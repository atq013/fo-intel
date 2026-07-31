-- M6 · Validation-result identity includes the policy version.
--
-- The scheduled `contract` run failed with:
--   duplicate key value violates unique constraint "s2_validation_result_pkey"
--   Key (id)=(vr_cl_267acf16-..._schema) already exists.
--
-- Two defects, and the second is the one that made the first fatal.
--
-- 1. The id was `vr_<claimId>_<gate>`. It carried no policy version, so
--    re-judging the same claim under a new standard collided with the verdict
--    recorded under the old one.
--
-- 2. The INSERT said `ON CONFLICT (claim_id, run_id, gate)` -- a DIFFERENT
--    constraint from the primary key. The upsert could therefore never catch a
--    primary-key collision. It looked like it handled duplicates and did not.
--
-- The fix keeps every historical verdict. `policy_version` becomes part of the
-- identity, so a claim judged under 2025-07-30.1 and again under 2025-07-31.1
-- holds two rows and the earlier one is never overwritten. That history is the
-- point: it is what shows a claim was quarantined under one standard and
-- re-admitted under the next, which is a demotion/re-admission audit trail
-- rather than a value that silently changed.
--
-- Re-running the SAME policy version still upserts, so a repeated run is
-- idempotent without destroying anything.

ALTER TABLE s2_validation_result
  ADD COLUMN IF NOT EXISTS policy_version TEXT;

-- Everything written before this migration was judged under the first policy.
UPDATE s2_validation_result
   SET policy_version = '2025-07-30.1'
 WHERE policy_version IS NULL;

ALTER TABLE s2_validation_result
  ALTER COLUMN policy_version SET NOT NULL;

DO $$
DECLARE
  old_name TEXT;
BEGIN
  -- Replace UNIQUE (claim_id, run_id, gate). Keying on run_id meant a re-run
  -- under the same policy created a new row rather than updating the verdict,
  -- while the primary key forbade exactly that. The two rules contradicted each
  -- other; policy version is the honest key.
  SELECT conname INTO old_name
    FROM pg_constraint
   WHERE conrelid = 's2_validation_result'::regclass
     AND contype = 'u'
     AND pg_get_constraintdef(oid) LIKE '%claim_id, run_id, gate%';

  IF old_name IS NOT NULL THEN
    EXECUTE format('ALTER TABLE s2_validation_result DROP CONSTRAINT %I', old_name);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 's2_validation_result'::regclass
       AND conname = 's2_validation_result_claim_gate_policy_key'
  ) THEN
    -- Deduplicate before the constraint lands: rows written across different
    -- runs under the same policy are the same verdict recorded twice. The most
    -- recent evaluation wins.
    DELETE FROM s2_validation_result a
     USING s2_validation_result b
     WHERE a.claim_id = b.claim_id
       AND a.gate = b.gate
       AND a.policy_version = b.policy_version
       AND (a.evaluated_at, a.id) < (b.evaluated_at, b.id);

    ALTER TABLE s2_validation_result
      ADD CONSTRAINT s2_validation_result_claim_gate_policy_key
      UNIQUE (claim_id, gate, policy_version);
  END IF;
END $$;

-- Reading the current verdict means "latest policy version", so index for it.
CREATE INDEX IF NOT EXISTS s2_validation_policy_idx
  ON s2_validation_result (claim_id, gate, policy_version DESC);
