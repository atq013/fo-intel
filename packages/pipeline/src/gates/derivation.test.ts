import assert from 'node:assert/strict';
import { test } from 'node:test';

import { checkAttribution } from './attribution.js';
import { derivedMethod } from './derivation.js';

/**
 * The derivation kind earns its place only if it still refuses the things gate 2
 * refuses. Every negative case below is a way a caller could smuggle an
 * unchecked value through by calling it "derived".
 */

const SEC_SPAN =
  'Institutional Investment Manager Filing this Report: Name: Kopp Family Office, LLC ' +
  'Address: 8400 NORMANDALE LAKE BOULEVARD SUITE 1450 BLOOMINGTON , MN 55437';

test('derivation · a correct derivation passes', () => {
  const r = checkAttribution('United States', SEC_SPAN, derivedMethod('us_state_to_country', 'MN'));
  assert.equal(r.outcome, 'passed', r.detail);
  assert.match(r.detail, /re-derived/);
});

test('derivation · state code to full name passes', () => {
  const r = checkAttribution('Minnesota', SEC_SPAN, derivedMethod('us_state_code_to_name', 'MN'));
  assert.equal(r.outcome, 'passed', r.detail);
});

test('derivation · an unregistered rule is refused', () => {
  // Otherwise `method` is free text that can assert anything about itself.
  const r = checkAttribution('Atlantis', SEC_SPAN, derivedMethod('vibes_based_geography', 'MN'));
  assert.equal(r.outcome, 'failed');
  assert.match(r.detail, /not registered/);
  assert.ok(r.counterfactual);
});

test('derivation · an input absent from the span is refused', () => {
  // The rule is real and the output is right, but "TX" is nowhere in the filing.
  // Without this check the input could be invented at extraction time.
  const r = checkAttribution('United States', SEC_SPAN, derivedMethod('us_state_to_country', 'TX'));
  assert.equal(r.outcome, 'failed');
  assert.match(r.detail, /does not appear in the span/);
});

test('derivation · a value the rule does not reproduce is refused', () => {
  const r = checkAttribution('Canada', SEC_SPAN, derivedMethod('us_state_to_country', 'MN'));
  assert.equal(r.outcome, 'failed');
  assert.match(r.detail, /yields "United States", not "Canada"/);
});

test('derivation · a rule that does not apply to its input is refused', () => {
  const span = 'Registered office: 1 Test Street, BLOOMINGTON, ZZ 55437';
  const r = checkAttribution('United States', span, derivedMethod('us_state_to_country', 'ZZ'));
  assert.equal(r.outcome, 'failed');
  assert.match(r.detail, /does not apply/);
});

test('derivation · substring inputs do not count as present', () => {
  // "IN" appears inside "BLOOMINGTON". A naive includes() would derive Indiana
  // from a Minnesota filing.
  const r = checkAttribution('Indiana', SEC_SPAN, derivedMethod('us_state_code_to_name', 'IN'));
  assert.equal(r.outcome, 'failed', r.detail);
  assert.match(r.detail, /does not appear in the span/);
});

test('derivation · UK home nation derives one country', () => {
  const span = 'Registered office address: 10 Downing Street, London, England, SW1A 2AA';
  const r = checkAttribution('United Kingdom', span, derivedMethod('uk_nation_to_country', 'England'));
  assert.equal(r.outcome, 'passed', r.detail);
});

test('derivation · non-derived methods are unaffected', () => {
  // The ordinary quoting path must be untouched by the new branch.
  const r = checkAttribution('BLOOMINGTON', SEC_SPAN, 'read from the filing');
  assert.equal(r.outcome, 'passed', r.detail);
  const bad = checkAttribution('701 CARLSON PARKWAY', SEC_SPAN, 'read from the filing');
  assert.equal(bad.outcome, 'failed');
});

test('attribution · a value that is entirely stopwords still resolves', () => {
  // "OR" is Oregon's state code and an English conjunction. Filtering it as a
  // stopword left nothing to compare, and a correct claim was quarantined.
  const span = 'COVERPAGE.FILINGMANAGER_STATEORCOUNTRY: OR';
  const r = checkAttribution('OR', span, 'the state given on the filing cover page');
  assert.equal(r.outcome, 'passed', r.detail);
});

test('attribution · a stopword-only value absent from the span still fails', () => {
  const span = 'COVERPAGE.FILINGMANAGER_STATEORCOUNTRY: CA';
  const r = checkAttribution('OR', span, 'the state given on the filing cover page');
  assert.equal(r.outcome, 'failed');
});
