// scripts/devdb.js — a real PostgreSQL for local development, without
// installing anything. Downloads and runs an embedded server, keeps the data
// between restarts, and stays up until Ctrl+C.
//
//   npm run db:local        (leave running in its own terminal)
//
// Point DATABASE_URL at it:
//   postgresql://postgres:postgres@127.0.0.1:55432/lysmera
'use strict';

const path = require('path');
const fs   = require('fs');

const PORT     = Number(process.env.LOCAL_DB_PORT) || 55432;
const DATA_DIR = path.join(__dirname, '..', '.localdb');
const DB_NAME  = 'lysmera';

async function main() {
  const mod = require('embedded-postgres');
  const EmbeddedPostgres = mod.default ?? mod;

  const firstRun = !fs.existsSync(DATA_DIR);

  const pg = new EmbeddedPostgres({
    databaseDir: DATA_DIR,
    user: 'postgres',
    password: 'postgres',
    port: PORT,
    persistent: true,
    // Match Railway: a Danish Windows locale would otherwise initialise the
    // cluster as WIN1252 and reject perfectly ordinary UTF-8.
    initdbFlags: ['--encoding=UTF8', '--no-locale'],
  });

  if (firstRun) {
    console.log('Første kørsel — opretter databasen (tager et øjeblik)…');
    await pg.initialise();
  }

  await pg.start();

  if (firstRun) {
    await pg.createDatabase(DB_NAME);
  }

  const url = `postgresql://postgres:postgres@127.0.0.1:${PORT}/${DB_NAME}`;
  console.log(`\n  PostgreSQL kører.\n`);
  console.log(`  DATABASE_URL=${url}\n`);
  if (firstRun) {
    console.log('  Kør nu i en anden terminal:');
    console.log('    npm run migrate');
    console.log('    npm run seed -- --org "Dit Firma ApS" --name "Dit navn" --email dig@firma.dk\n');
  }
  console.log('  Ctrl+C for at stoppe.\n');

  let stopping = false;
  const shutdown = async () => {
    if (stopping) return;
    stopping = true;
    console.log('\nStopper databasen…');
    await pg.stop().catch(() => {});
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  // Nothing else to do — the server runs in a child process; hold the event
  // loop open so the signal handlers stay attached.
  setInterval(() => {}, 1 << 30);
}

main().catch((err) => {
  console.error('[db:local] FEJLEDE:', err.message);
  process.exit(1);
});
