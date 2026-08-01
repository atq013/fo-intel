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

test('claims · reporting only what passed is allowed', () => {
  const a = auditClaims('78 validation checks passed for this firm.', SCORES, WITH_SKIPS);
  assert.deepEqual(a.skippedAsChecked, []);
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
