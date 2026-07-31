import 'dotenv/config';
import { withRun } from '../run/runner.js';
import { processSource } from '../run/pipeline.js';
import {
  VERIFIED_PROFILE_SOURCE, verifiedProfileCollector, verifiedProfileExtractor,
  type ProfileTarget,
} from '../collect/verified-profile.js';
import { connect } from '../../../db/src/connect.js';
import type { Observation } from '@fo/core/contract/index.js';

/**
 * `discover-profiles` — verified personal profiles for entities that have a
 * named principal but no route to them.
 *
 * Runs on its own source (`src_verified_profile`) and therefore its own
 * checkpoint row, keyed `(job, source_id)`. It cannot collide with the Companies
 * House or SEC cursors, and it creates no entities: every target already exists,
 * so this only ever adds a route to a record we already hold.
 */

const sql = connect();
const BATCH = Number(process.env.PROFILE_BATCH ?? 150);

// Qualifying entities with a released person name, no strict route, and no
// profile already stored. The last condition is what makes a re-run cheap
// instead of re-searching everything.
const rows = (await sql`
  SELECT DISTINCT ON (e.id) e.id, e.canonical_name, p.value_json #>> '{}' AS person
  FROM s2_entity e
  JOIN s2_claim p ON p.entity_id = e.id AND p.field LIKE '%fullName' AND p.status = 'released'
  WHERE e.commercial_state = 'qualifying'
    AND NOT e.strict_reachable
    AND NOT EXISTS (
      SELECT 1 FROM s2_contact c
      WHERE c.entity_id = e.id AND c.channel = 'linkedin' AND c.status = 'released')
  ORDER BY e.id
  LIMIT ${BATCH}`) as unknown as Array<{ id: string; canonical_name: string; person: string }>;

const targets: ProfileTarget[] = rows.map((r) => ({
  entityId: r.id, firmName: r.canonical_name, person: r.person,
}));

function entityFor(observation: Observation) {
  const d = JSON.parse(observation.body ?? '{}') as { entityId: string; firmName: string };
  // Upsert of an entity that already exists. `entityType` is deliberately left
  // as it was: finding someone's profile says nothing about what the firm is.
  return { id: d.entityId, canonicalName: d.firmName, entityType: 'unconfirmed' };
}

await withRun('discover', process.env.GITHUB_EVENT_NAME === 'schedule' ? 'schedule' : 'manual', async (run) => {
  await run.log('info', 'profile_scope', {
    source: VERIFIED_PROFILE_SOURCE.id,
    targets: targets.length,
    note: 'profile-assisted reachability only; a profile never counts as strict (ADR-11)',
  });

  if (!targets.length) {
    await run.log('info', 'profile_nothing_to_do');
    return;
  }

  await processSource({
    run,
    source: VERIFIED_PROFILE_SOURCE,
    collector: verifiedProfileCollector(targets),
    extractor: verifiedProfileExtractor(),
    entityFor,
    maxUnits: targets.length,
  });
});
