// routes/leads.js — the telemarketing side: call queue, outcomes, notes and
// callbacks.
'use strict';

const express = require('express');
const db      = require('../db');
const { authenticate } = require('../middleware/auth');
const { STATUS_VALUES, TERMINAL_STATUSES, STAGE_VALUES, STAGE_FOR_OUTCOME, PIPELINE_STAGES } = require('../config/cvrOptions');
const { checkDanishVat, danishVatNumber } = require('../services/vatService');

const router = express.Router();

const LEAD_FIELDS = [
  'id', 'list_id', 'cvr', 'name', 'address', 'zipcode', 'city', 'municipality',
  'region', 'phone', 'email', 'website', 'industry_code', 'industry_text',
  'company_type', 'employees', 'employees_interval', 'established_on',
  'owner_name', 'owner_role', 'owner_count', 'purpose', 'capital',
  'capital_currency', 'vat_status', 'vat_name', 'vat_checked_at',
  // Reklamebeskyttede må ikke kontaktes med markedsføring. De frasorteres
  // allerede ved indlæsning, men feltet skal med ud, så brugerfladen kan
  // skjule e-mailknappen hvis et gammelt lead eller et udbyderskifte har
  // ladet ét slippe igennem.
  'advertising_protected',
  // Both axes: `status` is the last call's outcome, `stage` is funnel position.
  // `last_called_at` er opkald; `last_contacted_at` er enhver kanal, også mail.
  // Adskilte, så "hvornår ringede vi sidst" stadig kan besvares.
  'status', 'stage', 'assigned_to', 'call_count', 'last_called_at',
  'last_contacted_at', 'next_callback_at', 'created_at',
];

// Qualified for SELECTs that join; bare for RETURNING clauses, which have no
// table alias in scope.
const LEAD_COLUMNS   = LEAD_FIELDS.map((f) => `l.${f}`).join(', ');
const LEAD_RETURNING = LEAD_FIELDS.join(', ');

// ── GET /api/leads/next — hand the agent the next company to call ────────────
// Priority: callbacks that are due, then never-called leads, then the leads
// left longest since the last attempt.
router.get('/leads/next', authenticate, async (req, res) => {
  const params = [req.orgId, req.user.id];
  const where = [
    'l.org_id = $1',
    `l.status NOT IN (${TERMINAL_STATUSES.map((s) => `'${s}'`).join(', ')})`,
    '(l.assigned_to IS NULL OR l.assigned_to = $2)',
    // A callback booked for later today is not ready yet — skip it until due.
    '(l.next_callback_at IS NULL OR l.next_callback_at <= NOW())',
  ];

  if (req.query.listId) {
    params.push(Number(req.query.listId));
    where.push(`l.list_id = $${params.length}`);
  }
  if (req.query.skip) {
    const skipIds = String(req.query.skip).split(',').map(Number).filter(Number.isInteger).slice(0, 50);
    if (skipIds.length) {
      params.push(skipIds);
      where.push(`l.id <> ALL($${params.length}::int[])`);
    }
  }

  try {
    const { rows } = await db.query(
      `SELECT ${LEAD_COLUMNS}, ll.name AS list_name
         FROM leads l
         JOIN lead_lists ll ON ll.id = l.list_id
        WHERE ${where.join(' AND ')}
        ORDER BY
          (l.next_callback_at IS NOT NULL AND l.next_callback_at <= NOW()) DESC,
          l.next_callback_at ASC NULLS LAST,
          l.call_count ASC,
          -- Før last_called_at: en virksomhed man lige har skrevet til har
          -- stadig call_count 0 og last_called_at NULL, og ville uden det her
          -- ligge øverst igen sekundet efter og blive mailet forfra.
          l.last_contacted_at ASC NULLS FIRST,
          l.last_called_at ASC NULLS FIRST,
          l.employees DESC NULLS LAST
        LIMIT 1`,
      params
    );
    if (!rows.length) return res.json({ lead: null, remaining: 0 });

    const countRes = await db.query(
      `SELECT COUNT(*)::int AS remaining FROM leads l WHERE ${where.join(' AND ')}`, params
    );
    return res.json({ lead: rows[0], remaining: countRes.rows[0].remaining });
  } catch (err) {
    console.error('[leads:next]', err.message);
    return res.status(500).json({ error: 'Kunne ikke hente næste lead.' });
  }
});

// ── GET /api/leads/callbacks — genopkald, due first ──────────────────────────
router.get('/leads/callbacks', authenticate, async (req, res) => {
  // 'today' covers everything overdue up to end of today; 'week' extends a week out.
  const scope = req.query.scope === 'week' ? '7 days' : '1 day';
  const params = [req.orgId];
  const where = [
    'l.org_id = $1',
    'l.next_callback_at IS NOT NULL',
    `l.next_callback_at < date_trunc('day', NOW()) + INTERVAL '${scope}'`,
    `l.status NOT IN (${TERMINAL_STATUSES.map((s) => `'${s}'`).join(', ')})`,
  ];
  if (req.query.mine === 'true') {
    params.push(req.user.id);
    where.push(`l.assigned_to = $${params.length}`);
  }

  try {
    const { rows } = await db.query(
      `SELECT ${LEAD_COLUMNS}, ll.name AS list_name, u.name AS assigned_to_name,
              l.next_callback_at < NOW() AS overdue
         FROM leads l
         JOIN lead_lists ll ON ll.id = l.list_id
         LEFT JOIN users u  ON u.id  = l.assigned_to
        WHERE ${where.join(' AND ')}
        ORDER BY l.next_callback_at ASC
        LIMIT 200`,
      params
    );
    return res.json({ callbacks: rows });
  } catch (err) {
    console.error('[leads:callbacks]', err.message);
    return res.status(500).json({ error: 'Kunne ikke hente genopkald.' });
  }
});

// ── GET /api/leads/:id — one lead with its history ───────────────────────────
router.get('/leads/:id', authenticate, async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'Ugyldigt lead-id.' });

  try {
    const { rows } = await db.query(
      `SELECT ${LEAD_COLUMNS}, ll.name AS list_name, u.name AS assigned_to_name
         FROM leads l
         JOIN lead_lists ll ON ll.id = l.list_id
         LEFT JOIN users u  ON u.id  = l.assigned_to
        WHERE l.id = $1 AND l.org_id = $2`,
      [id, req.orgId]
    );
    if (!rows.length) return res.status(404).json({ error: 'Lead blev ikke fundet.' });

    const activities = await db.query(
      `SELECT a.id, a.type, a.outcome, a.body, a.created_at, u.name AS user_name
         FROM lead_activities a
         LEFT JOIN users u ON u.id = a.user_id
        WHERE a.lead_id = $1 AND a.org_id = $2
        ORDER BY a.created_at DESC LIMIT 100`,
      [id, req.orgId]
    );
    return res.json({ lead: rows[0], activities: activities.rows });
  } catch (err) {
    console.error('[leads:show]', err.message);
    return res.status(500).json({ error: 'Kunne ikke hente lead.' });
  }
});

// ── POST /api/leads/:id/outcome — log a call and move the lead on ────────────
// Body: { status, note?, callbackAt?, countsAsCall? }
router.post('/leads/:id/outcome', authenticate, async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'Ugyldigt lead-id.' });

  const status = req.body?.status;
  if (status !== undefined && !STATUS_VALUES.includes(status)) {
    return res.status(400).json({ error: 'Ukendt status.' });
  }

  const note = String(req.body?.note ?? '').trim().slice(0, 4000) || null;

  // En mail er ikke et opkald. Det afgøres her og ikke i frontenden: sendte en
  // klient countsAsCall med, ville opkaldstallene på dashboardet og
  // adminsiden kunne pustes op af en fejl ét sted i brugerfladen.
  const erMail = status === 'emailed';
  const countsAsCall = !erMail && req.body?.countsAsCall !== false;

  let callbackAt = null;
  if (req.body?.callbackAt) {
    const parsed = new Date(req.body.callbackAt);
    if (Number.isNaN(parsed.getTime())) {
      return res.status(400).json({ error: 'Ugyldig dato for genopkald.' });
    }
    callbackAt = parsed;
  }
  // "Ring igen" without a time would sit in the queue with nothing to sort on.
  if (status === 'callback' && !callbackAt) {
    return res.status(400).json({ error: 'Vælg hvornår der skal ringes igen.' });
  }

  try {
    const result = await db.transaction(async (client) => {
      // Lock the row so two agents working the same queue can't both log an
      // outcome on it and lose one of the updates.
      const current = await client.query(
        'SELECT id, status, stage FROM leads WHERE id = $1 AND org_id = $2 FOR UPDATE',
        [id, req.orgId]
      );
      if (!current.rows.length) return null;

      const previousStatus = current.rows[0].status;
      const newStatus = status ?? previousStatus;
      // Booking a callback is the only case where a future date should stay on
      // the lead; any other outcome clears it.
      const keepCallback = newStatus === 'callback' && callbackAt;

      // Logging an outcome advances the funnel by itself. It never moves a
      // lead backwards: someone who reached 'i_pipeline' and then gets one
      // "intet svar" has not become merely 'kontaktet' again.
      const derivedStage = STAGE_FOR_OUTCOME[newStatus] ?? null;
      const stageRank = (s) => STAGE_VALUES.indexOf(s);
      const currentStage = current.rows[0].stage;
      const nextStage = derivedStage
        && (stageRank(derivedStage) > stageRank(currentStage)
            // 'tabt' and 'vundet' are conclusions and always apply.
            || derivedStage === 'tabt' || derivedStage === 'vundet')
        ? derivedStage
        : currentStage;

      const { rows } = await client.query(
        `UPDATE leads SET
           status           = $1,
           stage            = $2,
           next_callback_at = $3,
           call_count       = call_count + $4,
           last_called_at   = CASE WHEN $4 = 1 THEN NOW() ELSE last_called_at END,
           -- Sidste kontakt ad enhver kanal. Holdt adskilt fra last_called_at,
           -- så "hvornår ringede vi sidst" stadig kan besvares.
           last_contacted_at = CASE WHEN $4 = 1 OR $8 THEN NOW() ELSE last_contacted_at END,
           assigned_to      = COALESCE(assigned_to, $5),
           updated_at       = NOW()
         WHERE id = $6 AND org_id = $7
         RETURNING ${LEAD_RETURNING}`,
        [newStatus, nextStage, keepCallback ? callbackAt : null, countsAsCall ? 1 : 0,
         req.user.id, id, req.orgId, erMail]
      );

      if (erMail) {
        // Sin egen slags aktivitet. Gemt som note kunne historikken ikke
        // skelne "jeg skrev til dem" fra "jeg noterede noget" — og de to ting
        // betyder ikke det samme, når man samler op ugen efter.
        await client.query(
          `INSERT INTO lead_activities (org_id, lead_id, user_id, type, outcome, body)
           VALUES ($1, $2, $3, 'email', $4, $5)`,
          [req.orgId, id, req.user.id, newStatus, note]
        );
      } else if (countsAsCall) {
        await client.query(
          `INSERT INTO lead_activities (org_id, lead_id, user_id, type, outcome, body)
           VALUES ($1, $2, $3, 'call', $4, $5)`,
          [req.orgId, id, req.user.id, newStatus, note]
        );
      } else if (note) {
        await client.query(
          `INSERT INTO lead_activities (org_id, lead_id, user_id, type, body)
           VALUES ($1, $2, $3, 'note', $4)`,
          [req.orgId, id, req.user.id, note]
        );
      }

      // Mailen er allerede skrevet ind ovenfor; uden `!erMail` ville den samme
      // handling stå to gange i historikken.
      if (status && status !== previousStatus && !countsAsCall && !erMail) {
        await client.query(
          `INSERT INTO lead_activities (org_id, lead_id, user_id, type, outcome, body)
           VALUES ($1, $2, $3, 'status_change', $4, $5)`,
          [req.orgId, id, req.user.id, status, `${previousStatus} → ${status}`]
        );
      }

      if (keepCallback) {
        await client.query(
          `INSERT INTO lead_activities (org_id, lead_id, user_id, type, body)
           VALUES ($1, $2, $3, 'callback', $4)`,
          [req.orgId, id, req.user.id, `Genopkald sat til ${callbackAt.toISOString()}`]
        );
      }

      return rows[0];
    });

    if (!result) return res.status(404).json({ error: 'Lead blev ikke fundet.' });
    return res.json({ lead: result });
  } catch (err) {
    console.error('[leads:outcome]', err.message);
    return res.status(500).json({ error: 'Kunne ikke gemme resultatet.' });
  }
});

// ── POST /api/leads/:id/notes ────────────────────────────────────────────────
router.post('/leads/:id/notes', authenticate, async (req, res) => {
  const id = Number(req.params.id);
  const body = String(req.body?.body ?? '').trim().slice(0, 4000);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'Ugyldigt lead-id.' });
  if (!body) return res.status(400).json({ error: 'Noten er tom.' });

  try {
    const owns = await db.query('SELECT 1 FROM leads WHERE id = $1 AND org_id = $2', [id, req.orgId]);
    if (!owns.rows.length) return res.status(404).json({ error: 'Lead blev ikke fundet.' });

    const { rows } = await db.query(
      `INSERT INTO lead_activities (org_id, lead_id, user_id, type, body)
       VALUES ($1, $2, $3, 'note', $4)
       RETURNING id, type, body, created_at`,
      [req.orgId, id, req.user.id, body]
    );
    return res.status(201).json({ activity: { ...rows[0], user_name: req.user.name } });
  } catch (err) {
    console.error('[leads:notes]', err.message);
    return res.status(500).json({ error: 'Kunne ikke gemme noten.' });
  }
});

// ── PATCH /api/leads/:id — assignment, contact corrections ───────────────────
router.patch('/leads/:id', authenticate, async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'Ugyldigt lead-id.' });

  const sets = [];
  const params = [];

  // Dragging a card on the kanban board sets the stage directly. This is the
  // one place a stage can move backwards — the person moving it means it.
  if (req.body?.stage !== undefined) {
    if (!STAGE_VALUES.includes(req.body.stage)) {
      return res.status(400).json({ error: 'Ukendt pipeline-stadie.', code: 'BAD_STAGE' });
    }
    params.push(req.body.stage);
    sets.push(`stage = $${params.length}`);
  }

  if (req.body?.assignedTo !== undefined) {
    const assignee = req.body.assignedTo === null ? null : Number(req.body.assignedTo);
    if (assignee !== null) {
      // Guard the FK by hand so a lead can't be assigned across organisations.
      const member = await db.query(
        'SELECT 1 FROM users WHERE id = $1 AND org_id = $2 AND is_active', [assignee, req.orgId]
      );
      if (!member.rows.length) return res.status(400).json({ error: 'Ukendt kollega.' });
    }
    params.push(assignee); sets.push(`assigned_to = $${params.length}`);
  }

  // Agents routinely find the registry's number is dead and the real one on
  // the website, so contact fields stay editable.
  for (const [field, column] of [['phone', 'phone'], ['email', 'email'], ['website', 'website']]) {
    if (req.body?.[field] !== undefined) {
      params.push(String(req.body[field]).trim().slice(0, 200) || null);
      sets.push(`${column} = $${params.length}`);
    }
  }

  if (!sets.length) return res.status(400).json({ error: 'Ingen ændringer angivet.' });
  params.push(id, req.orgId);

  try {
    const { rows } = await db.query(
      `UPDATE leads SET ${sets.join(', ')}, updated_at = NOW()
        WHERE id = $${params.length - 1} AND org_id = $${params.length}
        RETURNING ${LEAD_RETURNING}`,
      params
    );
    if (!rows.length) return res.status(404).json({ error: 'Lead blev ikke fundet.' });
    return res.json({ lead: rows[0] });
  } catch (err) {
    console.error('[leads:patch]', err.message);
    return res.status(500).json({ error: 'Kunne ikke opdatere lead.' });
  }
});

// ── POST /api/leads/:id/vat-check — resolve VAT registration on demand ───────
// VIES is rate-limited, so this is never run across a whole extraction. The
// answer is cached on the lead; pass { force: true } to re-check.
router.post('/leads/:id/vat-check', authenticate, async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'Ugyldigt lead-id.' });

  try {
    const { rows } = await db.query(
      'SELECT cvr, vat_status, vat_name, vat_checked_at FROM leads WHERE id = $1 AND org_id = $2',
      [id, req.orgId]
    );
    if (!rows.length) return res.status(404).json({ error: 'Lead blev ikke fundet.' });
    const lead = rows[0];

    // A settled answer is stable enough to reuse; 'unknown' means the last
    // attempt failed, so retrying is the whole point.
    if (!req.body?.force && lead.vat_status !== 'unknown' && lead.vat_checked_at) {
      return res.json({
        vatStatus: lead.vat_status,
        vatName: lead.vat_name,
        vatNumber: danishVatNumber(lead.cvr),
        checkedAt: lead.vat_checked_at,
        cached: true,
      });
    }

    const result = await checkDanishVat(lead.cvr);

    // Only record a checked-at when we actually got an answer, so an 'unknown'
    // doesn't look like a settled verdict on the next read.
    await db.query(
      `UPDATE leads SET vat_status = $1, vat_name = $2,
              vat_checked_at = CASE WHEN $1 = 'unknown' THEN NULL ELSE NOW() END
        WHERE id = $3 AND org_id = $4`,
      [result.status, result.name, id, req.orgId]
    );

    return res.json({
      vatStatus: result.status,
      vatName: result.name,
      vatNumber: danishVatNumber(lead.cvr),
      checkedAt: result.status === 'unknown' ? null : new Date().toISOString(),
      cached: false,
      // Present only when status is 'unknown' — why we couldn't tell.
      reason: result.reason,
    });
  } catch (err) {
    console.error('[leads:vat-check]', err.message);
    return res.status(500).json({ error: 'Kunne ikke tjekke momsregistrering.' });
  }
});

// ── GET /api/stats — dashboard numbers ───────────────────────────────────────
router.get('/stats', authenticate, async (req, res) => {
  try {
    const [totals, today, mine, uge, sammenlign] = await Promise.all([
      db.query(
        `SELECT COUNT(*)::int AS leads,
                COUNT(*) FILTER (WHERE status = 'new')::int AS new_leads,
                COUNT(*) FILTER (WHERE status IN ('interested','meeting_booked'))::int AS warm,
                COUNT(*) FILTER (WHERE status = 'won')::int AS won
           FROM leads WHERE org_id = $1`, [req.orgId]),
      db.query(
        `SELECT COUNT(*)::int AS calls_today,
                COUNT(DISTINCT lead_id)::int AS companies_today
           FROM lead_activities
          WHERE org_id = $1 AND type = 'call' AND created_at >= date_trunc('day', NOW())`,
        [req.orgId]),
      db.query(
        `SELECT COUNT(*)::int AS due_callbacks
           FROM leads
          WHERE org_id = $1 AND next_callback_at IS NOT NULL
            AND next_callback_at < date_trunc('day', NOW()) + INTERVAL '1 day'
            AND status NOT IN (${TERMINAL_STATUSES.map((s) => `'${s}'`).join(', ')})`,
        [req.orgId]),
      // Ugens forløb. generate_series sikrer at dage uden aktivitet kommer med
      // som nul — ellers ville kurven springe over dem og se pænere ud end
      // virkeligheden.
      db.query(
        `WITH dage AS (
           SELECT generate_series(
             date_trunc('day', NOW()) - INTERVAL '6 days',
             date_trunc('day', NOW()),
             INTERVAL '1 day'
           ) AS dag
         )
         SELECT d.dag,
                (SELECT COUNT(*)::int FROM leads l
                   WHERE l.org_id = $1 AND l.created_at >= d.dag
                     AND l.created_at < d.dag + INTERVAL '1 day') AS nye,
                (SELECT COUNT(DISTINCT a.lead_id)::int FROM lead_activities a
                   WHERE a.org_id = $1 AND a.type = 'call' AND a.created_at >= d.dag
                     AND a.created_at < d.dag + INTERVAL '1 day') AS kontaktet
           FROM dage d ORDER BY d.dag`,
        [req.orgId]),

      // Forrige uge, til ændringen i procent. Uden et sammenligningsgrundlag
      // ville en pil op være pynt.
      db.query(
        `SELECT
           (SELECT COUNT(*)::int FROM leads
             WHERE org_id = $1 AND created_at >= NOW() - INTERVAL '7 days')  AS nye_denne,
           (SELECT COUNT(*)::int FROM leads
             WHERE org_id = $1 AND created_at >= NOW() - INTERVAL '14 days'
               AND created_at < NOW() - INTERVAL '7 days')                   AS nye_forrige,
           (SELECT COUNT(DISTINCT lead_id)::int FROM lead_activities
             WHERE org_id = $1 AND type = 'call' AND created_at >= NOW() - INTERVAL '7 days') AS kontaktet_denne,
           (SELECT COUNT(DISTINCT lead_id)::int FROM lead_activities
             WHERE org_id = $1 AND type = 'call' AND created_at >= NOW() - INTERVAL '14 days'
               AND created_at < NOW() - INTERVAL '7 days')                   AS kontaktet_forrige`,
        [req.orgId]),
    ]);

    const u = uge.rows.map((r) => ({
      dag: r.dag,
      nye: r.nye,
      kontaktet: r.kontaktet,
    }));

    // Fra ingenting til noget er ikke "uendelig procent" — så sendes null, og
    // brugerfladen lader være med at vise en ændring.
    const ændring = (nu, før) => (før > 0 ? Math.round(((nu - før) / før) * 100) : null);
    const s = sammenlign.rows[0];

    return res.json({
      ...totals.rows[0],
      ...today.rows[0],
      ...mine.rows[0],
      week: u,
      changes: {
        new_leads: ændring(s.nye_denne, s.nye_forrige),
        contacted: ændring(s.kontaktet_denne, s.kontaktet_forrige),
      },
    });
  } catch (err) {
    console.error('[stats]', err.message);
    return res.status(500).json({ error: 'Kunne ikke hente statistik.' });
  }
});

// ── GET /api/pipeline — kanban-tavlen ────────────────────────────────────────
// Leads grupperet efter trin. Kolonnerne kommer altid alle med, også de tomme,
// så tavlen har samme form uanset hvor lidt der ligger i den.
router.get('/pipeline', authenticate, async (req, res) => {
  try {
    const { rows } = await db.query(
      `SELECT l.id, l.cvr, l.name, l.city, l.phone, l.industry_text,
              l.stage, l.status, l.call_count, l.next_callback_at,
              l.updated_at, u.name AS assigned_name
         FROM leads l
         LEFT JOIN users u ON u.id = l.assigned_to
        WHERE l.org_id = $1
        ORDER BY l.updated_at DESC NULLS LAST, l.id DESC`,
      [req.orgId]
    );

    const kolonner = PIPELINE_STAGES.map((s) => ({
      ...s,
      // Loftet er der for at en organisation med titusinder af leads ikke
      // sender hele databasen til browseren for at tegne en tavle.
      leads: rows.filter((r) => r.stage === s.value).slice(0, 100),
      antal: rows.filter((r) => r.stage === s.value).length,
    }));

    return res.json({ columns: kolonner, total: rows.length });
  } catch (err) {
    console.error('[pipeline]', err.message);
    return res.status(500).json({ error: 'Kunne ikke hente pipelinen.' });
  }
});

module.exports = router;
