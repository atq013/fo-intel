import assert from 'node:assert/strict';
import { test } from 'node:test';

import { selectRotation, type Rotatable } from './refresh-rotation.js';

const at = (iso: string, n: string): Rotatable => ({
  url: `https://api.company-information.service.gov.uk/company/${n}`,
  fetched_at: iso,
});

test('rotation · least recently observed first, not lowest id first', () => {
  // Deliberately ordered the way the database returns them -- by entity id --
  // because taking the head of THAT list is the bug this replaces.
  const rows = [
    at('2026-08-01T10:00:00Z', '10000001'),
    at('2026-07-20T10:00:00Z', '10000002'),
    at('2026-07-25T10:00:00Z', '10000003'),
  ];
  assert.deepEqual(selectRotation(rows, 2), ['10000002', '10000003']);
});

test('rotation · a full sweep reaches every record, none twice', () => {
  const rows = Array.from({ length: 10 }, (_, i) =>
    at(new Date(Date.UTC(2026, 6, 20 + i)).toISOString(), `2000000${i}`));

  const seen = new Set<string>();
  let remaining = [...rows];
  for (let run = 0; run < 5; run++) {
    const batch = selectRotation(remaining, 2);
    for (const n of batch) {
      assert.ok(!seen.has(n), `${n} re-read before the sweep finished`);
      seen.add(n);
    }
    // A re-read record becomes the most recently observed, so it goes to the back.
    remaining = remaining.filter((r) => !batch.includes(r.url.split('/company/')[1] ?? ''));
  }
  assert.equal(seen.size, 10, 'every record must be reached in one sweep');
});

test('rotation · a batch larger than the file is not an error', () => {
  assert.equal(selectRotation([at('2026-08-01T10:00:00Z', '30000001')], 500).length, 1);
});

test('rotation · a url with no company number is dropped rather than sent as empty', () => {
  const rows = [at('2026-07-01T10:00:00Z', ''), at('2026-08-01T10:00:00Z', '40000001')];
  assert.deepEqual(selectRotation(rows, 5), ['40000001']);
});
