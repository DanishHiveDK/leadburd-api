// db.js — PostgreSQL pool.
// Same approach as EuroHive: parse DATABASE_URL ourselves so pg-connection-string
// never overwrites our explicit ssl option from an sslmode= query param.
'use strict';

const { Pool } = require('pg');

function buildPoolConfig() {
  const raw = process.env.DATABASE_URL || '';

  // Local / test: no SSL
  if (!raw || raw.includes('localhost') || raw.includes('127.0.0.1')) {
    return { connectionString: raw, ssl: false };
  }

  let parsed;
  try {
    // postgres:// is not a recognised scheme in the WHATWG URL parser — swap it
    parsed = new URL(raw.replace(/^postgres:\/\//, 'postgresql://'));
  } catch {
    return { connectionString: raw, ssl: { rejectUnauthorized: false } };
  }

  return {
    host:     parsed.hostname,
    port:     parseInt(parsed.port || '5432', 10),
    database: parsed.pathname.replace(/^\//, ''),
    user:     decodeURIComponent(parsed.username),
    password: decodeURIComponent(parsed.password),
    ssl: process.env.DB_SSL_CA
      ? { rejectUnauthorized: true, ca: process.env.DB_SSL_CA }
      : { rejectUnauthorized: false },
  };
}

const pool = new Pool({
  ...buildPoolConfig(),
  max: 15,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000,
});

pool.on('error', (err) => console.error('[DB] Unexpected pool error:', err.message));

async function query(text, params) {
  try {
    return await pool.query(text, params);
  } catch (err) {
    console.error('[DB] Query error:', err.message, '\nSQL:', text.slice(0, 200));
    throw err;
  }
}

/** Obtain a client for a multi-statement transaction. Caller MUST release(). */
async function getClient() {
  const client = await pool.connect();
  const originalRelease = client.release.bind(client);
  const timeout = setTimeout(() => {
    console.error('[DB] Client held >10s without release — possible leak');
  }, 10000);
  client.release = () => {
    clearTimeout(timeout);
    client.release = originalRelease;
    return originalRelease();
  };
  return client;
}

/** Run fn inside a transaction, committing on success and rolling back on throw. */
async function transaction(fn) {
  const client = await getClient();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

module.exports = { query, getClient, transaction, pool };
