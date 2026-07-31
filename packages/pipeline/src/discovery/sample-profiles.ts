import 'dotenv/config';
import { connect } from '../../../db/src/connect.js';
import { search, serperUsage } from '../lib/serper.js';
import { checkProfileSlug } from '../gates/identity.js';

/**
 * Measured sample of the verified-profile channel.
 *
 * Phase 0 measured this at 20% on the Stage 1 fifty and called it the weakest
 * projection in the table, because it rested on a 50-record sample. It is now
 * the channel that matters most: ADV and Companies House move the 500 and leave
 * the 200 untouched, and this is the only measured route that can move it.
 *
 * The verification is deterministic, not probabilistic (assumption A2): a
 * profile counts only when its URL slug encodes the named person's surname. On
 * the Stage 1 sample that rejected exactly the two wrong-person links the
 * feedback identified -- David Blitzer linked to /in/jonas-cohon, Rodger Riney
 * to /in/bobby-w-sandage-jr-phd-69087211.
 *
 * Writes nothing. Measures and reports.
 */

const sql = connect();
const SAMPLE = Number(process.env.PROFILE_SAMPLE ?? 25);

const rows = (await sql`
  SELECT DISTINCT ON (e.id) e.id, e.canonical_name, p.value_json #>> '{}' AS person
  FROM s2_entity e
  JOIN s2_claim p ON p.entity_id = e.id AND p.field LIKE '%fullName' AND p.status = 'released'
  WHERE e.commercial_state = 'qualifying' AND NOT e.strict_reachable
  ORDER BY e.id`) as unknown as Array<{ id: string; canonical_name: string; person: string }>;

// Spread across sources rather than taking the head of the list: the pool is
// 98 Companies House, 24 ADV, 17 SEC, and sampling only the first would measure
// one source's yield and report it as the channel's.
const bySource = new Map<string, typeof rows>();
for (const r of rows) {
  const k = r.id.startsWith('ent_ch_') ? 'ch' : r.id.startsWith('ent_adv_') ? 'adv' : 'sec';
  if (!bySource.has(k)) bySource.set(k, []);
  bySource.get(k)!.push(r);
}
const picked: typeof rows = [];
let i = 0;
while (picked.length < Math.min(SAMPLE, rows.length)) {
  let added = false;
  for (const list of bySource.values()) {
    if (i < list.length && picked.length < SAMPLE) { picked.push(list[i]!); added = true; }
  }
  if (!added) break;
  i++;
}

const t0 = Date.now();
let searches = 0;
const outcome = { verified: 0, wrongPerson: 0, noProfileFound: 0, noResults: 0 };
const verified: Array<{ firm: string; person: string; url: string }> = [];
const rejected: Array<{ firm: string; person: string; url: string; why: string }> = [];

for (const r of picked) {
  // Unquoted. The quoted-phrase form returned only the firm's own ADV PDF --
  // exact-phrase matching on a name written "SURNAME, FIRST, MIDDLE" matches
  // almost nothing on the open web, which produced a false 0% on the first run.
  const q = `${r.person} ${r.canonical_name} linkedin`;
  let results: Awaited<ReturnType<typeof search>> = [];
  try {
    results = await search(q, { num: 10 });
    searches++;
  } catch {
    outcome.noResults++;
    continue;
  }

  const profiles = results.filter((x) => /linkedin\.com\/in\//i.test(x.link));
  if (!profiles.length) { outcome.noProfileFound++; continue; }

  // First profile whose slug encodes the person. A profile that merely appears
  // in results for the query is not evidence it belongs to them -- that is the
  // exact error Stage 1 shipped twice.
  let hit: { link: string; why: string } | null = null;
  let firstReject: { link: string; why: string } | null = null;
  for (const p of profiles) {
    const v = checkProfileSlug(p.link, r.person);
    if (v.ok) { hit = { link: p.link, why: v.why }; break; }
    if (!firstReject) firstReject = { link: p.link, why: v.why };
  }

  if (hit) {
    outcome.verified++;
    verified.push({ firm: r.canonical_name, person: r.person, url: hit.link });
  } else {
    outcome.wrongPerson++;
    if (firstReject) rejected.push({ firm: r.canonical_name, person: r.person, url: firstReject.link, why: firstReject.why });
  }
}

const secs = (Date.now() - t0) / 1000;
const yieldRate = picked.length ? outcome.verified / picked.length : 0;
const pool = rows.length;

console.log(`\n--- VERIFIED-PROFILE SAMPLE ---`);
console.log(`addressable pool (qualifying, named principal, no strict route) : ${pool}`);
console.log(`sampled                                                        : ${picked.length}`);
console.log(`  verified profile (slug encodes the surname)                  : ${outcome.verified}  (${(yieldRate * 100).toFixed(0)}%)`);
console.log(`  profile found but slug names someone else                    : ${outcome.wrongPerson}`);
console.log(`  no personal profile in results                               : ${outcome.noProfileFound}`);
console.log(`  search failed                                                : ${outcome.noResults}`);
console.log(`\nsearches issued : ${searches}   serper usage: ${JSON.stringify(serperUsage())}`);
console.log(`wall time       : ${secs.toFixed(0)}s  (${picked.length ? (secs / picked.length).toFixed(1) : 0}s per entity)`);
console.log(`\n--- PROJECTION ---`);
console.log(`profile-assisted routes across the pool of ${pool} : ~${Math.round(pool * yieldRate)}`);
console.log(`api calls to run the full pool                    : ~${pool}`);
console.log(`estimated wall time                               : ~${((pool * (picked.length ? secs / picked.length : 0)) / 60).toFixed(0)} min`);
console.log(`\nNOTE: these are PROFILE-ASSISTED only. Strict reachability is unchanged; a`);
console.log(`profile is not a phone or a personal mailbox and never counts as strict.`);

console.log(`\nverified (sample):`);
for (const v of verified.slice(0, 10)) console.log(`  ${v.person} — ${v.firm}\n      ${v.url}`);
console.log(`\nrejected (sample) — the check earning its place:`);
for (const v of rejected.slice(0, 6)) console.log(`  ${v.person} — ${v.firm}\n      ${v.url}\n      ${v.why}`);
