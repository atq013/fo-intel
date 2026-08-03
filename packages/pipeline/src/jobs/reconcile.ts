import 'dotenv/config';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { connect } from '../../../db/src/connect.js';
import { contractStats } from '../../../db/src/stage2-reads.js';

/**
 * One set of numbers, checked against every surface that reports them.
 *
 * The operations page once showed 68 strict and 369 profile-assisted against a
 * file holding 67 and 368, because its query counted rows the export excluded.
 * Nothing catches that except comparing the surfaces to each other, which is
 * what this does: database, export JSON, export CSV, and the live product.
 */

const root = fileURLToPath(new URL('../../../../', import.meta.url));
const sql = connect();

const [db] = (await sql`
  SELECT count(*)::int entities,
         count(*) FILTER (WHERE commercial_state='qualifying')::int qualifying,
         count(*) FILTER (WHERE commercial_state='unassessed')::int unassessed,
         count(*) FILTER (WHERE commercial_state='qualifying' AND strict_reachable)::int strict,
         count(*) FILTER (WHERE commercial_state='qualifying' AND profile_assisted_reachable)::int profile,
         count(*) FILTER (WHERE commercial_state='qualifying' AND postal_reachable)::int postal,
         count(*) FILTER (WHERE commercial_state='qualifying'
           AND (strict_reachable OR profile_assisted_reachable OR postal_reachable))::int anyRoute
  FROM s2_entity WHERE merged_into_id IS NULL`) as unknown as Array<Record<string, number>>;

const j = JSON.parse(readFileSync(root + 'exports/records.json', 'utf8'));
const csvRows = readFileSync(root + 'exports/records.csv', 'utf8').trim().split('\n').slice(1);
const stats = await contractStats();

const surfaces: Record<string, Record<string, number>> = {
  database: db as never,
  'exports/records.json': {
    entities: j.counts.qualifying + j.counts.notQualifying,
    qualifying: j.counts.qualifying,
    unassessed: 0,
    strict: j.counts.reachable.strict,
    profile: j.counts.reachable.profileAssisted,
    postal: j.counts.reachable.postal,
    anyRoute: j.counts.reachable.anyRoute,
  },
  'exports/records.csv': { qualifying: csvRows.length },
  'live product (contractStats)': {
    entities: stats.entities,
    qualifying: stats.qualifying,
    strict: stats.strictReachable,
    profile: stats.profileAssistedReachable,
    postal: stats.postalReachable,
  },
};

const keys = ['entities', 'qualifying', 'unassessed', 'strict', 'profile', 'postal', 'anyRoute'];
console.log(`${'surface'.padEnd(32)}${keys.map((k) => k.padStart(11)).join('')}`);
for (const [name, v] of Object.entries(surfaces)) {
  console.log(name.padEnd(32) + keys.map((k) => String(v[k] ?? '-').padStart(11)).join(''));
}

let mismatches = 0;
for (const k of keys) {
  const vals = Object.entries(surfaces)
    .filter(([, v]) => v[k] !== undefined)
    .map(([n, v]) => [n, v[k]] as const);
  const distinct = new Set(vals.map(([, v]) => v));
  if (distinct.size > 1) {
    mismatches++;
    console.log(`\nMISMATCH on ${k}: ${vals.map(([n, v]) => `${n}=${v}`).join(', ')}`);
  }
}
console.log(mismatches === 0
  ? '\nAll surfaces agree.'
  : `\n${mismatches} metric(s) disagree across surfaces.`);
process.exit(mismatches === 0 ? 0 : 1);
