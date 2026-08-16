import { connect, withRetry } from '../../../db/src/connect.js';

/**
 * Closing a run whose process died, without inventing what it did.
 *
 * `withRun` closes a run on normal completion and on a caught failure. It cannot
 * close one on `SIGKILL` -- there is no handler for that -- so a killed process
 * leaves its row in `running` forever, and every later window query has to
 * decide what to do with a run that never ended.
 *
 * That is a real operational need, and it was met with a real operational
 * mistake. Three statements in the submitted session record closed the orphans
 * by hand:
 *
 *   UPDATE s2_run SET status='aborted', ended_at=now() WHERE status='running'
 *
 * `ended_at` is the field meaning "the run stopped here", and it was given the
 * time of the cleanup. All seven `aborted` rows in the submitted export carry an
 * end time written that way -- `finish()` writes the end time and the counters
 * together, and all seven still hold default counters, so it never ran on any of
 * them. Three also show extreme spans -- 43.9h, 50.1h and 74.0h -- against a
 * 40-minute maximum across the 108 completed runs that carry log lines. There are
 * 109 completed rows in all; the odd one, `run_m1_demo`, logs nothing and lasted
 * 0.1 minutes, so it does not move that maximum. The remaining four aborted rows
 * are closer to their last activity only because the cleanup happened sooner.
 * None of the seven records why it stopped.
 *
 * This function is the supported way to do the same job. Three differences, and
 * each maps to a column added in `007_run_closure.sql`:
 *
 *   - it never writes `ended_at`, because nothing observed the run ending
 *   - it writes `closed_at`, which is a fact: when the row was closed
 *   - it writes a `close_reason` stating what was actually seen, which is
 *     silence, not a cause of death
 *
 * It also leaves the counters alone. After 007 they are nullable, so a killed
 * run reports NULL rather than 0 -- and once `withRun` writes them as work
 * commits, it reports what it genuinely managed before it died.
 */

/**
 * How long a run may be silent before it is treated as dead.
 *
 * Measured rather than guessed. Across the 108 completed runs in
 * `exports/operating-window.json` that carry log lines -- the 109th and last,
 * `run_m1_demo`, has none -- the longest gap between consecutive log lines is
 * 1,036s (17.3 minutes) and the 95th percentile is 238s (4 minutes). Thirty
 * minutes is ~1.7x the worst case observed, which is the margin that stops this
 * from ever closing a run that is merely slow.
 *
 * Silence is the right signal, not total duration: a long run that is still
 * logging is alive, and a short run that stopped logging is not.
 */
export const DEFAULT_SILENCE_MS = 30 * 60 * 1000;

export interface OrphanCandidate {
  runId: string;
  job: string;
  trigger: string;
  startedAt: string;
  /** newest log line for this run, or null when it never logged one */
  lastActivityAt: string | null;
}

export interface OrphanDecision {
  runId: string;
  job: string;
  silentMs: number;
  /** written verbatim to `close_reason`; never empty */
  reason: string;
}

function ms(from: string, to: Date): number {
  return to.getTime() - new Date(from).getTime();
}

/**
 * Which running rows are actually dead, and what to record about each.
 *
 * Pure so it can be tested without a database, and so the judgement is
 * inspectable separately from the write.
 *
 * `excludeRunId` is the run doing the sweeping. Without it a job that closes
 * orphans would eventually close itself, which is the kind of bug that only
 * appears once the job has been running long enough to pass its own threshold.
 */
export function selectOrphans(
  rows: OrphanCandidate[],
  opts: { now: Date; silenceMs?: number; excludeRunId?: string },
): OrphanDecision[] {
  const silenceMs = opts.silenceMs ?? DEFAULT_SILENCE_MS;
  const out: OrphanDecision[] = [];

  for (const r of rows) {
    if (opts.excludeRunId && r.runId === opts.excludeRunId) continue;

    // A run that never logged is judged from when it started; there is nothing
    // else to go on, and "started and never spoke" is itself the observation.
    const since = r.lastActivityAt ?? r.startedAt;
    const silentMs = ms(since, opts.now);
    if (silentMs < silenceMs) continue;

    const minutes = Math.floor(silentMs / 60000);
    // Says only what was seen. The process may have been killed, the machine may
    // have gone away, the job may have hung -- none of that is observable from
    // here, and a reason that guessed would be the same class of error as an
    // end time that was never measured.
    const reason = r.lastActivityAt
      ? `no completion record; last activity ${r.lastActivityAt}, silent for ${minutes} minute(s) ` +
        'when the row was closed. The end time is unknown and is not recorded.'
      : `no completion record and no log activity; started ${r.startedAt}, silent for ` +
        `${minutes} minute(s) when the row was closed. The end time is unknown and is not recorded.`;

    out.push({ runId: r.runId, job: r.job, silentMs, reason });
  }

  return out;
}

export interface CloseResult {
  scanned: number;
  /** met the silence threshold: what a dry run reports it *would* close */
  selected: OrphanDecision[];
  /**
   * Rows an UPDATE actually changed. Never merely selected, and always empty on
   * a dry run -- kept separate from `selected` so a caller cannot report an
   * intention as an outcome, which is the same error this whole branch is about.
   */
  closed: OrphanDecision[];
  /** selected, then found alive again at update time and left alone */
  skippedByRecheck: string[];
  /** running rows never selected, because they are still speaking */
  leftRunning: number;
  dryRun: boolean;
}

/**
 * The two writes, behind an interface so the race can be tested.
 *
 * Selection reads the log; the update happens afterwards. In between, the run
 * may come back to life -- a process that was merely paused, or a slow unit that
 * finally committed. Closing it then would kill a live run's record, which is
 * strictly worse than leaving an orphan open for another cycle.
 */
export interface ClosureStore {
  /**
   * Close the run only if it is *still* running and *still* silent, in one
   * statement, and report whether a row actually changed.
   *
   * The silence recheck lives in the statement's own WHERE clause rather than in
   * a separate read, so a run that logged while we were deciding fails the
   * condition instead of being closed on stale information.
   */
  tryClose(runId: string, closedAt: string, reason: string, silentSince: string): Promise<boolean>;
  /** Record the closure on the run's own log. Called only for a row that closed. */
  recordClosure(runId: string, detail: Record<string, unknown>): Promise<void>;
}

/**
 * Apply the selected closures, honouring the recheck.
 *
 * Order matters and it is the opposite of the first draft. That one wrote the
 * log line first, so a run which came back to life between selection and update
 * got a `run_closed_administratively` entry describing a closure that never
 * happened -- a false statement in the operating log, written by the fix for
 * false statements in the operating log.
 *
 * Now the update decides. Only a row it actually changed is logged, and only
 * such a row is reported as closed. If the log write fails after a successful
 * update the reason is still on the run row itself, so the closure is never
 * unexplained -- which is why this is the safer order of the two.
 */
export async function applyClosures(
  store: ClosureStore,
  decisions: OrphanDecision[],
  opts: { closedAt: string; silentSince: string },
): Promise<{ closed: OrphanDecision[]; skippedByRecheck: string[] }> {
  const closed: OrphanDecision[] = [];
  const skippedByRecheck: string[] = [];

  for (const d of decisions) {
    const didClose = await store.tryClose(d.runId, opts.closedAt, d.reason, opts.silentSince);
    if (!didClose) {
      skippedByRecheck.push(d.runId);
      continue;
    }
    await store.recordClosure(d.runId, {
      silentMs: d.silentMs,
      closedAt: opts.closedAt,
      reason: d.reason,
    });
    closed.push(d);
  }

  return { closed, skippedByRecheck };
}

/**
 * Find every orphaned run and close it properly.
 *
 * **Dry run unless told otherwise.** `dryRun` defaults to `true`, so importing
 * this function and calling it bare reports what it would do and writes nothing.
 * The destructive behaviour has to be asked for by name. This operates on the
 * operating record itself -- the artifact the product invites a buyer to
 * inspect -- and a default that writes is a default that eventually writes by
 * accident.
 *
 * Safe to run repeatedly: a row it closes is no longer `running`, so a second
 * invocation finds nothing. Safe to run while other jobs are working, because
 * only silence past the threshold qualifies and the update rechecks it.
 */
export async function closeOrphanedRuns(opts: {
  silenceMs?: number;
  excludeRunId?: string;
  /** defaults to TRUE — pass `false` to actually write */
  dryRun?: boolean;
  now?: Date;
  /** injectable for tests; defaults to the Neon-backed implementation */
  store?: ClosureStore;
  /** injectable for tests; defaults to reading `running` rows from the database */
  fetchCandidates?: () => Promise<OrphanCandidate[]>;
} = {}): Promise<CloseResult> {
  const now = opts.now ?? new Date();
  const dryRun = opts.dryRun ?? true;

  // Connect lazily. With both seams injected the function runs with no database
  // at all, which is what lets the dry-run default be proved behaviourally
  // rather than by reading the source.
  const readCandidates = opts.fetchCandidates ?? (async () => {
    const sql = connect();
    const rows = (await withRetry(
      () => sql`
        SELECT r.id, r.job, r.trigger, r.started_at,
               (SELECT max(l.at) FROM s2_run_log l WHERE l.run_id = r.id) AS last_activity_at
        FROM s2_run r
        WHERE r.status = 'running'
        ORDER BY r.started_at ASC`,
      3,
      'select orphaned runs',
    )) as unknown as Array<Record<string, any>>;

    return rows.map((r) => ({
      runId: r.id,
      job: r.job,
      trigger: r.trigger,
      startedAt: new Date(r.started_at).toISOString(),
      lastActivityAt: r.last_activity_at ? new Date(r.last_activity_at).toISOString() : null,
    }));
  });

  const candidates = await readCandidates();

  const silenceMs = opts.silenceMs ?? DEFAULT_SILENCE_MS;
  const selected = selectOrphans(candidates, { now, silenceMs, excludeRunId: opts.excludeRunId });
  const leftRunning = candidates.length - selected.length;

  if (dryRun) {
    return { scanned: candidates.length, selected, closed: [], skippedByRecheck: [], leftRunning, dryRun: true };
  }

  const closedAt = now.toISOString();
  // Anything logged after this instant means the run is alive, so the update
  // must not fire. Same threshold selection used, re-applied at write time.
  const silentSince = new Date(now.getTime() - silenceMs).toISOString();

  // Opened only on the writing path, and only when no store was injected, so a
  // dry run and every test still need no database.
  const sql = opts.store ? null : connect();

  const store: ClosureStore = opts.store ?? {
    async tryClose(runId, at, reason, since) {
      // One statement: the status check and the silence recheck are part of the
      // same UPDATE, so a run that logged while we were deciding fails the WHERE
      // clause rather than being closed on a stale read. RETURNING is what makes
      // "did this actually close a row" answerable instead of assumed.
      //
      // Note what is absent: `ended_at` is never assigned, and the counters are
      // not touched. The statement records only what is known -- that the row
      // was closed, when, and why.
      const rows = (await withRetry(
        () => sql!`
          UPDATE s2_run
             SET status = 'aborted', closed_at = ${at}, close_reason = ${reason}
           WHERE id = ${runId}
             AND status = 'running'
             AND NOT EXISTS (
               SELECT 1 FROM s2_run_log l
                WHERE l.run_id = ${runId} AND l.at > ${since})
          RETURNING id`,
        3,
        'close orphaned run',
      )) as unknown as Array<{ id: string }>;
      return rows.length > 0;
    },

    async recordClosure(runId, detail) {
      // On the orphan's own run, so the closure appears in the same stream as
      // everything else that run did rather than in a side channel.
      await withRetry(
        () => sql!`
          INSERT INTO s2_run_log (run_id, level, event, detail)
          VALUES (${runId}, 'warn', 'run_closed_administratively', ${JSON.stringify(detail)}::jsonb)`,
        3,
        'log administrative closure',
      );
    },
  };

  const { closed, skippedByRecheck } = await applyClosures(store, selected, { closedAt, silentSince });

  return { scanned: candidates.length, selected, closed, skippedByRecheck, leftRunning, dryRun: false };
}
