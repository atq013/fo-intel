import test from 'node:test';
import assert from 'node:assert/strict';
import {
  newFlushState, shouldFlush, markFlushed, DEFAULT_FLUSH_INTERVAL_MS,
  type RunCounts,
} from './count-flush.js';

const counts = (over: Partial<RunCounts> = {}): RunCounts => ({
  created: 0, released: 0, quarantined: 0, touched: 0, ...over,
});

const T0 = 1_000_000;

test('flush · the first real change is written immediately', () => {
  // lastFlushAt starts at 0, so a run that dies in its first seconds still has
  // its partial count on the row rather than waiting out an interval.
  const s = newFlushState();
  assert.equal(shouldFlush(s, counts({ touched: 1 }), T0), true);
});

test('flush · THE UNKNOWN STATE: opening zeros are never written', () => {
  // `startRun` logs `run_started` before any work exists, and the log path
  // carries the throttled flush. Seeded with null, that first line counted as a
  // change and every run immediately wrote 0/0/0/0 over the NULLs the INSERT
  // left -- so a row said "this run did nothing" from the moment it was born,
  // and a kill before the first real unit was indistinguishable from a run that
  // genuinely did nothing.
  const s = newFlushState();
  assert.equal(shouldFlush(s, counts(), T0), false, 'nothing has happened yet');
  assert.equal(shouldFlush(s, counts(), T0, { force: true }), false, 'not even at a boundary');
  assert.equal(shouldFlush(s, counts(), T0 + DEFAULT_FLUSH_INTERVAL_MS * 100), false);

  // ...and the moment real work lands, it is persisted.
  assert.equal(shouldFlush(s, counts({ touched: 1 }), T0), true);
});

test('flush · a long silent loop still persists on a schedule', () => {
  // `contract` and `backfill-classification` process hundreds of records without
  // logging or checkpointing. With a throttled call per item, the counters reach
  // the row roughly once per interval instead of only at the end.
  const s = newFlushState();
  const c = counts();
  let writes = 0;
  let t = T0;

  for (let item = 1; item <= 500; item++) {
    c.touched = item;                 // the loop body doing its work
    t += 40;                          // ~40ms per record
    if (shouldFlush(s, c, t)) {
      writes++;
      markFlushed(s, c, t);
    }
  }

  const msPerItem = 40;
  const elapsedMs = 500 * msPerItem;

  // One write per interval, give or take the first immediate one -- not 500.
  assert.ok(writes <= Math.ceil(elapsedMs / DEFAULT_FLUSH_INTERVAL_MS) + 1, `too many writes: ${writes}`);
  assert.ok(writes >= 3, `too few writes to survive a kill: ${writes}`);

  // What a kill costs. The loop keeps counting after the last write, so the tail
  // is always lost -- the guarantee is that it is BOUNDED by the interval rather
  // than being the whole run, which is what it was when `finish()` was the only
  // writer. Persisting every item would cost 500 statements to save this much.
  const persisted = Number(s.lastFlushed!.split('/')[0]);
  const lost = 500 - persisted;
  const maxLost = Math.ceil(DEFAULT_FLUSH_INTERVAL_MS / msPerItem) + 1;
  assert.ok(lost <= maxLost, `a kill would lose ${lost} items, more than one interval (${maxLost})`);
  assert.ok(persisted > 300, `only ${persisted} of 500 persisted`);
});

test('flush · unchanged counters are never written', () => {
  const s = newFlushState();
  const c = counts({ touched: 5 });
  assert.equal(shouldFlush(s, c, T0), true);
  markFlushed(s, c, T0);

  // Long past the interval, but nothing has moved: a write storing the same four
  // numbers again is noise in the row's history.
  assert.equal(shouldFlush(s, c, T0 + DEFAULT_FLUSH_INTERVAL_MS * 10), false);
  assert.equal(shouldFlush(s, c, T0 + DEFAULT_FLUSH_INTERVAL_MS * 10, { force: true }), false);
});

test('flush · a change inside the interval waits', () => {
  const s = newFlushState();
  markFlushed(s, counts({ touched: 5 }), T0);
  assert.equal(shouldFlush(s, counts({ touched: 6 }), T0 + 1_000), false);
  assert.equal(shouldFlush(s, counts({ touched: 6 }), T0 + DEFAULT_FLUSH_INTERVAL_MS), true);
});

test('flush · a commit boundary bypasses the interval', () => {
  // What `checkpoint()` relies on: after a unit commits, the row must agree with
  // the checkpoint, whatever the throttle would otherwise say.
  const s = newFlushState();
  markFlushed(s, counts({ touched: 5 }), T0);
  assert.equal(shouldFlush(s, counts({ touched: 6 }), T0 + 1, { force: true }), true);
});

test('flush · every counter is watched, not just the obvious one', () => {
  const base = counts({ touched: 3, created: 2, released: 2, quarantined: 0 });
  for (const field of ['touched', 'created', 'released', 'quarantined'] as const) {
    const s = newFlushState();
    markFlushed(s, base, T0);
    const moved = { ...base, [field]: base[field] + 1 };
    assert.equal(
      shouldFlush(s, moved, T0 + 1, { force: true }), true,
      `a change to ${field} must be persisted`,
    );
  }
});

test('flush · THE PRODUCTION ROW: a quarantine is not lost to a kill', () => {
  // run_20260730191237_40bd4888 held 41 classifications and one quarantine, and
  // its row reported claimsQuarantined: 0 because the counters were only ever
  // written by finish(), which a SIGKILL never reaches.
  const s = newFlushState();
  const working = counts({ touched: 41, created: 41, quarantined: 1 });

  // The checkpoint after that unit forces the write...
  assert.equal(shouldFlush(s, working, T0, { force: true }), true);
  markFlushed(s, working, T0);

  // ...so whatever the row holds after the kill is what actually happened.
  assert.equal(s.lastFlushed, '41/41/0/1');
});

test('flush · markFlushed only records what was actually written', () => {
  const s = newFlushState();
  const written = counts({ touched: 10 });
  markFlushed(s, written, T0);

  // Counters keep moving after the write; the state still describes the write.
  const later = counts({ touched: 12 });
  assert.equal(s.lastFlushed, '10/0/0/0');
  assert.equal(shouldFlush(s, later, T0 + DEFAULT_FLUSH_INTERVAL_MS), true);
});

test('flush · a run that genuinely does nothing never writes', () => {
  // Zero at the start and zero throughout. `finish()` writes the honest zero;
  // this path adds nothing, which is why an idle contract run costs no extra
  // statements.
  const s = newFlushState();
  markFlushed(s, counts(), T0);
  assert.equal(shouldFlush(s, counts(), T0 + DEFAULT_FLUSH_INTERVAL_MS * 100), false);
});

test('flush · the interval is configurable per call', () => {
  const s = newFlushState();
  markFlushed(s, counts({ touched: 1 }), T0);
  const moved = counts({ touched: 2 });
  assert.equal(shouldFlush(s, moved, T0 + 100, { intervalMs: 50 }), true);
  assert.equal(shouldFlush(s, moved, T0 + 10, { intervalMs: 50 }), false);
});
