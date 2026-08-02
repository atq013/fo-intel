import assert from 'node:assert/strict';
import { test } from 'node:test';
import 'dotenv/config';

import { auditClaims, confidenceBlockMessage, type EvidenceCheck } from './claims-guard.js';
import { SUPPORTED_EVIDENCE_FIELDS, check_evidence } from './tools.js';

/**
 * Regressions for the three defects the first production goal run exposed.
 * The strings below are the exact text production produced, kept in
 * docs/goals/attempt-1/.
 */

const SCORES = [0.9993, 0.9984, 0.9975];

test('claims · THE GOAL 2 FAILURE: a relevance score presented as confidence is caught', () => {
  const answer =
    'The dataset cannot express market size, investment sector or mandate. Instead, the search ' +
    'returned 80 family offices. Confidence scores are Colony Family Offices, LLC: 0.9993, ' +
    'RiverGlades Family Offices LLC: 0.9993, Allie Family Office LLC: 0.9984.';
  const a = auditClaims(answer, SCORES);
  assert.ok(a.relevanceAsConfidence.length > 0, 'must catch the relabelled score');
  assert.ok(a.relevanceAsConfidence.some((r) => r.value === 0.9993));
  assert.match(confidenceBlockMessage(a), /ranks how well a record matched/);
});

test('claims · the same score as a percentage is also caught', () => {
  // Converting 0.9993 to "99.93% confident" is the same claim in another form.
  const a = auditClaims('We are 99.93% confident in Colony Family Offices, LLC.', SCORES);
  assert.ok(a.relevanceAsConfidence.length > 0);
});

test('claims · stating the relevance score AS a relevance score is allowed', () => {
  // The number is not forbidden — mislabelling it is.
  const a = auditClaims(
    'Ranked by relevance to the filters applied, Colony Family Offices, LLC scores 0.9993.',
    SCORES,
  );
  assert.deepEqual(a.relevanceAsConfidence, []);
});

test('claims · honest low-confidence wording passes', () => {
  const a = auditClaims(
    'I cannot confidently determine fit for a healthcare services fund: the dataset holds no ' +
    'mandate, sector or allocation evidence for any of these firms, so my confidence is low.',
    SCORES,
  );
  assert.deepEqual(a.relevanceAsConfidence, []);
  assert.deepEqual(a.internals, []);
});

test('claims · THE GOAL 3 LEAK: tool internals in buyer-facing prose are caught', () => {
  const answer =
    'Validation gates did not refuse to publish any information, with 0 rows and 0 data.';
  const a = auditClaims(answer, SCORES);
  assert.ok(a.internals.length > 0, 'must catch "0 rows" / "0 data"');
});

test('claims · ordinary business prose is not mistaken for internals', () => {
  const a = auditClaims(
    'BOSTON FAMILY OFFICE LLC holds nine released values, including a phone number that reaches ' +
    'George Beal, its Managing Partner. Nothing was withheld for this firm.',
    SCORES,
  );
  assert.deepEqual(a.internals, []);
  assert.deepEqual(a.relevanceAsConfidence, []);
});

test('evidence fields · THE GOAL 3 DEFECT: an unknown field fails closed', async () => {
  // "contactRoute" does not exist. Previously this returned an empty successful
  // result, which the agent read as "nothing was withheld".
  const r = await check_evidence({ entityId: 'ent_sec_n_boston_family_office', field: 'contactRoute' });
  const data = r.data as Record<string, unknown>;
  assert.equal(data.error, 'unknown_field');
  assert.equal((r.scope as Record<string, unknown>).validationError, true);
  assert.ok(r.limits.some((l) => /says NOTHING about whether values were withheld/i.test(l)));
});

test('evidence fields · the supported list covers the fields the extractors emit', () => {
  for (const f of ['principal.phone', 'principal.fullName', 'principal.linkedinUrl',
                   'officer.postalAddress', 'legalName', 'country']) {
    assert.ok(SUPPORTED_EVIDENCE_FIELDS.includes(f as never), `${f} must be supported`);
  }
  assert.ok(!SUPPORTED_EVIDENCE_FIELDS.includes('contactRoute' as never));
});

/**
 * Absence. The attempt-2 residue: the tool was made to fail closed and the
 * composer wrote the same conclusion on top of the error.
 */

const FAILED: EvidenceCheck[] = [{ entityId: 'ent_sec_n_boston_family_office', field: 'contactRoute', completed: false }];
const RAN: EvidenceCheck[] = [{ entityId: 'ent_sec_n_boston_family_office', completed: true }];

test('claims · THE GOAL 3 RESIDUE: "nothing was withheld" after a failed check is blocked', () => {
  const answer =
    'BOSTON FAMILY OFFICE LLC holds a phone number reaching George Beal, its Managing Partner. ' +
    'The validation gates did not refuse to publish any information about this firm.';
  const a = auditClaims(answer, SCORES, FAILED);
  assert.equal(a.unsupportedAbsence.length, 1);
  assert.match(confidenceBlockMessage(a), /the check that would establish that did not run/);
});

test('claims · the same claim is allowed once a check actually completed', () => {
  // The guard is about whether the check ran, not about the wording.
  const answer = 'The validation gates did not refuse to publish any information about this firm.';
  assert.deepEqual(auditClaims(answer, SCORES, RAN).unsupportedAbsence, []);
  // A failed call followed by the repaired one is also fine: something ran.
  assert.deepEqual(auditClaims(answer, SCORES, [...FAILED, ...RAN]).unsupportedAbsence, []);
});

test('claims · reporting what WAS withheld is never blocked', () => {
  const answer = 'Two values were withheld for this firm: both failed the identity gate.';
  assert.deepEqual(auditClaims(answer, SCORES, FAILED).unsupportedAbsence, []);
});

test('claims · an answer that never claimed a check is left alone', () => {
  // No check_evidence call at all is a different shape and not this guard's job.
  const answer = 'Nothing was withheld.';
  assert.deepEqual(auditClaims(answer, SCORES, []).unsupportedAbsence, []);
  assert.equal(auditClaims(answer, SCORES, FAILED).unsupportedAbsence.length, 1);
});

test('claims · other absence phrasings are caught too', () => {
  for (const a of [
    'No claims were quarantined for this firm.',
    "The gates didn't block anything here.",
    'None of the values were refused publication.',
  ]) {
    assert.equal(auditClaims(a, SCORES, FAILED).unsupportedAbsence.length, 1, a);
  }
});

test('claims · THE ATTEMPT-3 BLOCK: the tool-shaped noun came from the scope key', async () => {
  // The composer emitted the sanctioned count token and wrote the metric's own
  // name around it: "the evidence check found [[count:check_evidence.rows]] rows
  // of evidence". Resolved, that is "54 rows" -- blocked, correctly, as tool
  // language. The model was following the naming it was given.
  assert.ok(auditClaims('the evidence check found 54 rows of evidence', SCORES).internals.length > 0);

  // check_evidence no longer offers `rows` as the noun to copy.
  const r = await check_evidence({ entityId: 'ent_sec_n_boston_family_office' });
  const scope = r.scope as Record<string, unknown>;
  assert.equal(scope.rows, undefined, 'the tool-shaped key is gone');
  // The single total is gone too: it was collapsible, and the composer collapsed
  // it into "checked 54 aspects ... all passed or skipped". Three separate
  // figures replace it, so there is no one number to quote as "checks done".
  assert.equal(scope.gateOutcomes, undefined, 'the collapsible total is gone');
  assert.equal(typeof scope.gatesPassed, 'number');
  assert.equal(typeof scope.gatesSkipped, 'number');
  assert.equal(typeof scope.gatesFailed, 'number');
  assert.match(String(scope.gateOutcomesNote), /never as rows, records or data/);

  // And the phrasing the new names lead to passes.
  const a = auditClaims(
    `${scope.gatesPassed} validation checks passed for this firm.`, SCORES);
  assert.deepEqual(a.internals, []);
});

test('claims · a repaired check still supports an absence statement', () => {
  // Withdrawing the superseded failure must not weaken the absence guard: what
  // licenses the statement is that a check COMPLETED, regardless of what failed
  // before it.
  const answer = 'The validation gates did not refuse to publish anything for this firm.';
  assert.deepEqual(
    auditClaims(answer, SCORES, [
      { entityId: 'ent_x', field: 'contactRoute', completed: false },
      { entityId: 'ent_x', completed: true },
    ]).unsupportedAbsence,
    [],
  );
  // But two failures and no repair still blocks it.
  assert.equal(
    auditClaims(answer, SCORES, [
      { entityId: 'ent_x', field: 'contactRoute', completed: false },
      { entityId: 'ent_x', field: 'gatesRefusal', completed: false },
    ]).unsupportedAbsence.length,
    1,
  );
});

/**
 * Skipped gates read as clearance. The production Goal 3 answer, verbatim, for a
 * firm where 84 of 162 gate outcomes were skipped and 78 passed.
 */

const WITH_SKIPS: EvidenceCheck[] = [
  { entityId: 'ent_sec_n_boston_family_office', completed: true, passed: 78, skipped: 84 },
];
const NO_SKIPS: EvidenceCheck[] = [
  { entityId: 'ent_sec_n_boston_family_office', completed: true, passed: 78, skipped: 0 },
];

test('claims · THE GOAL 3 OVERSTATEMENT: "passed or skipped" as an all-clear is caught', () => {
  const answer =
    'The validation gates checked 54 aspects and refused to publish nothing, as all checks ' +
    'were either passed or skipped.';
  const a = auditClaims(answer, SCORES, WITH_SKIPS);
  assert.ok(a.skippedAsChecked.length > 0);
  assert.match(confidenceBlockMessage(a), /absence of a check, not a passing one/);
});

test('claims · a count of "checked" larger than what passed is caught', () => {
  // 162 only reconciles by counting the 84 gates that never ran.
  const a = auditClaims('The system validated 162 checks for this firm.', SCORES, WITH_SKIPS);
  assert.equal(a.skippedAsChecked.length, 1);
});

test('claims · reporting ONLY what passed is no longer enough', () => {
  // This test previously asserted the opposite. Reporting 78 passes while
  // silently dropping 84 skips is true and still leaves a buyer believing the
  // record was checked, in the one answer whose subject is what validation did.
  // Either the skip count or the true total has to appear with it.
  const a = auditClaims('78 validation checks passed for this firm.', SCORES, WITH_SKIPS);
  assert.equal(a.skippedAsChecked.length, 1);
});

test('claims · naming the skips honestly is allowed', () => {
  const a = auditClaims(
    '78 checks passed. A further 84 did not run, so those aspects are unverified rather than clear.',
    SCORES, WITH_SKIPS,
  );
  assert.deepEqual(a.skippedAsChecked, []);
});

test('claims · with nothing skipped, an all-clear is simply true', () => {
  const answer = 'All 78 checks passed and nothing was refused.';
  assert.deepEqual(auditClaims(answer, SCORES, NO_SKIPS).skippedAsChecked, []);
});

/**
 * The answer quoting its own instructions. Production Goal 3, verbatim.
 */

const COMPOSE_FRAGMENT =
  'You could NOT honour these constraints:\n- Unpublished information — Dataset cannot express ' +
  'unpublished information\n\nYou MUST state this plainly in your answer, in the first two ' +
  'sentences, in plain words. Say which part of the question you could not do and what you did ' +
  'instead. An answer that quietly ignores these is worse than no answer.';

test('claims · THE GOAL 3 PROMPT LEAK: instructions quoted to the buyer are caught', () => {
  const answer =
    'I could not honour these constraints: You could NOT honour these constraints: - Unpublished ' +
    'information — Dataset cannot express unpublished information. You MUST state this plainly in ' +
    'your answer, in the first two sentences, in plain words. Say which part of the question you ' +
    'could not do and what you did instead.';
  const a = auditClaims(answer, SCORES, [], COMPOSE_FRAGMENT);
  assert.ok(a.promptLeak.length > 0, 'must catch the quoted instruction');
  assert.match(confidenceBlockMessage(a), /quoted its own instructions back to you/);
});

test('claims · saying the same thing in its own words is allowed', () => {
  // The behaviour the instruction is asking for, without reciting it.
  const answer =
    'I could not tell you what the system has not published, because the dataset does not hold ' +
    'unpublished information. What I can give you is what it does hold and what the gates refused.';
  assert.deepEqual(auditClaims(answer, SCORES, [], COMPOSE_FRAGMENT).promptLeak, []);
});

test('claims · short overlaps with the prompt are not leaks', () => {
  // An answer legitimately reuses the question's nouns.
  const answer = 'Unpublished information is not held for this firm.';
  assert.deepEqual(auditClaims(answer, SCORES, [], COMPOSE_FRAGMENT).promptLeak, []);
});

test('claims · with no prompt supplied the check is inert rather than guessing', () => {
  assert.deepEqual(auditClaims('any answer at all', SCORES, []).promptLeak, []);
});

test('claims · restating an unhonourable constraint is required, not a leak', () => {
  // This blocked Goals 2 and 3 in production: the constraint text lives in the
  // prompt and the answer is instructed to state it plainly. The guard was
  // firing on the system doing exactly what it was told.
  const unhonourable = 'lower-middle-market — dataset cannot express market size';
  const prompt =
    `You could NOT honour these constraints:\n- ${unhonourable}\n\nYou MUST state this plainly ` +
    'in your answer, in the first two sentences, in plain words.';
  const answer =
    'I could not answer this as asked: lower-middle-market — dataset cannot express market size. ' +
    'Here is what the dataset does hold instead.';
  assert.deepEqual(auditClaims(answer, SCORES, [], prompt, [unhonourable]).promptLeak, []);

  // The scaffolding around it is still caught.
  const reciting =
    'You MUST state this plainly in your answer, in the first two sentences, in plain words.';
  assert.ok(auditClaims(reciting, SCORES, [], prompt, [unhonourable]).promptLeak.length > 0);
});

/**
 * Refusal asserted where nothing was refused, and database vocabulary in prose.
 * Both from the production Goal 3 and Goal 1 answers, verbatim.
 */

const NOTHING_REFUSED: EvidenceCheck[] = [
  { entityId: 'ent_sec_n_boston_family_office', completed: true, passed: 26, skipped: 28, failed: 0, withheldForEntity: 0 },
];
const SOMETHING_REFUSED: EvidenceCheck[] = [
  { entityId: 'ent_x', completed: true, passed: 26, skipped: 28, failed: 2, withheldForEntity: 3 },
];

test('claims · THE GOAL 3 FALSE REFUSAL: never-collected reported as withheld', () => {
  // Boston holds 9 claims, all released, none quarantined; no firm anywhere has
  // a mandate or sector field. The gates cannot have refused what they never saw.
  const answer =
    'The evidence that was refused to be published includes the mandate, sector, allocation, ' +
    'cheque size, and LP data.';
  const a = auditClaims(answer, SCORES, NOTHING_REFUSED);
  assert.equal(a.unsupportedRefusal.length, 1);
  assert.match(confidenceBlockMessage(a), /never collected, which is a different thing/);
});

test('claims · naming those fields as absent rather than refused is allowed', () => {
  const answer =
    'Mandate, sector and allocation are not present in the dataset for any firm, so nothing ' +
    'could be published about them.';
  assert.deepEqual(auditClaims(answer, SCORES, NOTHING_REFUSED).unsupportedRefusal, []);
});

test('claims · a refusal claim is allowed when something really was refused', () => {
  const answer = 'Two values were withheld for this firm after failing the identity gate.';
  assert.deepEqual(auditClaims(answer, SCORES, SOMETHING_REFUSED).unsupportedRefusal, []);
});

test('claims · database vocabulary in buyer prose is caught', () => {
  for (const bad of [
    'BOSTON FAMILY OFFICE LLC is a qualifying firm with a commercial state.',
    "The fields that are missing are listed in the 'missing' field for each firm.",
    'You could not honour the constraint that the dataset must only include family offices.',
  ]) {
    assert.ok(auditClaims(bad, SCORES).internals.length > 0, bad);
  }
});

test('claims · ordinary business phrasing of the same points passes', () => {
  const good =
    'BOSTON FAMILY OFFICE LLC meets the inclusion standard. Each firm below lists what it does ' +
    'not have. I could not filter on sector, because the dataset does not record it. ' +
    'You may want to approach Colony first.';
  const a = auditClaims(good, SCORES);
  assert.deepEqual(a.internals, []);
});

test('claims · the agent reporting its own inability is not a refusal claim', () => {
  // This blocked Goal 3 in production. The sentence contains "refusal" and
  // asserts the opposite of a refusal having happened: it is the agent stating
  // its own limit, which is the behaviour the system wants.
  const answer =
    "I could not determine the validation gates' refusal reasons for BOSTON FAMILY OFFICE LLC " +
    'as this information is not explicitly provided.';
  assert.deepEqual(auditClaims(answer, SCORES, NOTHING_REFUSED).unsupportedRefusal, []);

  // The sentence the guard exists for is still caught.
  const asserting =
    'The evidence that was refused to be published includes the mandate, sector and allocation, ' +
    'as these fields are not present.';
  assert.equal(auditClaims(asserting, SCORES, NOTHING_REFUSED).unsupportedRefusal.length, 1);
});

test('claims · citing passes while dropping the skips is caught', () => {
  // True and still misleading: "passed 26 checks" reads as "this record was
  // checked" when 28 of 54 never ran -- in the one answer whose subject is
  // what validation did. Either the skip count or the total discloses the gap.
  // WITH_SKIPS is 78 passed, 84 skipped -- 162 outcomes in total.
  assert.equal(auditClaims('The validation gates passed 78 checks.', SCORES, WITH_SKIPS)
    .skippedAsChecked.length, 1);
  assert.deepEqual(auditClaims('The gates passed 78 checks, skipped 84, and failed 0.', SCORES, WITH_SKIPS)
    .skippedAsChecked, []);
  assert.deepEqual(auditClaims('Of 162 validation checks, 78 passed.', SCORES, WITH_SKIPS)
    .skippedAsChecked, []);
  // With nothing skipped there is no gap to disclose.
  assert.deepEqual(auditClaims('The validation gates passed 78 checks.', SCORES, NO_SKIPS)
    .skippedAsChecked, []);
});

test('claims · sharing the prompt’s domain vocabulary is not a leak', () => {
  // This blocked Goal 1. The prompt's own rules name the fields whose absence
  // the answer is supposed to report, so an answer doing exactly that shares
  // eight words with its instructions while leaking nothing. The overlap has to
  // carry the instruction's voice, not just its nouns.
  const prompt =
    'You MUST state this plainly in your answer, in the first two sentences. If the evidence ' +
    'for the specific question is absent — no mandate, sector, allocation, cheque size or LP ' +
    'data — say confidence is low.';
  const sharing =
    'The system does not hold mandate, sector, allocation, cheque size or LP data for any firm.';
  assert.deepEqual(auditClaims(sharing, SCORES, [], prompt).promptLeak, []);

  const reciting = 'You MUST state this plainly in your answer, in the first two sentences.';
  assert.ok(auditClaims(reciting, SCORES, [], prompt).promptLeak.length > 0);
});
