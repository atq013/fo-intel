/**
 * Adversarial check on the M1 contract.
 *
 * The Stage 1 defect was a value shipped wearing evidence from a different fact.
 * M1 claims that is now unexpressible. A claim like that is worth nothing until
 * the database has actually refused the write, so this attempts the mis-wiring
 * directly and fails loudly if Postgres lets it through.
 *
 * Run: npx tsx packages/db/src/verify-ptc10.ts
 */
import { connect, withRetry } from './connect.js';

const sql = connect();
const P = 'ptc10test';

type Check = { name: string; expect: 'accept' | 'reject'; got: string; pass: boolean };
const checks: Check[] = [];

async function attempt(name: string, expect: 'accept' | 'reject', run: () => Promise<unknown>) {
  let got: string;
  try {
    // Retry only the transport. A constraint violation is the answer we came
    // for and must never be retried away.
    await withRetry(run, 4, name);
    got = 'accepted';
  } catch (err) {
    got = err instanceof Error ? (err.message.split('\n')[0] ?? err.message) : String(err);
  }
  const accepted = got === 'accepted';
  checks.push({ name, expect, got, pass: accepted === (expect === 'accept') });
}

async function cleanup() {
  // children first; evidence cascades from claim but events/observations do not
  await withRetry(async () => {
    await sql`DELETE FROM s2_evidence WHERE id LIKE ${P + '%'}`;
    await sql`DELETE FROM s2_claim WHERE id LIKE ${P + '%'}`;
    await sql`DELETE FROM s2_extraction_event WHERE id LIKE ${P + '%'}`;
    await sql`DELETE FROM s2_observation WHERE id LIKE ${P + '%'}`;
    await sql`DELETE FROM s2_entity WHERE id LIKE ${P + '%'}`;
    await sql`DELETE FROM s2_source WHERE id LIKE ${P + '%'}`;
  }, 4, 'cleanup');
}

/** Setup writes are transport-only too; a blip here is not a contract result. */
const setup = <T>(fn: () => Promise<T>) => withRetry(fn, 4, 'setup');

async function main() {
  await cleanup();

  // Two observations of two different documents, read in two separate events.
  // Event A established the claim. Event B is the "other fact" whose evidence
  // Stage 1 would have copied across.
  await setup(() => sql`INSERT INTO s2_source (id, kind, identifier, tier)
            VALUES (${P + '-src'}, 'companies_house', ${P}, 1)`);
  await setup(() => sql`INSERT INTO s2_observation (id, source_id, url, content_hash)
            VALUES (${P + '-obs-a'}, ${P + '-src'}, 'https://example.test/a', 'hash-a'),
                   (${P + '-obs-b'}, ${P + '-src'}, 'https://example.test/b', 'hash-b')`);
  await setup(() => sql`INSERT INTO s2_entity (id, canonical_name) VALUES (${P + '-ent'}, 'PTC-10 Test Ltd')`);
  await setup(() => sql`INSERT INTO s2_extraction_event (id, observation_id, extractor)
            VALUES (${P + '-ev-a'}, ${P + '-obs-a'}, 'verify'),
                   (${P + '-ev-b'}, ${P + '-obs-b'}, 'verify')`);
  await setup(() => sql`INSERT INTO s2_claim (id, entity_id, extraction_event_id, field, value_json, value_type)
            VALUES (${P + '-claim'}, ${P + '-ent'}, ${P + '-ev-a'},
                    'registered_address', ${JSON.stringify('1 Test Street')}::jsonb, 'address')`);

  // 1. THE STAGE 1 DEFECT ITSELF. Establishing evidence for a claim made in
  //    event A, carrying event B's reading. This is build-dataset.ts:144.
  await attempt('establishing evidence from a foreign extraction event', 'reject', () =>
    sql`INSERT INTO s2_evidence (id, claim_id, observation_id, extraction_event_id, role, span_text, method)
        VALUES (${P + '-e1'}, ${P + '-claim'}, ${P + '-obs-b'}, ${P + '-ev-b'},
                'establishing', 'unrelated quote from document B', 'copied at assembly time')`,
  );

  // 2. The correct write must still be easy.
  await attempt('establishing evidence from the claim\'s own event', 'accept', () =>
    sql`INSERT INTO s2_evidence (id, claim_id, observation_id, extraction_event_id, role, span_text, method)
        VALUES (${P + '-e2'}, ${P + '-claim'}, ${P + '-obs-a'}, ${P + '-ev-a'},
                'establishing', 'Registered office: 1 Test Street', 'read from the filing')`,
  );

  // 3. One establishing row per claim, so a second cannot quietly replace the first.
  await attempt('a second establishing row on the same claim', 'reject', () =>
    sql`INSERT INTO s2_evidence (id, claim_id, observation_id, extraction_event_id, role, span_text, method)
        VALUES (${P + '-e3'}, ${P + '-claim'}, ${P + '-obs-a'}, ${P + '-ev-a'},
                'establishing', 'duplicate', 'read from the filing')`,
  );

  // 4. Corroboration from a later, different event must remain free — a second
  //    source agreeing next week is the normal case, not a violation.
  await attempt('corroborating evidence from a different event', 'accept', () =>
    sql`INSERT INTO s2_evidence (id, claim_id, observation_id, extraction_event_id, role, span_text, method)
        VALUES (${P + '-e4'}, ${P + '-claim'}, ${P + '-obs-b'}, ${P + '-ev-b'},
                'corroborating', 'Address given as 1 Test Street', 'independent confirmation')`,
  );

  // 5. So must conflicting evidence — recording disagreement is the point.
  await attempt('conflicting evidence from a different event', 'accept', () =>
    sql`INSERT INTO s2_evidence (id, claim_id, observation_id, extraction_event_id, role, span_text, method)
        VALUES (${P + '-e5'}, ${P + '-claim'}, ${P + '-obs-b'}, ${P + '-ev-b'},
                'conflicting', 'Address given as 2 Other Road', 'independent source disagrees')`,
  );

  // 6. A claim cannot be released with no basis at all. Not a DB constraint --
  //    the release gate owns this -- so it is asserted here as a query, to be
  //    explicit that the schema alone does not cover it.
  const orphans = await setup(() => sql`
    SELECT c.id FROM s2_claim c
    WHERE NOT EXISTS (SELECT 1 FROM s2_evidence e WHERE e.claim_id = c.id AND e.role = 'establishing')`);
  checks.push({
    name: 'no claim lacks establishing evidence (gate-enforced, not schema-enforced)',
    expect: 'accept',
    got: orphans.length === 0 ? 'accepted' : `${orphans.length} orphan claim(s)`,
    pass: orphans.length === 0,
  });

  await cleanup();

  let failed = 0;
  for (const c of checks) {
    if (!c.pass) failed++;
    const mark = c.pass ? 'ok  ' : 'FAIL';
    const detail = c.got === 'accepted' ? 'accepted' : `rejected: ${c.got.slice(0, 78)}`;
    console.log(`  ${mark}  [expect ${c.expect}] ${c.name}\n          ${detail}`);
  }
  console.log(failed === 0 ? '\nPTC-10 holds at the database level.' : `\n${failed} check(s) failed.`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch(async (err) => {
  await cleanup().catch(() => {});
  console.error(err);
  process.exit(1);
});
