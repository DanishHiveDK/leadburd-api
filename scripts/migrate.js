// scripts/migrate.js — apply every unapplied .sql file in migrations/ in order.
'use strict';

require('dotenv').config();
const fs   = require('fs');
const path = require('path');
const db   = require('../db');

const DIR = path.join(__dirname, '..', 'migrations');

async function run() {
  await db.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      filename    TEXT PRIMARY KEY,
      applied_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`);

  const applied = new Set(
    (await db.query('SELECT filename FROM schema_migrations')).rows.map((r) => r.filename)
  );

  const files = fs.readdirSync(DIR).filter((f) => f.endsWith('.sql')).sort();
  let count = 0;

  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = fs.readFileSync(path.join(DIR, file), 'utf8');
    // Each migration is one transaction — a failure leaves nothing half-applied.
    await db.transaction(async (client) => {
      await client.query(sql);
      await client.query('INSERT INTO schema_migrations (filename) VALUES ($1)', [file]);
    });
    console.log(`  ✓ ${file}`);
    count++;
  }

  console.log(count ? `\n${count} migration(s) applied.` : 'Database already up to date.');
  await db.pool.end();
}

run().catch((err) => {
  console.error('[migrate] FAILED:', err.message);
  process.exit(1);
});
