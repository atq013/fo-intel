import { connect, withRetry } from '../../../db/src/connect.js';
import { auditRuns, type LifecycleAudit, type RunRecord } from './run-lifecycle.js';

/**
 * Run the lifecycle rules against live state.
 *
 * The `contract` job already audits claims -- PTC-1, no released claim without a
 * decision row naming its gates. This is the same idea pointed at the operating
 * record itself, which until now was the one table nothing checked. It is the
 * table a buyer is invited to inspect, so it should be the last one holding an
 * unverified claim.
 *
 * One query, aggregates only. The rules need two numbers per run, not the
 * decision rows themselves, and pulling ~1,500 rows to count them would make the
 * audit the most expensive thing the job does.
 */
export async function auditRunLifecycle(opts: { legacyBefore?: string } = {}): Promise<
  LifecycleAudit & { runsAudited: number }
> {
  const sql = connect();

  const rows = (await withRetry(() => sql`
    SELECT r.id, r.job, r.trigger, r.status, r.started_at, r.ended_at,
           r.closed_at, r.close_reason,
           r.records_touched, r.claims_created, r.claims_released, r.claims_quarantined,
           r.failures_json,
           (SELECT count(*)::int FROM s2_decision_log d WHERE d.run_id = r.id) AS decision_total,
           (SELECT count(*)::int FROM s2_decision_log d
             WHERE d.run_id = r.id AND d.kind = 'quarantine')                  AS decision_quarantine
    FROM s2_run r
    ORDER BY r.started_at ASC`, 3, 'auditRunLifecycle')) as unknown as Array<Record<string, any>>;

  const runs: RunRecord[] = rows.map((r) => ({
    runId: r.id,
    job: r.job,
    trigger: r.trigger,
    status: r.status,
    startedAt: new Date(r.started_at).toISOString(),
    endedAt: r.ended_at ? new Date(r.ended_at).toISOString() : null,
    closedAt: r.closed_at ? new Date(r.closed_at).toISOString() : null,
    closeReason: r.close_reason ?? null,
    counts: {
      // `?? null` rather than `?? 0`: after 007 these are nullable, and the
      // whole point is that an unwritten counter stays distinguishable from a
      // counted zero. Coercing here would undo the migration at the read.
      recordsTouched: r.records_touched ?? null,
      claimsCreated: r.claims_created ?? null,
      claimsReleased: r.claims_released ?? null,
      claimsQuarantined: r.claims_quarantined ?? null,
    },
    failures: Array.isArray(r.failures_json) ? r.failures_json : [],
    log: [],
    decisions: [],
    decisionCounts: { total: r.decision_total ?? 0, quarantine: r.decision_quarantine ?? 0 },
  }));

  return { ...auditRuns(runs, opts.legacyBefore), runsAudited: runs.length };
}
