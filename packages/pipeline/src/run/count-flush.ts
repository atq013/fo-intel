/**
 * When to persist a run's counters, and why they are persisted at all.
 *
 * The counters used to be written once, by `finish()`, in the same statement as
 * the end time. A process killed by SIGKILL never reaches it, so the row kept
 * the schema default of 0 -- and after the hand-written cleanup gave that row a
 * status and an end time, it read as a run that completed and did nothing.
 *
 * `run_20260730191237_40bd4888` is the case worth remembering: 43 log lines, 42
 * decisions including a quarantine, and `claimsQuarantined: 0` on the row above
 * them. The work happened; the record of it did not survive.
 *
 * The log lines survived because they are written as they occur. So the fix for
 * the counters is the same shape: write them as the work commits, and let
 * whatever was committed before the kill be what the row reports. A killed run
 * then shows a true partial count instead of reverting to zero.
 *
 * ### Why a policy module rather than a line in `runner.ts`
 *
 * Persisting on every increment would issue a write per record, which at 581
 * records is thousands of statements to save a number nobody reads until
 * something goes wrong. Persisting rarely loses the work the fix exists to
 * preserve. The compromise is a throttle, and a throttle is a decision with
 * edge cases -- so it lives here, pure and tested, rather than inline in a
 * module that cannot be imported without a database connection.
 */

export interface RunCounts {
  created: number;
  released: number;
  quarantined: number;
  touched: number;
}

export interface FlushState {
  /** epoch ms of the last successful write; 0 means never */
  lastFlushAt: number;
  /** the counters as they stood at that write, or null */
  lastFlushed: string | null;
}

/**
 * How long to wait between writes while a job is working.
 *
 * Five seconds against runs whose median length is well under a minute means a
 * handful of extra statements per run, and bounds what a kill can destroy to
 * five seconds of counting. The exact value matters less than the two
 * properties either side of it: a commit boundary always flushes regardless, and
 * an unchanged counter never writes at all.
 */
export const DEFAULT_FLUSH_INTERVAL_MS = 5_000;

function snapshot(c: RunCounts): string {
  return `${c.touched}/${c.created}/${c.released}/${c.quarantined}`;
}

/** All four counters at zero: what a run holds before it has done anything. */
const ZERO = snapshot({ created: 0, released: 0, quarantined: 0, touched: 0 });

export function newFlushState(): FlushState {
  return {
    // Zero rather than `Date.now()`, so the first real change is written
    // immediately instead of waiting out an interval. A run that dies in its
    // first seconds is exactly the case where the partial count matters most.
    lastFlushAt: 0,

    // Seeded with the zero snapshot rather than null, and this is the whole
    // point of it.
    //
    // `startRun` logs `run_started` before any work exists, and the log path
    // carries the throttled flush. With `null` here that first line counted as a
    // change, so every run immediately wrote 0/0/0/0 over the NULLs the INSERT
    // had left -- destroying the distinction the migration was added to create.
    // The row said "this run did nothing" from the moment it was born, which is
    // the same false statement as before, arriving earlier.
    //
    // Treating the opening zeros as already-persisted means the first write
    // happens when something actually moves, and a run killed before that keeps
    // NULL: not counted, rather than counted as none.
    lastFlushed: ZERO,
  };
}

/**
 * Should the counters be written now?
 *
 * `force` is for commit boundaries -- the checkpoint, and the end of the run --
 * where the point is that what is on disk matches what was committed, not that
 * enough time has passed.
 *
 * Unchanged counters are never written, forced or not. A write that stores the
 * same four numbers again is noise in the row's update history and buys nothing;
 * the caller that wants an unconditional write is `finish()`, which is writing
 * the status and the end time anyway and does not come through here.
 */
export function shouldFlush(
  state: FlushState,
  counts: RunCounts,
  now: number,
  opts: { force?: boolean; intervalMs?: number } = {},
): boolean {
  const sig = snapshot(counts);
  if (state.lastFlushed === sig) return false;
  if (opts.force) return true;
  return now - state.lastFlushAt >= (opts.intervalMs ?? DEFAULT_FLUSH_INTERVAL_MS);
}

/** Record that a write succeeded. Only called after the statement commits. */
export function markFlushed(state: FlushState, counts: RunCounts, now: number): void {
  state.lastFlushAt = now;
  state.lastFlushed = snapshot(counts);
}
