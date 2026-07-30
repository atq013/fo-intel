-- M4 · Checkpoints.
--
-- Operating infrastructure, not a contract change: nothing here touches claims,
-- evidence or the release path.
--
-- GitHub Actions kills a job at its timeout, free-tier quotas run out mid-run,
-- and the budget guard halts deliberately at 80%. In all three cases the run
-- stops somewhere in the middle of a source. Without a checkpoint the next run
-- restarts that source from the beginning, which costs the same API calls again
-- and -- because discovery is ordered -- means the tail of a long source list
-- may never be reached at all.
--
-- The checkpoint is per (job, source), not per run: the point is for the NEXT
-- run to resume where the last one stopped.

CREATE TABLE IF NOT EXISTS s2_checkpoint (
  id           TEXT PRIMARY KEY,
  job          TEXT NOT NULL,
  source_id    TEXT NOT NULL REFERENCES s2_source(id),

  -- Opaque to this table; the collector defines what it means. For Companies
  -- House it is the last company number completed.
  cursor       TEXT,

  -- Written only after the unit's writes have committed, so a cursor always
  -- points at work that is durably done. A cursor written before the write
  -- would silently skip a unit on resume -- a data-loss bug that looks like
  -- normal operation.
  units_done   INTEGER NOT NULL DEFAULT 0,
  last_run_id  TEXT REFERENCES s2_run(id),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),

  UNIQUE (job, source_id)
);

CREATE INDEX IF NOT EXISTS s2_checkpoint_job_idx ON s2_checkpoint (job, source_id);

-- Structured log lines, kept in the database as well as in the Actions log.
-- Actions logs expire and are awkward to query; the brief asks for complete run
-- logs for a 48-hour window and for evidence of specific events inside it.
CREATE TABLE IF NOT EXISTS s2_run_log (
  id        BIGSERIAL PRIMARY KEY,
  run_id    TEXT NOT NULL REFERENCES s2_run(id),
  at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  level     TEXT NOT NULL CHECK (level IN ('debug','info','warn','error')),
  event     TEXT NOT NULL,
  detail    JSONB
);

CREATE INDEX IF NOT EXISTS s2_run_log_run_idx   ON s2_run_log (run_id, at);
CREATE INDEX IF NOT EXISTS s2_run_log_level_idx ON s2_run_log (level, at DESC) WHERE level IN ('warn','error');
