const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

async function migrate() {
  const client = await pool.connect();
  try {
    await client.query(`
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
      )
    `);
    console.log('Migration completed: provider_services table created');
  } catch (err) {
    console.error('Migration failed:', err);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

migrate();
