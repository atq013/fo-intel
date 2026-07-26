import 'dotenv/config';
import { writeFileSync } from 'node:fs';
import { scoreCandidates } from './discovery/sec-13f.js';
import { searchFullText } from './discovery/sec-fulltext.js';
import { resolveMany } from './enrich/sec-entity.js';
import { discoverFromWeb } from './discovery/web.js';
import { serperUsage } from './lib/serper.js';
import { discoverUk, familyControlCell } from './discovery/companies-house.js';

const command = process.argv[2];

async function discover() {
  const all = scoreCandidates();
  console.log(`scored ${all.length} 13F filers after structural exclusions\n`);

  const strong = all.filter((c) => c.score >= 50);
  const named = strong.filter((c) => /famil/i.test(c.name));
  console.log(`score >= 50:                ${strong.length}`);
  console.log(`  of which named "family":  ${named.length}`);
  console.log(`  found only by structure:  ${strong.length - named.length}`);

  const withPhone = strong.filter((c) => c.signatoryPhone).length;
  console.log(`  with a filed phone number: ${withPhone}\n`);

  console.log('=== top 25 candidates ===');
  for (const c of all.slice(0, 25)) {
    const tel = c.signatoryPhone ? `  tel ${c.signatoryPhone}` : '';
    console.log(
      `${String(c.score).padStart(4)}  ${c.name.slice(0, 42).padEnd(44)}${c.city.slice(0, 14).padEnd(16)}${c.state}${tel}`,
    );
    console.log(`      ${c.reasons.join('; ')}`);
  }
}

async function discoverFullText() {
  console.log('EDGAR full-text search over ownership filings\n');
  const candidates = await searchFullText(Number(process.argv[3] ?? 20));

  const firms = candidates.filter((c) => c.isEntity);
  const people = candidates.filter((c) => !c.isEntity);

  console.log(`\n${candidates.length} distinct parties`);
  console.log(`  firms:        ${firms.length}`);
  console.log(`  individuals:  ${people.length}  (feed wealth-first discovery)\n`);

  // Position in the filing does not reliably say who filed, so resolve every CIK
  // against the SEC's own record and let entity type decide.
  console.log(`resolving ${firms.length} CIKs against the SEC submissions API...`);
  const entities = await resolveMany(
    firms.map((f) => f.cik),
    (done, total) => {
      if (done % 80 === 0 || done >= total) console.log(`  ${done}/${total}`);
    },
  );

  const vehicles = entities.filter((e) => !e.isOperatingCompany);
  const withPhone = vehicles.filter((e) => e.phone.value).length;

  console.log(`\nresolved:           ${entities.length}`);
  console.log(`  operating cos:    ${entities.length - vehicles.length}  (dropped - not investment vehicles)`);
  console.log(`  investment vehicles: ${vehicles.length}`);
  console.log(`  with SEC-filed phone: ${withPhone}\n`);

  const ranked = vehicles.sort((a, b) => (b.signals[0]?.occurredAt ?? '').localeCompare(a.signals[0]?.occurredAt ?? ''));

  console.log('=== investment vehicles, most recent activity first ===');
  for (const e of ranked.slice(0, 20)) {
    const loc = `${e.city}, ${e.region}`;
    console.log(`  ${e.legalName.slice(0, 44).padEnd(46)}${loc.slice(0, 22).padEnd(24)}${e.phone.value ?? '-'}`);
    if (e.signals[0]) console.log(`      latest: ${e.signals[0].occurredAt}  ${e.signals[0].summary.slice(0, 78)}`);
  }

  writeFileSync(
    'data/candidates-sec.json',
    JSON.stringify({ generatedAt: new Date().toISOString(), channel: 'sec_fulltext', entities: ranked }, null, 2),
  );
  console.log(`\nwrote ${ranked.length} candidates to data/candidates-sec.json`);
}

async function discoverWeb() {
  console.log('web discovery: conference programmes, job postings, news\n');
  const { candidates, stats } = await discoverFromWeb(Number(process.argv[3] ?? 6));

  console.log(`\nqueries run:        ${stats.queriesRun}  (serper calls used: ${serperUsage()})`);
  console.log(`pages fetched:      ${stats.pagesFetched}`);
  console.log(`firms extracted:    ${stats.extracted}`);
  console.log(`dropped, quote not found in page: ${stats.quoteFailed}`);
  console.log(`unique candidates:  ${candidates.length}\n`);

  const byChannel = new Map<string, number>();
  for (const c of candidates) byChannel.set(c.channel, (byChannel.get(c.channel) ?? 0) + 1);
  console.log('by channel:');
  for (const [ch, n] of byChannel) console.log(`  ${ch.padEnd(24)} ${n}`);

  console.log('\n=== sample ===');
  for (const c of candidates.slice(0, 25)) {
    console.log(`  ${c.name.slice(0, 44).padEnd(46)}${c.typeClaim.padEnd(24)}${(c.location ?? '').slice(0, 20)}`);
    if (c.principalName) console.log(`      ${c.principalName} - ${c.principalTitle ?? ''}`);
  }

  writeFileSync('data/candidates-web.json', JSON.stringify({ generatedAt: new Date().toISOString(), stats, candidates }, null, 2));
  console.log(`\nwrote ${candidates.length} candidates to data/candidates-web.json`);
}

async function discoverUkCmd() {
  console.log('UK Companies House: SIC-filtered search + officers + PSC\n');
  const companies = await discoverUk();

  const withPsc = companies.filter((c) => c.psc.length > 0);
  const familyControlled = companies.filter((c) => c.sharedSurnames.length > 0);

  const qualifying = familyControlled.filter((c) => c.hasSubstance);

  console.log(`\ncompanies found:                    ${companies.length}`);
  console.log(`  with PSC on record:               ${withPsc.length}`);
  console.log(`  family-surname control confirmed: ${familyControlled.length}`);
  console.log(`  ...and passing the substance test: ${qualifying.length}\n`);

  const rejected = familyControlled.filter((c) => !c.hasSubstance);
  const reasons = new Map<string, number>();
  for (const c of rejected) reasons.set(c.substanceNote, (reasons.get(c.substanceNote) ?? 0) + 1);
  console.log('rejected for lack of substance:');
  for (const [why, n] of [...reasons].sort((a, b) => b[1] - a[1])) console.log(`  ${String(n).padStart(4)}  ${why}`);

  console.log('\n=== qualifying: named family, named entity, filed accounts ===');
  for (const c of qualifying.slice(0, 25)) {
    const cell = familyControlCell(c);
    console.log(`  ${c.name.slice(0, 44).padEnd(46)}${(c.city || c.region).slice(0, 16).padEnd(18)}inc ${c.incorporated.slice(0, 4)}  ${c.substanceNote.slice(0, 40)}`);
    console.log(`      ${cell.evidence[0]?.method.slice(0, 100)}`);
  }

  writeFileSync('data/candidates-uk.json', JSON.stringify({ generatedAt: new Date().toISOString(), companies }, null, 2));
  console.log(`\nwrote ${companies.length} UK companies to data/candidates-uk.json`);
}

switch (command) {
  case 'discover':
    await discover();
    break;
  case 'fulltext':
    await discoverFullText();
    break;
  case 'web':
    await discoverWeb();
    break;
  case 'uk':
    await discoverUkCmd();
    break;
  default:
    console.error(`unknown command: ${command ?? '(none)'}`);
    console.error('usage: tsx packages/pipeline/src/cli.ts <discover|classify|enrich|validate|emit>');
    process.exit(1);
}
