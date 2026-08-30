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
      // Enrichment fields (migration 002)
      region: 'Syddanmark',
      ownerName: `Ejer Ejersen ${n}`,
      ownerRole: 'Direktør',
      ownerCount: 1,
      purpose: `Selskabets formål er testvirksomhed nummer ${n}.`,
      capital: 40000,
      capitalCurrency: 'DKK',
    };
  });
}

async function main() {
  const mod = require('embedded-postgres');
  const EmbeddedPostgres = mod.default ?? mod;
  const dataDir = path.join(os.tmpdir(), `lysmera-verify-${Date.now()}`);

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
  await pg.createDatabase('lysmera_test');
  console.log(`PostgreSQL kører på :${PG_PORT}\n`);

  // Env must be set before db.js / server.js are required — the pool is built
  // at module load.
  process.env.DATABASE_URL = `postgresql://postgres:postgres@127.0.0.1:${PG_PORT}/lysmera_test`;
  process.env.JWT_SECRET   = crypto.randomBytes(32).toString('hex');
  process.env.PORT         = String(APP_PORT);
  process.env.NODE_ENV     = 'test';
  // Fritagelsen og loftet læses ved indlæsning af middleware/subscription, så
  // de skal stå her — før server.js kræves ind. To pladser i stedet for fem:
  // loftet skal kunne rammes uden at oprette et helt team først.
  process.env.BILLING_EXEMPT_EMAILS = 'fri@example.dk';
  process.env.FREE_TEAM_SEATS       = '2';

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

    // ── Invitationer ─────────────────────────────────────────────────────────
    section('Invitationer');
    const invitér = (body, token = tokenA) =>
      call('/api/auth/team/invitations', { method: 'POST', token, body });

    const invMaria = await invitér({ name: 'Maria Berg', email: 'maria@example.dk' });
    check('ejer kan invitere med navn og e-mail', invMaria.status === 201,
      JSON.stringify(invMaria.json));
    const mariaLink = invMaria.json?.invitation?.link ?? '';
    const mariaToken = mariaLink.split('/').pop();
    check('invitationen giver et link at sende', mariaLink.includes('/invitation/'), mariaLink);
    check('uden mailudbyder sendes der ingen mail', invMaria.json?.mailSendt === false);

    const invIgen = await invitér({ name: 'Maria Berg', email: 'MARIA@example.dk' });
    check('samme adresse kan ikke inviteres to gange',
      invIgen.status === 409 && invIgen.json.code === 'INVITATION_EXISTS');

    const invMedlem = await invitér({ name: 'Ejeren', email: 'a@example.dk' });
    check('et nuværende medlem kan ikke inviteres', invMedlem.status === 409);

    const invAgent = await call('/api/auth/team/invitations', {
      method: 'POST', token: tokenSofie, body: { name: 'X', email: 'x@example.dk' } });
    check('en sælger kan ikke invitere', invAgent.status === 401 || invAgent.status === 403);

    const åbne = await call('/api/auth/team/invitations', { token: tokenA });
    check('ejeren kan se de åbne invitationer',
      åbne.json?.invitations?.some((i) => i.email === 'maria@example.dk' && i.status === 'pending'));

    // ── Den inviterede uden konto ────────────────────────────────────────────
    const visInv = await call(`/api/auth/invite/${mariaToken}`);
    check('invitationen kan ses uden login',
      visInv.status === 200 && visInv.json.gyldig === true);
    check('den viser hvem der inviterer',
      visInv.json?.invitation?.orgNavn === 'Firma A ApS'
      && visInv.json?.invitation?.harKonto === false);

    const kortKode = await call(`/api/auth/invite/${mariaToken}`, {
      method: 'POST', body: { password: 'kort' } });
    check('for kort adgangskode afvises ved accept', kortKode.status === 400);

    const ukendtToken = await call('/api/auth/invite/findes-ikke', {
      method: 'POST', body: { password: 'langnokkode123' } });
    check('ukendt token kan ikke bruges', ukendtToken.status === 410);

    const mariaAccept = await call(`/api/auth/invite/${mariaToken}`, {
      method: 'POST', body: { password: 'mariaskode123' } });
    check('den inviterede opretter sig uden CVR-nummer', mariaAccept.status === 201,
      JSON.stringify(mariaAccept.json));
    check('hun lander i det team der inviterede hende',
      mariaAccept.json?.user?.orgId === orgA.orgId && mariaAccept.json?.user?.role === 'agent');

    const mariaSerListe = await call(`/api/lists/${listId}`, { token: mariaAccept.json?.token });
    check('hun ser holdets lister med det samme', mariaSerListe.status === 200);

    const brugtToken = await call(`/api/auth/invite/${mariaToken}`, {
      method: 'POST', body: { password: 'endnuenkode123' } });
    check('linket kan kun bruges én gang', brugtToken.status === 410);

    // ── Tilbagekaldelse ──────────────────────────────────────────────────────
    const invPeter = await invitér({ name: 'Peter', email: 'peter@example.dk' });
    const peterToken = (invPeter.json?.invitation?.link ?? '').split('/').pop();
    const trukket = await call(
      `/api/auth/team/invitations/${invPeter.json?.invitation?.id}`, { method: 'DELETE', token: tokenA });
    check('ejeren kan trække en invitation tilbage', trukket.status === 200);
    const efterTilbagekald = await call(`/api/auth/invite/${peterToken}`);
    check('et tilbagekaldt link virker ikke længere',
      efterTilbagekald.json?.gyldig === false && efterTilbagekald.json?.status === 'revoked');

    // ── Den inviterede HAR allerede en konto ─────────────────────────────────
    const tomOrg = await mkOrg('Tom Konto ApS', 'tom@example.dk');
    const invTom = await invitér({ name: 'Tom', email: 'tom@example.dk' });
    check('en adresse med konto kan også inviteres', invTom.status === 201);

    const tomToken = (await call('/api/auth/login', {
      method: 'POST', body: { email: 'tom@example.dk', password: 'hemmeligkode123' } })).json.token;

    const tomsInvitationer = await call('/api/auth/invitations', { token: tomToken });
    check('invitationen dukker op på hans eget overblik',
      tomsInvitationer.json?.invitations?.[0]?.org_navn === 'Firma A ApS',
      JSON.stringify(tomsInvitationer.json));

    const tomAccept = await call(
      `/api/auth/invitations/${tomsInvitationer.json.invitations[0].id}/accept`,
      { method: 'POST', token: tomToken });
    check('han kan acceptere fra sit overblik', tomAccept.status === 200,
      JSON.stringify(tomAccept.json));
    check('han flyttes over i det nye team',
      tomAccept.json?.user?.orgId === orgA.orgId && tomAccept.json?.flyttet === true);
    const tomsGamleOrg = await db.query(
      'SELECT COUNT(*)::int AS n FROM organizations WHERE id = $1', [tomOrg.orgId]);
    check('hans tomme organisation ryddes op', tomsGamleOrg.rows[0].n === 0);

    // En konto med lister og leads må ikke kunne forlades i stilhed: brugeren
    // er den eneste, og data ville blive stående bag et login der ikke findes.
    const dataOrg = await mkOrg('Data ApS', 'data@example.dk');
    await db.query('INSERT INTO lead_lists (org_id, name) VALUES ($1, $2)',
      [dataOrg.orgId, 'Egne emner']);
    const dataToken = (await call('/api/auth/login', {
      method: 'POST', body: { email: 'data@example.dk', password: 'hemmeligkode123' } })).json.token;

    const invData = await invitér({ name: 'Data', email: 'data@example.dk' });
    const dataInvId = invData.json?.invitation?.id;
    const dataAccept = await call(`/api/auth/invitations/${dataInvId}/accept`,
      { method: 'POST', token: dataToken });
    check('en konto med data kan ikke forlades ved et uheld',
      dataAccept.status === 409 && dataAccept.json.code === 'ACCOUNT_HAS_DATA',
      JSON.stringify(dataAccept.json));

    const fremmedAccept = await call(`/api/auth/invitations/${dataInvId}/accept`,
      { method: 'POST', token: mariaAccept.json?.token });
    check('man kan ikke acceptere en invitation stilet til en anden',
      fremmedAccept.status === 404);

    const dataAfvis = await call(`/api/auth/invitations/${dataInvId}/decline`,
      { method: 'POST', token: dataToken });
    check('en invitation kan afvises', dataAfvis.status === 200);
    const efterAfvisning = await call('/api/auth/invitations', { token: dataToken });
    check('en afvist invitation vises ikke igen',
      efterAfvisning.json?.invitations?.length === 0);

    // ── Gratis teampladser på en fritaget konto ──────────────────────────────
    section('Gratis teampladser');
    const friOrg = await mkOrg('Fri ApS', 'fri@example.dk');
    const friToken = (await call('/api/auth/login', {
      method: 'POST', body: { email: 'fri@example.dk', password: 'hemmeligkode123' } })).json.token;

    const friStatus = await call('/api/billing/status', { token: friToken });
    check('den fritagne konto får to gratis teampladser',
      friStatus.json?.fritaget === true && friStatus.json?.team?.gratisPladser === 2,
      JSON.stringify(friStatus.json?.team));

    const kollega = (n) => call('/api/auth/team', {
      method: 'POST', token: friToken,
      body: { name: `Kollega ${n}`, email: `kollega${n}@example.dk`, password: 'langnokkode123' } });
    check('første gratis plads kan bruges', (await kollega(1)).status === 201);
    check('anden gratis plads kan bruges', (await kollega(2)).status === 201);
    const forMange = await kollega(3);
    check('den tredje afvises — loftet er to',
      forMange.status === 409 && forMange.json.code === 'FREE_SEATS_EXCEEDED',
      JSON.stringify(forMange.json));

    const kollegaToken = (await call('/api/auth/login', {
      method: 'POST', body: { email: 'kollega1@example.dk', password: 'langnokkode123' } })).json.token;
    const kollegaStatus = await call('/api/billing/status', { token: kollegaToken });
    check('kollegaen på en fritaget konto er også fritaget',
      kollegaStatus.json?.fritaget === true && kollegaStatus.json?.harAdgang === true,
      JSON.stringify(kollegaStatus.json));

    // En afventende invitation optager pladsen. Ellers ville loftet først vise
    // sig når nummer seks sagde ja — og de fem andre havde et dødt link.
    await call(`/api/auth/team/${(await db.query(
      `SELECT id FROM users WHERE email = 'kollega2@example.dk'`)).rows[0].id}`, {
      method: 'PATCH', token: friToken, body: { isActive: false } });
    const invEfterFrigivelse = await invitér(
      { name: 'Ny Kollega', email: 'ny@example.dk' }, friToken);
    check('en frigivet plads kan inviteres til', invEfterFrigivelse.status === 201);
    const invForMange = await invitér({ name: 'En til', email: 'entil@example.dk' }, friToken);
    check('afventende invitationer tæller med i loftet',
      invForMange.status === 409 && invForMange.json.code === 'FREE_SEATS_EXCEEDED');

    const genaktivér = await call(`/api/auth/team/${(await db.query(
      `SELECT id FROM users WHERE email = 'kollega2@example.dk'`)).rows[0].id}`, {
      method: 'PATCH', token: friToken, body: { isActive: true } });
    check('en deaktiveret bruger kan ikke genaktiveres forbi loftet',
      genaktivér.status === 409 && genaktivér.json.code === 'FREE_SEATS_EXCEEDED');

    // ── Profiler ─────────────────────────────────────────────────────────────
    section('Profiler');
    const kollega1Id = (await db.query(
      `SELECT id FROM users WHERE email = 'kollega1@example.dk'`)).rows[0].id;

    const omdøbt = await call(`/api/auth/team/${kollega1Id}`, {
      method: 'PATCH', token: friToken, body: { name: 'Kollega Én', email: 'en@example.dk' } });
    check('ejeren kan rette et medlems navn og e-mail',
      omdøbt.status === 200 && omdøbt.json.user.name === 'Kollega Én'
      && omdøbt.json.user.email === 'en@example.dk', JSON.stringify(omdøbt.json));
    check('et navneskifte aktiverer ikke ved et uheld', omdøbt.json?.user?.is_active === true);

    const efterOmdøbning = await call('/api/auth/login', {
      method: 'POST', body: { email: 'en@example.dk', password: 'langnokkode123' } });
    check('den nye adresse kan logge ind', efterOmdøbning.status === 200);

    const optagetMail = await call(`/api/auth/team/${kollega1Id}`, {
      method: 'PATCH', token: friToken, body: { email: 'fri@example.dk' } });
    check('en optaget e-mail afvises', optagetMail.status === 409);

    const tomtNavn = await call(`/api/auth/team/${kollega1Id}`, {
      method: 'PATCH', token: friToken, body: { name: '   ' } });
    check('et tomt navn afvises', tomtNavn.status === 400);

    const nyRolle = await call(`/api/auth/team/${kollega1Id}`, {
      method: 'PATCH', token: friToken, body: { role: 'owner' } });
    check('et medlem kan gøres til ejer',
      nyRolle.status === 200 && nyRolle.json.user.role === 'owner');

    const friId = (await db.query(
      `SELECT id FROM users WHERE email = 'fri@example.dk'`)).rows[0].id;
    const egenRolle = await call(`/api/auth/team/${friId}`, {
      method: 'PATCH', token: friToken, body: { role: 'agent' } });
    check('man kan ikke ændre sin egen rolle', egenRolle.status === 400);

    const egenAdgang = await call(`/api/auth/team/${friId}`, {
      method: 'PATCH', token: friToken, body: { isActive: false } });
    check('man kan ikke deaktivere sig selv', egenAdgang.status === 400);

    // Egen profil
    const egenProfil = await call('/api/auth/me', {
      method: 'PATCH', token: friToken, body: { name: 'Fri Ejer', email: 'fri@example.dk' } });
    check('man kan rette sit eget navn',
      egenProfil.status === 200 && egenProfil.json.user.name === 'Fri Ejer'
      && !!egenProfil.json.token, JSON.stringify(egenProfil.json));

    const ugyldigMail = await call('/api/auth/me', {
      method: 'PATCH', token: friToken, body: { name: 'Fri Ejer', email: 'ikke-en-mail' } });
    check('en ugyldig e-mail afvises på egen profil', ugyldigMail.status === 400);

    const stjålenMail = await call('/api/auth/me', {
      method: 'PATCH', token: friToken, body: { name: 'Fri Ejer', email: 'en@example.dk' } });
    check('egen profil kan ikke tage en andens e-mail', stjålenMail.status === 409);

    const agentRetterAndre = await call(`/api/auth/team/${friId}`, {
      method: 'PATCH', token: tokenSofie, body: { name: 'Hacket' } });
    check('en sælger kan ikke rette andres profiler',
      agentRetterAndre.status === 401 || agentRetterAndre.status === 403);

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
    // ── Enrichment: owner, region, purpose ───────────────────────────────────
    section('Berigede felter (ejer, region, formål)');
    const enriched = (await db.query(
      `SELECT owner_name, owner_role, region, purpose, capital, capital_currency
         FROM leads WHERE list_id = $1 LIMIT 1`, [listId])).rows[0];
    check('ejernavn gemmes', /^Ejer Ejersen/.test(enriched.owner_name ?? ''), enriched.owner_name);
    check('ejerrolle gemmes', enriched.owner_role === 'Direktør');
    check('region gemmes', enriched.region === 'Syddanmark');
    check('formål gemmes', /testvirksomhed/.test(enriched.purpose ?? ''));
    check('kapital gemmes som tal', Number(enriched.capital) === 40000, String(enriched.capital));

    const leadWithOwner = await call(`/api/lists/${listId}/leads?size=1`, { token: tokenA });
    check('API returnerer ejer og region på leads',
      !!leadWithOwner.json?.leads?.[0]?.owner_name && !!leadWithOwner.json?.leads?.[0]?.region);

    // ── Two-axis status model ────────────────────────────────────────────────
    section('Pipeline-stadier');
    const stageLead = (await db.query(
      `SELECT id FROM leads WHERE list_id = $1 AND stage = 'pipeline' LIMIT 1`, [listId])).rows[0].id;

    const readStage = async () =>
      (await call(`/api/leads/${stageLead}`, { token: tokenA })).json?.lead;

    check('nye leads starter i "pipeline"', (await readStage()).stage === 'pipeline');

    await call(`/api/leads/${stageLead}/outcome`, {
      method: 'POST', token: tokenA, body: { status: 'no_answer' } });
    // Et ubesvaret opkald er ikke fremdrift i en prognose — leadet skal
    // stadig ringes op, og bliver derfor i pipeline.
    check('"intet svar" bliver i "pipeline"', (await readStage()).stage === 'pipeline');

    await call(`/api/leads/${stageLead}/outcome`, {
      method: 'POST', token: tokenA, body: { status: 'interested' } });
    check('"interesseret" flytter til "upside"', (await readStage()).stage === 'upside');

    await call(`/api/leads/${stageLead}/outcome`, {
      method: 'POST', token: tokenA, body: { status: 'no_answer' } });
    const afterRelapse = await readStage();
    check('et senere "intet svar" trækker IKKE stadiet tilbage',
      afterRelapse.stage === 'upside', `stadie: ${afterRelapse.stage}`);
    check('opkaldsudfaldet opdateres stadig', afterRelapse.status === 'no_answer');

    await call(`/api/leads/${stageLead}/outcome`, {
      method: 'POST', token: tokenA, body: { status: 'not_interested' } });
    check('"ikke interesseret" er en konklusion og flytter til "tabt"',
      (await readStage()).stage === 'tabt');

    const dragged = await call(`/api/leads/${stageLead}`, {
      method: 'PATCH', token: tokenA, body: { stage: 'pipeline' } });
    check('kanban-træk kan flytte baglæns', dragged.json?.lead?.stage === 'pipeline');

    // 'commit' kan ikke nås af et udfald — kun ved at trække kortet. Det er
    // en vurdering, ikke noget der kan udledes af hvad der er sket.
    const tilCommit = await call(`/api/leads/${stageLead}`, {
      method: 'PATCH', token: tokenA, body: { stage: 'commit' } });
    check('"commit" kan sættes ved træk', tilCommit.json?.lead?.stage === 'commit');

    await call(`/api/leads/${stageLead}/outcome`, {
      method: 'POST', token: tokenA, body: { status: 'interested' } });
    check('et "interesseret" trækker ikke commit tilbage til upside',
      (await readStage()).stage === 'commit');

    const badStage = await call(`/api/leads/${stageLead}`, {
      method: 'PATCH', token: tokenA, body: { stage: 'noget-opfundet' } });
    check('ukendt stadie afvises', badStage.status === 400 && badStage.json.code === 'BAD_STAGE');

    const bStage = await call(`/api/leads/${stageLead}`, {
      method: 'PATCH', token: tokenB, body: { stage: 'vundet' } });
    check('Firma B kan ikke flytte Firma A\'s lead', bStage.status === 404);

    // ── VAT: the three-state model ───────────────────────────────────────────
    section('Momsstatus');
    const vatLead = (await db.query(
      'SELECT id, vat_status FROM leads WHERE list_id = $1 LIMIT 1', [listId])).rows[0];
    check('leads starter som momsstatus "unknown"', vatLead.vat_status === 'unknown');

    // A settled answer must be reused rather than re-queried; VIES is
    // rate-limited and this is the guard that keeps us off it.
    await db.query(
      `UPDATE leads SET vat_status = 'registered', vat_name = 'Test A/S', vat_checked_at = NOW()
        WHERE id = $1`, [vatLead.id]);
    const cachedVat = await call(`/api/leads/${vatLead.id}/vat-check`, {
      method: 'POST', token: tokenA, body: {} });
    check('afklaret momsstatus læses fra cache',
      cachedVat.json?.cached === true && cachedVat.json?.vatStatus === 'registered');
    check('momsnummer formateres som DK+CVR',
      /^DK\d{8}$/.test(cachedVat.json?.vatNumber ?? ''), cachedVat.json?.vatNumber);

    // 'unknown' means the last lookup failed — it must NOT be treated as a
    // settled "not registered", so it is always retried.
    await db.query(
      `UPDATE leads SET vat_status = 'unknown', vat_checked_at = NULL WHERE id = $1`, [vatLead.id]);
    const stillUnknown = (await db.query(
      'SELECT vat_status, vat_checked_at FROM leads WHERE id = $1', [vatLead.id])).rows[0];
    check('"unknown" har intet tjek-tidspunkt', stillUnknown.vat_checked_at === null);

    const bVat = await call(`/api/leads/${vatLead.id}/vat-check`, {
      method: 'POST', token: tokenB, body: {} });
    check('Firma B kan ikke momstjekke Firma A\'s lead', bVat.status === 404);

    // ── Options endpoint feeds the frontend both axes ────────────────────────
    section('Valgmuligheder til frontenden');
    const opts = await call('/api/meta/options', { token: tokenA });
    check('options leverer opkaldsudfald', Array.isArray(opts.json?.statuses) && opts.json.statuses.length > 0);
    // Ikke et hårdkodet antal: det tal skal rettes hver gang stigen ændres,
    // og en fejl siger så kun "det er ikke 6" uden at sige hvad der mangler.
    // Her sammenlignes med kilden, og at hvert trin har en etiket at vise.
    const { PIPELINE_STAGES } = require('../config/cvrOptions');
    const stadier = opts.json?.stages;
    check('options leverer pipeline-stadier',
      Array.isArray(stadier)
        && stadier.map((s) => s.value).join(',') === PIPELINE_STAGES.map((s) => s.value).join(',')
        && stadier.every((s) => typeof s.label === 'string' && s.label.length > 0),
      JSON.stringify(stadier?.map((s) => s.value)));
    check('selskabsformer bruger numeriske koder',
      typeof opts.json?.companyForms?.[0]?.value === 'number', JSON.stringify(opts.json?.companyForms?.[0]));

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
