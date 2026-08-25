// routes/lists.js — lead lists: create from a CVR extraction, browse, refresh,
// export. A list is a saved search plus the companies it pulled in.
'use strict';

const express = require('express');
const db      = require('../db');
const cvr     = require('../services/cvrService');
const { sanitizeFilters, isEmptyFilter } = require('../services/filterSchema');
const { authenticate } = require('../middleware/auth');
const { handleCvrError } = require('./search');
const { STATUS_VALUES } = require('../config/cvrOptions');
const { toCsv } = require('../services/csv');

const router = express.Router();

const MAX_EXTRACT = 10000;

/**
 * Column ↔ value mapping for a lead row, in one place. The INSERT's column
 * list, its placeholders and the values are all derived from this, so adding
 * a field means editing one line instead of three lists that must stay in
 * lockstep.
 */
const LEAD_INSERT_COLUMNS = [
  ['org_id',             (c, ctx) => ctx.orgId],
  ['list_id',            (c, ctx) => ctx.listId],
  ['cvr',                (c) => c.cvr],
  ['name',               (c) => c.name ?? '(uden navn)'],
  ['address',            (c) => c.address],
  ['zipcode',            (c) => c.zipcode],
  ['city',               (c) => c.city],
  ['municipality',       (c) => c.municipality],
  ['region',             (c) => c.region],
  ['phone',              (c) => c.phone],
  ['email',              (c) => c.email],
  ['website',            (c) => c.website],
  ['industry_code',      (c) => c.industryCode],
  ['industry_text',      (c) => c.industryText],
  ['company_type',       (c) => c.companyType],
  ['employees',          (c) => c.employees],
  ['employees_interval', (c) => c.employeesInterval],
  ['established_on',     (c) => c.establishedOn || null],
  ['owner_name',         (c) => c.ownerName],
  ['owner_role',         (c) => c.ownerRole],
  ['owner_count',        (c) => c.ownerCount],
  ['purpose',            (c) => c.purpose],
  ['capital',            (c) => c.capital],
  ['capital_currency',   (c) => c.capitalCurrency],
];

/**
 * Insert a batch of normalised companies into a list.
 * ON CONFLICT DO NOTHING means re-running a search tops the list up instead of
 * duplicating rows or resetting the call statuses already recorded.
 */
/**
 * Hvilke af disse CVR-numre har organisationen allerede som lead — i en
 * hvilken som helst liste?
 *
 * Slås op i databasen frem for at hente alle organisationens numre hjem: en
 * konto kan have hundredtusinder, og vi skal kun bruge svaret for de højst
 * nogle hundrede der er på vej ind.
 */
async function alleredeGemte(kilde, orgId, cvrNumre) {
  const numre = [...new Set(cvrNumre.filter(Boolean).map(String))];
  if (!numre.length) return new Set();
  const { rows } = await kilde.query(
    'SELECT DISTINCT cvr FROM leads WHERE org_id = $1 AND cvr = ANY($2::text[])',
    [orgId, numre]
  );
  return new Set(rows.map((r) => r.cvr));
}

async function insertLeads(client, { orgId, listId, companies }) {
  // Advertising-protected companies are excluded in the CVR query already;
  // this is the second gate so a provider change can't leak them into a list.
  const rows = companies.filter((c) => c.cvr && !c.advertisingProtected);
  if (!rows.length) return 0;

  const width = LEAD_INSERT_COLUMNS.length;
  const values = [];
  const placeholders = rows.map((company, i) => {
    const base = i * width;
    for (const [, read] of LEAD_INSERT_COLUMNS) values.push(read(company, { orgId, listId }));
    return `(${Array.from({ length: width }, (_, j) => `$${base + j + 1}`).join(', ')})`;
  });

  const { rowCount } = await client.query(
    `INSERT INTO leads (${LEAD_INSERT_COLUMNS.map(([col]) => col).join(', ')})
     VALUES ${placeholders.join(', ')}
     ON CONFLICT (list_id, cvr) DO NOTHING`,
    values
  );
  return rowCount;
}

// ── GET /api/lists ───────────────────────────────────────────────────────────
router.get('/lists', authenticate, async (req, res) => {
  try {
    const { rows } = await db.query(
      `SELECT l.id, l.name, l.description, l.filters, l.created_at, l.archived_at,
              u.name AS created_by_name,
              COUNT(ld.id)                                              AS lead_count,
              COUNT(ld.id) FILTER (WHERE ld.status = 'new')             AS new_count,
              COUNT(ld.id) FILTER (WHERE ld.call_count > 0)             AS called_count,
              COUNT(ld.id) FILTER (WHERE ld.status IN ('interested','meeting_booked','won')) AS positive_count
         FROM lead_lists l
         LEFT JOIN users u  ON u.id  = l.created_by
         LEFT JOIN leads ld ON ld.list_id = l.id
        WHERE l.org_id = $1 AND l.archived_at IS NULL
        GROUP BY l.id, u.name
        ORDER BY l.created_at DESC`,
      [req.orgId]
    );
    return res.json({ lists: rows });
  } catch (err) {
    console.error('[lists:index]', err.message);
    return res.status(500).json({ error: 'Kunne ikke hente listerne.' });
  }
});

// ── POST /api/lists — run the extraction and save it ─────────────────────────
router.post('/lists', authenticate, async (req, res) => {
  const name = String(req.body?.name ?? '').trim();
  if (!name) return res.status(400).json({ error: 'Giv listen et navn.' });

  // En tom liste at samle enkelte virksomheder i. Filterkravet nedenfor er
  // der for at ingen kan trække hele registret ud ved et uheld — det gælder
  // ikke her, hvor der ikke hentes noget overhovedet.
  if (req.body?.empty === true) {
    try {
      const { rows } = await db.query(
        `INSERT INTO lead_lists (org_id, name, description, filters, created_by)
         VALUES ($1, $2, $3, '{}'::jsonb, $4)
         RETURNING id, name, description, filters, created_at`,
        [req.orgId, name, String(req.body?.description ?? '').trim() || null, req.user.id]
      );
      return res.status(201).json({ list: rows[0], imported: 0, matched: 0, fetched: 0 });
    } catch (err) {
      console.error('[lists:create:empty]', err.message);
      return res.status(500).json({ error: 'Kunne ikke oprette listen.' });
    }
  }

  const filters = sanitizeFilters(req.body?.filters ?? {});
  if (isEmptyFilter(filters)) {
    return res.status(400).json({
      error: 'Vælg mindst ét filter — branche, område, størrelse eller søgeord.',
      code: 'FILTER_TOO_BROAD',
    });
  }

  const limit = Math.min(Math.max(Number(req.body?.limit) || 1000, 1), MAX_EXTRACT);

  try {
    // Create the list first so each scroll batch can be written straight in
    // rather than buffering the whole extraction in memory.
    const { rows } = await db.query(
      `INSERT INTO lead_lists (org_id, name, description, filters, created_by)
       VALUES ($1, $2, $3, $4, $5) RETURNING id, name, description, filters, created_at`,
      [req.orgId, name, String(req.body?.description ?? '').trim() || null,
       JSON.stringify(filters), req.user.id]
    );
    const list = rows[0];

    let inserted = 0;
    let skippedProtected = 0;
    let skippedExisting = 0;
    try {
      const { total, fetched } = await cvr.extractCompanies({
        filters,
        limit,
        onBatch: async (batch) => {
          skippedProtected += batch.filter((c) => c.advertisingProtected).length;
          const client = await db.getClient();
          try {
            let hold = batch;
            // ON CONFLICT fanger kun dubletter i SAMME liste. Vil man ikke se
            // dem man allerede har talt med, skal der kigges på tværs af alle
            // organisationens lister — og det er dét der er værdien: et udtræk
            // på tusind virksomheder man halvdelen af i forvejen har ringet
            // til, er femhundrede spildte opkald.
            if (filters.excludeExisting) {
              const kendte = await alleredeGemte(client, req.orgId, batch.map((c) => c.cvr));
              if (kendte.size) {
                hold = batch.filter((c) => !kendte.has(String(c.cvr)));
                skippedExisting += batch.length - hold.length;
              }
            }
            inserted += await insertLeads(client, { orgId: req.orgId, listId: list.id, companies: hold });
          } finally {
            client.release();
          }
        },
      });

      return res.status(201).json({
        list,
        imported: inserted,
        matched: total,
        fetched,
        truncated: total > fetched,
        skippedAdvertisingProtected: skippedProtected,
        skippedExisting,
      });
    } catch (err) {
      // The extraction failed — don't leave an empty list behind for the user
      // to wonder about.
      await db.query('DELETE FROM lead_lists WHERE id = $1 AND org_id = $2', [list.id, req.orgId])
        .catch(() => {});
      throw err;
    }
  } catch (err) {
    return handleCvrError(err, res, 'lists:create');
  }
});

// ── POST /api/lists/:id/refresh — re-run the saved filter, add new companies ─
router.post('/lists/:id/refresh', authenticate, async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'Ugyldigt liste-id.' });

  try {
    const { rows } = await db.query(
      'SELECT id, filters FROM lead_lists WHERE id = $1 AND org_id = $2', [id, req.orgId]
    );
    if (!rows.length) return res.status(404).json({ error: 'Listen blev ikke fundet.' });

    const filters = sanitizeFilters(rows[0].filters ?? {});
    const limit = Math.min(Math.max(Number(req.body?.limit) || 1000, 1), MAX_EXTRACT);

    let inserted = 0;
    const { total, fetched } = await cvr.extractCompanies({
      filters,
      limit,
      onBatch: async (batch) => {
        const client = await db.getClient();
        try {
          inserted += await insertLeads(client, { orgId: req.orgId, listId: id, companies: batch });
        } finally {
          client.release();
        }
      },
    });

    return res.json({ added: inserted, matched: total, fetched });
  } catch (err) {
    return handleCvrError(err, res, 'lists:refresh');
  }
});

// ── GET /api/lists/:id — list with status breakdown ──────────────────────────
router.get('/lists/:id', authenticate, async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'Ugyldigt liste-id.' });

  try {
    const { rows } = await db.query(
      'SELECT id, name, description, filters, created_at FROM lead_lists WHERE id = $1 AND org_id = $2',
      [id, req.orgId]
    );
    if (!rows.length) return res.status(404).json({ error: 'Listen blev ikke fundet.' });

    const stats = await db.query(
      `SELECT status, COUNT(*)::int AS count FROM leads
        WHERE list_id = $1 AND org_id = $2 GROUP BY status`,
      [id, req.orgId]
    );

    const byStatus = Object.fromEntries(stats.rows.map((r) => [r.status, r.count]));
    const total = stats.rows.reduce((sum, r) => sum + r.count, 0);

    return res.json({ list: rows[0], total, byStatus });
  } catch (err) {
    console.error('[lists:show]', err.message);
    return res.status(500).json({ error: 'Kunne ikke hente listen.' });
  }
});

// ── PATCH /api/lists/:id — rename / archive ──────────────────────────────────
router.patch('/lists/:id', authenticate, async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'Ugyldigt liste-id.' });

  const sets = [];
  const params = [];
  if (req.body?.name !== undefined) {
    const name = String(req.body.name).trim();
    if (!name) return res.status(400).json({ error: 'Navnet må ikke være tomt.' });
    params.push(name); sets.push(`name = $${params.length}`);
  }
  if (req.body?.description !== undefined) {
    params.push(String(req.body.description).trim() || null);
    sets.push(`description = $${params.length}`);
  }
  if (req.body?.archived !== undefined) {
    sets.push(`archived_at = ${req.body.archived ? 'NOW()' : 'NULL'}`);
  }
  if (!sets.length) return res.status(400).json({ error: 'Ingen ændringer angivet.' });

  params.push(id, req.orgId);
  try {
    const { rows } = await db.query(
      `UPDATE lead_lists SET ${sets.join(', ')}
        WHERE id = $${params.length - 1} AND org_id = $${params.length}
        RETURNING id, name, description, archived_at`,
      params
    );
    if (!rows.length) return res.status(404).json({ error: 'Listen blev ikke fundet.' });
    return res.json({ list: rows[0] });
  } catch (err) {
    console.error('[lists:patch]', err.message);
    return res.status(500).json({ error: 'Kunne ikke opdatere listen.' });
  }
});

// ── DELETE /api/lists/:id ────────────────────────────────────────────────────
router.delete('/lists/:id', authenticate, async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'Ugyldigt liste-id.' });
  try {
    const { rowCount } = await db.query(
      'DELETE FROM lead_lists WHERE id = $1 AND org_id = $2', [id, req.orgId]
    );
    if (!rowCount) return res.status(404).json({ error: 'Listen blev ikke fundet.' });
    return res.json({ ok: true });
  } catch (err) {
    console.error('[lists:delete]', err.message);
    return res.status(500).json({ error: 'Kunne ikke slette listen.' });
  }
});

// ── DELETE /api/lists/:id/leads — fjern udvalgte virksomheder ────────────────
// Body: { ids: [1,2,3] }  eller  { filter: { missingEmail: true, status: … } }
//
// To måder at pege på det samme, fordi de bruges forskelligt: `ids` når man har
// hakket nogle stykker af, og `filter` når man vil af med alle uden mail — dér
// kan der være tusinder, og de ligger ikke nødvendigvis på den side man kigger
// på.
router.delete('/lists/:id/leads', authenticate, async (req, res) => {
  const listId = Number(req.params.id);
  if (!Number.isInteger(listId)) return res.status(400).json({ error: 'Ugyldigt liste-id.' });

  const ids = Array.isArray(req.body?.ids)
    ? req.body.ids.map(Number).filter(Number.isInteger).slice(0, 5000)
    : null;
  const filter = req.body?.filter ?? null;

  if (!ids?.length && !filter) {
    return res.status(400).json({ error: 'Vælg hvad der skal slettes.' });
  }

  // org_id står i hver enkelt betingelse. Uden den kunne et gæt på et liste-id
  // fra en anden konto slette deres arbejde.
  const where = ['org_id = $1', 'list_id = $2'];
  const params = [req.orgId, listId];

  if (ids?.length) {
    params.push(ids);
    where.push(`id = ANY($${params.length}::int[])`);
  } else {
    if (filter.missingEmail) where.push("(email IS NULL OR email = '')");
    if (filter.missingPhone) where.push("(phone IS NULL OR phone = '')");
    if (filter.status && STATUS_VALUES.includes(filter.status)) {
      params.push(filter.status);
      where.push(`status = $${params.length}`);
    }
    // Et filter der ikke indsnævrer noget, ville tømme hele listen. Det kan
    // man gøre med vilje ved at slette listen, ikke ved et uheld herfra.
    if (where.length === 2) {
      return res.status(400).json({ error: 'Filteret ville slette hele listen. Slet listen i stedet.' });
    }
  }

  try {
    // Findes listen overhovedet hos denne konto? Uden det svarer et opslag på
    // en fremmed liste 200 med nul slettede, og så kan man ikke se forskel på
    // "intet matchede filteret" og "du peger på en liste der ikke er din".
    // Svaret er det samme i begge tilfælde — findes ikke og er ikke din skal
    // ikke kunne skelnes udefra.
    const { rowCount: findes } = await db.query(
      'SELECT 1 FROM lead_lists WHERE id = $1 AND org_id = $2', [listId, req.orgId]
    );
    if (!findes) return res.status(404).json({ error: 'Listen blev ikke fundet.' });

    const { rowCount } = await db.query(
      `DELETE FROM leads WHERE ${where.join(' AND ')}`, params
    );
    return res.json({ ok: true, slettet: rowCount });
  } catch (err) {
    console.error('[lists:leads:delete]', err.message);
    return res.status(500).json({ error: 'Kunne ikke slette virksomhederne.' });
  }
});

// ── GET /api/lists/:id/leads — paged, filterable ─────────────────────────────
router.get('/lists/:id/leads', authenticate, async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'Ugyldigt liste-id.' });

  const page = Math.max(Number(req.query.page) || 1, 1);
  const size = Math.min(Math.max(Number(req.query.size) || 50, 1), 200);
  const params = [req.orgId, id];
  const where = ['l.org_id = $1', 'l.list_id = $2'];

  if (req.query.status && STATUS_VALUES.includes(req.query.status)) {
    params.push(req.query.status);
    where.push(`l.status = $${params.length}`);
  }
  if (req.query.assignedTo) {
    params.push(Number(req.query.assignedTo));
    where.push(`l.assigned_to = $${params.length}`);
  }
  if (req.query.q) {
    params.push(`%${String(req.query.q).trim()}%`);
    where.push(`(l.name ILIKE $${params.length} OR l.cvr ILIKE $${params.length})`);
  }

  try {
    const countRes = await db.query(
      `SELECT COUNT(*)::int AS total FROM leads l WHERE ${where.join(' AND ')}`, params
    );
    params.push(size, (page - 1) * size);
    const { rows } = await db.query(
      `SELECT l.*, u.name AS assigned_to_name
         FROM leads l
         LEFT JOIN users u ON u.id = l.assigned_to
        WHERE ${where.join(' AND ')}
        ORDER BY l.status = 'new' DESC, l.employees DESC NULLS LAST, l.name
        LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params
    );
    return res.json({ leads: rows, total: countRes.rows[0].total, page, size });
  } catch (err) {
    console.error('[lists:leads]', err.message);
    return res.status(500).json({ error: 'Kunne ikke hente leads.' });
  }
});

// ── GET /api/lists/:id/export.csv ────────────────────────────────────────────
router.get('/lists/:id/export.csv', authenticate, async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'Ugyldigt liste-id.' });

  const params = [req.orgId, id];
  const where = ['l.org_id = $1', 'l.list_id = $2'];
  if (req.query.status && STATUS_VALUES.includes(req.query.status)) {
    params.push(req.query.status);
    where.push(`l.status = $${params.length}`);
  }

  try {
    const listRes = await db.query(
      'SELECT name FROM lead_lists WHERE id = $1 AND org_id = $2', [id, req.orgId]
    );
    if (!listRes.rows.length) return res.status(404).json({ error: 'Listen blev ikke fundet.' });

    const { rows } = await db.query(
      `SELECT l.cvr, l.name, l.address, l.zipcode, l.city, l.municipality, l.phone,
              l.email, l.website, l.industry_code, l.industry_text, l.company_type,
              l.employees, l.established_on, l.status, l.call_count, l.last_called_at,
              l.next_callback_at, u.name AS assigned_to_name,
              (SELECT a.body FROM lead_activities a
                WHERE a.lead_id = l.id AND a.body IS NOT NULL
                ORDER BY a.created_at DESC LIMIT 1) AS latest_note
         FROM leads l
         LEFT JOIN users u ON u.id = l.assigned_to
        WHERE ${where.join(' AND ')}
        ORDER BY l.name`,
      params
    );

    const csv = toCsv(rows, [
      ['cvr', 'CVR'], ['name', 'Virksomhed'], ['address', 'Adresse'],
      ['zipcode', 'Postnr'], ['city', 'By'], ['municipality', 'Kommune'],
      ['phone', 'Telefon'], ['email', 'E-mail'], ['website', 'Hjemmeside'],
      ['industry_code', 'Branchekode'], ['industry_text', 'Branche'],
      ['company_type', 'Selskabsform'], ['employees', 'Ansatte'],
      ['established_on', 'Stiftet'], ['status', 'Status'],
      ['call_count', 'Antal opkald'], ['last_called_at', 'Sidst ringet'],
      ['next_callback_at', 'Genopkald'], ['assigned_to_name', 'Tildelt'],
      ['latest_note', 'Seneste note'],
    ]);

    const safeName = listRes.rows[0].name.replace(/[^\p{L}\p{N}_-]+/gu, '_').slice(0, 60);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition',
      `attachment; filename="leadburd_${safeName}.csv"; filename*=UTF-8''leadburd_${encodeURIComponent(safeName)}.csv`);
    return res.send(csv);
  } catch (err) {
    console.error('[lists:export]', err.message);
    return res.status(500).json({ error: 'Kunne ikke eksportere listen.' });
  }
});

// ── POST /api/lists/:id/leads — læg én virksomhed i en liste ─────────────────
// Kernen i produktet: brugeren finder en relevant virksomhed og gemmer netop
// den, frem for at skulle tage et helt udtræk med.
router.post('/lists/:id/leads', authenticate, async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'Ugyldigt liste-id.' });

  // Flere ad gangen — fra en markering på søgesiden. Samme regler som ved én:
  // virksomhederne hentes fra registret, og reklamebeskyttede kommer ikke med.
  if (Array.isArray(req.body?.cvrs)) {
    const numre = [...new Set(
      req.body.cvrs.map((n) => String(n).replace(/[\s\-.]/g, '')).filter((n) => /^\d{8}$/.test(n))
    )].slice(0, 200);
    if (!numre.length) return res.status(400).json({ error: 'Ingen gyldige CVR-numre.' });

    try {
      const liste = await db.query(
        'SELECT id, name FROM lead_lists WHERE id = $1 AND org_id = $2', [id, req.orgId]
      );
      if (!liste.rows.length) return res.status(404).json({ error: 'Listen blev ikke fundet.' });

      const fundne = await cvr.lookupCompanies(numre);
      const beskyttede = fundne.filter((c) => c.advertisingProtected);
      const brugbare  = fundne.filter((c) => !c.advertisingProtected);

      const client = await db.getClient();
      let indsat = 0;
      try {
        indsat = await insertLeads(client, { orgId: req.orgId, listId: id, companies: brugbare });
      } finally {
        client.release();
      }

      return res.status(201).json({
        list: liste.rows[0],
        // Fire tal frem for ét, fordi forskellen mellem dem er det brugeren
        // spørger om når listen ikke voksede så meget som forventet.
        tilføjet: indsat,
        laaAllerede: brugbare.length - indsat,
        reklamebeskyttede: beskyttede.length,
        ikkeFundet: numre.length - fundne.length,
      });
    } catch (err) {
      return handleCvrError(err, res, 'lists:leads:bulk');
    }
  }

  const cvrNummer = String(req.body?.cvr ?? '').replace(/[\s\-.]/g, '');
  if (!/^\d{8}$/.test(cvrNummer)) {
    return res.status(400).json({ error: 'Et dansk CVR-nummer er 8 cifre.' });
  }

  try {
    const liste = await db.query(
      'SELECT id, name FROM lead_lists WHERE id = $1 AND org_id = $2', [id, req.orgId]
    );
    if (!liste.rows.length) return res.status(404).json({ error: 'Listen blev ikke fundet.' });

    // Virksomheden hentes fra registret, ikke fra det klienten sender. Ellers
    // kunne hvad som helst lægges i en liste og se ud som CVR-data bagefter.
    const firma = await cvr.lookupCompany(cvrNummer);
    if (!firma) {
      return res.status(404).json({ error: 'Vi kunne ikke finde en virksomhed med det CVR-nummer.' });
    }

    // Reklamebeskyttelse er et lovkrav, ikke en indstilling. insertLeads
    // frasorterer dem allerede, men tavst — og her har brugeren peget på
    // netop denne virksomhed og skal vide hvorfor den ikke kan gemmes.
    if (firma.advertisingProtected) {
      return res.status(422).json({
        error: `${firma.name} er reklamebeskyttet i CVR og må ikke kontaktes med markedsføring.`,
        code: 'ADVERTISING_PROTECTED',
      });
    }

    const client = await db.getClient();
    let indsat;
    try {
      indsat = await insertLeads(client, {
        orgId: req.orgId, listId: id, companies: [firma],
      });
    } finally {
      client.release();
    }

    // Nul betyder at den lå der i forvejen — ikke at noget gik galt.
    return res.status(indsat ? 201 : 200).json({
      added: indsat > 0,
      alreadyOnList: indsat === 0,
      company: { cvr: firma.cvr, name: firma.name },
      list: liste.rows[0],
    });
  } catch (err) {
    return handleCvrError(err, res, 'lists:addLead');
  }
});

module.exports = router;
