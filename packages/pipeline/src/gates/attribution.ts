import type { Claim, Gate, GateContext, GateResult } from '@fo/core/contract/index.js';
import { checkDerivation } from './derivation.js';

/**
 * Gate 2 · attribution — the centrepiece.
 *
 * Question: does the span we cited actually establish this value?
 *
 * Stage 1 had a check that a quote appeared in its source, and mistook it for a
 * check that the quote supported the value. Those are different questions, and
 * the gap between them was 93 mis-wired values. This gate asks the second one.
 *
 * Two kinds of evidence are scored differently, because they make different
 * claims about themselves:
 *
 *   quoting — "the value is written here". Testable now, lexically.
 *   pointer — "the value is in the record this names". Testable only by
 *             resolving the locator, which is a network call, so it is deferred
 *             rather than guessed at.
 *
 * Deferral is not a loophole. A deferred claim is `skipped`, and the release gate
 * treats skipped as not-passed (PTC-2), so a pointer claim cannot reach released
 * state until something actually resolves it. An extractor that emitted
 * pointer-shaped spans to dodge this gate would produce zero released claims.
 */

const STOPWORDS = new Set([
  'the', 'a', 'an', 'of', 'and', 'or', 'in', 'at', 'on', 'to', 'for', 'by',
  'is', 'was', 'are', 'were', 'be', 'as', 'with', 'from', 'this', 'that',
  'states', 'page', 'name', 'address', 'suite', 'floor', 'ltd', 'llc', 'limited',
]);

function tokenize(s: string): string[] {
  return s
    .toLowerCase()
    // keep digits attached to their own token; split ordinals like 57th -> 57
    .replace(/(\d)(st|nd|rd|th)\b/g, '$1')
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

/**
 * Tokens that cannot be coincidence: anything containing a digit.
 *
 * Every one must be present. This is what catches the Kopp address -- the value
 * says 701 and 1030, the cited filing says 8400 and 1450, and no amount of
 * shared words like "suite" makes that the same address. Prose overlaps by
 * accident; house numbers and postcodes do not.
 */
function hardTokens(tokens: string[]): string[] {
  return tokens.filter((t) => /\d/.test(t));
}

const LOCATOR = /\b(company\s*(number\s*)?\d{6,8}|cik\s*0*\d{6,10}|accession\s*(no\.?\s*)?[\d-]{18,20}|crd\s*\d{5,8})\b/i;

export const COVERAGE_THRESHOLD = 0.6;

export function checkAttribution(
  value: unknown,
  spanText: string,
  method = '',
): { outcome: 'passed' | 'failed' | 'skipped'; detail: string; counterfactual?: unknown } {
  // Third evidence kind: the value was computed from what the source says rather
  // than written in it. Checked by re-running the named rule, not by exempting
  // the claim -- see gates/derivation.ts.
  const derived = checkDerivation(value, spanText, method);
  if (derived) return derived;

  const valueStr = typeof value === 'string' ? value : JSON.stringify(value);
  const vTokens = tokenize(valueStr);
  const sTokens = new Set(tokenize(spanText));

  if (vTokens.length === 0) {
    return { outcome: 'failed', detail: 'value has no comparable tokens' };
  }

  const hard = hardTokens(vTokens);
  const missingHard = hard.filter((t) => !sTokens.has(t));

  const content = vTokens.filter((t) => !STOPWORDS.has(t));
  const present = content.filter((t) => sTokens.has(t));
  const coverage = content.length ? present.length / content.length : 0;

  const supported = missingHard.length === 0 && coverage >= COVERAGE_THRESHOLD;
  if (supported) {
    return {
      outcome: 'passed',
      detail: `span contains the value (${present.length}/${content.length} content tokens, all ${hard.length} hard tokens)`,
    };
  }

  // Not written here. Does the span at least name a record where it would be?
  if (LOCATOR.test(spanText)) {
    return {
      outcome: 'skipped',
      detail: 'pointer evidence: locator present, resolution deferred to Band B',
    };
  }

  const why = missingHard.length
    ? `span is missing hard token(s) ${missingHard.join(', ')}`
    : `content coverage ${(coverage * 100).toFixed(0)}% below ${COVERAGE_THRESHOLD * 100}%`;

  return {
    outcome: 'failed',
    detail: why,
    // What would have shipped had this gate not fired: the value, asserted, with
    // this span standing behind it. This is the column that proves the gate is
    // load-bearing rather than decorative.
    counterfactual: { wouldHaveReleased: value, citing: spanText.slice(0, 200) },
  };
}

export const attributionGate: Gate = {
  name: 'attribution',
  band: 'A',
  async evaluate(claim: Claim, ctx: GateContext): Promise<GateResult> {
    const establishing = ctx.evidence.find((e) => e.role === 'establishing');
    if (!establishing) {
      // Structurally impossible through the writer and refused by the database.
      // Checked anyway: a claim with no basis must never look merely unproven.
      return {
        gate: 'attribution',
        outcome: 'failed',
        band: 'A',
        detail: 'no establishing evidence',
        counterfactual: { wouldHaveReleased: claim.value, citing: null },
      };
    }
    const r = checkAttribution(claim.value, establishing.spanText, establishing.method);
    return { gate: 'attribution', outcome: r.outcome, band: 'A', detail: r.detail, counterfactual: r.counterfactual };
  },
};
