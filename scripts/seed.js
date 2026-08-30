// scripts/seed.js — create the first organisation and its owner.
// Usage: npm run seed -- --org "Firma ApS" --name "Lucca" --email x@y.dk --password ...
'use strict';

require('dotenv').config();
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const db     = require('../db');

function arg(flag, fallback = null) {
  const i = process.argv.indexOf(`--${flag}`);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

async function run() {
  const orgName  = arg('org', 'Lysmera Demo ApS');
  const name     = arg('name', 'Administrator');
  const email    = (arg('email', 'admin@lysmera.dk')).toLowerCase();
  // A generated password beats a weak default that ends up in production.
  const password = arg('password') || crypto.randomBytes(9).toString('base64url');
  const generated = !arg('password');

  const existing = await db.query('SELECT id FROM users WHERE LOWER(email) = $1', [email]);
  if (existing.rows.length) {
    console.log(`Brugeren ${email} findes allerede — intet at gøre.`);
    return;
  }

  await db.transaction(async (client) => {
    const org = await client.query(
      'INSERT INTO organizations (name, cvr) VALUES ($1, $2) RETURNING id',
      [orgName, arg('cvr')]
    );
    await client.query(
      `INSERT INTO users (org_id, email, password_hash, name, role)
       VALUES ($1, $2, $3, $4, 'owner')`,
      [org.rows[0].id, email, await bcrypt.hash(password, 12), name]
    );
  });

  console.log('\n  Organisation: ' + orgName);
  console.log('  Log ind med:  ' + email);
  console.log('  Adgangskode:  ' + password);
  if (generated) console.log('\n  (Genereret — skift den efter første login.)');
}

run()
  .catch((err) => { console.error('[seed] FAILED:', err.message); process.exitCode = 1; })
  .finally(() => db.pool.end());
