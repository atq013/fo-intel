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

test('identity · surname is taken from before the comma in SEC-format names', async () => {
  const { checkProfileSlug, surnameOf } = await import('./identity.js');
  // ADV Schedule A and 13F write the family name first. Taking the last token
  // rejected /in/dploftus for "LOFTUS, DOUGLAS, PAUL" -- the correct profile.
  assert.equal(surnameOf('LOFTUS, DOUGLAS, PAUL'), 'loftus');
  assert.equal(surnameOf('BUTTAR, Sharnpreet Singh'), 'buttar');
  assert.equal(surnameOf('Douglas Paul Loftus'), 'loftus');
  assert.equal(checkProfileSlug('https://www.linkedin.com/in/dploftus', 'LOFTUS, DOUGLAS, PAUL').ok, true);
});

test('identity · the Stage 1 wrong-person links are still rejected', async () => {
  const { checkProfileSlug } = await import('./identity.js');
  // The two the Stage 1 feedback found. The surname fix must not weaken these.
  assert.equal(checkProfileSlug('https://www.linkedin.com/in/jonas-cohon', 'David Blitzer').ok, false);
  assert.equal(
    checkProfileSlug('https://www.linkedin.com/in/bobby-w-sandage-jr-phd-69087211', 'Rodger Riney').ok,
    false,
  );
});

test('identity · a surname that is only a substring of another name is rejected', async () => {
  const { checkProfileSlug } = await import('./identity.js');
  // Found in production sampling: "curti" sits inside "curtis". Curtis Martin
  // Thom is not Thomas Alfred Curti.
  const r = checkProfileSlug('https://www.linkedin.com/in/curtis-martin-thom-2401aa28', 'CURTI, THOMAS, ALFRED');
  assert.equal(r.ok, false, r.why);
});

test('identity · abbreviated and concatenated slugs still verify', async () => {
  const { checkProfileSlug } = await import('./identity.js');
  assert.equal(checkProfileSlug('https://www.linkedin.com/in/lintonjen', 'LINTON, Vivienne Jennifer').ok, true);
  assert.equal(checkProfileSlug('https://www.linkedin.com/in/davidoconnor', "David O'Connor").ok, true);
  assert.equal(checkProfileSlug('https://www.linkedin.com/in/petermay', 'Peter W. May').ok, true);
  assert.equal(checkProfileSlug('https://www.linkedin.com/in/mr-marian-stupka-569286b', 'STUPKA, MARIAN, NMN').ok, true);
});

test('identity · a surname that is a substring of a slug TOKEN is rejected', async () => {
  const { checkProfileSlug } = await import('./identity.js');
  // "curti" inside "curtis". Alfred Curtis is not Thomas Alfred Curti, even
  // though "alfred" corroborates.
  assert.equal(
    checkProfileSlug('https://www.linkedin.com/in/alfred-curtis-0a61337a', 'CURTI, THOMAS, ALFRED').ok,
    false,
  );
});

test('identity · a surname split by slug punctuation still verifies', async () => {
  const { checkProfileSlug } = await import('./identity.js');
  // "o-connor" is one surname the slug happened to split.
  assert.equal(checkProfileSlug('https://www.linkedin.com/in/david-o-connor-a29410b2', "David O'Connor").ok, true);
  assert.equal(checkProfileSlug('https://www.linkedin.com/in/robert-gale-15195466', 'GALE, Robert John').ok, true);
});
