import 'dotenv/config';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { fetchJson, sleep } from '../lib/http.js';

/**
 * Companies House discovery, paginated and without the SIC filter.
 *
 * Two defects in the earlier searches, and the second was the expensive one.
 *
 * 1. **No pagination.** Every query asked for `size=40` and never read the
 *    `hits` total or used `start_index`. A term with 286 matches returned 40.
 *
 * 2. **The SIC filter was a guess, not a standard.** Stage 1 picked six codes it
 *    assumed family offices register under. Measured against the register that
 *    assumption is wrong: `"family office"` filtered to SIC 64205 returns 11
 *    hits; unfiltered it returns 286. The firms behind the filter register under
 *    68209, 70221, 70229, 68320, 82990 -- property, consultancy, "other business
 *    support" -- whatever their accountant chose. DE VILLIERS FAMILY OFFICE
 *    LIMITED is not less of a family office for having picked 68320.
 *
 * The SIC filter is therefore removed. That widens *which firms are looked at*
 * and changes nothing about what qualifies: the name test is unchanged, the
 * shell filter is unchanged, and every gate, ownership adjudication and the
 * commercial floor still apply downstream. This fixes a discovery bug that was
 * silently excluding qualifying records.
 *
 * Terms are ordered by how strongly they self-describe, because the tail is
 * weaker: "family holdings" returns many SIC 68209 property vehicles, which may
 * be family property businesses rather than family offices. They are collected
 * last and left for the gates and the floor to judge.
 */

const BASE = 'https://api.company-information.service.gov.uk';

/**
 * Search terms, widened after a qualification review.
 *
 * The first pass used three family-wealth words and reached 546 collected
 * entities, of which only 383 could be evidenced as family offices. Reaching 500
 * with evidence needs a bigger candidate pool, not a looser standard.
 *
 * Every term here names a WEALTH VEHICLE. `family group`, `family estates` and
 * `private office` were measured (178, 69 and 175 active companies) and left
 * out: a family group is usually a trading business and a family estate is
 * usually property, and the previous pass already proved what happens when the
 * pool admits those -- a bakery, a funeral home and a golf club qualified.
 *
 * The name still establishes nothing on its own. Classification requires a
 * statutory control register to name an individual whose surname is in the
 * company name; everything here only decides which firms get looked at.
 */
const TERMS = [
  // unambiguous self-description
  'single family office',
  'multi family office',
  'multi-family office',
  'private family office',
  'family office',
  // recognised UK family-wealth structures
  'family investment',
  'family holdings',
  'family capital',
  'family wealth',
  'family partners',
  'family trust',
  'family trustees',
  'family assets',
  'family ventures',
] as const;

const PAGE = 100;
const MAX_PAGES = Number(process.env.UK_MAX_PAGES ?? 12);

function auth(): Record<string, string> {
  const key = process.env.COMPANIES_HOUSE_API_KEY;
  if (!key) throw new Error('COMPANIES_HOUSE_API_KEY not set');
  return { Authorization: `Basic ${Buffer.from(`${key}:`).toString('base64')}` };
}

interface Hit {
  company_number: string;
  company_name: string;
  company_status: string;
  date_of_creation: string;
  sic_codes?: string[];
}

const root = fileURLToPath(new URL('../../../../', import.meta.url));

/** Everything already known, so the report separates new from re-found. */
const known = new Set<string>();
for (const f of ['data/candidates-uk.json', 'data/candidates-uk-narrow.json', 'data/candidates-uk-expanded.json']) {
  if (!existsSync(root + f)) continue;
  for (const c of (JSON.parse(readFileSync(root + f, 'utf8')).companies as Array<{ companyNumber: string }>)) {
    known.add(c.companyNumber);
  }
}

const t0 = Date.now();
let calls = 0;
const found = new Map<string, Hit & { term: string }>();
const perTerm: Array<{ term: string; hits: number; retrieved: number; fresh: number }> = [];

for (const term of TERMS) {
  let hits = 0;
  let retrieved = 0;
  let freshHere = 0;

  for (let page = 0; page < MAX_PAGES; page++) {
    const url =
      `${BASE}/advanced-search/companies?company_name_includes=${encodeURIComponent(term)}` +
      `&company_status=active&size=${PAGE}&start_index=${page * PAGE}`;
    try {
      const r = await fetchJson<{ hits?: number; items?: Hit[] }>(url, { headers: auth(), retries: 2 });
      calls++;
      hits = r.hits ?? hits;
      const items = r.items ?? [];
      if (!items.length) break;
      retrieved += items.length;
      for (const it of items) {
        if (found.has(it.company_number)) continue;
        found.set(it.company_number, { ...it, term });
        if (!known.has(it.company_number)) freshHere++;
      }
      // Stop once the pages have covered everything the API says exists.
      if ((page + 1) * PAGE >= hits) break;
    } catch {
      break; // a dead page is not a failed run
    }
    await sleep(110);
  }

  perTerm.push({ term, hits, retrieved, fresh: freshHere });
  console.log(`  ${term.padEnd(22)} hits=${String(hits).padStart(4)}  retrieved=${String(retrieved).padStart(4)}  new=${freshHere}`);
}

const all = [...found.values()];
const fresh = all.filter((c) => !known.has(c.company_number));

writeFileSync(root + 'data/candidates-uk-wide.json', JSON.stringify({
  generatedAt: new Date().toISOString(),
  method: 'Companies House advanced-search, explicit family-office terminology, PAGINATED, no SIC filter',
  terms: TERMS,
  note:
    'The SIC filter was removed because it was a guess about which codes family offices use, ' +
    'not an inclusion standard. Measured: "family office" filtered to SIC 64205 returns 11 hits, ' +
    'unfiltered 286. Name selection is unchanged; every gate, the shell filter and the commercial ' +
    'floor still apply downstream. A name establishes nothing on its own.',
  totalUnique: all.length,
  alreadyKnown: all.length - fresh.length,
  newCandidates: fresh.length,
  perTerm,
  companies: fresh.map((c) => ({
    companyNumber: c.company_number,
    name: c.company_name,
    status: c.company_status,
    incorporated: c.date_of_creation,
    sicCodes: c.sic_codes ?? [],
    matchedTerm: c.term,
  })),
}, null, 1));

const secs = (Date.now() - t0) / 1000;
console.log(`\n--- PAGINATED SEARCH RESULT ---`);
console.log(`unique companies returned : ${all.length}`);
console.log(`  already known           : ${all.length - fresh.length}`);
console.log(`  NEW candidates          : ${fresh.length}`);
console.log(`api calls                 : ${calls}`);
console.log(`wall time                 : ${secs.toFixed(0)}s`);
console.log(`written                   : data/candidates-uk-wide.json`);
console.log(`\nNOTE: these are CANDIDATES. None is a record until it passes the shell`);
console.log(`filter, every gate, and the commercial floor.`);
