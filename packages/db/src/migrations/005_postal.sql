-- M5 · Postal reachability, as a third metric that never merges with the others.
--
-- Companies House publishes each director's service address: the address at
-- which they personally accept service of documents. Adjudicated (see
-- collect/uk-director-address.ts) it is a route to a named individual, and it is
-- none of the things the brief excludes -- not a shared inbox, not a contact
-- form, not a switchboard, not an address generated from a naming pattern.
--
-- It is also commercially weaker than a phone or a personal email, and a
-- reviewer recomputing our reachable count would be entitled to disagree that a
-- postal address is a usable route. So it is stored and reported as its own
-- figure. Folding it into `strict_reachable` would raise the headline number by
-- changing what the headline means, which is the label inflation this whole
-- contract exists to prevent.
--
-- ADR-12 records the reasoning.

ALTER TABLE s2_entity
  ADD COLUMN IF NOT EXISTS postal_reachable BOOLEAN NOT NULL DEFAULT FALSE;

ALTER TABLE s2_contact
  ADD COLUMN IF NOT EXISTS counts_postal BOOLEAN NOT NULL DEFAULT FALSE;

CREATE INDEX IF NOT EXISTS s2_entity_postal_idx ON s2_entity (postal_reachable);

DO $$
BEGIN
  -- A postal route can never be strict. Strict means a direct line or personal
  -- mailbox; the database refuses the combination rather than trusting callers.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 's2_contact_postal_not_strict') THEN
    ALTER TABLE s2_contact
      ADD CONSTRAINT s2_contact_postal_not_strict
      CHECK (NOT (counts_strict AND channel = 'postal'));
  END IF;

  -- Nor can it be profile-assisted: that metric is strict plus verified personal
  -- profiles under assumption A1, and a postal address is neither.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 's2_contact_postal_not_assisted') THEN
    ALTER TABLE s2_contact
      ADD CONSTRAINT s2_contact_postal_not_assisted
      CHECK (NOT (counts_profile_assisted AND channel = 'postal'));
  END IF;

  -- Same ownership rule as the other metrics: a route counts only when it
  -- reaches an individual AND that ownership is evidenced.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 's2_contact_postal_needs_ownership') THEN
    ALTER TABLE s2_contact
      ADD CONSTRAINT s2_contact_postal_needs_ownership
      CHECK (NOT counts_postal OR (reaches = 'individual' AND ownership_evidence_id IS NOT NULL));
  END IF;
END $$;
