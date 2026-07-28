import 'dotenv/config';
import { existsSync, readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import { buildDataset } from './emit/build-dataset.js';
import { selectFinal } from './emit/select-final.js';
import { findProfile, type ProfileFinding } from './enrich/find-profile.js';
import { serperUsage } from './lib/serper.js';

const OUT = 'data/profile-findings.json';
const LOG = 'data/profiles.log';
const DEADLINE_MS = Number(process.env.PROFILE_MINUTES ?? 90) * 60_000;

function log(m: string) {
  const line = `${new Date().toISOString().slice(11, 19)}  ${m}`;
  console.log(line);
  appendFileSync(LOG, line + '\n');
}

const stored: Record<string, ProfileFinding> = existsSync(OUT) ? JSON.parse(readFileSync(OUT, 'utf8')) : {};

const { records: qualifying } = buildDataset();
const records = selectFinal(qualifying, 50).selected;
const targets = records.filter((r) => !stored[r.id]);

log(`enriching profiles for ${targets.length} of ${records.length} delivered records`);

const started = Date.now();
let desc = 0, corp = 0, person = 0;

for (const r of targets) {
  if (Date.now() - started > DEADLINE_MS) {
    log('reached the time budget; stopping with partial coverage');
    break;
  }

  const hint = [r.city.value, r.country.value].filter(Boolean).join(' ');
  try {
    const f = await findProfile(r.legalName, r.principals[0]?.fullName.value ?? '', hint);
    stored[r.id] = f;
    if (f.description) desc++;
    if (f.corporateLinkedin) corp++;
    if (f.principalLinkedin) person++;

    const marks = [f.description ? 'desc' : '', f.corporateLinkedin ? 'co-li' : '', f.principalLinkedin ? 'person-li' : '']
      .filter(Boolean)
      .join(' ');
    if (marks) log(`  ${r.legalName.slice(0, 38).padEnd(40)} ${marks}`);
  } catch (err) {
    log(`  ERROR ${r.legalName.slice(0, 36)}: ${err instanceof Error ? err.message.slice(0, 60) : err}`);
  }

  writeFileSync(OUT, JSON.stringify(stored, null, 2));
  await new Promise((x) => setTimeout(x, 2500));
}

log(`finished: descriptions ${desc} | company pages ${corp} | principal profiles ${person} | serper ${serperUsage()}`);
