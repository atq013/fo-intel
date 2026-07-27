import 'dotenv/config';
import { existsSync, readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import { buildDataset } from './emit/build-dataset.js';
import { selectFinal } from './emit/select-final.js';
import { findLocation, type LocationFinding } from './enrich/find-location.js';
import { serperUsage } from './lib/serper.js';

const OUT = 'data/location-findings.json';
const LOG = 'data/locations.log';

function log(m: string) {
  const line = `${new Date().toISOString().slice(11, 19)}  ${m}`;
  console.log(line);
  appendFileSync(LOG, line + '\n');
}

const stored: Record<string, LocationFinding> = existsSync(OUT) ? JSON.parse(readFileSync(OUT, 'utf8')) : {};

const { records: qualifying } = buildDataset();
const records = selectFinal(qualifying, 50).selected;

// Only records that actually lack a location. Registry and SEC records already
// carry a filed address and must not be overwritten by a web claim.
const targets = records.filter((r) => !r.country.value && !r.street.value && !stored[r.id]);
log(`${targets.length} of ${records.length} delivered records have no location`);

let found = 0;
for (const r of targets) {
  const f = await findLocation(r.legalName, r.principals[0]?.fullName.value ?? '');
  stored[r.id] = f;
  writeFileSync(OUT, JSON.stringify(stored, null, 2));
  if (f.country || f.city) {
    found++;
    log(`  ${r.legalName.slice(0, 34).padEnd(36)} ${[f.city, f.region, f.country].filter(Boolean).join(', ').slice(0, 40)}  (tier ${f.sourceTier})`);
  }
  await new Promise((x) => setTimeout(x, 3000));
}

log(`finished: ${found}/${targets.length} located | serper ${serperUsage()}`);
