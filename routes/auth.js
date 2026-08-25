// routes/auth.js — login, session and team management.
'use strict';

const express  = require('express');
const bcrypt   = require('bcryptjs');
const rateLimit = require('express-rate-limit');
const db       = require('../db');
const cvrService = require('../services/cvrService');
const stripeService = require('../services/stripeService');
const { erPlatformAdmin } = require('../middleware/platformAdmin');
const { authenticate, requireOwner, signToken } = require('../middleware/auth');

const router = express.Router();

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'For mange loginforsøg. Prøv igen om 15 minutter.' },
});

// Oprettelse er åben, så den eneste bremse er denne. Loftet er sat så en
// almindelig bruger aldrig rammer det, men et script ikke kan lave hundredvis
// af organisationer på jeres Virk-aftale.
const registerLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 5,
  // Kun oprettelser der lykkes tæller med. Ellers ville en bruger, der taster
  // en for kort adgangskode et par gange, bruge sit loft på forsøg der ikke
  // har oprettet noget — og det er de oprettede organisationer, ikke de
  // afviste forsøg, der belaster Virk-aftalen.
  skipFailedRequests: true,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'For mange oprettelser fra denne forbindelse. Prøv igen om en time.' },
});

// Opslag under oprettelsen sker mens brugeren taster, så loftet er højere end
// for selve oprettelsen — men det er stadig vores Virk-aftale der betaler.
const lookupLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'For mange opslag. Prøv igen om lidt.' },
});

// ── POST /api/auth/login ─────────────────────────────────────────────────────
router.post('/login', loginLimiter, async (req, res) => {
  const email = String(req.body?.email ?? '').trim().toLowerCase();
  const password = String(req.body?.password ?? '');

  if (!email || !password) {
    return res.status(400).json({ error: 'Udfyld både e-mail og adgangskode.' });
  }

  try {
    const { rows } = await db.query(
      `SELECT u.id, u.org_id, u.email, u.name, u.role, u.password_hash, u.is_active,
              o.name AS org_name
         FROM users u
         JOIN organizations o ON o.id = u.org_id
        WHERE LOWER(u.email) = $1`,
      [email]
    );
    const user = rows[0];

    // Same response whether the address is unknown or the password is wrong —
    // otherwise this endpoint tells an attacker which emails exist.
    const ok = user && user.is_active && await bcrypt.compare(password, user.password_hash);
    if (!ok) {
      return res.status(401).json({ error: 'Forkert e-mail eller adgangskode.' });
    }

    await db.query('UPDATE users SET last_login_at = NOW() WHERE id = $1', [user.id]);

    return res.json({
      token: signToken(user),
      user: {
        id: user.id, name: user.name, email: user.email, role: user.role,
        orgId: user.org_id, orgName: user.org_name,
        // Adgang til admin-siden. Sendes med, så frontenden ved om linket skal
        // vises — men API'et afgør selv adgangen ved hvert kald.
        platformAdmin: erPlatformAdmin(user.email),
      },
    });
  } catch (err) {
    console.error('[auth:login]', err.message);
    return res.status(500).json({ error: 'Login mislykkedes. Prøv igen.' });
  }
});

// ── GET /api/auth/cvr/:nummer — slå firmanavn op under oprettelsen ───────────
// Så brugeren kan se hvilken virksomhed nummeret hører til, før der oprettes
// noget. Åbent endpoint, men det udstiller kun hvad CVR-registret allerede
// offentliggør.
router.get('/cvr/:nummer', lookupLimiter, async (req, res) => {
  try {
    const firma = await cvrService.lookupCompany(req.params.nummer);
    if (!firma) {
      return res.status(404).json({ error: 'Vi kunne ikke finde en virksomhed med det CVR-nummer.' });
    }
    return res.json({ company: { cvr: firma.cvr, name: firma.name, city: firma.city ?? null } });
  } catch (err) {
    if (err instanceof cvrService.CvrError) {
      return res.status(err.status || 502).json({ error: err.message, code: err.code });
    }
    console.error('[auth:cvr]', err.message);
    return res.status(500).json({ error: 'Opslaget mislykkedes. Prøv igen.' });
  }
});

// ── POST /api/auth/register — selvbetjent oprettelse ─────────────────────────
// Opretter en ny organisation med den nye bruger som ejer. Der er ingen
// invitation og ingen godkendelse: enhver med et gyldigt CVR-nummer kan komme
// i gang. Nummeret slås op i registret og kan kun bruges én gang, så den samme
// virksomhed ikke kan tage en ny prøveperiode med en ny mailadresse.
router.post('/register', registerLimiter, async (req, res) => {
  const name     = String(req.body?.name ?? '').trim();
  const cvr      = String(req.body?.cvr ?? '').replace(/[\s\-.]/g, '');
  const email    = String(req.body?.email ?? '').trim().toLowerCase();
  const password = String(req.body?.password ?? '');

  if (!name || !cvr || !email || !password) {
    return res.status(400).json({ error: 'Navn, CVR-nummer, e-mail og adgangskode skal udfyldes.' });
  }
  if (!/^\d{8}$/.test(cvr)) {
    return res.status(400).json({ error: 'Et dansk CVR-nummer er 8 cifre.' });
  }
  // Bevidst løs kontrol: der findes gyldige adresser som et strengere mønster
  // ville afvise. Formålet er at fange tastefejl, ikke at validere e-mail.
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    return res.status(400).json({ error: 'Skriv en gyldig e-mailadresse.' });
  }
  if (password.length < 10) {
    return res.status(400).json({ error: 'Adgangskoden skal være mindst 10 tegn.' });
  }

  // Slå nummeret op før der oprettes noget. Findes virksomheden ikke, er
  // nøglen til "én prøveperiode per virksomhed" værdiløs.
  let firma;
  try {
    firma = await cvrService.lookupCompany(cvr);
  } catch (err) {
    if (err instanceof cvrService.CvrError) {
      // Registret er nede. Vi kunne lade oprettelsen gå igennem uden opslag,
      // men så ville et opdigtet nummer slippe forbi netop mens ingen kan se
      // det — og det er præcis hullet det hele skal lukke.
      return res.status(err.status || 502).json({
        error: 'Vi kan ikke nå CVR-registret lige nu, så oprettelsen må vente et øjeblik. Prøv igen om lidt.',
        code: err.code,
      });
    }
    console.error('[auth:register:cvr]', err.message);
    return res.status(500).json({ error: 'Kunne ikke oprette kontoen. Prøv igen.' });
  }
  if (!firma) {
    return res.status(404).json({ error: 'Vi kunne ikke finde en virksomhed med det CVR-nummer.' });
  }

  try {
    const hash = await bcrypt.hash(password, 12);

    // Organisation og ejer hører sammen: uden transaktionen kunne en optaget
    // e-mail efterlade en tom organisation uden brugere.
    const user = await db.transaction(async (client) => {
      // Navnet tages fra registret, ikke fra brugeren. Det er både mere
      // korrekt og ét felt mindre at udfylde.
      const org = await client.query(
        'INSERT INTO organizations (name, cvr) VALUES ($1, $2) RETURNING id, name',
        [firma.name, cvr]
      );
      const created = await client.query(
        `INSERT INTO users (org_id, email, password_hash, name, role)
         VALUES ($1, $2, $3, $4, 'owner')
         RETURNING id, org_id, email, name, role`,
        [org.rows[0].id, email, hash, name]
      );
      return { ...created.rows[0], org_name: org.rows[0].name };
    });

    return res.status(201).json({
      token: signToken(user),
      user: {
        id: user.id, name: user.name, email: user.email, role: user.role,
        orgId: user.org_id, orgName: user.org_name,
        platformAdmin: erPlatformAdmin(user.email),
      },
    });
  } catch (err) {
    if (err.code === '23505') {
      // Hvilken af de to nøgler der ramte, afgør hvad brugeren skal gøre:
      // logge ind, eller kontakte den kollega der allerede har oprettet firmaet.
      if (err.constraint === 'organizations_cvr_key') {
        return res.status(409).json({
          error: 'Der findes allerede en konto for den virksomhed. Bed din kollega om at invitere dig.',
          code: 'CVR_TAKEN',
        });
      }
      return res.status(409).json({ error: 'Der findes allerede en konto med den e-mail.' });
    }
    console.error('[auth:register]', err.message);
    return res.status(500).json({ error: 'Kunne ikke oprette kontoen. Prøv igen.' });
  }
});

// ── GET /api/auth/me ─────────────────────────────────────────────────────────
router.get('/me', authenticate, async (req, res) => {
  try {
    const { rows } = await db.query('SELECT name FROM organizations WHERE id = $1', [req.orgId]);
    return res.json({
      user: {
        id: req.user.id, name: req.user.name, email: req.user.email,
        role: req.user.role, orgId: req.orgId, orgName: rows[0]?.name ?? null,
        platformAdmin: erPlatformAdmin(req.user.email),
      },
    });
  } catch (err) {
    console.error('[auth:me]', err.message);
    return res.status(500).json({ error: 'Kunne ikke hente brugeren.' });
  }
});

// ── GET /api/auth/team — colleagues, for the "assigned to" pickers ───────────
router.get('/team', authenticate, async (req, res) => {
  try {
    const { rows } = await db.query(
      `SELECT id, name, email, role, is_active, last_login_at
         FROM users WHERE org_id = $1 ORDER BY name`,
      [req.orgId]
    );
    return res.json({ users: rows });
  } catch (err) {
    console.error('[auth:team]', err.message);
    return res.status(500).json({ error: 'Kunne ikke hente teamet.' });
  }
});

// ── POST /api/auth/team — owner invites a colleague ──────────────────────────
router.post('/team', authenticate, requireOwner, async (req, res) => {
  const email = String(req.body?.email ?? '').trim().toLowerCase();
  const name = String(req.body?.name ?? '').trim();
  const password = String(req.body?.password ?? '');
  const role = req.body?.role === 'owner' ? 'owner' : 'agent';

  if (!email || !name || !password) {
    return res.status(400).json({ error: 'Navn, e-mail og adgangskode skal udfyldes.' });
  }
  if (password.length < 10) {
    return res.status(400).json({ error: 'Adgangskoden skal være mindst 10 tegn.' });
  }

  try {
    const hash = await bcrypt.hash(password, 12);
    const { rows } = await db.query(
      `INSERT INTO users (org_id, email, password_hash, name, role)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, name, email, role, is_active`,
      [req.orgId, email, hash, name, role]
    );
    const pladser = await opdaterPladser(req.orgId);
    return res.status(201).json({ user: rows[0], seats: pladser });
  } catch (err) {
    if (err.code === '23505') {
      return res.status(409).json({ error: 'Den e-mail er allerede i brug.' });
    }
    console.error('[auth:team:create]', err.message);
    return res.status(500).json({ error: 'Kunne ikke oprette brugeren.' });
  }
});

/**
 * Sæt antallet af betalte pladser efter en ændring i teamet.
 *
 * Fejler kaldet til Stripe, oprettes brugeren alligevel. Det betyder at I i
 * værste fald opkræver for lidt indtil næste ændring — og det er den rigtige
 * vej at fejle: en kunde der ikke kan tilføje sin kollega fordi Stripe har en
 * dårlig dag, er værre end en faktura der mangler 99 kroner i en periode.
 * Fordi antallet regnes ud på ny hver gang, retter det sig selv.
 */
async function opdaterPladser(orgId) {
  try {
    const { rows } = await db.query(
      `SELECT o.stripe_subscription_id AS sub,
              (SELECT COUNT(*)::int FROM users u
                WHERE u.org_id = o.id AND u.is_active) AS aktive
         FROM organizations o WHERE o.id = $1`,
      [orgId]
    );
    const org = rows[0];
    if (!org?.sub) return null;   // Ingen abonnement endnu — intet at opdatere.
    return await stripeService.synkroniserPladser({
      abonnementId: org.sub,
      aktiveBrugere: org.aktive,
    });
  } catch (err) {
    console.error('[auth:team:pladser]', err.message);
    return null;
  }
}

// ── PATCH /api/auth/team/:id — activate / deactivate ─────────────────────────
router.patch('/team/:id', authenticate, requireOwner, async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'Ugyldigt bruger-id.' });
  if (id === req.user.id) {
    return res.status(400).json({ error: 'Du kan ikke deaktivere dig selv.' });
  }

  try {
    const { rows } = await db.query(
      `UPDATE users SET is_active = $1 WHERE id = $2 AND org_id = $3
       RETURNING id, name, email, role, is_active`,
      [req.body?.isActive !== false, id, req.orgId]
    );
    if (!rows.length) return res.status(404).json({ error: 'Brugeren blev ikke fundet.' });
    const pladser = await opdaterPladser(req.orgId);
    return res.json({ user: rows[0], seats: pladser });
  } catch (err) {
    console.error('[auth:team:patch]', err.message);
    return res.status(500).json({ error: 'Kunne ikke opdatere brugeren.' });
  }
});

// ── POST /api/auth/password — change own password ────────────────────────────
router.post('/password', authenticate, async (req, res) => {
  const current = String(req.body?.currentPassword ?? '');
  const next = String(req.body?.newPassword ?? '');
  if (next.length < 10) {
    return res.status(400).json({ error: 'Den nye adgangskode skal være mindst 10 tegn.' });
  }

  try {
    const { rows } = await db.query('SELECT password_hash FROM users WHERE id = $1', [req.user.id]);
    if (!rows.length || !await bcrypt.compare(current, rows[0].password_hash)) {
      return res.status(401).json({ error: 'Den nuværende adgangskode er forkert.' });
    }
    await db.query('UPDATE users SET password_hash = $1 WHERE id = $2',
      [await bcrypt.hash(next, 12), req.user.id]);
    return res.json({ ok: true });
  } catch (err) {
    console.error('[auth:password]', err.message);
    return res.status(500).json({ error: 'Kunne ikke skifte adgangskode.' });
  }
});

module.exports = router;
