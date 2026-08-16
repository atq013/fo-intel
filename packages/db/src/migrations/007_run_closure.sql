-- 007 · A run must be able to say it does not know.
--
-- `finish()` is the only code path that ends a run, and it writes the end time
-- and the four counters in one statement. A process killed by SIGKILL never
-- reaches it, so its row stays in `running` with the counters at their default
-- of 0. Those orphans were later closed by hand:
--
--   UPDATE s2_run SET status='aborted', ended_at=now() WHERE status='running'
--
-- That writes an end time and leaves the counters alone, so the row ends up
-- asserting two things nothing observed: that the run stopped at the moment of
-- the cleanup, and that it did no work. In the submitted operating-window export
-- one `contract` row records a 74-hour duration against a 40-minute maximum
-- across the 108 completed runs carrying log lines (109 completed rows in all;
-- `run_m1_demo` has none), and a `discover` row reports zero quarantines
-- beside a quarantine decision in the same record.
--
-- The schema is why it could not say anything else. There was nowhere to put a
-- closure time, nowhere to put a reason, and the counters were NOT NULL DEFAULT
-- 0 -- so "we never found out" had to be written as a number. This migration
-- makes the honest answer expressible.

-- ------------------------------------------------------- administrative closure

-- When the row was closed out of band. Deliberately NOT `ended_at`: one says
-- when the run stopped, the other when we stopped waiting for it. Collapsing
-- them is the defect this migration exists to make impossible.
ALTER TABLE s2_run ADD COLUMN IF NOT EXISTS closed_at TIMESTAMPTZ;

-- Why it was closed. A row closed silently is indistinguishable from a run that
-- ended on its own terms, which is how all seven historical rows read: none of
-- them records why it stopped.
ALTER TABLE s2_run ADD COLUMN IF NOT EXISTS close_reason TEXT;

-- ------------------------------------------------------------------ counters

-- Unknown is not zero.
--
-- These were NOT NULL DEFAULT 0, which made two different states impossible to
-- tell apart: a `contract` run that legitimately evaluated nothing, and a run
-- killed before it could write what it did. Roughly forty runs of the first kind
-- sit in the export next to seven of the second, all reading `0`. No validation
-- rule can separate them while the column cannot hold NULL, so this is the fix
-- rather than a tidy-up.
--
-- DROP NOT NULL and DROP DEFAULT are both no-ops when already applied, so this
-- migration stays re-runnable.
ALTER TABLE s2_run ALTER COLUMN records_touched    DROP NOT NULL;
ALTER TABLE s2_run ALTER COLUMN records_touched    DROP DEFAULT;
ALTER TABLE s2_run ALTER COLUMN claims_created     DROP NOT NULL;
ALTER TABLE s2_run ALTER COLUMN claims_created     DROP DEFAULT;
ALTER TABLE s2_run ALTER COLUMN claims_released    DROP NOT NULL;
ALTER TABLE s2_run ALTER COLUMN claims_released    DROP DEFAULT;
ALTER TABLE s2_run ALTER COLUMN claims_quarantined DROP NOT NULL;
ALTER TABLE s2_run ALTER COLUMN claims_quarantined DROP DEFAULT;

-- --------------------------------------------------------------- constraints
--
-- Added NOT VALID on purpose.
--
-- The seven historical rows violate all three, and they are submitted evidence:
-- correcting them here would rewrite the record this fix exists to describe. NOT
-- VALID enforces every future write while leaving the existing rows exactly as
-- they were exported, which is the same choice the codebase makes elsewhere --
-- keep the wrong thing visible, stop it happening again.
--
-- Wrapped in DO blocks because ADD CONSTRAINT has no IF NOT EXISTS and
-- migrations re-run.

-- One exhaustive rule per status, rather than three overlapping ones.
--
-- An earlier draft asserted only that the two timestamps were mutually
-- exclusive, that a closure had a reason, and that a terminal run had one time
-- or the other. Those three together still admit `status='aborted'` with an
-- `ended_at` -- which is the exact shape of the seven historical rows, so the
-- constraint would have permitted the defect it was written for.
--
-- Stating it per status closes that. Each branch is exhaustive, so there is no
-- combination left to slip through:
--
--   running    no outcome time of either kind, and no closure reason
--   aborted    closed_at AND a non-empty close_reason, and never ended_at
--   otherwise  ended_at, and never closed_at or close_reason
--
-- `otherwise` is completed / failed / halted_budget: every state the code writes
-- through `finish()`, which observes the end and records it.
--
-- Two details that look pedantic and are not:
--
-- `close_reason IS NOT NULL AND length(btrim(close_reason)) > 0` -- the IS NOT
-- NULL is load-bearing. A CHECK constraint passes when its expression evaluates
-- to NULL, so `length(btrim(close_reason)) > 0` alone would admit a NULL reason:
-- btrim(NULL) is NULL, length(NULL) is NULL, NULL > 0 is NULL, and NULL passes.
-- The explicit test makes the conjunction false instead. And btrim means an
-- empty or whitespace reason is refused as well, because '' satisfies NOT NULL
-- while telling a reader nothing.
--
-- `close_reason IS NULL` on the other two branches -- a reason is only meaningful
-- beside a closure. Left unconstrained, a completed run could carry one, which
-- would read as though it had been closed out of band when it ended on its own.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 's2_run_outcome_times') THEN
    ALTER TABLE s2_run ADD CONSTRAINT s2_run_outcome_times
      CHECK (
        CASE status
          WHEN 'running' THEN ended_at IS NULL AND closed_at IS NULL
                              AND close_reason IS NULL
          WHEN 'aborted' THEN ended_at IS NULL AND closed_at IS NOT NULL
                              AND close_reason IS NOT NULL
                              AND length(btrim(close_reason)) > 0
          ELSE                ended_at IS NOT NULL AND closed_at IS NULL
                              AND close_reason IS NULL
        END
      ) NOT VALID;
  END IF;
END $$;

-- Rows closed out of band, for the operations view and for the lifecycle audit.
CREATE INDEX IF NOT EXISTS s2_run_closed_idx ON s2_run (closed_at DESC) WHERE closed_at IS NOT NULL;
