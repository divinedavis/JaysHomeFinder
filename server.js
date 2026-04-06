require('dotenv').config();
const express = require('express');
const cors = require('cors');
const Database = require('better-sqlite3');
const axios = require('axios');
const cron = require('node-cron');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

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

// Clean out any properties over $500k from previous scans
db.prepare(`DELETE FROM properties WHERE price > ?`).run(MAX_PRICE);

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

function runChecklist(property, profile) {
  const checks = [];
  const price = property.price || 0;
  const yearBuilt = property.yearBuilt || 0;
  const taxAmount = property.taxAmount || 0;
  const rentEstimate = property.rentEstimate || 0;
  const daysOnMarket = property.daysOnMarket || 0;
  const bedrooms = property.bedrooms || 0;
  const propertyType = property.propertyType || '';

  const fhaDown = price * 0.035;
  const isFHA = propertyType.toLowerCase().includes('multi') && price <= 1149825;
  checks.push({ name: 'FHA 3.5% Eligible', passed: isFHA, detail: isFHA ? `3.5% down = $${Math.round(fhaDown).toLocaleString()}` : `Not FHA eligible (${propertyType})` });

  const canCover = fhaDown <= profile.borrowable401k;
  checks.push({ name: '401k Covers Down Payment', passed: canCover, detail: canCover ? `$${Math.round(fhaDown).toLocaleString()} <= $${profile.borrowable401k.toLocaleString()}` : `Need $${Math.round(fhaDown).toLocaleString()}, have $${profile.borrowable401k.toLocaleString()}` });


  const onePercent = price * 0.01;
  checks.push({ name: '1% Rule', passed: rentEstimate >= onePercent, detail: `Rent $${Math.round(rentEstimate).toLocaleString()}/mo vs 1% = $${Math.round(onePercent).toLocaleString()}/mo` });

  const valueEst = property.valueEstimate || 0;
  checks.push({ name: 'Forced Equity Potential', passed: valueEst > price * 1.05, detail: valueEst ? `Value $${Math.round(valueEst).toLocaleString()} vs price $${Math.round(price).toLocaleString()}` : 'No estimate yet' });

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

// ─── Daily Auto-Scan ───
async function dailyScan() {
  console.log(`[SCAN] Starting at ${new Date().toISOString()}`);
  const profile = db.prepare('SELECT * FROM user_profile WHERE id = 1').get();

  const scans = [
    // NYC
    { city: 'Bronx', state: 'NY', propertyType: 'Multi-Family', minBedrooms: 3 },
    { city: 'Queens', state: 'NY', propertyType: 'Multi-Family', minBedrooms: 3 },
    // PA
    { city: 'Philadelphia', state: 'PA', propertyType: 'Multi-Family', minBedrooms: 3 },
    // NJ
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
    console.log(`[SCAN] Searching ${scan.city} — multi-family under $${MAX_PRICE.toLocaleString()}...`);
    const params = {
      city: scan.city, state: scan.state,
      propertyType: scan.propertyType,
      price: `0-${MAX_PRICE}`,
      bedrooms: `${scan.minBedrooms}-10`,
      status: 'Active', limit: 50
    };

    const rawData = await rentcastGet('/listings/sale', params);
    if (!rawData || !Array.isArray(rawData)) {
      console.log(`[SCAN] No results for ${scan.city}`);
      db.prepare(`INSERT INTO scan_logs (scanType, city, totalFound, totalPassed, newProperties, details) VALUES (?, ?, 0, 0, 0, ?)`).run('daily', scan.city, 'No results from API');
      continue;
    }

    // Filter: no distressed, no over $500k
    const data = rawData.filter(p => !isDistressed(p) && (p.price || 0) <= MAX_PRICE);
    console.log(`[SCAN] ${scan.city}: ${rawData.length} raw -> ${data.length} after filters`);

    const upsert = db.prepare(`
      INSERT INTO properties (address, city, state, zipCode, latitude, longitude, propertyType, bedrooms, bathrooms, squareFootage, lotSize, yearBuilt, price, listingType, status, daysOnMarket, listedDate, rawData, source, updatedAt)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'daily-scan', datetime('now'))
      ON CONFLICT(address) DO UPDATE SET price=excluded.price, status=excluded.status, daysOnMarket=excluded.daysOnMarket, updatedAt=datetime('now')
    `);

    let totalPassed = 0, newCount = 0;
    const passedAddresses = [];

    for (const p of data) {
      const addr = p.formattedAddress || `${p.addressLine1}, ${p.city}, ${p.state} ${p.zipCode}`;
      const existing = db.prepare('SELECT id FROM properties WHERE address = ?').get(addr);
      if (!existing) newCount++;

      upsert.run(addr, p.city, p.state, p.zipCode, p.latitude, p.longitude, p.propertyType, p.bedrooms, p.bathrooms, p.squareFootage, p.lotSize, p.yearBuilt, p.price, p.listingType, p.status, p.daysOnMarket, p.listedDate, JSON.stringify(p));

      const dbRow = db.prepare('SELECT * FROM properties WHERE address = ?').get(addr);
      const prop = { ...p, address: addr, rentEstimate: dbRow.rentEstimate || 0, valueEstimate: dbRow.valueEstimate || 0, taxAmount: dbRow.taxAmount || 0 };
      const checklist = runChecklist(prop, profile);
      const passed = checklist.score === checklist.total;

      db.prepare('UPDATE properties SET checklistScore = ?, checklistDetails = ?, passedAll = ? WHERE address = ?')
        .run(checklist.score, JSON.stringify(checklist), passed ? 1 : 0, addr);

      if (passed) { totalPassed++; passedAddresses.push(addr); }
    }

    console.log(`[SCAN] ${scan.city}: ${data.length} valid, ${totalPassed} passed 15/15, ${newCount} new`);
    db.prepare(`INSERT INTO scan_logs (scanType, city, totalFound, totalPassed, newProperties, details) VALUES (?, ?, ?, ?, ?, ?)`)
      .run('daily', scan.city, data.length, totalPassed, newCount, JSON.stringify({ passedAddresses }));

    await new Promise(r => setTimeout(r, 2000));
  }
  console.log(`[SCAN] Complete at ${new Date().toISOString()}`);
}

// Run daily at 7 AM EST
cron.schedule('0 7 * * *', () => {
  dailyScan().catch(err => console.error('[SCAN] Error:', err));
}, { timezone: 'America/New_York' });

// Run scan on startup so dashboard has data
setTimeout(() => {
  dailyScan().catch(err => console.error('[SCAN] Startup scan error:', err));
}, 5000);

// Manual trigger
app.post('/api/scan/run', async (req, res) => {
  res.json({ message: 'Scan started' });
  dailyScan().catch(err => console.error('[SCAN] Manual error:', err));
});

app.get('/api/scan/logs', (req, res) => {
  res.json(db.prepare('SELECT * FROM scan_logs ORDER BY ranAt DESC LIMIT 30').all());
});

// Rescore with rent/value estimates
app.post('/api/properties/:id/rescore', async (req, res) => {
  const prop = db.prepare('SELECT * FROM properties WHERE id = ?').get(req.params.id);
  if (!prop) return res.status(404).json({ error: 'Not found' });

  if (!prop.rentEstimate) {
    const rd = await rentcastGet('/avm/rent/long-term', { address: prop.address });
    if (rd) { prop.rentEstimate = rd.rent || 0; prop.rentRangeLow = rd.rentRangeLow || 0; prop.rentRangeHigh = rd.rentRangeHigh || 0;
      db.prepare('UPDATE properties SET rentEstimate=?, rentRangeLow=?, rentRangeHigh=? WHERE address=?').run(prop.rentEstimate, prop.rentRangeLow, prop.rentRangeHigh, prop.address); }
  }
  if (!prop.valueEstimate) {
    const vd = await rentcastGet('/avm/value', { address: prop.address });
    if (vd) { prop.valueEstimate = vd.price || 0;
      db.prepare('UPDATE properties SET valueEstimate=? WHERE address=?').run(prop.valueEstimate, prop.address); }
  }

  const profile = db.prepare('SELECT * FROM user_profile WHERE id = 1').get();
  const checklist = runChecklist(prop, profile);
  const passed = checklist.score === checklist.total;
  db.prepare('UPDATE properties SET checklistScore=?, checklistDetails=?, passedAll=? WHERE address=?')
    .run(checklist.score, JSON.stringify(checklist), passed ? 1 : 0, prop.address);
  res.json({ property: prop, checklist });
});

// Properties — only qualified by default
app.get('/api/properties', (req, res) => {
  const { minScore, city, sort, showAll } = req.query;
  let sql = 'SELECT * FROM properties WHERE price <= ' + MAX_PRICE;
  const params = [];
  if (!showAll) { sql += ' AND passedAll = 1'; }
  if (minScore) { sql += ' AND checklistScore >= ?'; params.push(Number(minScore)); }
  if (city) { sql += ' AND city = ?'; params.push(city); }
  sql += ` ORDER BY ${sort === 'price' ? 'price ASC' : 'checklistScore DESC'}, createdAt DESC LIMIT 100`;
  res.json(db.prepare(sql).all(...params));
});

// Dashboard
app.get('/api/dashboard', (req, res) => {
  const profile = db.prepare('SELECT * FROM user_profile WHERE id = 1').get();
  const totalScanned = db.prepare('SELECT COUNT(*) as count FROM properties WHERE price <= ?').get(MAX_PRICE).count;
  const totalPassed = db.prepare('SELECT COUNT(*) as count FROM properties WHERE passedAll = 1 AND price <= ?').get(MAX_PRICE).count;
  const avgScore = db.prepare('SELECT AVG(checklistScore) as avg FROM properties WHERE checklistScore > 0 AND price <= ?').get(MAX_PRICE).avg || 0;
  const qualifiedProperties = db.prepare('SELECT * FROM properties WHERE passedAll = 1 AND price <= ? ORDER BY checklistScore DESC, price ASC').all(MAX_PRICE);
  const topScoring = db.prepare('SELECT * FROM properties WHERE price <= ? ORDER BY checklistScore DESC, price ASC LIMIT 50').all(MAX_PRICE);

  const portfolio = db.prepare('SELECT * FROM portfolio').all();
  const totalEquity = portfolio.reduce((s, p) => s + (p.equity || 0), 0);
  const totalCashFlow = portfolio.reduce((s, p) => s + ((p.monthlyRent || 0) - (p.monthlyMortgage || 0) - (p.monthlyExpenses || 0)), 0);
  const portfolioValue = portfolio.reduce((s, p) => s + (p.currentValue || 0), 0);
  const progressToGoal = ((portfolioValue / profile.goalAmount) * 100).toFixed(1);
  const monthlyNetSavings = profile.monthlySavings + totalCashFlow;
  const needed = profile.goalAmount * 0.25;
  const remaining = Math.max(0, needed - profile.cashOnHand - totalEquity);
  const monthsToGoal = monthlyNetSavings > 0 ? Math.ceil(remaining / monthlyNetSavings) : Infinity;
  const lastScan = db.prepare('SELECT * FROM scan_logs ORDER BY ranAt DESC LIMIT 1').get();
  const recentLogs = db.prepare('SELECT * FROM scan_logs ORDER BY ranAt DESC LIMIT 10').all();

  res.json({
    profile, lastScan, recentLogs,
    stats: { totalScanned, totalPassed, avgScore: avgScore.toFixed(1), totalEquity, totalCashFlow, portfolioValue, progressToGoal, monthsToGoal },
    qualifiedProperties, topScoring, portfolio
  });
});

// Portfolio CRUD
app.get('/api/portfolio', (req, res) => { res.json(db.prepare('SELECT * FROM portfolio ORDER BY addedAt DESC').all()); });
app.post('/api/portfolio', (req, res) => {
  const { propertyId, address, purchasePrice, currentValue, monthlyRent, monthlyMortgage, monthlyExpenses, equity, notes, status } = req.body;
  const result = db.prepare('INSERT INTO portfolio (propertyId, address, purchasePrice, currentValue, monthlyRent, monthlyMortgage, monthlyExpenses, equity, notes, status) VALUES (?,?,?,?,?,?,?,?,?,?)')
    .run(propertyId, address, purchasePrice||0, currentValue||0, monthlyRent||0, monthlyMortgage||0, monthlyExpenses||0, equity||0, notes||'', status||'watching');
  res.json({ id: result.lastInsertRowid });
});
app.put('/api/portfolio/:id', (req, res) => {
  const { purchasePrice, currentValue, monthlyRent, monthlyMortgage, monthlyExpenses, equity, notes, status } = req.body;
  db.prepare('UPDATE portfolio SET purchasePrice=?, currentValue=?, monthlyRent=?, monthlyMortgage=?, monthlyExpenses=?, equity=?, notes=?, status=? WHERE id=?')
    .run(purchasePrice, currentValue, monthlyRent, monthlyMortgage, monthlyExpenses, equity, notes, status, req.params.id);
  res.json({ success: true });
});
app.delete('/api/portfolio/:id', (req, res) => { db.prepare('DELETE FROM portfolio WHERE id = ?').run(req.params.id); res.json({ success: true }); });

// Profile
app.get('/api/profile', (req, res) => { res.json(db.prepare('SELECT * FROM user_profile WHERE id = 1').get()); });
app.put('/api/profile', (req, res) => {
  const { annualIncome, monthlySavings, cashOnHand, retirement401k, borrowable401k, creditScore, goalAmount, goalDescription } = req.body;
  db.prepare('UPDATE user_profile SET annualIncome=?, monthlySavings=?, cashOnHand=?, retirement401k=?, borrowable401k=?, creditScore=?, goalAmount=?, goalDescription=? WHERE id=1')
    .run(annualIncome, monthlySavings, cashOnHand, retirement401k, borrowable401k, creditScore, goalAmount, goalDescription);
  res.json({ success: true });
});

// Calculator
app.post('/api/calculate', (req, res) => {
  const { price, downPaymentPercent, interestRate, loanTermYears, monthlyRent, monthlyExpenses, annualAppreciation } = req.body;
  const downPayment = price * (downPaymentPercent / 100);
  const loanAmount = price - downPayment;
  const mm = calculateMortgage(loanAmount, interestRate / 100, loanTermYears);
  const tax = price * 0.015 / 12;
  const totalMonthly = mm + tax + (monthlyExpenses || 0);
  const cashFlow = (monthlyRent || 0) - totalMonthly;
  const coc = downPayment > 0 ? (cashFlow * 12 / downPayment * 100) : 0;
  const projection = [];
  let eq = downPayment, pv = price;
  for (let y = 1; y <= 10; y++) { pv *= (1 + (annualAppreciation || 3) / 100); eq = pv - loanAmount + downPayment;
    projection.push({ year: y, propertyValue: Math.round(pv), equity: Math.round(eq), annualCashFlow: Math.round(cashFlow * 12), totalReturn: Math.round(eq - downPayment + cashFlow * 12 * y) }); }
  res.json({ downPayment: Math.round(downPayment), loanAmount: Math.round(loanAmount), monthlyMortgage: Math.round(mm), monthlyTaxInsurance: Math.round(tax), totalMonthly: Math.round(totalMonthly), cashFlow: Math.round(cashFlow), annualCashFlow: Math.round(cashFlow * 12), cashOnCash: coc.toFixed(1), projection });
});

app.get('/{*path}', (req, res) => { res.sendFile(path.join(__dirname, 'public', 'index.html')); });

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`HomeFinder running on port ${PORT}`);
  console.log(`Daily scan: 7 AM EST | Bronx & Queens | Multi-Family under $${MAX_PRICE.toLocaleString()} | No distressed`);
});
