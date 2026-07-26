import 'dotenv/config';
import { writeFileSync } from 'node:fs';
import { scoreCandidates } from './discovery/sec-13f.js';
import { searchFullText } from './discovery/sec-fulltext.js';
import { resolveMany } from './enrich/sec-entity.js';

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

switch (command) {
  case 'discover':
    await discover();
    break;
  case 'fulltext':
    await discoverFullText();
    break;
  default:
    console.error(`unknown command: ${command ?? '(none)'}`);
    console.error('usage: tsx packages/pipeline/src/cli.ts <discover|classify|enrich|validate|emit>');
    process.exit(1);
}
