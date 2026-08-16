import 'dotenv/config';
import { closeOrphanedRuns, DEFAULT_SILENCE_MS } from '../run/close-orphaned-runs.js';

/**
 * The supported way to close runs whose process died.
 *
 * It exists so that nobody has to type the statement that caused this:
 *
 *   UPDATE s2_run SET status='aborted', ended_at=now() WHERE status='running'
 *
 * A one-line `UPDATE` at a psql prompt is faster than a job, which is exactly
 * why it was used, and it is also unreviewable, unlogged, and free to write an
 * end time nothing observed. Having a job means the correct behaviour is the
 * convenient one.
 *
 * **Dry run by default.** It prints what it would close and writes nothing.
 * Pass `CLOSE_ORPHANS_APPLY=1` to commit. That asymmetry is deliberate: this
 * operates on the operating record itself, and the version that changes history
 * should be the one you have to ask for.
 *
 *   npx tsx packages/pipeline/src/jobs/close-orphaned-runs.ts
 *   CLOSE_ORPHANS_APPLY=1 npx tsx packages/pipeline/src/jobs/close-orphaned-runs.ts
 *   CLOSE_ORPHANS_SILENCE_MIN=45 npx tsx packages/pipeline/src/jobs/close-orphaned-runs.ts
 */

const apply = process.env.CLOSE_ORPHANS_APPLY === '1';
const silenceMs = process.env.CLOSE_ORPHANS_SILENCE_MIN
  ? Number(process.env.CLOSE_ORPHANS_SILENCE_MIN) * 60_000
  : DEFAULT_SILENCE_MS;

if (!Number.isFinite(silenceMs) || silenceMs <= 0) {
  console.error(`CLOSE_ORPHANS_SILENCE_MIN must be a positive number of minutes`);
  process.exit(1);
}

const result = await closeOrphanedRuns({ silenceMs, dryRun: !apply });

// `selected` is what met the threshold; `closed` is what an UPDATE actually
// changed. Reporting the first as the second would be the same category of
// error this branch exists to fix, so they are printed as different things.
console.log(
  `${result.dryRun ? 'DRY RUN — nothing written' : 'APPLIED'} · ` +
  `silence threshold ${Math.round(silenceMs / 60000)}m · ` +
  `${result.scanned} run(s) in 'running' · ${result.selected.length} met the threshold · ` +
  `${result.leftRunning} still active`,
);

for (const d of result.selected) {
  const state = result.dryRun
    ? 'would close'
    : result.closed.some((c) => c.runId === d.runId)
      ? 'CLOSED'
      : 'skipped — logged again before the update, so it is alive';
  console.log(`  ${d.runId}  ${d.job}  silent ${Math.floor(d.silentMs / 60000)}m  → ${state}`);
  console.log(`      ${d.reason}`);
}

if (!result.dryRun) {
  console.log(`\n${result.closed.length} row(s) closed, ${result.skippedByRecheck.length} left alive by the recheck`);
}

if (result.dryRun && result.selected.length) {
  console.log(`\nre-run with CLOSE_ORPHANS_APPLY=1 to commit these closures`);
}
