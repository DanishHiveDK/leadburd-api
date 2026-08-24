// middleware/subscription.js — betalingsmuren.
//
// Frontenden slører de betalte skærme, men sløring er kun det brugeren ser.
// Uden denne kontrol kunne enhver med et gyldigt login hente det samme data
// med et enkelt kald udenom brugerfladen. Adgangen afgøres her.
'use strict';

const db = require('../db');
const { harAdgang } = require('../services/stripeService');

/**
 * Muren er slået fra som udgangspunkt.
 *
 * API'et og frontenden udrulles hver for sig. Blev muren håndhævet i samme
 * øjeblik den blev udrullet, ville nye brugere ramme en 402 uden en
 * betalingsside at klikke på, fordi frontenden endnu ikke kender til den.
 * Sæt BILLING_ENFORCED=true når begge dele er ude.
 */
const HÅNDHÆVES = process.env.BILLING_ENFORCED === 'true';

/**
 * Ejerne af LeadBurd. De betaler ikke for deres eget produkt.
 *
 * De to adresser står i koden og ikke kun i en miljøvariabel, så en glemt
 * eller forkert sat variabel ikke kan låse jer ude af jeres egen platform.
 * BILLING_EXEMPT_EMAILS kan tilføje flere uden en ny udrulning.
 */
const FRITAGNE = new Set(
  ['amana@leadburd.dk', 'lucca@look-a.dk']
    .concat((process.env.BILLING_EXEMPT_EMAILS || '').split(','))
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean)
);

function erFritaget(email) {
  // Trim som ved opbygningen af sættet. Ellers ville " lucca@look-a.dk "
  // blive behandlet som en anden — og fremmed — adresse.
  return FRITAGNE.has(String(email || '').trim().toLowerCase());
}

async function requireSubscription(req, res, next) {
  if (!HÅNDHÆVES) return next();

  // Ikke logget ind endnu: lad rutens egen authenticate svare på det, så
  // brugeren får "log ind" og ikke "betal".
  if (!req.orgId) return next();

  if (erFritaget(req.user?.email)) return next();

  try {
    const { rows } = await db.query(
      'SELECT subscription_status FROM organizations WHERE id = $1',
      [req.orgId]
    );
    const status = rows[0]?.subscription_status;

    if (harAdgang(status)) return next();

    return res.status(402).json({
      error: status === 'past_due' || status === 'unpaid'
        ? 'Betalingen mislykkedes. Opdater kortet for at fortsætte.'
        : 'Prøveperioden er udløbet. Vælg et medlemskab for at fortsætte.',
      code: 'SUBSCRIPTION_REQUIRED',
      status: status ?? null,
    });
  } catch (err) {
    console.error('[subscription]', err.message);
    return res.status(500).json({ error: 'Kunne ikke kontrollere abonnementet.' });
  }
}

module.exports = requireSubscription;
module.exports.erFritaget = erFritaget;
