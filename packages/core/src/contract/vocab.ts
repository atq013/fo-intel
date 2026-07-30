/**
 * The contract vocabularies, defined once.
 *
 * These mirror the CHECK constraints in packages/db/src/migrations. Keeping them
 * as `as const` tuples rather than TypeScript enums means the union types are
 * derived from the same array the runtime validates against, so a value that
 * type-checks is a value the database will accept.
 */

export const CLAIM_STATUS = [
  'candidate',
  'validated',
  'released',
  'stale',
  'quarantined',
  'retired',
] as const;
export type ClaimStatus = (typeof CLAIM_STATUS)[number];

/**
 * Note what is absent: there is no `withheld`. Commercial sufficiency is judged
 * on the entity, never on the claim -- a claim that passed its trust gates is
 * true regardless of how thin the record around it is. Correction 4.
 */
export const TRUST_STATE = ['active', 'merged', 'quarantined', 'retired'] as const;
export type TrustState = (typeof TRUST_STATE)[number];

export const COMMERCIAL_STATE = ['qualifying', 'withheld', 'unassessed'] as const;
export type CommercialState = (typeof COMMERCIAL_STATE)[number];

/**
 * Evidence roles.
 *
 * `establishing` is the constrained one: exactly one per claim, written inside
 * the claim's own extraction event, never attachable afterwards. The other three
 * attach freely after the fact -- a second source agreeing next week is normal,
 * and a source disagreeing is information we want, not an error.
 */
export const EVIDENCE_ROLE = [
  'establishing',
  'corroborating',
  'conflicting',
  'superseding',
] as const;
export type EvidenceRole = (typeof EVIDENCE_ROLE)[number];

export const SOURCE_KIND = [
  'sec_submissions',
  'sec_13f',
  'sec_fulltext',
  'sec_adv',
  'companies_house',
  'web_page',
  'search_result',
] as const;
export type SourceKind = (typeof SOURCE_KIND)[number];

/** 1 statutory or the firm itself · 2 recognised press · 3 aggregator · 4 unranked */
export type SourceTier = 1 | 2 | 3 | 4;

export const GATE = [
  'schema',
  'attribution',
  'value_type',
  'identity',
  'contact_ownership',
  'coherence',
  'conflict',
  'freshness',
  'commercial',
  'copy',
] as const;
export type GateName = (typeof GATE)[number];

/**
 * Band A gates are cheap and deterministic; all of them run, always, even after
 * one has already failed the claim. Band B is expensive or probabilistic and is
 * skipped once release is impossible.
 *
 * The skip is recorded as `skipped`, never as `passed` -- PTC-2. A gate that did
 * not run must never be able to look like a gate that agreed.
 */
export const BAND_A: readonly GateName[] = [
  'schema',
  'attribution',
  'value_type',
  'contact_ownership',
  'coherence',
] as const;

export const BAND_B: readonly GateName[] = [
  'identity',
  'conflict',
  'freshness',
  'commercial',
  'copy',
] as const;

export const GATE_OUTCOME = ['passed', 'failed', 'skipped', 'error'] as const;
export type GateOutcome = (typeof GATE_OUTCOME)[number];

export const RELEASE_DECISION = ['released', 'quarantined', 'held'] as const;
export type ReleaseDecisionKind = (typeof RELEASE_DECISION)[number];

/**
 * How often a field must be re-observed.
 *
 * `statutory` — registry facts; change rarely, change officially.
 * `volatile` — headcount, AUM, roles; change quietly and often.
 * `append_only` — dated events; never re-verified, they already happened.
 * `derived` — computed from other claims; refreshed when an input moves.
 */
export const REFRESH_POLICY = ['statutory', 'volatile', 'append_only', 'derived'] as const;
export type RefreshPolicy = (typeof REFRESH_POLICY)[number];

export const CONTACT_CHANNEL = ['email', 'phone', 'linkedin', 'postal'] as const;
export type ContactChannel = (typeof CONTACT_CHANNEL)[number];

/** Never inferred from the shape of an address. Always evidenced. */
export const CONTACT_REACHES = ['individual', 'team', 'company', 'unknown'] as const;
export type ContactReaches = (typeof CONTACT_REACHES)[number];

export const RUN_TRIGGER = ['schedule', 'manual', 'retry'] as const;
export type RunTrigger = (typeof RUN_TRIGGER)[number];

export const RUN_JOB = ['discover', 'refresh', 'contract', 'evaluate'] as const;
export type RunJob = (typeof RUN_JOB)[number];

export const RUN_STATUS = [
  'running',
  'completed',
  'failed',
  'halted_budget',
  'aborted',
] as const;
export type RunStatus = (typeof RUN_STATUS)[number];

export const DECISION_KIND = [
  'release',
  'quarantine',
  'supersede',
  'merge',
  'stale',
  'refresh',
  'classify',
  'contact_verify',
  'budget_halt',
  'source_circuit',
  'retry',
] as const;
export type DecisionKind = (typeof DECISION_KIND)[number];
