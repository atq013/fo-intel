import 'dotenv/config';
import { fileURLToPath } from 'node:url';
import { withRun } from '../run/runner.js';
import { processSource } from '../run/pipeline.js';
import { SEC_ADV_SOURCE, advCollector, advExtractor, advEntityId, loadAdv } from '../collect/sec-adv.js';
import { connect } from '../../../db/src/connect.js';
import type { Observation } from '@fo/core/contract/index.js';

/**
 * `discover-adv` — the measured 27.
 *
 * Scope is fixed before the run rather than discovered during it: the archive
 * holds 78 family-office-named registrants, 49 of which filed in 2023 or later,
 * and 22 of those are already in the file from 13F. That leaves 27, and the run
 * imports exactly those.
 *
 * Two dedup keys, because either alone leaks. CRD catches a firm we already hold
 * from ADV; the normalised legal name catches the same firm arriving under a
 * different id from the 13F census, which is where all 22 overlaps come from.
 */

const root = fileURLToPath(new URL('../../../../', import.meta.url));
const adv = loadAdv(root + 'data/adv/adv-family-offices.json');
const sql = connect();

/** Matches the normalisation used to join the 13F census, so the two agree. */
const norm = (s: string) =>
  s.toUpperCase().replace(/[.,]/g, ' ')
    .replace(/\b(L\s?L\s?C|L\s?P|LLP|INC|CORP|CORPORATION|COMPANY|CO|LTD|LIMITED|TRUST|THE)\b/g, ' ')
    .replace(/[^A-Z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();

const existing = (await sql`SELECT id, canonical_name FROM s2_entity`) as unknown as
  Array<{ id: string; canonical_name: string }>;
const haveIds = new Set(existing.map((e) => e.id));
const haveNames = new Set(existing.map((e) => norm(e.canonical_name)));

// "Recent filing" is the selection rule, and it is a filing-date filter, not a
// registration-status claim. The distinction is carried into the data: the
// extractor asserts the date and never asserts "active".
const RECENT_FROM = '2023-01-01';

const recent = adv.registrants.filter((r) => r.latestFilingDate >= RECENT_FROM);
const netNew = recent.filter(
  (r) => !haveIds.has(advEntityId(r.crd)) && !haveNames.has(norm(r.legalName)),
);

function entityFor(observation: Observation) {
  const r = JSON.parse(observation.body ?? '{}') as { crd: string; legalName: string };
  return {
    id: advEntityId(r.crd),
    canonicalName: r.legalName,
    // Never `family_office`. The family office rule excludes single family
    // offices from registration, so an ADV registrant cannot be one.
    entityType: 'unconfirmed_registered_adviser',
  };
}

await withRun('discover', process.env.GITHUB_EVENT_NAME === 'schedule' ? 'schedule' : 'manual', async (run) => {
  await run.log('info', 'adv_scope', {
    archiveCutoff: adv.archiveCutoff,
    totalRegistrants: adv.registrants.length,
    filedSince: RECENT_FROM,
    recent: recent.length,
    alreadyHeld: recent.length - netNew.length,
    netNew: netNew.length,
    staleness: adv.staleness,
  });

  if (!netNew.length) {
    await run.log('info', 'adv_nothing_new');
    return;
  }

  await processSource({
    run,
    source: SEC_ADV_SOURCE,
    collector: advCollector(netNew, adv),
    extractor: advExtractor(),
    entityFor,
    maxUnits: netNew.length,
    resume: false,
  });
});
