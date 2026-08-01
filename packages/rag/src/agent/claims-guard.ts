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
 *
 * ### 3. A failed check is not a clean result
 *
 * Same Goal 3 answer, the part that survived the first fix. The agent called
 * `check_evidence` with an invented field, got nothing back, and reported that
 * nothing had been withheld. Making the tool fail closed stopped it returning a
 * misleading empty success -- and the composer wrote the same conclusion anyway,
 * now on top of an explicit validation error.
 *
 * Absence is the hardest thing for a retrieval system to assert honestly and the
 * most damaging to get wrong: "nothing was withheld" is a stronger claim than
 * any value the system publishes, and here it was a claim about a query that
 * could not have found anything. So it is no longer left to the composer. An
 * absence-of-withholding sentence is permitted only when a `check_evidence` call
 * actually completed for that firm, and the run repairs the failed call before
 * composing rather than composing around the hole.
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

/**
 * Sentences asserting that nothing was refused, withheld, blocked or quarantined.
 *
 * Matched on the pairing of a negation with a withholding verb, so "nothing was
 * withheld" and "no values were refused" are caught while "nine values were
 * withheld" -- a true, supported statement -- is not.
 */
// `n't` carries no leading word boundary -- in "didn't" the preceding character
// is a word character, so \bn't\b never matches. Contractions are how a model
// most naturally phrases this, so missing them would miss the common case.
const NEGATION = String.raw`(?:\b(?:no|nothing|none|not|never)\b|n't)`;
const WITHHOLD = String.raw`\b(?:withheld|withhold|withholding|refused|refuse|refusing|blocked|block|blocking|quarantined|quarantine|suppressed|suppress|held back|kept back|excluded|exclude)\b`;

const ABSENCE_OF_WITHHOLDING = new RegExp(
  `${NEGATION}[^.;!?]{0,80}${WITHHOLD}` +
  `|${WITHHOLD}[^.;!?]{0,40}\\b(?:nothing|no (?:values?|claims?|fields?|information|data)|none)\\b`,
  'i',
);

export interface EvidenceCheck {
  entityId: string;
  /** false when the call returned a validation error and checked nothing */
  completed: boolean;
  field?: string;
}

export interface ClaimsAudit {
  /** relevance values presented as confidence */
  relevanceAsConfidence: Array<{ value: number; context: string }>;
  /** tool internals leaking into prose */
  internals: string[];
  /** an assertion that nothing was withheld, with no completed check behind it */
  unsupportedAbsence: string[];
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
export function auditClaims(
  answer: string,
  relevanceScores: number[],
  evidenceChecks: EvidenceCheck[] = [],
): ClaimsAudit {
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

  // An absence claim needs a check that ran. A check that errored is not weaker
  // evidence of absence -- it is none, and the two must not be treated alike.
  // When no check_evidence call was attempted at all this stays silent: that is
  // a different answer shape, judged by the tool-coverage rules, not here.
  const unsupportedAbsence: string[] = [];
  if (evidenceChecks.length && !evidenceChecks.some((c) => c.completed)) {
    for (const sentence of answer.split(/(?<=[.!?])\s+/)) {
      if (ABSENCE_OF_WITHHOLDING.test(sentence)) unsupportedAbsence.push(sentence.trim());
    }
  }

  return { relevanceAsConfidence, internals, unsupportedAbsence };
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
  if (audit.unsupportedAbsence.length) {
    parts.push(
      'It stated that nothing had been withheld — ' +
      `"${audit.unsupportedAbsence[0]}" — when the check that would establish that did not run. ` +
      'I do not know whether anything was withheld for this firm, and saying otherwise would be ' +
      'the one claim in this system a buyer could not verify for themselves.',
    );
  }
  return parts.join(' ');
}
