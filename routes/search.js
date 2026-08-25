// routes/search.js — CVR search preview and single-company lookup.
// Nothing here writes to the database; saving results is routes/lists.js.
'use strict';

const express   = require('express');
const db        = require('../db');
const rateLimit = require('express-rate-limit');
const cvr       = require('../services/cvrService');
const { sanitizeFilters } = require('../services/filterSchema');
const { authenticate }    = require('../middleware/auth');
const options   = require('../config/cvrOptions');

const router = express.Router();

// Virk is a shared public resource — don't let one account hammer it.
const searchLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 40,
  keyGenerator: (req) => String(req.user?.id ?? req.ip),
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'For mange søgninger på kort tid. Vent et øjeblik.' },
});

/** Translate a CvrError into its HTTP response; anything else is a 500. */
function handleCvrError(err, res, context) {
  if (err instanceof cvr.CvrError) {
    return res.status(err.status).json({ error: err.message, code: err.code });
  }
  console.error(`[${context}]`, err.message);
  return res.status(500).json({ error: 'Der skete en uventet fejl.' });
}

/**
 * Piller de virksomheder ud som organisationen allerede har som lead.
 *
 * Sker HER og ikke i forespørgslen til CVR: registret kender ikke vores
 * database, og en konto kan have hundredtusinder af leads — de kan ikke sendes
 * med som betingelse. Derfor forbliver `total` registrets tal, og `skjult`
 * siger hvor mange der blev pillet ud af netop denne side, så brugerfladen kan
 * sige det ligeud frem for at lade som om siden bare var kortere.
 */
async function fravælgKendte(orgId, results) {
  const numre = results.map((c) => String(c.cvr)).filter(Boolean);
  if (!numre.length) return { vist: results, skjult: 0 };

  const { rows } = await db.query(
    'SELECT DISTINCT cvr FROM leads WHERE org_id = $1 AND cvr = ANY($2::text[])',
    [orgId, numre]
  );
  if (!rows.length) return { vist: results, skjult: 0 };

  const kendte = new Set(rows.map((r) => r.cvr));
  const vist = results.filter((c) => !kendte.has(String(c.cvr)));
  return { vist, skjult: results.length - vist.length };
}

// ── GET /api/meta/options — dropdown data for the search form ────────────────
router.get('/meta/options', authenticate, (req, res) => {
  res.json({
    industries:   options.INDUSTRIES,
    // Overordnede områder. Dækker hver branchekode i registret via
    // præfiks på hovedafdelingen, så listen ikke kan komme bagud.
    industryCategories: options.INDUSTRY_CATEGORIES.map(({ value, label }) => ({ value, label })),
    companyForms: options.COMPANY_FORMS,
    regions:      options.REGIONS,
    // Two axes: `statuses` is the outcome of a call, `stages` is where the
    // lead sits in the funnel. The UI needs both — see API.md.
    statuses:     options.LEAD_STATUSES,
    stages:       options.PIPELINE_STAGES,
    cvrConfigured: cvr.hasVirkCredentials(),
  });
});

// ── POST /api/search — paged preview of a filter ─────────────────────────────
router.post('/search', authenticate, searchLimiter, async (req, res) => {
  const filters = sanitizeFilters(req.body?.filters ?? req.body ?? {});
  try {
    const { total, results } = await cvr.searchCompanies({
      filters,
      page: req.body?.page ?? 1,
      size: req.body?.size ?? 25,
    });

    const { vist, skjult } = filters.excludeExisting
      ? await fravælgKendte(req.orgId, results)
      : { vist: results, skjult: 0 };

    return res.json({
      total,
      results: vist,
      skjult,
      filters,
      excludesAdvertisingProtected: cvr.EXCLUDE_PROTECTED,
    });
  } catch (err) {
    return handleCvrError(err, res, 'search');
  }
});

// ── GET /api/new-companies — the product's core view ─────────────────────────
// Companies registered in the last N days, newest first. Everything the
// dashboard and the landing feed are built on.
//
// Query: days (1-90, default 7), page, size, plus the normal search filters
// as repeatable params (industryCodes, region, zipFrom/zipTo, requirePhone…).
router.get('/new-companies', authenticate, searchLimiter, async (req, res) => {
  const days = Math.min(Math.max(Number(req.query.days) || 7, 1), 90);
  const since = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);

  // Reuse the shared filter validation, then pin the date window. A caller
  // cannot widen it past `days` by also sending establishedFrom.
  const filters = sanitizeFilters({ ...req.query, establishedFrom: since, establishedTo: undefined });

  try {
    const { total, results } = await cvr.searchCompanies({
      filters,
      page: req.query.page ?? 1,
      size: req.query.size ?? 25,
      sort: 'newest',
    });

    const today = new Date();
    const withAge = results.map((c) => {
      const registered = c.establishedOn ? new Date(c.establishedOn) : null;
      const ageDays = registered
        ? Math.max(0, Math.floor((today - registered) / 86400000))
        : null;
      // VAT registration is a separate, rate-limited lookup — say plainly that
      // it hasn't been done rather than letting the UI guess.
      return { ...c, ageDays, vatStatus: 'unknown' };
    });

    const { vist, skjult } = filters.excludeExisting
      ? await fravælgKendte(req.orgId, withAge)
      : { vist: withAge, skjult: 0 };

    return res.json({
      total,
      days,
      since,
      results: vist,
      skjult,
      excludesAdvertisingProtected: cvr.EXCLUDE_PROTECTED,
    });
  } catch (err) {
    return handleCvrError(err, res, 'new-companies');
  }
});

// ── GET /api/search/company/:cvr — single lookup ─────────────────────────────
router.get('/search/company/:cvr', authenticate, searchLimiter, async (req, res) => {
  try {
    const company = await cvr.lookupCompany(req.params.cvr);
    if (!company) return res.status(404).json({ error: 'CVR-nummeret blev ikke fundet.' });
    return res.json({ company });
  } catch (err) {
    return handleCvrError(err, res, 'search:company');
  }
});

module.exports = router;
module.exports.handleCvrError = handleCvrError;
