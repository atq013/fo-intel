import 'dotenv/config';
import { withRun } from '../run/runner.js';
import { contractWriter } from '../../../db/src/contract-writer.js';
import { connect } from '../../../db/src/connect.js';
import { openExtractionEvent } from '@fo/core/contract/index.js';
import { GATES } from '../gates/index.js';
import { releaseDecision, POLICY_VERSION } from '../release/gate.js';
import { derivedMethod, getRule } from '../gates/derivation.js';
import type { Claim, Entity, GateResult } from '@fo/core/contract/index.js';

/**
 * Backfill `entityClassification` over records collected before the rule existed.
 *
 * The rule was added to the Companies House extractor, which covers everything
 * collected from now on. It does not cover the 505 records already held, and
 * `refresh` cannot reach them either: refresh short-circuits on an unchanged
 * content hash, which is correct -- re-extracting a document that has not moved
 * is wasted work -- but it means a NEW extraction rule never runs on old records.
 *
 * No re-fetch is needed. Both inputs the rule takes are already stored as
 * released claims from the same reading: `legalName` from the company profile
 * and `principal.fullName` from the PSC register, one observation per company.
 * So this reads what is held, re-derives the classification, and writes it as a
 * derivation claim bound to that same observation.
 *
 * It goes through the ordinary path -- extraction event, all six gates, release
 * decision -- because a value written around the gates is exactly the thing the
 * contract exists to prevent, and a backfill is not a licence to skip it. The
 * gate re-runs the rule independently, so a classification this job gets wrong
 * does not release.
 *
 * Idempotent: entities that already hold a released classification are skipped.
 */

const sql = connect();
const db = contractWriter(process.env.DATABASE_URL ?? '');

interface Target {
  entity_id: string;
  canonical_name: string;
  observation_id: string;
  person: string;
  legal_name: string;
}

const targets = (await sql`
  SELECT DISTINCT ON (e.id, p.value_json)
         e.id AS entity_id, e.canonical_name,
         xe.observation_id,
         p.value_json #>> '{}' AS person,
         ln.value_json #>> '{}' AS legal_name
  FROM s2_entity e
  JOIN s2_claim p            ON p.entity_id = e.id AND p.field = 'principal.fullName' AND p.status = 'released'
  JOIN s2_extraction_event xe ON xe.id = p.extraction_event_id
  JOIN s2_claim ln           ON ln.entity_id = e.id AND ln.field = 'legalName' AND ln.status = 'released'
                             AND ln.extraction_event_id = p.extraction_event_id
  WHERE e.id LIKE 'ent_ch_%'
    AND NOT EXISTS (
      SELECT 1 FROM s2_claim c
      WHERE c.entity_id = e.id AND c.field = 'entityClassification' AND c.status = 'released')
  ORDER BY e.id, p.value_json, xe.started_at DESC`) as unknown as Target[];

const rule = getRule('family_surname_control')!;

await withRun('contract', 'manual', async (run) => {
  await run.log('info', 'backfill_scope', {
    candidatePairings: targets.length,
    rule: 'family_surname_control',
    note: 'derived from claims already held; no source is re-fetched',
  });

  const done = new Set<string>();
  let classified = 0;
  let quarantined = 0;

  for (const t of targets) {
    if (done.has(t.entity_id)) continue;

    const pairing = `${t.person} || ${t.legal_name}`;
    const derived = rule.apply(pairing);
    // No match is not a failure. It means the register does not evidence this
    // firm as a single family office, and an absent classification is the
    // honest outcome -- Stage 1's error was labelling these anyway.
    if (derived !== 'single_family_office') continue;
    done.add(t.entity_id);

    const event = openExtractionEvent({
      observation: { id: t.observation_id } as never,
      extractor: 'backfill_classification',
      runId: run.id,
    });
    event.assert(
      {
        entityId: t.entity_id, field: 'entityClassification', value: derived,
        valueType: 'string', confidence: 0.85, refreshPolicy: 'derived',
      },
      {
        observationId: t.observation_id,
        spanText: `psc.items[].name + company_profile.company_name: ${pairing}`,
        method: derivedMethod('family_surname_control', pairing),
      },
    );

    const closed = event.close();
    await db.writeEvent(closed.event, closed.assertions, closed.attached);
    run.counts.created += closed.assertions.length;

    // The entity as the gates need it. Identity and reachability are read from
    // the database by the code that owns them; nothing here writes them.
    const entity: Entity = {
      id: t.entity_id, canonicalName: t.canonical_name, entityType: 'unconfirmed',
      firstSeenAt: new Date(), trustState: 'active', commercialState: 'unassessed',
      strictReachable: false, profileAssistedReachable: false,
    };

    for (const { claim, establishing } of closed.assertions) {
      const results: GateResult[] = [];
      for (const gate of GATES) {
        try {
          results.push(await gate.evaluate(claim, {
            evidence: [establishing], siblings: [], entity, policyVersion: POLICY_VERSION,
          }));
        } catch (err) {
          // A gate that threw did not pass. PTC-2: only an explicit pass passes.
          results.push({
            gate: gate.name, outcome: 'error', band: gate.band,
            detail: err instanceof Error ? err.message : String(err),
          });
        }
      }
      await db.recordGateResults(claim.id, run.id, results, POLICY_VERSION);
      const decision = releaseDecision(claim, results);
      await db.applyRelease(decision, run.id);

      if (decision.decision === 'released') {
        classified++;
        run.counts.released++;
      } else {
        quarantined++;
        run.counts.quarantined++;
        await run.decision('quarantine', {
          entityId: t.entity_id, claimId: claim.id, rule: 'release_gate',
          after: { decision: decision.decision, failed: decision.gatesFailed },
          reason: decision.reason ?? '',
        });
      }
    }
    run.counts.touched++;
    // Same reason as `contract`: this loop commits per entity and may never log
    // or checkpoint, so without this the partial counts die with the process.
    await run.flushCounts({ throttled: true });
  }

  await run.log('info', 'backfill_finished', { classified, quarantined });
  console.log(`classified : ${classified}`);
  console.log(`quarantined: ${quarantined}`);
});
