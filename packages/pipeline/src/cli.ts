import 'dotenv/config';
import { scoreCandidates } from './discovery/sec-13f.js';

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

switch (command) {
  case 'discover':
    await discover();
    break;
  default:
    console.error(`unknown command: ${command ?? '(none)'}`);
    console.error('usage: tsx packages/pipeline/src/cli.ts <discover|classify|enrich|validate|emit>');
    process.exit(1);
}
