-- 004_org_cvr_unique.sql
-- Én prøveperiode per virksomhed.
--
-- Uden en nøgle knyttet til virkeligheden kan den samme virksomhed tage en ny
-- gratis periode hver gang den forrige udløber: en ny mailadresse koster
-- ingenting. CVR-nummeret er den nøgle. Det slås op i registret ved
-- oprettelsen, så et opdigtet nummer ikke slipper igennem, og indekset her
-- sikrer at det kun kan bruges én gang.
--
-- Indekset er partielt: organisationer oprettet før dette (og alle der måtte
-- blive oprettet i hånden med seed-scriptet) har cvr = NULL, og flere NULL
-- må gerne findes side om side.

CREATE UNIQUE INDEX IF NOT EXISTS organizations_cvr_key
  ON organizations (cvr)
  WHERE cvr IS NOT NULL;
