// config/appUrl.js — frontendens adresse, ét sted.
//
// Bruges hvor API'et laver et link som en browser skal kunne følge: retur fra
// Stripe og invitationslinket i en mail. De to må ikke kunne pege forskellige
// steder hen, og det kunne de, da hver rute regnede adressen ud for sig.
'use strict';

/** Uden afsluttende skråstreg, så `${appUrl()}/sti` aldrig giver to. */
function appUrl() {
  const fra = process.env.APP_URL || (process.env.CORS_ORIGINS || '').split(',')[0].trim();
  return (fra || 'http://localhost:5173').replace(/\/+$/, '');
}

module.exports = appUrl;
