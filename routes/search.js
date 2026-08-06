// routes/search.js — CVR search preview and single-company lookup.
// Nothing here writes to the database; saving results is routes/lists.js.
'use strict';

const express   = require('express');
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

// ── GET /api/meta/options — dropdown data for the search form ────────────────
router.get('/meta/options', authenticate, (req, res) => {
  res.json({
    industries:   options.INDUSTRIES,
    companyForms: options.COMPANY_FORMS,
    regions:      options.REGIONS,
    statuses:     options.LEAD_STATUSES,
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
    return res.json({ total, results, filters, excludesAdvertisingProtected: cvr.EXCLUDE_PROTECTED });
  } catch (err) {
    return handleCvrError(err, res, 'search');
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
