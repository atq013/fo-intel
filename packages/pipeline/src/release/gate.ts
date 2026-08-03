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
/**
 * Bumped when the standard changes. The `contract` job re-judges every claim
 * that has no decision at the current version, so a bump makes the scheduled
 * runs re-evaluate the whole file unattended.
 *
 * 2025-07-31.2 — the identity gate verifies a profile against every named
 * principal of the firm, not just the first one found. It had been comparing
 * /in/-varunmalhotra against a colleague called Elliott and quarantining 32
 * correct profiles.
 *
 * 2025-07-31.1 — attribution no longer strips a value that is entirely
 * stopwords. Oregon's state code "OR" was being filtered as the English
 * conjunction, leaving nothing to compare, and a correct claim was quarantined.
 * Previously quarantined claims are re-admitted by re-evaluation, not by an
 * UPDATE: the decision row records that it changed and why.
 */
export const POLICY_VERSION = '2025-07-31.2';

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
/**
 * Institution classes that are not family offices, whatever their name says.
 *
 * Rubric rule X-2 already excluded banks, insurers, brokers, pensions,
 * universities and public institutions. A qualification review of all 614
 * records found the list too short: it let through two insurance companies, two
 * family LAW firms, a tax practice, an IFA, a consultancy and two grantmaking
 * foundations -- all carrying "family" in the name and none of them a family
 * office. A firm that advises families is not a family office, and a firm that
 * litigates their divorces certainly is not.
 *
 * The law pattern is "family law", not "law", because THE LAW FAMILY OFFICE LLP
 * is the Law family's office and a greedier rule excluded it.
 *
 * Deliberately NOT extended to multi-family offices or registered advisers. The
 * brief is explicit that records ambiguous between SFO, MFO and adviser must
 * stay visible with their status unresolved rather than be cleaned away, and
 * removing them would be answering Goal 2 by deleting its difficulty.
 */
const EXCLUDED_INSTITUTION =
  /\b(insurance|insurer|assurance|mutual holding|bancorp|bank|banking|building society|credit union|pension (fund|scheme|trust)|university|college|hospital|council|law firm|family law|solicitors?|barristers?|tax (llp|practice|advis\w+)|accountan\w+|independent financial advis\w+|consultanc\w+|consulting|foundation)\b/i;

/** The rule, exported so the audit can report what it would exclude. */
export function excludedInstitution(name: string): string | null {
  const m = EXCLUDED_INSTITUTION.exec(name);
  return m ? m[0].toLowerCase() : null;
}

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

  // An excluded institution fails regardless of how complete its record is.
  // Completeness is not the question here -- an insurance company with every
  // field filled is still not a family office.
  const excluded = excludedInstitution(entity.canonicalName);
  if (excluded) {
    return {
      entityId: entity.id,
      commercialState: 'withheld',
      reason: `excluded institution class: the name identifies a "${excluded}", which is not a family office`,
      missing,
      policyVersion,
    };
  }

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
