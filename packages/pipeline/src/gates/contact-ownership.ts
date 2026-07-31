import type { Claim, Gate, GateContext, GateResult } from '@fo/core/contract/index.js';

/**
 * Gate 5 · contact_ownership — does this route demonstrably reach the named
 * individual?
 *
 * The brief makes reachability a hard bar and names what does not count: shared
 * inboxes, contact forms, switchboards, pattern-generated addresses. Stage 1
 * shipped three role mailboxes as principals' personal email, including
 * info@emersoncollective.com attributed to Laurene Powell Jobs.
 *
 * The gate has two halves and the second is the one that matters:
 *
 *   1. shape — is this the kind of address that can belong to a person?
 *   2. ownership — is there evidence that it belongs to THIS person?
 *
 * Stage 1 effectively did neither, but the deeper error was treating shape as
 * sufficient. jane.doe@firm.com has personal shape and may still be a guess
 * generated from a naming pattern. Shape can only ever disqualify; it can never
 * establish. That asymmetry is why the two checks are separate below and why the
 * gate fails closed when ownership evidence is absent.
 */

const ROLE_MAILBOX = /^(info|contact|hello|hi|admin|enquir(y|ies)|inquir(y|ies)|office|team|support|mail|general|reception|press|media|careers|jobs|hr|sales|marketing|help|service|no-?reply|do-?not-?reply|webmaster|postmaster|accounts?|billing|finance|legal|compliance)([.\-_]?\d+)?@/i;

export function checkEmailShape(email: string): { disqualified: boolean; why: string } {
  const local = email.split('@')[0] ?? '';
  if (ROLE_MAILBOX.test(email)) {
    return { disqualified: true, why: `"${local}@" is a role mailbox, which the brief excludes explicitly` };
  }
  if (local.length <= 2) {
    return { disqualified: true, why: `local part "${local}" is too short to identify a person` };
  }
  return { disqualified: false, why: 'shape does not disqualify (which is not the same as ownership)' };
}

/**
 * Does the address encode the person's name?
 *
 * Used only to strengthen a route that already has ownership evidence, never to
 * create one. An address that encodes a name may still be pattern-generated --
 * that is exactly how pattern generation works.
 */
export function emailEncodesPerson(email: string, personName: string): boolean {
  const local = (email.split('@')[0] ?? '').toLowerCase();
  const tokens = personName.toLowerCase().replace(/[^a-z ]/g, '').split(/\s+/).filter((t) => t.length > 2);
  if (!tokens.length) return false;
  const surname = tokens[tokens.length - 1]!;
  return local.includes(surname) || tokens.filter((t) => local.includes(t)).length >= 2;
}

export const contactOwnershipGate: Gate = {
  name: 'contact_ownership',
  band: 'A',
  async evaluate(claim: Claim, ctx: GateContext): Promise<GateResult> {
    if (!['email', 'phone', 'postal'].includes(claim.valueType)) {
      return { gate: 'contact_ownership', outcome: 'skipped', band: 'A', detail: 'not a contact claim' };
    }

    const value = String(claim.value);

    if (claim.valueType === 'email') {
      const shape = checkEmailShape(value);
      if (shape.disqualified) {
        return {
          gate: 'contact_ownership',
          outcome: 'failed',
          band: 'A',
          detail: shape.why,
          counterfactual: {
            wouldHaveReleased: value,
            asPersonalContactFor: ctx.siblings.find((c) => c.field.endsWith('fullName'))?.value ?? null,
            andWouldHaveCountedTowardReachability: true,
          },
        };
      }
    }

    // Shape passed. That establishes nothing on its own -- ownership has to be
    // evidenced, and absent evidence this fails rather than defers, because a
    // contact that silently counts toward the 200 without a basis is precisely
    // the number the brief is testing.
    const owned = ctx.evidence.some(
      (e) => e.role === 'establishing' && new RegExp(value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i').test(e.spanText),
    );
    if (!owned) {
      return {
        gate: 'contact_ownership',
        outcome: 'failed',
        band: 'A',
        detail: 'no evidence binds this route to the named individual',
        counterfactual: { wouldHaveReleased: value, andWouldHaveCountedTowardReachability: true },
      };
    }

    return {
      gate: 'contact_ownership',
      outcome: 'passed',
      band: 'A',
      detail: 'route appears in evidence naming the individual',
    };
  },
};
