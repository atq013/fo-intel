-- fo-intel storage.
--
-- One row per firm holding the full provenance-carrying record as JSONB, plus a
-- separate chunk table for retrieval. The split matters: the customer-facing
-- record and the thing we embed are not the same object. Embedding the whole
-- record would let a semantic match on an audit note surface a firm whose
-- customer-facing cells are empty.

CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE IF NOT EXISTS firms (
  id                TEXT PRIMARY KEY,
  legal_name        TEXT NOT NULL,
  firm_type         TEXT NOT NULL,
  type_confidence   REAL NOT NULL DEFAULT 0,
  country           TEXT,
  city              TEXT,
  region            TEXT,

  -- Structured filters. Duplicated out of the JSONB so they can be indexed.
  has_phone         BOOLEAN NOT NULL DEFAULT FALSE,
  has_email         BOOLEAN NOT NULL DEFAULT FALSE,
  has_principal     BOOLEAN NOT NULL DEFAULT FALSE,
  signal_count      INTEGER NOT NULL DEFAULT 0,
  latest_signal_on  DATE,
  channel_count     INTEGER NOT NULL DEFAULT 0,

  -- The full record, cells and evidence intact.
  record            JSONB NOT NULL,

  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS firms_type_idx      ON firms (firm_type);
CREATE INDEX IF NOT EXISTS firms_country_idx   ON firms (country);
CREATE INDEX IF NOT EXISTS firms_signal_idx    ON firms (latest_signal_on DESC NULLS LAST);
CREATE INDEX IF NOT EXISTS firms_record_gin    ON firms USING gin (record jsonb_path_ops);

-- Retrieval units. Each chunk is addressable so a generated answer can cite the
-- exact span it used, and each carries the field path it came from so the
-- attribution checker can look the value back up in the record.
CREATE TABLE IF NOT EXISTS firm_chunks (
  id            TEXT PRIMARY KEY,
  firm_id       TEXT NOT NULL REFERENCES firms(id) ON DELETE CASCADE,
  kind          TEXT NOT NULL,          -- profile | thesis | signal | principal
  field_path    TEXT NOT NULL,          -- e.g. signals[2], principals[0].title
  content       TEXT NOT NULL,
  embedding     vector(1536),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS chunks_firm_idx ON firm_chunks (firm_id);

-- hnsw over cosine distance. Built after load; on an empty table it is a no-op.
CREATE INDEX IF NOT EXISTS chunks_embedding_idx
  ON firm_chunks USING hnsw (embedding vector_cosine_ops);

-- Values our own validation rejected. Kept for the audit trail and deliberately
-- NOT joined to anything the customer surface reads: a validation step that finds
-- problems but does not change what ships is measurement, not validation.
CREATE TABLE IF NOT EXISTS rejected_values (
  id            BIGSERIAL PRIMARY KEY,
  firm_id       TEXT,
  firm_name     TEXT NOT NULL,
  field_path    TEXT NOT NULL,
  rejected_value TEXT NOT NULL,
  reason        TEXT NOT NULL,
  detected_by   TEXT NOT NULL,
  detected_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Every query the deployed system answered, with what it did. Stage 2 asks for
-- evidence of what a system did while running, not what it would do.
CREATE TABLE IF NOT EXISTS query_log (
  id                BIGSERIAL PRIMARY KEY,
  question          TEXT NOT NULL,
  retrieved_ids     TEXT[] NOT NULL DEFAULT '{}',
  claims_made       INTEGER NOT NULL DEFAULT 0,
  claims_dropped    INTEGER NOT NULL DEFAULT 0,
  declined          BOOLEAN NOT NULL DEFAULT FALSE,
  decline_reason    TEXT,
  latency_ms        INTEGER,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
