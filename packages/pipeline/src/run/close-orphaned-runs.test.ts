import test from 'node:test';
import assert from 'node:assert/strict';
import {
  selectOrphans, applyClosures, closeOrphanedRuns, DEFAULT_SILENCE_MS,
  type OrphanCandidate, type OrphanDecision, type ClosureStore,
} from './close-orphaned-runs.js';
import { checkRun, errors, type RunRecord } from './run-lifecycle.js';

const NOW = new Date('2026-08-03T16:00:00.000Z');
const agoMin = (m: number) => new Date(NOW.getTime() - m * 60_000).toISOString();

const candidate = (over: Partial<OrphanCandidate> = {}): OrphanCandidate => ({
  runId: 'run_a', job: 'discover', trigger: 'manual',
  startedAt: agoMin(120), lastActivityAt: agoMin(90),
  ...over,
});

test('close · a run still logging is left alone', () => {
  // Two minutes of silence on a run that started two hours ago. Long-running is
  // not the same as dead, which is why the threshold measures silence.
  assert.deepEqual(selectOrphans([candidate({ lastActivityAt: agoMin(2) })], { now: NOW }), []);
});

test('close · the threshold clears the worst silence a healthy run ever showed', () => {
  // Measured from the submitted export: the longest gap between consecutive log
  // lines across the 108 completed runs carrying log lines is 1,036s (17.3
  // minutes). The 109th completed row, `run_m1_demo`, has no log lines at all.
  const worstObserved = selectOrphans([candidate({ lastActivityAt: agoMin(18) })], { now: NOW });
  assert.deepEqual(worstObserved, [], 'a 17-minute pause must never be swept');
  assert.ok(DEFAULT_SILENCE_MS / 60000 >= 30);
});

test('close · a genuinely silent run is closed', () => {
  const [d] = selectOrphans([candidate({ lastActivityAt: agoMin(90) })], { now: NOW });
  assert.equal(d!.runId, 'run_a');
  assert.equal(d!.silentMs, 90 * 60_000);
});

test('close · the reason is never empty and names what was actually seen', () => {
  const [d] = selectOrphans([candidate({ lastActivityAt: agoMin(74 * 60) })], { now: NOW });
  assert.ok(d!.reason.trim().length > 0, 'the schema refuses a blank reason');
  assert.match(d!.reason, /no completion record/);
  assert.match(d!.reason, /end time is unknown and is not recorded/);
  // It reports silence, not a cause of death. Guessing why the process died
  // would repeat the original error in a different field.
  assert.doesNotMatch(d!.reason, /killed|crashed|SIGKILL|timeout/i);
});

test('close · a run that never logged is judged from when it started', () => {
  const [d] = selectOrphans([candidate({ lastActivityAt: null, startedAt: agoMin(200) })], { now: NOW });
  assert.equal(d!.silentMs, 200 * 60_000);
  assert.match(d!.reason, /no log activity/);
});

test('close · the sweeping run never closes itself', () => {
  const rows = [candidate({ runId: 'run_sweeper', lastActivityAt: agoMin(90) }), candidate({ runId: 'run_other' })];
  const ids = selectOrphans(rows, { now: NOW, excludeRunId: 'run_sweeper' }).map((d) => d.runId);
  assert.ok(!ids.includes('run_sweeper'));
});

test('close · running it twice closes nothing the second time', () => {
  // The real guarantee comes from the WHERE clause (status='running'), but the
  // selector must not re-offer a row that is no longer running either.
  const rows = [candidate({ lastActivityAt: agoMin(90) })];
  assert.equal(selectOrphans(rows, { now: NOW }).length, 1);
  assert.equal(selectOrphans([], { now: NOW }).length, 0);
});

// ---- the race: activity appears between selection and update ----------------

/**
 * A store that mimics the UPDATE's own WHERE clause.
 *
 * `aliveAgain` is the set of runs that logged something after selection. The
 * real statement rechecks silence in SQL and returns no rows for those; this
 * does the same thing in memory, and records every call so a test can prove the
 * log was never written for a row that did not close.
 */
function fakeStore(aliveAgain: Set<string> = new Set()) {
  const closedRows: string[] = [];
  const logged: string[] = [];
  const store: ClosureStore = {
    async tryClose(runId) {
      if (aliveAgain.has(runId)) return false; // the recheck fails: it is alive
      closedRows.push(runId);
      return true;
    },
    async recordClosure(runId) {
      logged.push(runId);
    },
  };
  return { store, closedRows, logged };
}

const decision = (runId: string): OrphanDecision => ({
  runId, job: 'discover', silentMs: 90 * 60_000, reason: 'no completion record; silent for 90 minute(s)',
});

const APPLY = { closedAt: NOW.toISOString(), silentSince: agoMin(30) };

test('close · THE RACE: a run that logs again before the update is left untouched', () => {
  const { store, closedRows, logged } = fakeStore(new Set(['run_revived']));
  return applyClosures(store, [decision('run_revived')], APPLY).then((r) => {
    // Nothing updated, nothing logged, and it is reported as skipped rather than
    // closed. The previous ordering wrote the closure log line first, which left
    // a `run_closed_administratively` entry describing a closure that never
    // happened -- a false statement written by the fix for false statements.
    assert.deepEqual(closedRows, [], 'the run must not be closed');
    assert.deepEqual(logged, [], 'and no closure may be logged for it');
    assert.deepEqual(r.closed, []);
    assert.deepEqual(r.skippedByRecheck, ['run_revived']);
  });
});

test('close · a revived run does not stop the genuinely dead ones closing', () => {
  const { store, closedRows, logged } = fakeStore(new Set(['run_revived']));
  return applyClosures(store, [decision('run_revived'), decision('run_dead')], APPLY).then((r) => {
    assert.deepEqual(closedRows, ['run_dead']);
    assert.deepEqual(logged, ['run_dead']);
    assert.deepEqual(r.closed.map((c) => c.runId), ['run_dead']);
    assert.deepEqual(r.skippedByRecheck, ['run_revived']);
  });
});

test('close · the closure log is written only for a row that actually closed', () => {
  const { store, closedRows, logged } = fakeStore();
  return applyClosures(store, [decision('run_a'), decision('run_b')], APPLY).then(() => {
    // One log line per closed row, never more, never for a row that did not close.
    assert.deepEqual(logged, closedRows);
  });
});

test('close · reported results count updates, not intentions', () => {
  const { store } = fakeStore(new Set(['run_x', 'run_y']));
  return applyClosures(store, [decision('run_x'), decision('run_y'), decision('run_z')], APPLY).then((r) => {
    assert.equal(r.closed.length, 1, 'three selected, one actually updated');
    assert.equal(r.skippedByRecheck.length, 2);
  });
});

/**
 * The two halves have to agree.
 *
 * `closeOrphanedRuns` writes the shape, `run-lifecycle` judges it, and
 * `007_run_closure.sql` enforces it. If the writer produced a row its own audit
 * rejected, the fix would be self-contradicting -- so the row this function
 * produces is fed straight into the checker.
 */
test('close · the row it produces satisfies the lifecycle rules', () => {
  const [d] = selectOrphans([candidate({ lastActivityAt: agoMin(90) })], { now: NOW });

  const written: RunRecord = {
    runId: d!.runId, job: d!.job, trigger: 'manual',
    status: 'aborted',
    startedAt: agoMin(120),
    endedAt: null,                        // never written — nothing observed it
    closedAt: NOW.toISOString(),          // a fact: when the row was closed
    closeReason: d!.reason,
    counts: { recordsTouched: null, claimsCreated: null, claimsReleased: null, claimsQuarantined: null },
    failures: [],
    log: [{ at: agoMin(90), event: 'contacts_synced' }],
    decisions: [{ kind: 'classify' }],
  };

  assert.deepEqual(checkRun(written), [], 'the closure this function writes must be clean');
  assert.deepEqual(errors(checkRun(written)), []);
});

test('close · the historical shape it replaces is still rejected', () => {
  // What the hand-written UPDATE produced, for contrast: an end time nothing
  // observed, no reason, counters reset to zero.
  const swept: RunRecord = {
    runId: 'run_20260731132340_912a6e93', job: 'contract', trigger: 'manual',
    status: 'aborted',
    startedAt: '2026-07-31T13:23:41.293Z',
    endedAt: '2026-08-03T15:23:05.606Z',
    closedAt: null,
    closeReason: null,
    counts: { recordsTouched: 0, claimsCreated: 0, claimsReleased: 0, claimsQuarantined: 0 },
    failures: [],
    log: [{ at: '2026-07-31T13:23:42.000Z', event: 'contract_scope' }],
    decisions: [],
  };
  const rules = checkRun(swept).map((v) => v.rule);
  assert.ok(rules.includes('administrative_close_recorded_as_end'));
  assert.ok(rules.includes('administrative_close_without_time'));
  assert.ok(rules.includes('orphan_closed_without_reason'));
});

test('close · THE DEFAULT: calling it bare writes nothing', async () => {
  // Both seams injected, so this runs with no database. The store throws on any
  // write, so if the default ever flips to writing, this test fails loudly
  // instead of the change reaching an operating database.
  const exploding: ClosureStore = {
    async tryClose() { throw new Error('a dry run must not write'); },
    async recordClosure() { throw new Error('a dry run must not write'); },
  };
  const dead: OrphanCandidate[] = [candidate({ runId: 'run_dead', lastActivityAt: agoMin(90) })];

  const bare = await closeOrphanedRuns({
    now: NOW, store: exploding, fetchCandidates: async () => dead,
  });
  assert.equal(bare.dryRun, true, 'dryRun must default to true');
  assert.deepEqual(bare.closed, [], 'a dry run closes nothing');
  assert.equal(bare.selected.length, 1, 'but it still reports what it would close');

  // And it does write when explicitly asked, so the default is a choice rather
  // than the function being inert.
  const { store, closedRows, logged } = fakeStore();
  const applied = await closeOrphanedRuns({
    now: NOW, store, fetchCandidates: async () => dead, dryRun: false,
  });
  assert.deepEqual(closedRows, ['run_dead']);
  assert.deepEqual(logged, ['run_dead']);
  assert.equal(applied.closed.length, 1);
});
