import 'dotenv/config';
import { connect } from '../../../db/src/connect.js';
import { search, fetchPageText, serperUsage } from '../lib/serper.js';

/**
 * Time-boxed high-precision web-discovery spike.
 *
 * Question: can official firm websites supply enough defensible, net-new
 * family-office records to close the 218/500 gap?
 *
 * The rule that shapes the whole design: **search results and directories
 * discover candidates, they never qualify them.** A firm appearing in a
 * "top 50 family offices" listicle establishes nothing. Qualification requires
 * the firm's own site to say what it is, and to name a person.
 *
 * Writes nothing. Measures and reports.
 */

const sql = connect();

/** Exact terminology. Nothing that would admit a wealth manager or an IFA. */
const PHRASES = [
  '"single family office"',
  '"multi-family office"',
  '"private family office"',
  '"family office"',
];

/** Spread the queries so one city or one listicle cannot dominate the sample. */
const QUALIFIERS = [
  'about us', 'our team', 'leadership', 'founder', 'managing partner',
  'London', 'New York', 'Zurich', 'Singapore', 'Dubai', 'Geneva', 'Hong Kong',
  'established', 'we manage', 'the family',
];

/**
 * Directories, aggregators and social platforms. Useful to FIND a firm, never
 * to establish one: the brief is explicit that a source may surface a candidate
 * without being strong enough to establish its identity or classification.
 */
const DIRECTORY = new RegExp(
  '(linkedin|crunchbase|bloomberg|zoominfo|dnb\\.com|opencorporates|companieshouse|find-and-update|' +
  'wikipedia|facebook|twitter|x\\.com|instagram|youtube|reddit|medium|substack|' +
  'familyofficehub|familyofficelist|fintrx|preqin|pitchbook|privateequity|wealthbriefing|' +
  'citywire|forbes|reuters|ft\\.com|wsj|bloomberglaw|prnewswire|businesswire|globenewswire|' +
  'indeed|glassdoor|zippia|rocketreach|apollo\\.io|signalhire|lusha|clearbit|' +
  'yelp|yellowpages|bizapedia|manta|buzzfile|corporationwiki|sec\\.gov|gov\\.uk)',
  'i',
);

/** Explicit self-description. "wealth management" alone is not this. */
const FO_WORDING = /\b(single[- ]family office|multi[- ]family office|private family office|family office)\b/i;

/** Present on an adviser or asset manager, absent on a true single family office. */
const NOT_A_FAMILY_OFFICE = /\b(financial (adviser|advisor)|IFA\b|retail clients?|mortgage|insurance broker|find an adviser|book a consultation|our clients include|prospective clients)\b/i;

/** A person named as leadership, not a generic "contact us". */
const PRINCIPAL = /\b((?:Founder|Co-?Founder|Managing Partner|Managing Director|Chief Executive|CEO|Chairman|Chairwoman|Principal|Partner|President|Director)\b[^.\n]{0,40}?)\b([A-Z][a-z]+(?:\s+[A-Z][a-z'’-]+){1,2})\b|\b([A-Z][a-z]+(?:\s+[A-Z][a-z'’-]+){1,2})\b[^.\n]{0,20}?\b(?:Founder|Co-?Founder|Managing Partner|Managing Director|Chief Executive|CEO|Chairman|Principal|Partner|President)\b/;

const LOCATION = /\b(London|New York|Zurich|Geneva|Singapore|Dubai|Hong Kong|Chicago|Boston|Miami|Los Angeles|San Francisco|Toronto|Sydney|Monaco|Luxembourg|Amsterdam|Madrid|Milan|Paris|Frankfurt|Munich|Stockholm|Oslo|Copenhagen|Dublin|Edinburgh|Manchester|Houston|Dallas|Atlanta|Denver|Seattle|Vancouver|Melbourne|Mumbai|Tokyo|Riyadh|Abu Dhabi|Doha|Cayman|Jersey|Guernsey)\b/i;

const norm = (s: string) =>
  s.toUpperCase().replace(/[.,]/g, ' ')
    .replace(/\b(L\s?L\s?C|L\s?P|LLP|INC|CORP|CORPORATION|COMPANY|CO|LTD|LIMITED|TRUST|THE|GMBH|AG|SA|BV|NV|PLC)\b/g, ' ')
    .replace(/[^A-Z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();

const existing = (await sql`SELECT canonical_name FROM s2_entity`) as unknown as Array<{ canonical_name: string }>;
const haveNames = new Set(existing.map((e) => norm(e.canonical_name)));

const MAX_QUERIES = Number(process.env.WEB_QUERIES ?? 40);
const MAX_FETCH = Number(process.env.WEB_FETCH ?? 45);

const t0 = Date.now();
const seenDomains = new Set<string>();
const candidates: Array<{ domain: string; url: string; title: string }> = [];
let queries = 0;
let directoryHits = 0;

outer:
for (const q of QUALIFIERS) {
  for (const p of PHRASES) {
    if (queries >= MAX_QUERIES) break outer;
    let res: Awaited<ReturnType<typeof search>> = [];
    try { res = await search(`${p} ${q}`, { num: 10 }); queries++; } catch { continue; }
    for (const r of res) {
      let domain: string;
      try { domain = new URL(r.link).hostname.replace(/^www\./, ''); } catch { continue; }
      if (DIRECTORY.test(r.link)) { directoryHits++; continue; }
      if (seenDomains.has(domain)) continue;
      seenDomains.add(domain);
      candidates.push({ domain, url: r.link, title: r.title });
    }
  }
}

console.log(`queries issued          : ${queries}`);
console.log(`unique candidate domains: ${candidates.length}`);
console.log(`directory results skipped (discovery only, cannot qualify): ${directoryHits}`);

// ---- first-party verification -------------------------------------------
const reject = { noFetch: 0, noFoWording: 0, looksLikeAdviser: 0, noPrincipal: 0, noLocation: 0, duplicate: 0 };
const qualified: Array<{ domain: string; url: string; name: string; person: string; location: string }> = [];
const rejectedSamples: Array<{ domain: string; why: string }> = [];

for (const c of candidates.slice(0, MAX_FETCH)) {
  let text = '';
  try { text = await fetchPageText(c.url, 20_000); } catch { /* absent, not retried */ }
  if (!text || text.length < 400) { reject.noFetch++; continue; }

  if (!FO_WORDING.test(text)) {
    reject.noFoWording++;
    if (rejectedSamples.length < 8) rejectedSamples.push({ domain: c.domain, why: 'no explicit family-office wording on the page' });
    continue;
  }
  if (NOT_A_FAMILY_OFFICE.test(text)) {
    reject.looksLikeAdviser++;
    if (rejectedSamples.length < 8) rejectedSamples.push({ domain: c.domain, why: 'reads as an adviser or retail wealth practice' });
    continue;
  }

  const loc = LOCATION.exec(text);
  if (!loc) { reject.noLocation++; continue; }

  const pm = PRINCIPAL.exec(text);
  const person = (pm?.[2] ?? pm?.[3] ?? '').trim();
  if (!person) {
    reject.noPrincipal++;
    if (rejectedSamples.length < 8) rejectedSamples.push({ domain: c.domain, why: 'no named principal, founder or director on the page' });
    continue;
  }

  // Operating name from the page title, stripped of taglines.
  const name = c.title.split(/[|–—·]/)[0]!.trim().slice(0, 70);
  if (haveNames.has(norm(name))) { reject.duplicate++; continue; }

  qualified.push({ domain: c.domain, url: c.url, name, person, location: loc[1]! });
}

const fetched = Math.min(candidates.length, MAX_FETCH);
const secs = (Date.now() - t0) / 1000;
const precision = fetched ? qualified.length / fetched : 0;

console.log(`\n--- FIRST-PARTY VERIFICATION (${fetched} sites fetched) ---`);
console.log(`  QUALIFIED (name + FO wording + location + named principal) : ${qualified.length}  (${(precision * 100).toFixed(0)}%)`);
console.log(`  rejected: page unreachable        : ${reject.noFetch}`);
console.log(`  rejected: no family-office wording: ${reject.noFoWording}`);
console.log(`  rejected: adviser / retail wealth : ${reject.looksLikeAdviser}`);
console.log(`  rejected: no named principal      : ${reject.noPrincipal}`);
console.log(`  rejected: no location             : ${reject.noLocation}`);
console.log(`  duplicate of an existing entity   : ${reject.duplicate}`);

console.log(`\nsearch API calls : ${queries}   serper total this run: ${JSON.stringify(serperUsage())}`);
console.log(`page fetches     : ${fetched}`);
console.log(`runtime          : ${secs.toFixed(0)}s  (${fetched ? (secs / fetched).toFixed(1) : 0}s per candidate)`);

const byCountry = new Map<string, number>();
for (const q of qualified) byCountry.set(q.location, (byCountry.get(q.location) ?? 0) + 1);
console.log(`\ngeographic breakdown of qualified: ${[...byCountry].map(([k, v]) => `${k}=${v}`).join(', ') || 'none'}`);

const tld = new Map<string, number>();
for (const q of qualified) {
  const t = q.domain.split('.').slice(-1)[0]!;
  tld.set(t, (tld.get(t) ?? 0) + 1);
}
console.log(`source breakdown by TLD          : ${[...tld].map(([k, v]) => `.${k}=${v}`).join(', ') || 'none'}`);

console.log(`\n--- PROJECTION ---`);
console.log(`Every qualified record carries a named principal but NO contact route:`);
console.log(`  strict reachable yield          : 0 (a website is not a phone or a personal mailbox)`);
console.log(`  postal reachable yield          : 0 (no adjudicated per-person address)`);
console.log(`  profile-assisted yield          : ~${Math.round(qualified.length * 0.67)} of ${qualified.length} at the measured 67% profile rate`);

console.log(`\nqualified sample:`);
for (const q of qualified.slice(0, 14)) console.log(`  ${q.name}\n      ${q.domain} · ${q.location} · principal: ${q.person}`);
console.log(`\nrejected sample:`);
for (const r of rejectedSamples) console.log(`  ${r.domain} — ${r.why}`);
