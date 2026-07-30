import { buildSignatoryRoutes } from './sec-signatory.js';
import { shapeDisqualifies } from './reachability.js';

const t0 = Date.now();
const routes = buildSignatoryRoutes();

const individual = routes.filter((r) => r.ownership === 'individual');
const shaped = individual.filter((r) => !shapeDisqualifies({ channel: 'phone', value: r.phone }));

console.log(`unique firm+person routes in the 13F census : ${routes.length}`);
console.log(`  ownership adjudicated to an individual     : ${individual.length}`);
console.log(`  ...surviving shape checks                  : ${shaped.length}`);
console.log();

const byReason = new Map<string, number>();
for (const r of routes.filter((x) => x.ownership !== 'individual')) {
  const k = r.reason.replace(/\d+/g, 'N');
  byReason.set(k, (byReason.get(k) ?? 0) + 1);
}
console.log('excluded, by reason:');
for (const [k, v] of [...byReason].sort((a, b) => b[1] - a[1])) console.log(`  ${String(v).padStart(5)}  ${k}`);

console.log();
console.log('sample of surviving routes:');
for (const r of shaped.slice(0, 6)) {
  console.log(`  ${r.person.slice(0, 26).padEnd(28)}${(r.title || '-').slice(0, 24).padEnd(26)}${r.phone.padEnd(16)}${r.firm.slice(0, 30)}`);
}
console.log();
console.log(`wall time: ${Date.now() - t0}ms, api calls: 0 (local dataset)`);
