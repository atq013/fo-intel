import assert from 'node:assert/strict';
import { test } from 'node:test';

import { auditClaims, confidenceBlockMessage } from './claims-guard.js';
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
