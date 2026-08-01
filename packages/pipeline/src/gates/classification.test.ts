import assert from 'node:assert/strict';
import { test } from 'node:test';

import { checkDerivation, derivedMethod, getRule } from './derivation.js';

/**
 * SFO-1 as a re-runnable rule.
 *
 * Stage 1's version of this rule qualified twenty records on family CONTROL and
 * called them family offices. Control proves who owns the entity; it does not
 * prove what the entity does. The rule here requires both the control evidence
 * and the firm's own description, and these tests are mostly about the things it
 * must REFUSE.
 */

const rule = () => getRule('family_surname_control')!;
const apply = (person: string, company: string) => rule().apply(`${person} || ${company}`);

test('classification · a PSC surname in a family-office name qualifies', () => {
  assert.equal(apply('MR JOHN SMITH', 'SMITH FAMILY OFFICE LIMITED'), 'single_family_office');
  assert.equal(apply('LOFTUS, DOUGLAS, PAUL', 'LOFTUS FAMILY INVESTMENT LTD'), 'single_family_office');
});

test('classification · family control WITHOUT a family-office name does not qualify', () => {
  // The Stage 1 error, as a test. The register proves the Smiths control it; it
  // says nothing about the firm being a family office.
  assert.equal(apply('MR JOHN SMITH', 'SMITH ENGINEERING LIMITED'), null);
  assert.equal(apply('MR JOHN SMITH', 'SMITH & SONS BUILDERS LTD'), null);
});

test('classification · a family-office name with an UNRELATED controller does not qualify', () => {
  // Anyone may control a company called "... family office". Without the surname
  // link there is no evidence whose family it is.
  assert.equal(apply('MS AMANDA CLARKE', 'HENDERSON FAMILY OFFICE LIMITED'), null);
});

test('classification · a match on a generic word is refused', () => {
  // "FAMILY" as a surname would otherwise classify most of the register.
  assert.equal(apply('MR PAUL FAMILY', 'ABERDEEN FAMILY OFFICE LTD'), null);
  assert.equal(apply('MRS JANE HOLDINGS', 'JONES FAMILY HOLDINGS LIMITED'), null);
});

test('classification · substring matches do not count', () => {
  // "curti" matched "curtis" in an earlier defect. Here it would invent control.
  assert.equal(apply('MR TOM CURTI', 'CURTIS FAMILY OFFICE LIMITED'), null);
});

test('classification · a two-letter surname is too weak to match on', () => {
  assert.equal(apply('MR LI', 'LI FAMILY OFFICE LIMITED'), null);
});

test('classification · malformed input yields nothing rather than guessing', () => {
  assert.equal(rule().apply('SMITH FAMILY OFFICE LIMITED'), null);
  assert.equal(rule().apply(' || '), null);
  assert.equal(rule().apply(''), null);
});

test('classification · the gate re-derives it and refuses what it cannot reproduce', () => {
  const span =
    'psc.items[].name + company_profile.company_name: MR JOHN SMITH || SMITH FAMILY OFFICE LIMITED';
  const method = derivedMethod('family_surname_control', 'MR JOHN SMITH || SMITH FAMILY OFFICE LIMITED');

  assert.equal(checkDerivation('single_family_office', span, method)?.outcome, 'passed');

  // Upgrading the label past what the rule yields is exactly what must fail.
  const upgraded = checkDerivation('multi_family_office', span, method);
  assert.equal(upgraded?.outcome, 'failed');
  assert.match(upgraded!.detail, /yields "single_family_office"/);
});

test('classification · a span that does not contain the input fails the gate', () => {
  // The extractor cannot feed the rule a pairing it did not actually read.
  const method = derivedMethod('family_surname_control', 'MR JOHN SMITH || SMITH FAMILY OFFICE LIMITED');
  const r = checkDerivation('single_family_office', 'psc.items[].name: MR JOHN SMITH', method);
  assert.equal(r?.outcome, 'failed');
  assert.match(r!.detail, /does not appear in the span/);
});
