import type { Claim, Gate, GateContext, GateResult } from '@fo/core/contract/index.js';

/**
 * Gate 1 · schema — right shape, right type, non-empty.
 *
 * The cheapest gate and the least interesting, which is why it runs first: it
 * costs nothing and it stops a malformed claim from consuming the gates that do
 * cost something.
 */

const REQUIRED_NON_EMPTY = new Set(['string', 'person_name', 'email', 'phone', 'profile_url', 'address']);

export const schemaGate: Gate = {
  name: 'schema',
  band: 'A',
  async evaluate(claim: Claim, _ctx: GateContext): Promise<GateResult> {
    const problems: string[] = [];

    if (!claim.field.trim()) problems.push('empty field name');
    if (claim.value === null || claim.value === undefined) problems.push('null value');
    if (REQUIRED_NON_EMPTY.has(claim.valueType) && typeof claim.value === 'string' && !claim.value.trim()) {
      problems.push(`empty string for value type "${claim.valueType}"`);
    }
    if (claim.confidence < 0 || claim.confidence > 1) problems.push(`confidence ${claim.confidence} outside 0..1`);
    if (claim.valueType === 'profile_url' && typeof claim.value === 'string' && !/^https?:\/\//i.test(claim.value)) {
      problems.push('profile_url is not an absolute URL');
    }

    return {
      gate: 'schema',
      outcome: problems.length ? 'failed' : 'passed',
      band: 'A',
      detail: problems.length ? problems.join('; ') : 'shape and types valid',
      counterfactual: problems.length ? { wouldHaveReleased: claim.value } : undefined,
    };
  },
};
