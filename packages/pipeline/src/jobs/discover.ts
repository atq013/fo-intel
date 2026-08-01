import 'dotenv/config';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { withRun } from '../run/runner.js';
import { processSource } from '../run/pipeline.js';
import {
  COMPANIES_HOUSE_SOURCE,
  companiesHouseCollector,
  companiesHouseExtractor,
} from '../collect/companies-house.js';
import { buildAddressIndex } from '../collect/uk-director-address.js';
import type { Observation } from '@fo/core/contract/index.js';

/**
 * `discover` — Companies House, through the contract.
 *
 * Ordering is deliberate: the companies that appear in the Stage 1 delivered
 * dataset go first. The roadmap requires the Stage 1 fifty to be re-derived
 * through the new pipeline rather than copied across, and re-deriving them first
 * means the re-qualified count is known early, while there is still time to act
 * on it. It is also the number most likely to be uncomfortable, and finding out
 * late would be the expensive way to learn it.
 */

const root = fileURLToPath(new URL('../../../../', import.meta.url));

function loadCandidates(): string[] {
  const uk = JSON.parse(readFileSync(root + 'data/candidates-uk.json', 'utf8')) as {
    companies: Array<{ companyNumber: string; name: string; hasSubstance: boolean }>;
  };

  // Company numbers that appear in the Stage 1 delivered file, matched by name.
  const delivered = JSON.parse(readFileSync(root + 'data/fo-dataset.json', 'utf8')) as Array<{ legalName: string }>;
  const deliveredNames = new Set(delivered.map((r) => r.legalName.trim().toUpperCase()));

  const inStage1: string[] = [];
  const rest: string[] = [];
  for (const c of uk.companies) {
    if (deliveredNames.has(c.name.trim().toUpperCase())) inStage1.push(c.companyNumber);
    else if (c.hasSubstance) rest.push(c.companyNumber);
  }

  // The narrow pool: explicit family-office terms only. Collected separately
  // after the broad terms were measured and rejected for returning independent
  // financial advisers rather than family offices.
  const seen = new Set([...inStage1, ...rest]);
  const extra: string[] = [];

  for (const file of ['data/candidates-uk-narrow.json', 'data/candidates-uk-expanded.json']) {
    try {
      const n = JSON.parse(readFileSync(root + file, 'utf8')) as {
        companies: Array<{ companyNumber: string; matchedTerm?: string }>;
      };
      // Ordered by how strongly the name self-describes. "family office" is an
      // unambiguous claim; "family holdings" is a broader family-wealth vehicle
      // and many are property companies. Both are collected -- the gates and the
      // commercial floor decide -- but the stronger ones are read first so an
      // interrupted climb keeps the better records.
      const rank = (m?: string) =>
        m?.includes('family office') ? 0 : m?.includes('family investment') ? 1 : 2;
      for (const c of [...n.companies].sort((a, b) => rank(a.matchedTerm) - rank(b.matchedTerm))) {
        if (seen.has(c.companyNumber)) continue;
        seen.add(c.companyNumber);
        extra.push(c.companyNumber);
      }
    } catch {
      // An absent file simply means that collection has not been run.
    }
  }

  // No pre-filtering for substance here: the collector reads the profile and
  // skips shells itself, so one rule applies to every company number regardless
  // of which list it arrived on.

  // Shells are excluded from the tail but never from the Stage 1 set: a record
  // we already shipped must be re-judged on the new standard, not quietly
  // dropped because it would fail. Dropping it would hide the correction.
  return [...inStage1, ...rest, ...extra];
}

const numbers = loadCandidates();

// The cross-company address census, built once before any extraction. Without
// it a formation agent's address used by twenty companies would adjudicate to
// an individual for each of them.
buildAddressIndex(root + 'data/candidates-uk.json');

function entityFor(observation: Observation) {
  const doc = JSON.parse(observation.body ?? '{}') as { companyNumber: string; profile?: { company_name?: string } };
  return {
    // Deterministic, so a re-run upserts the same entity instead of duplicating
    // it. Entity duplication is disqualifying in the brief.
    id: `ent_ch_${doc.companyNumber}`,
    canonicalName: doc.profile?.company_name ?? doc.companyNumber,
    entityType: 'unconfirmed',
  };
}

await withRun('discover', (process.env.GITHUB_EVENT_NAME === 'schedule' ? 'schedule' : 'manual'), async (run) => {
  await run.log('info', 'candidates_loaded', { total: numbers.length });
  await processSource({
    run,
    source: COMPANIES_HOUSE_SOURCE,
    collector: companiesHouseCollector(numbers),
    extractor: companiesHouseExtractor((doc) => `ent_ch_${doc.companyNumber}`),
    entityFor,
  });
});
