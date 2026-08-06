// config/cvrOptions.js — dropdown data for the search form.
// Served to the frontend via GET /api/meta/options so there is one source.
'use strict';

// A shortlist of DB07 industry codes that come up most in Danish B2B calling.
// Not exhaustive — the search form also takes any code typed by hand.
//
// EVERY code here was checked against the live register and returns active
// companies. DB07 has been revised since its first edition, and the older
// codes are still present on ceased companies, so a stale code doesn't error
// — it quietly returns nothing. If you add a code, verify it the same way:
// filter on it together with an active status and confirm the count is > 0.
// Labels are the register's own branchetekst.
const INDUSTRIES = [
  { code: '410000', label: 'Opførelse af bygninger' },
  { code: '432100', label: 'El-installation' },
  { code: '432200', label: 'Installation af vvs-, varme- og klimaanlæg' },
  { code: '433200', label: 'Tømrer- og bygningssnedkeraktiviteter' },
  { code: '433410', label: 'Maleraktiviteter' },
  { code: '433500', label: 'Anden bygningsfærdiggørelse' },
  { code: '439100', label: 'Murerarbejde' },
  { code: '471110', label: 'Detailhandel med kioskvarer' },
  { code: '477110', label: 'Detailhandel med tøj' },
  { code: '494100', label: 'Vejgodstransport' },
  { code: '561110', label: 'Servering af mad i restauranter og caféer' },
  { code: '621000', label: 'Computerprogrammering' },
  { code: '629000', label: 'Andre IT- og computerserviceaktiviteter' },
  { code: '631000', label: 'IT-infrastruktur, hosting og databehandling' },
  { code: '682040', label: 'Udlejning af erhvervsejendomme' },
  { code: '691000', label: 'Juridiske aktiviteter' },
  { code: '692000', label: 'Bogføring, revision og skatterådgivning' },
  { code: '702000', label: 'Virksomheds- og ledelsesrådgivning' },
  { code: '711210', label: 'Rådgivende ingeniører (byggeri og anlæg)' },
  { code: '731110', label: 'Planlægning og design af reklamekampagner' },
  { code: '812100', label: 'Almindelig rengøring i bygninger' },
  { code: '855900', label: 'Anden undervisning' },
  { code: '862100', label: 'Alment praktiserende lægers aktiviteter' },
  { code: '862300', label: 'Tandlægers aktiviteter' },
  { code: '953190', label: 'Reparation og vedligeholdelse af motorkøretøjer' },
  { code: '962100', label: 'Drift af frisør- og barbersaloner' },
];

// CVR's `nyesteVirksomhedsform.virksomhedsformkode`. Codes and counts read
// straight out of the register — the numeric code is what we filter on,
// because the matching text field is analysed and won't match exactly.
// Ordered by how common they are among Danish companies.
const COMPANY_FORMS = [
  { value: 10,  short: 'ENK', label: 'Enkeltmandsvirksomhed' },
  { value: 80,  short: 'APS', label: 'Anpartsselskab (ApS)' },
  { value: 15,  short: 'PMV', label: 'Personligt ejet mindre virksomhed' },
  { value: 30,  short: 'I/S', label: 'Interessentskab (I/S)' },
  { value: 60,  short: 'A/S', label: 'Aktieselskab (A/S)' },
  { value: 81,  short: 'IVS', label: 'Iværksætterselskab (IVS)' },
  { value: 40,  short: 'K/S', label: 'Kommanditselskab (K/S)' },
  { value: 70,  short: 'KAS', label: 'Partnerselskab (P/S)' },
  { value: 151, short: 'SMA', label: 'Selskab med begrænset ansvar' },
  { value: 130, short: 'ANS', label: 'Andelsselskab' },
  { value: 100, short: 'EFO', label: 'Erhvervsdrivende fond' },
];

// Rough regional groupings so an agent can pick "Fyn" instead of typing ranges.
const REGIONS = [
  { value: 'kbh',      label: 'København og omegn', zipFrom: 1000, zipTo: 2990 },
  { value: 'nordsj',   label: 'Nordsjælland',       zipFrom: 3000, zipTo: 3670 },
  { value: 'bornholm', label: 'Bornholm',           zipFrom: 3700, zipTo: 3790 },
  { value: 'sjaelland',label: 'Sjælland',           zipFrom: 4000, zipTo: 4990 },
  { value: 'fyn',      label: 'Fyn',                zipFrom: 5000, zipTo: 5990 },
  { value: 'sydjyl',   label: 'Sydjylland',         zipFrom: 6000, zipTo: 6999 },
  { value: 'sondjyl',  label: 'Sønderjylland',      zipFrom: 6100, zipTo: 6470 },
  { value: 'midtjyl',  label: 'Midtjylland',        zipFrom: 7000, zipTo: 7999 },
  { value: 'ostjyl',   label: 'Østjylland',         zipFrom: 8000, zipTo: 8999 },
  { value: 'nordjyl',  label: 'Nordjylland',        zipFrom: 9000, zipTo: 9990 },
];

// Lead pipeline. `terminal` statuses drop out of the call queue.
const LEAD_STATUSES = [
  { value: 'new',            label: 'Ny',              tone: 'slate',  terminal: false },
  { value: 'no_answer',      label: 'Intet svar',      tone: 'amber',  terminal: false },
  { value: 'callback',       label: 'Ring igen',       tone: 'blue',   terminal: false },
  { value: 'interested',     label: 'Interesseret',    tone: 'green',  terminal: false },
  { value: 'meeting_booked', label: 'Møde booket',     tone: 'green',  terminal: false },
  { value: 'not_interested', label: 'Ikke interesseret', tone: 'red',  terminal: true  },
  { value: 'do_not_call',    label: 'Må ikke kontaktes', tone: 'red',  terminal: true  },
  { value: 'won',            label: 'Vundet',          tone: 'green',  terminal: true  },
  { value: 'lost',           label: 'Tabt',            tone: 'slate',  terminal: true  },
];

const TERMINAL_STATUSES = LEAD_STATUSES.filter((s) => s.terminal).map((s) => s.value);
const STATUS_VALUES     = LEAD_STATUSES.map((s) => s.value);

module.exports = {
  INDUSTRIES,
  COMPANY_FORMS,
  REGIONS,
  LEAD_STATUSES,
  TERMINAL_STATUSES,
  STATUS_VALUES,
};
