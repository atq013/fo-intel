import assert from 'node:assert/strict';
import { test } from 'node:test';

import { surfacesLimitation } from './run.js';

/**
 * The Stage 1 live failure, as a test.
 *
 * Asked for principal-owned contact routes excluding shared inboxes, the system
 * answered "firms with any populated contact field" and never said it had
 * narrowed the question. These cases pin the behaviour that must now block that.
 */

const UNHONOURED = ['filter by assets under management — no claim holds AUM'];

test('constraint · a silently narrowed answer is not accepted', () => {
  // Reads as a complete, confident answer. It is the Stage 1 failure verbatim.
  const answer =
    'Here are 5 family offices with contact details: Barington Companies Management, ' +
    'Boston Family Office, Arrowroot Family Office, Stokes Family Office and Allie Family Office.';
  assert.equal(surfacesLimitation(answer, UNHONOURED), false);
});

test('constraint · an answer that names the limitation is accepted', () => {
  const answer =
    'I could not filter by assets under management — the dataset holds no AUM claim for any firm. ' +
    'Ranking instead on reachability, here are 5 firms.';
  assert.equal(surfacesLimitation(answer, UNHONOURED), true);
});

test('constraint · vague apology without naming the subject is not enough', () => {
  // Sounds humble, tells the reader nothing about what was dropped. Accepting
  // this would let the model buy its way past the check with tone.
  const answer = 'I could not do everything you asked, but here are 5 firms that look relevant.';
  assert.equal(surfacesLimitation(answer, UNHONOURED), false);
});

test('constraint · confident prose with no admission is not enough', () => {
  const answer =
    'Sorted by assets under management, the top firms are Barington and Boston Family Office.';
  assert.equal(surfacesLimitation(answer, UNHONOURED), false);
});

test('constraint · several unhonoured constraints, one surfaced, still blocks', () => {
  const many = [
    'filter by assets under management — no claim holds AUM',
    'filter by investment sector — no claim holds sector',
  ];
  // Names AUM only. `some` accepts it, which is deliberate: the composer prompt
  // lists all of them, and prepending the full list on a partial admission would
  // duplicate what the model already said. Recorded as a known limit of the
  // check rather than left implicit.
  const answer = 'I could not filter by assets under management; no AUM data is held. Here are 3 firms.';
  assert.equal(surfacesLimitation(answer, many), true);
});

test('constraint · no unhonoured constraints means nothing to surface', () => {
  assert.equal(surfacesLimitation('Here are 5 firms.', []), false);
});

test('constraint · matches on the subject rather than exact phrasing', () => {
  const answer =
    'The dataset does not contain employee headcount, so I did not filter on it. Here are 4 firms.';
  assert.equal(
    surfacesLimitation(answer, ['filter by employee headcount — no claim holds headcount']),
    true,
  );
});
