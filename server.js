const express = require('express');
const cors = require('cors');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const axios = require('axios');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 5000;
const JWT_SECRET = process.env.JWT_SECRET;

app.use(cors());
// The webhook must see the untouched request body to verify its HMAC signature,
// so it is parsed as a raw buffer before the JSON parser runs.
app.use('/api/cashfree/webhook', express.raw({ type: '*/*', limit: '1mb' }));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// Returns clean JSON instead of an HTML stack trace when a body cannot be parsed
app.use((err, req, res, next) => {
  if (err && (err.type === 'entity.parse.failed' || err instanceof SyntaxError)) {
    return res.status(400).json({ error: 'Malformed request body. Send JSON or x-www-form-urlencoded.' });
  }
  next(err);
});

// Initialize Database
// DB_PATH lets the host point at a mounted persistent volume. Serverless
// platforms have no writable persistent disk, so this app needs a host that
// provides one (Render / Railway / Fly.io / a VPS).
const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'database.sqlite');
fs.mkdirSync(path.dirname(path.resolve(DB_PATH)), { recursive: true });
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');

// Create Tables
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT,
    email TEXT UNIQUE,
    password TEXT,
    google_id TEXT,
    role TEXT DEFAULT 'user',
    wallet_inr REAL DEFAULT 0.0,
    wallet_usd REAL DEFAULT 0.0,
    wallet_eur REAL DEFAULT 0.0,
    currency TEXT DEFAULT 'INR',
    referral_code TEXT UNIQUE,
    referred_by TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS services (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    category TEXT,
    name TEXT,
    rate_per_1000 REAL,
    min_quantity INTEGER,
    max_quantity INTEGER,
    description TEXT,
    status TEXT DEFAULT 'active'
  );

  CREATE TABLE IF NOT EXISTS orders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER,
    service_id INTEGER,
    service_name TEXT,
    link TEXT,
    quantity INTEGER,
    charge REAL,
    currency TEXT,
    status TEXT DEFAULT 'Pending',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(user_id) REFERENCES users(id)
  );

  CREATE TABLE IF NOT EXISTS tickets (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER,
    subject TEXT,
    order_id TEXT,
    request_type TEXT,
    message TEXT,
    status TEXT DEFAULT 'Open',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS transactions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER,
    amount REAL,
    currency TEXT,
    payment_method TEXT,
    status TEXT DEFAULT 'Completed',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS api_keys (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER UNIQUE,
    api_key TEXT UNIQUE,
    label TEXT,
    status TEXT DEFAULT 'active',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(user_id) REFERENCES users(id)
  );

  CREATE TABLE IF NOT EXISTS upstream_providers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT,
    api_url TEXT,
    api_key TEXT,
    markup_percent REAL DEFAULT 0,
    status TEXT DEFAULT 'active',
    last_sync_at DATETIME,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS payment_orders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    order_id TEXT UNIQUE,
    user_id INTEGER,
    amount REAL,
    currency TEXT,
    wallet_field TEXT,
    payment_status TEXT DEFAULT 'PENDING',
    payment_session_id TEXT,
    credited INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME,
    FOREIGN KEY(user_id) REFERENCES users(id)
  );
`);

// Lightweight migrations for columns added after the initial schema
const addColumnIfMissing = (table, column, definition) => {
  const existing = db.prepare(`PRAGMA table_info(${table})`).all();
  if (!existing.some((c) => c.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
};

addColumnIfMissing('services', 'provider_id', 'INTEGER');
addColumnIfMissing('services', 'upstream_service_id', 'TEXT');
addColumnIfMissing('services', 'cost_per_1000', 'REAL');
addColumnIfMissing('services', 'image', 'TEXT');
addColumnIfMissing('orders', 'upstream_order_id', 'TEXT');
addColumnIfMissing('orders', 'cost', 'REAL DEFAULT 0');

// Insert default Admin & demo services if empty
const adminCheck = db.prepare('SELECT * FROM users WHERE email = ?').get('admin@jayrajputmediapower.com');
if (!adminCheck) {
  const hash = bcrypt.hashSync('admin@3360', 10);
  db.prepare(`
    INSERT INTO users (name, email, password, role, referral_code) 
    VALUES (?, ?, ?, ?, ?)
  `).run('Admin Jay Rajput', 'admin@jayrajputmediapower.com', hash, 'admin', 'JRADMIN');

  // Seed default services
  const insertService = db.prepare(`
    INSERT INTO services (category, name, rate_per_1000, min_quantity, max_quantity, description)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  insertService.run('Instagram', 'Instagram Followers [High Quality - Non Drop]', 120.00, 100, 50000, 'Instant start, 30 days refill guarantee.');
  insertService.run('Instagram', 'Instagram Likes [Real Active Users]', 40.00, 50, 100000, 'Fast speed, organic appearance.');
  insertService.run('Facebook', 'Facebook Page Likes & Followers', 180.00, 100, 20000, 'Worldwide targeting, safe delivery.');
  insertService.run('YouTube', 'YouTube WatchTime Hours [Monetizable]', 850.00, 500, 4000, 'Refill enabled, 100% safe.');
}

// Middleware: Authentication
const authenticateToken = (req, res, next) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'Access Denied: No Token Provided' });

  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (err) return res.status(403).json({ error: 'Invalid Token' });
    req.user = user;
    next();
  });
};

// Middleware: Admin Authorization
const requireAdmin = (req, res, next) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin Access Required' });
  next();
};

// ==================== AUTH ROUTES ====================
app.post('/api/auth/register', (req, res) => {
  const { name, email, password, referral_code } = req.body;
  if (!name || !email || !password) return res.status(400).json({ error: 'All fields are required.' });

  try {
    const existing = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
    if (existing) return res.status(400).json({ error: 'Email already registered.' });

    const hash = bcrypt.hashSync(password, 10);
    const myRefCode = 'JR' + Math.random().toString(36).substring(2, 7).toUpperCase();

    const stmt = db.prepare(`
      INSERT INTO users (name, email, password, referral_code, referred_by)
      VALUES (?, ?, ?, ?, ?)
    `);
    const info = stmt.run(name, email, hash, myRefCode, referral_code || null);

    const token = jwt.sign({ id: info.lastInsertRowid, email, role: 'user' }, JWT_SECRET, { expiresIn: '7d' });
    res.json({ token, user: { id: info.lastInsertRowid, name, email, role: 'user', referral_code: myRefCode } });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/auth/login', (req, res) => {
  const { email, password } = req.body;
  const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
  if (!user || !bcrypt.compareSync(password, user.password)) {
    return res.status(400).json({ error: 'Invalid email or password.' });
  }

  const token = jwt.sign({ id: user.id, email: user.email, role: user.role }, JWT_SECRET, { expiresIn: '7d' });
  res.json({
    token,
    user: {
      id: user.id,
      name: user.name,
      email: user.email,
      role: user.role,
      wallet_inr: user.wallet_inr,
      wallet_usd: user.wallet_usd,
      wallet_eur: user.wallet_eur,
      currency: user.currency,
      referral_code: user.referral_code
    }
  });
});

// Google Login Mock / API integration hook
app.post('/api/auth/google', (req, res) => {
  const { google_id, email, name } = req.body;
  let user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);

  if (!user) {
    const myRefCode = 'JR' + Math.random().toString(36).substring(2, 7).toUpperCase();
    const info = db.prepare(`
      INSERT INTO users (name, email, google_id, role, referral_code)
      VALUES (?, ?, ?, 'user', ?)
    `).run(name, email, google_id, myRefCode);
    user = db.prepare('SELECT * FROM users WHERE id = ?').get(info.lastInsertRowid);
  }

  const token = jwt.sign({ id: user.id, email: user.email, role: user.role }, JWT_SECRET, { expiresIn: '7d' });
  res.json({ token, user });
});

// User Profile & Balance
app.get('/api/user/profile', authenticateToken, (req, res) => {
  const user = db.prepare('SELECT id, name, email, role, wallet_inr, wallet_usd, wallet_eur, currency, referral_code, referred_by FROM users WHERE id = ?').get(req.user.id);
  res.json(user);
});

// ==================== PRICING & ORDER PLACEMENT ====================
const WALLET_BY_CURRENCY = { INR: 'wallet_inr', USD: 'wallet_usd', EUR: 'wallet_eur' };
const CURRENCY_MULTIPLIER = { INR: 1, USD: 0.012, EUR: 0.011 };

// Places an order for a user: charges the wallet, writes the order, applies referral commission.
// Returns { error } on failure, otherwise the created order summary.
function placeOrder(user, service, link, quantity, currency = 'INR') {
  const multiplier = CURRENCY_MULTIPLIER[currency] ?? 1;
  const walletField = WALLET_BY_CURRENCY[currency] || 'wallet_inr';
  const totalCost = parseFloat((((service.rate_per_1000 * multiplier) / 1000) * quantity).toFixed(2));

  if (user[walletField] < totalCost) {
    return { error: 'Insufficient wallet balance. Please add funds.' };
  }

  // Upstream (wholesale) cost of fulfilling this order, for margin reporting
  const supplierCost = service.cost_per_1000
    ? parseFloat((((service.cost_per_1000 * multiplier) / 1000) * quantity).toFixed(2))
    : 0;

  db.prepare(`UPDATE users SET ${walletField} = ${walletField} - ? WHERE id = ?`).run(totalCost, user.id);

  const info = db.prepare(`
    INSERT INTO orders (user_id, service_id, service_name, link, quantity, charge, currency, cost)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(user.id, service.id, service.name, link, quantity, totalCost, currency, supplierCost);

  const orderId = info.lastInsertRowid;

  // Referral Reward Logic (5% commission if amount >= 100 INR/equivalent)
  if (totalCost >= 100 && user.referred_by) {
    const referrer = db.prepare('SELECT id FROM users WHERE referral_code = ?').get(user.referred_by);
    if (referrer) {
      const commission = parseFloat((totalCost * 0.05).toFixed(2));
      db.prepare(`UPDATE users SET ${walletField} = ${walletField} + ? WHERE id = ?`).run(commission, referrer.id);
    }
  }

  return { order_id: orderId, charge: totalCost, cost: supplierCost, remaining_balance: user[walletField] - totalCost };
}

// ==================== SERVICES & ORDERS ====================
app.get('/api/services', (req, res) => {
  const services = db.prepare("SELECT * FROM services WHERE status = 'active'").all();
  res.json(services);
});

app.post('/api/orders/create', authenticateToken, async (req, res) => {
  const { service_id, link, quantity, currency = 'INR' } = req.body;
  const service = db.prepare('SELECT * FROM services WHERE id = ?').get(service_id);
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);

  if (!service) return res.status(404).json({ error: 'Service not found.' });
  if (quantity < service.min_quantity || quantity > service.max_quantity) {
    return res.status(400).json({ error: `Quantity must be between ${service.min_quantity} and ${service.max_quantity}` });
  }

  const placed = placeOrder(user, service, link, quantity, currency);
  if (placed.error) return res.status(400).json({ error: placed.error });

  // Services imported from an upstream panel are pushed to that supplier automatically
  if (service.provider_id) {
    const forwarded = await forwardOrderToProvider(placed.order_id);
    if (forwarded.error) {
      res.json({ success: false, warning: forwarded.error, order_id: placed.order_id, charge: placed.charge, remaining_balance: placed.remaining_balance });
      return;
    }
  }

  res.json({ success: true, order_id: placed.order_id, charge: placed.charge, remaining_balance: placed.remaining_balance });
});

app.get('/api/orders/my-orders', authenticateToken, (req, res) => {
  const orders = db.prepare('SELECT * FROM orders WHERE user_id = ? ORDER BY id DESC').all(req.user.id);
  res.json(orders);
});

// ==================== WALLET & ADD FUNDS ====================
// Manual top-ups are admin-only. Customer deposits must go through the
// Cashfree checkout in /api/cashfree/* so the wallet is credited from a
// verified payment, never from a client request.
app.post('/api/wallet/add-funds', authenticateToken, requireAdmin, (req, res) => {
  const { amount, currency = 'INR', payment_method } = req.body;
  if (!amount || amount <= 0) return res.status(400).json({ error: 'Invalid amount' });

  let walletField = 'wallet_inr';
  if (currency === 'USD') walletField = 'wallet_usd';
  if (currency === 'EUR') walletField = 'wallet_eur';

  db.prepare(`UPDATE users SET ${walletField} = ${walletField} + ? WHERE id = ?`).run(amount, req.user.id);
  db.prepare('INSERT INTO transactions (user_id, amount, currency, payment_method) VALUES (?, ?, ?, ?)').run(req.user.id, amount, currency, payment_method);

  res.json({ success: true, message: `Successfully added ${amount} ${currency} to wallet!` });
});

// ==================== SUPPORT TICKETS ====================
app.post('/api/support/tickets', authenticateToken, (req, res) => {
  const { subject, order_id, request_type, message } = req.body;
  if (!subject || !request_type || !message) {
    return res.status(400).json({ error: 'Please provide all ticket details.' });
  }

  const info = db.prepare(`
    INSERT INTO tickets (user_id, subject, order_id, request_type, message)
    VALUES (?, ?, ?, ?, ?)
  `).run(req.user.id, subject, order_id || 'N/A', request_type, message);

  res.json({ success: true, ticket_id: info.lastInsertRowid });
});

app.get('/api/support/tickets', authenticateToken, (req, res) => {
  const tickets = db.prepare('SELECT * FROM tickets WHERE user_id = ? ORDER BY id DESC').all(req.user.id);
  res.json(tickets);
});


// ==================== UPDATE PASSWORD ROUTE ====================
app.post('/api/user/change-password', authenticateToken, (req, res) => {
  const { currentPassword, newPassword } = req.body;
  if (!currentPassword || !newPassword) {
    return res.status(400).json({ error: 'Both current and new passwords are required.' });
  }

  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
  if (!user || !bcrypt.compareSync(currentPassword, user.password)) {
    return res.status(400).json({ error: 'Current password is incorrect.' });
  }

  if (newPassword.length < 6) {
    return res.status(400).json({ error: 'New password must be at least 6 characters.' });
  }

  const newHash = bcrypt.hashSync(newPassword, 10);
  db.prepare('UPDATE users SET password = ? WHERE id = ?').run(newHash, user.id);
  res.json({ success: true, message: 'Password updated successfully!' });
});

// ==================== ADMIN PANEL ROUTES ====================
app.get('/api/admin/services', authenticateToken, requireAdmin, (req, res) => {
  const services = db.prepare('SELECT * FROM services').all();
  res.json(services);
});

app.post('/api/admin/services', authenticateToken, requireAdmin, (req, res) => {
  const { category, name, rate_per_1000, min_quantity, max_quantity, description, image } = req.body;
  const info = db.prepare(`
    INSERT INTO services (category, name, rate_per_1000, min_quantity, max_quantity, description, image)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(category, name, rate_per_1000, min_quantity, max_quantity, description, image || null);
  res.json({ success: true, id: info.lastInsertRowid });
});

app.put('/api/admin/services/:id', authenticateToken, requireAdmin, (req, res) => {
  const { category, name, rate_per_1000, min_quantity, max_quantity, description, status, image } = req.body;
  db.prepare(`
    UPDATE services SET category=?, name=?, rate_per_1000=?, min_quantity=?, max_quantity=?, description=?, status=?, image=?
    WHERE id = ?
  `).run(category, name, rate_per_1000, min_quantity, max_quantity, description, status, image || null, req.params.id);
  res.json({ success: true, message: 'Service updated successfully.' });
});

// Bulk image assignment: { assignments: [{ id, image }] } or { category, image }
app.post('/api/admin/services/images', authenticateToken, requireAdmin, (req, res) => {
  const { assignments, category, image } = req.body;

  if (Array.isArray(assignments) && assignments.length) {
    const stmt = db.prepare('UPDATE services SET image = ? WHERE id = ?');
    db.transaction(() => {
      for (const a of assignments) stmt.run(a.image || null, a.id);
    })();
    return res.json({ success: true, updated: assignments.length });
  }

  if (category && image) {
    const info = db.prepare('UPDATE services SET image = ? WHERE category = ?').run(image, category);
    return res.json({ success: true, updated: info.changes, category });
  }

  res.status(400).json({ error: 'Provide assignments[] or a category + image.' });
});

app.delete('/api/admin/services/:id', authenticateToken, requireAdmin, (req, res) => {
  db.prepare('DELETE FROM services WHERE id = ?').run(req.params.id);
  res.json({ success: true, message: 'Service deleted successfully.' });
});

// Available card images for the services catalog
app.get('/api/admin/service-images', authenticateToken, requireAdmin, (req, res) => {
  const dir = path.join(__dirname, 'public', 'images', 'services');
  let files = [];

  try {
    files = fs.readdirSync(dir)
      .filter((f) => /\.(jpe?g|png|webp|gif)$/i.test(f))
      .sort();
  } catch (err) {
    files = [];
  }

  res.json(files.map((f) => ({ file: f, url: `/images/services/${f}` })));
});

// ==================== UPSTREAM PROVIDERS (sell via other panels) ====================
// Standard SMM-panel dialect used for every upstream call:
//   services -> ?key=..&action=services   -> { data: [{ service, name, rate, min, max, category }] }
//   add      -> ?key=..&action=add&service=&link=&quantity= -> { order: <id> }
//   status   -> ?key=..&action=status&id=  -> { status: 'Pending' | 'In progress' | 'Completed' | 'Partial' | 'Canceled' }
function providerRequest(provider, params, method = 'GET') {
  const config = {
    timeout: 25000,
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
  };

  if (method === 'GET') {
    config.params = { key: provider.api_key, ...params };
  } else {
    const payload = new URLSearchParams({ key: provider.api_key, ...params }).toString();
    config.data = payload;
  }

  return axios.request({ url: provider.api_url, method, ...config });
}

// Pulls the full catalog + rates from an upstream panel and mirrors it into `services`
async function syncProviderServices(provider) {
  const response = await providerRequest(provider, { action: 'services' });
  const body = response.data;
  const list = Array.isArray(body) ? body : body && body.data;

  if (!Array.isArray(list)) {
    throw new Error('Provider did not return a service list. Check the API URL and key.');
  }

  const markup = 1 + (Number(provider.markup_percent) || 0) / 100;
  const upsert = db.prepare(`
    SELECT id FROM services WHERE provider_id = ? AND upstream_service_id = ?
  `);
  const insert = db.prepare(`
    INSERT INTO services (category, name, rate_per_1000, min_quantity, max_quantity, description, provider_id, upstream_service_id, cost_per_1000, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const update = db.prepare(`
    UPDATE services SET category = ?, name = ?, rate_per_1000 = ?, min_quantity = ?, max_quantity = ?,
      description = ?, cost_per_1000 = ?, status = ? WHERE id = ?
  `);

  let added = 0;
  let updated = 0;

  db.transaction(() => {
    for (const item of list) {
      const upstreamId = String(item.service ?? item.id ?? '');
      if (!upstreamId) continue;

      const name = item.name || `Service ${upstreamId}`;
      const wholesaleRate = parseFloat(item.rate);
      if (!Number.isFinite(wholesaleRate)) continue;

      const retailRate = parseFloat((wholesaleRate * markup).toFixed(4));
      const min = parseInt(item.min) || 1;
      const max = parseInt(item.max) || 1000000;
      const category = item.category || 'Imported';
      const description = item.description || `Supplied by ${provider.name}`;
      const status = String(item.status || 'active').toLowerCase() === 'inactive' ? 'inactive' : 'active';

      const existing = upsert.get(provider.id, upstreamId);
      if (existing) {
        update.run(category, name, retailRate, min, max, description, wholesaleRate, status, existing.id);
        updated++;
      } else {
        insert.run(category, name, retailRate, min, max, description, provider.id, upstreamId, wholesaleRate, status);
        added++;
      }
    }
    db.prepare("UPDATE upstream_providers SET last_sync_at = CURRENT_TIMESTAMP WHERE id = ?").run(provider.id);
  })();

  return { added, updated, total: list.length };
}

// Pushes a locally created order to the upstream panel that supplies its service
async function forwardOrderToProvider(orderId) {
  const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId);
  if (!order) return { error: 'Order not found.' };

  const service = db.prepare('SELECT * FROM services WHERE id = ?').get(order.service_id);
  if (!service || !service.provider_id || !service.upstream_service_id) {
    return { error: 'This service is not linked to an upstream provider.' };
  }

  const provider = db.prepare("SELECT * FROM upstream_providers WHERE id = ? AND status = 'active'").get(service.provider_id);
  if (!provider) return { error: 'Upstream provider is missing or disabled.' };

  try {
    const response = await providerRequest(provider, {
      action: 'add',
      service: service.upstream_service_id,
      link: order.link,
      quantity: order.quantity
    }, 'POST');

    const body = response.data || {};
    const payload = body.order ? body : body.data;
    const upstreamOrderId = payload ? (payload.order ?? payload) : null;

    if (!upstreamOrderId) {
      return { error: `Upstream rejected the order: ${JSON.stringify(body)}` };
    }

    db.prepare('UPDATE orders SET upstream_order_id = ? WHERE id = ?').run(String(upstreamOrderId), orderId);
    return { upstream_order_id: String(upstreamOrderId) };
  } catch (err) {
    const detail = err.response ? JSON.stringify(err.response.data) : err.message;
    return { error: `Upstream order failed: ${detail}` };
  }
}

// Pulls the delivery status of forwarded orders back from the upstream panel
async function refreshUpstreamOrderStatus() {
  const pending = db.prepare(`
    SELECT o.id, o.service_id, o.upstream_order_id FROM orders o
    JOIN services s ON s.id = o.service_id
    WHERE o.upstream_order_id IS NOT NULL
      AND o.upstream_order_id != ''
      AND o.status IN ('Pending', 'In progress', 'Partial')
      AND s.provider_id IS NOT NULL
  `).all();

  let checked = 0;

  for (const order of pending) {
    const service = db.prepare('SELECT provider_id FROM services WHERE id = ?').get(order.service_id);
    const provider = db.prepare("SELECT * FROM upstream_providers WHERE id = ? AND status = 'active'").get(service.provider_id);
    if (!provider) continue;

    try {
      const response = await providerRequest(provider, { action: 'status', id: order.upstream_order_id });
      const payload = (response.data && (response.data.order ?? response.data.data)) || {};
      const raw = String(payload.status ?? (typeof payload === 'string' ? payload : '')).trim();
      if (!raw) continue;

      const statusMap = {
        pending: 'Pending',
        'in progress': 'In progress',
        inprogress: 'In progress',
        completed: 'Completed',
        complete: 'Completed',
        partial: 'Partial',
        canceled: 'Canceled',
        cancelled: 'Canceled',
        failed: 'Failed'
      };
      const mapped = statusMap[raw.toLowerCase()];
      if (!mapped) continue;

      db.prepare('UPDATE orders SET status = ? WHERE id = ?').run(mapped, order.id);
      checked++;
    } catch (err) {
      console.error(`Upstream status check failed for order ${order.id}:`, err.message);
    }
  }

  return checked;
}

app.post('/api/admin/providers/sync-all', authenticateToken, requireAdmin, async (req, res) => {
  const providers = db.prepare("SELECT * FROM upstream_providers WHERE status = 'active'").all();
  const results = [];

  for (const provider of providers) {
    try {
      results.push({ provider: provider.name, ok: true, ...(await syncProviderServices(provider)) });
    } catch (err) {
      results.push({ provider: provider.name, ok: false, error: err.message });
    }
  }

  res.json({ success: true, results });
});

app.get('/api/admin/providers', authenticateToken, requireAdmin, (req, res) => {
  const providers = db.prepare('SELECT * FROM upstream_providers ORDER BY id DESC').all();
  const counts = db.prepare(`
    SELECT provider_id, COUNT(*) AS service_count FROM services
    WHERE provider_id IS NOT NULL GROUP BY provider_id
  `).all();
  const map = new Map(counts.map((c) => [c.provider_id, c.service_count]));

  res.json(providers.map((p) => ({
    id: p.id,
    name: p.name,
    api_url: p.api_url,
    api_key: p.api_key,
    markup_percent: p.markup_percent,
    status: p.status,
    last_sync_at: p.last_sync_at,
    created_at: p.created_at,
    service_count: map.get(p.id) || 0
  })));
});

app.post('/api/admin/providers', authenticateToken, requireAdmin, (req, res) => {
  const { name, api_url, api_key, markup_percent = 0 } = req.body;
  if (!name || !api_url || !api_key) {
    return res.status(400).json({ error: 'Name, API URL and API key are all required.' });
  }

  const info = db.prepare(`
    INSERT INTO upstream_providers (name, api_url, api_key, markup_percent)
    VALUES (?, ?, ?, ?)
  `).run(name, api_url.trim(), api_key.trim(), Number(markup_percent) || 0);

  res.json({ success: true, id: info.lastInsertRowid });
});

app.put('/api/admin/providers/:id', authenticateToken, requireAdmin, (req, res) => {
  const { name, api_url, api_key, markup_percent = 0, status = 'active' } = req.body;
  const provider = db.prepare('SELECT * FROM upstream_providers WHERE id = ?').get(req.params.id);
  if (!provider) return res.status(404).json({ error: 'Provider not found.' });

  db.prepare(`
    UPDATE upstream_providers SET name = ?, api_url = ?, api_key = ?, markup_percent = ?, status = ? WHERE id = ?
  `).run(
    name || provider.name,
    (api_url || provider.api_url).trim(),
    api_key || provider.api_key,
    Number(markup_percent) || 0,
    status,
    provider.id
  );

  res.json({ success: true, message: 'Provider updated.' });
});

app.post('/api/admin/providers/:id/sync', authenticateToken, requireAdmin, async (req, res) => {
  const provider = db.prepare('SELECT * FROM upstream_providers WHERE id = ?').get(req.params.id);
  if (!provider) return res.status(404).json({ error: 'Provider not found.' });

  try {
    const summary = await syncProviderServices(provider);
    res.json({ success: true, ...summary });
  } catch (err) {
    const detail = err.response ? (err.response.data.message || JSON.stringify(err.response.data)) : err.message;
    res.status(502).json({ success: false, error: detail });
  }
});

app.delete('/api/admin/providers/:id', authenticateToken, requireAdmin, (req, res) => {
  const provider = db.prepare('SELECT * FROM upstream_providers WHERE id = ?').get(req.params.id);
  if (!provider) return res.status(404).json({ error: 'Provider not found.' });

  const orphaned = db.prepare('SELECT COUNT(*) AS n FROM services WHERE provider_id = ?').get(provider.id).n;
  db.transaction(() => {
    db.prepare('UPDATE services SET status = \'inactive\' WHERE provider_id = ?').run(provider.id);
    db.prepare('DELETE FROM upstream_providers WHERE id = ?').run(provider.id);
  })();

  res.json({ success: true, message: `Provider removed. ${orphaned} imported service(s) were deactivated.` });
});

app.post('/api/admin/orders/:id/forward', authenticateToken, requireAdmin, async (req, res) => {
  const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(req.params.id);
  if (!order) return res.status(404).json({ error: 'Order not found.' });
  if (order.upstream_order_id) return res.status(400).json({ error: 'Order was already forwarded upstream.' });

  const result = await forwardOrderToProvider(order.id);
  if (result.error) return res.status(502).json({ success: false, error: result.error });

  res.json({ success: true, upstream_order_id: result.upstream_order_id });
});

// ==================== RESELLER API (sell our services to other sites) ====================
// Mirrors the common SMM panel contract so external websites / scripts can buy from us
// using the same endpoint they already use for their own supplier.
function authenticateApiKey(req, res, next) {
  const key = req.body?.key || req.query.key || req.headers['x-api-key'];
  if (!key) return res.status(401).json({ error: 'No API key supplied' });

  const record = db.prepare("SELECT * FROM api_keys WHERE api_key = ? AND status = 'active'").get(String(key));
  if (!record) return res.status(403).json({ error: 'Invalid API key' });

  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(record.user_id);
  if (!user) return res.status(403).json({ error: 'API key is not linked to an active account' });

  req.apiUser = user;
  next();
}

app.post('/api/v2', authenticateApiKey, async (req, res) => {
  const { action, service, link, quantity, order } = req.body || {};

  switch (action) {
    case 'services': {
      const rows = db.prepare("SELECT id, category, name, rate_per_1000, min_quantity, max_quantity, description FROM services WHERE status = 'active'");
      return res.json({
        data: rows.all().map((s) => ({
          service: s.id,
          name: s.name,
          type: s.category,
          rate: s.rate_per_1000,
          min: s.min_quantity,
          max: s.max_quantity,
          description: s.description
        }))
      });
    }

    case 'add': {
      const svc = db.prepare('SELECT * FROM services WHERE id = ?').get(service);
      if (!svc) return res.json({ error: 'Invalid service id' });
      if (!link) return res.json({ error: 'Link is required' });

      const qty = parseInt(quantity);
      if (!Number.isFinite(qty) || qty < svc.min_quantity || qty > svc.max_quantity) {
        return res.json({ error: `Quantity must be between ${svc.min_quantity} and ${svc.max_quantity}` });
      }

      const placed = placeOrder(req.apiUser, svc, link, qty, req.apiUser.currency || 'INR');
      if (placed.error) return res.json({ error: placed.error });

      if (svc.provider_id) {
        const forwarded = await forwardOrderToProvider(placed.order_id);
        if (forwarded.error) {
          return res.json({ order: placed.order_id, warning: forwarded.error });
        }
      }

      return res.json({ order: placed.order_id, charge: placed.charge, start_count: 0 });
    }

    case 'status': {
      const row = db.prepare('SELECT * FROM orders WHERE id = ? AND user_id = ?').get(order, req.apiUser.id);
      if (!row) return res.json({ error: 'Order not found' });

      return res.json({
        order: row.id,
        charge: row.charge,
        start_count: 0,
        status: row.status,
        remains: 0,
        currency: row.currency
      });
    }

    case 'balance': {
      return res.json({
        balance: req.apiUser.wallet_inr,
        currency: 'INR'
      });
    }

    case 'refunds':
      return res.json({ data: [] });

    default:
      return res.json({ error: 'Invalid action. Use services, add, status, balance or refunds.' });
  }
});

app.get('/api/v2/services', authenticateApiKey, (req, res) => {
  const rows = db.prepare("SELECT id, category, name, rate_per_1000, min_quantity, max_quantity, description FROM services WHERE status = 'active'");
  res.json({
    data: rows.all().map((s) => ({
      service: s.id,
      name: s.name,
      type: s.category,
      rate: s.rate_per_1000,
      min: s.min_quantity,
      max: s.max_quantity,
      description: s.description
    }))
  });
});

// API key self-service for logged-in dashboard users
app.get('/api/user/api-key', authenticateToken, (req, res) => {
  const record = db.prepare('SELECT api_key, created_at FROM api_keys WHERE user_id = ?').get(req.user.id);
  res.json({ api_key: record ? record.api_key : null, created_at: record ? record.created_at : null });
});

app.post('/api/user/api-key', authenticateToken, (req, res) => {
  const existing = db.prepare('SELECT id FROM api_keys WHERE user_id = ?').get(req.user.id);
  const apiKey = 'JR' + crypto.randomBytes(20).toString('hex');
  const label = (req.body && req.body.label) || 'default';

  if (existing) {
    db.prepare('UPDATE api_keys SET api_key = ?, label = ? WHERE id = ?').run(apiKey, label, existing.id);
  } else {
    db.prepare('INSERT INTO api_keys (user_id, api_key, label) VALUES (?, ?, ?)').run(req.user.id, apiKey, label);
  }

  res.json({ success: true, api_key: apiKey });
});

// Keeps forwarded orders in sync with the upstream panel
if (process.env.ENABLE_DWR !== 'false') {
  setInterval(() => {
    refreshUpstreamOrderStatus().catch((err) => console.error('DWR sync error:', err.message));
  }, Number(process.env.DWR_INTERVAL_MS) || 60000);
}

// ==================== CASHFREE PAYMENTS ====================
// Environment configuration
const CASHFREE_CLIENT_ID = process.env.CASHFREE_CLIENT_ID;
const CASHFREE_CLIENT_SECRET = process.env.CASHFREE_CLIENT_SECRET;
const CASHFREE_BASE_URL = process.env.CASHFREE_BASE_URL || 'https://api.cashfree.com/pg'; // Production Endpoint
const CASHFREE_API_VERSION = process.env.CASHFREE_API_VERSION || '2023-08-01';
// Cashfree rejects non-https return URLs, so the public origin is configured
// explicitly rather than derived from the incoming request.
const PUBLIC_URL = (process.env.PUBLIC_URL || 'https://jayrajputmediapower.com').replace(/\/+$/, '');

const CASHFREE_HEADERS = () => ({
  'x-client-id': CASHFREE_CLIENT_ID,
  'x-client-secret': CASHFREE_CLIENT_SECRET,
  'x-api-version': CASHFREE_API_VERSION,
  'Content-Type': 'application/json'
});

/**
 * Credits the wallet for a verified payment. Safe to call repeatedly for the
 * same order: the `credited` flag is flipped in the same transaction as the
 * balance update, so a replayed callback or webhook cannot double-credit.
 */
function creditVerifiedPayment(orderId, cashfreeStatus) {
  const record = db.prepare('SELECT * FROM payment_orders WHERE order_id = ?').get(orderId);
  if (!record) return { credited: false, reason: 'Unknown order' };

  // Only a fresh PAID from the gateway may credit. Anything else just records
  // the latest status so the deposit history stays accurate.
  if (cashfreeStatus !== 'PAID') {
    db.prepare("UPDATE payment_orders SET payment_status = ?, updated_at = CURRENT_TIMESTAMP WHERE order_id = ? AND credited = 0")
      .run(cashfreeStatus, orderId);
    return { credited: false, reason: `Payment status is ${cashfreeStatus}` };
  }

  if (record.credited) return { credited: false, reason: 'Already credited', amount: record.amount };

  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(record.user_id);
  if (!user) return { credited: false, reason: 'User no longer exists' };

  const walletField = record.wallet_field || WALLET_BY_CURRENCY[record.currency] || 'wallet_inr';

  const claim = db.transaction(() => {
    const info = db.prepare("UPDATE payment_orders SET payment_status = 'PAID', credited = 1, updated_at = CURRENT_TIMESTAMP WHERE order_id = ? AND credited = 0").run(orderId);
    if (info.changes !== 1) return false;
    db.prepare(`UPDATE users SET ${walletField} = ${walletField} + ? WHERE id = ?`).run(record.amount, record.user_id);
    db.prepare('INSERT INTO transactions (user_id, amount, currency, payment_method) VALUES (?, ?, ?, ?)')
      .run(record.user_id, record.amount, record.currency, 'Cashfree');
    return true;
  });

  if (!claim()) return { credited: false, reason: 'Already credited', amount: record.amount };

  return { credited: true, amount: record.amount, currency: record.currency };
}

/**
 * Creates a Cashfree payment session for a wallet top-up.
 */
app.post('/api/cashfree/create-order', authenticateToken, async (req, res) => {
  try {
    const amount = parseFloat(req.body.amount);
    const currency = (req.body.currency || 'INR').toUpperCase();

    if (!Number.isFinite(amount) || amount < 10) {
      return res.status(400).json({ success: false, error: 'Minimum deposit is 10.' });
    }
    if (amount > 1000000) {
      return res.status(400).json({ success: false, error: 'Maximum deposit is 1000000.' });
    }
    // Cashfree settles in INR for this account, so only INR can be credited 1:1.
    if (currency !== 'INR') {
      return res.status(400).json({ success: false, error: 'Online deposits are in INR only. Contact support for USD/EUR top-ups.' });
    }

    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
    if (!user) return res.status(404).json({ success: false, error: 'Account not found.' });

    const orderId = `TOPUP_${Date.now()}_${crypto.randomBytes(4).toString('hex').toUpperCase()}`;

    db.prepare(`
      INSERT INTO payment_orders (order_id, user_id, amount, currency, wallet_field, payment_status)
      VALUES (?, ?, ?, ?, ?, 'PENDING')
    `).run(orderId, user.id, amount, currency, WALLET_BY_CURRENCY[currency] || 'wallet_inr');

    const orderPayload = {
      order_id: orderId,
      order_amount: amount.toFixed(2),
      order_currency: currency,
      customer_details: {
        customer_id: String(user.id),
        customer_name: user.name || 'Customer',
        customer_email: user.email,
        customer_phone: req.body.customer_phone || '9999999999'
      },
      order_meta: {
        // Cashfree substitutes {order_id} when it sends the customer back
        return_url: `${PUBLIC_URL}/api/cashfree/verify-payment?order_id={order_id}`,
        payment_link: false,
        // Cashfree posts server-to-server here as well, so funds are credited
        // even if the customer closes the browser before returning
        webhook_url: `${PUBLIC_URL}/api/cashfree/webhook`
      }
    };

    const response = await axios.post(`${CASHFREE_BASE_URL}/orders`, orderPayload, { headers: CASHFREE_HEADERS() });

    db.prepare('UPDATE payment_orders SET payment_session_id = ? WHERE order_id = ?')
      .run(response.data.payment_session_id, orderId);

    res.json({
      success: true,
      order_id: response.data.order_id,
      payment_session_id: response.data.payment_session_id
    });
  } catch (error) {
    const detail = error.response ? (error.response.data.message || JSON.stringify(error.response.data)) : error.message;
    console.error('Cashfree Order Creation Error:', detail);
    res.status(500).json({ success: false, error: detail });
  }
});

/**
 * Cashfree redirects the customer here after checkout. Status is re-checked
 * server-to-server, never trusted from the query string.
 */
app.get('/api/cashfree/verify-payment', async (req, res) => {
  const { order_id } = req.query;

  if (!order_id) return res.redirect('/#/payment-failed');

  try {
    const response = await axios.get(`${CASHFREE_BASE_URL}/orders/${order_id}`, { headers: CASHFREE_HEADERS() });
    const orderStatus = response.data.order_status;

    if (orderStatus === 'PAID') {
      creditVerifiedPayment(order_id, 'PAID');
      return res.redirect(`/#/payment-success?order_id=${order_id}`);
    }

    db.prepare("UPDATE payment_orders SET payment_status = ?, updated_at = CURRENT_TIMESTAMP WHERE order_id = ? AND credited = 0")
      .run(orderStatus, order_id);
    return res.redirect(`/#/payment-failed?order_id=${order_id}`);
  } catch (error) {
    console.error('Cashfree Verification Error:', error.response ? error.response.data : error.message);
    return res.redirect(`/#/payment-failed?order_id=${order_id}`);
  }
});

/**
 * Server-to-server notification from Cashfree. Signature verified against the
 * client secret so only genuine events credit a wallet.
 */
app.post('/api/cashfree/webhook', (req, res) => {
  const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.from('');
  const signature = req.get('x-cashfree-signature') || '';
  const expected = crypto.createHmac('sha256', CASHFREE_CLIENT_SECRET).update(raw).digest('hex');

  const timingSafeEqual = (a, b) => {
    const bufA = Buffer.from(String(a));
    const bufB = Buffer.from(String(b));
    return bufA.length === bufB.length && crypto.timingSafeEqual(bufA, bufB);
  };

  if (!signature || !timingSafeEqual(signature, expected)) {
    return res.status(401).json({ success: false, error: 'Invalid signature' });
  }

  try {
    const event = JSON.parse(raw.toString('utf8') || '{}');
    const data = event.data || {};
    const orderId = data.order_id;

    if (!orderId) return res.json({ success: true, ignored: true });

    const status = data.order_status || event.type || 'UNKNOWN';

    if (status === 'PAID') {
      creditVerifiedPayment(orderId, 'PAID');
    } else if (['FAILED', 'CANCELLED'].includes(String(status).toUpperCase())) {
      db.prepare("UPDATE payment_orders SET payment_status = ?, updated_at = CURRENT_TIMESTAMP WHERE order_id = ? AND credited = 0")
        .run(String(status).toUpperCase(), orderId);
    }

    res.json({ success: true });
  } catch (error) {
    console.error('Cashfree Webhook Error:', error.message);
    res.status(500).json({ success: false, error: 'Webhook processing failed' });
  }
});

/** Deposit history for the signed-in user */
app.get('/api/wallet/payments', authenticateToken, (req, res) => {
  const rows = db.prepare(`
    SELECT order_id, amount, currency, payment_status, credited, created_at
    FROM payment_orders WHERE user_id = ? ORDER BY id DESC LIMIT 50
  `).all(req.user.id);
  res.json(rows);
});

app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

app.get('{*splat}', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`🚀 Jay Rajput Media Power Server live on http://localhost:${PORT}`);
  console.log(`🗄️  Database: ${DB_PATH}`);
  console.log(`💳 Cashfree return/webhook origin: ${PUBLIC_URL}`);
});

// Change to your WhatsApp Number (with Country Code, no + symbol)
const ADMIN_WHATSAPP_NUMBER = "919876543210"; 

function veUpdateFileName(input) {
  const fileNameText = document.getElementById('veFileNameText');
  if (input.files && input.files[0]) {
    const file = input.files[0];
    const fileSizeMB = (file.size / (1024 * 1024)).toFixed(2);
    fileNameText.innerText = `Selected: ${file.name} (${fileSizeMB} MB)`;
  } else {
    fileNameText.innerText = 'Click or Drag video file here';
  }
}
