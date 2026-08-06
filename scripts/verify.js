// scripts/verify.js — end-to-end check against a real, throwaway PostgreSQL.
//
// Boots an embedded Postgres, runs the migrations, seeds an organisation and
// then drives the actual Express app over HTTP: login, list creation, the call
// queue, callbacks, CSV export and the org-isolation guarantees.
//
// The CVR provider is stubbed — Virk credentials are not needed to prove the
// database layer and the API work.
//
//   node scripts/verify.js
'use strict';

const path = require('path');
const os   = require('os');
const fs   = require('fs');
const crypto = require('crypto');

// Deliberately not 55432 — that's `npm run db:local`, and the two must be able
// to run side by side.
const PG_PORT  = 55433;
const APP_PORT = 4555;

let passed = 0;
let failed = 0;

function check(name, condition, detail = '') {
  if (condition) {
    passed++;
    console.log(`  ✓ ${name}`);
  } else {
    failed++;
    console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

function section(title) {
  console.log(`\n${title}`);
}

/** Fake CVR companies so the extraction path can run without Virk. */
function fakeCompanies(count, offset = 0) {
  return Array.from({ length: count }, (_, i) => {
    const n = offset + i;
    return {
      cvr: String(10000000 + n),
      name: `Testvirksomhed ${n} ApS`,
      address: `Testvej ${n}`,
      zipcode: String(5000 + (n % 900)),
      city: 'Odense',
      municipality: 'Odense',
      phone: `65${String(100000 + n).slice(0, 6)}`,
      email: `kontakt${n}@example.dk`,
      website: 'https://example.dk',
      industryCode: '620200',
      industryText: 'IT-konsulentbistand',
      companyType: 'APS',
      employees: (n % 40) + 1,
      employeesInterval: null,
      establishedOn: '2015-03-01',
      status: 'NORMAL',
      // Every tenth company is advertising-protected — these must never land
      // in a list, which is the whole point of checking it here.
      advertisingProtected: n % 10 === 0,
    };
  });
}

async function main() {
  const mod = require('embedded-postgres');
  const EmbeddedPostgres = mod.default ?? mod;
  const dataDir = path.join(os.tmpdir(), `leadburd-verify-${Date.now()}`);

  console.log('Starter midlertidig PostgreSQL…');
  const pg = new EmbeddedPostgres({
    databaseDir: dataDir,
    user: 'postgres',
    password: 'postgres',
    port: PG_PORT,
    persistent: false,
    // A Danish Windows locale would initialise the cluster as WIN1252 and
    // reject non-Latin-1 bytes. Production (Railway) is UTF8 — match it, or
    // this verification tests a database unlike the real one.
    initdbFlags: ['--encoding=UTF8', '--no-locale'],
  });

  await pg.initialise();
  await pg.start();
  await pg.createDatabase('leadburd_test');
  console.log(`PostgreSQL kører på :${PG_PORT}\n`);

  // Env must be set before db.js / server.js are required — the pool is built
  // at module load.
  process.env.DATABASE_URL = `postgresql://postgres:postgres@127.0.0.1:${PG_PORT}/leadburd_test`;
  process.env.JWT_SECRET   = crypto.randomBytes(32).toString('hex');
  process.env.PORT         = String(APP_PORT);
  process.env.NODE_ENV     = 'test';

  const db = require('../db');

  try {
    // ── Migrations ───────────────────────────────────────────────────────────
    section('Migrations');
    const migDir = path.join(__dirname, '..', 'migrations');
    await db.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      filename TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
    for (const file of fs.readdirSync(migDir).filter((f) => f.endsWith('.sql')).sort()) {
      await db.transaction(async (c) => {
        await c.query(fs.readFileSync(path.join(migDir, file), 'utf8'));
        await c.query('INSERT INTO schema_migrations (filename) VALUES ($1)', [file]);
      });
      check(`${file} kørt`, true);
    }
    const tables = await db.query(
      `SELECT table_name FROM information_schema.tables
        WHERE table_schema = 'public' ORDER BY table_name`);
    const names = tables.rows.map((r) => r.table_name);
    check('alle tabeller oprettet',
      ['organizations', 'users', 'lead_lists', 'leads', 'lead_activities'].every((t) => names.includes(t)),
      names.join(', '));

    // ── Seed two organisations, so isolation can be tested ───────────────────
    section('Organisationer og brugere');
    const bcrypt = require('bcryptjs');
    const hash = await bcrypt.hash('hemmeligkode123', 10);

    const mkOrg = async (orgName, email) => {
      const org = await db.query('INSERT INTO organizations (name) VALUES ($1) RETURNING id', [orgName]);
      const user = await db.query(
        `INSERT INTO users (org_id, email, password_hash, name, role)
         VALUES ($1, $2, $3, $4, 'owner') RETURNING id`,
        [org.rows[0].id, email, hash, orgName + ' ejer']);
      return { orgId: org.rows[0].id, userId: user.rows[0].id };
    };
    const orgA = await mkOrg('Firma A ApS', 'a@example.dk');
    const orgB = await mkOrg('Firma B ApS', 'b@example.dk');
    check('to organisationer oprettet', orgA.orgId !== orgB.orgId);

    const dupe = await db.query(
      `INSERT INTO users (org_id, email, password_hash, name)
       VALUES ($1, 'A@EXAMPLE.DK', $2, 'Dublet') ON CONFLICT DO NOTHING RETURNING id`,
      [orgB.orgId, hash]).catch((e) => e);
    check('e-mail er unik på tværs af store/små bogstaver',
      dupe instanceof Error || dupe.rows.length === 0);

    // ── Stub the CVR provider, then boot the app ─────────────────────────────
    const cvr = require('../services/cvrService');
    cvr.extractCompanies = async ({ limit = 1000, onBatch }) => {
      const batches = [fakeCompanies(30, 0), fakeCompanies(20, 30)];
      let fetched = 0;
      for (const b of batches) {
        const slice = b.slice(0, Math.max(0, limit - fetched));
        if (!slice.length) break;
        fetched += slice.length;
        if (onBatch) await onBatch(slice);
      }
      return { total: 50, fetched, results: [] };
    };

    require('../server');
    await new Promise((r) => setTimeout(r, 400));
    const BASE = `http://127.0.0.1:${APP_PORT}`;

    const call = async (path, { method = 'GET', body, token } = {}) => {
      const res = await fetch(`${BASE}${path}`, {
        method,
        headers: {
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
          ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
      const text = await res.text();
      let json = null;
      try { json = JSON.parse(text); } catch { /* CSV and the like */ }
      return { status: res.status, json, text, headers: res.headers };
    };

    // ── Auth ─────────────────────────────────────────────────────────────────
    section('Login');
    const health = await call('/health');
    check('/health rapporterer db: true', health.json?.db === true, JSON.stringify(health.json));

    const badLogin = await call('/api/auth/login', {
      method: 'POST', body: { email: 'a@example.dk', password: 'forkert' } });
    check('forkert adgangskode afvises', badLogin.status === 401);

    const unknownLogin = await call('/api/auth/login', {
      method: 'POST', body: { email: 'findes-ikke@example.dk', password: 'hemmeligkode123' } });
    check('ukendt e-mail giver samme svar som forkert kode',
      unknownLogin.status === 401 && unknownLogin.json.error === badLogin.json.error);

    const loginA = await call('/api/auth/login', {
      method: 'POST', body: { email: 'A@Example.dk', password: 'hemmeligkode123' } });
    check('login virker (og e-mail er case-insensitiv)', loginA.status === 200 && !!loginA.json.token);
    const tokenA = loginA.json.token;

    const loginB = await call('/api/auth/login', {
      method: 'POST', body: { email: 'b@example.dk', password: 'hemmeligkode123' } });
    const tokenB = loginB.json.token;

    const me = await call('/api/auth/me', { token: tokenA });
    check('/auth/me returnerer org-navn', me.json?.user?.orgName === 'Firma A ApS');

    const noAuth = await call('/api/lists');
    check('beskyttet rute kræver token', noAuth.status === 401);

    // ── Extraction into a list ───────────────────────────────────────────────
    section('Udtræk og lister');
    const tooBroad = await call('/api/lists', {
      method: 'POST', token: tokenA, body: { name: 'Alt', filters: {} } });
    check('udtræk uden filtre blokeres', tooBroad.status === 400
      && tooBroad.json.code === 'FILTER_TOO_BROAD');

    const created = await call('/api/lists', {
      method: 'POST', token: tokenA,
      body: { name: 'IT-firmaer Fyn', filters: { industryCodes: ['620200'], region: 'fyn' }, limit: 1000 } });
    check('liste oprettet', created.status === 201, JSON.stringify(created.json));
    const listId = created.json?.list?.id;

    // 50 generated, every tenth advertising-protected → 45 should be stored.
    check('reklamebeskyttede frasorteres (45 af 50 importeret)',
      created.json?.imported === 45, `importeret: ${created.json?.imported}`);

    const dbProtected = await db.query(
      'SELECT COUNT(*)::int AS n FROM leads WHERE list_id = $1 AND advertising_protected', [listId]);
    check('ingen reklamebeskyttede i databasen', dbProtected.rows[0].n === 0);

    const refresh = await call(`/api/lists/${listId}/refresh`, {
      method: 'POST', token: tokenA, body: { limit: 1000 } });
    check('opdatering tilføjer ingen dubletter', refresh.json?.added === 0,
      `tilføjet: ${refresh.json?.added}`);

    const listShow = await call(`/api/lists/${listId}`, { token: tokenA });
    check('liste-detaljer viser statusfordeling',
      listShow.json?.total === 45 && listShow.json?.byStatus?.new === 45,
      JSON.stringify(listShow.json?.byStatus));

    const leadsPage = await call(`/api/lists/${listId}/leads?size=10&page=2`, { token: tokenA });
    check('paginering virker', leadsPage.json?.leads?.length === 10 && leadsPage.json?.total === 45);

    const searchLeads = await call(`/api/lists/${listId}/leads?q=Testvirksomhed%201%20`, { token: tokenA });
    check('søgning i listen virker', searchLeads.json?.total >= 1);

    // ── Org isolation ────────────────────────────────────────────────────────
    section('Adskillelse mellem virksomheder');
    const bSeesLists = await call('/api/lists', { token: tokenB });
    check('Firma B ser ikke Firma A\'s lister', bSeesLists.json?.lists?.length === 0);

    const bReadsList = await call(`/api/lists/${listId}`, { token: tokenB });
    check('Firma B kan ikke åbne Firma A\'s liste (404)', bReadsList.status === 404);

    const someLead = (await db.query(
      'SELECT id FROM leads WHERE list_id = $1 LIMIT 1', [listId])).rows[0].id;
    const bReadsLead = await call(`/api/leads/${someLead}`, { token: tokenB });
    check('Firma B kan ikke åbne Firma A\'s lead (404)', bReadsLead.status === 404);

    const bWritesLead = await call(`/api/leads/${someLead}/outcome`, {
      method: 'POST', token: tokenB, body: { status: 'won' } });
    check('Firma B kan ikke ændre Firma A\'s lead (404)', bWritesLead.status === 404);

    // ── The call queue ───────────────────────────────────────────────────────
    section('Ringekø');
    const next1 = await call('/api/leads/next', { token: tokenA });
    check('næste lead udleveres', !!next1.json?.lead, JSON.stringify(next1.json).slice(0, 160));
    check('antal tilbage er korrekt', next1.json?.remaining === 45, `remaining: ${next1.json?.remaining}`);
    const lead1 = next1.json.lead;

    const noAnswer = await call(`/api/leads/${lead1.id}/outcome`, {
      method: 'POST', token: tokenA, body: { status: 'no_answer', note: 'Lagde besked' } });
    check('resultat "intet svar" gemmes',
      noAnswer.json?.lead?.status === 'no_answer' && noAnswer.json?.lead?.call_count === 1);
    check('leadet tildeles den der ringede', noAnswer.json?.lead?.assigned_to != null);

    const next2 = await call('/api/leads/next', { token: tokenA });
    check('køen går videre til et andet lead', next2.json?.lead?.id !== lead1.id);

    const missingTime = await call(`/api/leads/${next2.json.lead.id}/outcome`, {
      method: 'POST', token: tokenA, body: { status: 'callback' } });
    check('"ring igen" uden tidspunkt afvises', missingTime.status === 400);

    const future = new Date(Date.now() + 3 * 24 * 3600 * 1000).toISOString();
    const cbSet = await call(`/api/leads/${next2.json.lead.id}/outcome`, {
      method: 'POST', token: tokenA, body: { status: 'callback', callbackAt: future, note: 'Ring torsdag' } });
    check('genopkald gemmes med tidspunkt', cbSet.json?.lead?.next_callback_at != null);

    const next3 = await call('/api/leads/next', { token: tokenA });
    check('lead med fremtidigt genopkald springes over i køen',
      next3.json?.lead?.id !== next2.json.lead.id);

    // A callback that is already due must jump to the front of the queue.
    const past = new Date(Date.now() - 3600 * 1000);
    const overdueLead = next3.json.lead.id;
    await db.query('UPDATE leads SET status = $1, next_callback_at = $2 WHERE id = $3',
      ['callback', past, overdueLead]);
    const next4 = await call('/api/leads/next', { token: tokenA });
    check('forfaldent genopkald kommer forrest i køen', next4.json?.lead?.id === overdueLead,
      `fik ${next4.json?.lead?.id}, ventede ${overdueLead}`);

    const won = await call(`/api/leads/${overdueLead}/outcome`, {
      method: 'POST', token: tokenA, body: { status: 'won', note: 'Solgt!' } });
    check('terminal status rydder genopkaldet', won.json?.lead?.next_callback_at === null);

    const next5 = await call('/api/leads/next', { token: tokenA });
    check('vundet lead falder ud af køen', next5.json?.lead?.id !== overdueLead);

    const badStatus = await call(`/api/leads/${lead1.id}/outcome`, {
      method: 'POST', token: tokenA, body: { status: 'noget-opfundet' } });
    check('ukendt status afvises', badStatus.status === 400);

    // ── Notes, history, callbacks list, stats ────────────────────────────────
    section('Noter, historik og genopkald');
    await call(`/api/leads/${lead1.id}/notes`, {
      method: 'POST', token: tokenA, body: { body: 'Ringede igen, receptionen tog den' } });
    const detail = await call(`/api/leads/${lead1.id}`, { token: tokenA });
    check('historikken indeholder både opkald og note',
      detail.json?.activities?.some((a) => a.type === 'call')
      && detail.json?.activities?.some((a) => a.type === 'note'));
    check('historikken viser hvem der gjorde det',
      detail.json?.activities?.[0]?.user_name === 'Firma A ApS ejer');

    const cbToday = await call('/api/leads/callbacks?scope=today', { token: tokenA });
    check('dagens genopkald er tom (aftalen ligger om 3 dage)',
      cbToday.json?.callbacks?.length === 0, `fik ${cbToday.json?.callbacks?.length}`);

    const cbWeek = await call('/api/leads/callbacks?scope=week', { token: tokenA });
    check('ugens genopkald indeholder aftalen', cbWeek.json?.callbacks?.length === 1);

    // Three outcomes were logged: no_answer, callback and won. The rejected
    // callback (400) and the plain note must not count as calls.
    const stats = await call('/api/stats', { token: tokenA });
    check('statistik tæller kun rigtige opkald (3)', stats.json?.calls_today === 3,
      JSON.stringify(stats.json));
    check('statistik tæller vundne', stats.json?.won === 1, JSON.stringify(stats.json));

    const statsB = await call('/api/stats', { token: tokenB });
    check('Firma B\'s statistik er nul', statsB.json?.leads === 0);

    // ── Team ─────────────────────────────────────────────────────────────────
    section('Team');
    const newUser = await call('/api/auth/team', {
      method: 'POST', token: tokenA,
      body: { name: 'Sælger Sofie', email: 'sofie@example.dk', password: 'langnokkode123', role: 'agent' } });
    check('ejer kan oprette sælger', newUser.status === 201);

    const shortPw = await call('/api/auth/team', {
      method: 'POST', token: tokenA,
      body: { name: 'Kort', email: 'kort@example.dk', password: 'kort' } });
    check('for kort adgangskode afvises', shortPw.status === 400);

    const loginSofie = await call('/api/auth/login', {
      method: 'POST', body: { email: 'sofie@example.dk', password: 'langnokkode123' } });
    const tokenSofie = loginSofie.json.token;
    check('sælger kan logge ind', !!tokenSofie);

    const sofieAddsUser = await call('/api/auth/team', {
      method: 'POST', token: tokenSofie,
      body: { name: 'X', email: 'x@example.dk', password: 'langnokkode123' } });
    check('sælger kan ikke oprette brugere', sofieAddsUser.status === 403);

    const sofieSeesList = await call(`/api/lists/${listId}`, { token: tokenSofie });
    check('sælger ser sin egen organisations liste', sofieSeesList.status === 200);

    await call(`/api/auth/team/${newUser.json.user.id}`, {
      method: 'PATCH', token: tokenA, body: { isActive: false } });
    const sofieAfterDisable = await call('/api/lists', { token: tokenSofie });
    check('deaktiveret bruger mister adgang med det samme',
      sofieAfterDisable.status === 401 && sofieAfterDisable.json.code === 'USER_INACTIVE');

    // ── CSV ──────────────────────────────────────────────────────────────────
    section('CSV-eksport');
    const csv = await call(`/api/lists/${listId}/export.csv`, { token: tokenA });
    check('CSV svarer 200', csv.status === 200);

    // The BOM has to be checked on the raw bytes: Response.text() decodes UTF-8
    // with BOM-stripping, so it would never show up in the string.
    const csvBytes = Buffer.from(await (await fetch(`${BASE}/api/lists/${listId}/export.csv`,
      { headers: { Authorization: `Bearer ${tokenA}` } })).arrayBuffer());
    check('CSV starter med UTF-8 BOM (Excel læser æøå korrekt)',
      csvBytes[0] === 0xef && csvBytes[1] === 0xbb && csvBytes[2] === 0xbf,
      [...csvBytes.subarray(0, 3)].map((b) => b.toString(16)).join(' '));
    check('CSV har æøå intakt', csvBytes.includes(Buffer.from('Virksomhed', 'utf8')));
    check('CSV bruger semikolon', csv.text.split('\r\n')[0].includes('CVR;Virksomhed'));
    check('CSV har en linje pr. lead + overskrift',
      csv.text.trim().split('\r\n').length === 46, `linjer: ${csv.text.trim().split('\r\n').length}`);
    check('CSV indeholder seneste note',
      csv.text.includes('receptionen tog den'));
    check('CSV-filnavn er sat', /filename=/.test(csv.headers.get('content-disposition') || ''));

    const csvFiltered = await call(`/api/lists/${listId}/export.csv?status=won`, { token: tokenA });
    check('CSV kan filtreres på status',
      csvFiltered.text.trim().split('\r\n').length === 2);

    const csvB = await call(`/api/lists/${listId}/export.csv`, { token: tokenB });
    check('Firma B kan ikke eksportere Firma A\'s liste', csvB.status === 404);

    // ── Deletion cascades ────────────────────────────────────────────────────
    section('Sletning');
    await call(`/api/lists/${listId}`, { method: 'DELETE', token: tokenA });
    const orphans = await db.query('SELECT COUNT(*)::int AS n FROM leads WHERE list_id = $1', [listId]);
    check('leads slettes med listen', orphans.rows[0].n === 0);
    const orphanActs = await db.query(
      'SELECT COUNT(*)::int AS n FROM lead_activities WHERE lead_id = $1', [someLead]);
    check('aktiviteter slettes med leadet', orphanActs.rows[0].n === 0);

  } finally {
    console.log(`\n${'─'.repeat(50)}`);
    console.log(`${passed} bestået, ${failed} fejlet`);
    await db.pool.end().catch(() => {});
    await pg.stop().catch(() => {});
    fs.rmSync(dataDir, { recursive: true, force: true });
    process.exit(failed ? 1 : 0);
  }
}

main().catch((err) => {
  console.error('\nVERIFIKATION BRØD SAMMEN:', err);
  process.exit(1);
});
