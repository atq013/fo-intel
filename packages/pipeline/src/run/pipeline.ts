import { openExtractionEvent } from '@fo/core/contract/index.js';
import type {
  Claim, Collector, Entity, Evidence, Extractor, GateResult, Observation, Source,
} from '@fo/core/contract/index.js';
import { contractWriter } from '../../../db/src/contract-writer.js';
import { GATES } from '../gates/index.js';
import { assessEntity, releaseDecision, POLICY_VERSION } from '../release/gate.js';
import { syncContacts } from './contacts.js';
import type { RunHandle } from './runner.js';

/**
 * The loop every job shares: collect, extract, gate, release, checkpoint.
 *
 * Written once because the interesting property is uniformity -- every claim
 * from every source passes the same gates and the same chokepoint. A source that
 * needed its own release path would be a source whose data nobody had checked.
 */

const db = contractWriter(process.env.DATABASE_URL!);

export interface ProcessOptions {
  run: RunHandle;
  source: Source;
  collector: Collector;
  extractor: Extractor;
  /** stable, deterministic id so re-running upserts rather than duplicates */
  entityFor: (observation: Observation) => { id: string; canonicalName: string; entityType?: string };
  /** stop after this many units; the budget guard, in its simplest form */
  maxUnits?: number;
  resume?: boolean;
}

export async function processSource(opts: ProcessOptions): Promise<void> {
  const { run, source, collector, extractor, entityFor } = opts;
  const maxUnits = opts.maxUnits ?? Number(process.env.MAX_UNITS ?? 40);

  await db.upsertSource(source);
  const cursor = opts.resume === false ? undefined : (await run.readCheckpoint(source.id)) ?? undefined;
  await run.log('info', 'source_started', { source: source.id, resumeFrom: cursor ?? null, maxUnits });

  let units = 0;

  for await (const { observation, cursor: next } of collector.collect(source, cursor)) {
    if (units >= maxUnits) {
      await run.log('info', 'budget_halt', { source: source.id, units, reason: 'maxUnits reached' });
      await run.decision('budget_halt', {
        rule: 'max_units_per_run',
        reason: `stopped after ${units} units to stay inside the run budget`,
        after: { cursor: next },
      });
      break;
    }

    try {
      await processObservation(observation, { run, source, extractor, entityFor });
      units++;
      run.counts.touched++;

      // Checkpoint AFTER the writes have committed. See migration 004.
      if (next) await run.checkpoint(source.id, next, units);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      run.failures.push({ source: source.id, url: observation.url, message });
      await run.log('error', 'unit_failed', { url: observation.url, message });
      // One bad unit must not end the run -- an unattended system that stops on
      // the first malformed record is a system that stops.
    }
  }

  await run.log('info', 'source_finished', { source: source.id, units });
}

async function processObservation(
  observation: Observation,
  ctx: Pick<ProcessOptions, 'run' | 'source' | 'extractor' | 'entityFor'>,
): Promise<void> {
  const { run, extractor, entityFor } = ctx;
  const ent = entityFor(observation);

  // Evidence-based staleness: if we have seen this exact content before, there
  // is nothing new to extract. A clock alone never justifies re-extraction.
  const seen = (await db.sql`
    SELECT id FROM s2_observation WHERE url = ${observation.url} AND content_hash = ${observation.contentHash}
    LIMIT 1`) as unknown as Array<{ id: string }>;
  if (seen.length) {
    await run.log('debug', 'unchanged', { url: observation.url, hash: observation.contentHash });
    return;
  }

  const priorRows = (await db.sql`
    SELECT content_hash FROM s2_observation WHERE url = ${observation.url}
    ORDER BY fetched_at DESC LIMIT 1`) as unknown as Array<{ content_hash: string }>;
  const prior = priorRows[0]?.content_hash;

  await db.upsertObservation(observation);

  const entity: Entity = {
    id: ent.id, canonicalName: ent.canonicalName, entityType: ent.entityType ?? 'unconfirmed',
    firstSeenAt: new Date(), trustState: 'active', commercialState: 'unassessed',
    strictReachable: false, profileAssistedReachable: false,
  };
  await db.upsertEntity(entity);

  if (prior) {
    // A content change with a recorded before/after is the staleness evidence
    // the brief asks for. Recorded when it happens, not reconstructed later.
    await run.decision('stale', {
      entityId: ent.id, rule: 'content_hash_changed',
      before: { contentHash: prior }, after: { contentHash: observation.contentHash },
      reason: `source content at ${observation.url} changed, so its claims are re-derived`,
    });
    await run.log('info', 'content_changed', { url: observation.url, from: prior, to: observation.contentHash });
  }

  const event = openExtractionEvent({ observation, extractor: extractor.name, runId: run.id });
  await extractor.extract(observation, event);
  const closed = event.close();
  if (!closed.assertions.length) return;

  await db.writeEvent(closed.event, closed.assertions, closed.attached);
  run.counts.created += closed.assertions.length;

  // Person-name claims already released for this entity, so a gate can verify a
  // value against a name established by an EARLIER reading. The profile channel
  // needs this: the slug check compares against a name that came from Companies
  // House or ADV, not from the search result being read now.
  //
  // Scoped to name fields on purpose. `coherence` keys on the extraction event,
  // so admitting older address parts as siblings would make every new address
  // claim look assembled across readings. Names belong to no composite, so they
  // cannot affect it.
  const priorNames = (await db.sql`
    SELECT id, entity_id, extraction_event_id, field, value_json, value_type, status,
           confidence, refresh_policy, established_at
    FROM s2_claim
    WHERE entity_id = ${ent.id} AND status = 'released'
      AND field LIKE '%fullName'`) as unknown as Array<Record<string, any>>;

  const siblings = [
    ...closed.assertions.map((a) => a.claim),
    ...priorNames.map((r) => ({
      id: r.id, entityId: r.entity_id, extractionEventId: r.extraction_event_id,
      field: r.field, value: r.value_json, valueType: r.value_type, status: r.status,
      confidence: r.confidence, refreshPolicy: r.refresh_policy,
      establishedAt: new Date(r.established_at),
    })) as Claim[],
  ];
  const released: Claim[] = [];
  // Kept so contact promotion can see which gate actually proved ownership,
  // rather than re-deriving it from the claim and guessing.
  const evidenceByClaim = new Map<string, Evidence>();
  const resultsByClaim = new Map<string, GateResult[]>();

  for (const { claim, establishing } of closed.assertions) {
    const results: GateResult[] = [];
    for (const gate of GATES) {
      try {
        results.push(await gate.evaluate(claim, {
          evidence: [establishing], observation,
          siblings: siblings.filter((c) => c.id !== claim.id),
          entity, policyVersion: POLICY_VERSION,
        }));
      } catch (err) {
        // A gate that threw did not pass. Recording it as `error` keeps PTC-2
        // honest: only an explicit pass counts as a pass.
        results.push({
          gate: gate.name, outcome: 'error', band: gate.band,
          detail: err instanceof Error ? err.message : String(err),
        });
      }
    }

    await db.recordGateResults(claim.id, run.id, results, POLICY_VERSION);
    evidenceByClaim.set(claim.id, establishing);
    resultsByClaim.set(claim.id, results);
    const decision = releaseDecision(claim, results);
    await db.applyRelease(decision, run.id);

    if (decision.decision === 'released') {
      released.push(claim);
      run.counts.released++;
    } else {
      run.counts.quarantined++;
      await run.decision(decision.decision === 'quarantined' ? 'quarantine' : 'release', {
        entityId: ent.id, claimId: claim.id, rule: 'release_gate',
        after: { decision: decision.decision, failed: decision.gatesFailed, skipped: decision.gatesSkipped },
        reason: decision.reason ?? '',
      });
    }
  }

  // Contacts and reachability, before the commercial assessment reads them.
  const reach = await syncContacts(ent.id, released, evidenceByClaim, resultsByClaim, priorNames.length > 0);
  if (reach.created) {
    await run.log('info', 'contacts_synced', {
      entity: ent.id, routes: reach.created,
      strictReachable: reach.strict, profileAssistedReachable: reach.profileAssisted,
      postalReachable: reach.postal,
    });
  }

  // Commercial sufficiency is a question about the WHOLE record.
  //
  // `released` holds only what THIS reading produced. For a collector that adds
  // one value to an existing entity -- the profile channel adds a single URL --
  // assessing that alone judged a complete record as though it had one field and
  // withheld it. The entity's full released set is the only correct input.
  const allReleased = (await db.sql`
    SELECT id, entity_id, extraction_event_id, field, value_json, value_type, status,
           confidence, refresh_policy, established_at
    FROM s2_claim WHERE entity_id = ${ent.id}
      AND status = 'released'`) as unknown as Array<Record<string, any>>;

  const commercial = assessEntity(entity, allReleased.map((r) => ({
    id: r.id, entityId: r.entity_id, extractionEventId: r.extraction_event_id, field: r.field,
    value: r.value_json, valueType: r.value_type, status: r.status, confidence: r.confidence,
    refreshPolicy: r.refresh_policy, establishedAt: new Date(r.established_at),
  })) as Claim[]);
  await db.sql`UPDATE s2_entity SET commercial_state = ${commercial.commercialState}, updated_at = now()
               WHERE id = ${ent.id}`;
  await run.decision('classify', {
    entityId: ent.id, rule: 'commercial_floor',
    after: { state: commercial.commercialState, missing: commercial.missing },
    reason: commercial.reason,
  });
}
