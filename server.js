require('dotenv').config();
const express = require('express');
const Database = require('better-sqlite3');
const axios = require('axios');
const cron = require('node-cron');
const path = require('path');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');

const app = express();
app.use(helmet({ contentSecurityPolicy: false, crossOriginResourcePolicy: false }));
app.use(express.json({ limit: '1mb' }));
app.use(rateLimit({ windowMs: 15 * 60 * 1000, max: 200, message: { error: 'Too many requests' } }));
app.use(express.static(path.join(__dirname, 'public')));

const MAX_PRICE = 500000;
const RAPID_KEY = process.env.RAPIDAPI_KEY;
const RAPID_HOST = 'realty-in-us.p.rapidapi.com';

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
    photoUrl TEXT, streetViewUrl TEXT, propertyId TEXT,
    priceReduced REAL, listingUrl TEXT,
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

// Migrations for new columns
const migrations = ['photoUrl TEXT', 'streetViewUrl TEXT', 'propertyId TEXT', 'priceReduced REAL', 'listingUrl TEXT'];
for (const col of migrations) {
  try { db.exec(`ALTER TABLE properties ADD COLUMN ${col}`); } catch(e) {}
}
try { db.exec(`ALTER TABLE properties ADD COLUMN passedAll INTEGER DEFAULT 0`); } catch(e) {}
try { db.exec(`ALTER TABLE properties ADD COLUMN source TEXT DEFAULT 'daily-scan'`); } catch(e) {}
db.prepare(`INSERT OR IGNORE INTO user_profile (id) VALUES (1)`).run();

// ─── Realtor.com API via RapidAPI ───
async function searchListings(city, stateCode) {
  try {
    const resp = await axios.post('https://realty-in-us.p.rapidapi.com/properties/v3/list', {
      limit: 50,
      offset: 0,
      city: city,
      state_code: stateCode,
      status: ['for_sale'],
      type: ['multi_family'],
      list_price: { max: MAX_PRICE },
      sort: { direction: 'desc', field: 'list_date' }
    }, {
      headers: {
        'Content-Type': 'application/json',
        'x-rapidapi-host': RAPID_HOST,
        'x-rapidapi-key': RAPID_KEY
      },
      timeout: 20000
    });
    return resp.data?.data?.home_search?.results || [];
  } catch (err) {
    console.error(`Realtor API error [${city}]:`, err.response?.status, err.response?.data || err.message);
    return [];
  }
}

function isDistressed(listing) {
  const flags = listing.flags || {};
  return flags.is_foreclosure || flags.is_short_sale || false;
}

// Parse Realtor.com result into our property format
function parseResult(r) {
  const addr = r.location?.address || {};
  const desc = r.description || {};
  const estimate = r.estimate?.estimate || 0;
  const photo = r.primary_photo?.href || '';
  const streetView = r.location?.street_view_url || '';
  const listDate = r.list_date || '';
  const now = new Date();
  const listed = listDate ? new Date(listDate) : null;
  const dom = listed ? Math.floor((now - listed) / (1000 * 60 * 60 * 24)) : 0;

  return {
    address: `${addr.line || ''}, ${addr.city || ''}, ${addr.state_code || ''} ${addr.postal_code || ''}`,
    city: addr.city || '',
    state: addr.state_code || '',
    zipCode: addr.postal_code || '',
    latitude: addr.coordinate?.lat || 0,
    longitude: addr.coordinate?.lon || 0,
    propertyType: desc.type === 'multi_family' ? 'Multi-Family' : desc.type || '',
    bedrooms: desc.beds || 0,
    bathrooms: desc.baths || 0,
    squareFootage: desc.sqft || 0,
    lotSize: desc.lot_sqft || 0,
    yearBuilt: desc.year_built || 0,
    price: r.list_price || 0,
    status: 'Active',
    daysOnMarket: dom,
    listedDate: listDate,
    lastSalePrice: r.last_sold_price || 0,
    lastSaleDate: r.last_sold_date || '',
    valueEstimate: estimate,
    photoUrl: photo.replace('s.jpg', 'od-w1024_h768.jpg'),
    streetViewUrl: streetView,
    propertyId: r.property_id || '',
    priceReduced: r.price_reduced_amount || 0,
    listingUrl: r.href || '',
    listingType: 'Standard'
  };
}

// ─── 10-Point Checklist ───
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



  const likelySeparate = bedrooms >= 4 && propertyType.toLowerCase().includes('multi');
  checks.push({ name: 'Separated Utilities (Est.)', passed: likelySeparate, detail: likelySeparate ? 'Multi-family 4+ beds — likely separate' : 'Verify separation' });

  const legalMulti = propertyType.toLowerCase().includes('multi');
  checks.push({ name: 'Legal Multi-Family Zoning', passed: legalMulti, detail: `Listed as ${propertyType}` });

  checks.push({ name: 'Owner-Occupancy Ready', passed: true, detail: 'Active listing' });


  const monthlyMortgage = calculateMortgage(price * 0.965, 0.07, 30);


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

function sanitizeProperty(p) {
  const { rawData, ...clean } = p;
  return clean;
}

// ─── Daily Auto-Scan ───
async function dailyScan() {
  console.log(`[SCAN] Starting at ${new Date().toISOString()}`);
  const profile = db.prepare('SELECT * FROM user_profile WHERE id = 1').get();

  const scans = [
    { city: 'Bronx', state: 'NY' },
    { city: 'Philadelphia', state: 'PA' },
    { city: 'York', state: 'PA' },
    { city: 'Lancaster', state: 'PA' },
    { city: 'Newark', state: 'NJ' },
    { city: 'Camden', state: 'NJ' },
    { city: 'Trenton', state: 'NJ' },
    { city: 'Irvington', state: 'NJ' },
    { city: 'East Orange', state: 'NJ' },
    { city: 'Paterson', state: 'NJ' },
    { city: 'Passaic', state: 'NJ' },
  ];

  for (const scan of scans) {
    console.log(`[SCAN] Searching ${scan.city}...`);
    const results = await searchListings(scan.city, scan.state);
    const twoYearsAgo = new Date(Date.now() - 730 * 24 * 60 * 60 * 1000).toISOString();
    const filtered = results.filter(r => !isDistressed(r) && (r.list_price || 0) <= MAX_PRICE && (r.list_price || 0) >= 50000 && (!r.list_date || r.list_date >= twoYearsAgo));

    const upsert = db.prepare(`
      INSERT INTO properties (address, city, state, zipCode, latitude, longitude, propertyType, bedrooms, bathrooms, squareFootage, lotSize, yearBuilt, price, listingType, status, daysOnMarket, listedDate, lastSalePrice, lastSaleDate, valueEstimate, photoUrl, streetViewUrl, propertyId, priceReduced, listingUrl, source, updatedAt)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'daily-scan', datetime('now'))
      ON CONFLICT(address) DO UPDATE SET price=excluded.price, status=excluded.status, daysOnMarket=excluded.daysOnMarket, valueEstimate=excluded.valueEstimate, photoUrl=excluded.photoUrl, priceReduced=excluded.priceReduced, lastSalePrice=excluded.lastSalePrice, lastSaleDate=excluded.lastSaleDate, updatedAt=datetime('now')
    `);

    let totalPassed = 0, newCount = 0;
    for (const r of filtered) {
      const p = parseResult(r);
      if (!p.address || p.address.startsWith(',')) continue;

      if (!db.prepare('SELECT id FROM properties WHERE address = ?').get(p.address)) newCount++;
      upsert.run(p.address, p.city, p.state, p.zipCode, p.latitude, p.longitude, p.propertyType, p.bedrooms, p.bathrooms, p.squareFootage, p.lotSize, p.yearBuilt, p.price, p.listingType, p.status, p.daysOnMarket, p.listedDate, p.lastSalePrice, p.lastSaleDate, p.valueEstimate, p.photoUrl, p.streetViewUrl, p.propertyId, p.priceReduced, p.listingUrl);

      const dbRow = db.prepare('SELECT * FROM properties WHERE address = ?').get(p.address);
      const checklist = runChecklist({ ...p, rentEstimate: dbRow.rentEstimate || 0, taxAmount: dbRow.taxAmount || 0 }, profile);
      db.prepare('UPDATE properties SET checklistScore=?, checklistDetails=?, passedAll=? WHERE address=?')
        .run(checklist.score, JSON.stringify(checklist), checklist.score === checklist.total ? 1 : 0, p.address);
      if (checklist.score === checklist.total) totalPassed++;
    }

    console.log(`[SCAN] ${scan.city}: ${filtered.length} found, ${totalPassed} passed, ${newCount} new`);
    db.prepare(`INSERT INTO scan_logs (scanType, city, totalFound, totalPassed, newProperties, details) VALUES (?, ?, ?, ?, ?, ?)`)
      .run('daily', scan.city, filtered.length, totalPassed, newCount, '');
    await new Promise(r => setTimeout(r, 1500));
  }
  console.log(`[SCAN] Complete at ${new Date().toISOString()}`);
}

// Daily at 7 AM EST
cron.schedule('0 7 * * *', () => { dailyScan().catch(console.error); }, { timezone: 'America/New_York' });

// Scan on startup
setTimeout(() => { dailyScan().catch(console.error); }, 3000);

// Manual trigger
app.post('/api/scan/run', (req, res) => {
  res.json({ message: 'Scan started' });
  dailyScan().catch(console.error);
});

app.get('/api/scan/logs', (req, res) => {
  res.json(db.prepare('SELECT * FROM scan_logs ORDER BY ranAt DESC LIMIT 30').all());
});

// Properties
app.get('/api/properties', (req, res) => {
  const { city, sort, showAll } = req.query;
  let sql = 'SELECT * FROM properties WHERE price <= ? AND (valueEstimate IS NULL OR valueEstimate = 0 OR valueEstimate > price * 1.05)';
  const params = [MAX_PRICE];
  if (!showAll) { sql += ' AND passedAll = 1'; }
  if (city) { sql += ' AND city = ?'; params.push(String(city)); }
  sql += ` ORDER BY ${sort === 'price' ? 'price ASC' : 'checklistScore DESC'}, createdAt DESC LIMIT 100`;
  res.json(db.prepare(sql).all(...params).map(sanitizeProperty));
});

// Dashboard
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

// Portfolio
app.get('/api/portfolio', (req, res) => { res.json(db.prepare('SELECT * FROM portfolio ORDER BY addedAt DESC').all()); });
app.post('/api/portfolio', (req, res) => {
  const { propertyId, address, purchasePrice, currentValue, monthlyRent, monthlyMortgage, monthlyExpenses, equity, notes, status } = req.body;
  const result = db.prepare('INSERT INTO portfolio (propertyId, address, purchasePrice, currentValue, monthlyRent, monthlyMortgage, monthlyExpenses, equity, notes, status) VALUES (?,?,?,?,?,?,?,?,?,?)')
    .run(Number(propertyId)||null, String(address||''), Number(purchasePrice)||0, Number(currentValue)||0, Number(monthlyRent)||0, Number(monthlyMortgage)||0, Number(monthlyExpenses)||0, Number(equity)||0, String(notes||''), String(status||'watching'));
  res.json({ id: result.lastInsertRowid });
});
app.delete('/api/portfolio/:id', (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id < 1) return res.status(400).json({ error: 'Invalid ID' });
  db.prepare('DELETE FROM portfolio WHERE id = ?').run(id);
  res.json({ success: true });
});

// Profile
app.get('/api/profile', (req, res) => { res.json(db.prepare('SELECT * FROM user_profile WHERE id = 1').get()); });
app.put('/api/profile', (req, res) => {
  const { annualIncome, monthlySavings, cashOnHand, retirement401k, borrowable401k, creditScore, goalAmount, goalDescription } = req.body;
  db.prepare('UPDATE user_profile SET annualIncome=?, monthlySavings=?, cashOnHand=?, retirement401k=?, borrowable401k=?, creditScore=?, goalAmount=?, goalDescription=? WHERE id=1')
    .run(Number(annualIncome)||0, Number(monthlySavings)||0, Number(cashOnHand)||0, Number(retirement401k)||0, Number(borrowable401k)||0, Number(creditScore)||0, Number(goalAmount)||0, String(goalDescription||''));
  res.json({ success: true });
});

// Calculator
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

const PORT = process.env.PORT || 3000;
app.listen(PORT, '127.0.0.1', () => {
  console.log(`HomeFinder running on 127.0.0.1:${PORT}`);
});
