import type { Claim, Gate, GateContext, GateResult } from '@fo/core/contract/index.js';

/**
 * Gate 3 · value_type — does a person field hold a person?
 *
 * Stage 1 shipped six corporate bodies as principals, all titled "Person with
 * significant control". The title is Companies House's own wording and it is
 * legally correct: a PSC may be a corporate entity. The extractor read the label
 * and never asked whether the thing wearing it was a human being.
 *
 * It also shipped a unix timestamp as a phone number, which nothing in the
 * pipeline questioned because the field was typed `string`.
 *
 * Every check here is deterministic. No model is asked whether something looks
 * like a person, because a model that is wrong 2% of the time is wrong ten times
 * across 500 records and cannot say which ten.
 */

const CORPORATE = /\b(LLC|L\.L\.C|LTD|LIMITED|INC|INCORPORATED|CORP|CORPORATION|GMBH|PLC|SA|NV|BV|AG|HOLDINGS?|GROUP|TRUST|COMPANY|PARTNERS|PARTNERSHIP|LP|LLP|FOUNDATION|VENTURES?|CAPITAL|INVESTMENTS?)\b/i;

const HONORIFIC = /^(mr|mrs|ms|miss|dr|sir|dame|lord|lady|prof)\.?\s+/i;

export function checkPersonName(value: unknown): { ok: boolean; why: string } {
  if (typeof value !== 'string' || !value.trim()) return { ok: false, why: 'not a non-empty string' };
  const name = value.trim();

  if (CORPORATE.test(name)) {
    return { ok: false, why: `contains a corporate designator, so this is an organisation and not a natural person` };
  }
  const words = name.replace(HONORIFIC, '').split(/\s+/).filter(Boolean);
  if (words.length < 2) {
    return { ok: false, why: 'a single token is not a full name' };
  }
  if (/\d/.test(name)) return { ok: false, why: 'contains digits' };
  return { ok: true, why: 'no corporate designator, at least two name tokens' };
}

/**
 * Phone validity, and specifically the check that catches a timestamp.
 *
 * A 10-digit NANP number cannot have an area code beginning 0 or 1 -- that is a
 * numbering-plan rule, not a heuristic. Emerson Collective's principal shipped
 * with 1706895664, which fails it, and which is also 2 Feb 2024 read as unix
 * seconds. One rule, two defects caught.
 */
export function checkPhone(value: unknown): { ok: boolean; why: string } {
  if (typeof value !== 'string' || !value.trim()) return { ok: false, why: 'not a non-empty string' };
  const digits = value.replace(/\D/g, '');

  if (digits.length < 7) return { ok: false, why: `only ${digits.length} digits` };
  if (digits.length > 15) return { ok: false, why: 'exceeds E.164 maximum of 15 digits' };

  const isIntl = value.trim().startsWith('+') || digits.length > 11;
  if (!isIntl && digits.length === 10 && (digits[0] === '0' || digits[0] === '1')) {
    const asEpoch = new Date(Number(digits) * 1000);
    const epochNote = asEpoch.getUTCFullYear() > 1990 && asEpoch.getUTCFullYear() < 2100
      ? `; reads as the unix timestamp ${asEpoch.toISOString().slice(0, 10)}`
      : '';
    return { ok: false, why: `no NANP area code begins with ${digits[0]}${epochNote}` };
  }
  return { ok: true, why: `${digits.length} digits, numbering-plan consistent` };
}

export function checkEmail(value: unknown): { ok: boolean; why: string } {
  if (typeof value !== 'string') return { ok: false, why: 'not a string' };
  return /^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i.test(value.trim())
    ? { ok: true, why: 'well-formed' }
    : { ok: false, why: 'not a well-formed address' };
}

const CHECKS: Record<string, (v: unknown) => { ok: boolean; why: string }> = {
  person_name: checkPersonName,
  phone: checkPhone,
  email: checkEmail,
};

export const valueTypeGate: Gate = {
  name: 'value_type',
  band: 'A',
  async evaluate(claim: Claim, _ctx: GateContext): Promise<GateResult> {
    const check = CHECKS[claim.valueType];
    if (!check) {
      // An unknown value type is not a pass. It means nobody has decided what
      // this field is allowed to contain, which is the state Stage 1 shipped in.
      return {
        gate: 'value_type',
        outcome: 'skipped',
        band: 'A',
        detail: `no checker registered for value type "${claim.valueType}"`,
      };
    }
    const r = check(claim.value);
    return {
      gate: 'value_type',
      outcome: r.ok ? 'passed' : 'failed',
      band: 'A',
      detail: r.why,
      counterfactual: r.ok ? undefined : { wouldHaveReleased: claim.value, asType: claim.valueType },
    };
  },
};
