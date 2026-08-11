-- 002_lead_enrichment.sql
-- Fields the frontend's lead card shows: who to ask for, what the company
-- says it does, and whether it is actually VAT registered.

ALTER TABLE leads
  ADD COLUMN IF NOT EXISTS region            TEXT,
  ADD COLUMN IF NOT EXISTS owner_name        TEXT,
  ADD COLUMN IF NOT EXISTS owner_role        TEXT,
  ADD COLUMN IF NOT EXISTS owner_count       INTEGER,
  ADD COLUMN IF NOT EXISTS purpose           TEXT,
  ADD COLUMN IF NOT EXISTS capital           NUMERIC(14,2),
  ADD COLUMN IF NOT EXISTS capital_currency  TEXT;

-- VAT registration is NOT in the CVR feed. It is resolved on demand against
-- the EU VIES registry, so the answer is one of three states and 'unknown' is
-- a real, common answer -- never render it as "no".
--   unknown      : not looked up yet, or the lookup failed
--   registered   : VIES confirmed an active VAT number
--   unregistered : VIES answered, and the number is not active
ALTER TABLE leads
  ADD COLUMN IF NOT EXISTS vat_status      TEXT NOT NULL DEFAULT 'unknown'
    CHECK (vat_status IN ('unknown', 'registered', 'unregistered')),
  ADD COLUMN IF NOT EXISTS vat_checked_at  TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS vat_name        TEXT;

-- The core product is "companies registered in the last N days", so this
-- ordering is the one the app hits most.
CREATE INDEX IF NOT EXISTS leads_established_idx
  ON leads (org_id, established_on DESC NULLS LAST);

CREATE INDEX IF NOT EXISTS leads_region_idx ON leads (org_id, region);
