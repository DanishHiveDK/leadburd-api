-- "Kontaktet på mail" som selvstændigt udfald.
--
-- Sælgerne skriver til nogle virksomheder frem for at ringe, og indtil nu
-- måtte det registreres som et opkald eller slet ikke. Begge dele er forkerte:
-- det første forurener opkaldsstatistikken, det andet efterlader intet spor af
-- at virksomheden faktisk er kontaktet.
--
-- Udfaldet er IKKE terminalt. Man skriver typisk først og ringer bagefter, så
-- leadet skal blive i køen.

-- Begrænsningerne er skrevet uden navn i 001, så Postgres har selv fundet på
-- et. Det slås op frem for at blive gættet — hedder den noget andet i et miljø,
-- ville et gæt fejle stille og efterlade databaserne forskellige.
DO $$
DECLARE
  navn TEXT;
BEGIN
  SELECT conname INTO navn
    FROM pg_constraint
   WHERE conrelid = 'leads'::regclass
     AND contype  = 'c'
     AND pg_get_constraintdef(oid) LIKE '%no_answer%';

  IF navn IS NOT NULL THEN
    EXECUTE format('ALTER TABLE leads DROP CONSTRAINT %I', navn);
  END IF;
END $$;

ALTER TABLE leads
  ADD CONSTRAINT leads_status_check CHECK (status IN (
    'new', 'no_answer', 'callback', 'interested',
    'meeting_booked', 'not_interested', 'do_not_call',
    'won', 'lost', 'emailed'));

-- En mail er sin egen slags aktivitet. Den kunne have været gemt som en note,
-- men så kunne historikken ikke skelne "jeg skrev til dem" fra "jeg noterede
-- noget", og de to ting betyder ikke det samme når man samler op ugen efter.
DO $$
DECLARE
  navn TEXT;
BEGIN
  SELECT conname INTO navn
    FROM pg_constraint
   WHERE conrelid = 'lead_activities'::regclass
     AND contype  = 'c'
     AND pg_get_constraintdef(oid) LIKE '%status_change%';

  IF navn IS NOT NULL THEN
    EXECUTE format('ALTER TABLE lead_activities DROP CONSTRAINT %I', navn);
  END IF;
END $$;

ALTER TABLE lead_activities
  ADD CONSTRAINT lead_activities_type_check CHECK (type IN (
    'call', 'note', 'status_change', 'callback', 'email'));

-- Hvornår virksomheden sidst blev kontaktet ad nogen kanal. `last_called_at`
-- rører vi ikke: den betyder opkald, og skulle den også dække mails, ville
-- "hvornår ringede vi sidst" ikke længere kunne besvares.
--
-- Køen sorterer efter den, så en virksomhed man lige har skrevet til, ikke
-- ligger øverst igen sekundet efter.
ALTER TABLE leads
  ADD COLUMN IF NOT EXISTS last_contacted_at TIMESTAMPTZ;

-- Bagudrettet: alt hvad der er ringet til, er også kontaktet.
UPDATE leads
   SET last_contacted_at = last_called_at
 WHERE last_called_at IS NOT NULL
   AND last_contacted_at IS NULL;

CREATE INDEX IF NOT EXISTS leads_last_contacted_idx
  ON leads (org_id, last_contacted_at NULLS FIRST);
