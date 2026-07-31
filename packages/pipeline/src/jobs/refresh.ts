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

const rows = (await sql`
  SELECT DISTINCT ON (e.id) e.id, o.url
  FROM s2_entity e
  JOIN s2_claim c        ON c.entity_id = e.id
  JOIN s2_extraction_event xe ON xe.id = c.extraction_event_id
  JOIN s2_observation o  ON o.id = xe.observation_id
  WHERE e.id LIKE 'ent_ch_%' AND e.trust_state = 'active'
  ORDER BY e.id, o.fetched_at ASC`) as unknown as Array<{ id: string; url: string }>;

// Oldest observation first, then take the batch. Sorting in SQL alongside
// DISTINCT ON would order by the wrong key, so it is done here.
const numbers = rows
  .map((r) => ({ number: r.url.split('/company/')[1] ?? '', id: r.id }))
  .filter((r) => r.number)
  .slice(0, BATCH)
  .map((r) => r.number);

function entityFor(observation: Observation) {
  const doc = JSON.parse(observation.body ?? '{}') as { companyNumber: string; profile?: { company_name?: string } };
  return {
    id: `ent_ch_${doc.companyNumber}`,
    canonicalName: doc.profile?.company_name ?? doc.companyNumber,
    entityType: 'unconfirmed',
  };
}

await withRun('refresh', process.env.GITHUB_EVENT_NAME === 'schedule' ? 'schedule' : 'manual', async (run) => {
  await run.log('info', 'refresh_scope', { entities: rows.length, batch: numbers.length });
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
