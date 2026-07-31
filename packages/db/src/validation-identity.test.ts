import 'dotenv/config';
import assert from 'node:assert/strict';
import { test, after } from 'node:test';

import { connect } from './connect.js';
import { contractWriter } from './contract-writer.js';

/**
 * Regression for the scheduled `contract` failure.
 *
 * The verdict id was `vr_<claimId>_<gate>` — no policy version — so re-judging a
 * claim under a new standard collided with the verdict recorded under the old
 * one and the whole run died on a primary-key violation. The `ON CONFLICT`
 * clause named a different constraint from the primary key, so it could never
 * have caught it.
 *
 * What must hold now: two policy versions produce two rows, and the earlier one
 * is preserved. That history is the audit trail showing a claim was quarantined
 * under one standard and re-admitted under the next.
 */

const sql = connect();
const db = contractWriter(process.env.DATABASE_URL!);
const P = 'vridtest';

async function cleanup() {
  await sql`DELETE FROM s2_validation_result WHERE claim_id = ${P + '-claim'}`;
  await sql`DELETE FROM s2_evidence WHERE claim_id = ${P + '-claim'}`;
  await sql`DELETE FROM s2_claim WHERE id = ${P + '-claim'}`;
  await sql`DELETE FROM s2_extraction_event WHERE id = ${P + '-ev'}`;
  await sql`DELETE FROM s2_observation WHERE id = ${P + '-obs'}`;
  await sql`DELETE FROM s2_entity WHERE id = ${P + '-ent'}`;
  await sql`DELETE FROM s2_source WHERE id = ${P + '-src'}`;
}

after(cleanup);

test('validation identity · the same claim and gate coexist under two policy versions', async () => {
  await cleanup();
  await sql`INSERT INTO s2_source (id, kind, identifier, tier) VALUES (${P + '-src'}, 'sec_13f', ${P}, 1)`;
  await sql`INSERT INTO s2_observation (id, source_id, url, content_hash)
            VALUES (${P + '-obs'}, ${P + '-src'}, 'https://example.test/vr', 'h')`;
  await sql`INSERT INTO s2_entity (id, canonical_name) VALUES (${P + '-ent'}, 'VR Identity Test')`;
  await sql`INSERT INTO s2_extraction_event (id, observation_id, extractor)
            VALUES (${P + '-ev'}, ${P + '-obs'}, 'test')`;
  await sql`INSERT INTO s2_claim (id, entity_id, extraction_event_id, field, value_json, value_type)
            VALUES (${P + '-claim'}, ${P + '-ent'}, ${P + '-ev'}, 'region', '"OR"'::jsonb, 'string')`;

  // Judged under the old standard: quarantined.
  await db.recordGateResults(P + '-claim', null, [
    { gate: 'attribution', outcome: 'failed', band: 'A', detail: 'content coverage 0% below 60%' },
  ], '2025-07-30.1');

  // Re-judged under the new standard: passes. This is the exact call that
  // brought down the scheduled run.
  await db.recordGateResults(P + '-claim', null, [
    { gate: 'attribution', outcome: 'passed', band: 'A', detail: 'span contains the value' },
  ], '2025-07-31.1');

  const rows = (await sql`
    SELECT policy_version, outcome, detail FROM s2_validation_result
    WHERE claim_id = ${P + '-claim'} AND gate = 'attribution'
    ORDER BY policy_version`) as unknown as Array<Record<string, string>>;

  assert.equal(rows.length, 2, 'both verdicts must be stored');
  assert.equal(rows[0]!.policy_version, '2025-07-30.1');
  assert.equal(rows[0]!.outcome, 'failed', 'the earlier verdict must not be overwritten');
  assert.equal(rows[1]!.policy_version, '2025-07-31.1');
  assert.equal(rows[1]!.outcome, 'passed');
});

test('validation identity · re-running the same policy version is idempotent', async () => {
  // Repeating a policy must update in place rather than accumulate duplicates,
  // otherwise a resumed run would double every verdict it re-evaluated.
  await db.recordGateResults(P + '-claim', null, [
    { gate: 'attribution', outcome: 'passed', band: 'A', detail: 'second pass, same policy' },
  ], '2025-07-31.1');

  const rows = (await sql`
    SELECT detail FROM s2_validation_result
    WHERE claim_id = ${P + '-claim'} AND gate = 'attribution'
      AND policy_version = '2025-07-31.1'`) as unknown as Array<{ detail: string }>;

  assert.equal(rows.length, 1, 'same policy must upsert, not duplicate');
  assert.equal(rows[0]!.detail, 'second pass, same policy');
});

test('validation identity · the id carries the policy version', async () => {
  const rows = (await sql`
    SELECT id FROM s2_validation_result
    WHERE claim_id = ${P + '-claim'} AND gate = 'attribution'
    ORDER BY policy_version`) as unknown as Array<{ id: string }>;
  assert.match(rows[0]!.id, /2025-07-30\.1$/);
  assert.match(rows[1]!.id, /2025-07-31\.1$/);
  assert.notEqual(rows[0]!.id, rows[1]!.id);
});
