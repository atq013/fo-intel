/**
 * Database access, shared by the pipeline (writes) and the web app (reads).
 *
 * Uses Neon's HTTP driver rather than a TCP pool because the web app runs as
 * serverless functions, where a connection pool has nowhere to live between
 * invocations.
 */
import { neon } from '@neondatabase/serverless';
import type { FamilyOffice } from '@fo/core';

export type Sql = ReturnType<typeof neon>;

let client: Sql | null = null;

export function db(): Sql {
  if (!client) {
    const url = process.env.DATABASE_URL;
    if (!url) throw new Error('DATABASE_URL not set');
    client = neon(url);
  }
  return client;
}

export interface FirmRow {
  id: string;
  legal_name: string;
  firm_type: string;
  type_confidence: number;
  country: string | null;
  city: string | null;
  region: string | null;
  has_phone: boolean;
  has_email: boolean;
  has_principal: boolean;
  signal_count: number;
  latest_signal_on: string | null;
  channel_count: number;
  record: FamilyOffice;
}

export interface RetrievedChunk {
  id: string;
  firm_id: string;
  kind: string;
  field_path: string;
  content: string;
  distance: number;
  legal_name: string;
  firm_type: string;
}

/**
 * Hybrid retrieval: structured predicates narrow the candidate set, semantic
 * similarity ranks within it.
 *
 * The order matters for correctness, not just speed. "Single-family offices in
 * Texas" is a filter, not a similarity question - embeddings will happily return
 * a Californian multi-family office that reads similarly, and the user has no way
 * to tell it violated their constraint.
 */
export async function retrieve(
  embedding: number[],
  filters: {
    firmType?: string;
    country?: string;
    requireContact?: boolean;
    sinceDate?: string;
    /** Restrict to chunk kinds. Contact facts live on profile chunks, activity on signal chunks. */
    kinds?: string[];
  },
  limit = 12,
): Promise<RetrievedChunk[]> {
  const sql = db();
  const vec = `[${embedding.join(',')}]`;

  const rows = await sql`
    SELECT c.id, c.firm_id, c.kind, c.field_path, c.content,
           c.embedding <=> ${vec}::vector AS distance,
           f.legal_name, f.firm_type
    FROM firm_chunks c
    JOIN firms f ON f.id = c.firm_id
    WHERE c.embedding IS NOT NULL
      AND (${filters.firmType ?? null}::text IS NULL OR f.firm_type = ${filters.firmType ?? null})
      AND (${filters.country ?? null}::text IS NULL OR f.country = ${filters.country ?? null})
      AND (${filters.requireContact ?? false} = FALSE OR f.has_phone OR f.has_email)
      AND (${filters.sinceDate ?? null}::date IS NULL OR f.latest_signal_on >= ${filters.sinceDate ?? null}::date)
      AND (${filters.kinds ?? null}::text[] IS NULL OR c.kind = ANY(${filters.kinds ?? null}::text[]))
    ORDER BY distance ASC
    LIMIT ${limit}
  `;

  return rows as unknown as RetrievedChunk[];
}

/**
 * How many firms match the structured filters, ignoring the semantic ranking and
 * the prompt-size cap. Without this the interface cannot tell a user that more
 * results exist, and eight of twenty-two reads as "these are all of them".
 */
/**
 * Firms whose name appears in the question text.
 *
 * Looked up against the whole table rather than the retrieved set, because a
 * question naming a firm does not guarantee similarity search ranks that firm
 * highly - asked for one firm's email, retrieval will happily surface the firms
 * that actually have emails instead.
 */
export async function firmsNamedIn(question: string): Promise<FirmRow[]> {
  const sql = db();
  const asked = question.toLowerCase().replace(/[^a-z0-9]/g, '');
  if (asked.length < 6) return [];

  const rows = (await sql`SELECT * FROM firms`) as unknown as FirmRow[];
  return rows.filter((row) => {
    const bare = row.legal_name
      .toLowerCase()
      .replace(/\b(llc|ltd|limited|inc|lp|plc|corporation|corp|company|co)\b/g, '')
      .replace(/[^a-z0-9]/g, '');
    return bare.length >= 6 && asked.includes(bare);
  });
}

export async function countMatching(filters: {
  firmType?: string;
  country?: string;
  requireContact?: boolean;
  sinceDate?: string;
}): Promise<number> {
  const sql = db();
  const [row] = (await sql`
    SELECT COUNT(*)::int AS n
    FROM firms f
    WHERE (${filters.firmType ?? null}::text IS NULL OR f.firm_type = ${filters.firmType ?? null})
      AND (${filters.country ?? null}::text IS NULL OR f.country = ${filters.country ?? null})
      AND (${filters.requireContact ?? false} = FALSE OR f.has_phone OR f.has_email)
      AND (${filters.sinceDate ?? null}::date IS NULL OR f.latest_signal_on >= ${filters.sinceDate ?? null}::date)
  `) as unknown as Array<{ n: number }>;
  return row?.n ?? 0;
}

export async function getFirms(ids: string[]): Promise<FirmRow[]> {
  if (ids.length === 0) return [];
  const sql = db();
  const rows = await sql`SELECT * FROM firms WHERE id = ANY(${ids})`;
  return rows as unknown as FirmRow[];
}

export async function countFirms(): Promise<{ total: number; sfo: number; withContact: number }> {
  const sql = db();
  const [row] = (await sql`
    SELECT COUNT(*)::int AS total,
           COUNT(*) FILTER (WHERE firm_type = 'single_family_office')::int AS sfo,
           COUNT(*) FILTER (WHERE has_phone OR has_email)::int AS with_contact
    FROM firms
  `) as unknown as Array<{ total: number; sfo: number; with_contact: number }>;
  return { total: row?.total ?? 0, sfo: row?.sfo ?? 0, withContact: row?.with_contact ?? 0 };
}

export async function logQuery(entry: {
  question: string;
  retrievedIds: string[];
  claimsMade: number;
  claimsDropped: number;
  declined: boolean;
  declineReason?: string;
  latencyMs: number;
}) {
  const sql = db();
  await sql`
    INSERT INTO query_log (question, retrieved_ids, claims_made, claims_dropped, declined, decline_reason, latency_ms)
    VALUES (${entry.question}, ${entry.retrievedIds}, ${entry.claimsMade}, ${entry.claimsDropped},
            ${entry.declined}, ${entry.declineReason ?? null}, ${entry.latencyMs})
  `;
}

export async function recordRejection(entry: {
  firmId: string | null;
  firmName: string;
  fieldPath: string;
  value: string;
  reason: string;
  detectedBy: string;
}) {
  const sql = db();
  await sql`
    INSERT INTO rejected_values (firm_id, firm_name, field_path, rejected_value, reason, detected_by)
    VALUES (${entry.firmId}, ${entry.firmName}, ${entry.fieldPath}, ${entry.value}, ${entry.reason}, ${entry.detectedBy})
  `;
}
