import 'dotenv/config';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { fetchJson, sleep } from '../lib/http.js';

/**
 * Measured discovery sample (option B).
 *
 * Runs the widened Companies House search, measures what it would actually
 * yield, and writes nothing. The point is to know the duplicate rate, the shell
 * rate and the API cost *before* committing a full pool to the pipeline, rather
 * than discovering at record 300 that most of them are dormant registrations.
 *
 * Fragments are name patterns that a family wealth vehicle plausibly registers
 * under. They select which companies to look at, never what a company is --
 * every candidate still has to pass substance, the gates and the commercial
 * floor. Adding a fragment cannot lower the bar; it can only widen the funnel.
 */

const BASE = 'https://api.company-information.service.gov.uk';

/** Stage 1 used these. Kept so the overlap is measurable. */
const EXISTING_FRAGMENTS = [
  'family office', 'family investment', 'family holdings', 'family capital', 'legacy', 'heritage', 'family trust',
];

/**
 * Widened set. Each is a term a family wealth vehicle actually registers under;
 * none is a generic finance word that would drag in ordinary asset managers.
 */
const NEW_FRAGMENTS = [
  'family wealth', 'family partners', 'family group', 'family assets', 'family estates',
  'family fund', 'family ventures', 'family enterprises', 'family investments',
  'private office', 'family services', 'family management', 'family properties',
  'family securities', 'family equity',
];

/** Stage 1's codes plus adjacent investment-vehicle classifications. */
const EXISTING_SIC = ['64205', '64303', '66300', '64209', '70100', '64999'];
const NEW_SIC = ['64301', '64302', '64304', '64306', '66190', '70221'];

function auth(): Record<string, string> {
  const key = process.env.COMPANIES_HOUSE_API_KEY;
  if (!key) throw new Error('COMPANIES_HOUSE_API_KEY not set');
  return { Authorization: `Basic ${Buffer.from(`${key}:`).toString('base64')}` };
}

interface SearchHit {
  company_number: string;
  company_name: string;
  company_status: string;
  date_of_creation: string;
  sic_codes?: string[];
}

async function search(fragment: string, sic: string): Promise<SearchHit[]> {
  const path =
    `/advanced-search/companies?company_name_includes=${encodeURIComponent(fragment)}` +
    `&sic_codes=${sic}&company_status=active&size=40`;
  try {
    const r = await fetchJson<{ items?: SearchHit[] }>(`${BASE}${path}`, { headers: auth(), retries: 2 });
    return r.items ?? [];
  } catch {
    return [];
  }
}

/** Same shell test Stage 1 applied: dormant, micro-entity and never-filed are out. */
const SHELL_ACCOUNTS = new Set(['dormant', 'micro-entity', 'null', '']);

async function isSubstantive(num: string): Promise<{ ok: boolean; type: string }> {
  try {
    const p = await fetchJson<{ accounts?: { last_accounts?: { type?: string } } }>(
      `${BASE}/company/${num}`, { headers: auth(), retries: 2 },
    );
    const type = p.accounts?.last_accounts?.type ?? '';
    return { ok: !SHELL_ACCOUNTS.has(type), type: type || 'never filed' };
  } catch {
    return { ok: false, type: 'unreadable' };
  }
}

const root = fileURLToPath(new URL('../../../../', import.meta.url));
const known = new Set(
  (JSON.parse(readFileSync(root + 'data/candidates-uk.json', 'utf8')).companies as Array<{ companyNumber: string }>)
    .map((c) => c.companyNumber),
);

const t0 = Date.now();
let calls = 0;
const found = new Map<string, SearchHit>();

// Sample: the new fragments across both SIC sets, plus existing fragments
// against the new SIC codes. Both are combinations Stage 1 never issued.
const combos: Array<[string, string]> = [];
for (const f of NEW_FRAGMENTS) for (const s of [...EXISTING_SIC, ...NEW_SIC]) combos.push([f, s]);
for (const f of EXISTING_FRAGMENTS) for (const s of NEW_SIC) combos.push([f, s]);

const SAMPLE = Number(process.env.SAMPLE_COMBOS ?? 60);
const sampled = combos.slice(0, SAMPLE);

console.log(`combinations available: ${combos.length}, sampling ${sampled.length}`);

for (const [f, s] of sampled) {
  const items = await search(f, s);
  calls++;
  for (const it of items) if (!found.has(it.company_number)) found.set(it.company_number, it);
  await sleep(120);
}

const all = [...found.values()];
const dupes = all.filter((c) => known.has(c.company_number));
const fresh = all.filter((c) => !known.has(c.company_number));

// Substance-check a sample of the new ones only.
const CHECK = Math.min(fresh.length, Number(process.env.SAMPLE_SUBSTANCE ?? 40));
let substantive = 0;
const byType = new Map<string, number>();
for (const c of fresh.slice(0, CHECK)) {
  const r = await isSubstantive(c.company_number);
  calls++;
  byType.set(r.type, (byType.get(r.type) ?? 0) + 1);
  if (r.ok) substantive++;
  await sleep(120);
}

const secs = (Date.now() - t0) / 1000;
const substanceRate = CHECK ? substantive / CHECK : 0;
const perCombo = sampled.length ? fresh.length / sampled.length : 0;

console.log(`\n--- SAMPLE RESULT (${sampled.length} of ${combos.length} combinations) ---`);
console.log(`unique companies returned      : ${all.length}`);
console.log(`  already in the Stage 1 pool  : ${dupes.length}  (duplicate rate ${(all.length ? dupes.length / all.length * 100 : 0).toFixed(0)}%)`);
console.log(`  NEW candidates               : ${fresh.length}`);
console.log(`substance-checked              : ${CHECK}`);
console.log(`  passed (not a shell)         : ${substantive}  (${(substanceRate * 100).toFixed(0)}%)`);
console.log(`  rejected as shell/inactive   : ${CHECK - substantive}  (${((1 - substanceRate) * 100).toFixed(0)}%)`);
console.log(`accounts filing types seen     : ${[...byType].map(([k, v]) => `${k}=${v}`).join(', ')}`);
console.log(`\napi calls used                  : ${calls}`);
console.log(`wall time                      : ${secs.toFixed(0)}s`);
console.log(`\n--- PROJECTION TO THE FULL COMBINATION SET ---`);
const projFresh = Math.round(perCombo * combos.length);
console.log(`new candidates at ${combos.length} combinations : ~${projFresh}`);
console.log(`  surviving the shell filter   : ~${Math.round(projFresh * substanceRate)}`);
console.log(`search calls                   : ${combos.length}`);
console.log(`substance calls                : ~${projFresh}`);
console.log(`collector calls (3 per record) : ~${Math.round(projFresh * substanceRate) * 3}`);
console.log(`estimated wall time            : ~${((combos.length + projFresh + Math.round(projFresh * substanceRate) * 3) * 0.35 / 60).toFixed(0)} min`);
console.log(`\nsample of new candidate names:`);
for (const c of fresh.slice(0, 12)) console.log(`  - ${c.company_name} (${c.company_number}, ${c.sic_codes?.join('/') ?? '-'})`);
