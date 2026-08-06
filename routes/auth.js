// routes/auth.js — login, session and team management.
'use strict';

const express  = require('express');
const bcrypt   = require('bcryptjs');
const rateLimit = require('express-rate-limit');
const db       = require('../db');
const { authenticate, requireOwner, signToken } = require('../middleware/auth');

const router = express.Router();

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'For mange loginforsøg. Prøv igen om 15 minutter.' },
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
      },
    });
  } catch (err) {
    console.error('[auth:login]', err.message);
    return res.status(500).json({ error: 'Login mislykkedes. Prøv igen.' });
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
    return res.status(201).json({ user: rows[0] });
  } catch (err) {
    if (err.code === '23505') {
      return res.status(409).json({ error: 'Den e-mail er allerede i brug.' });
    }
    console.error('[auth:team:create]', err.message);
    return res.status(500).json({ error: 'Kunne ikke oprette brugeren.' });
  }
});

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
    return res.json({ user: rows[0] });
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
