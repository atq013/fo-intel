import { db, shortlist, type ShortlistQuery } from '@fo/db';

/**
 * The agent's tools (spec §8).
 *
 * Every tool returns `{ data, scope, excluded, limits }`. **Scope is mandatory.**
 * It is what lets the agent state in its answer what was searched and what was
 * left out — which Correction 8 requires of every user-visible sentence, and
 * which Stage 1 failed at when it silently answered a narrower question than the
 * one asked.
 *
 * Every tool reads **released claims only**. Candidate, held, quarantined and
 * withheld data is not reachable from here. That is not a filter the agent
 * applies and could forget; it is the only data these queries select.
 */

export interface ToolResult<T> {
  data: T;
  /** what was searched and what matched */
  scope: Record<string, unknown>;
  /** what was deliberately left out, and why */
  excluded: Array<{ reason: string; count: number }>;
  /** what this tool cannot tell you, stated rather than implied */
  limits: string[];
}

export const TOOL_SCHEMAS = [
  {
    name: 'search_firms',
    description:
      'Shortlist firms over released claims, ranked on fit, evidence, freshness and reachability. ' +
      'Returns why each matched and what it is missing.',
    input_schema: {
      type: 'object' as const,
      properties: {
        q: { type: 'string', description: 'substring match on firm name; NOT semantic' },
        requireStrictReachable: { type: 'boolean', description: 'a route reaching a named individual, profiles excluded' },
        requireProfileAssisted: { type: 'boolean', description: 'as above, counting verified personal profiles (assumption A1)' },
        requiredFields: { type: 'array', items: { type: 'string' }, description: 'e.g. ["principal.fullName","principal.phone"]' },
        freshWithinDays: { type: 'number' },
        maxSourceTier: { type: 'number', description: '1 statutory/self, 2 press, 3 aggregator, 4 unranked' },
        limit: { type: 'number' },
      },
    },
  },
  {
    name: 'get_firm',
    description: "One firm's released claims with the evidence span establishing each. Cannot invent absent fields.",
    input_schema: {
      type: 'object' as const,
      properties: { entityId: { type: 'string' } },
      required: ['entityId'],
    },
  },
  {
    name: 'count_matching',
    description: 'Exact count of firms matching a filter. Never an estimate.',
    input_schema: {
      type: 'object' as const,
      properties: {
        requireStrictReachable: { type: 'boolean' },
        requireProfileAssisted: { type: 'boolean' },
        requiredFields: { type: 'array', items: { type: 'string' } },
      },
    },
  },
  {
    name: 'check_evidence',
    description: 'The gate outcomes and evidence for one claim. Asserts nothing beyond what the gates recorded.',
    input_schema: {
      type: 'object' as const,
      properties: { entityId: { type: 'string' }, field: { type: 'string' } },
      required: ['entityId'],
    },
  },
];

export async function search_firms(input: ShortlistQuery): Promise<ToolResult<unknown>> {
  const r = await shortlist({ ...input, limit: Math.min(input.limit ?? 10, 25) });
  return {
    data: r.results.map((x) => ({
      entityId: x.entityId, name: x.name, score: x.score,
      strictReachable: x.strictReachable, profileAssistedReachable: x.profileAssistedReachable,
      contact: x.contact ?? null, matched: x.matched, missing: x.missing,
      lastObservedAt: x.lastObservedAt, bestSourceTier: x.bestSourceTier,
    })),
    scope: {
      searched: r.scope.searched,
      matched: r.scope.matched,
      returned: r.scope.returned,
      appliedFilters: r.scope.appliedFilters,
      // Spelled out because a model that reads the array length as "the number
      // of firms" understates the answer. Observed doing exactly that: it
      // reported 10 (the page size) when 24 matched.
      countNote:
        `${r.scope.matched} firms matched; the data array holds only the top ${r.scope.returned}. ` +
        `Report ${r.scope.matched} as the count, never the array length.`,
    },
    excluded: r.scope.excluded,
    limits: r.limits,
  };
}

export async function get_firm(input: { entityId: string }): Promise<ToolResult<unknown>> {
  const sql = db();
  const rows = (await sql`
    SELECT c.field, c.value_json #>> '{}' AS value, c.value_type, c.confidence,
           e.span_text, e.method, o.url, s.tier, o.fetched_at
    FROM s2_claim c
    JOIN s2_evidence e ON e.claim_id = c.id AND e.role = 'establishing'
    JOIN s2_observation o ON o.id = e.observation_id
    JOIN s2_source s ON s.id = o.source_id
    WHERE c.entity_id = ${input.entityId} AND c.status = 'released'
    ORDER BY c.field`) as unknown as Array<Record<string, any>>;

  const ent = (await sql`
    SELECT canonical_name, entity_type, commercial_state, strict_reachable, profile_assisted_reachable
    FROM s2_entity WHERE id = ${input.entityId}`) as unknown as Array<Record<string, any>>;

  // Non-released claims are counted but never shown. The agent is told they
  // exist so it can say "some values did not pass" rather than implying the
  // record is simply thin -- but it cannot read them.
  const [withheld] = (await sql`
    SELECT count(*) FILTER (WHERE status='quarantined')::int quarantined,
           count(*) FILTER (WHERE status='candidate')::int held
    FROM s2_claim WHERE entity_id = ${input.entityId}`) as unknown as Array<Record<string, number>>;

  return {
    data: {
      entity: ent[0] ?? null,
      claims: rows.map((r) => ({
        field: r.field, value: r.value, valueType: r.value_type, confidence: r.confidence,
        evidence: { span: r.span_text, method: r.method, url: r.url, sourceTier: r.tier, observedAt: r.fetched_at },
      })),
    },
    scope: { entityId: input.entityId, releasedClaims: rows.length },
    excluded: [
      ...(withheld?.quarantined ? [{ reason: 'claims quarantined by a gate (not readable here)', count: withheld.quarantined }] : []),
      ...(withheld?.held ? [{ reason: 'claims held pending an unresolved check', count: withheld.held }] : []),
    ],
    limits: [
      'Only released claims are returned. A field absent here is a field this system does not have — not a field the firm lacks.',
      'The evidence span is the exact text read. It is not a summary and has not been paraphrased.',
    ],
  };
}

export async function count_matching(input: {
  requireStrictReachable?: boolean; requireProfileAssisted?: boolean; requiredFields?: string[];
}): Promise<ToolResult<unknown>> {
  const r = await shortlist({ ...input, limit: 1 });
  return {
    data: { count: r.scope.matched },
    scope: { searched: r.scope.searched, appliedFilters: r.scope.appliedFilters },
    excluded: r.scope.excluded,
    limits: ['An exact count over released claims at this moment. Not an estimate and not a projection.'],
  };
}

export async function check_evidence(input: { entityId: string; field?: string }): Promise<ToolResult<unknown>> {
  const sql = db();
  // Only the verdict under the newest policy the claim was judged under. An
  // older verdict is history, not the system's current position, and returning
  // both would let the agent quote a superseded outcome as current.
  const rows = (await sql`
    SELECT c.field, c.status, vr.gate, vr.outcome, vr.detail, vr.policy_version
    FROM s2_claim c
    LEFT JOIN LATERAL (
      SELECT DISTINCT ON (v.gate) v.gate, v.outcome, v.detail, v.policy_version
      FROM s2_validation_result v
      WHERE v.claim_id = c.id
      ORDER BY v.gate, v.policy_version DESC
    ) vr ON TRUE
    WHERE c.entity_id = ${input.entityId}
      AND (${input.field ?? null}::text IS NULL OR c.field = ${input.field ?? null})
    ORDER BY c.field, vr.gate`) as unknown as Array<Record<string, any>>;

  return {
    data: rows.map((r) => ({
      field: r.field, claimStatus: r.status, gate: r.gate,
      outcome: r.outcome, detail: r.detail, policyVersion: r.policy_version,
    })),
    scope: { entityId: input.entityId, field: input.field ?? 'all', rows: rows.length },
    excluded: [],
    limits: [
      'Reports what the gates recorded and nothing beyond it. A passed gate means that specific check passed, not that the value is true.',
      "`skipped` is not `passed`. A skipped gate means the check did not run.",
    ],
  };
}

export const TOOLS: Record<string, (input: any) => Promise<ToolResult<unknown>>> = {
  search_firms, get_firm, count_matching, check_evidence,
};
