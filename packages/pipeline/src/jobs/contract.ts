import 'dotenv/config';
import { withRun } from '../run/runner.js';
import { connect } from '../../../db/src/connect.js';
import { contractWriter } from '../../../db/src/contract-writer.js';
import { GATES } from '../gates/index.js';
import { assessEntity, releaseDecision, POLICY_VERSION } from '../release/gate.js';
import type { Claim, Entity, Evidence, GateResult } from '@fo/core/contract/index.js';

/**
 * `contract` — re-evaluate existing claims under the current policy.
 *
 * Release is a pipeline, not a boolean. When the standard tightens, claims
 * released under the old standard are re-judged and can be demoted; when a gate
 * is fixed, claims quarantined by the old version can be re-admitted. Without
 * this job, policy_version would be decoration -- a number stamped on decisions
 * that nothing ever revisits.
 *
 * It runs after discover and refresh, so it sees whatever they just wrote, and
 * it is also the job that produces the PTC-1 audit: no released claim without a
 * decision row naming its gates.
 */

const sql = connect();
const db = contractWriter(process.env.DATABASE_URL!);

const BATCH = Number(process.env.CONTRACT_BATCH ?? 400);

await withRun('contract', process.env.GITHUB_EVENT_NAME === 'schedule' ? 'schedule' : 'manual', async (run) => {
  // Claims never judged under the current policy version, oldest first.
  const claims = (await sql`
    SELECT c.id, c.entity_id, c.extraction_event_id, c.field, c.value_json, c.value_type,
           c.status, c.confidence, c.refresh_policy, c.established_at
    FROM s2_claim c
    WHERE NOT EXISTS (
      SELECT 1 FROM s2_release_decision d
      WHERE d.claim_id = c.id AND d.policy_version = ${POLICY_VERSION})
    ORDER BY c.established_at ASC
    LIMIT ${BATCH}`) as unknown as Array<Record<string, any>>;

  await run.log('info', 'contract_scope', { claims: claims.length, policyVersion: POLICY_VERSION });

  const byEntity = new Map<string, Claim[]>();
  let demoted = 0;
  let admitted = 0;

  for (const row of claims) {
    const claim: Claim = {
      id: row.id, entityId: row.entity_id, extractionEventId: row.extraction_event_id,
      field: row.field, value: row.value_json, valueType: row.value_type,
      status: row.status, confidence: row.confidence, refreshPolicy: row.refresh_policy,
      establishedAt: new Date(row.established_at),
    };

    const evRows = (await sql`
      SELECT id, claim_id, observation_id, extraction_event_id, role, span_text, method, created_at
      FROM s2_evidence WHERE claim_id = ${claim.id}`) as unknown as Array<Record<string, any>>;
    const evidence = evRows.map((e) => ({
      id: e.id, claimId: e.claim_id, observationId: e.observation_id,
      extractionEventId: e.extraction_event_id, role: e.role, spanText: e.span_text,
      method: e.method, createdAt: new Date(e.created_at),
    })) as unknown as Evidence[];

    const sibRows = (await sql`
      SELECT id, entity_id, extraction_event_id, field, value_json, value_type, status, confidence, refresh_policy, established_at
      FROM s2_claim WHERE entity_id = ${claim.entityId} AND id <> ${claim.id}`) as unknown as Array<Record<string, any>>;
    const siblings = sibRows.map((s) => ({
      id: s.id, entityId: s.entity_id, extractionEventId: s.extraction_event_id, field: s.field,
      value: s.value_json, valueType: s.value_type, status: s.status, confidence: s.confidence,
      refreshPolicy: s.refresh_policy, establishedAt: new Date(s.established_at),
    })) as Claim[];

    const entity: Entity = {
      id: claim.entityId, canonicalName: claim.entityId, entityType: 'unconfirmed',
      firstSeenAt: new Date(), trustState: 'active', commercialState: 'unassessed',
      strictReachable: false, profileAssistedReachable: false,
    };

    const results: GateResult[] = [];
    for (const gate of GATES) {
      try {
        results.push(await gate.evaluate(claim, { evidence, siblings, entity, policyVersion: POLICY_VERSION }));
      } catch (err) {
        results.push({ gate: gate.name, outcome: 'error', band: gate.band, detail: String(err) });
      }
    }

    await db.recordGateResults(claim.id, run.id, results, POLICY_VERSION);
    const decision = releaseDecision(claim, results, POLICY_VERSION);
    const was = claim.status;
    await db.applyRelease(decision, run.id);

    const now = decision.decision === 'released' ? 'released'
      : decision.decision === 'quarantined' ? 'quarantined' : 'candidate';

    if (was === 'released' && now !== 'released') {
      demoted++;
      await run.decision('quarantine', {
        entityId: claim.entityId, claimId: claim.id, rule: `policy:${POLICY_VERSION}`,
        before: { status: was }, after: { status: now, failed: decision.gatesFailed },
        reason: `re-evaluated under ${POLICY_VERSION}: ${decision.reason}`,
      });
    } else if (was !== 'released' && now === 'released') {
      admitted++;
      await run.decision('release', {
        entityId: claim.entityId, claimId: claim.id, rule: `policy:${POLICY_VERSION}`,
        before: { status: was }, after: { status: now },
        reason: `re-admitted under ${POLICY_VERSION}: ${decision.reason}`,
      });
    }

    if (now === 'released') {
      const list = byEntity.get(claim.entityId) ?? [];
      list.push(claim);
      byEntity.set(claim.entityId, list);
    }
    run.counts.touched++;
  }

  // Commercial sufficiency is a question about the WHOLE record, so it must be
  // asked over every released claim the entity holds -- not the subset that
  // happened to fall in this batch.
  //
  // Assessing the batch alone silently withheld 102 qualifying entities: a firm
  // with ten released claims, three of which were in this run of 600, was judged
  // as though it had three. The batch is a unit of work, never a unit of truth.
  for (const entityId of byEntity.keys()) {
    const allReleased = (await sql`
      SELECT id, entity_id, extraction_event_id, field, value_json, value_type, status,
             confidence, refresh_policy, established_at
      FROM s2_claim WHERE entity_id = ${entityId}
        AND status = 'released'`) as unknown as Array<Record<string, any>>;

    const claims = allReleased.map((r) => ({
      id: r.id, entityId: r.entity_id, extractionEventId: r.extraction_event_id, field: r.field,
      value: r.value_json, valueType: r.value_type, status: r.status, confidence: r.confidence,
      refreshPolicy: r.refresh_policy, establishedAt: new Date(r.established_at),
    })) as Claim[];

    const entity: Entity = {
      id: entityId, canonicalName: entityId, entityType: 'unconfirmed', firstSeenAt: new Date(),
      trustState: 'active', commercialState: 'unassessed',
      strictReachable: false, profileAssistedReachable: false,
    };
    const commercial = assessEntity(entity, claims, POLICY_VERSION);
    await sql`UPDATE s2_entity SET commercial_state = ${commercial.commercialState}, updated_at = now()
              WHERE id = ${entityId}`;
  }

  // PTC-1. A released claim with no decision row naming its gates is the state
  // the spec says must fail the build, so the job that would create it is also
  // the job that checks for it.
  const orphans = (await sql`
    SELECT c.id FROM s2_claim c
    WHERE c.status = 'released'
      AND NOT EXISTS (SELECT 1 FROM s2_release_decision d WHERE d.claim_id = c.id)
    LIMIT 5`) as unknown as Array<{ id: string }>;

  await run.log(orphans.length ? 'error' : 'info', 'ptc1_audit', {
    releasedWithoutDecision: orphans.length, sample: orphans.map((o) => o.id),
  });

  await run.log('info', 'contract_summary', { evaluated: claims.length, demoted, admitted });
  if (orphans.length) {
    run.failures.push({ ptc: 'PTC-1', releasedWithoutDecision: orphans.length });
    throw new Error(`PTC-1 violated: ${orphans.length} released claim(s) with no release_decision row`);
  }
});
