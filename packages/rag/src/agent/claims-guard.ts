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
  /** gates that actually ran and passed */
  passed?: number;
  /** gates that did not run at all */
  skipped?: number;
}

/**
 * Treating a gate that did not run as one that cleared the value.
 *
 * Two shapes, both produced in the same sentence: an all-clear that names
 * skipping as one of its grounds ("all checks were either passed or skipped"),
 * and a count of what was "checked" that only reconciles if skips are counted
 * as checks.
 *
 * PTC-2 keeps `skipped` and `passed` apart in the database. This keeps them
 * apart in the sentence a buyer reads, which is the only place it matters to
 * them.
 */
const SKIP_AS_CLEARANCE =
  /\b(pass(?:ed|es)?|clear(?:ed)?|fine|ok|satisfactor\w+|success\w*)\b[^.;!?]{0,30}\bor\b[^.;!?]{0,20}\bskip(?:ped)?\b|\bskip(?:ped)?\b[^.;!?]{0,30}\bor\b[^.;!?]{0,20}\b(pass(?:ed|es)?|clear(?:ed)?)\b/i;

/**
 * A sentence that names the skips as not having run is the honest form, not the
 * defect. "A further 84 did not run, so those aspects are unverified" states
 * exactly what this guard is trying to force, and must not be blocked for
 * containing a number larger than the pass count.
 */
const NAMES_THE_SKIP =
  /\b(did ?n[o']t run|did not run|were not run|was not run|never ran|not (?:checked|run|verified|validated|performed)|skipped|unverified|unchecked|no[t]? applicable)\b/i;

const CHECKED_A_COUNT = /\b(check\w*|validat\w*|verif\w*|review\w*|examin\w*|assess\w*)\b[^.;!?]{0,40}?(\d+)|(\d+)\s+[^.;!?]{0,30}?\b(checks?|aspects?|validations?|gates?)\b/i;

/**
 * The answer quoting its own instructions.
 *
 * Production, Goal 3: *"I could not honour these constraints: You could NOT
 * honour these constraints: - Unpublished information ... You MUST state this
 * plainly in your answer, in the first two sentences, in plain words. Say which
 * part of the question you could not do and what you did instead."*
 *
 * A buyer was shown the prompt. Nothing else caught it: the internals guard
 * looks for tool-shaped tokens and this is English, the absence guard had
 * nothing to fire on, and the sentence is not false -- it is just not addressed
 * to the reader.
 *
 * Detected structurally rather than by phrase list, because the next leak will
 * be worded differently: any run of `LEAK_WINDOW` consecutive words shared
 * between the prompt and the answer is a quotation, not a coincidence. Short
 * overlaps are expected and ignored -- the answer legitimately reuses the
 * question's nouns.
 */
const LEAK_WINDOW = 8;

const shingles = (text: string, n: number): Set<string> => {
  const words = text.toLowerCase().replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter(Boolean);
  const out = new Set<string>();
  for (let i = 0; i + n <= words.length; i++) out.add(words.slice(i, i + n).join(' '));
  return out;
};

/**
 * Runs of the prompt that appear verbatim in the answer.
 *
 * `expectedEchoes` are the parts of the prompt the answer is SUPPOSED to
 * reproduce: the unhonourable constraints, which it is required to state
 * plainly, and the question itself. Those are content the prompt carries, not
 * instructions it gives, and matching them is the guard working correctly at the
 * wrong target -- it blocked Goals 2 and 3 for doing exactly what was asked.
 * They are removed before comparison, so what remains to match against is the
 * instruction scaffolding, which is the only part no reader should ever see.
 */
export function findPromptLeak(
  answer: string,
  promptText: string,
  expectedEchoes: string[] = [],
): string[] {
  if (!promptText) return [];
  let instructionsOnly = promptText;
  for (const echo of expectedEchoes) {
    if (echo.trim().length < 4) continue;
    instructionsOnly = instructionsOnly.split(echo).join(' ');
  }
  const fromPrompt = shingles(instructionsOnly, LEAK_WINDOW);
  const hits: string[] = [];
  for (const s of shingles(answer, LEAK_WINDOW)) {
    if (fromPrompt.has(s)) hits.push(s);
  }
  // Overlapping shingles describe one leak; report the distinct starts only.
  return hits.filter((h, i) => !hits.some((o, j) => j < i && o.includes(h.split(' ')[0]!))).slice(0, 3);
}

export interface ClaimsAudit {
  /** relevance values presented as confidence */
  relevanceAsConfidence: Array<{ value: number; context: string }>;
  /** tool internals leaking into prose */
  internals: string[];
  /** an assertion that nothing was withheld, with no completed check behind it */
  unsupportedAbsence: string[];
  /** a skipped gate presented as one that checked or cleared the value */
  skippedAsChecked: string[];
  /** runs of the composer's own instructions quoted back to the reader */
  promptLeak: string[];
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
  promptText = '',
  expectedEchoes: string[] = [],
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

  // Only meaningful when gates were actually skipped. With no skips there is
  // nothing to misrepresent, and "all checks passed" is simply true.
  const skipped = evidenceChecks.reduce((n, c) => n + (c.skipped ?? 0), 0);
  const passed = evidenceChecks.reduce((n, c) => n + (c.passed ?? 0), 0);
  const skippedAsChecked: string[] = [];
  if (skipped > 0) {
    for (const sentence of answer.split(/(?<=[.!?])\s+/)) {
      if (SKIP_AS_CLEARANCE.test(sentence)) {
        skippedAsChecked.push(sentence.trim());
        continue;
      }
      // A count of what was "checked" is only honest at the number that passed.
      // Anything larger is reconciling by counting gates that never ran.
      if (NAMES_THE_SKIP.test(sentence)) continue;
      const m = CHECKED_A_COUNT.exec(sentence);
      const n = m ? Number(m[2] ?? m[3]) : NaN;
      if (Number.isFinite(n) && n > passed) skippedAsChecked.push(sentence.trim());
    }
  }

  return {
    relevanceAsConfidence, internals, unsupportedAbsence, skippedAsChecked,
    promptLeak: findPromptLeak(answer, promptText, expectedEchoes),
  };
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
  if (audit.promptLeak.length) {
    parts.push(
      `It quoted its own instructions back to you — "...${audit.promptLeak[0]}...". ` +
      'That text was addressed to the system, not to you, and should never have appeared in an answer.',
    );
  }
  if (audit.skippedAsChecked.length) {
    parts.push(
      `It reported gates that did not run as though they had cleared the record — ` +
      `"${audit.skippedAsChecked[0]}". A skipped gate is the absence of a check, not a passing one, ` +
      'and counting it toward an all-clear is the one thing this system must never do.',
    );
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
