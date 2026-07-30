import assert from 'node:assert/strict';
import { test } from 'node:test';

import { resolveNames, normaliseName } from './names.js';

/**
 * The production defect, pinned.
 *
 * The deployed agent wrote "BARRINGTON COMPANIES MANAGEMENT, LLC" for a firm
 * stored as "BARINGTON". One letter, invented by the composer while the tool
 * data underneath was correct.
 */

const CANON = new Map([
  ['ent_sec_0001234567', 'BARINGTON COMPANIES MANAGEMENT, LLC'],
  ['ent_sec_n_boston_family_office', 'BOSTON FAMILY OFFICE LLC'],
  ['ent_sec_n_arrowroot_family_office', 'Arrowroot Family Office, LLC'],
]);

test('names · the intended path substitutes tokens for stored names', () => {
  const r = resolveNames('You can reach [[ent_sec_0001234567]] by phone.', CANON);
  assert.match(r.text, /BARINGTON COMPANIES MANAGEMENT, LLC/);
  assert.equal(r.fabricated.length, 0);
  assert.equal(r.unresolvedTokens.length, 0);
});

test('names · THE PRODUCTION BUG: a misspelled firm is corrected to the stored spelling', () => {
  const r = resolveNames('You can reach BARRINGTON COMPANIES MANAGEMENT, LLC by phone.', CANON);
  assert.match(r.text, /BARINGTON COMPANIES MANAGEMENT, LLC/);
  assert.doesNotMatch(r.text, /BARRINGTON/);
  assert.equal(r.corrected.length, 1);
  assert.equal(r.corrected[0]!.stored, 'BARINGTON COMPANIES MANAGEMENT, LLC');
});

test('names · an exactly-correct name is left untouched', () => {
  const src = 'BOSTON FAMILY OFFICE LLC holds a phone route.';
  const r = resolveNames(src, CANON);
  assert.equal(r.text, src);
  assert.equal(r.corrected.length, 0);
  assert.equal(r.fabricated.length, 0);
});

test('names · a firm that is nowhere in the tool output is flagged as fabricated', () => {
  // Not a near miss of anything held. This must not be silently "corrected"
  // into a real firm — that would swap one falsehood for another.
  const r = resolveNames('Consider Blackstone Alternative Asset Management LLC.', CANON);
  assert.equal(r.fabricated.length, 1);
  assert.match(r.fabricated[0]!, /Blackstone/);
});

test('names · a token the tools never returned is reported, not invented', () => {
  const r = resolveNames('See [[ent_sec_9999999999]] for details.', CANON);
  assert.deepEqual(r.unresolvedTokens, ['ent_sec_9999999999']);
  assert.doesNotMatch(r.text, /ent_sec_9999999999/);
});

test('names · punctuation and case differences resolve to the stored form', () => {
  const r = resolveNames('Arrowroot Family Office LLC was returned.', CANON);
  assert.match(r.text, /Arrowroot Family Office, LLC/);
});

test('names · ordinary prose is not mistaken for a firm', () => {
  const src = 'I could not filter by assets under management. The dataset holds no such claim.';
  const r = resolveNames(src, CANON);
  assert.equal(r.fabricated.length, 0);
  assert.equal(r.text, src);
});

test('names · normalisation ignores suffixes and punctuation', () => {
  assert.equal(normaliseName('Arrowroot Family Office, LLC'), normaliseName('ARROWROOT FAMILY OFFICE LLC'));
  assert.notEqual(normaliseName('BARINGTON COMPANIES'), normaliseName('BARRINGTON COMPANIES'));
});

test('names · a comma-separated list of real firms is not treated as one fabricated name', () => {
  // Regression. The first version of the validator swallowed the whole list as a
  // single phrase, matched nothing, and blocked an answer in which every firm
  // was real. Over-blocking a correct answer is worse than the misspelling the
  // guard exists to catch.
  const canon = new Map([
    ['a', 'Timonier Family Office, LTD.'],
    ['b', 'Virtus Family Office LLC'],
    ['c', 'Callan Family Office, LLC'],
  ]);
  const r = resolveNames(
    'They are Timonier Family Office, LTD., Virtus Family Office LLC, Callan Family Office, LLC.',
    canon,
  );
  assert.deepEqual(r.fabricated, [], `wrongly flagged: ${r.fabricated.join(' | ')}`);
});

test('names · a fabricated firm inside a list of real ones is still caught', () => {
  const canon = new Map([
    ['a', 'Timonier Family Office, LTD.'],
    ['b', 'Virtus Family Office LLC'],
  ]);
  const r = resolveNames(
    'They are Timonier Family Office, LTD., Blackstone Alternative Asset Management LLC.',
    canon,
  );
  assert.equal(r.fabricated.length, 1);
  assert.match(r.fabricated[0]!, /Blackstone/);
});
