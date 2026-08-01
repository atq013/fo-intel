import 'dotenv/config';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { fetchJson, sleep } from '../lib/http.js';

/**
 * Stratified sample of the 1,096 new candidates, per search term.
 *
 * The pool is not homogeneous and averaging it would hide that: "family
 * holdings" is 619 of the 1,096 and is the weakest term, with many SIC 68209
 * property vehicles that may be family property businesses rather than family
 * offices. Sampling each term separately is what shows whether that bucket
 * belongs in the pool at all.
 *
 * Two things are measured, because both decide qualification:
 *   - substance: the same shell test Stage 1 applied, unchanged
 *   - a named person: the commercial floor needs one, and no name means no
 *     record however substantive the company
 *
 * Writes nothing.
 */

const BASE = 'https://api.company-information.service.gov.uk';
const PER_TERM = Number(process.env.PER_TERM ?? 30);

function auth(): Record<string, string> {
  const key = process.env.COMPANIES_HOUSE_API_KEY;
  if (!key) throw new Error('COMPANIES_HOUSE_API_KEY not set');
  return { Authorization: `Basic ${Buffer.from(`${key}:`).toString('base64')}` };
}

/** Unchanged from Stage 1. Not relaxed to make the number work. */
const SHELL = new Set(['dormant', 'micro-entity', 'null', '']);

const root = fileURLToPath(new URL('../../../../', import.meta.url));
const file = JSON.parse(readFileSync(root + 'data/candidates-uk-expanded.json', 'utf8')) as {
  companies: Array<{ companyNumber: string; name: string; matchedTerm: string; sicCodes: string[] }>;
};

const byTerm = new Map<string, typeof file.companies>();
for (const c of file.companies) {
  if (!byTerm.has(c.matchedTerm)) byTerm.set(c.matchedTerm, []);
  byTerm.get(c.matchedTerm)!.push(c);
}

const t0 = Date.now();
let calls = 0;
const summary: Array<Record<string, unknown>> = [];

for (const [term, list] of byTerm) {
  if (list.length < 5) continue;
  // Spread across the list rather than taking the head: the API returns them in
  // its own order and the first 30 are not a random 30.
  const step = Math.max(1, Math.floor(list.length / PER_TERM));
  const picked = list.filter((_, i) => i % step === 0).slice(0, PER_TERM);

  let substantive = 0, named = 0, both = 0;
  const accountTypes = new Map<string, number>();
  const examples: string[] = [];

  for (const c of picked) {
    let ok = false, hasName = false;
    try {
      const p = await fetchJson<{ accounts?: { last_accounts?: { type?: string } } }>(
        `${BASE}/company/${c.companyNumber}`, { headers: auth(), retries: 1 });
      calls++;
      const type = p.accounts?.last_accounts?.type ?? '';
      accountTypes.set(type || 'never filed', (accountTypes.get(type || 'never filed') ?? 0) + 1);
      ok = !SHELL.has(type);
    } catch { accountTypes.set('unreadable', (accountTypes.get('unreadable') ?? 0) + 1); }
    await sleep(100);

    if (ok) {
      substantive++;
      try {
        const o = await fetchJson<{ items?: Array<Record<string, unknown>> }>(
          `${BASE}/company/${c.companyNumber}/officers?items_per_page=20`, { headers: auth(), retries: 1 });
        calls++;
        hasName = (o.items ?? []).some((i) => !i.resigned_on && typeof i.name === 'string' && i.name);
      } catch { /* absent */ }
      await sleep(100);
    }
    if (hasName) named++;
    if (ok && hasName) { both++; if (examples.length < 4) examples.push(c.name); }
  }

  const substanceRate = substantive / picked.length;
  const qualifyRate = both / picked.length;
  summary.push({ term, poolSize: list.length, sampled: picked.length, substantive, both, substanceRate, qualifyRate, examples });

  console.log(`\n"${term}"  pool=${list.length}  sampled=${picked.length}`);
  console.log(`  substantive (not a shell)      : ${substantive}  (${(substanceRate * 100).toFixed(0)}%)`);
  console.log(`  substantive AND has a named person: ${both}  (${(qualifyRate * 100).toFixed(0)}%)`);
  console.log(`  accounts filed: ${[...accountTypes].map(([k, v]) => `${k}=${v}`).join(', ')}`);
  console.log(`  examples: ${examples.join(' | ')}`);
}

console.log(`\n--- PROJECTION ACROSS THE FULL POOL ---`);
let projected = 0;
for (const s of summary) {
  const p = Math.round((s.poolSize as number) * (s.qualifyRate as number));
  projected += p;
  console.log(`  ${String(s.term).padEnd(22)} ${String(s.poolSize).padStart(4)} candidates -> ~${p} qualifying`);
}
console.log(`  ${'TOTAL projected new'.padEnd(22)} ~${projected}`);
console.log(`  current qualifying                            218`);
console.log(`  projected total                               ~${218 + projected}   (target 500)`);
console.log(`\napi calls used : ${calls}`);
console.log(`wall time      : ${((Date.now() - t0) / 1000).toFixed(0)}s`);
console.log(`full-pool cost : ~${file.companies.length * 4} calls (substance + 3 collector calls each)`);
