import 'dotenv/config';
import { establishType } from './enrich/establish-type.js';

// Known-answer cases. Cascade and Bezos Expeditions are documented single-family
// offices; Trian and Iroquois are not family offices. These exist to catch the
// pipeline asserting something false, which is how the source-conflict bug surfaced.
const cases: Array<[string, string, string]> = [
  ['Cascade Investment', 'Kirkland WA', 'single_family_office'],
  ['Bezos Expeditions', 'Seattle WA', 'single_family_office'],
  ['Duquesne Family Office LLC', 'New York NY', 'single_family_office'],
  ['Trian Fund Management', 'New York NY', 'not_a_family_office'],
  ['Iroquois Capital Management', 'Scarsdale NY', 'not_a_family_office'],
  ['Wolfswood Holdings LLC', 'New York NY', 'unknown'],
];

let correct = 0, withheld = 0, wrong = 0;

for (const [name, loc, expected] of cases) {
  const f = await establishType(name, loc);
  const verdict =
    f.type === 'undetermined' ? 'WITHHELD' : f.type === expected ? 'correct' : 'WRONG';
  if (verdict === 'correct') correct++;
  else if (verdict === 'WITHHELD') withheld++;
  else wrong++;

  console.log(`${name}`);
  console.log(`   expected ${expected}  ->  got ${f.type}  [${verdict}]  conf ${f.confidence.toFixed(2)}  tier ${f.sourceTier ?? '-'}`);
  console.log(`   ${f.note.slice(0, 130)}`);
  if (f.quote) console.log(`   quote: "${f.quote.slice(0, 120)}"  <- ${f.sourceUrl.slice(0, 60)}`);
  if (f.claims.length > 1) {
    console.log(`   all claims:`);
    for (const c of f.claims) console.log(`      t${c.tier} ${c.value.padEnd(22)} ${c.sourceUrl.slice(0, 62)}`);
  }
  console.log();
}

console.log(`correct ${correct} | withheld ${withheld} | WRONG ${wrong}`);
