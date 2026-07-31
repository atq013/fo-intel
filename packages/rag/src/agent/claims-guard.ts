/**
 * Two deterministic output guards, both written against real production failures.
 *
 * ### 1. A relevance score is not a confidence score
 *
 * Asked the verbatim Goal 2 question — best fit for a lower-middle-market
 * healthcare services fund seeking LPs — the agent correctly said the dataset
 * cannot express sector, mandate or market size, and then wrote:
 *
 *   "Confidence scores are Colony Family Offices, LLC: 0.9993"
 *
 * That number is the shortlist's ranking weight over fit, evidence grade,
 * freshness and reachability. Colony holds no sector, AUM or mandate claim, so
 * 99.93% confidence in a healthcare-LP fit rests on nothing. The answer
 * contradicted its own first sentence.
 *
 * Renaming the field helps and does not settle it, because the model can still
 * relabel. This is the part that cannot be talked past.
 *
 * ### 2. Tool internals are not buyer-facing language
 *
 * "Validation gates did not refuse to publish any information, with 0 rows and
 * 0 data." A non-technical buyer cannot read that, and the brief requires every
 * user-visible state to be understandable to one.
 */

const CONFIDENCE_WORD =
  /\b(confidence|confident|probability|probable|certainty|certain|likelihood|likely|evidence strength|strength of evidence|assurance|reliability score)\b/i;

/** Tool-shaped phrasing that must never reach a customer. */
const TOOL_INTERNALS = [
  /\b\d+\s+rows?\b/i,
  /\b(rows?|dataLength|releasedClaims|excludedTotal|appliedFilters|entityId|value_?type|claim_?id|policy_?version)\b/,
  /\b0\s+data\b/i,
  /\bnull\b/,
  /\bundefined\b/,
  /\[\[|\]\]/,
];

export interface ClaimsAudit {
  /** relevance values presented as confidence */
  relevanceAsConfidence: Array<{ value: number; context: string }>;
  /** tool internals leaking into prose */
  internals: string[];
}

/**
 * Does the answer present a relevance score as a confidence?
 *
 * Deliberately lexical. Asking a model whether an answer conflates the two
 * reintroduces the judgement that failed in the first place.
 *
 * A number counts as a relevance score if it matches one the tools returned,
 * either as the raw value (0.9993) or as a percentage (99.93). It counts as
 * *presented as confidence* if a confidence word appears within 120 characters —
 * enough to span "Confidence scores are X: 0.9993, Y: 0.9984" without reaching
 * into an unrelated sentence.
 */
export function auditClaims(answer: string, relevanceScores: number[]): ClaimsAudit {
  const relevanceAsConfidence: Array<{ value: number; context: string }> = [];
  const seen = new Set<number>();

  if (relevanceScores.length) {
    const wanted = new Map<string, number>();
    for (const s of relevanceScores) {
      wanted.set(s.toFixed(4).replace(/0+$/, '').replace(/\.$/, ''), s);
      wanted.set(s.toFixed(3), s);
      wanted.set(s.toFixed(2), s);
      wanted.set((s * 100).toFixed(2).replace(/\.?0+$/, ''), s);
      wanted.set((s * 100).toFixed(1).replace(/\.0$/, ''), s);
      wanted.set(String(Math.round(s * 100)), s);
    }

    for (const m of answer.matchAll(/\d+(?:\.\d+)?/g)) {
      const raw = m[0];
      const score = wanted.get(raw) ?? wanted.get(raw.replace(/0+$/, '').replace(/\.$/, ''));
      if (score === undefined) continue;
      const at = m.index ?? 0;
      const window = answer.slice(Math.max(0, at - 120), Math.min(answer.length, at + 60));
      if (CONFIDENCE_WORD.test(window) && !seen.has(score)) {
        seen.add(score);
        relevanceAsConfidence.push({ value: score, context: window.replace(/\s+/g, ' ').trim() });
      }
    }
  }

  const internals: string[] = [];
  for (const re of TOOL_INTERNALS) {
    const hit = re.exec(answer);
    if (hit && !internals.includes(hit[0])) internals.push(hit[0]);
  }

  return { relevanceAsConfidence, internals };
}

/**
 * What a blocked answer says instead.
 *
 * It states the failure rather than silently softening the wording, because a
 * quietly rewritten answer is indistinguishable from one that was right.
 */
export function confidenceBlockMessage(audit: ClaimsAudit): string {
  const parts: string[] = ['I cannot give this answer as drafted.'];
  if (audit.relevanceAsConfidence.length) {
    parts.push(
      `It presented a search-ranking value (${audit.relevanceAsConfidence.map((r) => r.value).join(', ')}) ` +
      'as a confidence score. That number ranks how well a record matched the filters applied; it is ' +
      'not a measure of confidence in the question you asked, and the dataset does not hold the ' +
      'mandate, sector or allocation evidence that question would need.',
    );
  }
  if (audit.internals.length) {
    parts.push(`It also exposed internal tool output (${audit.internals.join(', ')}) rather than plain language.`);
  }
  return parts.join(' ');
}
