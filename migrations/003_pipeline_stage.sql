-- 003_pipeline_stage.sql
-- Two axes, not one.
--
-- The frontend thinks in PIPELINE STAGES: where a lead sits in the funnel
-- (Ny -> Gemt -> Kontaktet -> I pipeline -> Vundet/Tabt). That is what a
-- kanban board and a dashboard count.
--
-- The call queue thinks in CALL OUTCOMES: what happened on the last attempt
-- (intet svar, ring igen, interesseret...). Several outcomes map to the same
-- stage -- "intet svar" three times running is still "Kontaktet".
--
-- Collapsing them into one column would lose information either way, so both
-- are stored. `status` (the outcome) already exists; `stage` is added here and
-- is kept in step with it by the API.

ALTER TABLE leads
  ADD COLUMN IF NOT EXISTS stage TEXT NOT NULL DEFAULT 'ny'
    CHECK (stage IN ('ny', 'gemt', 'kontaktet', 'i_pipeline', 'vundet', 'tabt'));

-- Backfill from the outcomes recorded before this split existed.
UPDATE leads SET stage = CASE
  WHEN status = 'won'                                THEN 'vundet'
  WHEN status IN ('lost', 'not_interested',
                  'do_not_call')                     THEN 'tabt'
  WHEN status IN ('interested', 'meeting_booked')    THEN 'i_pipeline'
  WHEN status IN ('no_answer', 'callback')           THEN 'kontaktet'
  WHEN call_count > 0                                THEN 'kontaktet'
  ELSE 'ny'
END
WHERE stage = 'ny';

CREATE INDEX IF NOT EXISTS leads_stage_idx ON leads (org_id, stage);
