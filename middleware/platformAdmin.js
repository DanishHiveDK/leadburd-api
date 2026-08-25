// middleware/platformAdmin.js — adgang til admin-siden.
//
// Bevidst adskilt fra betalingsfritagelsen, selvom det er de samme to
// adresser i dag. At kunne se alle kunders data er en anden rettighed end at
// slippe for at betale, og de to lister vil før eller siden skulle skilles ad
// — fx hvis en medarbejder skal have gratis adgang uden at kunne se alt.
//
// `role: 'owner'` er ejeren af en KUNDES konto, ikke af platformen. Den
// forskel er hele pointen: uden den ville enhver kunde kunne se alle andre.
'use strict';

const ADMINS = new Set(
  ['amana@leadburd.dk', 'lucca@look-a.dk']
    .concat((process.env.PLATFORM_ADMIN_EMAILS || '').split(','))
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean)
);

function erPlatformAdmin(email) {
  return ADMINS.has(String(email || '').trim().toLowerCase());
}

function requirePlatformAdmin(req, res, next) {
  if (erPlatformAdmin(req.user?.email)) return next();
  // Samme svar som en sti der ikke findes. Et 403 ville bekræfte at siden
  // eksisterer, og det er der ingen grund til at fortælle.
  return res.status(404).json({ error: 'Endpoint findes ikke.' });
}

module.exports = requirePlatformAdmin;
module.exports.erPlatformAdmin = erPlatformAdmin;
