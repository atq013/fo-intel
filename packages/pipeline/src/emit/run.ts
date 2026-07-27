import 'dotenv/config';
import { writeFileSync } from 'node:fs';
import { buildDataset } from './build-dataset.js';
import { toCsv } from './to-csv.js';

const { records, rejected, stats } = buildDataset();

console.log('dataset build');
for (const [k, v] of Object.entries(stats)) console.log(`  ${k.padEnd(24)} ${v}`);

const byCountry = new Map<string, number>();
for (const r of records) byCountry.set(r.country.value ?? 'unknown', (byCountry.get(r.country.value ?? 'unknown') ?? 0) + 1);
console.log('\ncountries:');
for (const [c, n] of [...byCountry].sort((a, b) => b[1] - a[1])) console.log(`  ${String(n).padStart(4)}  ${c}`);

const byChannel = new Map<string, number>();
for (const r of records) for (const c of new Set(r.discoveries.map((d) => d.channel))) byChannel.set(c, (byChannel.get(c) ?? 0) + 1);
console.log('\ndiscovery channel distribution:');
for (const [c, n] of [...byChannel].sort((a, b) => b[1] - a[1])) console.log(`  ${String(n).padStart(4)}  ${c}`);

writeFileSync('data/fo-dataset.csv', toCsv(records));
writeFileSync('data/fo-dataset.json', JSON.stringify(records, null, 2));
writeFileSync('data/audit-rejected.json', JSON.stringify(rejected, null, 2));

console.log(`\nwrote data/fo-dataset.csv (${records.length} records)`);
console.log(`wrote data/audit-rejected.json (${rejected.length} rejected values)`);
