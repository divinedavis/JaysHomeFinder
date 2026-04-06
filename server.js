require('dotenv').config();
const express = require('express');
const Database = require('better-sqlite3');
const axios = require('axios');
const cron = require('node-cron');
const path = require('path');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const cookieParser = require('cookie-parser');
const crypto = require('crypto');

const app = express();

// ─── Security Middleware ───
app.use(helmet({ contentSecurityPolicy: false }));
app.use(cookieParser());
app.use(express.json({ limit: '1mb' }));

// Rate limiting — 100 requests per 15 min per IP
app.use(rateLimit({ windowMs: 15 * 60 * 1000, max: 100, message: { error: 'Too many requests' } }));

// Login rate limit — 5 attempts per 15 min
const loginLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 5, message: { error: 'Too many login attempts' } });

const APP_PASSWORD = process.env.APP_PASSWORD;
const SESSION_SECRET = process.env.SESSION_SECRET;

// Session tokens stored in memory (cleared on restart, which is fine)
const sessions = new Map();

function generateToken() {
  return crypto.randomBytes(48).toString('hex');
}

function requireAuth(req, res, next) {
  const token = req.cookies?.session;
  if (!token || !sessions.has(token)) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  // Refresh expiry
  sessions.set(token, Date.now() + 24 * 60 * 60 * 1000);
  next();
}

// ─── Auth Routes (no auth required) ───
app.post('/api/login', loginLimiter, (req, res) => {
  const { password } = req.body;
  if (!password || password !== APP_PASSWORD) {
    return res.status(401).json({ error: 'Wrong password' });
  }
  const token = generateToken();
  sessions.set(token, Date.now() + 24 * 60 * 60 * 1000); // 24hr expiry
  res.cookie('session', token, {
    httpOnly: true,
    secure: true,
    sameSite: 'strict',
    maxAge: 24 * 60 * 60 * 1000
  });
  res.json({ success: true });
});

app.post('/api/logout', (req, res) => {
  const token = req.cookies?.session;
  if (token) sessions.delete(token);
  res.clearCookie('session');
  res.json({ success: true });
});

app.get('/api/auth/check', (req, res) => {
  const token = req.cookies?.session;
  res.json({ authenticated: !!(token && sessions.has(token)) });
});

// Clean expired sessions every hour
setInterval(() => {
  const now = Date.now();
  for (const [token, expiry] of sessions) {
    if (expiry < now) sessions.delete(token);
  }
}, 60 * 60 * 1000);

// Static files (login page accessible without auth)
app.use(express.static(path.join(__dirname, 'public')));

// ─── All API routes below require auth ───
app.use('/api', (req, res, next) => {
  // Skip auth for login/logout/auth-check
  if (req.path === '/login' || req.path === '/logout' || req.path === '/auth/check') return next();
  requireAuth(req, res, next);
});

// ─── Database ───
const MAX_PRICE = 500000;
const db = new Database(path.join(__dirname, 'homefinder.db'));
db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS properties (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    address TEXT UNIQUE, city TEXT, state TEXT, zipCode TEXT,
    latitude REAL, longitude REAL, propertyType TEXT,
    bedrooms INTEGER, bathrooms REAL, squareFootage INTEGER,
    lotSize INTEGER, yearBuilt INTEGER, price REAL,
    listingType TEXT, status TEXT, daysOnMarket INTEGER, listedDate TEXT,
    lastSalePrice REAL, lastSaleDate TEXT, taxAmount REAL, hoaFee REAL,
    rentEstimate REAL, rentRangeLow REAL, rentRangeHigh REAL, valueEstimate REAL,
    checklistScore INTEGER DEFAULT 0, checklistDetails TEXT,
    passedAll INTEGER DEFAULT 0, source TEXT DEFAULT 'daily-scan',
    rawData TEXT,
    createdAt TEXT DEFAULT (datetime('now')),
    updatedAt TEXT DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS portfolio (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    propertyId INTEGER, address TEXT,
    purchasePrice REAL, currentValue REAL,
    monthlyRent REAL, monthlyMortgage REAL, monthlyExpenses REAL,
    equity REAL, notes TEXT, status TEXT DEFAULT 'watching',
    addedAt TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (propertyId) REFERENCES properties(id)
  );
  CREATE TABLE IF NOT EXISTS user_profile (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    annualIncome REAL DEFAULT 150000, monthlySavings REAL DEFAULT 2000,
    cashOnHand REAL DEFAULT 0, retirement401k REAL DEFAULT 30000,
    borrowable401k REAL DEFAULT 15000, creditScore INTEGER DEFAULT 700,
    goalAmount REAL DEFAULT 3000000,
    goalDescription TEXT DEFAULT 'Brooklyn mixed-use building with coffee shop'
  );
  CREATE TABLE IF NOT EXISTS scan_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    scanType TEXT, city TEXT,
    totalFound INTEGER DEFAULT 0, totalPassed INTEGER DEFAULT 0,
    newProperties INTEGER DEFAULT 0, details TEXT,
    ranAt TEXT DEFAULT (datetime('now'))
  );
`);

try { db.exec(`ALTER TABLE properties ADD COLUMN passedAll INTEGER DEFAULT 0`); } catch(e) {}
try { db.exec(`ALTER TABLE properties ADD COLUMN source TEXT DEFAULT 'daily-scan'`); } catch(e) {}
db.prepare(`INSERT OR IGNORE INTO user_profile (id) VALUES (1)`).run();
db.prepare(`DELETE FROM properties WHERE price > ?`).run(MAX_PRICE);

// ─── RentCast API ───
const RENTCAST_KEY = process.env.RENTCAST_API_KEY;
const RENTCAST_BASE = 'https://api.rentcast.io/v1';

async function rentcastGet(endpoint, params = {}) {
  try {
    const resp = await axios.get(`${RENTCAST_BASE}${endpoint}`, {
      headers: { 'X-Api-Key': RENTCAST_KEY }, params, timeout: 15000
    });
    return resp.data;
  } catch (err) {
    console.error(`RentCast error [${endpoint}]:`, err.response?.status, err.response?.data || err.message);
    return null;
  }
}

function isDistressed(listing) {
  const lt = (listing.listingType || '').toLowerCase();
  return lt.includes('short') || lt.includes('foreclosure') || lt.includes('bank owned') || lt.includes('reo');
}

// ─── 11-Point Checklist ───
function runChecklist(property, profile) {
  const checks = [];
  const price = property.price || 0;
  const taxAmount = property.taxAmount || 0;
  const rentEstimate = property.rentEstimate || 0;
  const bedrooms = property.bedrooms || 0;
  const propertyType = property.propertyType || '';

  const fhaDown = price * 0.035;
  const isFHA = propertyType.toLowerCase().includes('multi') && price <= 1149825;
  checks.push({ name: 'FHA 3.5% Eligible', passed: isFHA, detail: isFHA ? `3.5% down = $${Math.round(fhaDown).toLocaleString()}` : `Not FHA eligible (${propertyType})` });

  const canCover = fhaDown <= profile.borrowable401k;
  checks.push({ name: '401k Covers Down Payment', passed: canCover, detail: canCover ? `$${Math.round(fhaDown).toLocaleString()} <= $${profile.borrowable401k.toLocaleString()}` : `Need $${Math.round(fhaDown).toLocaleString()}, have $${profile.borrowable401k.toLocaleString()}` });

  const onePercent = price * 0.01;
  checks.push({ name: '1% Rule', passed: rentEstimate >= onePercent, detail: `Rent $${Math.round(rentEstimate).toLocaleString()}/mo vs 1% = $${Math.round(onePercent).toLocaleString()}/mo` });


  const likelySeparate = bedrooms >= 4 && propertyType.toLowerCase().includes('multi');
  checks.push({ name: 'Separated Utilities (Est.)', passed: likelySeparate, detail: likelySeparate ? 'Multi-family 4+ beds — likely separate' : 'Verify separation' });

  const legalMulti = propertyType.toLowerCase().includes('multi');
  checks.push({ name: 'Legal Multi-Family Zoning', passed: legalMulti, detail: `Listed as ${propertyType}` });

  const livable = property.status === 'Active' && !property.listingType?.toLowerCase().includes('foreclosure');
  checks.push({ name: 'Owner-Occupancy Ready', passed: livable, detail: livable ? 'Active, appears livable' : 'May need work or distressed' });

  const notDistressed = !property.listingType?.toLowerCase().includes('short') && !property.listingType?.toLowerCase().includes('foreclosure');
  checks.push({ name: 'Not Short Sale/Foreclosure', passed: notDistressed, detail: notDistressed ? 'Standard sale' : property.listingType });

  const monthlyMortgage = calculateMortgage(price * 0.965, 0.07, 30);
  const monthlyCashFlow = rentEstimate - monthlyMortgage - (taxAmount / 12) - 200;
  checks.push({ name: 'Cash Flow Positive', passed: monthlyCashFlow > 0, detail: `$${Math.round(monthlyCashFlow).toLocaleString()}/mo (rent $${Math.round(rentEstimate).toLocaleString()} - mtg $${Math.round(monthlyMortgage).toLocaleString()} - tax $${Math.round(taxAmount/12).toLocaleString()} - ins $200)` });

  const monthlyIncome = profile.annualIncome / 12;
  const dti = (monthlyMortgage + (taxAmount / 12) + 200) / monthlyIncome;
  checks.push({ name: 'DTI Under 43%', passed: dti < 0.43, detail: `${(dti * 100).toFixed(1)}%` });

  const estimatedUnits = bedrooms >= 6 ? 3 : bedrooms >= 4 ? 2 : 1;
  const pricePerUnit = price / estimatedUnits;
  checks.push({ name: 'Price Per Unit < $350k', passed: pricePerUnit < 350000, detail: `$${Math.round(pricePerUnit).toLocaleString()}/unit (${estimatedUnits} units)` });

  const score = checks.filter(c => c.passed).length;
  return { score, total: checks.length, checks };
}

function calculateMortgage(principal, annualRate, years) {
  const r = annualRate / 12;
  const n = years * 12;
  return principal * (r * Math.pow(1 + r, n)) / (Math.pow(1 + r, n) - 1);
}

// Strip rawData from property objects before sending to client
function sanitizeProperty(p) {
  const { rawData, ...clean } = p;
  return clean;
}

// ─── Daily Auto-Scan ───
async function dailyScan() {
  console.log(`[SCAN] Starting at ${new Date().toISOString()}`);
  const profile = db.prepare('SELECT * FROM user_profile WHERE id = 1').get();

  const scans = [
    { city: 'Bronx', state: 'NY', propertyType: 'Multi-Family', minBedrooms: 3 },
    { city: 'Queens', state: 'NY', propertyType: 'Multi-Family', minBedrooms: 3 },
    { city: 'Philadelphia', state: 'PA', propertyType: 'Multi-Family', minBedrooms: 3 },
    { city: 'Newark', state: 'NJ', propertyType: 'Multi-Family', minBedrooms: 3 },
    { city: 'Camden', state: 'NJ', propertyType: 'Multi-Family', minBedrooms: 3 },
    { city: 'Trenton', state: 'NJ', propertyType: 'Multi-Family', minBedrooms: 3 },
    { city: 'Irvington', state: 'NJ', propertyType: 'Multi-Family', minBedrooms: 3 },
    { city: 'East Orange', state: 'NJ', propertyType: 'Multi-Family', minBedrooms: 3 },
    { city: 'Plainfield', state: 'NJ', propertyType: 'Multi-Family', minBedrooms: 3 },
    { city: 'Paterson', state: 'NJ', propertyType: 'Multi-Family', minBedrooms: 3 },
    { city: 'Passaic', state: 'NJ', propertyType: 'Multi-Family', minBedrooms: 3 },
    { city: 'Perth Amboy', state: 'NJ', propertyType: 'Multi-Family', minBedrooms: 3 },
    { city: 'Elizabeth', state: 'NJ', propertyType: 'Multi-Family', minBedrooms: 3 },
    { city: 'Bridgeton', state: 'NJ', propertyType: 'Multi-Family', minBedrooms: 3 },
  ];

  for (const scan of scans) {
    console.log(`[SCAN] Searching ${scan.city}...`);
    const params = {
      city: scan.city, state: scan.state, propertyType: scan.propertyType,
      price: `0-${MAX_PRICE}`, bedrooms: `${scan.minBedrooms}-10`,
      status: 'Active', limit: 50
    };

    const rawData = await rentcastGet('/listings/sale', params);
    if (!rawData || !Array.isArray(rawData)) {
      db.prepare(`INSERT INTO scan_logs (scanType, city, totalFound, totalPassed, newProperties, details) VALUES (?, ?, 0, 0, 0, ?)`).run('daily', scan.city, 'No results');
      continue;
    }

    const data = rawData.filter(p => !isDistressed(p) && (p.price || 0) <= MAX_PRICE);
    const upsert = db.prepare(`
      INSERT INTO properties (address, city, state, zipCode, latitude, longitude, propertyType, bedrooms, bathrooms, squareFootage, lotSize, yearBuilt, price, listingType, status, daysOnMarket, listedDate, rawData, source, updatedAt)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'daily-scan', datetime('now'))
      ON CONFLICT(address) DO UPDATE SET price=excluded.price, status=excluded.status, daysOnMarket=excluded.daysOnMarket, updatedAt=datetime('now')
    `);

    let totalPassed = 0, newCount = 0;
    for (const p of data) {
      const addr = p.formattedAddress || `${p.addressLine1}, ${p.city}, ${p.state} ${p.zipCode}`;
      if (!db.prepare('SELECT id FROM properties WHERE address = ?').get(addr)) newCount++;
      upsert.run(addr, p.city, p.state, p.zipCode, p.latitude, p.longitude, p.propertyType, p.bedrooms, p.bathrooms, p.squareFootage, p.lotSize, p.yearBuilt, p.price, p.listingType, p.status, p.daysOnMarket, p.listedDate, JSON.stringify(p));

      const dbRow = db.prepare('SELECT * FROM properties WHERE address = ?').get(addr);
      const prop = { ...p, address: addr, rentEstimate: dbRow.rentEstimate || 0, valueEstimate: dbRow.valueEstimate || 0, taxAmount: dbRow.taxAmount || 0 };
      const checklist = runChecklist(prop, profile);
      db.prepare('UPDATE properties SET checklistScore = ?, checklistDetails = ?, passedAll = ? WHERE address = ?')
        .run(checklist.score, JSON.stringify(checklist), checklist.score === checklist.total ? 1 : 0, addr);
      if (checklist.score === checklist.total) totalPassed++;
    }

    console.log(`[SCAN] ${scan.city}: ${data.length} found, ${totalPassed} passed, ${newCount} new`);
    db.prepare(`INSERT INTO scan_logs (scanType, city, totalFound, totalPassed, newProperties, details) VALUES (?, ?, ?, ?, ?, ?)`)
      .run('daily', scan.city, data.length, totalPassed, newCount, '');
    await new Promise(r => setTimeout(r, 2000));
  }
  console.log(`[SCAN] Complete at ${new Date().toISOString()}`);
}

cron.schedule('0 7 * * *', () => { dailyScan().catch(console.error); }, { timezone: 'America/New_York' });
setTimeout(() => { dailyScan().catch(console.error); }, 5000);

// ─── Protected API Routes ───
app.post('/api/scan/run', (req, res) => {
  res.json({ message: 'Scan started' });
  dailyScan().catch(console.error);
});

app.get('/api/scan/logs', (req, res) => {
  res.json(db.prepare('SELECT * FROM scan_logs ORDER BY ranAt DESC LIMIT 30').all());
});

app.post('/api/properties/:id/rescore', async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id < 1) return res.status(400).json({ error: 'Invalid ID' });
  const prop = db.prepare('SELECT * FROM properties WHERE id = ?').get(id);
  if (!prop) return res.status(404).json({ error: 'Not found' });

  if (!prop.rentEstimate) {
    const rd = await rentcastGet('/avm/rent/long-term', { address: prop.address });
    if (rd) { prop.rentEstimate = rd.rent || 0;
      db.prepare('UPDATE properties SET rentEstimate=?, rentRangeLow=?, rentRangeHigh=? WHERE address=?').run(rd.rent || 0, rd.rentRangeLow || 0, rd.rentRangeHigh || 0, prop.address); }
  }
  if (!prop.valueEstimate) {
    const vd = await rentcastGet('/avm/value', { address: prop.address });
    if (vd) { prop.valueEstimate = vd.price || 0;
      db.prepare('UPDATE properties SET valueEstimate=? WHERE address=?').run(vd.price || 0, prop.address); }
  }

  const profile = db.prepare('SELECT * FROM user_profile WHERE id = 1').get();
  const checklist = runChecklist(prop, profile);
  db.prepare('UPDATE properties SET checklistScore=?, checklistDetails=?, passedAll=? WHERE address=?')
    .run(checklist.score, JSON.stringify(checklist), checklist.score === checklist.total ? 1 : 0, prop.address);
  res.json({ property: sanitizeProperty(prop), checklist });
});

app.get('/api/properties', (req, res) => {
  const { minScore, city, sort, showAll } = req.query;
  let sql = 'SELECT * FROM properties WHERE price <= ? AND (valueEstimate IS NULL OR valueEstimate = 0 OR valueEstimate > price * 1.05)';
  const params = [MAX_PRICE];
  if (!showAll) { sql += ' AND passedAll = 1'; }
  if (minScore) { const s = Number(minScore); if (Number.isInteger(s)) { sql += ' AND checklistScore >= ?'; params.push(s); } }
  if (city) { sql += ' AND city = ?'; params.push(String(city)); }
  sql += ` ORDER BY ${sort === 'price' ? 'price ASC' : 'checklistScore DESC'}, createdAt DESC LIMIT 100`;
  res.json(db.prepare(sql).all(...params).map(sanitizeProperty));
});

app.get('/api/dashboard', (req, res) => {
  const profile = db.prepare('SELECT * FROM user_profile WHERE id = 1').get();
  const totalScanned = db.prepare('SELECT COUNT(*) as count FROM properties WHERE price <= ? AND (valueEstimate IS NULL OR valueEstimate = 0 OR valueEstimate > price * 1.05)').get(MAX_PRICE).count;
  const totalPassed = db.prepare('SELECT COUNT(*) as count FROM properties WHERE passedAll = 1 AND price <= ?').get(MAX_PRICE).count;
  const avgScore = db.prepare('SELECT AVG(checklistScore) as avg FROM properties WHERE checklistScore > 0 AND price <= ?').get(MAX_PRICE).avg || 0;
  const qualifiedProperties = db.prepare('SELECT * FROM properties WHERE passedAll = 1 AND price <= ? AND (valueEstimate IS NULL OR valueEstimate = 0 OR valueEstimate > price * 1.05) ORDER BY checklistScore DESC, price ASC').all(MAX_PRICE).map(sanitizeProperty);
  const topScoring = db.prepare('SELECT * FROM properties WHERE price <= ? AND (valueEstimate IS NULL OR valueEstimate = 0 OR valueEstimate > price * 1.05) ORDER BY checklistScore DESC, price ASC LIMIT 50').all(MAX_PRICE).map(sanitizeProperty);
  const portfolio = db.prepare('SELECT * FROM portfolio').all();
  const lastScan = db.prepare('SELECT * FROM scan_logs ORDER BY ranAt DESC LIMIT 1').get();
  const recentLogs = db.prepare('SELECT * FROM scan_logs ORDER BY ranAt DESC LIMIT 10').all();

  res.json({ profile, lastScan, recentLogs,
    stats: { totalScanned, totalPassed, avgScore: avgScore.toFixed(1) },
    qualifiedProperties, topScoring, portfolio
  });
});

app.get('/api/portfolio', (req, res) => { res.json(db.prepare('SELECT * FROM portfolio ORDER BY addedAt DESC').all()); });
app.post('/api/portfolio', (req, res) => {
  const { propertyId, address, purchasePrice, currentValue, monthlyRent, monthlyMortgage, monthlyExpenses, equity, notes, status } = req.body;
  const result = db.prepare('INSERT INTO portfolio (propertyId, address, purchasePrice, currentValue, monthlyRent, monthlyMortgage, monthlyExpenses, equity, notes, status) VALUES (?,?,?,?,?,?,?,?,?,?)')
    .run(Number(propertyId)||null, String(address||''), Number(purchasePrice)||0, Number(currentValue)||0, Number(monthlyRent)||0, Number(monthlyMortgage)||0, Number(monthlyExpenses)||0, Number(equity)||0, String(notes||''), String(status||'watching'));
  res.json({ id: result.lastInsertRowid });
});
app.put('/api/portfolio/:id', (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id < 1) return res.status(400).json({ error: 'Invalid ID' });
  const { purchasePrice, currentValue, monthlyRent, monthlyMortgage, monthlyExpenses, equity, notes, status } = req.body;
  db.prepare('UPDATE portfolio SET purchasePrice=?, currentValue=?, monthlyRent=?, monthlyMortgage=?, monthlyExpenses=?, equity=?, notes=?, status=? WHERE id=?')
    .run(Number(purchasePrice)||0, Number(currentValue)||0, Number(monthlyRent)||0, Number(monthlyMortgage)||0, Number(monthlyExpenses)||0, Number(equity)||0, String(notes||''), String(status||''), id);
  res.json({ success: true });
});
app.delete('/api/portfolio/:id', (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id < 1) return res.status(400).json({ error: 'Invalid ID' });
  db.prepare('DELETE FROM portfolio WHERE id = ?').run(id);
  res.json({ success: true });
});

app.get('/api/profile', (req, res) => { res.json(db.prepare('SELECT * FROM user_profile WHERE id = 1').get()); });
app.put('/api/profile', (req, res) => {
  const { annualIncome, monthlySavings, cashOnHand, retirement401k, borrowable401k, creditScore, goalAmount, goalDescription } = req.body;
  db.prepare('UPDATE user_profile SET annualIncome=?, monthlySavings=?, cashOnHand=?, retirement401k=?, borrowable401k=?, creditScore=?, goalAmount=?, goalDescription=? WHERE id=1')
    .run(Number(annualIncome)||0, Number(monthlySavings)||0, Number(cashOnHand)||0, Number(retirement401k)||0, Number(borrowable401k)||0, Number(creditScore)||0, Number(goalAmount)||0, String(goalDescription||''));
  res.json({ success: true });
});

app.post('/api/calculate', (req, res) => {
  const { price, downPaymentPercent, interestRate, loanTermYears, monthlyRent, monthlyExpenses, annualAppreciation } = req.body;
  const dp = Number(price) * (Number(downPaymentPercent) / 100);
  const la = Number(price) - dp;
  const mm = calculateMortgage(la, Number(interestRate) / 100, Number(loanTermYears));
  const tax = Number(price) * 0.015 / 12;
  const totalMonthly = mm + tax + (Number(monthlyExpenses) || 0);
  const cashFlow = (Number(monthlyRent) || 0) - totalMonthly;
  const coc = dp > 0 ? (cashFlow * 12 / dp * 100) : 0;
  const projection = [];
  let eq = dp, pv = Number(price);
  for (let y = 1; y <= 10; y++) { pv *= (1 + (Number(annualAppreciation) || 3) / 100); eq = pv - la + dp;
    projection.push({ year: y, propertyValue: Math.round(pv), equity: Math.round(eq), annualCashFlow: Math.round(cashFlow * 12), totalReturn: Math.round(eq - dp + cashFlow * 12 * y) }); }
  res.json({ downPayment: Math.round(dp), loanAmount: Math.round(la), monthlyMortgage: Math.round(mm), monthlyTaxInsurance: Math.round(tax), totalMonthly: Math.round(totalMonthly), cashFlow: Math.round(cashFlow), annualCashFlow: Math.round(cashFlow * 12), cashOnCash: coc.toFixed(1), projection });
});

app.get('/{*path}', (req, res) => { res.sendFile(path.join(__dirname, 'public', 'index.html')); });

// Bind to localhost only — Nginx handles public traffic
const PORT = process.env.PORT || 3000;
app.listen(PORT, '127.0.0.1', () => {
  console.log(`HomeFinder running on 127.0.0.1:${PORT} (behind Nginx)`);
});
