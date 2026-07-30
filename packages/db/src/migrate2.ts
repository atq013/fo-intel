import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { connect, withRetry } from './connect.js';

const sql = connect();

// fileURLToPath, not .pathname: the repo lives under a directory with a space
// in its name and .pathname leaves it percent-encoded.
const dir = fileURLToPath(new URL('./migrations/', import.meta.url));
const files = readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();

/**
 * Split on semicolons that actually terminate a statement.
 *
 * A plain .split(';') shreds any DO $$ ... $$ block into fragments that each
 * fail on their own -- and 003 needs one, because ALTER TABLE ADD CONSTRAINT has
 * no IF NOT EXISTS and migrations re-run. So track dollar-quoted bodies and
 * ordinary string literals, and only break outside both.
 */
function splitStatements(sqlText: string): string[] {
  const out: string[] = [];
  let buf = '';
  let i = 0;
  let tag: string | null = null; // open dollar-quote tag, e.g. "$$" or "$fn$"
  let inString = false;

  while (i < sqlText.length) {
    const ch = sqlText[i];

    if (tag) {
      if (sqlText.startsWith(tag, i)) {
        buf += tag;
        i += tag.length;
        tag = null;
        continue;
      }
    } else if (inString) {
      if (ch === "'") inString = false;
    } else if (ch === "'") {
      inString = true;
    } else if (ch === '$') {
      const m = /^\$[A-Za-z_]*\$/.exec(sqlText.slice(i));
      if (m) {
        tag = m[0];
        buf += tag;
        i += tag.length;
        continue;
      }
    } else if (ch === ';') {
      if (buf.trim()) out.push(buf.trim());
      buf = '';
      i++;
      continue;
    }

    buf += ch;
    i++;
  }
  if (buf.trim()) out.push(buf.trim());
  return out;
}

for (const file of files) {
  const ddl = readFileSync(dir + file, 'utf8');
  // strip comment lines before splitting: splitting first and discarding
  // anything starting with "--" silently drops every statement with a comment
  // above it, which is most of them. (Learned this the hard way in Stage 1.)
  const body = ddl
    .split('\n')
    .filter((l) => !l.trim().startsWith('--'))
    .join('\n');
  const statements = splitStatements(body);

  console.log(`\n${file}  (${statements.length} statements)`);
  let failed = 0;
  for (const stmt of statements) {
    const label = stmt.replace(/\s+/g, ' ').slice(0, 66);
    // A transient fault on statement 1 cascades into every dependent statement,
    // so a DNS blip would otherwise read as a schema error.
    try {
      await withRetry(() => sql.query(stmt), 4, label);
      console.log(`  ok    ${label}`);
    } catch (err) {
      failed++;
      console.log(`  FAIL  ${label}\n        ${err instanceof Error ? err.message : err}`);
    }
  }
  if (failed) console.log(`  ${failed} statement(s) failed`);
}

const [c] = (await sql`
  SELECT COUNT(*)::int AS n FROM information_schema.tables
  WHERE table_schema='public' AND table_name LIKE 's2_%'
`) as unknown as Array<{ n: number }>;
console.log(`\ns2_* tables present: ${c?.n ?? 0}`);
