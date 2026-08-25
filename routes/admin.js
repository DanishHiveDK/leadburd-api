// routes/admin.js — platformens eget overblik.
//
// Stripes dashboard viser betalinger bedre end noget her. Det det IKKE kan, er
// at koble betalingen sammen med brugen: hvem der rent faktisk søger og ringer,
// og hvem der er holdt op uden endnu at have opsagt. Det er dét denne side er
// til for.
'use strict';

const express = require('express');
const db      = require('../db');
const { authenticate } = require('../middleware/auth');
const requirePlatformAdmin = require('../middleware/platformAdmin');
const stripeService = require('../services/stripeService');

const router = express.Router();

const GRUNDPRIS = Number(process.env.PRICE_BASE_DKK || 179);
const PLADSPRIS = Number(process.env.PRICE_SEAT_DKK || 99);

router.use(authenticate, requirePlatformAdmin);

// ── GET /api/admin/overview ──────────────────────────────────────────────────
router.get('/overview', async (req, res) => {
  try {
    const { rows: konti } = await db.query(
      `SELECT o.id, o.name, o.cvr, o.created_at,
              o.subscription_status, o.current_period_end,
              o.stripe_customer_id IS NOT NULL AS har_kunde,
              (SELECT COUNT(*)::int FROM users u WHERE u.org_id = o.id AND u.is_active)  AS brugere,
              (SELECT COUNT(*)::int FROM users u WHERE u.org_id = o.id)                  AS brugere_i_alt,
              (SELECT COUNT(*)::int FROM leads l WHERE l.org_id = o.id)                  AS leads,
              (SELECT COUNT(*)::int FROM lead_lists ll WHERE ll.org_id = o.id)           AS lister,
              (SELECT COUNT(*)::int FROM lead_activities a
                 WHERE a.org_id = o.id AND a.type = 'call')                              AS opkald,
              -- Sidste livstegn. Uden det kan man ikke se hvem der er holdt op
              -- med at bruge produktet, før opsigelsen kommer.
              GREATEST(
                COALESCE((SELECT MAX(u.last_login_at) FROM users u WHERE u.org_id = o.id), o.created_at),
                COALESCE((SELECT MAX(a.created_at) FROM lead_activities a WHERE a.org_id = o.id), o.created_at)
              ) AS sidst_aktiv
         FROM organizations o
        ORDER BY o.created_at DESC`
    );

    const betalende = konti.filter((k) => k.subscription_status === 'active');
    const prøve     = konti.filter((k) => k.subscription_status === 'trialing');

    const pris = (k) =>
      GRUNDPRIS + Math.max(0, k.brugere - stripeService.PLADSER_INKLUDERET) * PLADSPRIS;

    return res.json({
      konti: konti.map((k) => ({ ...k, maanedspris: pris(k) })),
      nøgletal: {
        konti: konti.length,
        betalende: betalende.length,
        iPrøveperiode: prøve.length,
        // Kun de betalende tælles med. At regne prøvekonti med ville få
        // omsætningen til at se større ud end den er.
        maanedligOmsaetning: betalende.reduce((s, k) => s + pris(k), 0),
        brugere: konti.reduce((s, k) => s + k.brugere, 0),
        leads: konti.reduce((s, k) => s + k.leads, 0),
        opkald: konti.reduce((s, k) => s + k.opkald, 0),
      },
    });
  } catch (err) {
    console.error('[admin:overview]', err.message);
    return res.status(500).json({ error: 'Kunne ikke hente overblikket.' });
  }
});

// ── GET /api/admin/invoices ──────────────────────────────────────────────────
// De seneste fakturaer på tværs af alle kunder, så I kan se indbetalinger uden
// at skifte over i Stripe.
router.get('/invoices', async (req, res) => {
  if (!stripeService.stripe) {
    return res.status(503).json({ error: 'Betaling er ikke sat op.' });
  }
  try {
    const liste = await stripeService.stripe.invoices.list({ limit: 50 });
    return res.json({
      invoices: liste.data.map((f) => ({
        nummer: f.number,
        kunde: f.customer_name,
        dato: f.status_transitions?.finalized_at ?? f.created,
        ekskl: (f.subtotal ?? 0) / 100,
        moms: (f.tax ?? 0) / 100,
        ialt: (f.total ?? 0) / 100,
        valuta: (f.currency ?? 'dkk').toUpperCase(),
        status: f.status,
        web: f.hosted_invoice_url,
      })),
    });
  } catch (err) {
    console.error('[admin:invoices]', err.message);
    return res.status(502).json({ error: 'Kunne ikke hente fakturaerne.' });
  }
});

module.exports = router;
