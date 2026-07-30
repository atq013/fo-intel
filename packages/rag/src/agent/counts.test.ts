import 'dotenv/config';
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { newMetrics, recordMetrics, resolveCounts, tokenRoster } from './counts.js';

/**
 * The production defect, pinned.
 *
 * On roughly one run in four the composer wrote "0 firms matched out of 119
 * searched" for a query whose tool scope said matched: 1, releasedClaims: 9.
 */

function reg() {
  const r = newMetrics();
  recordMetrics(r, 'search_firms', 1,
    { searched: 119, matched: 1, returned: 1 },
    [{ reason: 'no strictly-reachable route', count: 72 }, { reason: 'below the commercial floor', count: 8 }],
    [{ entityId: 'ent_a', name: 'BOSTON FAMILY OFFICE LLC' }]);
  recordMetrics(r, 'get_firm', 2, { releasedClaims: 9 }, [], { entity: {}, claims: [] });
  return r;
}

test('counts · tokens resolve to the figure the tool returned', () => {
  const r = resolveCounts(
    '[[count:search_firms.matched]] firms matched out of [[count:search_firms.searched]] searched.',
    reg(),
  );
  assert.equal(r.text, '1 firms matched out of 119 searched.');
  assert.equal(r.unsupported.length, 0);
  assert.equal(r.unresolvedTokens.length, 0);
  assert.deepEqual(r.resolved.map((x) => x.value), [1, 119]);
});

test('counts · THE PRODUCTION BUG: an invented count is caught', () => {
  // The exact sentence the deployed agent produced.
  const r = resolveCounts('No evidence backs the contact route as 0 firms matched out of 119 searched.', reg());
  assert.ok(r.unsupported.includes(0), `expected 0 to be unsupported, got ${JSON.stringify(r.unsupported)}`);
});

test('counts · a bare number that IS a real metric is allowed', () => {
  // 119 and 9 both came from tools; stating them plainly is not a fabrication.
  const r = resolveCounts('Across 119 firms searched, this one holds 9 claims.', reg());
  assert.deepEqual(r.unsupported, []);
});

test('counts · a token naming a metric no tool produced is reported', () => {
  const r = resolveCounts('There are [[count:search_firms.aum]] firms.', reg());
  assert.deepEqual(r.unresolvedTokens, ['search_firms.aum']);
  assert.doesNotMatch(r.text, /search_firms\.aum/);
});

test('counts · phone numbers and postcodes are not treated as counts', () => {
  // The guard must stay narrow. These digits are values, not metrics.
  const r = resolveCounts(
    'Reach George Beal on 617-624-0800 at 20 CUSTOM HOUSE STREET, BOSTON 02110.',
    reg(),
  );
  assert.deepEqual(r.unsupported, []);
});

test('counts · exclusion totals from the tool are allowed', () => {
  const r = resolveCounts('72 firms were excluded for having no reachable route.', reg());
  assert.deepEqual(r.unsupported, []);
});

test('counts · an invented exclusion figure is caught', () => {
  const r = resolveCounts('55 firms were excluded for having no reachable route.', reg());
  assert.ok(r.unsupported.includes(55));
});

test('counts · indexed keys address a repeated tool call', () => {
  const r = reg();
  recordMetrics(r, 'search_firms', 3, { searched: 119, matched: 43 }, [], []);
  // the bare key keeps the first call's value; the indexed key reaches the second
  assert.equal(r.values.get('search_firms.matched'), 1);
  assert.equal(r.values.get('search_firms#3.matched'), 43);
  assert.match(tokenRoster(r), /\[\[count:search_firms\.matched\]\] = 1/);
});

test('counts · zero-valued filter sentinels do not silently exclude everything', async () => {
  // Regression for a real defect. The planner emitted freshWithinDays: 0 and
  // maxSourceTier: 0 as "no value". Taken literally both are unsatisfiable --
  // nothing is 0 days old, no source is tier 0 -- so the shortlist returned 0
  // matches while `appliedFilters` (a truthiness test) did not even disclose
  // that a filter had run. The agent then truthfully reported "0 firms matched"
  // and looked like it was inventing numbers. It was not; the tool was.
  const { shortlist } = await import('@fo/db');
  const zeroed = await shortlist({ q: 'family office', freshWithinDays: 0, maxSourceTier: 0 as never, limit: 1 });
  const plain = await shortlist({ q: 'family office', limit: 1 });
  assert.equal(zeroed.scope.matched, plain.scope.matched);
  assert.ok(!zeroed.scope.appliedFilters.some((f) => /within 0d|tier <= 0/.test(f)));
});
