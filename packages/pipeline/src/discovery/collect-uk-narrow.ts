import 'dotenv/config';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { fetchJson, sleep } from '../lib/http.js';

/**
 * Collects the narrow Companies House pool the sample measured.
 *
 * Only the four explicit family-office terms. The broad set was tried and
 * dropped: it returned independent financial advisers and retail wealth
 * practices, which would have raised the record count by putting a different
 * industry into a family-office dataset.
 *
 * Writes a candidate file; imports nothing. The discover job takes it from
 * there so every record still passes through the same observation, extraction,
 * gate and release path as everything else.
 */

const BASE = 'https://api.company-information.service.gov.uk';

const FRAGMENTS = [
  'family office', 'single family office', 'multi family office',
  'multi-family office', 'private family office',
];
const SIC = ['64205', '64303', '66300', '64209', '70100', '64999',
             '64301', '64302', '64304', '64306', '66190', '70221'];

function auth(): Record<string, string> {
  const key = process.env.COMPANIES_HOUSE_API_KEY;
  if (!key) throw new Error('COMPANIES_HOUSE_API_KEY not set');
  return { Authorization: `Basic ${Buffer.from(`${key}:`).toString('base64')}` };
}

interface Hit {
  company_number: string; company_name: string; company_status: string;
  date_of_creation: string; sic_codes?: string[];
  registered_office_address?: Record<string, string>;
}

/** Same shell bar Stage 1 applied. Never relaxed to reach a number. */
const SHELL = new Set(['dormant', 'micro-entity', 'null', '']);

const root = fileURLToPath(new URL('../../../../', import.meta.url));
const known = new Set(
  (JSON.parse(readFileSync(root + 'data/candidates-uk.json', 'utf8')).companies as Array<{ companyNumber: string }>)
    .map((c) => c.companyNumber),
);

const t0 = Date.now();
let calls = 0;
const found = new Map<string, Hit>();

for (const f of FRAGMENTS) {
  for (const s of SIC) {
    const path = `/advanced-search/companies?company_name_includes=${encodeURIComponent(f)}` +
                 `&sic_codes=${s}&company_status=active&size=40`;
    try {
      const r = await fetchJson<{ items?: Hit[] }>(`${BASE}${path}`, { headers: auth(), retries: 2 });
      for (const it of r.items ?? []) if (!found.has(it.company_number)) found.set(it.company_number, it);
    } catch { /* a dead combination is not a failed run */ }
    calls++;
    await sleep(120);
  }
}

const fresh = [...found.values()].filter((c) => !known.has(c.company_number));
console.log(`search complete: ${found.size} unique, ${fresh.length} new, ${calls} calls`);

const keep: Array<Record<string, unknown>> = [];
let shells = 0;
for (const c of fresh) {
  try {
    const p = await fetchJson<{ accounts?: { last_accounts?: { type?: string; made_up_to?: string } } }>(
      `${BASE}/company/${c.company_number}`, { headers: auth(), retries: 2 },
    );
    calls++;
    const type = p.accounts?.last_accounts?.type ?? '';
    if (SHELL.has(type)) { shells++; continue; }
    keep.push({
      companyNumber: c.company_number, name: c.company_name, status: c.company_status,
      incorporated: c.date_of_creation, sicCodes: c.sic_codes ?? [],
      accountsType: type, hasSubstance: true, officers: [], psc: [],
    });
  } catch { shells++; }
  await sleep(120);
}

const out = root + 'data/candidates-uk-narrow.json';
writeFileSync(out, JSON.stringify({
  generatedAt: new Date().toISOString(),
  method: 'Companies House advanced-search, explicit family-office terms only',
  fragments: FRAGMENTS, sicCodes: SIC,
  note: 'Name selects which companies to investigate. It establishes nothing: every entity is created unconfirmed and must earn its classification from evidence.',
  companies: keep,
}, null, 1));

console.log(`\nsubstance-checked : ${fresh.length}`);
console.log(`  kept            : ${keep.length}`);
console.log(`  shells rejected : ${shells}`);
console.log(`api calls         : ${calls}`);
console.log(`wall time         : ${((Date.now() - t0) / 1000).toFixed(0)}s`);
console.log(`written           : ${out}`);
