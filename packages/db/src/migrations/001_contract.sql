-- M1 · The claim/evidence contract.
--
-- Everything here exists to make one Stage 1 defect unexpressible: a value
-- shipped wearing evidence that belongs to a different fact. That happened
-- because evidence was an assignable field, so `build-dataset.ts:144` could copy
-- a firm's classification quote onto nine unrelated values at assembly time.
--
-- Here the binding is an identity relationship the database enforces, not a
-- convention the writer is trusted to follow.
--
-- Stage 1 tables (firms, firm_chunks, rejected_values, query_log) are left in
-- place. Nothing in this migration touches them.

-- ---------------------------------------------------------------- sources

CREATE TABLE IF NOT EXISTS s2_source (
  id                    TEXT PRIMARY KEY,
  kind                  TEXT NOT NULL,
  identifier            TEXT NOT NULL,
  base_url              TEXT,
  -- 1 statutory or the firm itself · 2 recognised press · 3 aggregator · 4 unranked
  tier                  SMALLINT NOT NULL CHECK (tier BETWEEN 1 AND 4),
  rate_limit_per_min    INTEGER NOT NULL DEFAULT 30,
  last_ok_at            TIMESTAMPTZ,
  consecutive_failures  INTEGER NOT NULL DEFAULT 0,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (kind, identifier)
);

-- ----------------------------------------------------------- observations

-- What a source returned, at a time. Immutable once written.
-- content_hash is how decay is detected: re-fetching and getting the same hash
-- means nothing changed; a different hash is a concrete, evidence-based reason
-- to re-extract. A clock alone never satisfies the staleness requirement.
CREATE TABLE IF NOT EXISTS s2_observation (
  id            TEXT PRIMARY KEY,
  source_id     TEXT NOT NULL REFERENCES s2_source(id),
  url           TEXT NOT NULL,
  fetched_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  content_hash  TEXT NOT NULL,
  raw_ref       TEXT,
  http_status   INTEGER,
  notes         TEXT
);

CREATE INDEX IF NOT EXISTS s2_observation_url_idx  ON s2_observation (url, fetched_at DESC);
CREATE INDEX IF NOT EXISTS s2_observation_hash_idx ON s2_observation (content_hash);

-- -------------------------------------------------------------- entities

CREATE TABLE IF NOT EXISTS s2_entity (
  id               TEXT PRIMARY KEY,
  canonical_name   TEXT NOT NULL,
  entity_type      TEXT NOT NULL DEFAULT 'unconfirmed',
  first_seen_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  merged_into_id   TEXT REFERENCES s2_entity(id),

  -- Trust and commercial sufficiency are different questions with different
  -- remedies. A firm can be entirely trustworthy and still too thin to sell;
  -- conflating them sends us hunting for evidence defects in records whose only
  -- fault is thinness.
  trust_state      TEXT NOT NULL DEFAULT 'active'
                   CHECK (trust_state IN ('active','merged','quarantined','retired')),
  commercial_state TEXT NOT NULL DEFAULT 'unassessed'
                   CHECK (commercial_state IN ('qualifying','withheld','unassessed')),

  -- ADR-11: two reachability metrics, never merged. Assumption A1 (a verified
  -- personal profile is a route) is a judgement a reviewer may not share, and the
  -- count swings ~60 to ~160 on it. Both are stored so either reading is checkable.
  strict_reachable            BOOLEAN NOT NULL DEFAULT FALSE,
  profile_assisted_reachable  BOOLEAN NOT NULL DEFAULT FALSE,

  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS s2_entity_state_idx ON s2_entity (trust_state, commercial_state);
CREATE INDEX IF NOT EXISTS s2_entity_reach_idx ON s2_entity (strict_reachable, profile_assisted_reachable);

-- ------------------------------------------------------ extraction events

-- One act of reading one observation and deriving assertions from it.
-- A claim and its establishing evidence are written inside one event, in one
-- transaction. This row is the thing they share.
CREATE TABLE IF NOT EXISTS s2_extraction_event (
  id              TEXT PRIMARY KEY,
  run_id          TEXT,
  observation_id  TEXT NOT NULL REFERENCES s2_observation(id),
  extractor       TEXT NOT NULL,
  started_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  ended_at        TIMESTAMPTZ
);

-- ---------------------------------------------------------------- claims

CREATE TABLE IF NOT EXISTS s2_claim (
  id                  TEXT PRIMARY KEY,
  entity_id           TEXT NOT NULL REFERENCES s2_entity(id),
  extraction_event_id TEXT NOT NULL REFERENCES s2_extraction_event(id),
  field               TEXT NOT NULL,
  value_json          JSONB NOT NULL,
  value_type          TEXT NOT NULL,

  -- No `withheld` here on purpose: commercial sufficiency is judged on the
  -- entity, not the claim.
  status              TEXT NOT NULL DEFAULT 'candidate'
                      CHECK (status IN ('candidate','validated','released','stale','quarantined','retired')),

  confidence          REAL NOT NULL DEFAULT 0 CHECK (confidence BETWEEN 0 AND 1),
  refresh_policy      TEXT NOT NULL DEFAULT 'statutory'
                      CHECK (refresh_policy IN ('statutory','volatile','append_only','derived')),
  established_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at          TIMESTAMPTZ,
  superseded_by_id    TEXT REFERENCES s2_claim(id),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- the target of the composite FK below
  UNIQUE (id, extraction_event_id)
);

CREATE INDEX IF NOT EXISTS s2_claim_entity_idx  ON s2_claim (entity_id, field);
CREATE INDEX IF NOT EXISTS s2_claim_status_idx  ON s2_claim (status);
CREATE INDEX IF NOT EXISTS s2_claim_expiry_idx  ON s2_claim (expires_at) WHERE status = 'released';

-- -------------------------------------------------------------- evidence

CREATE TABLE IF NOT EXISTS s2_evidence (
  id                  TEXT PRIMARY KEY,
  claim_id            TEXT NOT NULL REFERENCES s2_claim(id) ON DELETE CASCADE,
  observation_id      TEXT NOT NULL REFERENCES s2_observation(id),
  extraction_event_id TEXT NOT NULL REFERENCES s2_extraction_event(id),

  role                TEXT NOT NULL
                      CHECK (role IN ('establishing','corroborating','conflicting','superseding')),

  span_text           TEXT NOT NULL,
  span_start          INTEGER,
  span_end            INTEGER,
  -- the sentence a customer reads. Must describe what was actually checked.
  method              TEXT NOT NULL,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- PTC-10, enforced in the schema rather than in review.
  --
  -- This column is the extraction event ONLY for establishing rows, NULL for
  -- every other role. The composite foreign key below therefore applies only to
  -- establishing evidence (a FK with a NULL component is not enforced under the
  -- default MATCH SIMPLE), and forces it to share its claim's extraction event.
  --
  -- Corroborating and conflicting evidence attach freely afterwards, which they
  -- must -- a second source agreeing next week is normal. They simply cannot
  -- masquerade as the thing that established the value.
  establishing_event_id TEXT GENERATED ALWAYS AS
    (CASE WHEN role = 'establishing' THEN extraction_event_id END) STORED,

  FOREIGN KEY (claim_id, establishing_event_id)
    REFERENCES s2_claim (id, extraction_event_id)
);

-- Exactly one establishing row per claim.
CREATE UNIQUE INDEX IF NOT EXISTS s2_evidence_one_establishing
  ON s2_evidence (claim_id) WHERE role = 'establishing';

CREATE INDEX IF NOT EXISTS s2_evidence_claim_idx ON s2_evidence (claim_id, role);
