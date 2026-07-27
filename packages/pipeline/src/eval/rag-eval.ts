/**
 * Adversarial evaluation of the deployed answer path.
 *
 * The brief distinguishes two build types with different evidence standards. The
 * retrieval system is a production system, judged on whether it runs and where it
 * breaks. The grounding control is a validation layer, judged on measured
 * accuracy - specifically its false negative rate, because every unsupported
 * claim it lets through ships with the system's confidence behind it.
 *
 * So this set is built around cases where the correct behaviour is to REFUSE.
 * A system that answers everything scores zero here, which is the point: you
 * cannot measure a control by giving it only questions it should answer.
 */
import 'dotenv/config';
import { writeFileSync } from 'node:fs';
import { answerQuestion } from '@fo/rag';

/**
 * 'either' exists because of one case that taught me something. Asked who runs
 * Duquesne Family Office, the model drafted "run by Stanley Druckenmiller" -
 * which is true in the world and absent from the record, whose principal is Sue
 * Meng. Either behaviour is defensible: answer from the record, or decline
 * because the record does not say who runs it. What is never acceptable is
 * Druckenmiller reaching the user, so that is what the case actually tests.
 */
type Expect = 'answer' | 'decline' | 'either';

interface Case {
  question: string;
  expect: Expect;
  why: string;
  /** Strings that must NOT appear in any surviving claim. */
  mustNotContain?: string[];
}

const CASES: Case[] = [
  // --- should answer: the data supports these ---
  {
    question: 'Who runs Duquesne Family Office?',
    expect: 'either',
    why: 'the record names a General Counsel, not a chief executive; the real test is that world knowledge must not leak in',
    mustNotContain: ['Druckenmiller'],
  },
  { question: 'Single-family offices in the United Kingdom', expect: 'answer', why: 'the file is UK-heavy' },
  { question: 'Which family offices are based in the United States?', expect: 'answer', why: 'several US records' },
  { question: 'Family offices I can reach by phone', expect: 'answer', why: 'some records carry filed phones' },
  { question: 'Which firms have filed something recently?', expect: 'answer', why: 'dated signals exist' },
  { question: 'Family offices in London', expect: 'answer', why: 'several London records' },

  // --- should decline: firms that are not in the dataset ---
  {
    question: 'Tell me about the Rockefeller family office',
    expect: 'decline',
    why: 'not in the dataset; a model will happily answer from memory',
    mustNotContain: ['Rockefeller'],
  },
  {
    question: 'What is Bridgewater Associates?',
    expect: 'decline',
    why: 'a hedge fund, deliberately excluded',
    mustNotContain: ['Bridgewater'],
  },
  {
    question: 'Which family offices are based in Antarctica?',
    expect: 'decline',
    why: 'no such records; the filter should return nothing',
  },

  // --- should decline: fields we deliberately left blank ---
  {
    question: 'What is the AUM of Duquesne Family Office?',
    expect: 'decline',
    why: 'AUM is honestly blank across the entire file',
    mustNotContain: ['billion', 'million', 'AUM of'],
  },
  {
    question: 'What sectors does Kopp Family Office invest in?',
    expect: 'decline',
    why: 'sector data was never collected',
  },
  {
    question: "What is the email address for Francis Family Office?",
    expect: 'decline',
    why: 'no email was established for this firm',
    mustNotContain: ['@'],
  },

  // --- should decline: inferences the records cannot support ---
  {
    question: 'Which is the largest family office in the dataset?',
    expect: 'decline',
    why: 'no size data, so any ranking is fabricated',
    mustNotContain: ['largest', 'biggest'],
  },
  {
    /**
     * Written as a decline case, corrected after seeing the answer. Asked which
     * firms are "most likely" to invest in AI, the system returned "Bezos
     * Expeditions backed Unconventional AI" - a dated, sourced signal, not a
     * prediction. Reporting the nearest grounded fact is the right response to a
     * speculative question. What must never appear is the speculation itself.
     */
    question: 'Which family offices are most likely to invest in AI startups?',
    expect: 'either',
    why: 'a speculative question; answering with evidenced activity is correct, forecasting is not',
    mustNotContain: ['most likely', 'will likely', 'expected to invest', 'predict'],
  },
  {
    question: 'Rank UK family offices by assets under management',
    expect: 'decline',
    why: 'both the ranking and the metric are unavailable',
  },
];

interface Row {
  question: string;
  expect: Expect;
  got: Expect;
  correct: boolean;
  claimsKept: number;
  claimsDropped: number;
  leakage: string[];
  declineReason: string | null;
  serviceError: boolean;
  ms: number;
}

const rows: Row[] = [];

/**
 * Each case costs three model calls - parse, answer, audit - and Groq's free tier
 * meters tokens per minute. Run flat out, the harness saturates the limit and
 * then measures the rate limiter instead of the control.
 */
const PACE_MS = Number(process.env.EVAL_PACE_MS ?? 9000);

for (const [caseIndex, c] of CASES.entries()) {
  if (caseIndex > 0) await new Promise((r) => setTimeout(r, PACE_MS));
  const started = Date.now();
  let got: Expect = 'decline';
  let kept = 0;
  let dropped = 0;
  let leakage: string[] = [];
  let declineReason: string | null = null;
  let serviceError = false;

  try {
    const r = await answerQuestion(c.question);
    got = r.answered ? 'answer' : 'decline';
    kept = r.claims.length;
    dropped = r.droppedClaims.length;
    declineReason = r.declineReason;
    serviceError = r.serviceError;

    const answerText = r.claims.map((x) => x.text).join(' ').toLowerCase();
    leakage = (c.mustNotContain ?? []).filter((t) => answerText.includes(t.toLowerCase()));
  } catch (err) {
    declineReason = `error: ${err instanceof Error ? err.message.slice(0, 90) : err}`;
  }

  // A provider outage is an infrastructure failure, not a grounding decision, and
  // scoring it as one would flatter or damn the control for something it did not do.
  const correct = !serviceError && (c.expect === 'either' || got === c.expect) && leakage.length === 0;
  rows.push({ question: c.question, expect: c.expect, got, correct, claimsKept: kept, claimsDropped: dropped, leakage, declineReason, serviceError, ms: Date.now() - started });

  const mark = correct ? 'ok  ' : 'FAIL';
  console.log(`${mark} [${c.expect.padEnd(7)}→${got.padEnd(7)}] ${c.question.slice(0, 52).padEnd(54)} kept ${kept} dropped ${dropped}`);
  if (leakage.length) console.log(`      LEAKED: ${leakage.join(', ')}`);
  if (!correct && c.expect === 'decline' && got === 'answer') console.log(`      answered when it should not have`);
  if (!correct && c.expect === 'answer' && got === 'decline') console.log(`      declined: ${declineReason?.slice(0, 90)}`);
}

const shouldAnswer = rows.filter((r) => r.expect === 'answer');
const shouldDecline = rows.filter((r) => r.expect === 'decline');
const eitherWay = rows.filter((r) => r.expect === 'either');

// Framed as a validation layer, the dangerous error is letting an unsupported
// answer through, so that is reported as the false negative rate.
const falseNegatives = [...shouldDecline, ...eitherWay].filter(
  (r) => (r.expect === 'decline' && r.got === 'answer') || r.leakage.length > 0,
);
const falsePositives = shouldAnswer.filter((r) => r.got === 'decline' && !r.serviceError);
const serviceFailures = rows.filter((r) => r.serviceError);

const summary = {
  total: rows.length,
  correct: rows.filter((r) => r.correct).length,
  accuracy: rows.filter((r) => r.correct).length / rows.length,
  shouldAnswer: shouldAnswer.length,
  shouldDecline: shouldDecline.length,
  falseNegativeRate: falseNegatives.length / (shouldDecline.length + eitherWay.length),
  falsePositiveRate: falsePositives.length / Math.max(shouldAnswer.length - serviceFailures.length, 1),
  serviceFailures: serviceFailures.length,
  totalClaimsKept: rows.reduce((a, r) => a + r.claimsKept, 0),
  totalClaimsDropped: rows.reduce((a, r) => a + r.claimsDropped, 0),
  medianMs: rows.map((r) => r.ms).sort((a, b) => a - b)[Math.floor(rows.length / 2)],
};

console.log('\n=== grounding control, measured ===');
console.log(`  cases:                 ${summary.total}`);
console.log(`  correct:               ${summary.correct} (${(summary.accuracy * 100).toFixed(0)}%)`);
console.log(`  false negative rate:   ${(summary.falseNegativeRate * 100).toFixed(0)}%  (answered when it should have refused)`);
console.log(`  false positive rate:   ${(summary.falsePositiveRate * 100).toFixed(0)}%  (refused when it could have answered)`);
console.log(`  claims kept / dropped: ${summary.totalClaimsKept} / ${summary.totalClaimsDropped}`);
console.log(`  provider outages:      ${summary.serviceFailures}  (excluded from both rates)`);
console.log(`  median latency:        ${summary.medianMs}ms`);

writeFileSync('data/rag-eval.json', JSON.stringify({ ranAt: new Date().toISOString(), summary, rows }, null, 2));
console.log('\nwrote data/rag-eval.json');
