# LeadBurd — API

Backend til LeadBurd: udtræk af virksomheder fra CVR-registret og
telemarketing-arbejdsgangen ovenpå (ringekø, status, noter, genopkald).

Brugerfladen ligger i et andet repo: **`leadburd-web`**.

---

## Kom i gang

```bash
npm install
cp .env.example .env      # udfyld JWT_SECRET og VIRK_*
npm run db:local          # PostgreSQL, i sin egen terminal
npm run migrate           # opret tabellerne
npm run seed -- --org "Dit Firma ApS" --name "Lucca" --email lucca@firma.dk
npm run dev               # API på :4000
```

`npm run seed` printer en genereret adgangskode hvis du ikke selv angiver
`--password`.

`npm run db:local` starter en rigtig PostgreSQL uden at installere noget — den
henter selv serveren første gang og gemmer data i `.localdb/`. Kun til
udvikling; i produktion bruges Railway-databasen.

### Test

```bash
npm run verify
```

Starter en midlertidig database, kører migrations og driver hele API'et
igennem over HTTP: login, udtræk, ringekø, genopkald, CSV og adskillelsen
mellem virksomheder. CVR-kilden stubbes, så Virk-adgang ikke er nødvendig.
58 tjek — alle skal være grønne før noget deployes.

---

## Miljøvariabler

| Variabel | Krævet | Hvad den gør |
|---|---|---|
| `JWT_SECRET` | ja | Signerer login-tokens. Serveren nægter at starte uden. |
| `DATABASE_URL` | ja | PostgreSQL. |
| `CORS_ORIGINS` | i produktion | Frontendens adresse(r), kommasepareret. Uden den blokerer browseren alt fra frontenden. |
| `VIRK_USERNAME` / `VIRK_PASSWORD` | til udtræk | Virk Distribution. |
| `EXCLUDE_ADVERTISING_PROTECTED` | nej | Default `true` — lad den stå. |
| `PORT` | nej | Default 4000. |

---

## CVR-adgang

**Virk Distribution** (`distribution.virk.dk`) er Erhvervsstyrelsens
system-til-system-adgang til hele CVR-registret. Det er den eneste kilde der
kan filtrere på branche, geografi og størrelse — altså den eneste der kan lave
et rigtigt lead-udtræk. Gratis, men login ansøges hos Erhvervsstyrelsen.

Uden `VIRK_*` kører API'et videre, men søgning og udtræk svarer
`503 CVR_NOT_CONFIGURED`, og enkeltopslag falder tilbage på **cvrapi.dk**
(gratis, ét firma ad gangen, ingen filtrering).

### Faldgruber i Virk-indekset

Kortlagt mod det rigtige register — hver af dem kostede en fejlsøgning:

- **De fleste tekstfelter er `text`, ikke `keyword`.** Et `terms`-opslag
  returnerer derfor **0 hits uden at fejle**. Brug `anyPhrase()` (match_phrase).
  Gælder `sammensatStatus`, `kortBeskrivelse`, `kommuneNavn`. `branchekode`
  virker med `terms`, fordi cifre overlever analysen.
- **Selskabsform filtreres på den numeriske `virksomhedsformkode`**, ikke
  teksten. 10 ENK · 15 PMV · 30 I/S · 40 K/S · 60 A/S · 70 P/S · 80 ApS ·
  81 IVS.
- **Feltet `nyesteAntalAnsatte` findes ikke.** Ansattetal ligger i fire
  felter, ingen af dem komplette (`nyesteErstMaanedsbeskaeftigelse` er frisk
  men dækker 300k af 2,26 mio.; `nyesteAarsbeskaeftigelse` er ældre men dækker
  908k). Vi læser det friskeste der findes og filtrerer på tværs af alle fire.
- **DB07-branchekoder er blevet revideret.** Gamle koder sidder stadig på
  ophørte firmaer, så en forældet kode returnerer tomt i stedet for at fejle.
  Tilføjer du en kode til `config/cvrOptions.js`, så tjek først at den giver
  hits sammen med et aktiv-status-filter.
- **`requirePhone` kræver efterfiltrering.** CVR gemmer hvert nummer et firma
  nogensinde har haft, med gyldighedsperiode. Elasticsearch kan ikke se
  forskel, så ~10% af et resultatsæt har kun numre der udløb for tyve år siden.
  `applyPostFilters()` fjerner dem efter normalisering.

### Reklamebeskyttelse — vigtigt

CVR markerer virksomheder der har frabedt sig reklamehenvendelser
(`reklamebeskyttet`). Man må ikke bruge CVR-data til markedsføring mod dem.
De frasorteres to steder: i selve Elasticsearch-forespørgslen (`must_not`) og
igen lige før leads gemmes. Klienten kan **ikke** slå det fra — det kræver
`EXCLUDE_ADVERTISING_PROTECTED=false` på serveren.

Telefonnumre markeret `hemmelig` hentes heller ikke ind.

---

## Arkitektur

```
server.js               Express: monterer /api, CORS mod frontenden
db.js                   pg-pool + transaction()
middleware/auth.js      JWT; sætter req.user og req.orgId
routes/
  auth.js               login, /me, team
  search.js             CVR-preview + enkeltopslag + /meta/options
  lists.js              ringelister: opret (udtræk), opdatér, CSV-eksport
  leads.js              ringekø, opkaldsresultater, noter, genopkald, /stats
services/
  cvrService.js         Virk Elasticsearch-adapter + cvrapi.dk-fallback
  filterSchema.js       validering af søgefiltre (én kilde for alle ruter)
  csv.js                CSV til dansk Excel (BOM + semikolon)
config/cvrOptions.js    brancher, selskabsformer, regioner, statusser
migrations/             SQL, køres af scripts/migrate.js
```

**Multi-tenant:** alt kundedata har `org_id`, og hver eneste forespørgsel
filtrerer på `req.orgId`. Ingen rute kan tilgå en anden organisations data —
det er dækket af tests i `npm run verify`.

**Lead-status:** `new → no_answer / callback / interested / meeting_booked →
won / lost`, plus `not_interested` og `do_not_call`. De sidste fire er
terminale og falder ud af ringekøen.

**Ringekøens rækkefølge:** forfaldne genopkald først, derefter aldrig-ringede,
derefter dem der er gået længst tid siden — og til sidst størst virksomhed
først. Rækken låses med `FOR UPDATE`, så to sælgere i samme kø ikke kan
overskrive hinandens resultat.

---

## Endpoints

| Metode | Sti | Hvad |
|---|---|---|
| POST | `/api/auth/login` | Log ind → `{ token, user }` |
| GET | `/api/auth/me` | Nuværende bruger |
| GET/POST/PATCH | `/api/auth/team` | Kollegaer (POST/PATCH kræver ejer) |
| GET | `/api/meta/options` | Brancher, regioner, selskabsformer, statusser |
| POST | `/api/search` | Preview af et filter (paged, maks 10.000 dybde) |
| GET | `/api/search/company/:cvr` | Enkeltopslag |
| GET/POST | `/api/lists` | Lister; POST kører udtrækket |
| POST | `/api/lists/:id/refresh` | Kør det gemte filter igen, tilføj nye |
| GET | `/api/lists/:id/leads` | Paged, filtrerbar på status/søgeord |
| GET | `/api/lists/:id/export.csv` | CSV-eksport |
| GET | `/api/leads/next` | Næste lead i ringekøen |
| POST | `/api/leads/:id/outcome` | Log opkaldsresultat (+ note, + genopkald) |
| POST | `/api/leads/:id/notes` | Note uden opkald |
| PATCH | `/api/leads/:id` | Tildel kollega, ret kontaktinfo |
| GET | `/api/leads/callbacks?scope=today\|week` | Genopkald |
| GET | `/api/stats` | Tal til overblikket |
| GET | `/health` | `{ status, db, cvr }` |
