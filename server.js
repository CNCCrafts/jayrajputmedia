const express = require('express');
const cors = require('cors');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const { Pool } = require('pg');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const axios = require('axios');
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
app.use(express.static(path.join(__dirname, 'public')));

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

(async function init() {
  await addColumnIfMissing('services', 'provider_id', 'INTEGER');
  await addColumnIfMissing('services', 'upstream_service_id', 'TEXT');
  await addColumnIfMissing('services', 'cost_per_1000', 'REAL');
  await addColumnIfMissing('services', 'image', 'TEXT');
  await addColumnIfMissing('orders', 'upstream_order_id', 'TEXT');
  await addColumnIfMissing('orders', 'cost', 'REAL DEFAULT 0');
  await addColumnIfMissing('users', 'status', "TEXT DEFAULT 'active'");
  await addColumnIfMissing('tickets', 'resolved_at', 'TIMESTAMP');

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

  // Seed default site themes if none exist
  const themeCount = await pool.query("SELECT COUNT(*) AS n FROM site_themes");
  if (parseInt(themeCount.rows[0].n) === 0) {
    const defaultThemes = [
      ['Default', 'Default', '{"primary":"#1e40af","accent":"#f59e0b","bg":"#ffffff","text":"#1f2937"}', null, true],
      ['Diwali', 'Festive', '{"primary":"#d97706","accent":"#eab308","bg":"#fffff7","text":"#78350f"}', null, false],
      ['Holi', 'Festive', '{"primary":"#ec4899","accent":"#a855f7","bg":"#fff0f6","text":"#7c2d7c"}', null, false],
      ['Eid', 'Festive', '{"primary":"#0f766e","accent":"#2dd36f","bg":"#ecfdf5","text":"#064e35"}', null, false],
      ['Christmas', 'Festive', '{"primary":"#b91c1c","accent":"#f59e0b","bg":"#ffeff1","text":"#7f1d1d"}', null, false]
    ];
    for (const t of defaultThemes) {
      await pool.query(
        `INSERT INTO site_themes (name, label, palette_json, banner_url, is_active) VALUES ($1, $2, $3, $4, $5) ON CONFLICT (name) DO NOTHING`,
        t
      );
    }
  }

  await pool.query(
    `INSERT INTO site_settings (key, value) VALUES ('active_theme', 'Default') ON CONFLICT (key) DO NOTHING`
  );
})();

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

