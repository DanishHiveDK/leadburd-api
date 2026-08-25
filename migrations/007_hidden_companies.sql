-- Virksomheder en organisation ikke vil se igen.
--
-- Adskilt fra `leads`, fordi det betyder noget andet: et lead er nogen man vil
-- tale med, en skjult virksomhed er nogen man har set og valgt fra. Lå de i
-- samme tabel med en særlig status, ville hver optælling af leads skulle huske
-- at trække dem fra.
--
-- Kun CVR-nummeret gemmes. Navnet står i registret, og en kopi her ville blive
-- forældet uden at nogen opdagede det.
CREATE TABLE IF NOT EXISTS hidden_companies (
  org_id      INTEGER     NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  cvr         TEXT        NOT NULL,
  hidden_by   INTEGER     REFERENCES users(id) ON DELETE SET NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (org_id, cvr)
);

-- Opslaget er altid "hvilke af disse numre har org X skjult", og det dækker
-- primærnøglen allerede.
