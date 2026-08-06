-- 001_init.sql - LeadBurd core schema.
-- Every table that holds customer data carries org_id; all queries filter on it.

-- -- Tenants ------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS organizations (
  id          SERIAL PRIMARY KEY,
  name        TEXT        NOT NULL,
  cvr         TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS users (
  id             SERIAL PRIMARY KEY,
  org_id         INTEGER     NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  email          TEXT        NOT NULL,
  password_hash  TEXT        NOT NULL,
  name           TEXT        NOT NULL,
  -- owner: manages users + all lists. agent: works the call queue.
  role           TEXT        NOT NULL DEFAULT 'agent' CHECK (role IN ('owner', 'agent')),
  is_active      BOOLEAN     NOT NULL DEFAULT TRUE,
  last_login_at  TIMESTAMPTZ,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
-- Case-insensitive uniqueness: login lowercases before lookup.
CREATE UNIQUE INDEX IF NOT EXISTS users_email_lower_key ON users (LOWER(email));
CREATE INDEX IF NOT EXISTS users_org_idx ON users (org_id);

-- -- Saved searches -> lead lists ----------------------------------------------
CREATE TABLE IF NOT EXISTS lead_lists (
  id           SERIAL PRIMARY KEY,
  org_id       INTEGER     NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name         TEXT        NOT NULL,
  description  TEXT,
  -- The CVR search criteria that produced the list, so it can be re-run later.
  filters      JSONB       NOT NULL DEFAULT '{}'::jsonb,
  created_by   INTEGER     REFERENCES users(id) ON DELETE SET NULL,
  archived_at  TIMESTAMPTZ,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS lead_lists_org_idx ON lead_lists (org_id, archived_at);

-- -- Leads --------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS leads (
  id                    SERIAL PRIMARY KEY,
  org_id                INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  list_id               INTEGER NOT NULL REFERENCES lead_lists(id)   ON DELETE CASCADE,

  -- Snapshot of the CVR record at import time
  cvr                   TEXT    NOT NULL,
  name                  TEXT    NOT NULL,
  address               TEXT,
  zipcode               TEXT,
  city                  TEXT,
  municipality          TEXT,
  phone                 TEXT,
  email                 TEXT,
  website               TEXT,
  industry_code         TEXT,
  industry_text         TEXT,
  company_type          TEXT,
  employees             INTEGER,
  employees_interval    TEXT,
  established_on        DATE,
  -- CVR "Reklamebeskyttelse": the company has opted out of marketing
  -- approaches. Never call these - kept only so the exclusion is auditable.
  advertising_protected BOOLEAN NOT NULL DEFAULT FALSE,
  raw                   JSONB,

  -- Telemarketing workflow
  status                TEXT    NOT NULL DEFAULT 'new' CHECK (status IN (
                          'new', 'no_answer', 'callback', 'interested',
                          'meeting_booked', 'not_interested', 'do_not_call',
                          'won', 'lost')),
  assigned_to           INTEGER REFERENCES users(id) ON DELETE SET NULL,
  call_count            INTEGER NOT NULL DEFAULT 0,
  last_called_at        TIMESTAMPTZ,
  next_callback_at      TIMESTAMPTZ,

  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
-- Re-running a saved search must not duplicate rows within the same list.
CREATE UNIQUE INDEX IF NOT EXISTS leads_list_cvr_key ON leads (list_id, cvr);
CREATE INDEX IF NOT EXISTS leads_queue_idx    ON leads (org_id, list_id, status);
CREATE INDEX IF NOT EXISTS leads_callback_idx ON leads (org_id, next_callback_at)
  WHERE next_callback_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS leads_assigned_idx ON leads (org_id, assigned_to);

-- -- Call log / notes ---------------------------------------------------------
CREATE TABLE IF NOT EXISTS lead_activities (
  id          SERIAL PRIMARY KEY,
  org_id      INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  lead_id     INTEGER NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  user_id     INTEGER REFERENCES users(id) ON DELETE SET NULL,
  type        TEXT    NOT NULL CHECK (type IN ('call', 'note', 'status_change', 'callback')),
  -- Status the call resulted in, when type = 'call'
  outcome     TEXT,
  body        TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS lead_activities_lead_idx ON lead_activities (lead_id, created_at DESC);
CREATE INDEX IF NOT EXISTS lead_activities_org_idx  ON lead_activities (org_id, created_at DESC);
