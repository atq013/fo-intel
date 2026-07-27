import 'dotenv/config';
import { readFileSync } from 'node:fs';
import { neon } from '@neondatabase/serverless';

const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL not set');
const sql = neon(url);

const ddl = readFileSync(new URL('./schema.sql', import.meta.url), 'utf8');

// Strip comment lines before splitting. Splitting first and then discarding
// anything starting with "--" silently drops every statement that has a comment
// above it, which is most of them.
const statements = ddl
  .split('\n')
  .filter((line) => !line.trim().startsWith('--'))
  .join('\n')
  .split(';')
  .map((s) => s.trim())
  .filter(Boolean);

let failed = 0;
for (const stmt of statements) {
  const label = stmt.replace(/\s+/g, ' ').slice(0, 70);
  try {
    await sql.query(stmt);
    console.log(`ok    ${label}`);
  } catch (err) {
    failed++;
    console.log(`FAIL  ${label}\n      ${err instanceof Error ? err.message : err}`);
  }
}

const [counts] = (await sql`
  SELECT (SELECT COUNT(*) FROM firms)::int AS firms,
         (SELECT COUNT(*) FROM firm_chunks)::int AS chunks
`) as unknown as Array<{ firms: number; chunks: number }>;
console.log(`\n${statements.length - failed}/${statements.length} statements applied`);
console.log(`firms: ${counts?.firms ?? 0}  chunks: ${counts?.chunks ?? 0}`);
