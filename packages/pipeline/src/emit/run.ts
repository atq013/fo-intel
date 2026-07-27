import 'dotenv/config';
import { writeFileSync } from 'node:fs';
import { buildDataset } from './build-dataset.js';
import { selectFinal } from './select-final.js';
import { toCsv } from './to-csv.js';

const { records: qualifying, rejected, stats } = buildDataset();
const { selected: records, deferred, channelMix } = selectFinal(qualifying, 50);

console.log('dataset build');
for (const [k, v] of Object.entries(stats)) console.log(`  ${k.padEnd(24)} ${v}`);
console.log(`  qualifying pool          ${qualifying.length}`);
console.log(`  delivered                ${records.length}`);
console.log(`  held back                ${deferred.length}`);

console.log('\nchannel mix in the delivered file:');
const total = records.length;
for (const [c, n] of Object.entries(channelMix).sort((a, b) => b[1] - a[1])) {
  console.log(`  ${String(n).padStart(4)}  ${String(Math.round((n / total) * 100)).padStart(3)}%  ${c}`);
}

const byCountry = new Map<string, number>();
for (const r of records) byCountry.set(r.country.value ?? 'unknown', (byCountry.get(r.country.value ?? 'unknown') ?? 0) + 1);
console.log('\ncountries:');
for (const [c, n] of [...byCountry].sort((a, b) => b[1] - a[1])) console.log(`  ${String(n).padStart(4)}  ${c}`);


writeFileSync('data/fo-dataset.csv', toCsv(records));
writeFileSync('data/fo-dataset.json', JSON.stringify(records, null, 2));
writeFileSync('data/audit-rejected.json', JSON.stringify(rejected, null, 2));
writeFileSync(
  'data/held-back.json',
  JSON.stringify(deferred.map((d) => ({ firm: d.record.legalName, reason: d.reason })), null, 2),
);

console.log(`\nwrote data/fo-dataset.csv (${records.length} records)`);
console.log(`wrote data/audit-rejected.json (${rejected.length} rejected values)`);
console.log(`wrote data/held-back.json (${deferred.length} qualifying records not delivered)`);
