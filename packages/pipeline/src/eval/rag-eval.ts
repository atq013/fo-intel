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

type Expect = 'answer' | 'decline';

interface Case {
  question: string;
  expect: Expect;
  why: string;
  /** Strings that must NOT appear in any surviving claim. */
  mustNotContain?: string[];
}

const CASES: Case[] = [
  // --- should answer: the data supports these ---
  { question: 'Who runs Duquesne Family Office?', expect: 'answer', why: 'principal is on record' },
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
    question: 'Which family offices are most likely to invest in AI startups?',
    expect: 'decline',
    why: 'requires a prediction the records do not support',
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
  ms: number;
}

const rows: Row[] = [];

for (const c of CASES) {
  const started = Date.now();
  let got: Expect = 'decline';
  let kept = 0;
  let dropped = 0;
  let leakage: string[] = [];
  let declineReason: string | null = null;

  try {
    const r = await answerQuestion(c.question);
    got = r.answered ? 'answer' : 'decline';
    kept = r.claims.length;
    dropped = r.droppedClaims.length;
    declineReason = r.declineReason;

    const answerText = r.claims.map((x) => x.text).join(' ').toLowerCase();
    leakage = (c.mustNotContain ?? []).filter((t) => answerText.includes(t.toLowerCase()));
  } catch (err) {
    declineReason = `error: ${err instanceof Error ? err.message.slice(0, 90) : err}`;
  }

  const correct = got === c.expect && leakage.length === 0;
  rows.push({ question: c.question, expect: c.expect, got, correct, claimsKept: kept, claimsDropped: dropped, leakage, declineReason, ms: Date.now() - started });

  const mark = correct ? 'ok  ' : 'FAIL';
  console.log(`${mark} [${c.expect.padEnd(7)}→${got.padEnd(7)}] ${c.question.slice(0, 52).padEnd(54)} kept ${kept} dropped ${dropped}`);
  if (leakage.length) console.log(`      LEAKED: ${leakage.join(', ')}`);
  if (!correct && c.expect === 'decline' && got === 'answer') console.log(`      answered when it should not have`);
  if (!correct && c.expect === 'answer' && got === 'decline') console.log(`      declined: ${declineReason?.slice(0, 90)}`);
}

const shouldAnswer = rows.filter((r) => r.expect === 'answer');
const shouldDecline = rows.filter((r) => r.expect === 'decline');

// Framed as a validation layer, the dangerous error is letting an unsupported
// answer through, so that is reported as the false negative rate.
const falseNegatives = shouldDecline.filter((r) => r.got === 'answer' || r.leakage.length > 0);
const falsePositives = shouldAnswer.filter((r) => r.got === 'decline');

const summary = {
  total: rows.length,
  correct: rows.filter((r) => r.correct).length,
  accuracy: rows.filter((r) => r.correct).length / rows.length,
  shouldAnswer: shouldAnswer.length,
  shouldDecline: shouldDecline.length,
  falseNegativeRate: falseNegatives.length / shouldDecline.length,
  falsePositiveRate: falsePositives.length / shouldAnswer.length,
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
console.log(`  median latency:        ${summary.medianMs}ms`);

writeFileSync('data/rag-eval.json', JSON.stringify({ ranAt: new Date().toISOString(), summary, rows }, null, 2));
console.log('\nwrote data/rag-eval.json');
