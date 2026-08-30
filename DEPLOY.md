# Deployment — lysmera-api

Denne service er API'et alene. Frontenden (`lysmera-web`) deployes for sig og
kalder herind over CORS.

---

## Railway

1. **New Project → Deploy from GitHub repo** → `lysmera-api`.
2. **New → Database → PostgreSQL** i samme projekt.

Build og start læses fra `railway.json`:

```
start:  npm run start:prod     (migrations, derefter serveren)
health: /health
```

Migrations kører ved hver deploy. De er idempotente (`IF NOT EXISTS` +
`schema_migrations`), så en gen-deploy uden nye migrations gør ingenting.

### Variabler

| Variabel | Værdi |
|---|---|
| `DATABASE_URL` | `${{Postgres.DATABASE_URL}}` — Railway-reference, ikke en kopieret streng |
| `JWT_SECRET` | Ny, tilfældig værdi. **Ikke** den fra din lokale `.env` |
| `CORS_ORIGINS` | Frontendens adresse, fx `https://lysmera-web.pages.dev` |
| `VIRK_USERNAME` | Virk Distribution-brugeren |
| `VIRK_PASSWORD` | Virk Distribution-adgangskoden |
| `NODE_ENV` | `production` |

```bash
node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
```

Serveren **nægter at starte** uden `JWT_SECRET`. Uden `CORS_ORIGINS` starter
den, men advarer i loggen — og frontenden vil være blokeret af browseren.

> **`CORS_ORIGINS` skal være den nøjagtige origin**: skema + værtsnavn, ingen
> sti, ingen skråstreg til sidst. `https://app.lysmera.dk` — ikke
> `https://app.lysmera.dk/`.

### Første bruger

Railway kører ikke seed automatisk. Efter første deploy, kør én gang lokalt mod
produktionsdatabasen (hent `DATABASE_PUBLIC_URL` fra Railway):

```bash
DATABASE_URL="<DATABASE_PUBLIC_URL>" \
  npm run seed -- --org "Kundens Firma ApS" --name "Navn" --email dem@firma.dk
```

Kommandoen printer en genereret adgangskode. Giv den videre ad en anden kanal
end e-mail, og bed dem skifte den ved første login.

### Test at det virker

```
GET https://<service>.up.railway.app/health
→ {"status":"ok","db":true,"cvr":"virk"}
```

`"cvr":"cvrapi-fallback"` betyder at `VIRK_*` mangler — udtræk svarer 503.

---

## Rækkefølgen når begge dele skal op

De to services peger på hinanden, så første deploy er en hønen-og-ægget-situation:

1. Deploy **API'et** først. Noter adressen.
2. Byg og deploy **frontenden** med `VITE_API_URL=<api-adressen>`.
3. Sæt `CORS_ORIGINS=<frontend-adressen>` på API'et. Railway genstarter selv.

Skifter en af adresserne senere, skal det tilsvarende trin gøres om.
`VITE_API_URL` bages ind i frontendens bundle på byggetidspunktet — den kan
ikke ændres uden et nyt build.

---

## Fejlsøgning

**Frontenden viser fejl ved hvert kald, men API'et svarer fint i browseren.**
CORS. Tjek at `CORS_ORIGINS` matcher frontendens origin præcist. Serverloggen
skriver ved opstart hvad den tillader.

**`/health` svarer `degraded`, `db:false`.** `DATABASE_URL` peger forkert, eller
databasen er ikke oppe. Brug Railway-referencen frem for en kopieret streng —
adgangskoden roteres.

**Udtræk svarer 503.** `VIRK_USERNAME`/`VIRK_PASSWORD` mangler på servicen.

**Søgning giver 0 hits på en branche du ved findes.** Branchekoden er
sandsynligvis en udgået DB07-kode. Se afsnittet om faldgruber i `README.md`.

---

## Noter

- **Kør `npm run verify` før hver deploy** — 58 tjek mod en rigtig database.
- **`embedded-postgres`** er en devDependency, kun til `npm run db:local` og
  `npm run verify`. Den henter en PostgreSQL-binær ved install, hvilket gør
  Railway-builds langsommere. Bliver det generende, kan udviklingsdatabasen
  flyttes til et separat værktøj.
- Databasen indeholder virksomhedsdata og opkaldsnoter. Slå **backups** til på
  Railway-Postgres'en før I lægger rigtige kunder ind.
