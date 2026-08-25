# LeadBurd API — kontrakt til frontenden

Alt hvad frontenden skal bruge for at koble sig på. Er noget uklart eller
mangler et felt, så sig til frem for at gætte — det er hurtigere at tilføje i
API'et end at reparere bagefter.

**Base-URL:** sættes som `VITE_API_URL`. Alle stier nedenfor har `/api` foran,
undtagen `/health`.

---

## Kom hurtigt i gang

```ts
const res = await fetch(`${API}/api/auth/login`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ email, password }),
});
const { token, user } = await res.json();
// Gem token. Send den på hvert efterfølgende kald:
//   headers: { Authorization: `Bearer ${token}` }
```

Oprettelse er **selvbetjent**: `POST /auth/register` opretter en organisation
med brugeren som ejer, ud fra et CVR-nummer der slås op i registret. Ejeren
kan derefter tilføje kollegaer under `/api/auth/team`.

### Fejl

Alle fejl er JSON: `{ "error": "Dansk besked", "code": "MASKINKODE" }`.
`error` kan vises direkte til brugeren — teksterne er skrevet på dansk til
formålet. `code` er kun til logik.

| HTTP | Betyder |
|---|---|
| 401 | Ikke logget ind, eller token udløbet → send brugeren til `/login` |
| 403 | Logget ind, men mangler rettighed (fx sælger der prøver ejer-handling) |
| 404 | Findes ikke — **eller tilhører en anden virksomhed** (bevidst ens) |
| 429 | For mange kald. Vent. |
| 503 | `CVR_NOT_CONFIGURED` — Virk-adgang mangler på serveren |
| 504 | CVR svarede ikke i tide. Prøv igen. |

---

## Den vigtigste ting at forstå: to akser

Et lead har **to uafhængige tilstande**. Bland dem ikke sammen.

**`stage` — hvor i tragten leadet er.** Det er den her et kanban-board og et
dashboard tæller på.

`ny` → `gemt` → `kontaktet` → `i_pipeline` → `vundet` / `tabt`

**`status` — hvad der skete ved sidste opkald.**

`new`, `no_answer`, `callback`, `interested`, `meeting_booked`,
`not_interested`, `do_not_call`, `won`, `lost`

Tre gange "intet svar" er tre opkaldsudfald, men stadig ét stadie
(`kontaktet`). Derfor er de adskilt.

**Sådan hænger de sammen:**

- Logger du et udfald (`POST /leads/:id/outcome`), rykker `stage` **automatisk**
  med. Du skal ikke sætte begge.
- `stage` går aldrig baglæns af sig selv. Et lead i `i_pipeline` der får ét
  "intet svar" bliver i `i_pipeline`.
- `vundet` og `tabt` er konklusioner og slår altid igennem.
- Trækker brugeren et kort på boardet, sætter du `stage` direkte med
  `PATCH /leads/:id` — det er det ene sted stadiet må gå baglæns.

Hent de gyldige værdier og deres danske labels fra `/api/meta/options`
(`stages` og `statuses`) frem for at hardkode dem.

---

## Endpoints

### Login og brugere

| Metode | Sti | Bemærkning |
|---|---|---|
| GET | `/auth/cvr/:nummer` | Slår firmanavnet op under oprettelsen. Åbent. 30 opslag pr. 15 min. pr. IP |
| POST | `/auth/register` | `{name, cvr, email, password}` → `{token, user}`. Slår CVR-nummeret op i registret og opretter en organisation med registrets navn og brugeren som ejer. **Ét CVR-nummer kan kun bruges én gang** (409 `CVR_TAKEN`) — det er spærringen mod nye prøveperioder på samme virksomhed. Kode min. 10 tegn. Højst 5 vellykkede oprettelser pr. time pr. IP |
| POST | `/auth/login` | `{email, password}` → `{token, user}` |
| GET | `/auth/me` | Nuværende bruger |
| GET | `/auth/team` | Kollegaer (til "tildelt til"-vælgere) |
| POST | `/auth/team` | Opret bruger. **Kun ejer.** Kode min. 10 tegn |
| PATCH | `/auth/team/:id` | `{isActive}` — aktivér/deaktivér. **Kun ejer** |
| POST | `/auth/password` | `{currentPassword, newPassword}` |

`user` er `{ id, name, email, role, orgId, orgName }`. `role` er `"owner"`
eller `"agent"` — skjul ejer-funktioner for `agent`.

Token udløber efter 12 timer. Ved 401 skal brugeren logge ind igen.

### Nyregistrerede virksomheder — produktets kerne

```
GET /new-companies?days=7&size=25&page=1
```

Virksomheder registreret i CVR de seneste `days` dage, **nyeste først**.
`days` er 1–90, standard 7.

Kan kombineres med søgefiltrene nedenfor (`region`, `industryCodes`,
`zipFrom`/`zipTo`, `requirePhone`, `requireEmail`, `employeesMin`/`employeesMax`,
`companyForms`).

```jsonc
{
  "total": 166,          // hvor mange CVR matchede
  "days": 7,
  "since": "2026-08-04",
  "results": [ /* Virksomhed[], se felter nedenfor */ ],
  "excludesAdvertisingProtected": true
}
```

Hvert resultat har ekstra `ageDays` (0 = registreret i dag) og
`vatStatus: "unknown"` — se momsafsnittet.

### Søgning

```
POST /search   { filters: {...}, page: 1, size: 25 }
GET  /search/company/:cvr
GET  /meta/options
```

`/meta/options` giver brancher, regioner, selskabsformer, stadier og
statusser med danske labels. **Byg dropdowns ud fra den**, ikke ud fra
hardkodede lister.

**Filtre:**

| Felt | Type | Eksempel |
|---|---|---|
| `query` | string | Søgeord i firmanavn |
| `industryCategories` | string[] | `["sundhed","byggeri"]` — overordnede områder, se nedenfor |
| `industryCodes` | string[] | `["621000","629000"]` — 6-cifrede DB07 |
| `region` | string | `"fyn"`, `"nordjyl"` … (se options) |
| `zipFrom` / `zipTo` | number | `5000` / `5999` — slår `region` |
| `municipalities` | string[] | `["Odense"]` |
| `companyForms` | number[] | **Tal**, ikke tekst: `[80]` = ApS, `[60]` = A/S |
| `employeesMin` / `employeesMax` | number | |
| `establishedFrom` / `establishedTo` | `YYYY-MM-DD` | |
| `requirePhone` | boolean | Kun firmaer med et nummer der kan ringes op |
| `requireEmail` | boolean | Kun firmaer med en gyldig mailadresse |
| `excludeExisting` | boolean | Skjuler dem organisationen allerede har som lead |
| `includeHidden` | boolean | Viser også dem brugeren selv har skjult |

`companyForms` er **numeriske koder** — teksten "ApS" matcher ingenting i
CVR. Koderne står i `/meta/options`.

#### `excludeExisting` — hvad tallene betyder

Frasorteringen sker hos os, ikke i CVR: registret kender ikke vores database,
og en konto kan have hundredtusinder af leads, som ikke kan sendes med som
betingelse i forespørgslen.

Derfor er `total` fortsat **registrets** tal — det bliver ikke mindre af at
slå frasorteringen til. Svaret får i stedet `skjult`, som er hvor mange der
blev pillet ud af netop den side. Vis det; ellers ser en side med 16 rækker ud
som en fejl når der står 115 matcher.

Ved listeudtræk (`POST /lists`) gælder det på tværs af **alle** organisationens
lister — `ON CONFLICT` fanger kun dubletter i den samme liste. Svaret får
`skippedExisting`.

#### Skjulte virksomheder

| Metode | Sti | Bemærkning |
|---|---|---|
| POST | `/hidden` | `{cvrs:[…]}` — "vis mig ikke dem her igen" |
| DELETE | `/hidden` | `{cvrs:[…]}` for udvalgte, `{}` for alle |
| GET | `/hidden` | `{antal}` — så brugerfladen kan tilbyde at vise dem igen |

Skjulte ryger **altid** ud af søgeresultater, uanset `excludeExisting`: det var
en bevidst handling, og så skal den holde uden at man skal huske et flueben.
`includeHidden: true` beder om at se dem alligevel.

Svaret skelner mellem `skjultAfDig` og `alleredeGemt`, fordi brugeren har bedt
om de to ting forskelligt og skal kunne se hvad der skete med hvad. Er en
virksomhed begge dele, tælles den som skjult — det var den mest bevidste
handling.

#### Flere virksomheder til en liste ad gangen

`POST /lists/:id/leads` tager også `{cvrs:[…]}` i stedet for `{cvr}`. Højst 200
ad gangen, og de hentes i **ét** opslag mod registret frem for ét pr. nummer.

Svaret er fire tal — `tilføjet`, `laaAllerede`, `reklamebeskyttede`,
`ikkeFundet` — fordi forskellen mellem dem er dét brugeren spørger om, når
listen ikke voksede så meget som forventet.

### Lister (gemte udtræk)

| Metode | Sti | Bemærkning |
|---|---|---|
| GET | `/lists` | Med optælling pr. liste |
| POST | `/lists` | `{name, filters, limit}` — **kører udtrækket**, kan tage 5–30 s |
| POST | `/lists` med `{name, empty: true}` | Opretter en tom liste uden udtræk, til at samle enkelte virksomheder i |
| POST | `/lists/:id/leads` | `{cvr}` → lægger én virksomhed i listen. Slås op i registret; klientens data bruges ikke. 409-agtig adfærd: `alreadyOnList: true` hvis den lå der. 422 `ADVERTISING_PROTECTED` hvis den ikke må kontaktes |
| GET | `/lists/:id` | Liste + fordeling pr. status |
| GET | `/lists/:id/leads` | `?page=&size=&status=&assignedTo=&q=` |
| POST | `/lists/:id/refresh` | Kør filteret igen, tilføj kun nye |
| PATCH | `/lists/:id` | `{name, description, archived}` |
| DELETE | `/lists/:id` | Sletter også leads og historik |
| GET | `/lists/:id/export.csv` | `?status=` — CSV til dansk Excel |

`POST /lists` returnerer `{ list, imported, matched, truncated,
skippedAdvertisingProtected }`. `imported` < `matched` er normalt: både
reklamebeskyttede og firmaer uden brugbart telefonnummer frasorteres.

**Vis en spinner** — udtrækket kører synkront mod CVR.

### Leads og ringekø

| Metode | Sti | Bemærkning |
|---|---|---|
| GET | `/leads/next` | `?listId=&skip=1,2,3` — næste i køen |
| GET | `/leads/:id` | Lead + fuld historik |
| POST | `/leads/:id/outcome` | `{status, note?, callbackAt?, countsAsCall?}` |
| POST | `/leads/:id/notes` | `{body}` — note uden opkald |
| PATCH | `/leads/:id` | `{stage?, assignedTo?, phone?, email?, website?}` |
| GET | `/leads/callbacks` | `?scope=today\|week&mine=true` |
| POST | `/leads/:id/vat-check` | Momsopslag, se nedenfor |
| GET | `/stats` | Tal til dashboardet |

`GET /leads/next` giver `{ lead, remaining }`. `lead: null` betyder tom kø.
Rækkefølgen er: forfaldne genopkald → aldrig ringet → længst siden → størst
firma. `skip` er kommaseparerede id'er brugeren har sprunget over i denne
session.

`status: "callback"` **kræver** `callbackAt` (ISO-dato), ellers 400.

#### Brancheområder

Der er godt 800 branchekoder i DB07, og ingen kender dem udenad. Koderne er
hierarkiske — de to første cifre er hovedafdelingen — så et område er ganske
enkelt et sæt præfikser: `sundhed` = alt der begynder med 86, 87 eller 88.

Områderne hentes fra `GET /meta/options` (`industryCategories`). De dækker
**hver eneste** branchekode i registret, også dem der tilføjes senere, hvor
`industries` kun er en genvejsliste over de mest ringede.

Vælger man både et område og en enkelt kode, lægges de sammen med **ELLER**.
En virksomhed har kun én hovedbranche, så OG ville altid give nul.

> Listen kan ikke hentes fra Virk: branchekoden er indekseret som fritekst, og
> Elasticsearch afviser at aggregere over den. Præfiksopslag virker derimod.

### Moms — læs det her

Momsregistrering står **ikke** i CVR. Et CVR-nummer beviser det ikke: firmaer
under omsætningsgrænsen og momsfritagne brancher (læger, tandlæger,
undervisning, forsikring) har CVR-nummer uden momsregistrering, og store
koncerner er fællesregistrerede så datterselskabets eget nummer er inaktivt.

Vi slår det op i EU's VIES-register. Det er langsomt og hastighedsbegrænset,
så det sker **kun når brugeren beder om det** — aldrig på en hel liste.

```
POST /leads/:id/vat-check      // {} eller { "force": true }
→ { vatStatus, vatName, vatNumber, checkedAt, cached, reason? }
```

`vatStatus` har **tre** værdier:

| Værdi | Betyder | Vis som |
|---|---|---|
| `registered` | VIES bekræftede aktivt momsnummer | ✅ Momsregistreret |
| `unregistered` | VIES svarede, nummeret er ikke aktivt | ❌ Ikke momsregistreret |
| `unknown` | Ikke slået op endnu, eller opslaget fejlede | ⃝ Ikke tjekket + en knap |

**`unknown` må aldrig vises som "nej".** Det er den almindelige starttilstand
for alle leads, og VIES fejler jævnligt. Skriver vi "ikke momsregistreret" om
et firma der er det, sender vi sælgeren ind i samtalen med forkerte oplysninger.

`vatNumber` (`DK12345678`) er blot CVR-nummeret formateret som momsnummer og
siger intet om registrering — brug det til fakturering, ikke som bevis.

### Abonnement, fakturaer og admin

Alt under `/api` **undtagen** `/auth`, `/billing` og `/admin` kræver et aktivt
abonnement eller en løbende prøveperiode. Uden svarer API'et **402** med
`code: "SUBSCRIPTION_REQUIRED"`. De tre undtagelser er bevidste: kunne man ikke
nå betalingssiden uden at have betalt, var der ingen vej ud af låsen igen.

| Metode | Sti | Bemærkning |
|---|---|---|
| GET | `/billing/status` | Adgang, prøveperiode, `team`-blok med pladser og priser |
| POST | `/billing/checkout` | Starter Stripe Checkout, giver `{url}` |
| POST | `/billing/portal` | Stripes kundeportal — kort, adresse, opsigelse |
| GET | `/billing/invoices` | `{invoices, virksomhed}` — kundens egne fakturaer |
| GET | `/billing/invoices.csv` | Samme som fil, til bogføring |

Fakturaerne hentes fra Stripe ved hvert opslag frem for at ligge hos os. En
kopi kunne komme ud af trit ved en kreditnota, og så byggede kundens regnskab
på noget forkert.

**Køberens navn og momsnummer tages fra fakturaen, ikke fra vores database.**
Stripe fryser navnet fast når fakturaen udstedes, og bilaget er dét der gælder
i et regnskab. Skifter en kunde navn, skal den gamle CSV-linje stadig passe til
den gamle PDF.

CSV'en bruger semikolon og komma som decimaltegn og har en UTF-8 BOM foran —
ellers viser dansk Excel æ, ø og å som volapyk og propper alle kolonner ned i
én.

#### Admin — kun platformens ejere

| Metode | Sti | Bemærkning |
|---|---|---|
| GET | `/admin/overview` | Alle konti + `nøgletal` |
| GET | `/admin/invoices` | Seneste 50 fakturaer på tværs af kunder |

Adgangen hænger på adressen (`middleware/platformAdmin.js`), ikke på
`role: "owner"` — **`owner` er ejeren af en kundes konto**, ikke af platformen.
Uden den forskel kunne enhver kunde se alle andre.

Alle andre får **404, ikke 403**. Et 403 ville bekræfte at siden findes, og det
er der ingen grund til at fortælle. Frontenden skjuler linket ud fra
`user.platformAdmin`, men det er kun bekvemmelighed — API'et afgør adgangen ved
hvert kald.

Konti hvor ejeren er fritaget for betaling (`fritaget: true`) tælles **ikke**
med i `maanedligOmsaetning` eller `betalende`. Vores egne konti står i den
samme tabel som kundernes, og talt med ville de vise vores gratis adgang som
indtægt.

---

## Virksomhed — felter

Samme form fra `/search`, `/new-companies` og gemte leads. I gemte leads er
nøglerne `snake_case` (`owner_name`), fra CVR-søgning er de `camelCase`
(`ownerName`) — det retter vi hvis det generer.

| Felt | Type | Dækning | Bemærkning |
|---|---|---|---|
| `cvr` | string | 100% | 8 cifre |
| `name` | string | 100% | |
| `address`, `zipcode`, `city` | string | ~100% | |
| `municipality` | string | 97% | |
| `region` | string | 97% | Udledt af postnummer |
| `phone` | string \| null | ~48% på nye | Kun numre der er gyldige nu |
| `email` | string \| null | ~54% | |
| `website` | string \| null | ~12% | |
| `industryCode` / `industryText` | string | ~100% | |
| `companyType` | string | ~100% | `"APS"`, `"A/S"`, `"ENK"` … |
| `employees` | number \| null | varierer | |
| `employeesYear` | number \| null | | **Hvilket år tallet er fra** — vis det |
| `establishedOn` | `YYYY-MM-DD` | 100% | |
| `ownerName` | string \| null | **97%** | Personen at spørge efter |
| `ownerRole` | string \| null | | `"Direktør"`, `"Indehaver"`, `"Stifter"` … |
| `ownerCount` | number | | Antal personer bag firmaet |
| `purpose` | string \| null | **31%** | Formålsparagraffen |
| `capital` / `capitalCurrency` | number / string | 31% | |
| `ageDays` | number | kun `/new-companies` | 0 = registreret i dag |
| `vatStatus` | string | 100% | Se ovenfor |

`purpose` og `capital` findes kun for kapitalselskaber (ApS, A/S) — derfor
31%. Enkeltmandsvirksomheder har dem ikke. **`purpose` er bedre end
branchekoden til at kvalificere et lead** — det er firmaets egne ord om hvad
det laver. Overvej at vise den på lead-kortet.

`employeesYear` er vigtig: CVR's ansattetal kan være flere år gammelt.
"25 ansatte (2019)" er en ærlig påstand, "25 ansatte" er det ikke.

---

## Ting der IKKE kan leveres

Bygger du UI der lover det her, kan API'et ikke indfri det:

- **Momsregistrering uden opslag.** Kun on-demand, og svaret kan være `unknown`.
- **Ejer på alle firmaer.** 97% — foreninger og enkelte selskabsformer har
  ingen persondeltagere. Håndtér `null`.
- **Omsætning, resultat, regnskabstal.** Ikke i vores CVR-adgang.
- **Antal ansatte på alle.** Mange små firmaer har intet indberettet tal.
- **Dyb paginering.** Maks 10.000 resultater igennem. Ud over det skal
  søgningen indsnævres.

---

## Compliance — kan ikke slås fra

Virksomheder med **reklamebeskyttelse** i CVR har frabedt sig
markedsføringshenvendelser. Det er ulovligt at ringe til dem på baggrund af et
CVR-udtræk. De frasorteres i selve CVR-forespørgslen og igen før de gemmes —
frontenden kan ikke slå det fra, og der skal ikke bygges en knap til det.

Telefonnumre markeret hemmelige i CVR hentes heller ikke.

Det er værd at skrive tydeligt i brugerfladen, fx under søgeresultatet:
*"Virksomheder med reklamebeskyttelse frasorteres automatisk."*
