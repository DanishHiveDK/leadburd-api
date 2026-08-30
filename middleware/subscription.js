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
 * Indehaveren af Lysmera. Betaler ikke for sit eget produkt.
 *
 * De to adresser står i koden og ikke kun i en miljøvariabel, så en glemt
 * eller forkert sat variabel ikke kan låse jer ude af jeres egen platform.
 * BILLING_EXEMPT_EMAILS kan tilføje flere uden en ny udrulning.
 */
const FRITAGNE = new Set(
  ['lucca@look-a.dk']
    .concat((process.env.BILLING_EXEMPT_EMAILS || '').split(','))
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean)
);

function erFritaget(email) {
  // Trim som ved opbygningen af sættet. Ellers ville " lucca@look-a.dk "
  // blive behandlet som en anden — og fremmed — adresse.
  return FRITAGNE.has(String(email || '').trim().toLowerCase());
}

/**
 * Gratis teampladser på en fritaget konto.
 *
 * Fritagelsen fulgte før e-mailadressen, så den gjaldt kun personen selv. Det
 * betød at ejerens egne kollegaer ramte betalingsmuren på en konto der ikke
 * kan betale — den har hverken kunde eller abonnement i Stripe. Fritagelsen
 * følger derfor organisationen, men med et loft: ejeren plus dette antal.
 *
 * Loftet er der for at fritagelsen ikke stille og roligt bliver til gratis
 * adgang for enhver, ejeren kender.
 */
const GRATIS_TEAMPLADSER = Math.max(0, Number(process.env.FREE_TEAM_SEATS || 5));

/** Ejerens adresse afgør organisationens fritagelse — som på admin-siden. */
async function hentEjerEmail(orgId) {
  const { rows } = await db.query(
    `SELECT email FROM users
      WHERE org_id = $1 AND role = 'owner'
      ORDER BY id LIMIT 1`,
    [orgId]
  );
  return rows[0]?.email ?? null;
}

/** Er organisationen på en fritaget konto? Bruges hvor prisen skal vises. */
async function erFriOrganisation(orgId) {
  if (!orgId) return false;
  return erFritaget(await hentEjerEmail(orgId));
}

async function requireSubscription(req, res, next) {
  if (!HÅNDHÆVES) return next();

  // Ikke logget ind endnu: lad rutens egen authenticate svare på det, så
  // brugeren får "log ind" og ikke "betal".
  if (!req.orgId) return next();

  if (erFritaget(req.user?.email)) return next();

  try {
    const { rows } = await db.query(
      `SELECT o.subscription_status,
              (SELECT u.email FROM users u
                WHERE u.org_id = o.id AND u.role = 'owner'
                ORDER BY u.id LIMIT 1) AS ejer_email,
              -- Brugerens plads i rækken af aktive brugere, ældste først.
              -- Rækkefølgen ligger fast, så den samme bruger ikke kan falde
              -- ind og ud af de gratis pladser fra kald til kald.
              (SELECT COUNT(*)::int FROM users u
                WHERE u.org_id = o.id AND u.is_active AND u.id < $2) AS foran
         FROM organizations o WHERE o.id = $1`,
      [req.orgId, req.user.id]
    );
    const status = rows[0]?.subscription_status;

    // Ejerens fritagelse dækker teamet — op til loftet. Loftet håndhæves også
    // dér hvor brugere oprettes; her, fordi en plads der er givet ét sted skal
    // kunne inddrages det andet, fx hvis pladserne skæres ned.
    if (erFritaget(rows[0]?.ejer_email)) {
      if (rows[0].foran < 1 + GRATIS_TEAMPLADSER) return next();
      return res.status(402).json({
        error: `Kontoen har ${GRATIS_TEAMPLADSER} gratis teampladser, og de er brugt. `
             + 'Bed ejeren om at deaktivere et andet medlem.',
        code: 'FREE_SEATS_EXCEEDED',
        status: 'fritaget',
      });
    }

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
module.exports.erFriOrganisation = erFriOrganisation;
module.exports.GRATIS_TEAMPLADSER = GRATIS_TEAMPLADSER;
