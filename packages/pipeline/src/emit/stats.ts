/**
 * Prints the delivered file's figures. The submission quotes counts, and a count
 * that has drifted from the artifact it describes is exactly the kind of claim
 * that fails inspection - so they are generated, never typed by hand.
 */
import { readFileSync } from 'node:fs';
import type { FamilyOffice } from '@fo/core';

const records = JSON.parse(readFileSync('data/fo-dataset.json', 'utf8')) as FamilyOffice[];
const has = (fn: (r: FamilyOffice) => unknown) => records.filter((r) => Boolean(fn(r))).length;

const channels = new Map<string, number>();
for (const r of records) {
  const c = r.discoveries[0]?.channel ?? 'unknown';
  channels.set(c, (channels.get(c) ?? 0) + 1);
}

const countries = new Map<string, number>();
for (const r of records) {
  const c = r.country.value ?? 'not established';
  countries.set(c, (countries.get(c) ?? 0) + 1);
}

console.log(`delivered records            ${records.length}`);
console.log(`  single-family offices      ${has((r) => r.classification.type === 'single_family_office')}`);
console.log(`  multi-family offices       ${has((r) => r.classification.type === 'multi_family_office')}`);
console.log(`  named principal            ${has((r) => r.principals[0]?.fullName.value)}`);
console.log(`  two or more principals     ${records.filter((r) => r.principals.filter((p) => p.fullName.value).length >= 2).length}`);
console.log(`  statutory control basis    ${has((r) => r.principals[0]?.controlBasis?.value)}`);
console.log(`  registered street address  ${has((r) => r.street.value)}`);
console.log(`  dated activity signals     ${has((r) => r.signals.length > 0)}`);
console.log(`  direct phone number        ${has((r) => r.principals[0]?.phone.value)}`);
console.log(`  verified email             ${has((r) => r.principals[0]?.email.value)}`);
console.log(`  confirmed website          ${has((r) => r.website.value)}`);

console.log('\nprimary discovery channel:');
for (const [c, n] of [...channels].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${String(n).padStart(4)}  ${String(Math.round((n / records.length) * 100)).padStart(3)}%  ${c}`);
}

console.log('\ncountry:');
for (const [c, n] of [...countries].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${String(n).padStart(4)}  ${c}`);
}
