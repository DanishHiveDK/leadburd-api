// routes/billing.js — abonnement: status, checkout og kundeportal.
'use strict';

const express = require('express');
const db      = require('../db');
const stripeService = require('../services/stripeService');
const requireSubscription = require('../middleware/subscription');
const { authenticate, requireOwner } = require('../middleware/auth');

const router = express.Router();

/** Frontendens adresse — hertil sendes brugeren tilbage fra Stripe. */
function appUrl() {
  const fra = process.env.APP_URL || (process.env.CORS_ORIGINS || '').split(',')[0].trim();
  return (fra || 'http://localhost:5173').replace(/\/+$/, '');
}

async function hentOrg(orgId) {
  const { rows } = await db.query(
    `SELECT id, name, cvr, stripe_customer_id, stripe_subscription_id,
            subscription_status, current_period_end
       FROM organizations WHERE id = $1`,
    [orgId]
  );
  return rows[0] ?? null;
}

// ── GET /api/billing/status ──────────────────────────────────────────────────
// Frontenden spørger her for at vide om den skal vise betalingsmuren.
router.get('/status', authenticate, async (req, res) => {
  try {
    const org = await hentOrg(req.orgId);
    if (!org) return res.status(404).json({ error: 'Organisationen blev ikke fundet.' });

    // Ejerne er fritaget i muren, og status skal sige det samme — ellers
    // ville brugerfladen vise låsen frem, mens API'et lukkede dem ind.
    const fritaget = requireSubscription.erFritaget(req.user?.email);

    return res.json({
      status: fritaget ? 'fritaget' : org.subscription_status,
      harAdgang: fritaget || stripeService.harAdgang(org.subscription_status),
      fritaget,
      iPrøveperiode: !fritaget && org.subscription_status === 'trialing',
      periodeSlutter: org.current_period_end,
      harAbonnement: Boolean(org.stripe_subscription_id),
      prøvedage: stripeService.TRIAL_DAGE,
    });
  } catch (err) {
    console.error('[billing:status]', err.message);
    return res.status(500).json({ error: 'Kunne ikke hente abonnementet.' });
  }
});

// ── POST /api/billing/checkout ───────────────────────────────────────────────
router.post('/checkout', authenticate, requireOwner, async (req, res) => {
  if (!stripeService.erKonfigureret()) {
    return res.status(503).json({ error: 'Betaling er ikke sat op endnu.' });
  }

  try {
    const org = await hentOrg(req.orgId);
    if (!org) return res.status(404).json({ error: 'Organisationen blev ikke fundet.' });

    const session = await stripeService.opretCheckout({
      orgId: org.id,
      email: req.user.email,
      kundeId: org.stripe_customer_id,
      successUrl: `${appUrl()}/velkommen?session_id={CHECKOUT_SESSION_ID}`,
      cancelUrl: `${appUrl()}/abonnement`,
    });

    return res.json({ url: session.url });
  } catch (err) {
    console.error('[billing:checkout]', err.message);
    return res.status(502).json({ error: 'Kunne ikke starte betalingen. Prøv igen.' });
  }
});

// ── POST /api/billing/portal ─────────────────────────────────────────────────
router.post('/portal', authenticate, requireOwner, async (req, res) => {
  try {
    const org = await hentOrg(req.orgId);
    if (!org?.stripe_customer_id) {
      return res.status(400).json({ error: 'Der er ikke oprettet et abonnement endnu.' });
    }

    const session = await stripeService.opretPortal({
      kundeId: org.stripe_customer_id,
      returUrl: `${appUrl()}/abonnement`,
    });
    return res.json({ url: session.url });
  } catch (err) {
    console.error('[billing:portal]', err.message);
    return res.status(502).json({ error: 'Kunne ikke åbne kundeportalen.' });
  }
});

module.exports = router;
