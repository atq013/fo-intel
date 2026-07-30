import 'dotenv/config';
import { fileURLToPath } from 'node:url';
import { withRun } from '../run/runner.js';
import { processSource } from '../run/pipeline.js';
import {
  SEC_13F_SOURCE, filerUnits, secEntityId, secSignatoryCollector, secSignatoryExtractor,
} from '../collect/sec-signatory.js';
import type { Observation } from '@fo/core/contract/index.js';

/**
 * `discover-sec` — the reachability channel.
 *
 * Separate job from `discover` rather than a second source inside it, because
 * the two have different failure modes and different budgets: Companies House is
 * network-bound and rate-limited, this is a local dataset join costing zero API
 * calls. Sharing a run would make one job's budget halt truncate the other.
 */

const root = fileURLToPath(new URL('../../../../', import.meta.url));
const units = filerUnits(root + 'data/candidates-sec.json', root + 'data/sec');

function entityFor(observation: Observation) {
  const u = JSON.parse(observation.body ?? '{}') as { cik: string; firm: string };
  return { id: secEntityId(u.cik), canonicalName: u.firm, entityType: 'unconfirmed' };
}

await withRun('discover', process.env.GITHUB_EVENT_NAME === 'schedule' ? 'schedule' : 'manual', async (run) => {
  const withRoutes = units.filter((u) => u.routes.some((r) => r.ownership === 'individual')).length;
  await run.log('info', 'sec_units_loaded', {
    filers: units.length,
    filersWithIndividualRoute: withRoutes,
  });

  await processSource({
    run,
    source: SEC_13F_SOURCE,
    collector: secSignatoryCollector(units),
    extractor: secSignatoryExtractor(),
    entityFor,
    maxUnits: Number(process.env.MAX_UNITS ?? units.length),
  });
});
