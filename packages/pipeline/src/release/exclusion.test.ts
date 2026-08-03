import assert from 'node:assert/strict';
import { test } from 'node:test';

import { excludedInstitution } from './gate.js';

/**
 * The qualification-risk review, as tests.
 *
 * A review of all 614 qualifying records flagged 27 whose names suggested a
 * service provider. Ten of them were not family offices by any reading. Twelve
 * were ambiguous between single-family office, multi-family office and adviser
 * -- and the brief says explicitly that those must remain visible with their
 * status unresolved, so excluding them would be answering Goal 2 by deleting
 * its difficulty.
 */

test('exclusion · institutions that are not family offices are refused', () => {
  for (const n of [
    'AMERICAN FAMILY MUTUAL INSURANCE COMPANY, S.I.',
    'American Family Insurance Mutual Holding Co',
    'MAGUIRE FAMILY LAW HOLDINGS LIMITED',
    'STOWE FAMILY LAW HOLDINGS LIMITED',
    'FAMILY OFFICE TAX LLP',
    'HERITAGE INDEPENDENT FINANCIAL ADVISERS LIMITED',
    'DECCAN HERITAGE FOUNDATION LIMITED',
    'George Kaiser Family Foundation',
    'Walter Scott Family Foundation',
    'FAMILY INVESTMENT CONSULTING LIMITED',
  ]) {
    assert.ok(excludedInstitution(n), `${n} must be excluded`);
  }
});

test('exclusion · "Law" as a family surname is not a law firm', () => {
  // A greedier pattern excluded THE LAW FAMILY OFFICE LLP, which is the Law
  // family's office. The rule matches "family law", not "law".
  assert.equal(excludedInstitution('THE LAW FAMILY OFFICE LLP'), null);
  assert.ok(excludedInstitution('MAGUIRE FAMILY LAW HOLDINGS LIMITED'));
});

test('exclusion · ambiguous advisers and multi-family offices are KEPT', () => {
  // Goal 2 exists to see what the system does with records it cannot resolve.
  for (const n of [
    'Heritage Family Offices, LLP', 'ASPINALLS FAMILY OFFICE LLP', 'CAPSTONE FAMILY OFFICE LLP',
    'Q FAMILY OFFICE LLP', 'OAK FAMILY ADVISORS, LLC', 'Pinnacle Family Advisors, LLC',
    'Corus Family Wealth Advisors', 'ALLSKO FAMILY OFFICE RESOURCES LLP',
  ]) {
    assert.equal(excludedInstitution(n), null, `${n} must be kept and left unresolved`);
  }
});

test('exclusion · ordinary family offices are untouched', () => {
  for (const n of ['BOSTON FAMILY OFFICE LLC', 'HAYWARD FAMILY HOLDINGS LIMITED', 'AKHTAR FAMILY HOLDINGS LLP']) {
    assert.equal(excludedInstitution(n), null);
  }
});
