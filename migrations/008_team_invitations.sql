-- 008_team_invitations.sql
-- Invitationer til et team.
--
-- Før denne tabel var den eneste vej ind i et team, at ejeren oprettede
-- brugeren med en adgangskode og sagde den videre. Det virker, men ejeren
-- kender så kollegaens kode, og den bliver sjældent skiftet. En invitation
-- vender det om: ejeren skriver navn og e-mail, og den inviterede vælger selv
-- sin adgangskode når hun siger ja.
--
-- Invitationen er knyttet til en e-mailADRESSE, ikke til en bruger. Den
-- inviterede har typisk ingen konto endnu, og hvis hun har, er det hendes
-- adresse — ikke hendes bruger-id — ejeren kender.

CREATE TABLE IF NOT EXISTS team_invitations (
  id            SERIAL PRIMARY KEY,
  org_id        INTEGER     NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  email         TEXT        NOT NULL,
  name          TEXT        NOT NULL,
  role          TEXT        NOT NULL DEFAULT 'agent' CHECK (role IN ('owner', 'agent')),

  -- Hemmeligheden i linket. Unik, så et opslag på token alene er nok, og
  -- lang nok til at den ikke kan gættes.
  token         TEXT        NOT NULL UNIQUE,

  -- pending → accepted | declined | revoked. Ingen CHECK på udløb: en udløbet
  -- invitation bliver stående som 'pending' og filtreres fra på expires_at,
  -- så ejeren stadig kan se at hun blev inviteret og aldrig svarede.
  status        TEXT        NOT NULL DEFAULT 'pending'
                CHECK (status IN ('pending', 'accepted', 'declined', 'revoked')),

  invited_by    INTEGER     REFERENCES users(id) ON DELETE SET NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  responded_at  TIMESTAMPTZ,
  expires_at    TIMESTAMPTZ NOT NULL DEFAULT NOW() + INTERVAL '14 days'
);

-- Én åben invitation ad gangen per adresse per organisation. Uden den ville et
-- utålmodigt dobbeltklik lave to invitationer, og den inviterede få to beskeder
-- om det samme. Afviste og tilbagekaldte tæller ikke med — man skal kunne
-- invitere igen efter et nej.
CREATE UNIQUE INDEX IF NOT EXISTS team_invitations_open_key
  ON team_invitations (org_id, LOWER(email))
  WHERE status = 'pending';

-- Den inviteredes eget opslag: "er der noget til mig?" ved hvert login.
CREATE INDEX IF NOT EXISTS team_invitations_email_idx
  ON team_invitations (LOWER(email))
  WHERE status = 'pending';

CREATE INDEX IF NOT EXISTS team_invitations_org_idx
  ON team_invitations (org_id, created_at DESC);
