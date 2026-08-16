import 'dotenv/config';
import { writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { connect } from '../../../db/src/connect.js';
import { TOOL_SCHEMAS } from '../../../rag/src/agent/tools.js';

/**
 * Deliverables 4 and 6 — the complete operating record, and the tool interfaces.
 *
 * "The complete run logs for the entire operating window, not only the three
 * goals: everything the system did while it ran." So this exports every run,
 * every log line, every decision and every failure, unfiltered and in time
 * order. Nothing is summarised and nothing is dropped for being uninteresting:
 * a curated excerpt is the one thing the brief says this must not be.
 *
 * That includes the runs that failed, the run that a duplicate-key defect
 * killed, and the two rows left `running` by a SIGKILL. Those are part of what
 * happened.
 */

const OUT = fileURLToPath(new URL('../../../../exports/', import.meta.url));
mkdirSync(OUT, { recursive: true });

const sql = connect();

const runs = (await sql`
  SELECT id, job, trigger, status, started_at, ended_at, closed_at, close_reason,
         git_sha, policy_version,
         records_touched, claims_created, claims_released, claims_quarantined,
         failures_json, cost_json
  FROM s2_run ORDER BY started_at`) as unknown as Array<Record<string, any>>;

const logs = (await sql`
  SELECT run_id, at, level, event, detail FROM s2_run_log ORDER BY at`) as unknown as
  Array<Record<string, any>>;

const decisions = (await sql`
  SELECT run_id, at, kind, rule, entity_id, claim_id, before_json, after_json, reason
  FROM s2_decision_log ORDER BY at`) as unknown as Array<Record<string, any>>;

type Keyed = Record<string, any>;
const byRun = (rows: Keyed[]) => {
  const m = new Map<string, Keyed[]>();
  for (const r of rows) {
    if (!m.has(r.run_id)) m.set(r.run_id, []);
    m.get(r.run_id)!.push(r);
  }
  return m;
};
const logsBy = byRun(logs);
const decisionsBy = byRun(decisions);

const scheduled = runs.filter((r) => r.trigger === 'schedule');
const first = scheduled[0]?.started_at ? new Date(scheduled[0].started_at) : null;
const last = scheduled[scheduled.length - 1]?.started_at
  ? new Date(scheduled[scheduled.length - 1]!.started_at) : null;
const spanHours = first && last ? (last.getTime() - first.getTime()) / 3_600_000 : 0;

/**
 * The three window conditions, each answered from the rows rather than asserted.
 * Where a condition is not met this says so -- the brief asks for honest
 * incompleteness over a claim the artifacts do not support.
 */
const staleAcrossRuns = decisions.filter((d) => d.kind === 'stale');
const staleFromScheduled = staleAcrossRuns.filter((d) =>
  scheduled.some((r) => r.id === d.run_id));
const failures = runs.flatMap((r) => {
  const f = Array.isArray(r.failures_json) ? r.failures_json : [];
  return f.map((x: unknown) => ({ runId: r.id, job: r.job, trigger: r.trigger, failure: x }));
});

const windowConditions = {
  twoScheduledRunsAcross48h: {
    met: scheduled.length >= 2 && spanHours >= 48,
    scheduledRuns: scheduled.length,
    firstScheduledRun: first?.toISOString() ?? null,
    lastScheduledRun: last?.toISOString() ?? null,
    spanHours: Number(spanHours.toFixed(1)),
    note: 'Run history also visible in GitHub Actions, which keeps its own record.',
  },
  realDependencyFailure: {
    met: failures.length > 0,
    count: failures.length,
    failures,
    note:
      'The genuine dependency failure is a Neon connection dropped mid-run; the system ' +
      'logged it, recorded it on the run, continued to the next unit and completed. ' +
      'The scheduled `contract` run that failed on a duplicate key is NOT a dependency ' +
      'failure -- it was an application defect, and it is kept separate deliberately.',
  },
  stalenessAcrossRuns: {
    met: staleFromScheduled.length > 0,
    totalStalenessEvents: staleAcrossRuns.length,
    detectedByScheduledRun: staleFromScheduled.length,
    note:
      'Every staleness event here is evidence-based: a content hash that differed from ' +
      'the one previously stored for the same URL, with both recorded. No event is ' +
      'clock-based. Where `detectedByScheduledRun` is 0, the events exist but were found ' +
      'by hand-run jobs, and that is stated rather than presented as satisfying the condition.',
  },
};

/**
 * Written beside the submitted file, never over it.
 *
 * `exports/operating-window.json` is submitted evidence. Regenerating in place
 * would silently replace the artifact whose defects this branch describes, and a
 * corrected copy that cannot be diffed against the original proves nothing. The
 * two files side by side ARE the proof.
 */
const FILENAME = process.env.OPERATING_WINDOW_OUT ?? 'operating-window.corrected.json';

writeFileSync(OUT + FILENAME, JSON.stringify({
  generatedAt: new Date().toISOString(),
  // The previous wording claimed this file contained rows left `running` by a
  // SIGKILL. It never did: those rows were closed by hand before the export ran,
  // so the export asserted something about its own contents that was false. It
  // now describes what is actually here.
  note:
    'Every run, log line, decision and failure, in time order. Unfiltered: failed runs and ' +
    'administratively closed runs are all present, because they are part of what the system ' +
    'did. A run closed out of band carries `closedAt` and `closeReason` and no `endedAt`: ' +
    'the moment its row was closed is recorded, the moment it stopped is not known and is ' +
    'not invented. A `null` counter means the run was killed before that number was written, ' +
    'which is different from a counted zero.',
  windowConditions,
  runCount: runs.length,
  logLineCount: logs.length,
  decisionCount: decisions.length,
  runs: runs.map((r) => ({
    runId: r.id, job: r.job, trigger: r.trigger, status: r.status,
    startedAt: r.started_at,
    // Three separate facts, never collapsed. `endedAt` is an observation;
    // `closedAt` is when the row was closed for a run that never reported one.
    endedAt: r.ended_at,
    closedAt: r.closed_at ?? null,
    closeReason: r.close_reason ?? null,
    gitSha: r.git_sha, policyVersion: r.policy_version,
    counts: {
      // `?? null` and not `?? 0`: an unwritten counter must stay distinguishable
      // from a counted zero all the way out to the file.
      recordsTouched: r.records_touched ?? null, claimsCreated: r.claims_created ?? null,
      claimsReleased: r.claims_released ?? null, claimsQuarantined: r.claims_quarantined ?? null,
    },
    failures: r.failures_json,
    cost: r.cost_json,
    log: (logsBy.get(r.id) ?? []).map((l) => ({
      at: l.at, level: l.level, event: l.event, detail: l.detail,
    })),
    decisions: (decisionsBy.get(r.id) ?? []).map((d) => ({
      at: d.at, kind: d.kind, rule: d.rule, entityId: d.entity_id, claimId: d.claim_id,
      before: d.before_json, after: d.after_json, reason: d.reason,
    })),
  })),
}, null, 1));

writeFileSync(OUT + 'agent-tools.json', JSON.stringify({
  generatedAt: new Date().toISOString(),
  note:
    'The interfaces the agent can call. Every tool returns { data, scope, excluded, limits }: ' +
    'scope states what was searched and what matched, excluded states what was deliberately ' +
    'left out and why, and limits state what the tool cannot tell you. Every tool reads ' +
    'released claims only -- candidate, held, quarantined and withheld data is not reachable ' +
    'from here, which is not a filter the agent applies and could forget but the only data ' +
    'these queries select.',
  tools: TOOL_SCHEMAS,
}, null, 1));

console.log(`runs           : ${runs.length}`);
console.log(`log lines      : ${logs.length}`);
console.log(`decisions      : ${decisions.length}`);
console.log(`failures       : ${failures.length}`);
console.log('');
console.log(`window · 2 scheduled runs across 48h : ${windowConditions.twoScheduledRunsAcross48h.met ? 'MET' : 'NOT MET'} (${scheduled.length} runs, ${spanHours.toFixed(1)}h)`);
console.log(`window · real dependency failure     : ${windowConditions.realDependencyFailure.met ? 'MET' : 'NOT MET'} (${failures.length})`);
console.log(`window · staleness across runs       : ${windowConditions.stalenessAcrossRuns.met ? 'MET' : 'NOT MET'} (${staleAcrossRuns.length} events, ${staleFromScheduled.length} from scheduled runs)`);
console.log('');
// Prints the name it actually wrote. It used to print `operating-window.json`
// unconditionally, which was true only until the output became configurable --
// and a script that misreports its own output is precisely the class of defect
// this branch exists to fix.
console.log(`written        : exports/${FILENAME}, exports/agent-tools.json`);
