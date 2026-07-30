import type {
  Claim,
  CommercialDecision,
  Entity,
  GateName,
  GateResult,
  ReleaseDecision,
} from '@fo/core/contract/index.js';

/**
 * The single path to released state.
 *
 * There is one function here and no setter for `status` is exported anywhere
 * else in the codebase. A claim that is released was released by this call, so
 * "how did this reach the customer?" always has exactly one answer.
 */
export const POLICY_VERSION = '2025-07-30.1';

export function releaseDecision(
  claim: Claim,
  results: GateResult[],
  policyVersion = POLICY_VERSION,
): ReleaseDecision {
  const passed = results.filter((r) => r.outcome === 'passed').map((r) => r.gate);
  const failed = results.filter((r) => r.outcome === 'failed' || r.outcome === 'error').map((r) => r.gate);
  const skipped = results.filter((r) => r.outcome === 'skipped').map((r) => r.gate);

  const base = { claimId: claim.id, gatesPassed: passed, gatesFailed: failed, gatesSkipped: skipped, policyVersion };

  if (failed.length) {
    return { ...base, decision: 'quarantined' as const, reason: `failed: ${failed.join(', ')}` };
  }

  /**
   * PTC-2, and the reason `held` exists as a third outcome.
   *
   * A skipped gate is not a passed gate. Attribution can legitimately skip when
   * evidence is pointer-style and its locator has not been resolved yet -- but
   * "we have not checked whether this quote supports this value" must never
   * reach a customer as though we had. The claim waits.
   */
  const mustPass: GateName[] = ['schema', 'attribution'];
  const unproven = mustPass.filter((g) => !passed.includes(g));
  if (unproven.length) {
    return { ...base, decision: 'held' as const, reason: `not established: ${unproven.join(', ')}` };
  }

  return { ...base, decision: 'released' as const, reason: `passed ${passed.length} gate(s)` };
}

/**
 * Gate 9 · commercial — asked once per entity, over its released claims.
 *
 * Deliberately separate from release. A quarantined claim needs better evidence;
 * a withheld entity needs more enrichment. Conflating them sends us hunting for
 * evidence defects in records whose only fault is thinness.
 */
export function assessEntity(
  entity: Entity,
  released: Claim[],
  policyVersion = POLICY_VERSION,
): CommercialDecision {
  const has = (f: string) => released.some((c) => c.field === f || c.field.endsWith('.' + f));
  const required = ['legalName', 'country'];
  const commercial = ['fullName', 'website', 'city'];

  const missing = [...required.filter((f) => !has(f)), ...commercial.filter((f) => !has(f))];
  const meetsFloor = required.every(has) && commercial.filter(has).length >= 2;

  return {
    entityId: entity.id,
    commercialState: meetsFloor ? 'qualifying' : 'withheld',
    reason: meetsFloor
      ? 'holds identity claims and enough context to act on'
      : `below the commercial floor; missing ${missing.join(', ')}`,
    missing,
    policyVersion,
  };
}
