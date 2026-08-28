-- 009_pipeline_forecast.sql
-- Pipelinen skifter fra en aktivitetsstige til en prognosestige.
--
-- Før:  ny -> gemt -> kontaktet -> i_pipeline -> vundet/tabt
--       Trinnene beskrev, HVOR MEGET man havde gjort ved et lead.
--
-- Nu:   pipeline -> upside -> commit -> vundet/tabt
--       Trinnene beskriver, HVOR SANDSYNLIGT et salg er:
--         pipeline  skal ringes op
--         upside    talt med, tilbud givet, virker interesseret
--         commit    de vil købe — det er bare ikke afgjort hvad
--
-- Det er ikke en omdøbning. "Ny", "Gemt" og "Kontaktet" beskrev tre grader af
-- kontakt, men i en prognose betyder de det samme: der er ikke givet et tilbud
-- endnu. De lægges derfor sammen i pipeline. Antallet af kolonner falder fra
-- seks til fem, og de tre første bliver til én.
--
-- 'commit' får ingen leads ved overgangen. Ingen af de gamle trin svarer til
-- "de vil købe" — det er en vurdering, en sælger foretager, og den kan ikke
-- udledes af hvad der er sket indtil nu. Kolonnen starter tom, og leads
-- flyttes derind ved at trække kortet.

-- Betingelsen skal væk, før de nye værdier kan skrives; ellers afvises
-- opdateringen af den gamle CHECK.
ALTER TABLE leads DROP CONSTRAINT IF EXISTS leads_stage_check;
ALTER TABLE leads ALTER COLUMN stage DROP DEFAULT;

UPDATE leads SET stage = CASE
  -- Tre grader af "ikke talt ordentligt med dem endnu" bliver til én.
  WHEN stage IN ('ny', 'gemt', 'kontaktet') THEN 'pipeline'
  -- 'i_pipeline' blev sat af udfaldene 'interesseret' og 'møde booket'.
  -- Det er præcis definitionen på upside.
  WHEN stage = 'i_pipeline'                 THEN 'upside'
  ELSE stage
END
WHERE stage IN ('ny', 'gemt', 'kontaktet', 'i_pipeline');

ALTER TABLE leads ALTER COLUMN stage SET DEFAULT 'pipeline';

ALTER TABLE leads ADD CONSTRAINT leads_stage_check
  CHECK (stage IN ('pipeline', 'upside', 'commit', 'vundet', 'tabt'));

-- Indekset fra 003 dækker stadig (org_id, stage) og skal ikke røres.
