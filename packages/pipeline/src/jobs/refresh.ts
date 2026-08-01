import 'dotenv/config';
import { withRun } from '../run/runner.js';
import { processSource } from '../run/pipeline.js';
import {
  COMPANIES_HOUSE_SOURCE,
  companiesHouseCollector,
  companiesHouseExtractor,
} from '../collect/companies-house.js';
import { connect } from '../../../db/src/connect.js';
import { buildAddressIndex } from '../collect/uk-director-address.js';
import type { Observation } from '@fo/core/contract/index.js';
import { selectRotation } from './refresh-rotation.js';

/**
 * `refresh` — re-observe what we already hold, oldest first.
 *
 * This is where the staleness requirement is actually met. Re-fetching produces
 * a content hash; an unchanged hash ends the unit with no writes, and a changed
 * hash is a concrete, evidence-based reason to re-extract, recorded in
 * `decision_log` as a `stale` decision with the before and after hashes.
 *
 * That distinction is the whole point. "This record is 30 days old" is a fact
 * about the clock, not about the data, and the brief is explicit that expiry
 * alone does not establish staleness. Only the source disagreeing with what we
 * stored does.
 *
 * Rotation is by least-recently-observed so the refresh budget spreads across
 * the file instead of repeatedly re-checking the same head of the list.
 */

const sql = connect();
buildAddressIndex(new URL('../../../../data/candidates-uk.json', import.meta.url).pathname.replace(/%20/g, ' '));

const BATCH = Number(process.env.REFRESH_BATCH ?? 25);

/**
 * Least-recently-observed first, and both halves of that mattered.
 *
 * `DISTINCT ON (e.id) ... ORDER BY e.id, o.fetched_at ASC` picks each entity's
 * OLDEST reading, which is not when we last looked at it -- an entity read three
 * times still reports its first reading and looks permanently overdue. What
 * decides rotation is the MOST RECENT reading, so that is what is selected.
 *
 * The rows then still arrive ordered by entity id, and the batch was taken
 * straight off the top of that. A comment said the sort happened here in JS; it
 * did not. So every run re-read the same head of the list: 3 of 546 Companies
 * House URLs had ever been re-read, and the other 543 never once. All 3 that
 * were re-read had genuinely changed, which is the measure of what the broken
 * rotation was hiding rather than a reason to trust it.
 *
 * Sorting ascending by last reading is what makes the budget sweep the file.
 */
const rows = (await sql`
  SELECT DISTINCT ON (e.id) e.id, o.url, o.fetched_at
  FROM s2_entity e
  JOIN s2_claim c        ON c.entity_id = e.id
  JOIN s2_extraction_event xe ON xe.id = c.extraction_event_id
  JOIN s2_observation o  ON o.id = xe.observation_id
  WHERE e.id LIKE 'ent_ch_%' AND e.trust_state = 'active'
  ORDER BY e.id, o.fetched_at DESC`) as unknown as
  Array<{ id: string; url: string; fetched_at: string }>;

const numbers = selectRotation(rows, BATCH);

function entityFor(observation: Observation) {
  const doc = JSON.parse(observation.body ?? '{}') as { companyNumber: string; profile?: { company_name?: string } };
  return {
    id: `ent_ch_${doc.companyNumber}`,
    canonicalName: doc.profile?.company_name ?? doc.companyNumber,
    entityType: 'unconfirmed',
  };
}

await withRun('refresh', process.env.GITHUB_EVENT_NAME === 'schedule' ? 'schedule' : 'manual', async (run) => {
  const oldest = rows.length ? new Date(Math.min(...rows.map((r) => new Date(r.fetched_at).getTime()))) : null;
  await run.log('info', 'refresh_scope', {
    entities: rows.length,
    batch: numbers.length,
    leastRecentlyObserved: oldest?.toISOString() ?? null,
    // Logged so a reviewer can see the rotation actually sweeping rather than
    // taking it on trust: this is how long a full pass over the file takes.
    fullSweepRuns: numbers.length ? Math.ceil(rows.length / numbers.length) : 0,
  });
  if (!numbers.length) {
    await run.log('info', 'nothing_to_refresh');
    return;
  }
  await processSource({
    run,
    source: COMPANIES_HOUSE_SOURCE,
    collector: companiesHouseCollector(numbers),
    extractor: companiesHouseExtractor((doc) => `ent_ch_${doc.companyNumber}`),
    entityFor,
    maxUnits: numbers.length,
    // Refresh always starts from the top of its own list; the discover cursor
    // must not be consumed or advanced by it.
    resume: false,
  });
});
