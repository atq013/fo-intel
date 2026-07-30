import type {
  Claim,
  CommercialDecision,
  Entity,
  Evidence,
  GateResult,
  Observation,
  ReleaseDecision,
  Source,
} from './types.js';
import type { OpenExtractionEvent } from './extraction.js';

/**
 * The five seams.
 *
 * Written before any implementation because getting a seam wrong is the mistake
 * that costs a rewrite, and because one property of this set is load-bearing:
 *
 *   **`Extractor` is the only signature that can produce Evidence, and it can
 *   only produce it alongside the claims from the same event.**
 *
 * Read the return types below. A Collector returns observations and no evidence.
 * A Gate returns a judgement and no evidence. A ReleaseGate returns a decision
 * and no evidence. Nothing downstream of extraction can manufacture a basis for
 * a value, which is precisely what Stage 1's assembly step did.
 */

/**
 * Fetches from one source, resumably.
 *
 * The cursor is returned rather than held internally so a run halted mid-source
 * -- by the budget guard, by a circuit breaker, by GitHub Actions timing out --
 * resumes from the last committed unit instead of restarting the source.
 */
export interface Collector {
  readonly kind: string;
  collect(
    source: Source,
    cursor?: string,
  ): AsyncIterable<{ observation: Observation; cursor?: string }>;
}

/**
 * Reads one observation and derives assertions from it.
 *
 * Takes the open event rather than returning loose claims and evidence: the
 * extractor cannot pair them wrongly because it never holds them apart. It calls
 * `event.assert(value, span)` and the pairing is made at that moment.
 */
export interface Extractor {
  readonly name: string;
  extract(observation: Observation, event: OpenExtractionEvent): Promise<void>;
}

/**
 * One validation question, asked of one claim.
 *
 * `band` decides whether the gate runs when release is already blocked. Band A
 * always runs -- a first-failure-only record costs a 500-record re-run to find
 * the second defect, and at this volume the compute is cheaper than the round
 * trip. Band B is skipped, and the skip is recorded as `skipped`, never as a
 * pass.
 */
export interface Gate {
  readonly name: GateResult['gate'];
  readonly band: 'A' | 'B';
  evaluate(claim: Claim, ctx: GateContext): Promise<GateResult>;
}

export interface GateContext {
  /** the claim's own establishing evidence, plus anything attached since */
  evidence: Evidence[];
  observation?: Observation;
  /** the entity's other claims, for record-level questions like coherence */
  siblings: Claim[];
  entity: Entity;
  policyVersion: string;
}

/**
 * The single chokepoint. A claim reaches `released` through this and no other
 * path; no setter for `status` is exported anywhere else.
 */
export interface ReleaseGate {
  decide(claim: Claim, results: GateResult[], policyVersion: string): ReleaseDecision;
}

/**
 * The record-level question, asked once per entity over its released claims.
 *
 * Separate from ReleaseGate because trust and commercial sufficiency have
 * different remedies: a quarantined claim needs better evidence, a withheld
 * entity needs more enrichment. Conflating them sends us looking for evidence
 * defects in records whose only fault is thinness.
 */
export interface EntityGate {
  assess(entity: Entity, released: Claim[], policyVersion: string): CommercialDecision;
}
