import { db } from './index.js';

/**
 * Evidence-aware shortlist retrieval (spec D4).
 *
 * The capability Stage 1 did not have: filter and rank simultaneously on fit,
 * evidence grade, freshness, and principal-level reachability, and return per
 * result *why it matched* and *what is missing*.
 *
 * Stage 1 could rank on semantic similarity and filter on type and country. It
 * could not answer "firms with a named principal I can actually reach, verified
 * recently, ranked by fit" — which is the question someone with money to deploy
 * actually has.
 *
 * **This is a tool, not a workflow.** It takes a structured query and returns
 * scored rows with scope metadata. It does not decompose goals, call itself, or
 * write prose. The agent does those things using this as one tool. Keeping that
 * line sharp is what makes the retrieval feature independently demonstrable,
 * which the brief requires separately from the agent.
 *
 * Two rules hold throughout:
 *
 *   1. **Released claims only.** Candidate, quarantined and held claims are
 *      invisible here. A value that did not pass its gates cannot influence a
 *      shortlist, or the gates were decorative.
 *   2. **Absence is reported, never imputed.** `missing` is part of every result.
 *      A firm that lacks a phone is not silently ranked lower — it is returned
 *      saying it lacks a phone.
 */

export interface ShortlistQuery {
  /** free text matched against the firm name; not semantic, and said so */
  q?: string;
  country?: string;
  /** a route that reaches a named individual, profiles excluded (ADR-11) */
  requireStrictReachable?: boolean;
  /** the above, plus verified personal profiles under assumption A1 */
  requireProfileAssisted?: boolean;
  /** claim fields the record must actually hold, e.g. principal.fullName */
  requiredFields?: string[];
  /** only entities whose newest observation is within this many days */
  freshWithinDays?: number;
  /** 1 statutory/self · 2 press · 3 aggregator · 4 unranked */
  maxSourceTier?: 1 | 2 | 3 | 4;
  limit?: number;
}

export interface ShortlistResult {
  entityId: string;
  name: string;
  score: number;
  dimensions: {
    fit: number;
    evidence: number;
    freshness: number;
    reachability: number;
  };
  /** the concrete reasons this row is here */
  matched: string[];
  /** what a buyer would want and this record does not have */
  missing: string[];
  strictReachable: boolean;
  profileAssistedReachable: boolean;
  releasedFields: string[];
  contact?: { channel: string; value: string; reaches: string; method: string | null };
  lastObservedAt: string | null;
  bestSourceTier: number | null;
}

export interface ShortlistResponse {
  results: ShortlistResult[];
  /**
   * Mandatory. What was searched, what matched, what was excluded and why.
   * Correction 8: the system states its scope rather than letting the reader
   * assume the answer covers everything.
   */
  scope: {
    searched: number;
    matched: number;
    returned: number;
    excluded: Array<{ reason: string; count: number }>;
    appliedFilters: string[];
  };
  /** honest statements about what this retrieval cannot do */
  limits: string[];
  query: ShortlistQuery;
}

/** Fields a buyer needs to act. Absence of any is reported, not penalised silently. */
const COMMERCIAL_FIELDS = ['legalName', 'country', 'city', 'principal.fullName', 'principal.phone'];

export async function shortlist(raw: ShortlistQuery): Promise<ShortlistResponse> {
  // Callers -- the agent planner in particular -- emit 0 as a "no value"
  // sentinel for these. Taken literally they are unsatisfiable: nothing is 0
  // days old, and there is no source tier 0, so either silently excluded every
  // record. Worse, `appliedFilters` tested truthiness, so the filter ran without
  // being disclosed and the scope under-reported what had been applied.
  //
  // Normalising here keeps one rule: a filter that runs is a filter that is
  // reported, and a value that cannot constrain anything is not a filter.
  const query: ShortlistQuery = {
    ...raw,
    freshWithinDays: raw.freshWithinDays && raw.freshWithinDays > 0 ? raw.freshWithinDays : undefined,
    maxSourceTier: raw.maxSourceTier && raw.maxSourceTier >= 1 ? raw.maxSourceTier : undefined,
    requiredFields: raw.requiredFields?.length ? raw.requiredFields : undefined,
    q: raw.q?.trim() || undefined,
  };
  const limit = Math.min(query.limit ?? 25, 100);
  const sql = db();

  // One pass over released claims per entity. Everything downstream scores in
  // TypeScript so each dimension's contribution stays inspectable rather than
  // buried in a SQL expression nobody can audit.
  const rows = (await sql`
    SELECT e.id, e.canonical_name, e.commercial_state, e.trust_state,
           e.strict_reachable, e.profile_assisted_reachable,
           (SELECT array_agg(DISTINCT c.field) FROM s2_claim c
             WHERE c.entity_id = e.id AND c.status = 'released')            AS fields,
           (SELECT max(o.fetched_at) FROM s2_claim c
              JOIN s2_extraction_event xe ON xe.id = c.extraction_event_id
              JOIN s2_observation o ON o.id = xe.observation_id
             WHERE c.entity_id = e.id AND c.status = 'released')            AS last_observed,
           (SELECT min(s.tier) FROM s2_claim c
              JOIN s2_extraction_event xe ON xe.id = c.extraction_event_id
              JOIN s2_observation o ON o.id = xe.observation_id
              JOIN s2_source s ON s.id = o.source_id
             WHERE c.entity_id = e.id AND c.status = 'released')            AS best_tier,
           (SELECT count(*)::int FROM s2_claim c
             WHERE c.entity_id = e.id AND c.status = 'released')            AS released_count,
           ct.channel, ct.value AS contact_value, ct.reaches, ct.verification_method
    FROM s2_entity e
    LEFT JOIN LATERAL (
      SELECT channel, value, reaches, verification_method
      FROM s2_contact
      WHERE entity_id = e.id AND status = 'released' AND counts_profile_assisted
      ORDER BY counts_strict DESC LIMIT 1
    ) ct ON TRUE
    WHERE e.trust_state = 'active'
  `) as unknown as Array<Record<string, any>>;

  const searched = rows.length;
  const excluded: Array<{ reason: string; count: number }> = [];
  const bump = (reason: string) => {
    const hit = excluded.find((e) => e.reason === reason);
    if (hit) hit.count++;
    else excluded.push({ reason, count: 1 });
  };

  const appliedFilters: string[] = [];
  if (query.q) appliedFilters.push(`name contains "${query.q}"`);
  if (query.country) appliedFilters.push(`country = ${query.country}`);
  if (query.requireStrictReachable) appliedFilters.push('strict reachability (profiles excluded)');
  if (query.requireProfileAssisted) appliedFilters.push('profile-assisted reachability');
  if (query.requiredFields?.length) appliedFilters.push(`holds ${query.requiredFields.join(', ')}`);
  if (query.freshWithinDays != null) appliedFilters.push(`observed within ${query.freshWithinDays}d`);
  if (query.maxSourceTier != null) appliedFilters.push(`source tier <= ${query.maxSourceTier}`);

  const now = Date.now();
  const kept: ShortlistResult[] = [];

  for (const r of rows) {
    const fields: string[] = r.fields ?? [];

    // A shortlist is a commercial artefact: an entity below the floor is not
    // sellable, so it is excluded here and the exclusion is reported.
    if (r.commercial_state !== 'qualifying') { bump('below the commercial floor'); continue; }
    if (query.q && !String(r.canonical_name).toLowerCase().includes(query.q.toLowerCase())) {
      bump('name did not match the query text'); continue;
    }
    if (query.requireStrictReachable && !r.strict_reachable) { bump('no strictly-reachable route'); continue; }
    if (query.requireProfileAssisted && !r.profile_assisted_reachable) { bump('no reachable route even counting profiles'); continue; }

    const missingRequired = (query.requiredFields ?? []).filter((f) => !fields.includes(f));
    if (missingRequired.length) { bump(`missing required field(s): ${missingRequired.join(', ')}`); continue; }

    const observedAt = r.last_observed ? new Date(r.last_observed).getTime() : null;
    const ageDays = observedAt ? (now - observedAt) / 86_400_000 : null;
    if (query.freshWithinDays != null && (ageDays == null || ageDays > query.freshWithinDays)) {
      bump(`not observed within ${query.freshWithinDays} days`); continue;
    }
    if (query.maxSourceTier != null && (r.best_tier == null || r.best_tier > query.maxSourceTier)) {
      bump(`no source at tier ${query.maxSourceTier} or better`); continue;
    }

    // ---- dimensions, each 0..1 and each independently explainable ----------
    // fit: how much of what a buyer needs this record actually holds
    const held = COMMERCIAL_FIELDS.filter((f) => fields.includes(f));
    const fit = held.length / COMMERCIAL_FIELDS.length;

    // evidence: source tier, best = 1 (statutory or the firm itself)
    const evidence = r.best_tier ? (5 - Number(r.best_tier)) / 4 : 0;

    // freshness: linear decay over 90 days. Not a truth claim -- an unchanged
    // source is not stale, and this only expresses how recently we looked.
    const freshness = ageDays == null ? 0 : Math.max(0, Math.min(1, 1 - ageDays / 90));

    // reachability: strict outranks profile-assisted, and the two never merge
    const reachability = r.strict_reachable ? 1 : r.profile_assisted_reachable ? 0.6 : 0;

    const score = Number((fit * 0.35 + evidence * 0.2 + freshness * 0.15 + reachability * 0.3).toFixed(4));

    const matched: string[] = [];
    if (r.strict_reachable) matched.push('a route that reaches a named individual, profiles excluded');
    else if (r.profile_assisted_reachable) matched.push('a reachable route counting verified profiles (assumption A1)');
    if (r.best_tier === 1) matched.push('every value traced to a statutory source or the firm itself');
    if (ageDays != null && ageDays < 7) matched.push(`source re-observed ${ageDays < 1 ? 'today' : `${Math.floor(ageDays)}d ago`}`);
    matched.push(`${r.released_count} released claims, each with establishing evidence`);

    const missing = COMMERCIAL_FIELDS.filter((f) => !fields.includes(f))
      .map((f) => `no ${f.replace('principal.', 'principal ')}`);
    if (!r.strict_reachable && !r.profile_assisted_reachable) missing.push('no contact route that reaches an individual');

    kept.push({
      entityId: r.id,
      name: r.canonical_name,
      score,
      dimensions: {
        fit: Number(fit.toFixed(3)),
        evidence: Number(evidence.toFixed(3)),
        freshness: Number(freshness.toFixed(3)),
        reachability,
      },
      matched,
      missing,
      strictReachable: !!r.strict_reachable,
      profileAssistedReachable: !!r.profile_assisted_reachable,
      releasedFields: fields.sort(),
      contact: r.contact_value
        ? { channel: r.channel, value: r.contact_value, reaches: r.reaches, method: r.verification_method }
        : undefined,
      lastObservedAt: r.last_observed ? new Date(r.last_observed).toISOString() : null,
      bestSourceTier: r.best_tier == null ? null : Number(r.best_tier),
    });
  }

  kept.sort((a, b) => b.score - a.score);

  return {
    results: kept.slice(0, limit),
    scope: {
      searched,
      matched: kept.length,
      returned: Math.min(kept.length, limit),
      excluded: excluded.sort((a, b) => b.count - a.count),
      appliedFilters,
    },
    limits: [
      'Ranks only over released claims. Candidate, held and quarantined values are invisible to this query by design.',
      'Text matching is substring on the firm name, not semantic. A firm whose name does not contain the query text will not appear even if it fits.',
      'Freshness measures when the source was last observed, not whether it changed. An unchanged source is not stale.',
      'Reachability is reported as two separate figures and never merged (ADR-11). Strict excludes personal profiles; profile-assisted includes them under assumption A1, which a reviewer may reject.',
      'No AUM, sector or mandate scoring: most single-family offices do not publish those, and a fabricated band would be worse than a blank.',
    ],
    query,
  };
}
