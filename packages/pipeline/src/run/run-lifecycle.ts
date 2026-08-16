/**
 * Run-lifecycle consistency rules.
 *
 * The operating-window log is the product's evidence surface: a buyer is invited
 * to inspect what ran, when, what it caught and what broke. So a run row is held
 * to the same standard as a claim -- a value the system never observed must not
 * be recorded as though it had been.
 *
 * ### What went wrong
 *
 * `finish()` is the only code path that ends a run, and it writes the end time
 * and the four counters in one statement. A process killed by SIGKILL never
 * reaches it, so its row stays in `running` with the counters at their schema
 * default of 0.
 *
 * Those orphaned rows were later closed by hand:
 *
 *   UPDATE s2_run SET status='aborted', ended_at=now() WHERE status='running'
 *
 * That statement is in the submitted session record, twice without a reason and
 * once with one. It writes an end time and leaves the counters alone, so each
 * swept row asserts two things nothing observed: that the run stopped at the
 * moment of the cleanup, and that it did no work. In the submitted export one
 * `contract` row records a 74-hour duration against a 40-minute maximum across
 * the 108 completed runs that carry log lines -- 109 completed rows in all, the
 * odd one logging nothing -- and a `discover` row reports `claimsQuarantined: 0`
 * while carrying a quarantine decision in the same object.
 *
 * ### Why these rules and not a timestamp heuristic
 *
 * A first draft flagged runs sharing an `ended_at` to the millisecond. That
 * detects this incident and nothing else: it false-positives on genuinely
 * concurrent runs, and a cleanup closing rows one at a time would pass it. It
 * tests the symptom.
 *
 * A second draft asked whether the counters were "unwritten", inferring that
 * from all-zero values. That is unsound on the current schema, and the artifact
 * proves it: roughly forty `contract` runs completed normally with every counter
 * at zero, because `contract` legitimately evaluates nothing until the policy
 * version moves. Zero-because-nothing-happened and zero-because-nobody-wrote-it
 * are indistinguishable while the columns are `NOT NULL DEFAULT 0`. Making them
 * nullable is therefore part of the fix, not a tidy-up.
 *
 * What survives is exact. **`aborted` is a status no code path writes** --
 * `withRun` calls `finish('completed')` or `finish('failed')` and nothing else;
 * the word appears in the codebase only in the vocabulary and the schema's CHECK
 * constraint. Every `aborted` row was therefore set by hand, so its `ended_at`
 * is a cleanup time rather than an observation, whatever its value and however
 * the cleanup was run. The remaining rules compare a row against its own
 * decision log, which needs no inference at all.
 *
 * Pure functions over plain rows on purpose: the same rules run against the
 * database in the `contract` job and against an exported file, so a reviewer can
 * check the artifact without credentials.
 */

/**
 * Statuses the application can actually produce.
 *
 * `halted_budget` is included because the budget guard sets it deliberately.
 * `aborted` is not here, and that absence is the whole point -- see below.
 */
export const CODE_WRITTEN_STATUS = new Set(['running', 'completed', 'failed', 'halted_budget']);

/** A run in one of these is making a claim about how and when it ended. */
export const TERMINAL_STATUS = new Set(['completed', 'failed', 'halted_budget', 'aborted']);

/**
 * The status that only a human can produce.
 *
 * Verifiable with one grep: `aborted` occurs in `vocab.ts`, in the `CHECK`
 * constraint of `003_operating.sql`, and in prose. No call site passes it to
 * `finish()`. A row wearing it was closed out of band.
 */
export const ADMINISTRATIVE_STATUS = 'aborted';

export interface RunCounts {
  recordsTouched: number | null;
  claimsCreated: number | null;
  claimsReleased: number | null;
  claimsQuarantined: number | null;
}

/**
 * A run as either surface presents it.
 *
 * `closedAt`/`closeReason` are optional because rows written before this fix do
 * not carry them -- and their absence on an administratively closed run is
 * itself one of the violations.
 */
export interface RunRecord {
  runId: string;
  job: string;
  trigger: string;
  status: string;
  startedAt: string;
  endedAt: string | null;
  closedAt?: string | null;
  closeReason?: string | null;
  counts: RunCounts;
  failures?: Array<Record<string, unknown>>;
  log: Array<{ at: string; level?: string; event: string }>;
  decisions: Array<{ kind: string }>;
  /**
   * Aggregated decision counts, when the caller has them without the rows.
   *
   * The `contract` job audits every run on every execution, and pulling ~1,500
   * decision rows to count two things would make the audit the most expensive
   * part of the job. Preferred over `decisions` when present; the rules only
   * ever needed the totals.
   */
  decisionCounts?: { total: number; quarantine: number };
}

function decisionTotals(r: RunRecord): { total: number; quarantine: number } {
  if (r.decisionCounts) return r.decisionCounts;
  const list = r.decisions ?? [];
  return { total: list.length, quarantine: list.filter((d) => d.kind === 'quarantine').length };
}

/**
 * These mirror the `s2_run_outcome_times` constraint in `007_run_closure.sql`,
 * one rule per branch, so a row the database would now refuse is also a row this
 * audit reports. The database cannot check the seven historical rows -- the
 * constraint is NOT VALID by design -- so this is where they are caught.
 */
export type LifecycleRule =
  | 'administrative_close_recorded_as_end'
  | 'administrative_close_without_time'
  | 'orphan_closed_without_reason'
  | 'close_reason_without_administrative_close'
  | 'running_with_outcome_time'
  | 'terminal_without_outcome_time'
  | 'completed_run_with_closure_time'
  | 'end_time_and_close_time'
  | 'counts_contradict_decisions'
  | 'no_work_recorded_despite_activity';

/**
 * `error` blocks; `warning` is recorded and does not.
 *
 * The distinction exists for one rule. `no_work_recorded_despite_activity` is
 * correct and already fires on two runs that COMPLETED normally, where the job
 * simply never incremented the counter -- a real gap, but a pre-existing one
 * this branch does not repair. Blocking on it would fail the `contract` job over
 * history rather than over anything the fix is responsible for. It is promoted
 * to `error` once counters are written incrementally and those rows are clean.
 */
export type Severity = 'error' | 'warning';

export interface LifecycleViolation {
  runId: string;
  rule: LifecycleRule;
  severity: Severity;
  detail: string;
}



/**
 * Check one run against every rule.
 *
 * Returns all violations rather than the first: a row can be wrong in more than
 * one way, and reporting one at a time is how the second defect gets missed --
 * the same argument the gate battery makes for running Band A to completion.
 */
export function checkRun(r: RunRecord): LifecycleViolation[] {
  const out: LifecycleViolation[] = [];
  const v = (rule: LifecycleRule, detail: string, severity: Severity = 'error') =>
    out.push({ runId: r.runId, rule, severity, detail });

  const administrative = r.status === ADMINISTRATIVE_STATUS;
  const { total: decisions, quarantine: quarantined } = decisionTotals(r);

  // The core rule, and it needs no threshold. A status the code cannot write was
  // written by hand, so the end time beside it came from the cleanup, not from
  // the run stopping.
  if (administrative && r.endedAt) {
    v(
      'administrative_close_recorded_as_end',
      `status=${r.status} is not written by any code path, so endedAt=${r.endedAt} is the ` +
        'moment the row was closed, not the moment the run stopped. It belongs in closedAt.',
    );
  }

  // Closing an orphan is legitimate. Closing one silently is not: the row then
  // looks exactly like a run that ended on its own terms.
  //
  // An earlier draft accepted a `failures` entry in place of a reason. That was
  // leniency the database does not share -- the constraint names `close_reason`
  // specifically -- and matching it exactly matters more than sparing one
  // historical row. The 10-minute-timeout run does carry its message, but in
  // `failures_json`, which is where a run records what went wrong while running,
  // not why the row was closed afterwards. Those are different facts.
  //
  // Blank counts as absent: '' satisfies NOT NULL and tells a reader nothing.
  if (administrative && !r.closeReason?.trim()) {
    v(
      'orphan_closed_without_reason',
      'closed administratively with no closeReason. A row closed out of band must say ' +
        'that it was, and why, in the field that means it.',
    );
  }

  // A reason is only meaningful beside a closure. On any other status it reads
  // as though the row had been closed out of band when it ended on its own.
  if (!administrative && r.closeReason) {
    v(
      'close_reason_without_administrative_close',
      `status=${r.status} carries a closeReason. That field belongs only to a run whose ` +
        'row was closed for it.',
    );
  }

  // A reason alone is not enough. "Why" without "when" leaves the row unable to
  // say how long it sat orphaned before anyone noticed, which is the operational
  // question the closure timestamp exists to answer.
  if (administrative && !r.closedAt) {
    v(
      'administrative_close_without_time',
      'closed administratively with no closedAt. The moment the row was closed is ' +
        'itself a fact about the system and must be recorded, not discarded.',
    );
  }

  // A run still going has not stopped, so it cannot hold a time saying it did.
  if (r.status === 'running' && (r.endedAt || r.closedAt)) {
    v(
      'running_with_outcome_time',
      `status=running with ${r.endedAt ? 'endedAt' : 'closedAt'} set. A run that has not ` +
        'finished cannot carry a time saying when it did.',
    );
  }

  // A run that finished on its own terms observed its own end, so it must hold
  // `endedAt` -- and only `endedAt`. A closure time here would mean the row was
  // closed for it, which contradicts the status it is claiming.
  const finishedNormally = TERMINAL_STATUS.has(r.status) && !administrative;
  if (finishedNormally && !r.endedAt) {
    v(
      'terminal_without_outcome_time',
      `status=${r.status} with no endedAt. A run that claims to have finished must record ` +
        'when, or the window it belongs to cannot be computed.',
    );
  }
  if (finishedNormally && r.closedAt) {
    v(
      'completed_run_with_closure_time',
      `status=${r.status} carries closedAt=${r.closedAt}. An administrative closure belongs ` +
        'only to a run that never reported its own end.',
    );
  }

  // The two timestamps mean different things and must never both be asserted:
  // one says when the run stopped, the other when we stopped waiting for it.
  if (r.endedAt && r.closedAt) {
    v(
      'end_time_and_close_time',
      `both endedAt=${r.endedAt} and closedAt=${r.closedAt} are set. An observed end ` +
        'and an administrative closure are mutually exclusive.',
    );
  }

  // A counter is a measurement. It may be absent; it may not disagree with the
  // run's own decision log, which is sitting in the same object.
  if (r.counts.claimsQuarantined !== null && r.counts.claimsQuarantined < quarantined) {
    v(
      'counts_contradict_decisions',
      `claimsQuarantined=${r.counts.claimsQuarantined} but the run holds ${quarantined} ` +
        'quarantine decision(s) in the same record.',
    );
  }

  // "Touched nothing" is a strong claim to make beside a list of decisions.
  // Scoped to decisions rather than log lines: bookkeeping events like
  // `run_started` and `contract_scope` are not work, and counting them would
  // accuse every healthy run that legitimately had nothing to do.
  if (r.counts.recordsTouched === 0 && decisions > 0) {
    v(
      'no_work_recorded_despite_activity',
      `recordsTouched=0 while the run holds ${decisions} decision(s). Unknown is not zero.`,
      // Warning, not error: two runs that completed normally already trip this,
      // and repairing the counters is a separate change. See `Severity`.
      'warning',
    );
  }

  return out;
}

export function checkRuns(runs: RunRecord[]): LifecycleViolation[] {
  return runs.flatMap(checkRun);
}

/** What must block a run. The `contract` job fails on a non-empty result. */
export function errors(violations: LifecycleViolation[]): LifecycleViolation[] {
  return violations.filter((v) => v.severity === 'error');
}

/** Recorded and reported, but not blocking. */
export function warnings(violations: LifecycleViolation[]): LifecycleViolation[] {
  return violations.filter((v) => v.severity === 'warning');
}

/** Grouped for a human: which rules fired, and how often. */
export function summarise(violations: LifecycleViolation[]): Partial<Record<LifecycleRule, number>> {
  const out: Partial<Record<LifecycleRule, number>> = {};
  for (const x of violations) out[x.rule] = (out[x.rule] ?? 0) + 1;
  return out;
}

/**
 * The boundary between the historical record and rows written under the fix.
 *
 * Runs that started before this instant are the operating record as submitted.
 * Their defects are real and are reported on every audit -- but they must not
 * fail the build, for a reason that is not convenience: correcting them would
 * mean rewriting evidence that has already been submitted, and leaving them
 * uncorrected while failing every `contract` run would take the job permanently
 * red and train everyone to ignore it. A check that is always failing is a check
 * nobody reads.
 *
 * So they are quarantined in time rather than excused. The count is logged every
 * run, and any row written after this instant blocks normally.
 *
 * Set to the date this fix landed. Deliberately a timestamp and not a list of
 * run ids: an id list would silently excuse a row that happened to be added to
 * it, whereas a cutoff can only ever excuse the past, and the past is finite.
 */
export const LEGACY_BEFORE = '2026-08-15T00:00:00.000Z';

export interface LifecycleAudit {
  /** blocking violations on runs written under the fix */
  blocking: LifecycleViolation[];
  /** violations on pre-fix rows: reported every run, never fatal */
  legacy: LifecycleViolation[];
  /** non-blocking by rule severity, on any row */
  warnings: LifecycleViolation[];
  legacyRunIds: string[];
}

/**
 * Split violations into what must stop the job and what is history.
 *
 * A violation is legacy when its run started before `LEGACY_BEFORE`. Severity is
 * applied first: a `warning` is never blocking whatever its era.
 */
export function auditRuns(runs: RunRecord[], legacyBefore = LEGACY_BEFORE): LifecycleAudit {
  const cutoff = new Date(legacyBefore).getTime();
  const startedAt = new Map(runs.map((r) => [r.runId, new Date(r.startedAt).getTime()]));

  const blocking: LifecycleViolation[] = [];
  const legacy: LifecycleViolation[] = [];
  const warnings: LifecycleViolation[] = [];
  const legacyRunIds = new Set<string>();

  for (const v of checkRuns(runs)) {
    if (v.severity === 'warning') { warnings.push(v); continue; }
    if ((startedAt.get(v.runId) ?? 0) < cutoff) {
      legacy.push(v);
      legacyRunIds.add(v.runId);
      continue;
    }
    blocking.push(v);
  }

  return { blocking, legacy, warnings, legacyRunIds: [...legacyRunIds] };
}
