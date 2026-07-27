import 'dotenv/config';
import { existsSync, readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import { buildDataset } from './emit/build-dataset.js';
import { findWebsite } from './enrich/find-website.js';
import { findContacts, hunterUsage, type ContactFinding } from './enrich/contacts.js';
import { isCustomerFacing } from './validate/email-verify.js';
import { serperUsage } from './lib/serper.js';

const OUT = 'data/contact-findings.json';
const LOG = 'data/contacts.log';
const DEADLINE_MS = Number(process.env.CONTACT_MINUTES ?? 80) * 60_000;

function log(msg: string) {
  const line = `${new Date().toISOString().slice(11, 19)}  ${msg}`;
  console.log(line);
  appendFileSync(LOG, line + '\n');
}

interface Stored { website: string | null; websiteBasis: string; contacts: ContactFinding }
const stored: Record<string, Stored> = existsSync(OUT) ? JSON.parse(readFileSync(OUT, 'utf8')) : {};

const { records } = buildDataset();
const started = Date.now();

// Records with the strongest classification first: if we run out of time, the
// best records are the ones that got enriched.
const targets = records
  .filter((r) => !stored[r.id])
  .sort((a, b) => b.classification.confidence - a.classification.confidence);

log(`enriching contacts for ${targets.length} of ${records.length} records`);

let done = 0, withEmail = 0, withPhone = 0, withSite = 0;

for (const r of targets) {
  if (Date.now() - started > DEADLINE_MS) { log('reached time budget'); break; }

  const location = [r.city.value, r.country.value].filter(Boolean).join(' ');
  try {
    const site = r.website.value ?? (await findWebsite(r.legalName, location)).website;
    const principal = r.principals[0]?.fullName.value ?? '';
    // Vendor credits go only to records strong enough to be worth one.
    const contacts = await findContacts(site, principal, { allowVendor: r.classification.confidence >= 0.8 });

    stored[r.id] = { website: site, websiteBasis: site ? 'confirmed against the firm name' : 'none found', contacts };

    if (site) withSite++;
    if (contacts.emails.some((e) => isCustomerFacing(e.status))) withEmail++;
    if (contacts.phones.length) withPhone++;

    const email = contacts.emails.find((e) => isCustomerFacing(e.status));
    if (site || email) {
      log(`  ${r.legalName.slice(0, 38).padEnd(40)} ${(site ?? '-').slice(0, 34).padEnd(36)} ${email?.address ?? ''}`);
    }
  } catch (err) {
    log(`  ERROR ${r.legalName.slice(0, 40)}: ${err instanceof Error ? err.message : err}`);
  }

  done++;
  writeFileSync(OUT, JSON.stringify(stored, null, 2));
  if (done % 10 === 0) {
    log(`${done}/${targets.length}  sites ${withSite}  emails ${withEmail}  phones ${withPhone}  | serper ${serperUsage()} hunter ${hunterUsage()}`);
  }
}

log(`finished: ${done} records | sites ${withSite} | emails ${withEmail} | phones ${withPhone}`);
log(`serper ${serperUsage()}  hunter ${hunterUsage()}`);
