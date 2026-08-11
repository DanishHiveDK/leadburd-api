// services/vatService.js — is this company actually VAT registered?
//
// The CVR feed does NOT carry VAT registration. A CVR number is not proof of
// it: companies under the 50.000 kr threshold and VAT-exempt trades (doctors,
// dentists, teaching, insurance) have a CVR number and no VAT registration,
// and large groups file jointly so a subsidiary's own number is inactive.
//
// The EU VIES registry is the authority. It is slow and rate-limited, so this
// is an on-demand lookup cached on the lead — never something to run across a
// whole extraction.
'use strict';

const ENDPOINT = 'https://ec.europa.eu/taxation_customs/vies/rest-api/check-vat-number';

/**
 * VIES answers a failed lookup with `valid: false` PLUS a userError code — a
 * "no" that actually means "I could not tell you". Treating those as
 * unregistered would brand real VAT-registered companies as not registered,
 * so only these two codes are real answers.
 */
const CONCLUSIVE = new Set(['VALID', 'INVALID']);

/** Errors worth retrying: the member state is busy, not the number being bad. */
const TRANSIENT = new Set([
  'MS_MAX_CONCURRENT_REQ',
  'MS_UNAVAILABLE',
  'SERVICE_UNAVAILABLE',
  'TIMEOUT',
  'GLOBAL_MAX_CONCURRENT_REQ',
]);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Look up one Danish VAT number.
 *
 * @returns {{status:'registered'|'unregistered'|'unknown', name:string|null, reason:string|null}}
 *          'unknown' is a normal outcome, not an error — the UI must show it
 *          as "ikke tjekket", never as "ikke momsregistreret".
 */
async function checkDanishVat(cvrNumber, { attempts = 3, timeoutMs = 15000 } = {}) {
  const clean = String(cvrNumber ?? '').replace(/[^0-9]/g, '');
  if (!/^\d{8}$/.test(clean)) {
    return { status: 'unknown', name: null, reason: 'INVALID_CVR_FORMAT' };
  }

  let lastReason = null;

  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      const res = await fetch(ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ countryCode: 'DK', vatNumber: clean }),
        signal: AbortSignal.timeout(timeoutMs),
      });

      if (!res.ok) {
        lastReason = `HTTP_${res.status}`;
        await sleep(1500 * (attempt + 1));
        continue;
      }

      const data = await res.json();
      const userError = data.userError ?? null;

      // No userError, or an explicitly conclusive one → trust `valid`.
      if (!userError || CONCLUSIVE.has(userError)) {
        return {
          status: data.valid === true ? 'registered' : 'unregistered',
          name: data.name && data.name !== '---' ? data.name : null,
          reason: null,
        };
      }

      lastReason = userError;
      if (!TRANSIENT.has(userError)) break; // a permanent error won't improve
      await sleep(2000 * (attempt + 1));
    } catch (err) {
      lastReason = err.name === 'TimeoutError' ? 'TIMEOUT' : 'NETWORK';
      await sleep(1500 * (attempt + 1));
    }
  }

  return { status: 'unknown', name: null, reason: lastReason };
}

/**
 * The Danish VAT number for a CVR number. This is a formatting rule and
 * nothing more — it says nothing about whether the company is registered.
 * Useful for invoicing once you know they are.
 */
function danishVatNumber(cvrNumber) {
  const clean = String(cvrNumber ?? '').replace(/[^0-9]/g, '');
  return /^\d{8}$/.test(clean) ? `DK${clean}` : null;
}

module.exports = { checkDanishVat, danishVatNumber };
