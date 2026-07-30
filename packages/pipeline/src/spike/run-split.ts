import { readFileSync } from 'node:fs';
import { buildSignatoryRoutes } from './sec-signatory.js';
import { shapeDisqualifies } from './reachability.js';

const norm = (s: string) => s.toLowerCase().replace(/&/g,' and ')
  .replace(/\b(llc|l\.l\.c\.|lp|l\.p\.|inc|incorporated|corp|corporation|co|company|ltd|limited|plc|trust)\b/g,' ')
  .replace(/[^a-z0-9]/g,'');

const routes = buildSignatoryRoutes()
  .filter(r => r.ownership === 'individual')
  .filter(r => !shapeDisqualifies({ channel:'phone', value:r.phone }));
const byFirm = new Set(routes.map(r => norm(r.firm)));

const recs = JSON.parse(readFileSync('data/fo-dataset.json','utf8')) as any[];
const groups = new Map<string, any[]>();
for (const r of recs) {
  const ch = r.discoveries?.[0]?.channel ?? 'unknown';
  const k = ch.startsWith('sec') ? 'SEC-derived' : ch === 'companies_house' ? 'UK registry' : 'web-derived';
  if (!groups.has(k)) groups.set(k, []);
  groups.get(k)!.push(r);
}

console.log('route coverage in the delivered 50, split by where the firm was found:');
for (const [k, g] of groups) {
  const hit = g.filter(r => byFirm.has(norm(r.legalName)));
  console.log(`  ${k.padEnd(14)} ${String(g.length).padStart(3)} firms   ${String(hit.length).padStart(2)} with a route   ${String(Math.round(100*hit.length/g.length)).padStart(3)}%`);
}

// How many family offices can the 13F census plausibly contain at all?
// Proxy: filers whose own name states it, which understates but is a floor.
const named = routes.filter(r => /famil(y|ies)/i.test(r.firm));
console.log();
console.log(`13F filers with an individual-owned route whose NAME says "family": ${named.length}`);
console.log('  (a floor, not a ceiling: Cascade, Bezos Expeditions etc. do not say it)');
for (const r of named.slice(0,5)) console.log(`     ${r.firm.slice(0,40).padEnd(42)}${r.person.slice(0,22).padEnd(24)}${r.title.slice(0,22)}`);
