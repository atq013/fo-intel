import type { Claim, Gate, GateContext, GateResult } from '@fo/core/contract/index.js';

/**
 * Gate 4 · identity — is this the person we think, or a namesake?
 *
 * Stage 1 shipped two profile URLs belonging to entirely different people:
 * David Blitzer linked to /in/jonas-cohon, Rodger Riney to
 * /in/bobby-w-sandage-jr-phd-69087211. Both were found by a human reviewer after
 * submission.
 *
 * The Phase 0 spike re-derived them in microseconds with a slug check. That is
 * worth stating plainly: the defect that embarrassed the Stage 1 submission was
 * catchable by a string comparison nobody had written. The gate is cheap because
 * the check is cheap; it was missing because nobody asked the question.
 *
 * Band A despite being an identity question, because URL-slug verification needs
 * no network. Resolving the profile itself is Band B and comes later.
 */

export function checkProfileSlug(url: string, personName: string): { ok: boolean; why: string } {
  const slug = (url.split('/in/')[1] ?? '').split(/[/?#]/)[0]?.toLowerCase() ?? '';
  if (!slug) return { ok: false, why: 'not a personal profile URL' };

  const tokens = personName.toLowerCase().replace(/[^a-z ]/g, '').split(/\s+/).filter((t) => t.length > 2);
  if (!tokens.length) return { ok: false, why: 'no comparable name tokens' };

  const matched = tokens.filter((t) => slug.includes(t));
  // The surname is the discriminating token. A shared first name is a
  // coincidence; a shared surname plus anything else is not.
  const surname = tokens[tokens.length - 1]!;
  if (!slug.includes(surname)) {
    return { ok: false, why: `slug "${slug}" does not contain the surname "${surname}"` };
  }
  return { ok: true, why: `slug encodes ${matched.length}/${tokens.length} name tokens including the surname` };
}

export const identityGate: Gate = {
  name: 'identity',
  band: 'A',
  async evaluate(claim: Claim, ctx: GateContext): Promise<GateResult> {
    if (claim.valueType !== 'profile_url') {
      return { gate: 'identity', outcome: 'skipped', band: 'A', detail: 'not a profile claim' };
    }
    const person = ctx.siblings.find((c) => c.field.endsWith('fullName'))?.value;
    if (typeof person !== 'string') {
      return { gate: 'identity', outcome: 'failed', band: 'A', detail: 'no named person to verify against' };
    }
    const r = checkProfileSlug(String(claim.value), person);
    return {
      gate: 'identity',
      outcome: r.ok ? 'passed' : 'failed',
      band: 'A',
      detail: r.why,
      counterfactual: r.ok ? undefined : { wouldHaveReleased: claim.value, asProfileFor: person },
    };
  },
};
