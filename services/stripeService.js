// services/stripeService.js — abonnementet.
//
// Stripe ejer sandheden om hvem der har betalt. Vi gemmer en kopi på
// organisationen, så hvert API-kald kan spørge til den uden et netværkskald,
// og webhooken holder kopien opdateret.
'use strict';

const Stripe = require('stripe');

const SECRET   = process.env.STRIPE_SECRET_KEY || '';
const PRICE_ID = process.env.STRIPE_PRICE_ID || '';
const SEAT_PRICE_ID = process.env.STRIPE_SEAT_PRICE_ID || '';
const TRIAL_DAGE = Number(process.env.STRIPE_TRIAL_DAYS || 14);

/** Grundprisen dækker ejeren. Kun medlem nummer to og opefter koster. */
const PLADSER_INKLUDERET = 1;

// Klienten instantieres — den globale nøglestil (Stripe.setApiKey) er udgået.
const stripe = SECRET
  ? new Stripe(SECRET, { apiVersion: '2026-07-29.dahlia' })
  : null;

function erKonfigureret() {
  return Boolean(stripe && PRICE_ID);
}

/** Statusser fra Stripe der giver adgang til produktet. */
const ADGANG_STATUSSER = new Set(['trialing', 'active']);

function harAdgang(status) {
  return ADGANG_STATUSSER.has(String(status || ''));
}

/**
 * Checkout-session til et nyt abonnement.
 *
 * Bemærk hvad der IKKE står her: `payment_method_types`. Udelades den, vælger
 * Stripe selv de betalingsmetoder der er slået til i dashboardet og som passer
 * til kunden — herunder MobilePay. Hardkodes den til kort, lukkes resten ude.
 */
async function opretCheckout({ orgId, email, kundeId, successUrl, cancelUrl }) {
  return stripe.checkout.sessions.create({
    mode: 'subscription',
    line_items: [{ price: PRICE_ID, quantity: 1 }],

    ...(kundeId ? { customer: kundeId } : { customer_email: email }),

    subscription_data: {
      trial_period_days: TRIAL_DAGE,
      metadata: { org_id: String(orgId) },
    },
    // Kortoplysninger kræves fra start, også i prøveperioden. Det er dét der
    // gør en ny gratis periode dyrere end blot en ny mailadresse.
    payment_method_collection: 'always',

    // Momsen lægges oven i prisen. Virker kun hvis der findes en aktiv
    // registrering — uden opkræver Stripe 0 kr. uden at fejle.
    automatic_tax: { enabled: true },
    // Erhvervskunder i andre EU-lande med gyldigt momsnummer skal have omvendt
    // betalingspligt. Uden momsnummeret behandler Stripe dem som privatkunder.
    tax_id_collection: { enabled: true },
    customer_update: kundeId ? { address: 'auto', name: 'auto' } : undefined,

    client_reference_id: String(orgId),
    metadata: { org_id: String(orgId) },
    integration_identifier: 'leadburd-abonnement-mkqvzrph',

    success_url: successUrl,
    cancel_url: cancelUrl,
  });
}

/**
 * Sæt antallet af betalte pladser på et abonnement.
 *
 * Antallet regnes ud fra hvor mange aktive brugere organisationen HAR — ikke
 * ved at tælle op og ned ved hver ændring. Det betyder at en enkelt fejlet
 * synkronisering retter sig selv ved næste ændring, i stedet for at drive
 * længere og længere fra virkeligheden.
 *
 * `proration_behavior: 'none'`: nye medlemmer betales først fra næste faktura.
 * Uden den ville Stripe opkræve for de resterende dage med det samme.
 */
async function synkroniserPladser({ abonnementId, aktiveBrugere }) {
  if (!stripe || !SEAT_PRICE_ID || !abonnementId) return null;

  const pladser = Math.max(0, aktiveBrugere - PLADSER_INKLUDERET);
  const sub = await stripe.subscriptions.retrieve(abonnementId);
  const linje = sub.items.data.find((i) => i.price?.id === SEAT_PRICE_ID);

  // Stripe tillader ikke en linje med antal 0 — den skal fjernes helt.
  if (pladser === 0) {
    if (linje) {
      await stripe.subscriptionItems.del(linje.id, { proration_behavior: 'none' });
    }
    return { pladser: 0 };
  }

  if (!linje) {
    await stripe.subscriptionItems.create({
      subscription: abonnementId,
      price: SEAT_PRICE_ID,
      quantity: pladser,
      proration_behavior: 'none',
    });
  } else if (linje.quantity !== pladser) {
    await stripe.subscriptionItems.update(linje.id, {
      quantity: pladser,
      proration_behavior: 'none',
    });
  }
  return { pladser };
}

/** Kundeportalen: skift kort, se kvitteringer, opsig. */
async function opretPortal({ kundeId, returUrl }) {
  return stripe.billingPortal.sessions.create({
    customer: kundeId,
    return_url: returUrl,
  });
}

function verificerWebhook(rawBody, signatur) {
  const hemmelighed = process.env.STRIPE_WEBHOOK_SECRET || '';
  if (!hemmelighed) {
    throw new Error('STRIPE_WEBHOOK_SECRET mangler — webhooken kan ikke verificeres.');
  }
  return stripe.webhooks.constructEvent(rawBody, signatur, hemmelighed);
}

module.exports = {
  stripe,
  erKonfigureret,
  harAdgang,
  opretCheckout,
  opretPortal,
  synkroniserPladser,
  verificerWebhook,
  PRICE_ID,
  SEAT_PRICE_ID,
  TRIAL_DAGE,
  PLADSER_INKLUDERET,
};
