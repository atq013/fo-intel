import { meterSnapshot, resetMeter } from '@fo/core';
import { randomUUID } from 'node:crypto';
import { execSync } from 'node:child_process';
import { connect, withRetry } from '../../../db/src/connect.js';
import type { DecisionKind, RunJob, RunStatus, RunTrigger } from '@fo/core/contract/index.js';

/**
 * The operating record.
 *
 * Every scheduled execution opens a run, writes what it did as it goes, and
 * closes it. The brief asks for complete logs across a 48-hour unattended
 * window plus evidence of a real dependency failure and a real staleness event
 * -- those are claims about behaviour, and they are only credible if the rows
 * were written while the behaviour happened rather than composed afterwards.
 *
 * Logs go to two places on purpose. GitHub Actions logs are the operator's view
 * and expire; Neon rows are queryable and outlive the workflow retention.
 */

const sql = connect();

function gitSha(): string | null {
  if (process.env.GITHUB_SHA) return process.env.GITHUB_SHA.slice(0, 12);
  try {
    return execSync('git rev-parse --short HEAD', { encoding: 'utf8' }).trim();
  } catch {
    return null;
  }
}

export interface RunHandle {
  id: string;
  job: RunJob;
  log(level: 'debug' | 'info' | 'warn' | 'error', event: string, detail?: unknown): Promise<void>;
  decision(kind: DecisionKind, opts: {
    entityId?: string; claimId?: string; rule: string;
    before?: unknown; after?: unknown; reason: string;
  }): Promise<void>;
  checkpoint(sourceId: string, cursor: string, unitsDone: number): Promise<void>;
  readCheckpoint(sourceId: string): Promise<string | null>;
  counts: { created: number; released: number; quarantined: number; touched: number };
  failures: unknown[];
  finish(status: RunStatus, cost?: Record<string, unknown>): Promise<void>;
}

export async function startRun(job: RunJob, trigger: RunTrigger = 'manual'): Promise<RunHandle> {
  const id = `run_${new Date().toISOString().slice(0, 19).replace(/[:T-]/g, '')}_${randomUUID().slice(0, 8)}`;
  const policyVersion = (await import('../release/gate.js')).POLICY_VERSION;

  await withRetry(() => sql`
    INSERT INTO s2_run (id, trigger, job, status, git_sha, policy_version)
    VALUES (${id}, ${trigger}, ${job}, 'running', ${gitSha()}, ${policyVersion})`, 4, 'startRun');

  const counts = { created: 0, released: 0, quarantined: 0, touched: 0 };
  const failures: unknown[] = [];

  const handle: RunHandle = {
    id,
    job,
    counts,
    failures,

    async log(level, event, detail) {
      // stdout first: if the database write is what is failing, the Actions log
      // is the only place the reason can still appear.
      const line = { run: id, job, level, event, ...(detail ? { detail } : {}) };
      console.log(JSON.stringify(line));
      try {
        await withRetry(() => sql`
          INSERT INTO s2_run_log (run_id, level, event, detail)
          VALUES (${id}, ${level}, ${event}, ${detail ? JSON.stringify(detail) : null}::jsonb)`, 2, 'log');
      } catch (err) {
        console.log(JSON.stringify({ run: id, level: 'warn', event: 'log_write_failed', detail: String(err) }));
      }
    },

    async decision(kind, o) {
      await withRetry(() => sql`
        INSERT INTO s2_decision_log (id, run_id, entity_id, claim_id, kind, rule, before_json, after_json, reason)
        VALUES (${`dl_${randomUUID()}`}, ${id}, ${o.entityId ?? null}, ${o.claimId ?? null}, ${kind}, ${o.rule},
                ${o.before ? JSON.stringify(o.before) : null}::jsonb,
                ${o.after ? JSON.stringify(o.after) : null}::jsonb, ${o.reason})`, 3, 'decision');
    },

    /**
     * Called only after the unit's writes have committed. A cursor written
     * before the write would make the next run skip a unit that was never
     * stored -- data loss that looks exactly like normal progress.
     */
    async checkpoint(sourceId, cursor, unitsDone) {
      await withRetry(() => sql`
        INSERT INTO s2_checkpoint (id, job, source_id, cursor, units_done, last_run_id)
        VALUES (${`cp_${job}_${sourceId}`}, ${job}, ${sourceId}, ${cursor}, ${unitsDone}, ${id})
        ON CONFLICT (job, source_id) DO UPDATE SET
          cursor = EXCLUDED.cursor, units_done = EXCLUDED.units_done,
          last_run_id = EXCLUDED.last_run_id, updated_at = now()`, 3, 'checkpoint');
    },

    async readCheckpoint(sourceId) {
      const rows = (await withRetry(() => sql`
        SELECT cursor FROM s2_checkpoint WHERE job = ${job} AND source_id = ${sourceId}`,
        3, 'readCheckpoint')) as unknown as Array<{ cursor: string | null }>;
      return rows[0]?.cursor ?? null;
    },

    async finish(status, cost) {
      await withRetry(() => sql`
        UPDATE s2_run SET status = ${status}, ended_at = now(),
          records_touched = ${counts.touched}, claims_created = ${counts.created},
          claims_released = ${counts.released}, claims_quarantined = ${counts.quarantined},
          failures_json = ${JSON.stringify(failures)}::jsonb,
          cost_json = ${JSON.stringify(cost ?? {})}::jsonb
        WHERE id = ${id}`, 4, 'finish');
      console.log(JSON.stringify({ run: id, job, event: 'run_finished', status, counts, failures: failures.length }));
    },
  };

  await handle.log('info', 'run_started', { trigger, gitSha: gitSha() });
  return handle;
}

/**
 * Wraps a whole job so a crash still closes its run row.
 *
 * A run left in `running` forever is worse than a run marked failed: the
 * operating evidence has to distinguish "this broke" from "this is still going",
 * and an abandoned row makes every later query ambiguous.
 */
export async function withRun(
  job: RunJob,
  trigger: RunTrigger,
  fn: (run: RunHandle) => Promise<void>,
): Promise<RunHandle> {
  // Cleared at the start rather than the end, so a previous run that died
  // without finishing cannot bleed its spend into this one's figures.
  resetMeter();
  const startedAt = Date.now();
  const run = await startRun(job, trigger);

  // A failed run's cost is the interesting one -- it is what a retry will cost
  // again -- so the snapshot is taken on both paths.
  const cost = () => ({ ...meterSnapshot(), wallMs: Date.now() - startedAt });

  try {
    await fn(run);
    await run.finish('completed', cost());
  } catch (err) {
    run.failures.push({ fatal: true, message: err instanceof Error ? err.message : String(err) });
    await run.log('error', 'run_failed', { message: err instanceof Error ? err.message : String(err) });
    await run.finish('failed', cost());
    throw err;
  }
  return run;
}
