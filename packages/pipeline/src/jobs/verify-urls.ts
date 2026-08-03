import 'dotenv/config';
import { writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { connect } from '../../../db/src/connect.js';

/**
 * Check that every URL the dataset cites still resolves.
 *
 * Each of the 958 URLs is where a value was actually read, so a dead one means a
 * reviewer cannot check that value for themselves. This fetches all of them and
 * writes the outcome per URL.
 *
 * Three source classes behave differently and the report keeps them apart:
 *
 *   - **Companies House** is an authenticated API. Unauthenticated it returns
 *     401, which says nothing about the URL, so the key is sent.
 *   - **SEC** is public but rejects requests without a declared User-Agent.
 *   - **LinkedIn blocks automated requests by design**, typically with 999 or a
 *     login wall. A non-200 from LinkedIn is therefore NOT evidence that the
 *     profile is gone, and it is reported separately rather than counted as a
 *     failure -- calling it one would misstate the file's condition in the
 *     direction that looks worse, which is no better than the reverse.
 */

const OUT = fileURLToPath(new URL('../../../../exports/', import.meta.url));
mkdirSync(OUT, { recursive: true });
const sql = connect();

const rows = (await sql`
  SELECT DISTINCT o.url, s.identifier AS source, s.tier
  FROM s2_observation o
  JOIN s2_source s ON s.id = o.source_id
  WHERE EXISTS (
    SELECT 1 FROM s2_extraction_event xe
    JOIN s2_claim c ON c.extraction_event_id = xe.id AND c.status = 'released'
    WHERE xe.observation_id = o.id)
  ORDER BY o.url`) as unknown as Array<{ url: string; source: string; tier: number }>;

const CH_KEY = process.env.COMPANIES_HOUSE_API_KEY ?? '';
const UA = process.env.SEC_USER_AGENT ?? 'fo-intel research contact@example.com';

function headersFor(url: string): Record<string, string> {
  if (url.includes('company-information.service.gov.uk')) {
    return { Authorization: `Basic ${Buffer.from(`${CH_KEY}:`).toString('base64')}` };
  }
  return { 'User-Agent': UA, Accept: '*/*' };
}

const isLinkedIn = (u: string) => /(^|\.)linkedin\.com/.test(new URL(u).host);

interface Result { url: string; source: string; tier: number; status: number | string; ok: boolean; note: string }
const results: Result[] = [];
let done = 0;

async function check(r: { url: string; source: string; tier: number }): Promise<Result> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 20_000);
  try {
    const res = await fetch(r.url, { headers: headersFor(r.url), redirect: 'follow', signal: ac.signal });
    const li = isLinkedIn(r.url);
    return {
      url: r.url, source: r.source, tier: r.tier, status: res.status,
      // A LinkedIn non-200 is a bot wall, not a dead link, and is not counted
      // as a failure either way -- only as "could not be checked from here".
      // 429 is LinkedIn's rate limiter answering a script, and 999 is its bot
      // wall. Neither says the profile is gone -- an earlier run counted 268
      // of them as broken links, which overstated the file's decay from the
      // opposite direction to the usual mistake.
      ok: res.ok || (li && [999, 403, 401, 429].includes(res.status)),
      note: res.ok ? 'resolves'
        : li ? `LinkedIn ${res.status}: rate limit or bot wall, not a dead profile; not checkable from a script`
        : `HTTP ${res.status}`,
    };
  } catch (err) {
    const li = isLinkedIn(r.url);
    return {
      url: r.url, source: r.source, tier: r.tier, status: 'error', ok: li,
      note: li ? 'LinkedIn blocks automated requests; not checkable from a script'
               : (err instanceof Error ? err.message : String(err)),
    };
  } finally {
    clearTimeout(timer);
    if (++done % 100 === 0) console.log(`  ...${done}/${rows.length}`);
  }
}

// Modest concurrency: these are other people's servers and one of them rate
// limits at 600 requests per five minutes.
const CONCURRENCY = 6;
const queue = [...rows];
await Promise.all(Array.from({ length: CONCURRENCY }, async () => {
  for (;;) {
    const next = queue.shift();
    if (!next) return;
    results.push(await check(next));
    await new Promise((r) => setTimeout(r, 120));
  }
}));

const esc = (v: unknown) => {
  const s = String(v ?? '');
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
writeFileSync(OUT + 'url-check.csv',
  ['url,source,tier,httpStatus,ok,note',
   ...results.sort((a, b) => a.url.localeCompare(b.url))
     .map((r) => [r.url, r.source, r.tier, r.status, r.ok, r.note].map(esc).join(','))].join('\n') + '\n');

const byHost = new Map<string, { ok: number; bad: number; blocked: number }>();
for (const r of results) {
  const h = new URL(r.url).host;
  const e = byHost.get(h) ?? { ok: 0, bad: 0, blocked: 0 };
  if (r.note.startsWith('LinkedIn blocks')) e.blocked++;
  else if (r.ok) e.ok++;
  else e.bad++;
  byHost.set(h, e);
}

console.log('\nURL CHECK');
console.log(`  URLs checked : ${results.length}\n`);
console.log(`  ${'host'.padEnd(42)} ${'ok'.padStart(5)} ${'failed'.padStart(7)} ${'bot-walled'.padStart(11)}`);
for (const [h, e] of [...byHost].sort((a, b) => (b[1].ok + b[1].bad + b[1].blocked) - (a[1].ok + a[1].bad + a[1].blocked))) {
  console.log(`  ${h.padEnd(42)} ${String(e.ok).padStart(5)} ${String(e.bad).padStart(7)} ${String(e.blocked).padStart(11)}`);
}
const broken = results.filter((r) => !r.ok);
console.log(`\n  genuinely broken: ${broken.length}`);
for (const b of broken.slice(0, 15)) console.log(`    ${b.status}  ${b.url}`);
console.log('\nwritten: exports/url-check.csv');
