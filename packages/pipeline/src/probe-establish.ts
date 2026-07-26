import 'dotenv/config';
import { establishType } from './enrich/establish-type.js';

// A deliberately mixed set: two known SFOs, two known non-family firms, and two
// structural candidates whose type is genuinely unknown to us.
const cases: Array<[string, string]> = [
  ['Duquesne Family Office LLC', 'New York NY'],
  ['Cascade Investment', 'Kirkland WA'],
  ['Trian Fund Management', 'New York NY'],
  ['Iroquois Capital Management', 'Scarsdale NY'],
  ['1922 Trust', 'Houston TX'],
  ['Wolfswood Holdings LLC', 'New York NY'],
];

for (const [name, loc] of cases) {
  const f = await establishType(name, loc);
  console.log(`${name}`);
  console.log(`   -> ${f.type}  (quote verified: ${f.quoteVerified}, own site: ${f.sourceIsOwnSite})`);
  if (f.quote) console.log(`   quote: "${f.quote.slice(0, 130)}"`);
  console.log(`   src:   ${f.sourceUrl.slice(0, 90)}`);
  if (!f.quoteVerified) console.log(`   note:  ${f.reasoning.slice(0, 120)}`);
  console.log();
}
