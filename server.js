const express = require('express');
const cors = require('cors');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const { Pool } = require('pg');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const axios = require('axios');
const { OAuth2Client } = require('google-auth-library');
const cloudinary = require('cloudinary').v2;
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 5000;
const JWT_SECRET = process.env.JWT_SECRET;

if (!JWT_SECRET) {
  console.error('JWT_SECRET environment variable is not set');
  process.exit(1);
}

// Cloudinary configuration
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME || 'iobtqc2g',
  api_key: process.env.CLOUDINARY_API_KEY || '175498488934745',
  api_secret: process.env.CLOUDINARY_API_SECRET || 'FDC-_1qDMCKRp-JswrOmku37HaQ'
});
console.log('Cloudinary configured');

app.use(cors());
// The webhook must see the untouched request body to verify its HMAC signature,
// so it is parsed as a raw buffer before the JSON parser runs.
app.use('/api/cashfree/webhook', express.raw({ type: '*/*', limit: '1mb' }));
app.use(express.json({ limit: '12mb' }));
app.use(express.urlencoded({ extended: true, limit: '12mb' }));
app.use(express.static(path.join(__dirname, 'public'), {
  setHeaders(res, filePath) {
    if (path.extname(filePath) === '.html') {
      res.setHeader('Cache-Control', 'no-store');
    }
  }
}));

// Returns clean JSON instead of an HTML stack trace when a body cannot be parsed
app.use((err, req, res, next) => {
  if (err && err.type === 'entity.too.large') {
    return res.status(413).json({ error: 'Image is too large to upload. Maximum size is 12MB.' });
  }
  if (err && (err.type === 'entity.parse.failed' || err instanceof SyntaxError)) {
    return res.status(400).json({ error: 'Malformed request body. Send JSON or x-www-form-urlencoded.' });
  }
  next(err);
});

// Database configuration for Vercel serverless.
// Uses PostgreSQL via pg. For Vercel Postgres, checks multiple possible env var names.
let pool;
try {
  const connectionString = process.env.DATABASE_URL 
    || process.env.POSTGRES_URL 
    || process.env.vercel_DATABASE_URL 
    || process.env.vercel_POSTGRES_URL;
  if (!connectionString) {
    console.error('DATABASE_URL or POSTGRES_URL or vercel_DATABASE_URL environment variable is not set');
    throw new Error('DATABASE_URL or POSTGRES_URL environment variable is not set');
  }
  pool = new Pool({ connectionString });
  console.log('Database pool created successfully');
} catch (e) {
  console.error('Failed to create database pool:', e.message);
  throw e;
}

async function initDb() {
  console.log('Initializing database...');
  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        name TEXT,
        email TEXT UNIQUE,
        password TEXT,
        google_id TEXT,
        role TEXT DEFAULT 'user',
        wallet_inr REAL DEFAULT 0,
        wallet_usd REAL DEFAULT 0,
        wallet_eur REAL DEFAULT 0,
        currency TEXT DEFAULT 'INR',
        referral_code TEXT UNIQUE,
        referred_by TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS services (
        id SERIAL PRIMARY KEY,
        category TEXT,
        name TEXT,
        rate_per_1000 REAL,
        min_quantity INTEGER,
        max_quantity INTEGER,
        description TEXT,
        status TEXT DEFAULT 'active'
      );

      CREATE TABLE IF NOT EXISTS orders (
        id SERIAL PRIMARY KEY,
        user_id INTEGER,
        service_id INTEGER,
        service_name TEXT,
        link TEXT,
        quantity INTEGER,
        charge REAL,
        currency TEXT,
        status TEXT DEFAULT 'Pending',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (user_id) REFERENCES users (id)
      );

      CREATE TABLE IF NOT EXISTS tickets (
        id SERIAL PRIMARY KEY,
        user_id INTEGER,
        subject TEXT,
        order_id TEXT,
        request_type TEXT,
        message TEXT,
        status TEXT DEFAULT 'Open',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS transactions (
        id SERIAL PRIMARY KEY,
        user_id INTEGER,
        amount REAL,
        currency TEXT,
        payment_method TEXT,
        status TEXT DEFAULT 'Completed',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS api_keys (
        id SERIAL PRIMARY KEY,
        user_id INTEGER UNIQUE,
        api_key TEXT UNIQUE,
        label TEXT,
        status TEXT DEFAULT 'active',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (user_id) REFERENCES users (id)
      );

      CREATE TABLE IF NOT EXISTS upstream_providers (
        id SERIAL PRIMARY KEY,
        name TEXT,
        api_url TEXT,
        api_key TEXT,
        markup_percent REAL DEFAULT 0,
        status TEXT DEFAULT 'active',
        last_sync_at TIMESTAMP,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS provider_services (
        id SERIAL PRIMARY KEY,
        provider_id INTEGER REFERENCES upstream_providers(id) ON DELETE CASCADE,
        upstream_service_id TEXT,
        name TEXT,
        category TEXT,
        rate REAL,
        min_quantity INTEGER,
        max_quantity INTEGER,
        description TEXT,
        status TEXT DEFAULT 'active',
        is_selected BOOLEAN DEFAULT true,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(provider_id, upstream_service_id)
      );

      CREATE TABLE IF NOT EXISTS payment_orders (
        id SERIAL PRIMARY KEY,
        order_id TEXT UNIQUE,
        user_id INTEGER,
        amount REAL,
        currency TEXT,
        wallet_field TEXT,
        payment_status TEXT DEFAULT 'PENDING',
        payment_session_id TEXT,
        credited INTEGER DEFAULT 0,
        refunded INTEGER DEFAULT 0,
        refunded_amount REAL DEFAULT 0,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP,
        FOREIGN KEY (user_id) REFERENCES users (id)
      );

      CREATE TABLE IF NOT EXISTS user_logins (
        id SERIAL PRIMARY KEY,
        user_id INTEGER REFERENCES users (id),
        ip TEXT,
        user_agent TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS user_service_prices (
        id SERIAL PRIMARY KEY,
        user_id INTEGER REFERENCES users (id),
        service_id INTEGER REFERENCES services (id),
        custom_rate_per_1000 REAL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(user_id, service_id)
      );

      CREATE TABLE IF NOT EXISTS ticket_replies (
        id SERIAL PRIMARY KEY,
        ticket_id INTEGER REFERENCES tickets (id),
        sender_user_id INTEGER REFERENCES users (id),
        is_admin BOOLEAN DEFAULT false,
        message TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS site_settings (
        key TEXT PRIMARY KEY,
        value TEXT
      );

      CREATE TABLE IF NOT EXISTS site_themes (
        id SERIAL PRIMARY KEY,
        name TEXT UNIQUE,
        label TEXT,
        palette_json TEXT,
        banner_url TEXT,
        is_active BOOLEAN DEFAULT false,
        layout TEXT NOT NULL DEFAULT 'classic',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS categories (
        id SERIAL PRIMARY KEY,
        name TEXT UNIQUE,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);
    console.log('Database tables created successfully');
  } finally {
    client.release();
  }
}

// Lightweight migrations for columns added after the initial schema
const addColumnIfMissing = async (table, column, definition) => {
  const existing = await pool.query('SELECT column_name FROM information_schema.columns WHERE table_name = $1 AND column_name = $2', [table, column]);
  if (!existing.rows.length) {
    await pool.query(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
};

async function initializeAppData() {
  await addColumnIfMissing('services', 'provider_id', 'INTEGER');
  await addColumnIfMissing('services', 'upstream_service_id', 'TEXT');
  await addColumnIfMissing('services', 'cost_per_1000', 'REAL');
  await addColumnIfMissing('services', 'image', 'TEXT');
  await addColumnIfMissing('orders', 'upstream_order_id', 'TEXT');
  await addColumnIfMissing('orders', 'cost', 'REAL DEFAULT 0');
  await addColumnIfMissing('users', 'status', "TEXT DEFAULT 'active'");
  await addColumnIfMissing('tickets', 'resolved_at', 'TIMESTAMP');
  await addColumnIfMissing('site_themes', 'layout', "TEXT NOT NULL DEFAULT 'classic'");
  await addColumnIfMissing('site_themes', 'occasion_message', 'TEXT');
  await addColumnIfMissing('payment_orders', 'refunded', 'INTEGER DEFAULT 0');
  await addColumnIfMissing('payment_orders', 'refunded_amount', 'REAL DEFAULT 0');
  await addColumnIfMissing('payment_orders', 'payment_method', "TEXT NOT NULL DEFAULT 'Cashfree'");
  await addColumnIfMissing('payment_orders', 'utr', 'TEXT');
  await pool.query("CREATE UNIQUE INDEX IF NOT EXISTS payment_orders_utr_unique_idx ON payment_orders (LOWER(utr)) WHERE utr IS NOT NULL AND BTRIM(utr) <> ''");

  // Insert default Admin if not exists
  const adminCheck = await pool.query('SELECT * FROM users WHERE email = $1', ['admin@jayrajputmediapower.com']);
  if (!adminCheck.rows.length) {
    const hash = bcrypt.hashSync('admin@3360', 10);
    await pool.query(
      `INSERT INTO users (name, email, password, role, referral_code) VALUES ($1, $2, $3, $4, $5)`,
      ['Admin Jay Rajput', 'admin@jayrajputmediapower.com', hash, 'admin', 'JRADMIN']
    );
  }

  // Recover default in-house services if they were deleted
  const defaultServices = [
    { category: 'Instagram', name: 'Instagram Followers [High Quality - Non Drop]', rate_per_1000: 120.00, min_quantity: 100, max_quantity: 50000, description: 'Instant start, 30 days refill guarantee.', image: 'https://res.cloudinary.com/iobtqc2g/image/upload/v1791301870/jayrajputmedia/services/services/service-01.jpg' },
    { category: 'Instagram', name: 'Instagram Likes [Real Active Users]', rate_per_1000: 40.00, min_quantity: 50, max_quantity: 100000, description: 'Fast speed, organic appearance.', image: 'https://res.cloudinary.com/iobtqc2g/image/upload/v1791301871/jayrajputmedia/services/services/service-02.jpg' },
    { category: 'Facebook', name: 'Facebook Page Likes & Followers', rate_per_1000: 180.00, min_quantity: 100, max_quantity: 20000, description: 'Worldwide targeting, safe delivery.', image: 'https://res.cloudinary.com/iobtqc2g/image/upload/v1791301871/jayrajputmedia/services/services/service-03.jpg' },
    { category: 'YouTube', name: 'YouTube WatchTime Hours [Monetizable]', rate_per_1000: 850.00, min_quantity: 500, max_quantity: 4000, description: 'Refill enabled, 100% safe.', image: 'https://res.cloudinary.com/iobtqc2g/image/upload/v1791301872/jayrajputmedia/services/services/service-04.jpg' }
  ];

  const existingCount = await pool.query("SELECT COUNT(*) AS n FROM services WHERE provider_id IS NULL");
  if (parseInt(existingCount.rows[0].n) === 0) {
    for (const svc of defaultServices) {
      await pool.query(
        `INSERT INTO services (category, name, rate_per_1000, min_quantity, max_quantity, description, image) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [svc.category, svc.name, svc.rate_per_1000, svc.min_quantity, svc.max_quantity, svc.description, svc.image]
      );
    }
    console.log('Recovered default in-house services.');
  } else {
    // Ensure existing in-house services have images
    for (const svc of defaultServices) {
      await pool.query(
        `UPDATE services SET image = $1 WHERE name = $2 AND provider_id IS NULL AND (image IS NULL OR image = '')`,
        [svc.image, svc.name]
      );
    }
  }

  await pool.query(
    `INSERT INTO categories (name)
     SELECT DISTINCT TRIM(category) FROM services
     WHERE category IS NOT NULL AND TRIM(category) <> ''
     ON CONFLICT (name) DO NOTHING`
  );
  await pool.query(
    `INSERT INTO categories (name)
     SELECT DISTINCT TRIM(category) FROM provider_services
     WHERE category IS NOT NULL AND TRIM(category) <> ''
     ON CONFLICT (name) DO NOTHING`
  );

  // Ensure the built-in quick themes are available alongside custom themes.
  const defaultThemes = [
    ['Default', 'Classic Storefront', '{"primary":"#1e40af","accent":"#f59e0b","bg":"#ffffff","text":"#1f2937","surface":"#ffffff","font":"Plus Jakarta Sans","headingFont":"Outfit"}', null, true, 'classic'],
    ['Diwali', 'Festive', '{"primary":"#d97706","accent":"#eab308","bg":"#fffff7","text":"#78350f","surface":"#ffffff","font":"Plus Jakarta Sans","headingFont":"Outfit"}', null, false, 'editorial'],
    ['Holi', 'Festive', '{"primary":"#ec4899","accent":"#a855f7","bg":"#fff0f6","text":"#7c2d7c","surface":"#ffffff","font":"Plus Jakarta Sans","headingFont":"Outfit"}', null, false, 'editorial'],
    ['Eid', 'Festive', '{"primary":"#0f766e","accent":"#2dd36f","bg":"#ecfdf5","text":"#064e35","surface":"#ffffff","font":"Plus Jakarta Sans","headingFont":"Plus Jakarta Sans"}', null, false, 'minimal'],
    ['Christmas', 'Festive', '{"primary":"#b91c1c","accent":"#f59e0b","bg":"#ffeff1","text":"#7f1d1d","surface":"#ffffff","font":"Plus Jakarta Sans","headingFont":"Outfit"}', null, false, 'classic'],
    ['Minimal', 'Minimal Studio', '{"primary":"#334155","accent":"#0f766e","bg":"#f8fafc","text":"#0f172a","surface":"#ffffff","font":"Plus Jakarta Sans","headingFont":"Plus Jakarta Sans"}', null, false, 'minimal'],
    ['Editorial', 'Editorial Spotlight', '{"primary":"#7c3aed","accent":"#db2777","bg":"#faf5ff","text":"#1f1635","surface":"#ffffff","font":"Plus Jakarta Sans","headingFont":"Outfit"}', null, false, 'editorial']
  ];
  for (const t of defaultThemes) {
    await pool.query(
      `INSERT INTO site_themes (name, label, palette_json, banner_url, is_active, layout) VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT (name) DO NOTHING`,
      t
    );
  }

  await pool.query(
    `INSERT INTO site_settings (key, value) VALUES ('active_theme', 'Default') ON CONFLICT (key) DO NOTHING`
  );
  const activeThemeSetting = await pool.query("SELECT value FROM site_settings WHERE key = 'active_theme'");
  let activeThemeName = activeThemeSetting.rows[0]?.value;
  const activeThemeExists = await pool.query('SELECT id FROM site_themes WHERE name = $1', [activeThemeName]);
  if (!activeThemeExists.rows.length) {
    const fallbackTheme = await pool.query('SELECT name FROM site_themes ORDER BY id LIMIT 1');
    activeThemeName = fallbackTheme.rows[0]?.name || 'Default';
    await pool.query(
      `INSERT INTO site_settings (key, value) VALUES ('active_theme', $1)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
      [activeThemeName]
    );
  }
  await pool.query('UPDATE site_themes SET is_active = (name = $1)', [activeThemeName]);
}

// Middleware: Authentication
const authenticateToken = async (req, res, next) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'Access Denied: No Token Provided' });

  try {
    const tokenUser = jwt.verify(token, JWT_SECRET);
    if (!tokenUser || typeof tokenUser !== 'object' || !tokenUser.id) {
      return res.status(403).json({ error: 'Invalid Token' });
    }

    const result = await pool.query(
      'SELECT id, email, role, status FROM users WHERE id = $1',
      [tokenUser.id]
    );
    const user = result.rows[0];
    if (!user) return res.status(401).json({ error: 'Account not found.' });
    if (user.status === 'suspended') {
      return res.status(403).json({ error: 'This account is suspended. Please contact support.' });
    }

    req.user = { ...tokenUser, id: user.id, email: user.email, role: user.role };
    next();
  } catch (error) {
    if (error && ['JsonWebTokenError', 'TokenExpiredError', 'NotBeforeError'].includes(error.name)) {
      return res.status(403).json({ error: 'Invalid Token' });
    }
    console.error('Authentication check failed:', error);
    res.status(500).json({ error: 'Could not verify account status.' });
  }
};

// Middleware: Admin Authorization
const requireAdmin = (req, res, next) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin Access Required' });
  next();
};

// ==================== AUTH ROUTES ====================
app.post('/api/auth/register', async (req, res) => {
  const { name, email, password, referral_code } = req.body;
  if (!name || !email || !password) return res.status(400).json({ error: 'All fields are required.' });

  try {
    console.log('Register attempt for:', email);
    const existing = await pool.query('SELECT * FROM users WHERE email = $1', [email]);
    if (existing.rows.length) return res.status(400).json({ error: 'Email already registered.' });

    const hash = bcrypt.hashSync(password, 10);
    const myRefCode = 'JR' + Math.random().toString(36).substring(2, 7).toUpperCase();

    const stmt = await pool.query(
      `INSERT INTO users (name, email, password, referral_code, referred_by) VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      [name, email, hash, myRefCode, referral_code || null]
    );

    const userId = stmt.rows[0].id;
    console.log('User created with ID:', userId);
    const token = jwt.sign({ id: userId, email, role: 'user' }, JWT_SECRET, { expiresIn: '7d' });
    res.json({ token, user: { id: userId, name, email, role: 'user', referral_code: myRefCode } });
  } catch (err) {
    console.error('Register error:', err);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/auth/login', async (req, res) => {
  const { email, password } = req.body;
  if (typeof email !== 'string' || typeof password !== 'string' || !email || !password) {
    return res.status(401).json({ error: 'Invalid credentials. Please check your email and password.' });
  }
  try {
    console.log('Login attempt for:', email);
    const user = await pool.query('SELECT * FROM users WHERE email = $1', [email]);
    const existingUser = user.rows[0];
    if (!existingUser || typeof existingUser.password !== 'string' || !bcrypt.compareSync(password, existingUser.password)) {
      return res.status(401).json({ error: 'Invalid credentials. Please check your email and password.' });
    }
    if (existingUser.status === 'suspended') {
      return res.status(403).json({ error: 'This account is suspended. Please contact support.' });
    }

    const token = jwt.sign({ id: existingUser.id, email: existingUser.email, role: existingUser.role }, JWT_SECRET, { expiresIn: '7d' });

    // Best-effort sign-in log (enables Admin > Users > Sign-in history). Non-blocking.
    pool.query('INSERT INTO user_logins (user_id, ip, user_agent) VALUES ($1, $2, $3)',
      [existingUser.id, req.ip || req.socket.remoteAddress || 'unknown', req.get('User-Agent') || '']).catch(() => {});

    res.json({
      token,
      user: {
        id: existingUser.id,
        name: existingUser.name,
        email: existingUser.email,
        role: existingUser.role,
        wallet_inr: existingUser.wallet_inr,
        wallet_usd: existingUser.wallet_usd,
        wallet_eur: existingUser.wallet_eur,
        currency: existingUser.currency,
        referral_code: existingUser.referral_code
      }
    });
  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ error: err.message });
  }
});

const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || '144460065869-cj42bposvevvpneci3s32qmeb72jcpho.apps.googleusercontent.com';
const googleAuthClient = new OAuth2Client(GOOGLE_CLIENT_ID);

app.post('/api/auth/google', async (req, res) => {
  const { credential } = req.body;
  if (typeof credential !== 'string' || !credential) {
    return res.status(400).json({ error: 'This page is out of date. Refresh it and try Google Sign-In again.' });
  }

  let identity;
  try {
    const ticket = await googleAuthClient.verifyIdToken({ idToken: credential, audience: GOOGLE_CLIENT_ID });
    identity = ticket.getPayload();
  } catch (error) {
    const networkErrorCodes = ['ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED', 'ERR_NETWORK'];
    const serviceUnavailable = error && (
      networkErrorCodes.includes(error.code)
      || (error.response && (error.response.status >= 500 || error.response.status === 429))
    );
    if (serviceUnavailable) {
      console.error('Google ID token verification service failed:', error);
      return res.status(502).json({ error: 'Google Sign-In verification is temporarily unavailable. Please try again.' });
    }
    return res.status(401).json({ error: 'Google Sign-In could not verify this account.' });
  }

  const email = typeof identity?.email === 'string' ? identity.email.trim().toLowerCase() : '';
  if (!identity || !identity.sub || !email || identity.email_verified !== true) {
    return res.status(401).json({ error: 'Google Sign-In could not verify this account.' });
  }

  try {
    console.log('Google Sign-In attempt for verified account:', email);
    let user = await pool.query('SELECT * FROM users WHERE LOWER(email) = $1', [email]);
    if (user.rows[0] && user.rows[0].status === 'suspended') {
      return res.status(403).json({ error: 'This account is suspended. Please contact support.' });
    }

    if (!user.rows.length) {
      const myRefCode = 'JR' + Math.random().toString(36).substring(2, 7).toUpperCase();
      const info = await pool.query(
        `INSERT INTO users (name, email, google_id, role, referral_code) VALUES ($1, $2, $3, 'user', $4) RETURNING id`,
        [identity.name || email.split('@')[0], email, identity.sub, myRefCode]
      );
      const newUserId = info.rows[0].id;
      user = await pool.query('SELECT * FROM users WHERE id = $1', [newUserId]);
      console.log('New Google user created:', email);
    } else {
      console.log('Existing Google user logged in:', email);
    }

    const account = user.rows[0];
    const token = jwt.sign({ id: account.id, email: account.email, role: account.role }, JWT_SECRET, { expiresIn: '7d' });
    res.json({
      token,
      user: {
        id: account.id,
        name: account.name,
        email: account.email,
        role: account.role,
        wallet_inr: account.wallet_inr,
        wallet_usd: account.wallet_usd,
        wallet_eur: account.wallet_eur,
        currency: account.currency,
        referral_code: account.referral_code
      }
    });
  } catch (err) {
    console.error('Google Sign-In account lookup failed:', err);
    res.status(500).json({ error: 'Could not complete Google Sign-In. Please try again.' });
  }
});

// User Profile & Balance
app.get('/api/user/profile', authenticateToken, async (req, res) => {
  const user = await pool.query('SELECT id, name, email, role, wallet_inr, wallet_usd, wallet_eur, currency, referral_code, referred_by FROM users WHERE id = $1', [req.user.id]);
  res.json(user.rows[0]);
});

// ==================== PRICING & ORDER PLACEMENT ====================
const WALLET_BY_CURRENCY = { INR: 'wallet_inr', USD: 'wallet_usd', EUR: 'wallet_eur' };
const CURRENCY_MULTIPLIER = { INR: 1, USD: 0.012, EUR: 0.011 };

// Places an order for a user: charges the wallet, writes the order, applies referral commission.
// Returns { error } on failure, otherwise the created order summary.
async function placeOrder(user, service, link, quantity, currency = 'INR') {
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

  await pool.query(`UPDATE users SET ${walletField} = ${walletField} - $1 WHERE id = $2`, [totalCost, user.id]);

    const info = await pool.query(
      `INSERT INTO orders (user_id, service_id, service_name, link, quantity, charge, currency, cost) VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
      [user.id, service.id, service.name, link, quantity, totalCost, currency, supplierCost]
    );

    const orderId = info.rows[0].id;

  // Apply the ₹100 eligibility threshold in INR, regardless of order currency.
  const orderValueInInr = totalCost / multiplier;
  if (orderValueInInr > 100 && user.referred_by) {
    const referrer = await pool.query('SELECT id FROM users WHERE referral_code = $1', [user.referred_by]);
    if (referrer.rows.length) {
      const commission = parseFloat((totalCost * 0.10).toFixed(2));
      await pool.query(`UPDATE users SET ${walletField} = ${walletField} + $1 WHERE id = $2`, [commission, referrer.rows[0].id]);
    }
  }

  return { order_id: orderId, charge: totalCost, cost: supplierCost, remaining_balance: user[walletField] - totalCost };
}

// ==================== SERVICES & ORDERS ====================
app.get('/api/services', async (req, res) => {
  const services = await pool.query("SELECT * FROM services WHERE status = 'active'");
  res.json(services.rows);
});

app.post('/api/orders/create', authenticateToken, async (req, res) => {
  const { service_id, link, quantity, currency = 'INR' } = req.body;
  const service = await pool.query('SELECT * FROM services WHERE id = $1', [service_id]);
  const user = await pool.query('SELECT * FROM users WHERE id = $1', [req.user.id]);

  if (!service.rows.length) return res.status(404).json({ error: 'Service not found.' });
  if (quantity < service.rows[0].min_quantity || quantity > service.rows[0].max_quantity) {
    return res.status(400).json({ error: `Quantity must be between ${service.rows[0].min_quantity} and ${service.rows[0].max_quantity}` });
  }

  const placed = await placeOrder(user.rows[0], service.rows[0], link, quantity, currency);
  if (placed.error) return res.status(400).json({ error: placed.error });

  // Services imported from an upstream panel are pushed to that supplier automatically
  if (service.rows[0].provider_id) {
    const forwarded = await forwardOrderToProvider(placed.order_id);
    if (forwarded.error) {
      res.json({ success: false, warning: forwarded.error, order_id: placed.order_id, charge: placed.charge, remaining_balance: placed.remaining_balance });
      return;
    }
  }

  res.json({ success: true, order_id: placed.order_id, charge: placed.charge, remaining_balance: placed.remaining_balance });
});

app.get('/api/orders/my-orders', authenticateToken, async (req, res) => {
  const orders = await pool.query('SELECT * FROM orders WHERE user_id = $1 ORDER BY id DESC', [req.user.id]);
  res.json(orders.rows);
});

// ==================== WALLET & ADD FUNDS ====================
// Manual top-ups are admin-only. Customer deposits must go through the
// Cashfree checkout in /api/cashfree/* so the wallet is credited from a
// verified payment, never from a client request.
app.post('/api/wallet/add-funds', authenticateToken, requireAdmin, async (req, res) => {
  const { amount, currency = 'INR', payment_method } = req.body;
  if (!amount || amount <= 0) return res.status(400).json({ error: 'Invalid amount' });

  let walletField = 'wallet_inr';
  if (currency === 'USD') walletField = 'wallet_usd';
  if (currency === 'EUR') walletField = 'wallet_eur';

  await pool.query(`UPDATE users SET ${walletField} = ${walletField} + $1 WHERE id = $2`, [amount, req.user.id]);
  await pool.query('INSERT INTO transactions (user_id, amount, currency, payment_method) VALUES ($1, $2, $3, $4)', [req.user.id, amount, currency, payment_method]);

  res.json({ success: true, message: `Successfully added ${amount} ${currency} to wallet!` });
});

// ==================== SUPPORT TICKETS ====================
app.post('/api/support/tickets', authenticateToken, async (req, res) => {
  const { subject, order_id, request_type, message } = req.body;
  if (!subject || !request_type || !message) {
    return res.status(400).json({ error: 'Please provide all ticket details.' });
  }

  const info = await pool.query(
    `INSERT INTO tickets (user_id, subject, order_id, request_type, message) VALUES ($1, $2, $3, $4, $5) RETURNING id`,
    [req.user.id, subject, order_id || 'N/A', request_type, message]
  );

  res.json({ success: true, ticket_id: info.rows[0].id });
});

app.get('/api/support/tickets', authenticateToken, async (req, res) => {
  const tickets = await pool.query('SELECT * FROM tickets WHERE user_id = $1 ORDER BY id DESC', [req.user.id]);
  res.json(tickets.rows);
});


// ==================== UPDATE PASSWORD ROUTE ====================
app.post('/api/user/change-password', authenticateToken, async (req, res) => {
  const { currentPassword, newPassword } = req.body;
  if (!currentPassword || !newPassword) {
    return res.status(400).json({ error: 'Both current and new passwords are required.' });
  }

    const user = await pool.query('SELECT * FROM users WHERE id = $1', [req.user.id]);
  const existingUser = user.rows[0];
  if (!existingUser || !bcrypt.compareSync(currentPassword, existingUser.password)) {
    return res.status(400).json({ error: 'Current password is incorrect.' });
  }

  if (newPassword.length < 6) {
    return res.status(400).json({ error: 'New password must be at least 6 characters.' });
  }

  const newHash = bcrypt.hashSync(newPassword, 10);
  await pool.query('UPDATE users SET password = $1 WHERE id = $2', [newHash, user.rows[0].id]);
  res.json({ success: true, message: 'Password updated successfully!' });
});

// ==================== ADMIN PANEL ROUTES ====================
app.get('/api/admin/services', authenticateToken, requireAdmin, async (req, res) => {
  const services = await pool.query('SELECT * FROM services');
  res.json(services.rows);
});

app.post('/api/admin/services', authenticateToken, requireAdmin, async (req, res) => {
  const { category, name, rate_per_1000, min_quantity, max_quantity, description, image } = req.body;
  const info = await pool.query(
    `INSERT INTO services (category, name, rate_per_1000, min_quantity, max_quantity, description, image) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
    [category, name, rate_per_1000, min_quantity, max_quantity, description, image || null]
  );
  res.json({ success: true, id: info.rows[0].id });
});

app.put('/api/admin/services/:id', authenticateToken, requireAdmin, async (req, res) => {
  const { category, name, rate_per_1000, min_quantity, max_quantity, description, status, image } = req.body;
  await pool.query(
    `UPDATE services SET category=$1, name=$2, rate_per_1000=$3, min_quantity=$4, max_quantity=$5, description=$6, status=$7, image=$8 WHERE id = $9`,
    [category, name, rate_per_1000, min_quantity, max_quantity, description, status, image || null, req.params.id]
  );
  res.json({ success: true, message: 'Service updated successfully.' });
});

// Bulk image assignment: { assignments: [{ id, image }] } or { category, image }
app.post('/api/admin/services/images', authenticateToken, requireAdmin, async (req, res) => {
  const { assignments, category, image } = req.body;

  if (Array.isArray(assignments) && assignments.length) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      for (const a of assignments) {
        await client.query('UPDATE services SET image = $1 WHERE id = $2', [a.image || null, a.id]);
      }
      await client.query('COMMIT');
      return res.json({ success: true, updated: assignments.length });
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  if (category && image) {
    const info = await pool.query('UPDATE services SET image = $1 WHERE category = $2', [image, category]);
    return res.json({ success: true, updated: info.rowCount, category });
  }

  res.status(400).json({ error: 'Provide assignments[] or a category + image.' });
});

app.delete('/api/admin/services/:id', authenticateToken, requireAdmin, async (req, res) => {
  await pool.query('DELETE FROM services WHERE id = $1', [req.params.id]);
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

// Upload image to Cloudinary (admin only)
app.post('/api/admin/upload-image', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const imageData = req.body.image;
    if (!imageData) {
      return res.status(400).json({ error: 'No image data provided.' });
    }

    console.log('Uploading image to Cloudinary, data length:', imageData.length);

    const result = await cloudinary.uploader.upload(imageData, {
      folder: 'jayrajputmedia/services',
      resource_type: 'image',
      transformation: [
        { width: 800, height: 600, crop: 'limit', quality: 'auto' },
        { fetch_format: 'auto' }
      ]
    });

    console.log('Cloudinary upload success:', result.secure_url);
    res.json({ url: result.secure_url, public_id: result.public_id });
  } catch (err) {
    console.error('Cloudinary upload error:', err);
    res.status(500).json({ error: 'Image upload failed: ' + (err.message || 'Unknown error') });
  }
});

// ==================== UPSTREAM PROVIDERS (sell via other panels) ====================
// Standard SMM-panel dialect used for every upstream call:
//   services -> ?key=..&action=services   -> { data: [{ service, name, rate, min, max, category }] }
//   add      -> ?key=..&action=add&service=&link=&quantity= -> { order: <id> }
//   status   -> ?key=..&action=status&id=  -> { status: 'Pending' | 'In progress' | 'Completed' | 'Partial' | 'Canceled' }
function providerRequest(provider, params, method = 'GET') {
  const config = {
    timeout: 60000,
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
  let response;
  let body;
  let list;
  let usedMethod = 'GET';

  try {
    response = await providerRequest(provider, { action: 'services' });
    body = response.data;
    list = Array.isArray(body) ? body : body && body.data;
  } catch (err) {
    console.error('GET services failed, trying POST:', err.message);
    try {
      response = await providerRequest(provider, { action: 'services' }, 'POST');
      body = response.data;
      list = Array.isArray(body) ? body : body && body.data;
      usedMethod = 'POST';
    } catch (postErr) {
      console.error('POST services also failed:', postErr.message);
      throw new Error(`Failed to fetch services from provider. GET error: ${err.message}. POST error: ${postErr.message}. Check API URL and key.`);
    }
  }

  if (!Array.isArray(list)) {
    const responsePreview = typeof body === 'string' ? body.substring(0, 500) : JSON.stringify(body).substring(0, 500);
    throw new Error(`Provider did not return a service list. Expected array, got: ${responsePreview}. Check API URL: ${provider.api_url}`);
  }

  const markup = 1 + (Number(provider.markup_percent) || 0) / 100;
  let added = 0;
  let updated = 0;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
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

      const existing = await client.query('SELECT id FROM services WHERE provider_id = $1 AND upstream_service_id = $2', [provider.id, upstreamId]);
      if (existing.rows.length) {
        await client.query(
          `UPDATE services SET category = $1, name = $2, rate_per_1000 = $3, min_quantity = $4, max_quantity = $5, description = $6, cost_per_1000 = $7, status = $8 WHERE id = $9`,
          [category, name, retailRate, min, max, description, wholesaleRate, status, existing.rows[0].id]
        );
        updated++;
      } else {
        // Also check for duplicates by normalized name + category across all providers
        const duplicate = await client.query(
          `SELECT id FROM services WHERE LOWER(TRIM(name)) = LOWER(TRIM($1)) AND LOWER(TRIM(category)) = LOWER(TRIM($2)) AND provider_id IS NOT NULL LIMIT 1`,
          [name, category]
        );
        if (duplicate.rows.length) {
          // Update existing duplicate instead of inserting
          await client.query(
            `UPDATE services SET rate_per_1000 = $1, min_quantity = $2, max_quantity = $3, description = $4, provider_id = $5, upstream_service_id = $6, cost_per_1000 = $7, status = $8 WHERE id = $9`,
            [retailRate, min, max, description, provider.id, upstreamId, wholesaleRate, status, duplicate.rows[0].id]
          );
          updated++;
        } else {
          await client.query(
            `INSERT INTO services (category, name, rate_per_1000, min_quantity, max_quantity, description, provider_id, upstream_service_id, cost_per_1000, status) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
            [category, name, retailRate, min, max, description, provider.id, upstreamId, wholesaleRate, status]
          );
          added++;
        }
      }
    }
    await client.query("UPDATE upstream_providers SET last_sync_at = CURRENT_TIMESTAMP WHERE id = $1", [provider.id]);

    // Auto-assign images to newly imported services by category
    const categories = [...new Set(list.map(item => item.category || 'Imported'))];
    for (const category of categories) {
      const ref = await client.query('SELECT image FROM services WHERE category = $1 AND image IS NOT NULL LIMIT 1', [category]);
      if (ref.rows.length) {
        await client.query('UPDATE services SET image = $1 WHERE category = $2 AND image IS NULL AND provider_id = $3', [ref.rows[0].image, category, provider.id]);
      }
    }

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }

  return { added, updated, total: list.length };
}

// Remove duplicate services keeping the newest entry
app.post('/api/admin/services/deduplicate', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const result = await pool.query(`
      DELETE FROM services
      WHERE id NOT IN (
        SELECT MAX(id)
        FROM services
        GROUP BY LOWER(TRIM(name)), LOWER(TRIM(category))
        HAVING COUNT(*) > 1
      )
      AND provider_id IS NULL
    `);
    res.json({ deleted: result.rowCount, message: `Removed ${result.rowCount} duplicate in-house services.` });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/admin/services/deduplicate-all', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const result = await pool.query(`
      DELETE FROM services
      WHERE id NOT IN (
        SELECT MAX(id)
        FROM services
        GROUP BY LOWER(TRIM(name)), LOWER(TRIM(category))
        HAVING COUNT(*) > 1
      )
    `);
    res.json({ deleted: result.rowCount, message: `Removed ${result.rowCount} duplicate services.` });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Pushes a locally created order to the upstream panel that supplies its service
async function forwardOrderToProvider(orderId) {
  const order = await pool.query('SELECT * FROM orders WHERE id = $1', [orderId]);
  if (!order.rows.length) return { error: 'Order not found.' };

  const service = await pool.query('SELECT * FROM services WHERE id = $1', [order.rows[0].service_id]);
  if (!service.rows.length || !service.rows[0].provider_id || !service.rows[0].upstream_service_id) {
    return { error: 'This service is not linked to an upstream provider.' };
  }

  const provider = await pool.query("SELECT * FROM upstream_providers WHERE id = $1 AND status = 'active'", [service.rows[0].provider_id]);
  if (!provider.rows.length) return { error: 'Upstream provider is missing or disabled.' };

  try {
    const response = await providerRequest(provider.rows[0], {
      action: 'add',
      service: service.rows[0].upstream_service_id,
      link: order.rows[0].link,
      quantity: order.rows[0].quantity
    }, 'POST');

    const body = response.data || {};
    const payload = body.order ? body : body.data;
    const upstreamOrderId = payload ? (payload.order ?? payload) : null;

    if (!upstreamOrderId) {
      return { error: `Upstream rejected the order: ${JSON.stringify(body)}` };
    }

    await pool.query('UPDATE orders SET upstream_order_id = $1 WHERE id = $2', [String(upstreamOrderId), orderId]);
    return { upstream_order_id: String(upstreamOrderId) };
  } catch (err) {
    const detail = err.response ? JSON.stringify(err.response.data) : err.message;
    return { error: `Upstream order failed: ${detail}` };
  }
}

// Pulls the delivery status of forwarded orders back from the upstream panel
async function refreshUpstreamOrderStatus() {
  const pending = await pool.query(`
    SELECT o.id, o.service_id, o.upstream_order_id FROM orders o
    JOIN services s ON s.id = o.service_id
    WHERE o.upstream_order_id IS NOT NULL
      AND o.upstream_order_id != ''
      AND o.status IN ('Pending', 'In progress', 'Partial')
      AND s.provider_id IS NOT NULL
  `);

  let checked = 0;

  for (const order of pending.rows) {
    const service = await pool.query('SELECT provider_id FROM services WHERE id = $1', [order.service_id]);
    const provider = await pool.query("SELECT * FROM upstream_providers WHERE id = $1 AND status = 'active'", [service.rows[0].provider_id]);
    if (!provider.rows.length) continue;

    try {
      const response = await providerRequest(provider.rows[0], { action: 'status', id: order.upstream_order_id });
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

      await pool.query('UPDATE orders SET status = $1 WHERE id = $2', [mapped, order.id]);
      checked++;
    } catch (err) {
      console.error(`Upstream status check failed for order ${order.id}:`, err.message);
    }
  }

  return checked;
}

app.post('/api/admin/providers/sync-all', authenticateToken, requireAdmin, async (req, res) => {
  const providers = await pool.query("SELECT * FROM upstream_providers WHERE status = 'active'").rows;
  const results = [];

  for (const provider of providers) {
    try {
      const summary = await syncProviderServices(provider);
      results.push({ provider: provider.name, ok: true, ...summary });
    } catch (err) {
      results.push({ provider: provider.name, ok: false, error: err.message });
    }
  }

  res.json({ success: true, results });
});

app.get('/api/admin/providers', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const providers = await pool.query('SELECT * FROM upstream_providers ORDER BY id DESC');
    const providersRows = providers.rows || [];

    const counts = await pool.query(`
      SELECT provider_id, COUNT(*) AS service_count FROM services
      WHERE provider_id IS NOT NULL GROUP BY provider_id
    `);
    const countsRows = counts.rows || [];

    const cacheCounts = await pool.query(`
      SELECT provider_id, COUNT(*) AS cached_count FROM provider_services
      GROUP BY provider_id
    `);
    const cacheCountsRows = cacheCounts.rows || [];

    const map = new Map(countsRows.map((c) => [c.provider_id, c.service_count]));
    const cacheMap = new Map(cacheCountsRows.map((c) => [c.provider_id, c.cached_count]));

    res.json(providersRows.map((p) => ({
      id: p.id,
      name: p.name,
      api_url: p.api_url,
      api_key: p.api_key,
      markup_percent: p.markup_percent,
      status: p.status,
      last_sync_at: p.last_sync_at,
      created_at: p.created_at,
      service_count: map.get(p.id) || 0,
      cached_count: cacheMap.get(p.id) || 0
    })));
  } catch (err) {
    console.error('Error in /api/admin/providers:', err);
    res.status(500).json({ error: 'Failed to fetch providers: ' + err.message });
  }
});

app.post('/api/admin/providers', authenticateToken, requireAdmin, async (req, res) => {
  const { name, api_url, api_key, markup_percent = 0 } = req.body;
  if (!name || !api_url || !api_key) {
    return res.status(400).json({ error: 'Name, API URL and API key are all required.' });
  }

  const info = await pool.query(
    `INSERT INTO upstream_providers (name, api_url, api_key, markup_percent) VALUES ($1, $2, $3, $4) RETURNING id`,
    [name, api_url.trim(), api_key.trim(), Number(markup_percent) || 0]
  );

  res.json({ success: true, id: info.rows[0].id });
});

app.put('/api/admin/providers/:id', authenticateToken, requireAdmin, async (req, res) => {
  const { name, api_url, api_key, markup_percent = 0, status = 'active' } = req.body;
  const provider = await pool.query('SELECT * FROM upstream_providers WHERE id = $1', [req.params.id]);
  if (!provider.rows.length) return res.status(404).json({ error: 'Provider not found.' });

  await pool.query(
    `UPDATE upstream_providers SET name = $1, api_url = $2, api_key = $3, markup_percent = $4, status = $5 WHERE id = $6`,
    [name || provider.rows[0].name, (api_url || provider.rows[0].api_url).trim(), api_key || provider.rows[0].api_key, Number(markup_percent) || 0, status, provider.rows[0].id]
  );

  res.json({ success: true, message: 'Provider updated.' });
});

app.post('/api/admin/providers/:id/sync', authenticateToken, requireAdmin, async (req, res) => {
  const provider = await pool.query('SELECT * FROM upstream_providers WHERE id = $1', [req.params.id]);
  if (!provider.rows.length) return res.status(404).json({ error: 'Provider not found.' });

  try {
    const summary = await syncProviderServices(provider.rows[0]);
    res.json({ success: true, ...summary });
  } catch (err) {
    const detail = err.response ? (err.response.data?.message || JSON.stringify(err.response.data)) : err.message;
    res.status(502).json({ success: false, error: detail, raw: err.response?.data || null });
  }
});

app.post('/api/admin/providers/:id/preview', authenticateToken, requireAdmin, async (req, res) => {
  const provider = await pool.query('SELECT * FROM upstream_providers WHERE id = $1', [req.params.id]);
  if (!provider.rows.length) return res.status(404).json({ error: 'Provider not found.' });

  try {
    // Fetch directly from the provider API
    const response = await providerRequest(provider.rows[0], { action: 'services' });
    const body = response.data;
    const list = Array.isArray(body) ? body : body && body.data;

    if (!Array.isArray(list)) {
      // Fall back to cached services if API fails
      const cached = await pool.query('SELECT * FROM provider_services WHERE provider_id = $1 ORDER BY category, name', [provider.rows[0].id]);
      if (cached.rows.length > 0) {
        const normalized = cached.rows.map(row => ({
          upstreamId: row.upstream_service_id,
          name: row.name,
          rate: row.rate,
          min: row.min_quantity,
          max: row.max_quantity,
          category: row.category,
          description: row.description || ''
        }));
        return res.json({
          success: true,
          services: normalized,
          cached: true,
          markupPercent: Number(provider.rows[0].markup_percent) || 0
        });
      }
      return res.status(400).json({ error: 'Provider did not return a service list. Check the API URL and key.' });
    }

    const normalized = list.map(item => ({
      upstreamId: String(item.service ?? item.id ?? ''),
      name: item.name || `Service ${item.service ?? item.id}`,
      rate: item.rate,
      min: item.min,
      max: item.max,
      category: item.category || 'Imported',
      description: item.description || ''
    })).filter(item => item.upstreamId);

    res.json({
      success: true,
      services: normalized,
      cached: false,
      markupPercent: Number(provider.rows[0].markup_percent) || 0
    });
  } catch (err) {
    // Fall back to cached services on error
    try {
      const cached = await pool.query('SELECT * FROM provider_services WHERE provider_id = $1 ORDER BY category, name', [provider.rows[0].id]);
      if (cached.rows.length > 0) {
        const normalized = cached.rows.map(row => ({
          upstreamId: row.upstream_service_id,
          name: row.name,
          rate: row.rate,
          min: row.min_quantity,
          max: row.max_quantity,
          category: row.category,
          description: row.description || ''
        }));
        return res.json({
          success: true,
          services: normalized,
          cached: true,
          markupPercent: Number(provider.rows[0].markup_percent) || 0
        });
      }
    } catch (cacheErr) {
      console.error('Cache fallback failed:', cacheErr.message);
    }

    const detail = err.response ? (err.response.data?.error || err.response.data?.message || JSON.stringify(err.response.data)) : err.message;
    res.status(502).json({ success: false, error: 'Provider API error: ' + detail + ' (check your API key)' });
  }
});

app.post('/api/admin/providers/:id/refresh-cache', authenticateToken, requireAdmin, async (req, res) => {
  const provider = await pool.query('SELECT * FROM upstream_providers WHERE id = $1', [req.params.id]);
  if (!provider.rows.length) return res.status(404).json({ error: 'Provider not found.' });

  try {
    const response = await providerRequest(provider.rows[0], { action: 'services' });
    const body = response.data;
    const list = Array.isArray(body) ? body : body && body.data;

    if (!Array.isArray(list)) {
      return res.status(400).json({ error: 'Provider did not return a service list.' });
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('DELETE FROM provider_services WHERE provider_id = $1', [provider.rows[0].id]);

      for (const item of list) {
        const upstreamId = String(item.service ?? item.id ?? '');
        if (!upstreamId) continue;

        const name = item.name || `Service ${upstreamId}`;
        const rate = parseFloat(item.rate);
        if (!Number.isFinite(rate)) continue;

        const min = parseInt(item.min) || 1;
        const max = parseInt(item.max) || 1000000;
        const category = item.category || 'Imported';
        const description = item.description || '';
        const status = String(item.status || 'active').toLowerCase() === 'inactive' ? 'inactive' : 'active';

        await client.query(
          `INSERT INTO provider_services (provider_id, upstream_service_id, name, category, rate, min_quantity, max_quantity, description, status) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
          [provider.rows[0].id, upstreamId, name, category, rate, min, max, description, status]
        );
      }

      await client.query('UPDATE upstream_providers SET last_sync_at = CURRENT_TIMESTAMP WHERE id = $1', [provider.rows[0].id]);
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }

    res.json({ success: true, message: `Cached ${list.length} services from provider.` });
  } catch (err) {
    res.status(502).json({ success: false, error: err.message });
  }
});

app.get('/api/admin/providers/:id/cached-services', authenticateToken, requireAdmin, async (req, res) => {
  const provider = await pool.query('SELECT * FROM upstream_providers WHERE id = $1', [req.params.id]);
  if (!provider.rows.length) return res.status(404).json({ error: 'Provider not found.' });

  try {
    const services = await pool.query(
      'SELECT * FROM provider_services WHERE provider_id = $1 ORDER BY category, name',
      [provider.rows[0].id]
    );

    res.json({ success: true, services: services.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/admin/providers/:id/import-selected', authenticateToken, requireAdmin, async (req, res) => {
  const provider = await pool.query('SELECT * FROM upstream_providers WHERE id = $1', [req.params.id]);
  if (!provider.rows.length) return res.status(404).json({ error: 'Provider not found.' });

  const { selectedIds, services } = req.body;

  try {
    // The preview popup fetches services straight from the provider API,
    // so selected services arrive with full data and can be imported
    // without a cache refresh. When only IDs are sent, fall back to the
    // cached provider_services table.
    let rows;
    if (Array.isArray(services) && services.length) {
      rows = services.map(s => ({
        upstream_service_id: String(s.upstreamId ?? s.upstream_service_id ?? s.service ?? s.id ?? ''),
        name: s.name,
        category: s.category,
        rate: s.rate,
        min_quantity: s.min ?? s.min_quantity,
        max_quantity: s.max ?? s.max_quantity,
        description: s.description,
        status: 'active'
      })).filter(r => r.upstream_service_id);
    } else {
      if (!Array.isArray(selectedIds) || !selectedIds.length) {
        return res.status(400).json({ error: 'No services selected.' });
      }
      const cachedServices = await pool.query(
        'SELECT * FROM provider_services WHERE provider_id = $1 AND upstream_service_id = ANY($2::text[])',
        [provider.rows[0].id, selectedIds]
      );
      if (!cachedServices.rows.length) {
        return res.status(400).json({ error: 'No cached services found. Please refresh cache first.' });
      }
      rows = cachedServices.rows;
    }

    const markup = 1 + (Number(provider.rows[0].markup_percent) || 0) / 100;
    let added = 0;
    let updated = 0;

    for (const row of rows) {
      const upstreamId = String(row.upstream_service_id);
      const name = row.name || `Service ${upstreamId}`;
      const wholesaleRate = parseFloat(row.rate);
      if (!Number.isFinite(wholesaleRate)) continue;

      const retailRate = parseFloat((wholesaleRate * markup).toFixed(4));
      const min = parseInt(row.min_quantity) || 1;
      const max = parseInt(row.max_quantity) || 1000000;
      const category = row.category || 'Imported';
      const description = row.description || `Supplied by ${provider.rows[0].name}`;
      const status = row.status || 'active';

      const existing = await pool.query('SELECT id FROM services WHERE provider_id = $1 AND upstream_service_id = $2', [provider.rows[0].id, upstreamId]);
      if (existing.rows.length) {
        await pool.query(
          `UPDATE services SET category = $1, name = $2, rate_per_1000 = $3, min_quantity = $4, max_quantity = $5, description = $6, cost_per_1000 = $7, status = $8 WHERE id = $9`,
          [category, name, retailRate, min, max, description, wholesaleRate, status, existing.rows[0].id]
        );
        updated++;
      } else {
        // Also check for duplicates by normalized name + category across all providers
        const duplicate = await pool.query(
          `SELECT id FROM services WHERE LOWER(TRIM(name)) = LOWER(TRIM($1)) AND LOWER(TRIM(category)) = LOWER(TRIM($2)) AND provider_id IS NOT NULL LIMIT 1`,
          [name, category]
        );
        if (duplicate.rows.length) {
          await pool.query(
            `UPDATE services SET rate_per_1000 = $1, min_quantity = $2, max_quantity = $3, description = $4, provider_id = $5, upstream_service_id = $6, cost_per_1000 = $7, status = $8 WHERE id = $9`,
            [retailRate, min, max, description, provider.rows[0].id, upstreamId, wholesaleRate, status, duplicate.rows[0].id]
          );
          updated++;
        } else {
          await pool.query(
            `INSERT INTO services (category, name, rate_per_1000, min_quantity, max_quantity, description, provider_id, upstream_service_id, cost_per_1000, status) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
            [category, name, retailRate, min, max, description, provider.rows[0].id, upstreamId, wholesaleRate, status]
          );
          added++;
        }
      }
    }

    await pool.query("UPDATE upstream_providers SET last_sync_at = CURRENT_TIMESTAMP WHERE id = $1", [provider.rows[0].id]);

    res.json({ success: true, added, updated, total: rows.length });
  } catch (err) {
    res.status(502).json({ success: false, error: err.message });
  }
});

app.post('/api/admin/providers/:id/test', authenticateToken, requireAdmin, async (req, res) => {
  const provider = await pool.query('SELECT * FROM upstream_providers WHERE id = $1', [req.params.id]);
  if (!provider.rows.length) return res.status(404).json({ error: 'Provider not found.' });

  try {
    const response = await providerRequest(provider.rows[0], { action: 'services' });
    const body = response.data;
    const list = Array.isArray(body) ? body : body && body.data;

    res.json({
      success: true,
      status: response.status,
      method: 'GET',
      count: list?.length || 0,
      sample: list?.slice(0, 3) || null,
      raw: typeof body === 'string' ? body.substring(0, 1000) : JSON.stringify(body).substring(0, 1000)
    });
  } catch (err) {
    try {
      const response = await providerRequest(provider.rows[0], { action: 'services' }, 'POST');
      const body = response.data;
      const list = Array.isArray(body) ? body : body && body.data;

      res.json({
        success: true,
        status: response.status,
        method: 'POST',
        count: list?.length || 0,
        sample: list?.slice(0, 3) || null,
        raw: typeof body === 'string' ? body.substring(0, 1000) : JSON.stringify(body).substring(0, 1000)
      });
    } catch (postErr) {
      res.status(502).json({
        success: false,
        error: postErr.message,
        getError: err.message,
        raw: postErr.response?.data || null
      });
    }
  }
});

app.delete('/api/admin/providers/:id', authenticateToken, requireAdmin, async (req, res) => {
  const provider = await pool.query('SELECT * FROM upstream_providers WHERE id = $1', [req.params.id]);
  if (!provider.rows.length) return res.status(404).json({ error: 'Provider not found.' });

  const orphaned = (await pool.query('SELECT COUNT(*) AS n FROM services WHERE provider_id = $1', [provider.rows[0].id])).rows[0].n;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('UPDATE services SET status = $1 WHERE provider_id = $2', ['inactive', provider.rows[0].id]);
    await client.query('DELETE FROM upstream_providers WHERE id = $1', [provider.rows[0].id]);
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }

  res.json({ success: true, message: `Provider removed. ${orphaned} imported service(s) were deactivated.` });
});

app.post('/api/admin/orders/:id/forward', authenticateToken, requireAdmin, async (req, res) => {
  const order = await pool.query('SELECT * FROM orders WHERE id = $1', [req.params.id]);
  if (!order.rows.length) return res.status(404).json({ error: 'Order not found.' });
  if (order.rows[0].upstream_order_id) return res.status(400).json({ error: 'Order was already forwarded upstream.' });

  const result = await forwardOrderToProvider(order.rows[0].id);
  if (result.error) return res.status(502).json({ success: false, error: result.error });

  res.json({ success: true, upstream_order_id: result.upstream_order_id });
});

app.get('/api/admin/orders', authenticateToken, requireAdmin, async (req, res) => {
  const { status, search, page = 1, limit = 50 } = req.query;
  const offset = (parseInt(page) - 1) * parseInt(limit);

  let where = 'WHERE 1=1';
  const params = [];

  if (status && status !== 'all') {
    where += ` AND o.status = $${params.length + 1}`;
    params.push(status);
  }

  if (search) {
    where += ` AND (o.service_name ILIKE $${params.length + 1} OR u.email ILIKE $${params.length + 1} OR o.link ILIKE $${params.length + 1})`;
    params.push(`%${search}%`);
  }

  const countRes = await pool.query(`SELECT COUNT(*) AS total FROM orders o JOIN users u ON o.user_id = u.id ${where}`, params);
  const total = parseInt(countRes.rows[0].total);

  const ordersRes = await pool.query(
    `SELECT o.*, u.email AS user_email, u.name AS user_name FROM orders o JOIN users u ON o.user_id = u.id ${where} ORDER BY o.id DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
    [...params, parseInt(limit), offset]
  );

  res.json({ orders: ordersRes.rows, total, page: parseInt(page), totalPages: Math.ceil(total / parseInt(limit)) });
});

app.put('/api/admin/orders/:id/status', authenticateToken, requireAdmin, async (req, res) => {
  const { status } = req.body;
  if (!status) return res.status(400).json({ error: 'Status is required.' });

  const allowedStatuses = ['Awaiting', 'Pending', 'Processing', 'In Progress', 'Inprogress', 'Completed', 'Cancelled', 'Failed', 'Canceled', 'Refunded'];
  const statusSet = [...new Set(allowedStatuses)];
  if (!statusSet.includes(status)) return res.status(400).json({ error: 'Invalid status.' });

  const result = await pool.query('UPDATE orders SET status = $1 WHERE id = $2 RETURNING *', [status, req.params.id]);
  if (!result.rows.length) return res.status(404).json({ error: 'Order not found.' });

  res.json({ order: result.rows[0] });
});

// ==================== ADMIN DASHBOARD ====================
app.get('/api/admin/dashboard', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const userCount = await pool.query("SELECT COUNT(*) AS n FROM users WHERE role = 'user'");
    const activeServices = await pool.query("SELECT COUNT(*) AS n FROM services WHERE status = 'active'");
    const totalOrders = await pool.query('SELECT COUNT(*) AS n FROM orders');
    const todayOrders = await pool.query("SELECT COUNT(*) AS n FROM orders WHERE created_at >= CURRENT_DATE");
    const revenueTotal = await pool.query("SELECT COALESCE(SUM(charge),0) AS n FROM orders WHERE status = 'Completed'");
    const revenueToday = await pool.query("SELECT COALESCE(SUM(charge),0) AS n FROM orders WHERE created_at >= CURRENT_DATE AND status = 'Completed'");
    const pendingOrders = await pool.query("SELECT COUNT(*) AS n FROM orders WHERE status IN ('Awaiting','Pending','Processing','In Progress')");
    const recentOrders = await pool.query(
      `SELECT o.id, o.service_name, o.charge, o.currency, o.status, o.created_at, u.name AS user_name, u.email AS user_email
       FROM orders o JOIN users u ON o.user_id = u.id ORDER BY o.id DESC LIMIT 8`
    );
    res.json({
      users: parseInt(userCount.rows[0].n),
      active_services: parseInt(activeServices.rows[0].n),
      orders_total: parseInt(totalOrders.rows[0].n),
      orders_today: parseInt(todayOrders.rows[0].n),
      revenue_total: parseFloat(revenueTotal.rows[0].n),
      revenue_today: parseFloat(revenueToday.rows[0].n),
      pending_orders: parseInt(pendingOrders.rows[0].n),
      recent_orders: recentOrders.rows
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ==================== ADMIN USERS ====================
app.get('/api/admin/users', authenticateToken, requireAdmin, async (req, res) => {
  const { q, page = 1, limit = 50 } = req.query;
  const offset = (parseInt(page) - 1) * parseInt(limit);
  const params = [];
  let where = 'WHERE role = \'user\'';
  if (q) {
    where += ` AND (name ILIKE $${params.length + 1} OR email ILIKE $${params.length + 1})`;
    params.push(`%${q}%`);
  }
  const countRes = await pool.query(`SELECT COUNT(*) AS total FROM users ${where}`, params);
  const total = parseInt(countRes.rows[0].total);
  const usersRes = await pool.query(
    `SELECT id, name, email, role, wallet_inr, wallet_usd, wallet_eur, currency, status, referral_code, referred_by, created_at
     FROM users ${where} ORDER BY id DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
    [...params, parseInt(limit), offset]
  );
  res.json({ users: usersRes.rows, total, page: parseInt(page), totalPages: Math.ceil(total / parseInt(limit)) });
});

app.post('/api/admin/users', authenticateToken, requireAdmin, async (req, res) => {
  const { name, email, password, role = 'user' } = req.body;
  if (!name || !email || !password) return res.status(400).json({ error: 'Name, email and password are required.' });
  const existing = await pool.query('SELECT id FROM users WHERE email = $1', [email]);
  if (existing.rows.length) return res.status(400).json({ error: 'Email already registered.' });
  const hash = bcrypt.hashSync(password, 10);
  const refCode = 'JR' + Math.random().toString(36).substring(2, 7).toUpperCase();
  const info = await pool.query(
    `INSERT INTO users (name, email, password, role, referral_code, status) VALUES ($1, $2, $3, $4, $5, 'active') RETURNING id`,
    [name, email, hash, role, refCode]
  );
  res.status(201).json({ id: info.rows[0].id, name, email, role, referral_code: refCode });
});

app.put('/api/admin/users/:id', authenticateToken, requireAdmin, async (req, res) => {
  const { name, email, role } = req.body;
  const updates = [];
  const values = [];
  let i = 1;
  if (name !== undefined) { updates.push(`name = $${i++}`); values.push(name); }
  if (email !== undefined) { updates.push(`email = $${i++}`); values.push(email); }
  if (role !== undefined) { updates.push(`role = $${i++}`); values.push(role); }
  if (!updates.length) return res.status(400).json({ error: 'No updatable fields provided.' });
  values.push(req.params.id);
  const result = await pool.query(`UPDATE users SET ${updates.join(', ')} WHERE id = $${i} RETURNING id, name, email, role`, values);
  if (!result.rows.length) return res.status(404).json({ error: 'User not found.' });
  res.json({ user: result.rows[0] });
});

app.post('/api/admin/users/:id/funds', authenticateToken, requireAdmin, async (req, res) => {
  const amount = Number(req.body.amount);
  const currency = req.body.currency || 'INR';
  if (!Number.isFinite(amount) || amount <= 0 || Math.abs(amount * 100 - Math.round(amount * 100)) > 0.000001) {
    return res.status(400).json({ error: 'Enter an amount greater than zero with no more than two decimal places.' });
  }

  const walletFields = { INR: 'wallet_inr', USD: 'wallet_usd', EUR: 'wallet_eur' };
  const walletField = walletFields[currency];
  if (!walletField) return res.status(400).json({ error: 'Currency must be INR, USD, or EUR.' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await client.query(
      `UPDATE users SET ${walletField} = ${walletField} + $1 WHERE id = $2 RETURNING id`,
      [amount, req.params.id]
    );
    if (!result.rows.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'User not found.' });
    }
    await client.query(
      `INSERT INTO transactions (user_id, amount, currency, payment_method, status)
       VALUES ($1, $2, $3, 'Admin wallet credit', 'Completed')`,
      [req.params.id, amount, currency]
    );
    await client.query('COMMIT');
    res.json({ success: true, message: `Added ${amount.toFixed(2)} ${currency} to the user's wallet.` });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Admin wallet credit error:', err);
    res.status(500).json({ error: 'Could not add funds to the user wallet.' });
  } finally {
    client.release();
  }
});

app.put('/api/admin/users/:id/password', authenticateToken, requireAdmin, async (req, res) => {
  const { password } = req.body;
  if (!password || password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters.' });
  const hash = bcrypt.hashSync(password, 10);
  const result = await pool.query('UPDATE users SET password = $1 WHERE id = $2 RETURNING id', [hash, req.params.id]);
  if (!result.rows.length) return res.status(404).json({ error: 'User not found.' });
  res.json({ success: true });
});

app.post('/api/admin/users/:id/impersonate', authenticateToken, requireAdmin, async (req, res) => {
  const target = await pool.query('SELECT id, email, name, role, status FROM users WHERE id = $1', [req.params.id]);
  if (!target.rows.length) return res.status(404).json({ error: 'User not found.' });
  const user = target.rows[0];
  if (user.role !== 'user') return res.status(403).json({ error: 'Only customer accounts can be impersonated.' });
  if (user.status === 'suspended') {
    return res.status(403).json({ error: 'Suspended accounts cannot be accessed.' });
  }
  const token = jwt.sign({ id: user.id, email: user.email, role: user.role }, JWT_SECRET, { expiresIn: '8h' });
  // Audit log (best-effort)
  try {
    await pool.query('INSERT INTO user_logins (user_id, ip, user_agent, created_at) VALUES ($1, $2, $3, CURRENT_TIMESTAMP)',
      [user.id, req.ip || 'admin-impersonate', req.get('User-Agent') || 'admin']);
  } catch (e) { /* log-only */ }
  res.json({ token, user: { id: user.id, name: user.name, email: user.email, role: user.role } });
});

app.get('/api/admin/users/:id/logins', authenticateToken, requireAdmin, async (req, res) => {
  const rows = await pool.query('SELECT ip, user_agent, created_at FROM user_logins WHERE user_id = $1 ORDER BY created_at DESC LIMIT 100', [req.params.id]);
  res.json({ logins: rows.rows });
});

app.patch('/api/admin/users/:id/suspend', authenticateToken, requireAdmin, async (req, res) => {
  const { suspended } = req.body;
  const status = suspended ? 'suspended' : 'active';
  const result = await pool.query('UPDATE users SET status = $1 WHERE id = $2 RETURNING id, status', [status, req.params.id]);
  if (!result.rows.length) return res.status(404).json({ error: 'User not found.' });
  res.json({ user: result.rows[0] });
});

// ==================== SERVICES: duplicate + categories ====================
app.post('/api/admin/services/:id/duplicate', authenticateToken, requireAdmin, async (req, res) => {
  const original = await pool.query('SELECT category, name, rate_per_1000, min_quantity, max_quantity, description, image, status FROM services WHERE id = $1', [req.params.id]);
  if (!original.rows.length) return res.status(404).json({ error: 'Service not found.' });
  const s = original.rows[0];
  const dup = await pool.query(
    `INSERT INTO services (category, name, rate_per_1000, min_quantity, max_quantity, description, image, status)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
    [s.category, `${s.name} (copy)`, s.rate_per_1000, s.min_quantity, s.max_quantity, s.description, s.image, s.status]
  );
  res.status(201).json({ service: dup.rows[0] });
});

app.get('/api/admin/categories', authenticateToken, requireAdmin, async (req, res) => {
  await pool.query(
    `INSERT INTO categories (name)
     SELECT DISTINCT category_name
     FROM (
       SELECT TRIM(category) AS category_name FROM services
       UNION
       SELECT TRIM(category) AS category_name FROM provider_services
     ) category_names
     WHERE category_name IS NOT NULL AND category_name <> ''
     ON CONFLICT (name) DO NOTHING`
  );
  const rows = await pool.query('SELECT id, name FROM categories ORDER BY name');
  res.json({ categories: rows.rows });
});

app.post('/api/admin/categories', authenticateToken, requireAdmin, async (req, res) => {
  const name = typeof req.body.name === 'string' ? req.body.name.trim() : '';
  if (!name || name.length > 80) return res.status(400).json({ error: 'Category name is required and must be 80 characters or fewer.' });
  try {
    const result = await pool.query('INSERT INTO categories (name) VALUES ($1) RETURNING id, name', [name]);
    res.status(201).json({ category: result.rows[0] });
  } catch (error) {
    if (error.code === '23505') return res.status(409).json({ error: 'Category already exists.' });
    console.error('Admin category creation failed:', error);
    res.status(500).json({ error: 'Could not create category.' });
  }
});

app.put('/api/admin/categories/:id', authenticateToken, requireAdmin, async (req, res) => {
  const name = typeof req.body.name === 'string' ? req.body.name.trim() : '';
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id < 1) return res.status(400).json({ error: 'Invalid category id.' });
  if (!name || name.length > 80) return res.status(400).json({ error: 'Category name is required and must be 80 characters or fewer.' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const current = await client.query('SELECT id, name FROM categories WHERE id = $1 FOR UPDATE', [id]);
    if (!current.rows.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Category not found.' });
    }
    const duplicate = await client.query(
      'SELECT id FROM categories WHERE LOWER(name) = LOWER($1) AND id <> $2',
      [name, id]
    );
    if (duplicate.rows.length) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'A category with this name already exists.' });
    }

    const oldName = current.rows[0].name;
    await client.query('UPDATE services SET category = $1 WHERE LOWER(TRIM(category)) = LOWER(TRIM($2))', [name, oldName]);
    await client.query('UPDATE provider_services SET category = $1 WHERE LOWER(TRIM(category)) = LOWER(TRIM($2))', [name, oldName]);
    const updated = await client.query('UPDATE categories SET name = $1 WHERE id = $2 RETURNING id, name', [name, id]);
    await client.query('COMMIT');
    res.json({ category: updated.rows[0] });
  } catch (error) {
    await client.query('ROLLBACK');
    if (error.code === '23505') return res.status(409).json({ error: 'A category with this name already exists.' });
    console.error('Admin category rename failed:', error);
    res.status(500).json({ error: 'Could not rename category.' });
  } finally {
    client.release();
  }
});

app.delete('/api/admin/categories/:id', authenticateToken, requireAdmin, async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id < 1) return res.status(400).json({ error: 'Invalid category id.' });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const current = await client.query('SELECT id, name FROM categories WHERE id = $1 FOR UPDATE', [id]);
    if (!current.rows.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Category not found.' });
    }
    const name = current.rows[0].name;
    const usage = await client.query(
      `SELECT EXISTS (SELECT 1 FROM services WHERE LOWER(TRIM(category)) = LOWER(TRIM($1)))
       OR EXISTS (SELECT 1 FROM provider_services WHERE LOWER(TRIM(category)) = LOWER(TRIM($1))) AS in_use`,
      [name]
    );
    if (usage.rows[0].in_use) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'This category is used by services. Rename it or move those services before deleting it.' });
    }
    await client.query('DELETE FROM categories WHERE id = $1', [id]);
    await client.query('COMMIT');
    res.json({ success: true });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Admin category deletion failed:', error);
    res.status(500).json({ error: 'Could not delete category.' });
  } finally {
    client.release();
  }
});

// ==================== ADMIN PAYMENTS LEDGER ====================
app.get('/api/admin/payments', authenticateToken, requireAdmin, async (req, res) => {
  const { q, status, page = 1, limit = 50 } = req.query;
  const offset = (parseInt(page) - 1) * parseInt(limit);
  const params = [];
  let where = 'WHERE 1=1';
  if (status && status !== 'all') {
    where += ` AND payment_status = $${params.length + 1}`;
    params.push(status);
  }
  if (q) {
    where += ` AND (order_id ILIKE $${params.length + 1} OR user_name ILIKE $${params.length + 1} OR user_email ILIKE $${params.length + 1} OR amount::text ILIKE $${params.length + 1} OR COALESCE(utr, '') ILIKE $${params.length + 1})`;
    params.push(`%${q}%`);
  }
  const ledger = `
    WITH payment_ledger AS (
      SELECT po.order_id, po.amount, po.currency, po.payment_status, po.credited, po.refunded, po.refunded_amount, po.utr,
             po.created_at, po.updated_at, u.id AS user_id, u.name AS user_name, u.email AS user_email,
             COALESCE(po.payment_method, 'Cashfree') AS payment_method, 'payment' AS record_type
      FROM payment_orders po JOIN users u ON po.user_id = u.id
      UNION ALL
      SELECT 'WALLET-' || t.id::text AS order_id, t.amount, t.currency, UPPER(COALESCE(t.status, 'COMPLETED')) AS payment_status,
             1 AS credited, 0 AS refunded, 0 AS refunded_amount, NULL::text AS utr, t.created_at, NULL AS updated_at,
             u.id AS user_id, u.name AS user_name, u.email AS user_email, COALESCE(t.payment_method, 'Wallet transaction') AS payment_method,
             'transaction' AS record_type
      FROM transactions t JOIN users u ON t.user_id = u.id
      WHERE COALESCE(t.payment_method, '') NOT IN ('Cashfree', 'BharatPe QR')
    )
  `;
  const countRes = await pool.query(
    `${ledger} SELECT COUNT(*) AS total FROM payment_ledger ${where}`,
    params
  );
  const total = parseInt(countRes.rows[0].total);
  const rows = await pool.query(
    `${ledger} SELECT order_id, amount, currency, payment_status, credited, refunded, refunded_amount, utr, created_at, updated_at,
            user_id, user_name, user_email, payment_method, record_type
     FROM payment_ledger ${where} ORDER BY created_at DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
    [...params, parseInt(limit), offset]
  );
  res.json({ payments: rows.rows, total, page: parseInt(page), totalPages: Math.ceil(total / parseInt(limit)) });
});

app.post('/api/admin/payments/:orderId/approve-upi', authenticateToken, requireAdmin, async (req, res) => {
  const utr = typeof req.body.utr === 'string' ? req.body.utr.trim().toUpperCase() : '';
  if (!/^[A-Z0-9-]{6,30}$/.test(utr)) {
    return res.status(400).json({ error: 'Enter a valid UTR (6–30 letters, numbers, or hyphens).' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const payment = await client.query(
      `SELECT order_id, user_id, amount, currency, payment_status, credited, payment_method
       FROM payment_orders WHERE order_id = $1 FOR UPDATE`,
      [req.params.orderId]
    );
    if (!payment.rows.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Payment not found.' });
    }

    const record = payment.rows[0];
    if (record.payment_method !== 'BharatPe QR' || record.payment_status !== 'PENDING' || record.credited) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'Only pending BharatPe QR payments can be approved.' });
    }
    if (record.currency !== 'INR' || !Number.isFinite(Number(record.amount)) || Number(record.amount) <= 0) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'This payment has invalid amount or currency details.' });
    }

    const duplicate = await client.query(
      "SELECT order_id FROM payment_orders WHERE LOWER(utr) = LOWER($1) AND order_id <> $2 LIMIT 1",
      [utr, record.order_id]
    );
    if (duplicate.rows.length) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'This UTR has already been used for another payment.' });
    }

    const userUpdate = await client.query(
      'UPDATE users SET wallet_inr = wallet_inr + $1 WHERE id = $2',
      [record.amount, record.user_id]
    );
    if (userUpdate.rowCount !== 1) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Customer account not found.' });
    }
    await client.query(
      `UPDATE payment_orders
       SET utr = $1, payment_status = 'PAID', credited = 1, updated_at = CURRENT_TIMESTAMP
       WHERE order_id = $2`,
      [utr, record.order_id]
    );
    await client.query(
      `INSERT INTO transactions (user_id, amount, currency, payment_method, status)
       VALUES ($1, $2, $3, 'BharatPe QR', 'Completed')`,
      [record.user_id, record.amount, record.currency]
    );
    await client.query('COMMIT');
    res.json({ success: true, message: 'UTR approved and wallet credited.' });
  } catch (error) {
    await client.query('ROLLBACK');
    if (error.code === '23505') return res.status(409).json({ error: 'This UTR has already been used for another payment.' });
    console.error('BharatPe QR payment approval failed:', error);
    res.status(500).json({ error: 'Could not approve this QR payment.' });
  } finally {
    client.release();
  }
});

app.post('/api/admin/payments/:orderId/reject-upi', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const result = await pool.query(
      `UPDATE payment_orders SET payment_status = 'REJECTED', updated_at = CURRENT_TIMESTAMP
       WHERE order_id = $1 AND payment_method = 'BharatPe QR' AND payment_status = 'PENDING' AND credited = 0
       RETURNING order_id`,
      [req.params.orderId]
    );
    if (!result.rows.length) return res.status(409).json({ error: 'Only pending BharatPe QR payments can be rejected.' });
    res.json({ success: true, message: 'QR payment rejected.' });
  } catch (error) {
    console.error('BharatPe QR payment rejection failed:', error);
    res.status(500).json({ error: 'Could not reject this QR payment.' });
  }
});

app.post('/api/admin/payments/:orderId/refund', authenticateToken, requireAdmin, async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const payment = await client.query(
      `SELECT order_id, user_id, amount, currency, payment_status, credited, refunded, refunded_amount
       FROM payment_orders WHERE order_id = $1 FOR UPDATE`,
      [req.params.orderId]
    );
    if (!payment.rows.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Payment not found.' });
    }

    const record = payment.rows[0];
    if (record.payment_status !== 'PAID' || !record.credited) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Only paid and credited deposits can be refunded to the wallet.' });
    }
    const totalAmount = Number(record.amount);
    const refundedAmount = Number(record.refunded_amount || 0);
    const totalCents = Math.round(totalAmount * 100);
    const refundedCents = Math.round(refundedAmount * 100);
    const remainingCents = totalCents - refundedCents;
    const walletField = WALLET_BY_CURRENCY[record.currency] || 'wallet_inr';
    if (!Number.isFinite(totalAmount) || totalCents <= 0 || !Number.isFinite(refundedAmount) || refundedCents < 0) {
      throw new Error(`Invalid refund amount for payment ${record.order_id}`);
    }
    if (record.refunded || remainingCents <= 0) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'This deposit has already been fully refunded to the wallet.' });
    }

    const requestedAmount = !req.body || req.body.amount === undefined ? remainingCents / 100 : Number(req.body.amount);
    const amountCents = Math.round(requestedAmount * 100);
    if (!Number.isFinite(requestedAmount) || amountCents <= 0 || Math.abs(requestedAmount - amountCents / 100) > 0.000001) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Enter a refund amount greater than zero with no more than two decimal places.' });
    }
    if (amountCents > remainingCents) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: `The refund amount cannot exceed the remaining ${(remainingCents / 100).toFixed(2)} ${record.currency}.` });
    }
    const amount = amountCents / 100;
    const newRefundedCents = refundedCents + amountCents;

    const userUpdate = await client.query(
      `UPDATE users SET ${walletField} = ${walletField} + $1 WHERE id = $2`,
      [amount, record.user_id]
    );
    if (userUpdate.rowCount !== 1) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Customer account not found.' });
    }
    await client.query(
      'UPDATE payment_orders SET refunded_amount = $1, refunded = $2, updated_at = CURRENT_TIMESTAMP WHERE order_id = $3',
      [newRefundedCents / 100, newRefundedCents >= totalCents ? 1 : 0, record.order_id]
    );
    await client.query(
      `INSERT INTO transactions (user_id, amount, currency, payment_method, status)
       VALUES ($1, $2, $3, 'Admin wallet refund', 'Completed')`,
      [record.user_id, amount, record.currency]
    );
    await client.query('COMMIT');
    const remainingAfterRefund = Math.max(totalCents - newRefundedCents, 0) / 100;
    res.json({
      success: true,
      message: `Added ${amount.toFixed(2)} ${record.currency} to the customer's wallet.${remainingAfterRefund > 0 ? ` ${remainingAfterRefund.toFixed(2)} ${record.currency} remains refundable.` : ''}`
    });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Admin wallet refund failed:', err);
    res.status(500).json({ error: 'Could not refund this deposit to the customer wallet.' });
  } finally {
    client.release();
  }
});

// User-facing: deposit (top-up) history for the signed-in customer
app.get('/api/wallet/payments', authenticateToken, async (req, res) => {
  const rows = await pool.query(
    `SELECT 'TXN-' || id::text AS order_id, COALESCE(payment_method, 'Wallet transaction') AS description,
            amount, currency, UPPER(COALESCE(status, 'COMPLETED')) AS payment_status,
            TRUE AS credited, NULL::text AS utr, created_at
     FROM transactions WHERE user_id = $1 AND COALESCE(payment_method, '') NOT IN ('Cashfree', 'BharatPe QR')
     UNION ALL
     SELECT order_id, COALESCE(payment_method, 'Cashfree') || ' wallet deposit' AS description,
            amount, currency, payment_status, (credited = 1) AS credited, utr, created_at
     FROM payment_orders WHERE user_id = $1
     ORDER BY created_at DESC LIMIT 50`,
    [req.user.id]
  );
  res.json(rows.rows);
});

app.post('/api/wallet/upi-payment', authenticateToken, async (req, res) => {
  const amount = Number(req.body.amount);
  const utr = typeof req.body.utr === 'string' ? req.body.utr.trim().toUpperCase() : '';
  if (!Number.isFinite(amount) || amount < 10 || amount > 1000000 || Math.abs(amount * 100 - Math.round(amount * 100)) > 0.000001) {
    return res.status(400).json({ error: 'Enter an amount between 10 and 1000000 INR, with no more than two decimal places.' });
  }
  if (!/^[A-Z0-9-]{6,30}$/.test(utr)) {
    return res.status(400).json({ error: 'Enter a valid UTR (6–30 letters, numbers, or hyphens).' });
  }

  const orderId = `UPI_${Date.now()}_${crypto.randomBytes(4).toString('hex').toUpperCase()}`;
  try {
    const result = await pool.query(
      `INSERT INTO payment_orders (order_id, user_id, amount, currency, wallet_field, payment_method, utr, payment_status)
       VALUES ($1, $2, $3, 'INR', 'wallet_inr', 'BharatPe QR', $4, 'PENDING')
       RETURNING order_id, payment_status`,
      [orderId, req.user.id, amount, utr]
    );
    res.status(201).json({
      success: true,
      order_id: result.rows[0].order_id,
      payment_status: result.rows[0].payment_status,
      message: 'Your payment details were submitted. Wallet funds will be added after admin verification.'
    });
  } catch (error) {
    if (error.code === '23505') return res.status(409).json({ error: 'This UTR has already been submitted.' });
    console.error('BharatPe QR payment submission failed:', error);
    res.status(500).json({ error: 'Could not submit this QR payment.' });
  }
});

// ==================== SUPPORT TICKETS (admin + user replies) ====================
app.get('/api/admin/tickets', authenticateToken, requireAdmin, async (req, res) => {
  const { status, q, page = 1, limit = 50 } = req.query;
  const offset = (parseInt(page) - 1) * parseInt(limit);
  const params = [];
  let where = 'WHERE 1=1';
  if (status && status !== 'all') {
    where += ` AND t.status = $${params.length + 1}`;
    params.push(status);
  }
  if (q) {
    where += ` AND (t.subject ILIKE $${params.length + 1} OR t.message ILIKE $${params.length + 1} OR u.email ILIKE $${params.length + 1})`;
    params.push(`%${q}%`);
  }
  const countRes = await pool.query(`SELECT COUNT(*) AS total FROM tickets t JOIN users u ON t.user_id = u.id ${where}`, params);
  const total = parseInt(countRes.rows[0].total);
  const rows = await pool.query(
    `SELECT t.id, t.user_id, t.subject, t.message, t.request_type, t.status, t.order_id, t.created_at,
            u.name AS user_name, u.email AS user_email
     FROM tickets t JOIN users u ON t.user_id = u.id ${where} ORDER BY t.id DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
    [...params, parseInt(limit), offset]
  );
  res.json({ tickets: rows.rows, total, page: parseInt(page), totalPages: Math.ceil(total / parseInt(limit)) });
});

app.get('/api/admin/tickets/:id', authenticateToken, requireAdmin, async (req, res) => {
  const ticket = await pool.query('SELECT t.*, u.name AS user_name, u.email AS user_email FROM tickets t JOIN users u ON t.user_id = u.id WHERE t.id = $1', [req.params.id]);
  if (!ticket.rows.length) return res.status(404).json({ error: 'Ticket not found.' });
  const replies = await pool.query(
    `SELECT tr.id, tr.sender_user_id, tr.is_admin, tr.message, tr.created_at, u.name AS sender_name
     FROM ticket_replies tr JOIN users u ON tr.sender_user_id = u.id WHERE tr.ticket_id = $1 ORDER BY tr.id ASC`,
    [req.params.id]
  );
  ticket.rows[0].replies = replies.rows;
  res.json(ticket.rows[0]);
});

app.post('/api/admin/tickets/:id/reply', authenticateToken, requireAdmin, async (req, res) => {
  const message = req.body && typeof req.body.message === 'string' ? req.body.message.trim() : '';
  const { status } = req.body || {};
  if (!message) return res.status(400).json({ error: 'Reply message is required.' });
  if (message.length > 5000) return res.status(400).json({ error: 'Reply message cannot exceed 5000 characters.' });
  if (status && !['Open', 'In Progress', 'Resolved', 'Closed'].includes(status)) {
    return res.status(400).json({ error: 'Invalid status.' });
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const ticket = await client.query('SELECT id FROM tickets WHERE id = $1 FOR UPDATE', [req.params.id]);
    if (!ticket.rows.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Ticket not found.' });
    }
    await client.query(
      `INSERT INTO ticket_replies (ticket_id, sender_user_id, is_admin, message) VALUES ($1, $2, true, $3)`,
      [req.params.id, req.user.id, message]
    );
    if (status) {
      await client.query('UPDATE tickets SET status = $1 WHERE id = $2', [status, req.params.id]);
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    return res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
  res.json({ success: true });
});

app.post('/api/support/tickets/:id/reply', authenticateToken, async (req, res) => {
  const { message } = req.body;
  if (!message) return res.status(400).json({ error: 'Reply message is required.' });
  const ticket = await pool.query('SELECT * FROM tickets WHERE id = $1 AND user_id = $2', [req.params.id, req.user.id]);
  if (!ticket.rows.length) return res.status(404).json({ error: 'Ticket not found.' });
  await pool.query(
    `INSERT INTO ticket_replies (ticket_id, sender_user_id, is_admin, message) VALUES ($1, $2, false, $3)`,
    [req.params.id, req.user.id, message]
  );
  res.status(201).json({ success: true });
});

app.put('/api/admin/tickets/:id/status', authenticateToken, requireAdmin, async (req, res) => {
  const { status } = req.body;
  const allowed = ['Open', 'In Progress', 'Resolved', 'Closed'];
  if (!allowed.includes(status)) return res.status(400).json({ error: 'Invalid status.' });
  const result = await pool.query('UPDATE tickets SET resolved_at = CASE WHEN $2 IN (\'Resolved\',\'Closed\') THEN CURRENT_TIMESTAMP ELSE resolved_at END, status = $1 WHERE id = $3 RETURNING *', [status, status, req.params.id]);
  if (!result.rows.length) return res.status(404).json({ error: 'Ticket not found.' });
  res.json({ ticket: result.rows[0] });
});

// ==================== APPEARANCE: site themes ====================
// Public: returns the active theme palette so the site can apply it
app.get('/api/settings', async (req, res) => {
  try {
    const setting = await pool.query("SELECT value FROM site_settings WHERE key = 'active_theme'");
    const activeName = setting.rows.length ? setting.rows[0].value : 'Default';
    const theme = await pool.query('SELECT name, label, palette_json, occasion_message, is_active, layout FROM site_themes WHERE name = $1', [activeName]);
    if (!theme.rows.length) {
      return res.json({ active_theme: 'Default', palette: {}, occasion_message: null, layout: 'classic' });
    }
    res.json({
      active_theme: theme.rows[0].name,
      label: theme.rows[0].label,
      palette: theme.rows[0].palette_json ? JSON.parse(theme.rows[0].palette_json) : {},
      occasion_message: theme.rows[0].occasion_message,
      layout: theme.rows[0].layout || 'classic'
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/admin/settings/appearance', authenticateToken, requireAdmin, async (req, res) => {
  const setting = await pool.query("SELECT value FROM site_settings WHERE key = 'active_theme'");
  const activeName = setting.rows.length ? setting.rows[0].value : 'Default';
  const themes = await pool.query('SELECT id, name, label, palette_json, occasion_message, is_active, layout FROM site_themes ORDER BY id');
  res.json({ active_theme: activeName, themes: themes.rows });
});

app.get('/api/admin/settings/themes', authenticateToken, requireAdmin, async (req, res) => {
  const rows = await pool.query('SELECT id, name, label, palette_json, occasion_message, is_active, layout FROM site_themes ORDER BY id');
  res.json({ themes: rows.rows });
});

async function activateTheme(id) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await client.query('SELECT name FROM site_themes WHERE id = $1 FOR UPDATE', [id]);
    if (!result.rows.length) {
      await client.query('ROLLBACK');
      return null;
    }
    const activeTheme = result.rows[0].name;
    await client.query('UPDATE site_themes SET is_active = false');
    await client.query('UPDATE site_themes SET is_active = true WHERE id = $1', [id]);
    await client.query(
      `INSERT INTO site_settings (key, value) VALUES ('active_theme', $1)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
      [activeTheme]
    );
    await client.query('COMMIT');
    return activeTheme;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

app.put('/api/admin/settings/appearance', authenticateToken, requireAdmin, async (req, res) => {
  const { active_theme } = req.body;
  if (!active_theme) return res.status(400).json({ error: 'active_theme is required.' });
  try {
    const result = await pool.query('SELECT id FROM site_themes WHERE name = $1', [active_theme]);
    if (!result.rows.length) return res.status(404).json({ error: 'Theme not found.' });
    const activatedTheme = await activateTheme(result.rows[0].id);
    if (!activatedTheme) return res.status(404).json({ error: 'Theme not found.' });
    res.json({ success: true, active_theme });
  } catch (err) {
    console.error('Theme activation failed:', err);
    res.status(500).json({ error: 'Could not activate the selected theme.' });
  }
});

app.post('/api/admin/settings/themes/:id/apply', authenticateToken, requireAdmin, async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id < 1) return res.status(400).json({ error: 'Invalid theme id.' });
  try {
    const active_theme = await activateTheme(id);
    if (!active_theme) return res.status(404).json({ error: 'Theme not found.' });
    res.json({ success: true, active_theme });
  } catch (err) {
    console.error('Theme activation failed:', err);
    res.status(500).json({ error: 'Could not activate the selected theme.' });
  }
});

app.delete('/api/admin/settings/themes/:id', authenticateToken, requireAdmin, async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id < 1) return res.status(400).json({ error: 'Invalid theme id.' });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const themeResult = await client.query('SELECT id, name, is_active FROM site_themes WHERE id = $1 FOR UPDATE', [id]);
    if (!themeResult.rows.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Theme not found.' });
    }
    if (['Default', 'Diwali', 'Holi', 'Eid', 'Christmas', 'Minimal'].includes(themeResult.rows[0].name)) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'Built-in quick themes cannot be deleted.' });
    }
    const countResult = await client.query('SELECT COUNT(*) AS total FROM site_themes');
    if (Number(countResult.rows[0].total) <= 1) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'The last remaining theme cannot be deleted.' });
    }

    let activeTheme = null;
    if (themeResult.rows[0].is_active) {
      const fallbackResult = await client.query('SELECT id, name FROM site_themes WHERE id <> $1 ORDER BY id LIMIT 1 FOR UPDATE', [id]);
      activeTheme = fallbackResult.rows[0].name;
      await client.query('UPDATE site_themes SET is_active = false');
      await client.query('UPDATE site_themes SET is_active = true WHERE id = $1', [fallbackResult.rows[0].id]);
      await client.query(
        `INSERT INTO site_settings (key, value) VALUES ('active_theme', $1)
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
        [activeTheme]
      );
    }
    await client.query('DELETE FROM site_themes WHERE id = $1', [id]);
    await client.query('COMMIT');
    res.json({ success: true, deleted_theme: themeResult.rows[0].name, active_theme: activeTheme });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Theme deletion failed:', err);
    res.status(500).json({ error: 'Could not delete the theme pack.' });
  } finally {
    client.release();
  }
});

app.post('/api/admin/settings/themes', authenticateToken, requireAdmin, async (req, res) => {
  const { name, label, palette_json, occasion_message, layout } = req.body;
  const cleanName = typeof name === 'string' ? name.trim() : '';
  const cleanLabel = typeof label === 'string' ? label.trim() : cleanName;
  const chosenLayout = layout || 'classic';
  if (!cleanName || cleanName.length > 60) {
    return res.status(400).json({ error: 'Theme name is required and must be 60 characters or fewer.' });
  }
  if (!cleanLabel || cleanLabel.length > 80) {
    return res.status(400).json({ error: 'Theme label is required and must be 80 characters or fewer.' });
  }
  if (!['classic', 'minimal', 'editorial'].includes(chosenLayout)) {
    return res.status(400).json({ error: 'Choose a valid layout template.' });
  }

  let palette;
  try {
    palette = typeof palette_json === 'string' ? JSON.parse(palette_json) : palette_json;
  } catch {
    return res.status(400).json({ error: 'Theme colors must be valid JSON.' });
  }
  if (!palette || typeof palette !== 'object' || Array.isArray(palette)) {
    return res.status(400).json({ error: 'Theme colors are required.' });
  }
  const colorKeys = ['primary', 'accent', 'bg', 'text', 'surface'];
  for (const key of colorKeys) {
    const value = palette[key] || (key === 'surface' ? palette.bg : null);
    if (typeof value !== 'string' || !/^#[0-9a-fA-F]{6}$/.test(value)) {
      return res.status(400).json({ error: `Theme color "${key}" must be a six-digit hex value.` });
    }
    palette[key] = value.toLowerCase();
  }
  const fonts = ['Plus Jakarta Sans', 'Outfit', 'Georgia', 'Arial'];
  if (!fonts.includes(palette.font || 'Plus Jakarta Sans') || !fonts.includes(palette.headingFont || 'Outfit')) {
    return res.status(400).json({ error: 'Choose a supported font for the theme.' });
  }
  palette.font = palette.font || 'Plus Jakarta Sans';
  palette.headingFont = palette.headingFont || 'Outfit';

  if (occasion_message !== undefined && occasion_message !== null && typeof occasion_message !== 'string') {
    return res.status(400).json({ error: 'Occasion greeting must be text.' });
  }
  const cleanOccasionMessage = typeof occasion_message === 'string' ? occasion_message.trim() : '';
  if (cleanOccasionMessage.length > 240) {
    return res.status(400).json({ error: 'Occasion greeting must be 240 characters or fewer.' });
  }

  try {
    const result = await pool.query(
      `INSERT INTO site_themes (name, label, palette_json, occasion_message, is_active, layout)
       VALUES ($1, $2, $3, $4, false, $5)
       RETURNING id, name, label, palette_json, occasion_message, is_active, layout`,
      [cleanName, cleanLabel, JSON.stringify(palette), cleanOccasionMessage || null, chosenLayout]
    );
    res.status(201).json({ theme: result.rows[0] });
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'A theme with that name already exists.' });
    console.error('Theme creation failed:', err);
    res.status(500).json({ error: 'Could not save the theme pack.' });
  }
});

// ==================== RESELLER API (sell our services to other sites) ====================
// Mirrors the common SMM panel contract so external websites / scripts can buy from us
// using the same endpoint they already use for their own supplier.
async function authenticateApiKey(req, res, next) {
  const key = req.body?.key || req.query.key || req.headers['x-api-key'];
  if (!key) return res.status(401).json({ error: 'No API key supplied' });

  const record = await pool.query("SELECT * FROM api_keys WHERE api_key = $1 AND status = 'active'", [String(key)]);
  if (!record.rows.length) return res.status(403).json({ error: 'Invalid API key' });

  const user = await pool.query('SELECT * FROM users WHERE id = $1', [record.rows[0].user_id]);
  if (!user.rows.length) return res.status(403).json({ error: 'API key is not linked to an active account' });

  req.apiUser = user.rows[0];
  next();
}

app.post('/api/v2', authenticateApiKey, async (req, res) => {
  const { action, service, link, quantity, order } = req.body || {};

  switch (action) {
    case 'services': {
      const rows = await pool.query("SELECT id, category, name, rate_per_1000, min_quantity, max_quantity, description FROM services WHERE status = 'active'");
      return res.json({
        data: rows.rows.map((s) => ({
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
      const svc = await pool.query('SELECT * FROM services WHERE id = $1', [service]);
      if (!svc.rows.length) return res.json({ error: 'Invalid service id' });
      if (!link) return res.json({ error: 'Link is required' });

      const qty = parseInt(quantity);
      if (!Number.isFinite(qty) || qty < svc.rows[0].min_quantity || qty > svc.rows[0].max_quantity) {
        return res.json({ error: `Quantity must be between ${svc.rows[0].min_quantity} and ${svc.rows[0].max_quantity}` });
      }

      const placed = await placeOrder(req.apiUser, svc.rows[0], link, qty, req.apiUser.currency || 'INR');
      if (placed.error) return res.json({ error: placed.error });

      if (svc.rows[0].provider_id) {
        const forwarded = await forwardOrderToProvider(placed.order_id);
        if (forwarded.error) {
          return res.json({ order: placed.order_id, warning: forwarded.error });
        }
      }

      return res.json({ order: placed.order_id, charge: placed.charge, start_count: 0 });
    }

    case 'status': {
      const row = await pool.query('SELECT * FROM orders WHERE id = $1 AND user_id = $2', [order, req.apiUser.id]);
      if (!row.rows.length) return res.json({ error: 'Order not found' });

      return res.json({
        order: row.rows[0].id,
        charge: row.rows[0].charge,
        start_count: 0,
        status: row.rows[0].status,
        remains: 0,
        currency: row.rows[0].currency
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

app.get('/api/v2/services', authenticateApiKey, async (req, res) => {
  const rows = await pool.query("SELECT id, category, name, rate_per_1000, min_quantity, max_quantity, description FROM services WHERE status = 'active'");
  res.json({
    data: rows.rows.map((s) => ({
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
app.get('/api/user/api-key', authenticateToken, async (req, res) => {
  const record = await pool.query('SELECT api_key, created_at FROM api_keys WHERE user_id = $1', [req.user.id]);
  const row = record.rows[0];
  res.json({ api_key: row ? row.api_key : null, created_at: row ? row.created_at : null });
});

app.post('/api/user/api-key', authenticateToken, async (req, res) => {
  const existing = await pool.query('SELECT id FROM api_keys WHERE user_id = $1', [req.user.id]);
  const apiKey = 'JR' + crypto.randomBytes(20).toString('hex');
  const label = (req.body && req.body.label) || 'default';

  if (existing.rows.length) {
    await pool.query('UPDATE api_keys SET api_key = $1, label = $2 WHERE id = $3', [apiKey, label, existing.rows[0].id]);
  } else {
    await pool.query('INSERT INTO api_keys (user_id, api_key, label) VALUES ($1, $2, $3)', [req.user.id, apiKey, label]);
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
async function creditVerifiedPayment(orderId, cashfreeStatus) {
  const record = await pool.query('SELECT * FROM payment_orders WHERE order_id = $1', [orderId]);
  if (!record.rows.length) return { credited: false, reason: 'Unknown order' };

  // Only a fresh PAID from the gateway may credit. Anything else just records
  // the latest status so the deposit history stays accurate.
  if (cashfreeStatus !== 'PAID') {
    await pool.query("UPDATE payment_orders SET payment_status = $1, updated_at = CURRENT_TIMESTAMP WHERE order_id = $2 AND credited = 0", [cashfreeStatus, orderId]);
    return { credited: false, reason: `Payment status is ${cashfreeStatus}` };
  }

  if (record.rows[0].credited) return { credited: false, reason: 'Already credited', amount: record.rows[0].amount };

  const user = await pool.query('SELECT * FROM users WHERE id = $1', [record.rows[0].user_id]);
  if (!user.rows.length) return { credited: false, reason: 'User no longer exists' };

  const walletField = record.rows[0].wallet_field || WALLET_BY_CURRENCY[record.rows[0].currency] || 'wallet_inr';

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const info = await client.query("UPDATE payment_orders SET payment_status = 'PAID', credited = 1, updated_at = CURRENT_TIMESTAMP WHERE order_id = $1 AND credited = 0", [orderId]);
    if (info.rowCount !== 1) {
      await client.query('ROLLBACK');
      return { credited: false, reason: 'Already credited', amount: record.rows[0].amount };
    }
    await client.query(`UPDATE users SET ${walletField} = ${walletField} + $1 WHERE id = $2`, [record.rows[0].amount, record.rows[0].user_id]);
    await client.query('INSERT INTO transactions (user_id, amount, currency, payment_method) VALUES ($1, $2, $3, $4)', [record.rows[0].user_id, record.rows[0].amount, record.rows[0].currency, 'Cashfree']);
    await client.query('COMMIT');
    return { credited: true, amount: record.rows[0].amount, currency: record.rows[0].currency };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
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

  const user = await pool.query('SELECT * FROM users WHERE id = $1', [req.user.id]);
    if (!user.rows.length) return res.status(404).json({ success: false, error: 'Account not found.' });

    const orderId = `TOPUP_${Date.now()}_${crypto.randomBytes(4).toString('hex').toUpperCase()}`;

    await pool.query(
      `INSERT INTO payment_orders (order_id, user_id, amount, currency, wallet_field, payment_status) VALUES ($1, $2, $3, $4, $5, 'PENDING') RETURNING id`,
      [orderId, user.rows[0].id, amount, currency, WALLET_BY_CURRENCY[currency] || 'wallet_inr']
    );

    const orderPayload = {
      order_id: orderId,
      order_amount: amount.toFixed(2),
      order_currency: currency,
      customer_details: {
        customer_id: String(user.rows[0].id),
        customer_name: user.rows[0].name || 'Customer',
        customer_email: user.rows[0].email,
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

    await pool.query('UPDATE payment_orders SET payment_session_id = $1 WHERE order_id = $2', [response.data.payment_session_id, orderId]);

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
      await creditVerifiedPayment(order_id, 'PAID');
      return res.redirect(`/#/payment-success?order_id=${order_id}`);
    }

    await pool.query("UPDATE payment_orders SET payment_status = $1, updated_at = CURRENT_TIMESTAMP WHERE order_id = $2 AND credited = 0", [orderStatus, order_id]);
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
app.post('/api/cashfree/webhook', async (req, res) => {
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
      await creditVerifiedPayment(orderId, 'PAID');
    } else if (['FAILED', 'CANCELLED'].includes(String(status).toUpperCase())) {
      await pool.query("UPDATE payment_orders SET payment_status = $1, updated_at = CURRENT_TIMESTAMP WHERE order_id = $2 AND credited = 0", [String(status).toUpperCase(), orderId]);
    }

    res.json({ success: true });
  } catch (error) {
    console.error('Cashfree Webhook Error:', error.message);
    res.status(500).json({ success: false, error: 'Webhook processing failed' });
  }
});

// Global error handler
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  if (req.path && req.path.startsWith('/api/')) {
    res.status(500).json({ error: 'Internal server error', message: err.message });
  } else {
    res.status(500).send('Internal Server Error');
  }
});

// Health check endpoint
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

app.get('*', (req, res) => {
  const indexPath = path.join(__dirname, 'public', 'index.html');
  console.log('Serving index.html from:', indexPath);
  res.sendFile(indexPath).catch(err => {
    console.error('Failed to serve index.html:', err);
    res.status(500).json({ error: 'Failed to serve index.html', path: indexPath });
  });
});

// Initialize database and start server
initDb().then(initializeAppData).then(() => {
  console.log('Database initialized successfully');
  app.listen(PORT, () => {
    console.log(`🚀 Jay Rajput Media Power Server live on http://localhost:${PORT}`);
    console.log(`💳 Cashfree return/webhook origin: ${PUBLIC_URL}`);
  });
}).catch(err => {
  console.error('Failed to initialize database:', err);
  app.listen(PORT, () => {
    console.log(`🚀 Server started on http://localhost:${PORT} but DATABASE FAILED:`, err.message);
  });
});
