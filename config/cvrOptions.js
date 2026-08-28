// config/cvrOptions.js — dropdown data for the search form.
// Served to the frontend via GET /api/meta/options so there is one source.
'use strict';

/**
 * Overordnede brancheområder.
 *
 * Der er godt 800 branchekoder i DB07, og ingen sælger kender dem udenad. Men
 * koderne er hierarkiske: de to første cifre er hovedafdelingen, så "alt inden
 * for sundhed" er ganske enkelt alle koder der begynder med 86, 87 eller 88.
 *
 * Derfor grupperes der på de to cifre frem for at føre en liste over de 800.
 * Det dækker HVER eneste branche i registret — også dem vi aldrig har hørt om
 * — og listen kan ikke komme bagud når Danmarks Statistik tilføjer en kode.
 *
 * Vi kunne ikke hente listen fra Virk: branchekoden er indekseret som fritekst,
 * og Elasticsearch afviser at aggregere over den ("fielddata is disabled on
 * text fields"). Præfiksopslag virker til gengæld fint, og det er dét det her
 * bygger på.
 *
 * Inddelingen følger DB07/NACE rev. 2, men er slået sammen efter hvem man
 * ringer til frem for efter statistisk systematik.
 */
const INDUSTRY_CATEGORIES = [
  { value: 'byggeri',    label: 'Byggeri og håndværk',        divisions: ['41', '42', '43'] },
  { value: 'handel',     label: 'Handel og detail',           divisions: ['45', '46', '47'] },
  { value: 'sundhed',    label: 'Sundhed og omsorg',          divisions: ['86', '87', '88'] },
  { value: 'radgivning', label: 'Rådgivning og videnservice', divisions: ['69', '70', '71', '72', '73', '74', '75'] },
  { value: 'it',         label: 'IT og kommunikation',        divisions: ['58', '59', '60', '61', '62', '63'] },
  { value: 'transport',  label: 'Transport og logistik',      divisions: ['49', '50', '51', '52', '53'] },
  { value: 'hotel',      label: 'Hotel og restauration',      divisions: ['55', '56'] },
  { value: 'service',    label: 'Rengøring og operationel service', divisions: ['77', '78', '79', '80', '81', '82'] },
  { value: 'industri',   label: 'Industri og produktion',
    divisions: ['10', '11', '12', '13', '14', '15', '16', '17', '18', '19', '20', '21',
                '22', '23', '24', '25', '26', '27', '28', '29', '30', '31', '32', '33'] },
  { value: 'finans',     label: 'Finans, forsikring og ejendom', divisions: ['64', '65', '66', '68'] },
  { value: 'landbrug',   label: 'Landbrug, skovbrug og fiskeri', divisions: ['01', '02', '03'] },
  { value: 'energi',     label: 'Energi, vand og miljø',      divisions: ['35', '36', '37', '38', '39'] },
  { value: 'undervisning', label: 'Undervisning',             divisions: ['85'] },
  { value: 'kultur',     label: 'Kultur, fritid og foreninger', divisions: ['90', '91', '92', '93', '94'] },
  { value: 'personlig',  label: 'Personlig service',          divisions: ['95', '96'] },
  { value: 'raastof',    label: 'Råstofindvinding',           divisions: ['05', '06', '07', '08', '09'] },
  { value: 'offentlig',  label: 'Offentlig administration',   divisions: ['84'] },
];

const CATEGORY_VALUES = INDUSTRY_CATEGORIES.map((k) => k.value);

/** De to-cifrede hovedafdelinger for et sæt kategorier. */
function divisionsForCategories(values = []) {
  const valgte = new Set(values.map(String));
  return INDUSTRY_CATEGORIES
    .filter((k) => valgte.has(k.value))
    .flatMap((k) => k.divisions);
}

// Genveje til de brancher der oftest ringes til. Kategorierne ovenfor dækker
// dem også, men den der leder efter netop elektrikere skal ikke igennem hele
// byggeriet først.
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
  // Ikke terminal: man skriver typisk først og ringer bagefter, så leadet skal
  // blive i køen. Det tæller heller ikke som et opkald — se countsAsCall.
  { value: 'emailed',        label: 'Kontaktet på mail', tone: 'blue', terminal: false },
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

/**
 * Pipeline stages — where a lead sits in the funnel. This is the axis the
 * kanban board and the dashboard count on, and it is deliberately separate
 * from the call outcome above: three "intet svar" attempts are three outcomes
 * but one stage ("Kontaktet").
 */
/**
 * En prognosestige, ikke en aktivitetsstige.
 *
 * Trinnene siger, hvor sandsynligt et salg er — ikke hvor meget arbejde der
 * er lagt i det. Det er forskellen på et bræt, en sælger bruger til at holde
 * styr på sig selv, og et bræt, man kan lave et bud ud fra.
 *
 * Rækkefølgen betyder noget: `stageRank` i routes/leads.js bruger indekset
 * til at forhindre, at et lead falder tilbage, når man logger et udfald.
 * vundet og tabt er undtaget, fordi de er konklusioner.
 */
const PIPELINE_STAGES = [
  { value: 'pipeline', label: 'Pipeline', tone: 'slate',
    hint: 'Skal ringes op' },
  { value: 'upside',   label: 'Upside',   tone: 'amber',
    hint: 'Talt med, tilbud givet, virker interesseret' },
  { value: 'commit',   label: 'Commit',   tone: 'blue',
    hint: 'De vil købe — det er bare ikke afgjort hvad' },
  { value: 'vundet',   label: 'Vundet',   tone: 'green',
    hint: 'Aftalen er i hus' },
  { value: 'tabt',     label: 'Tabt',     tone: 'red',
    hint: 'Ingen handel' },
];

const STAGE_VALUES = PIPELINE_STAGES.map((s) => s.value);

/**
 * Logging a call outcome moves the lead along the funnel on its own — an
 * agent should never have to maintain both by hand. A stage set explicitly
 * (dragging a card on the board) is respected and not overwritten.
 */
const STAGE_FOR_OUTCOME = {
  // Alt før der er givet et tilbud, er pipeline. Tre ubesvarede opkald er
  // stadig et lead, der skal ringes op — ikke et lead, der er kommet videre.
  new:            'pipeline',
  no_answer:      'pipeline',
  emailed:        'pipeline',
  callback:       'pipeline',

  // Der HAR været en samtale, og den gik godt. Det er upside.
  interested:     'upside',
  meeting_booked: 'upside',

  not_interested: 'tabt',
  do_not_call:    'tabt',
  won:            'vundet',
  lost:           'tabt',

  // 'commit' står med vilje ikke her. Ingen udfald kan afgøre, at en kunde
  // VIL købe — det er sælgerens vurdering. Trinnet nås kun ved at trække
  // kortet, og derfor overskriver et senere udfald det heller ikke, så længe
  // udfaldet rangerer lavere.
};

module.exports = {
  INDUSTRIES,
  INDUSTRY_CATEGORIES,
  CATEGORY_VALUES,
  divisionsForCategories,
  COMPANY_FORMS,
  REGIONS,
  LEAD_STATUSES,
  TERMINAL_STATUSES,
  STATUS_VALUES,
  PIPELINE_STAGES,
  STAGE_VALUES,
  STAGE_FOR_OUTCOME,
};
