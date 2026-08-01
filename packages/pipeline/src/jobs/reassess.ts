import 'dotenv/config';
import { connect } from '../../../db/src/connect.js';
import { assessEntity, POLICY_VERSION } from '../release/gate.js';
import type { Claim, Entity } from '@fo/core/contract/index.js';

/**
 * Re-derive commercial state for entities left `unassessed` while holding
 * released claims.
 *
 * That combination is not a natural state: the floor runs on every entity that
 * gets claims. It was produced by `upsertEntity` writing its INSERT placeholders
 * on the conflict path, which reset the assessment on every re-touch and left it
 * reset whenever the unit returned early. The upsert is fixed; this repairs the
 * rows it already reset.
 *
 * Idempotent, and it reassesses from ALL released claims for the entity rather
 * than from any batch, so a record with three values is never judged as though
 * it had one.
 */

const sql = connect();

const stranded = (await sql`
  SELECT DISTINCT e.id FROM s2_entity e
  WHERE e.commercial_state = 'unassessed'
    AND EXISTS (SELECT 1 FROM s2_claim c WHERE c.entity_id = e.id AND c.status = 'released')
  ORDER BY e.id`) as unknown as Array<{ id: string }>;

console.log(`entities to reassess: ${stranded.length}`);

let qualifying = 0;
let withheld = 0;

for (const { id } of stranded) {
  const rows = (await sql`
    SELECT id, entity_id, extraction_event_id, field, value_json, value_type, status,
           confidence, refresh_policy, established_at
    FROM s2_claim WHERE entity_id = ${id} AND status = 'released'`) as unknown as Array<Record<string, any>>;

  const claims = rows.map((r) => ({
    id: r.id, entityId: r.entity_id, extractionEventId: r.extraction_event_id, field: r.field,
    value: r.value_json, valueType: r.value_type, status: r.status, confidence: r.confidence,
    refreshPolicy: r.refresh_policy, establishedAt: new Date(r.established_at),
  })) as Claim[];

  const entity: Entity = {
    id, canonicalName: id, entityType: 'unconfirmed', firstSeenAt: new Date(),
    trustState: 'active', commercialState: 'unassessed',
    strictReachable: false, profileAssistedReachable: false,
  };
  const commercial = assessEntity(entity, claims, POLICY_VERSION);
  await sql`UPDATE s2_entity SET commercial_state = ${commercial.commercialState}, updated_at = now()
            WHERE id = ${id}`;
  if (commercial.commercialState === 'qualifying') qualifying++; else withheld++;
  console.log(`  ${id}  ${rows.length} released claims -> ${commercial.commercialState}`);
}

console.log(`reassessed ${stranded.length}: ${qualifying} qualifying, ${withheld} withheld`);
