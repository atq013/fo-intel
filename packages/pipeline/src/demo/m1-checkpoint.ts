/**
 * M1 exit demonstration.
 *
 * Takes one real Stage 1 record, replays it through the new contract, and shows
 * the outcome the roadmap asks for: an entity whose claims each carry
 * establishing evidence from their own extraction event, with release decisions
 * naming the gates that ran.
 *
 * Kopp Family Office is the right record to use because it is one of the ones we
 * got wrong. Two of its address values contradict the filing they cite. The
 * point of the demonstration is that they no longer reach released state, and
 * that the reason is recorded rather than inferred.
 *
 * Run: npx tsx packages/pipeline/src/demo/m1-checkpoint.ts
 */
import 'dotenv/config';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { openExtractionEvent } from '@fo/core/contract/index.js';
import type { Claim, Entity, GateResult, Observation, Source } from '@fo/core/contract/index.js';
import { contractWriter } from '../../../db/src/contract-writer.js';
import { GATES } from '../gates/index.js';
import { assessEntity, releaseDecision, POLICY_VERSION } from '../release/gate.js';

const root = fileURLToPath(new URL('../../../../', import.meta.url));
const rows = JSON.parse(readFileSync(root + 'data/fo-dataset.json', 'utf8')) as any[];
const record = rows.find((r) => /kopp/i.test(r.legalName));

const db = contractWriter(process.env.DATABASE_URL!);
const RUN = `run_m1_demo`;
const ENTITY = 'ent_m1_kopp';

async function main() {
  // Clean prior demo rows so the run is repeatable and its output is not an
  // accumulation of earlier attempts.
  // Strict reverse dependency order. Two things were learned writing this and
  // both are worth keeping:
  //
  //   - events must be deleted by the observation they read, not by an id
  //     prefix. The writer mints them as xe_<uuid>, so a prefix match deletes
  //     nothing silently and leaves the observation un-droppable next run.
  //   - decision_log references the entity, so it has to go before it.
  //
  // Nothing here cascades except evidence-from-claim. That is deliberate: rows
  // that vanish quietly are rows whose disappearance nobody audits.
  await db.sql`DELETE FROM s2_decision_log     WHERE entity_id = ${ENTITY} OR run_id = ${RUN}`;
  await db.sql`DELETE FROM s2_release_decision WHERE run_id = ${RUN}
                 OR claim_id IN (SELECT id FROM s2_claim WHERE entity_id = ${ENTITY})`;
  await db.sql`DELETE FROM s2_validation_result WHERE run_id = ${RUN}
                 OR claim_id IN (SELECT id FROM s2_claim WHERE entity_id = ${ENTITY})`;
  await db.sql`DELETE FROM s2_evidence
                 WHERE claim_id IN (SELECT id FROM s2_claim WHERE entity_id = ${ENTITY})`;
  await db.sql`DELETE FROM s2_claim            WHERE entity_id = ${ENTITY}`;
  await db.sql`DELETE FROM s2_extraction_event WHERE observation_id LIKE 'obs_m1%' OR run_id = ${RUN}`;
  await db.sql`DELETE FROM s2_observation      WHERE id LIKE 'obs_m1%'`;
  await db.sql`DELETE FROM s2_entity           WHERE id = ${ENTITY}`;
  await db.sql`DELETE FROM s2_source           WHERE id = 'src_m1_sec'`;
  await db.sql`DELETE FROM s2_run              WHERE id = ${RUN}`;

  await db.sql`INSERT INTO s2_run (id, trigger, job, status) VALUES (${RUN}, 'manual', 'contract', 'running')`;

  const source: Source = {
    id: 'src_m1_sec', kind: 'sec_13f', identifier: 'CIK1683689', tier: 1,
    baseUrl: 'https://www.sec.gov', rateLimitPerMin: 30, consecutiveFailures: 0,
  };
  await db.upsertSource(source);

  const entity: Entity = {
    id: ENTITY, canonicalName: record.legalName, entityType: 'family_office',
    firstSeenAt: new Date(), trustState: 'active', commercialState: 'unassessed',
    strictReachable: false, profileAssistedReachable: false,
  };
  await db.upsertEntity(entity);

  // One filing, read once. Every value below is derived inside this single event,
  // which is what makes the coherence question answerable at all.
  const filing = record.street.evidence[0].sourceUrl;
  const span = record.street.evidence[0].method as string;
  const observation: Observation = {
    id: 'obs_m1_filing', sourceId: source.id, url: filing, fetchedAt: new Date(),
    contentHash: 'sha256:m1demo', httpStatus: 200,
  };
  await db.upsertObservation(observation);

  const event = openExtractionEvent({ observation, extractor: 'stage1-replay', runId: RUN });

  const fields: Array<[string, unknown, string]> = [
    ['legalName', record.legalName, 'string'],
    ['street', record.street.value, 'string'],
    ['postcode', record.postcode.value, 'string'],
    ['city', record.city.value, 'string'],
    ['country', record.country.value, 'string'],
    ['principal.fullName', record.principals?.[0]?.fullName?.value, 'person_name'],
    ['principal.phone', record.principals?.[0]?.phone?.value, 'phone'],
  ].filter(([, v]) => v != null) as Array<[string, unknown, string]>;

  for (const [field, value, valueType] of fields) {
    event.assert(
      { entityId: ENTITY, field, value, valueType, confidence: 0.8, refreshPolicy: 'statutory' },
      { observationId: observation.id, spanText: span, method: span },
    );
  }

  const closed = event.close();
  await db.writeEvent(closed.event, closed.assertions, closed.attached);

  // Band A runs in full even after a failure: finding one defect and stopping
  // costs a 500-record re-run to find the second.
  const released: Claim[] = [];
  for (const { claim } of closed.assertions) {
    const ctx = {
      evidence: [closed.assertions.find((a) => a.claim.id === claim.id)!.establishing],
      observation,
      siblings: closed.assertions.map((a) => a.claim).filter((c) => c.id !== claim.id),
      entity,
      policyVersion: 'test',
    };
    const results: GateResult[] = [];
    for (const gate of GATES) results.push(await gate.evaluate(claim, ctx));

    await db.recordGateResults(claim.id, RUN, results, POLICY_VERSION);
    const decision = releaseDecision(claim, results);
    await db.applyRelease(decision, RUN);
    if (decision.decision === 'released') released.push(claim);
  }

  const commercial = assessEntity(entity, released);
  await db.sql`UPDATE s2_entity SET commercial_state = ${commercial.commercialState}, updated_at = now() WHERE id = ${ENTITY}`;
  await db.sql`INSERT INTO s2_decision_log (id, run_id, entity_id, kind, rule, after_json, reason)
               VALUES (${'dl_' + RUN}, ${RUN}, ${ENTITY}, 'classify', 'commercial_floor',
                       ${JSON.stringify(commercial)}::jsonb, ${commercial.reason})`;
  await db.sql`UPDATE s2_run SET status = 'completed', ended_at = now(),
                 claims_created = ${closed.assertions.length},
                 claims_released = ${released.length},
                 claims_quarantined = ${closed.assertions.length - released.length}
               WHERE id = ${RUN}`;

  // ---- the demonstration query the roadmap asks for -----------------------
  const report = (await db.sql`
    SELECT c.field,
           left(c.value_json #>> '{}', 34)          AS value,
           c.status,
           (e.extraction_event_id = c.extraction_event_id) AS evidence_from_own_event,
           rd.decision,
           array_to_string(rd.gates_failed, ',')    AS failed,
           left(rd.reason, 48)                      AS reason
    FROM s2_claim c
    JOIN s2_evidence e ON e.claim_id = c.id AND e.role = 'establishing'
    LEFT JOIN s2_release_decision rd ON rd.claim_id = c.id
    WHERE c.entity_id = ${ENTITY}
    ORDER BY c.field`) as unknown as any[];

  console.log(`\n${record.legalName} — replayed through the Stage 2 contract\n`);
  console.log('field                value                               status       own-event  decision     failed gate(s)');
  console.log('-'.repeat(118));
  for (const r of report) {
    console.log(
      `${r.field.padEnd(20)} ${String(r.value).padEnd(35)} ${String(r.status).padEnd(12)} ` +
      `${String(r.evidence_from_own_event).padEnd(10)} ${String(r.decision).padEnd(12)} ${r.failed || ''}`,
    );
  }

  const orphanRows = (await db.sql`
    SELECT COUNT(*)::int AS n FROM s2_claim c
    WHERE c.status = 'released'
      AND NOT EXISTS (SELECT 1 FROM s2_release_decision d WHERE d.claim_id = c.id)`) as unknown as Array<{ n: number }>;
  const orphans = orphanRows[0]?.n ?? 0;

  const cf = (await db.sql`
    SELECT gate, counterfactual FROM s2_validation_result
    WHERE claim_id IN (SELECT id FROM s2_claim WHERE entity_id = ${ENTITY})
      AND outcome = 'failed' AND counterfactual IS NOT NULL`) as unknown as any[];

  console.log(`\nreleased ${released.length}/${closed.assertions.length} claims`);
  console.log(`entity commercial_state: ${commercial.commercialState} — ${commercial.reason}`);
  console.log(`released claims with no release_decision row: ${orphans} (must be 0)`);
  console.log(`\nwithout these gates, ${cf.length} value(s) would have shipped as verified:`);
  for (const r of cf) console.log(`  ${r.gate.padEnd(18)} ${JSON.stringify(r.counterfactual).slice(0, 96)}`);

  process.exit(orphans === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
