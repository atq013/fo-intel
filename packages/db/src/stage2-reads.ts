import { db } from './index.js';

/**
 * Stage 2 read paths for the deployed app.
 *
 * These use the web app's existing Neon client rather than `connect.ts`.
 * `connect.ts` installs a global undici dispatcher to work around a resolver
 * fault on the development machine; on Vercel that fault does not exist, and
 * calling setGlobalDispatcher inside a serverless function would change fetch
 * behaviour for the whole request handler to fix a problem it does not have.
 */

export interface RunRow {
  id: string; job: string; trigger: string; status: string;
  started_at: string; ended_at: string | null;
  records_touched: number; claims_created: number;
  claims_released: number; claims_quarantined: number;
  git_sha: string | null;
}

export async function recentRuns(limit = 20): Promise<RunRow[]> {
  return (await db()`
    SELECT id, job, trigger, status, started_at, ended_at, records_touched,
           claims_created, claims_released, claims_quarantined, git_sha
    FROM s2_run ORDER BY started_at DESC LIMIT ${limit}`) as unknown as RunRow[];
}

export interface ContractStats {
  entities: number; qualifying: number;
  claims: number; released: number; quarantined: number; held: number;
  strictReachable: number; profileAssistedReachable: number; postalReachable: number;
  scheduledRuns: number; windowHours: number | null;
}

export async function contractStats(): Promise<ContractStats> {
  // Reachability is counted over QUALIFYING, unmerged entities only.
  //
  // It used to count every row with the flag set, so a withheld record or a
  // merged duplicate carrying a route inflated the figure: the page showed 68
  // strict and 369 profile-assisted against a file holding 67 and 368. Small,
  // and exactly the kind of number a reviewer recomputes from the export and
  // finds does not match the product.
  const [e] = (await db()`
    SELECT count(*) FILTER (WHERE merged_into_id IS NULL)::int total,
           count(*) FILTER (WHERE merged_into_id IS NULL AND commercial_state = 'qualifying')::int qualifying,
           count(*) FILTER (WHERE merged_into_id IS NULL AND commercial_state = 'qualifying'
                              AND strict_reachable)::int strict,
           count(*) FILTER (WHERE merged_into_id IS NULL AND commercial_state = 'qualifying'
                              AND profile_assisted_reachable)::int assisted,
           count(*) FILTER (WHERE merged_into_id IS NULL AND commercial_state = 'qualifying'
                              AND postal_reachable)::int postal
    FROM s2_entity`) as unknown as Array<Record<string, number>>;

  const [c] = (await db()`
    SELECT count(*)::int total,
           count(*) FILTER (WHERE status = 'released')::int released,
           count(*) FILTER (WHERE status = 'quarantined')::int quarantined,
           count(*) FILTER (WHERE status = 'candidate')::int held
    FROM s2_claim`) as unknown as Array<Record<string, number>>;

  // The operating window is measured from scheduled runs only. A manual
  // dispatch cannot evidence unattended operation, so it is excluded here
  // rather than quietly counted.
  const [w] = (await db()`
    SELECT count(*)::int n,
           EXTRACT(EPOCH FROM (max(started_at) - min(started_at))) / 3600 AS hours
    FROM s2_run WHERE trigger = 'schedule'`) as unknown as Array<{ n: number; hours: number | null }>;

  return {
    entities: e?.total ?? 0,
    qualifying: e?.qualifying ?? 0,
    strictReachable: e?.strict ?? 0,
    profileAssistedReachable: e?.assisted ?? 0,
    postalReachable: e?.postal ?? 0,
    claims: c?.total ?? 0,
    released: c?.released ?? 0,
    quarantined: c?.quarantined ?? 0,
    held: c?.held ?? 0,
    scheduledRuns: w?.n ?? 0,
    windowHours: w?.hours != null ? Math.round(Number(w.hours) * 10) / 10 : null,
  };
}

export interface GateRow { gate: string; outcome: string; n: number }

export async function gateOutcomes(): Promise<GateRow[]> {
  // The CURRENT verdict per claim and gate. Once a policy bump re-judges the
  // file, every claim holds a row per version; counting them all would report
  // each claim once per standard it has ever been judged under.
  return (await db()`
    SELECT gate, outcome, count(*)::int n FROM (
      SELECT DISTINCT ON (claim_id, gate) gate, outcome
      FROM s2_validation_result
      ORDER BY claim_id, gate, policy_version DESC
    ) latest
    GROUP BY 1, 2 ORDER BY 1, 2`) as unknown as GateRow[];
}

export interface DecisionRow {
  kind: string; rule: string; reason: string; at: string; entity_id: string | null;
}

/** The staleness and demotion events the operating window has to evidence. */
export async function recentDecisions(limit = 25): Promise<DecisionRow[]> {
  return (await db()`
    SELECT kind, rule, reason, at, entity_id FROM s2_decision_log
    WHERE kind IN ('stale', 'quarantine', 'release', 'budget_halt', 'source_circuit')
    ORDER BY at DESC LIMIT ${limit}`) as unknown as DecisionRow[];
}

export interface QuarantineRow {
  field: string; value: string; failed: string; reason: string; canonical_name: string;
}

/**
 * What the gates refused, and why. This is the part of the product a customer
 * cannot get elsewhere: not the records that passed, but the specific defects
 * that were caught before they shipped.
 */
export async function recentQuarantines(limit = 25): Promise<QuarantineRow[]> {
  // A claim that failed two gates has two validation rows, so joining directly
  // fans the claim out into duplicate lines. The detail is aggregated into one
  // string instead — a reader wants one row per refused value, listing every
  // reason it was refused.
  return (await db()`
    SELECT c.field,
           left(c.value_json #>> '{}', 60) AS value,
           array_to_string(rd.gates_failed, ', ') AS failed,
           left((
             SELECT string_agg(vr.detail, ' · ' ORDER BY vr.gate)
             FROM s2_validation_result vr
             WHERE vr.claim_id = c.id AND vr.outcome IN ('failed', 'error')
           ), 140) AS reason,
           e.canonical_name
    FROM s2_claim c
    JOIN s2_release_decision rd ON rd.claim_id = c.id
    JOIN s2_entity e ON e.id = c.entity_id
    WHERE c.status = 'quarantined'
    ORDER BY rd.decided_at DESC LIMIT ${limit}`) as unknown as QuarantineRow[];
}
