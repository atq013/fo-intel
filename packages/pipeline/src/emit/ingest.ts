/**
 * Loads the built dataset into Postgres and embeds it for retrieval.
 *
 * What gets embedded is a design decision, not a formality. Only the parts a
 * user would search on become chunks - what the firm is, where it is, who runs
 * it, what it recently did. Validation notes, audit reasons and internal
 * confidence text are deliberately excluded: embedding them lets a semantic
 * match on an audit note surface a firm whose customer-facing cells are empty,
 * which is the retrieval equivalent of showing someone your workings instead of
 * your answer.
 */
import 'dotenv/config';
import { neon } from '@neondatabase/serverless';
import type { FamilyOffice } from '@fo/core';
import { buildDataset } from './build-dataset.js';
import { embed } from '../lib/llm.js';

const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL not set');
const sql = neon(url);

interface Chunk {
  id: string;
  firmId: string;
  kind: string;
  fieldPath: string;
  content: string;
}

function chunksFor(r: FamilyOffice): Chunk[] {
  const out: Chunk[] = [];
  const p = r.principals[0];
  const location = [r.city.value, r.region.value, r.country.value].filter(Boolean).join(', ');

  const typeLabel =
    r.classification.type === 'single_family_office'
      ? 'a single-family office'
      : r.classification.type === 'multi_family_office'
        ? 'a multi-family office'
        : r.classification.type;

  const profile = [
    `${r.legalName} is ${typeLabel}${location ? ` based in ${location}` : ''}.`,
    p?.fullName.value ? `Its named principal is ${p.fullName.value}${p.title.value ? `, ${p.title.value}` : ''}.` : '',
    r.website.value ? `Website: ${r.website.value}.` : '',
    r.street.value ? `Registered address: ${[r.street.value, r.city.value, r.postcode.value].filter(Boolean).join(', ')}.` : '',
    p?.phone.value ? `A direct phone number is on record.` : '',
    p?.email.value ? `A verified email address is on record.` : '',
    r.classification.evidence[0] ? `Classification basis: ${r.classification.evidence[0].method}` : '',
  ]
    .filter(Boolean)
    .join(' ');

  out.push({ id: `${r.id}:profile`, firmId: r.id, kind: 'profile', fieldPath: 'classification', content: profile });

  r.signals.slice(0, 6).forEach((s, i) => {
    out.push({
      id: `${r.id}:signal:${i}`,
      firmId: r.id,
      kind: 'signal',
      fieldPath: `signals[${i}]`,
      content: `On ${s.occurredAt}, ${s.summary}`,
    });
  });

  return out;
}

const { records, rejected, stats } = buildDataset();
console.log(`building index for ${records.length} records`);

await sql`TRUNCATE firm_chunks, firms RESTART IDENTITY CASCADE`;

for (const r of records) {
  const p = r.principals[0];
  await sql`
    INSERT INTO firms (id, legal_name, firm_type, type_confidence, country, city, region,
                       has_phone, has_email, has_principal, signal_count, latest_signal_on, channel_count, record)
    VALUES (${r.id}, ${r.legalName}, ${r.classification.type}, ${r.classification.confidence},
            ${r.country.value}, ${r.city.value}, ${r.region.value},
            ${Boolean(p?.phone.value)}, ${Boolean(p?.email.value)}, ${Boolean(p?.fullName.value)},
            ${r.signals.length}, ${r.signals[0]?.occurredAt ?? null}, ${r.discoveries.length},
            ${JSON.stringify(r)}::jsonb)
  `;
}
console.log(`  inserted ${records.length} firms`);

const allChunks = records.flatMap(chunksFor);
console.log(`  embedding ${allChunks.length} chunks...`);

let embedded = 0;
for (const chunk of allChunks) {
  let vector: number[] | null = null;
  try {
    vector = await embed(chunk.content);
  } catch (err) {
    console.log(`    embed failed for ${chunk.id}: ${err instanceof Error ? err.message.slice(0, 80) : err}`);
  }

  await sql`
    INSERT INTO firm_chunks (id, firm_id, kind, field_path, content, embedding)
    VALUES (${chunk.id}, ${chunk.firmId}, ${chunk.kind}, ${chunk.fieldPath}, ${chunk.content},
            ${vector ? `[${vector.join(',')}]` : null}::vector)
  `;
  if (vector) embedded++;
  if (embedded % 25 === 0 && vector) console.log(`    ${embedded}/${allChunks.length}`);
}

for (const rej of rejected) {
  await sql`
    INSERT INTO rejected_values (firm_name, field_path, rejected_value, reason, detected_by)
    VALUES (${rej.firmName}, ${rej.fieldPath}, ${rej.value}, ${rej.reason}, ${rej.detectedBy})
  `;
}

const [counts] = (await sql`
  SELECT (SELECT COUNT(*) FROM firms)::int AS firms,
         (SELECT COUNT(*) FROM firm_chunks WHERE embedding IS NOT NULL)::int AS chunks,
         (SELECT COUNT(*) FROM rejected_values)::int AS rejected
`) as unknown as Array<{ firms: number; chunks: number; rejected: number }>;

console.log(`\nindexed: ${counts?.firms} firms, ${counts?.chunks} embedded chunks, ${counts?.rejected} audit rows`);
console.log(`dataset stats: ${JSON.stringify(stats)}`);
