-- M3 · The operating record.
--
-- The brief asks for complete run logs across a 48-hour unattended window, and
-- for evidence that the system handled a real dependency failure and a real
-- staleness event. Those are claims about behaviour, so they need rows that were
-- written while the behaviour happened -- not a narrative composed afterwards.

-- -------------------------------------------------------------------- runs

CREATE TABLE IF NOT EXISTS s2_run (
  id                 TEXT PRIMARY KEY,

  -- `schedule` is the one that counts toward the operating window. A run that
  -- was triggered by hand cannot evidence unattended operation, so the trigger
  -- is recorded rather than assumed.
  trigger            TEXT NOT NULL CHECK (trigger IN ('schedule','manual','retry')),
  job                TEXT NOT NULL CHECK (job IN ('discover','refresh','contract','evaluate')),

  started_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  ended_at           TIMESTAMPTZ,
  status             TEXT NOT NULL DEFAULT 'running'
                     CHECK (status IN ('running','completed','failed','halted_budget','aborted')),

  records_touched    INTEGER NOT NULL DEFAULT 0,
  claims_created     INTEGER NOT NULL DEFAULT 0,
  claims_released    INTEGER NOT NULL DEFAULT 0,
  claims_quarantined INTEGER NOT NULL DEFAULT 0,

  -- Failures are kept on the run even when handled, because a failure the system
  -- absorbed silently is exactly what the operating evidence needs to show.
  failures_json      JSONB NOT NULL DEFAULT '[]'::jsonb,
  cost_json          JSONB NOT NULL DEFAULT '{}'::jsonb,

  git_sha            TEXT,
  policy_version     TEXT
);

CREATE INDEX IF NOT EXISTS s2_run_started_idx ON s2_run (started_at DESC);
CREATE INDEX IF NOT EXISTS s2_run_window_idx  ON s2_run (job, started_at DESC) WHERE trigger = 'schedule';

-- ------------------------------------------------------------ decision log

-- Every consequential decision, one row, with the state on both sides of it.
-- before_json/after_json exist so a reviewer can reconstruct what changed
-- without trusting the `reason` text -- the reason is written by the same code
-- that made the decision and is therefore the least reliable column here.
CREATE TABLE IF NOT EXISTS s2_decision_log (
  id          TEXT PRIMARY KEY,
  run_id      TEXT REFERENCES s2_run(id),
  entity_id   TEXT REFERENCES s2_entity(id),
  claim_id    TEXT REFERENCES s2_claim(id) ON DELETE CASCADE,

  kind        TEXT NOT NULL CHECK (kind IN (
                'release','quarantine','supersede','merge','stale','refresh',
                'classify','contact_verify','budget_halt','source_circuit','retry')),
  rule        TEXT NOT NULL,
  before_json JSONB,
  after_json  JSONB,
  reason      TEXT NOT NULL,
  at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS s2_decision_run_idx    ON s2_decision_log (run_id, at);
CREATE INDEX IF NOT EXISTS s2_decision_kind_idx   ON s2_decision_log (kind, at DESC);
CREATE INDEX IF NOT EXISTS s2_decision_entity_idx ON s2_decision_log (entity_id, at DESC);

-- ------------------------------------------- close the M2 forward references

-- M2 wrote run_id as bare TEXT because s2_run did not exist yet. Now it does.
-- Guarded because migrations re-run: ADD CONSTRAINT has no IF NOT EXISTS.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 's2_validation_result_run_fk') THEN
    ALTER TABLE s2_validation_result
      ADD CONSTRAINT s2_validation_result_run_fk FOREIGN KEY (run_id) REFERENCES s2_run(id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 's2_release_decision_run_fk') THEN
    ALTER TABLE s2_release_decision
      ADD CONSTRAINT s2_release_decision_run_fk FOREIGN KEY (run_id) REFERENCES s2_run(id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 's2_extraction_event_run_fk') THEN
    ALTER TABLE s2_extraction_event
      ADD CONSTRAINT s2_extraction_event_run_fk FOREIGN KEY (run_id) REFERENCES s2_run(id);
  END IF;
END $$;
