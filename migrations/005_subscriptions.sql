-- 005_subscriptions.sql
-- Abonnementstilstand per organisation.
--
-- Stripe ejer sandheden om betalingen; det her er en kopi vi kan spørge til
-- på hvert API-kald uden at ringe til Stripe. Den holdes opdateret af
-- webhooken.
--
-- `subscription_status` er Stripes egne værdier ordret (trialing, active,
-- past_due, canceled, incomplete, unpaid ...). Der er med vilje ingen CHECK:
-- Stripe kan finde på at tilføje en status, og en afvist INSERT i webhooken
-- ville betyde at vi holdt op med at følge med i virkeligheden.

ALTER TABLE organizations
  ADD COLUMN IF NOT EXISTS stripe_customer_id     TEXT,
  ADD COLUMN IF NOT EXISTS stripe_subscription_id TEXT,
  ADD COLUMN IF NOT EXISTS subscription_status    TEXT,
  ADD COLUMN IF NOT EXISTS current_period_end     TIMESTAMPTZ;

CREATE UNIQUE INDEX IF NOT EXISTS organizations_stripe_customer_key
  ON organizations (stripe_customer_id)
  WHERE stripe_customer_id IS NOT NULL;

-- De organisationer der findes NU, er oprettet før der var noget at betale
-- for. Uden denne linje ville betalingsmuren låse jeres egen konto og alle
-- beta-brugere ude i samme sekund som den blev udrullet.
UPDATE organizations
   SET subscription_status = 'active'
 WHERE subscription_status IS NULL;
