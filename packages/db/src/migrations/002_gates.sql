-- M2 · Gate results, the release chokepoint, and the two specialised claim kinds.
--
-- `run_id` here is a plain TEXT column, not a foreign key. s2_run arrives in M3.
-- 003 adds the references once it exists rather than reordering the roadmap's
-- migration contents to suit dependency order.

-- ------------------------------------------------------ validation results

-- One row per gate per claim per run. Every Band A gate writes a row even after
-- an earlier gate has already failed the claim, because a first-failure-only
-- record costs a full 500-record re-run to find the second defect.
CREATE TABLE IF NOT EXISTS s2_validation_result (
  id         TEXT PRIMARY KEY,
  claim_id   TEXT NOT NULL REFERENCES s2_claim(id) ON DELETE CASCADE,
  run_id     TEXT,
  gate       TEXT NOT NULL CHECK (gate IN (
               'schema','attribution','value_type','identity','contact_ownership',
               'coherence','conflict','freshness','commercial','copy')),

  -- PTC-2: a gate that did not run never counts as a gate that passed. `skipped`
  -- is a distinct outcome and carries its reason in `detail`.
  outcome    TEXT NOT NULL CHECK (outcome IN ('passed','failed','skipped','error')),
  band       CHAR(1) NOT NULL DEFAULT 'A' CHECK (band IN ('A','B')),

  detail     TEXT,

  -- What the claim would have been had this gate not fired. This is the only
  -- thing that distinguishes a load-bearing validator from a decorative one:
  -- a gate whose counterfactual is always identical to the outcome is doing
  -- nothing, and the evaluation in §11 reads this column to say so.
  counterfactual JSONB,

  evaluated_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- a gate runs at most once per claim per run
  UNIQUE (claim_id, run_id, gate)
);

CREATE INDEX IF NOT EXISTS s2_validation_claim_idx   ON s2_validation_result (claim_id);
CREATE INDEX IF NOT EXISTS s2_validation_outcome_idx ON s2_validation_result (gate, outcome);

-- ------------------------------------------------------- release decisions

-- The audit trail of the single chokepoint. Spec §5: no released claim exists
-- without a row here naming the gates that ran.
CREATE TABLE IF NOT EXISTS s2_release_decision (
  id             TEXT PRIMARY KEY,
  claim_id       TEXT NOT NULL REFERENCES s2_claim(id) ON DELETE CASCADE,
  run_id         TEXT,
  decision       TEXT NOT NULL CHECK (decision IN ('released','quarantined','held')),
  gates_passed   TEXT[] NOT NULL DEFAULT '{}',
  gates_failed   TEXT[] NOT NULL DEFAULT '{}',
  gates_skipped  TEXT[] NOT NULL DEFAULT '{}',

  -- Policy is versioned data, not code. When the standard tightens, previously
  -- released claims are re-evaluated on the next run and can be demoted -- which
  -- is what makes release a pipeline rather than a boolean.
  policy_version TEXT NOT NULL,
  reason         TEXT,
  decided_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS s2_release_claim_idx ON s2_release_decision (claim_id, decided_at DESC);

-- --------------------------------------------------------------- contacts

-- Reachability is a hard bar in the brief, so a contact is not an ordinary claim
-- with a string in it. `reaches` is never inferred from the shape of an address:
-- Stage 1 shipped three info@ inboxes as principals' email precisely because
-- shape was treated as sufficient.
CREATE TABLE IF NOT EXISTS s2_contact (
  id                    TEXT PRIMARY KEY,
  entity_id             TEXT NOT NULL REFERENCES s2_entity(id),
  person_claim_id       TEXT REFERENCES s2_claim(id),
  channel               TEXT NOT NULL CHECK (channel IN ('email','phone','linkedin','postal')),
  value                 TEXT NOT NULL,

  reaches               TEXT NOT NULL DEFAULT 'unknown'
                        CHECK (reaches IN ('individual','team','company','unknown')),

  -- The evidence that the route belongs to the named person, as opposed to
  -- evidence that the route exists. Null means unevidenced, and unevidenced
  -- never counts toward the 200.
  ownership_evidence_id TEXT REFERENCES s2_evidence(id),
  verification_method   TEXT,
  verified_at           TIMESTAMPTZ,
  status                TEXT NOT NULL DEFAULT 'candidate'
                        CHECK (status IN ('candidate','validated','released','stale','quarantined')),

  -- ADR-11: which of the two reachability readings this route supports. A
  -- verified profile sets profile_assisted only; a person-owned phone or mailbox
  -- sets both. Stored per route so either metric is recomputable from the file.
  counts_strict           BOOLEAN NOT NULL DEFAULT FALSE,
  counts_profile_assisted BOOLEAN NOT NULL DEFAULT FALSE,

  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- A route counts only when it reaches an individual AND ownership is evidenced.
  -- Enforced here so the reachability count cannot be inflated by a writer that
  -- forgets the second half of the rule.
  CONSTRAINT s2_contact_counts_need_ownership CHECK (
    (NOT counts_strict AND NOT counts_profile_assisted)
    OR (reaches = 'individual' AND ownership_evidence_id IS NOT NULL)
  ),
  -- Strict excludes profiles by definition; a profile can only ever be
  -- profile-assisted. This is the boundary the two metrics turn on.
  CONSTRAINT s2_contact_profile_not_strict CHECK (
    NOT (counts_strict AND channel = 'linkedin')
  ),

  UNIQUE (entity_id, channel, value)
);

CREATE INDEX IF NOT EXISTS s2_contact_entity_idx  ON s2_contact (entity_id);
CREATE INDEX IF NOT EXISTS s2_contact_reach_idx   ON s2_contact (counts_strict, counts_profile_assisted)
  WHERE status = 'released';

-- ---------------------------------------------------------------- signals

-- Dated activity. Append-only and never re-verified: an event that happened on a
-- date does not stop having happened, so re-checking it would burn budget for no
-- truth gain. Freshness applies to the record's signal coverage, not to the rows.
CREATE TABLE IF NOT EXISTS s2_signal (
  id           TEXT PRIMARY KEY,
  entity_id    TEXT NOT NULL REFERENCES s2_entity(id),
  kind         TEXT NOT NULL,
  summary      TEXT NOT NULL,
  occurred_at  TIMESTAMPTZ NOT NULL,
  evidence_id  TEXT REFERENCES s2_evidence(id),
  source_tier  SMALLINT NOT NULL CHECK (source_tier BETWEEN 1 AND 4),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (entity_id, kind, occurred_at, summary)
);

CREATE INDEX IF NOT EXISTS s2_signal_entity_idx ON s2_signal (entity_id, occurred_at DESC);
