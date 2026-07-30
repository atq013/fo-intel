import { readFileSync } from 'node:fs';
import { buildSignatoryRoutes } from './sec-signatory.js';
import { shapeDisqualifies, readPool } from './reachability.js';

const norm = (s: string) =>
  s.toLowerCase().replace(/&/g, ' and ')
   .replace(/\b(llc|l\.l\.c\.|lp|l\.p\.|inc|incorporated|corp|corporation|co|company|ltd|limited|plc|trust)\b/g, ' ')
   .replace(/[^a-z0-9]/g, '');

const routes = buildSignatoryRoutes()
  .filter((r) => r.ownership === 'individual')
  .filter((r) => !shapeDisqualifies({ channel: 'phone', value: r.phone }));

const byFirm = new Map<string, typeof routes[number]>();
for (const r of routes) if (!byFirm.has(norm(r.firm))) byFirm.set(norm(r.firm), r);

// Cohort A: firms Stage 1 confirmed are family offices (the ground truth we have)
const delivered = JSON.parse(readFileSync('data/fo-dataset.json', 'utf8')) as Array<{ legalName: string }>;
// Cohort B: SEC-resolved investment vehicles — the realistic feed for the climb
const secPool = readPool<{ legalName: string }>('data/candidates-sec.json', 'entities');

for (const [label, pool] of [['delivered 50 (confirmed family offices)', delivered],
                             ['SEC investment vehicles (climb feed)', secPool]] as const) {
  const hits = pool.filter((p) => byFirm.has(norm(p.legalName)));
  console.log(`${label}`);
  console.log(`  firms: ${pool.length}   with an individual-owned signatory route: ${hits.length}  (${Math.round(100*hits.length/pool.length)}%)`);
  for (const h of hits.slice(0, 4)) {
    const r = byFirm.get(norm(h.legalName))!;
    console.log(`     ${r.person.slice(0,24).padEnd(26)}${(r.title||'-').slice(0,26).padEnd(28)}${r.phone}`);
  }
  console.log();
}

// what kind of people are these? decision-maker vs back-office
const DECISION = /\b(chief investment|cio\b|managing (partner|member|director)|principal|founder|president|chairman|owner|trustee|portfolio manager|ceo|chief executive)\b/i;
const BACKOFFICE = /\b(compliance|counsel|administrator|operations|accounting|controller|secretary|analyst)\b/i;
let d=0,b=0,o=0;
for (const r of routes) {
  if (DECISION.test(r.title)) d++; else if (BACKOFFICE.test(r.title)) b++; else o++;
}
console.log('title mix across all surviving routes:');
console.log(`  decision-maker  ${d} (${Math.round(100*d/routes.length)}%)`);
console.log(`  back office     ${b} (${Math.round(100*b/routes.length)}%)`);
console.log(`  other/blank     ${o} (${Math.round(100*o/routes.length)}%)`);
