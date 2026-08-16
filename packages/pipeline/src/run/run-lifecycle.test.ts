import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { checkRun, checkRuns, errors, warnings, summarise, auditRuns, type RunRecord } from './run-lifecycle.js';

/**
 * These rules are proved against the submitted artifact, not a fixture.
 *
 * A check written after the fact can always be made to pass on a fixture built
 * to suit it. The test that means something runs the rules over
 * `exports/operating-window.json` exactly as submitted, shows them firing on the
 * real rows, and shows them silent on all 109 completed rows. A
 * rule that accuses healthy runs would be worse than the defect it catches.
 *
 * The export is read read-only and never rewritten. It is submitted evidence.
 */

const EXPORT = fileURLToPath(new URL('../../../../exports/operating-window.json', import.meta.url));

function loadSubmittedRuns(): RunRecord[] {
  const raw = JSON.parse(readFileSync(EXPORT, 'utf8')) as { runs: any[] };
  return raw.runs.map((r) => ({
    runId: r.runId,
    job: r.job,
    trigger: r.trigger,
    status: r.status,
    startedAt: r.startedAt,
    endedAt: r.endedAt ?? null,
    // The submitted rows predate both columns; their absence is part of what is wrong.
    closedAt: r.closedAt ?? null,
    closeReason: r.closeReason ?? null,
    counts: {
      recordsTouched: r.counts?.recordsTouched ?? null,
      claimsCreated: r.counts?.claimsCreated ?? null,
      claimsReleased: r.counts?.claimsReleased ?? null,
      claimsQuarantined: r.counts?.claimsQuarantined ?? null,
    },
    failures: r.failures ?? [],
    log: r.log ?? [],
    decisions: r.decisions ?? [],
  }));
}

test('lifecycle · every administratively closed run in the submitted export is caught', () => {
  const runs = loadSubmittedRuns();
  const caught = new Set(
    checkRuns(runs)
      .filter((v) => v.rule === 'administrative_close_recorded_as_end')
      .map((v) => v.runId),
  );
  const aborted = runs.filter((r) => r.status === 'aborted').map((r) => r.runId);

  assert.equal(aborted.length, 7, 'the submitted export holds seven administratively closed runs');
  assert.deepEqual([...caught].sort(), [...aborted].sort());
});

test('lifecycle · all seven were closed with no close_reason', () => {
  const runs = loadSubmittedRuns();
  const silent = checkRuns(runs).filter((v) => v.rule === 'orphan_closed_without_reason');
  assert.equal(silent.length, 7);

  // The 10-minute-timeout row is not an exception. It carries its message in
  // `failures`, which records what went wrong WHILE RUNNING -- a different fact
  // from why the row was closed afterwards. The database constraint names
  // `close_reason` specifically, and these rules match it exactly.
  const timeout = runs.find((r) => r.runId === 'run_20260730191237_40bd4888')!;
  assert.ok(timeout.failures!.length > 0, 'it does carry a failure message');
  assert.equal(timeout.closeReason, null, 'but no close_reason, so it is still flagged');
});

test('lifecycle · THE PRODUCTION ROW: a quarantine reported as zero is caught', () => {
  const run = loadSubmittedRuns().find((r) => r.runId === 'run_20260730191237_40bd4888')!;
  const rules = checkRun(run).map((v) => v.rule);
  assert.ok(rules.includes('counts_contradict_decisions'));
  assert.ok(rules.includes('administrative_close_recorded_as_end'));
  assert.ok(rules.includes('no_work_recorded_despite_activity'));
});

test('lifecycle · no healthy run is accused of an administrative close', () => {
  const healthy = loadSubmittedRuns().filter((r) => r.status !== 'aborted');
  assert.ok(healthy.length >= 110, 'sanity: 109 completed plus 2 failed');
  const wrong = checkRuns(healthy).filter(
    (v) => v.rule === 'administrative_close_recorded_as_end' || v.rule === 'orphan_closed_without_reason',
  );
  assert.deepEqual(wrong, [], 'the close rules must fire only on hand-closed rows');
});

/**
 * A `contract` run legitimately evaluates nothing until the policy version moves,
 * and roughly forty of them completed normally with every counter at zero. That
 * is why "all counters zero" cannot stand in for "counters never written" while
 * the columns are NOT NULL DEFAULT 0 -- and why the migration makes them
 * nullable rather than leaving the inference to a rule.
 */
test('lifecycle · zero counters on a legitimately idle run are not a violation', () => {
  // Genuinely idle: nothing to do, and the decision log agrees. Zero is honest here.
  const idleContract = loadSubmittedRuns().filter(
    (r) => r.job === 'contract' && r.status === 'completed'
      && r.counts.recordsTouched === 0 && r.decisions.length === 0,
  );
  assert.ok(idleContract.length > 10, 'the export holds many legitimately idle contract runs');
  assert.deepEqual(checkRuns(idleContract), []);
});

/**
 * Disclosed rather than folded in.
 *
 * Two runs that COMPLETED normally also report `recordsTouched: 0` while holding
 * decisions -- one of them 130. That is a separate, pre-existing gap: those jobs
 * never increment the counter. It is not the sweep defect and is not claimed as
 * part of it. Writing counters incrementally, which this branch does for the
 * orphan case, is also what closes this one; the test pins the current number so
 * a future change to it is deliberate rather than accidental.
 */
test('lifecycle · a separate counter gap on two completed runs is surfaced, not hidden', () => {
  const runs = loadSubmittedRuns();
  const hits = checkRuns(runs).filter((v) => v.rule === 'no_work_recorded_despite_activity');
  const onCompleted = hits.filter(
    (v) => runs.find((r) => r.runId === v.runId)!.status === 'completed',
  );
  assert.equal(onCompleted.length, 2, 'known pre-existing counter gap, disclosed in the write-up');
  // Reported, never blocking — repairing those counters is a separate change.
  assert.ok(hits.every((v) => v.severity === 'warning'));
  assert.deepEqual(errors(onCompleted), []);
});

test('lifecycle · no run that completed normally raises a BLOCKING violation', () => {
  // The gate the `contract` job will use. Healthy history must pass it cleanly,
  // or wiring these rules in would fail the build on data the fix does not touch.
  const healthy = loadSubmittedRuns().filter((r) => r.status !== 'aborted');
  assert.deepEqual(errors(checkRuns(healthy)), []);
  assert.ok(warnings(checkRuns(healthy)).length > 0, 'the counter gap is still reported');
});

test('lifecycle · all seven hand-closed rows lack a closure timestamp', () => {
  const hits = checkRuns(loadSubmittedRuns()).filter(
    (v) => v.rule === 'administrative_close_without_time',
  );
  assert.equal(hits.length, 7);
});

test('lifecycle · every rule fires on the submitted data', () => {
  const counts = summarise(checkRuns(loadSubmittedRuns()));
  // A rule that never fires on the artifact it was written for is decoration.
  assert.ok((counts.administrative_close_recorded_as_end ?? 0) > 0);
  assert.ok((counts.orphan_closed_without_reason ?? 0) > 0);
  assert.ok((counts.counts_contradict_decisions ?? 0) > 0);
  assert.ok((counts.no_work_recorded_despite_activity ?? 0) > 0);
});

// ---- synthetic cases: the shape the fix must produce ------------------------

const orphan = (over: Partial<RunRecord> = {}): RunRecord => ({
  runId: 'run_test', job: 'discover', trigger: 'manual', status: 'aborted',
  startedAt: '2026-08-01T10:00:00.000Z', endedAt: null, closedAt: null, closeReason: null,
  counts: { recordsTouched: null, claimsCreated: null, claimsReleased: null, claimsQuarantined: null },
  failures: [],
  log: [{ at: '2026-08-01T10:00:01.000Z', event: 'run_started' }],
  decisions: [{ kind: 'classify' }],
  ...over,
});

test('lifecycle · an orphan closed the RIGHT way passes', () => {
  // No end time, an explicit closure time, a stated reason, counters left unknown.
  assert.deepEqual(
    checkRun(orphan({
      closedAt: '2026-08-03T15:23:05.606Z',
      closeReason: 'no completion record; process terminated without closing the run',
    })),
    [],
  );
});

test('lifecycle · a reason without a closure time is NOT enough', () => {
  // The gap you spotted: "why" with no "when" used to pass silently.
  const rules = checkRun(orphan({
    closeReason: 'no completion record; process terminated without closing the run',
  })).map((v) => v.rule);
  assert.ok(rules.includes('administrative_close_without_time'));
  // An aborted row is judged by the aborted branch, not the normal-finish one.
  assert.ok(!rules.includes('terminal_without_outcome_time'));
});

test('lifecycle · a terminal run with neither timestamp is rejected', () => {
  const counts = { recordsTouched: 1, claimsCreated: 0, claimsReleased: 0, claimsQuarantined: 0 };
  for (const status of ['completed', 'failed', 'halted_budget']) {
    const rules = checkRun(orphan({ status, closedAt: null, endedAt: null, counts })).map((v) => v.rule);
    assert.ok(rules.includes('terminal_without_outcome_time'), `${status} should be rejected`);
  }
  // An aborted run is rejected by its own branch: it needs closedAt, not endedAt.
  const aborted = checkRun(orphan({ closeReason: 'x', closedAt: null, endedAt: null, counts })).map((v) => v.rule);
  assert.ok(aborted.includes('administrative_close_without_time'));
});

/**
 * One test per branch of the `s2_run_outcome_times` constraint.
 *
 * The earlier draft asserted only that the two timestamps were mutually
 * exclusive, that a closure carried a reason, and that a terminal run had one
 * time or the other -- which still admitted `aborted` WITH an `ended_at`, the
 * exact shape of all seven historical rows. These pin each branch so that hole
 * cannot reopen.
 */
test('lifecycle · THE HOLE: an aborted run may never carry an end time', () => {
  const rules = checkRun(orphan({
    endedAt: '2026-08-03T15:23:05.606Z',
    closedAt: '2026-08-03T15:23:05.606Z',
    closeReason: 'swept',
  })).map((v) => v.rule);
  assert.ok(rules.includes('administrative_close_recorded_as_end'),
    'aborted + endedAt is the defect being fixed and must never pass');
});

test('lifecycle · a blank or whitespace close reason is no reason', () => {
  for (const reason of ['', '   ', '\t\n']) {
    const rules = checkRun(orphan({ closedAt: '2026-08-03T15:23:05.606Z', closeReason: reason }))
      .map((v) => v.rule);
    assert.ok(rules.includes('orphan_closed_without_reason'), `${JSON.stringify(reason)} must not count`);
  }
});

test('lifecycle · only an aborted run may carry a close reason', () => {
  const counts = { recordsTouched: 2, claimsCreated: 1, claimsReleased: 1, claimsQuarantined: 0 };
  const cases: Array<Partial<RunRecord>> = [
    { status: 'completed', endedAt: '2026-08-01T10:05:00.000Z', closeReason: 'stray', counts },
    { status: 'failed', endedAt: '2026-08-01T10:05:00.000Z', closeReason: 'stray', counts },
    { status: 'running', closeReason: 'stray', counts },
  ];
  for (const over of cases) {
    const rules = checkRun(orphan(over)).map((v) => v.rule);
    assert.ok(
      rules.includes('close_reason_without_administrative_close'),
      `${over.status} must not carry a close reason`,
    );
  }
});

test('lifecycle · a running job may hold no outcome time at all', () => {
  const base = { status: 'running', closedAt: null, endedAt: null, closeReason: null };
  assert.deepEqual(checkRun(orphan({ ...base, counts: { recordsTouched: 1, claimsCreated: 0, claimsReleased: 0, claimsQuarantined: 0 } })), []);

  for (const field of ['endedAt', 'closedAt'] as const) {
    const rules = checkRun(orphan({ ...base, [field]: '2026-08-01T10:05:00.000Z', closeReason: 'x' })).map((v) => v.rule);
    assert.ok(rules.includes('running_with_outcome_time'), `running + ${field} should be rejected`);
  }
});

test('lifecycle · a normally finished job uses endedAt only', () => {
  const counts = { recordsTouched: 4, claimsCreated: 2, claimsReleased: 2, claimsQuarantined: 0 };
  assert.deepEqual(checkRun(orphan({ status: 'completed', endedAt: '2026-08-01T10:05:00.000Z', counts })), []);

  const rules = checkRun(orphan({
    status: 'completed', endedAt: null, closedAt: '2026-08-01T10:05:00.000Z', closeReason: 'x', counts,
  })).map((v) => v.rule);
  assert.ok(rules.includes('completed_run_with_closure_time'));
});

test('lifecycle · an orphan closed the WRONG way is caught', () => {
  // Exactly what the sweep produced: an end time, no reason, counters at zero.
  const rules = checkRun(orphan({
    endedAt: '2026-08-03T15:23:05.606Z',
    counts: { recordsTouched: 0, claimsCreated: 0, claimsReleased: 0, claimsQuarantined: 0 },
  })).map((v) => v.rule);
  assert.ok(rules.includes('administrative_close_recorded_as_end'));
  assert.ok(rules.includes('orphan_closed_without_reason'));
  assert.ok(rules.includes('no_work_recorded_despite_activity'));
});

test('lifecycle · asserting both an end time and a closure time is caught', () => {
  assert.ok(
    checkRun(orphan({
      status: 'completed',
      endedAt: '2026-08-03T15:00:00.000Z',
      closedAt: '2026-08-03T15:23:05.606Z',
      counts: { recordsTouched: 3, claimsCreated: 2, claimsReleased: 2, claimsQuarantined: 0 },
    })).some((v) => v.rule === 'end_time_and_close_time'),
  );
});

test('lifecycle · partial counts survive a kill; zeroed counts do not', () => {
  const closed = {
    closedAt: '2026-08-01T10:30:00.000Z',
    closeReason: 'no completion record; process terminated without closing the run',
  };
  // The point of writing counters as work commits: a killed run keeps what it did.
  assert.deepEqual(
    checkRun(orphan({
      ...closed,
      counts: { recordsTouched: 41, claimsCreated: 12, claimsReleased: 9, claimsQuarantined: 1 },
      decisions: [{ kind: 'classify' }, { kind: 'quarantine' }],
    })),
    [],
  );
  assert.ok(
    checkRun(orphan({
      ...closed,
      counts: { recordsTouched: 0, claimsCreated: 0, claimsReleased: 0, claimsQuarantined: 0 },
    })).some((v) => v.rule === 'no_work_recorded_despite_activity'),
  );
});

test('lifecycle · a run that genuinely did nothing is not accused', () => {
  assert.deepEqual(
    checkRun(orphan({
      status: 'completed',
      endedAt: '2026-08-01T10:00:02.000Z',
      counts: { recordsTouched: 0, claimsCreated: 0, claimsReleased: 0, claimsQuarantined: 0 },
      decisions: [],
    })),
    [],
  );
});

// ---- legacy vs blocking, as the contract job partitions them ----------------

test('lifecycle · the seven historical rows are legacy, not blocking', () => {
  const a = auditRuns(loadSubmittedRuns());
  assert.deepEqual(a.blocking, [], 'nothing in the submitted export may fail the build');
  assert.equal(a.legacyRunIds.length, 7, 'all seven hand-closed rows are reported as legacy');
  assert.ok(a.legacy.length >= 7, 'and their violations are still counted, not discarded');
});

test('lifecycle · a violation written AFTER the fix blocks', () => {
  const runs = loadSubmittedRuns();
  // The same defect, on a row dated after the cutoff. History is forgiven once;
  // a repeat is not.
  runs.push({
    runId: 'run_new_bad', job: 'discover', trigger: 'manual', status: 'aborted',
    startedAt: '2026-09-01T10:00:00.000Z',
    endedAt: '2026-09-01T12:00:00.000Z', closedAt: null, closeReason: null,
    counts: { recordsTouched: null, claimsCreated: null, claimsReleased: null, claimsQuarantined: null },
    failures: [], log: [], decisions: [{ kind: 'classify' }],
  });
  const a = auditRuns(runs);
  assert.ok(a.blocking.length > 0, 'a new bad row must fail the job');
  assert.ok(a.blocking.every((v) => v.runId === 'run_new_bad'));
  assert.equal(a.legacyRunIds.length, 7, 'and the legacy set is unchanged');
});

test('lifecycle · a correctly closed run after the fix blocks nothing', () => {
  const runs = loadSubmittedRuns();
  runs.push({
    runId: 'run_new_good', job: 'discover', trigger: 'manual', status: 'aborted',
    startedAt: '2026-09-01T10:00:00.000Z',
    endedAt: null, closedAt: '2026-09-01T12:00:00.000Z',
    closeReason: 'no completion record; process terminated without closing the run',
    counts: { recordsTouched: 41, claimsCreated: 41, claimsReleased: 0, claimsQuarantined: 1 },
    failures: [], log: [], decisions: [{ kind: 'classify' }, { kind: 'quarantine' }],
  });
  assert.deepEqual(auditRuns(runs).blocking, []);
});

test('lifecycle · warnings never block, whatever their era', () => {
  const a = auditRuns(loadSubmittedRuns());
  assert.ok(a.warnings.length > 0, 'the two completed-run counter gaps are still reported');
  assert.ok(a.warnings.every((v) => v.severity === 'warning'));
  assert.ok(!a.blocking.some((v) => v.severity === 'warning'));
});

test('lifecycle · aggregated decision counts agree with decision rows', () => {
  // The contract job passes totals instead of rows; both paths must judge alike.
  const base = {
    runId: 'r', job: 'discover', trigger: 'manual', status: 'aborted',
    startedAt: '2026-09-01T10:00:00.000Z', endedAt: null,
    closedAt: '2026-09-01T11:00:00.000Z', closeReason: 'terminated',
    counts: { recordsTouched: 5, claimsCreated: 0, claimsReleased: 0, claimsQuarantined: 0 },
    failures: [], log: [],
  };
  const fromRows = checkRun({ ...base, decisions: [{ kind: 'classify' }, { kind: 'quarantine' }] });
  const fromCounts = checkRun({ ...base, decisions: [], decisionCounts: { total: 2, quarantine: 1 } });
  assert.deepEqual(fromCounts.map((v) => v.rule), fromRows.map((v) => v.rule));
  assert.ok(fromRows.some((v) => v.rule === 'counts_contradict_decisions'));
});
