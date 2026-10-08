// Seeds the 24 WhatsApp-catalog services into the `services` table.
// Each service gets one of the Cloudinary images uploaded in wa-upload-results.json.
// Idempotent: skips names that already exist as in-house (provider_id IS NULL) services.
const fs = require('fs');
const { Pool } = require('pg');
require('dotenv').config();

const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

// Placeholder catalog (names/details approved as placeholders by the user).
// Rates are INR per 1000, consistent with the existing in-house services.
const CATALOG = [
  { category: 'Instagram', name: 'Instagram Followers [Instant Start]',        rate: 99,  min: 100,   max: 100000,  description: 'Fast delivery, worldwide targeting.' },
  { category: 'Instagram', name: 'Instagram Likes [Auto Likes]',               rate: 35,  min: 50,    max: 200000,  description: 'Real active users, instant start.' },
  { category: 'Instagram', name: 'Instagram Comments [Real Users]',            rate: 149, min: 50,    max: 50000,   description: 'Genuine comments with replies.' },
  { category: 'Instagram', name: 'Instagram Reels Views',                      rate: 59,  min: 100,   max: 500000,  description: 'High retention reel views.' },
  { category: 'Instagram', name: 'Instagram Story Views',                      rate: 49,  min: 100,   max: 200000,  description: 'Targeted story viewers.' },
  { category: 'Instagram', name: 'Instagram Profile Visits',                   rate: 99,  min: 100,   max: 100000,  description: 'Organic profile traffic.' },
  { category: 'Facebook',  name: 'Facebook Page Likes [Worldwide]',            rate: 150, min: 100,   max: 50000,   description: 'Worldwide page likes, safe delivery.' },
  { category: 'Facebook',  name: 'Facebook Post Likes',                        rate: 79,  min: 100,   max: 100000,  description: 'Instant post engagement.' },
  { category: 'Facebook',  name: 'Facebook Followers [Targeted]',              rate: 199, min: 100,   max: 50000,   description: 'Country-targeted followers.' },
  { category: 'Facebook',  name: 'Facebook Video Views',                       rate: 39,  min: 500,   max: 1000000, description: 'High-quality video views.' },
  { category: 'YouTube',   name: 'YouTube Views [Fast]',                       rate: 49,  min: 500,   max: 1000000, description: 'Fast views, no drop.' },
  { category: 'YouTube',   name: 'YouTube Subscribers [Real]',                 rate: 399, min: 100,   max: 50000,   description: 'Real subscribers, refill enabled.' },
  { category: 'YouTube',   name: 'YouTube Likes',                              rate: 59,  min: 100,   max: 200000,  description: 'Instant likes from active users.' },
  { category: 'YouTube',   name: 'YouTube Comments',                           rate: 179, min: 50,    max: 50000,   description: 'Custom comments available.' },
  { category: 'Twitter',   name: 'X (Twitter) Followers',                        rate: 129, min: 100,   max: 100000,  description: 'Instant followers, safe.' },
  { category: 'Twitter',   name: 'X (Twitter) Likes',                            rate: 29,  min: 50,    max: 500000,  description: 'Fast tweet likes.' },
  { category: 'Twitter',   name: 'X (Twitter) Retweets',                         rate: 69,  min: 50,    max: 200000,  description: 'Retweets from real accounts.' },
  { category: 'TikTok',    name: 'TikTok Followers',                             rate: 89,  min: 100,   max: 100000,  description: 'Instant TikTok followers.' },
  { category: 'TikTok',    name: 'TikTok Likes',                               rate: 29,  min: 100,   max: 500000,  description: 'Fast TikTok likes.' },
  { category: 'TikTok',    name: 'TikTok Views',                               rate: 19,  min: 1000,  max: 2000000, description: 'High-quality TikTok views.' },
  { category: 'Telegram',  name: 'Telegram Group Members',                       rate: 199, min: 50,    max: 50000,   description: 'Real group members.' },
  { category: 'Telegram',  name: 'Telegram Channel Views',                       rate: 29,  min: 500,   max: 1000000, description: 'Post views for channels.' },
  { category: 'Music',     name: 'Spotify Monthly Listeners',                    rate: 299, min: 50,    max: 50000,   description: 'Organic monthly listeners.' },
  { category: 'Traffic',   name: 'Website Traffic [Organic]',                    rate: 249, min: 100,   max: 100000,  description: 'Targeted website visitors.' }
];

async function seed() {
  const images = JSON.parse(fs.readFileSync('wa-upload-results.json', 'utf8'));
  if (images.length < CATALOG.length) {
    throw new Error(`Need ${CATALOG.length} images, found ${images.length}`);
  }

  let inserted = 0;
  let skipped = 0;

  for (let i = 0; i < CATALOG.length; i++) {
    const svc = CATALOG[i];
    const image = images[i].url;

    const existing = await pool.query(
      'SELECT id FROM services WHERE LOWER(TRIM(name)) = LOWER(TRIM($1)) AND provider_id IS NULL',
      [svc.name]
    );
    if (existing.rows.length) {
      // Keep the catalog image on existing entries so the card art stays current.
      await pool.query('UPDATE services SET image = $1 WHERE id = $2', [image, existing.rows[0].id]);
      skipped++;
      continue;
    }

    await pool.query(
      `INSERT INTO services (category, name, rate_per_1000, min_quantity, max_quantity, description, image)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [svc.category, svc.name, svc.rate, svc.min, svc.max, svc.description, image]
    );
    inserted++;
    console.log(`+ [${svc.category}] ${svc.name} (₹${svc.rate}/1000)`);
  }

  const total = await pool.query('SELECT COUNT(*) AS n FROM services');
  console.log(`\nInserted: ${inserted}, Updated/skipped: ${skipped}, Total services now: ${total.rows[0].n}`);
  await pool.end();
}

seed().catch(async (err) => { console.error('Seed error:', err.message); await pool.end(); process.exit(1); });
