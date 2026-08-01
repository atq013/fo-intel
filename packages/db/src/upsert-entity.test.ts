import assert from 'node:assert/strict';
import { test } from 'node:test';
import 'dotenv/config';

import { connect } from './connect.js';
import { contractWriter } from './contract-writer.js';
import type { Entity } from '@fo/core/contract/index.js';

/**
 * An upsert must not undo an assessment.
 *
 * Every caller passes `unassessed`/`false`/`false` because nothing is known at
 * upsert time. Writing those on the conflict path reset qualifying, reachable
 * records to unassessed and unreachable -- and the caller returns early when an
 * extraction yields no assertions, so nothing put them back.
 */

const ID = 'ent_test_upsert_preserves_assessment';

const seed = (): Entity => ({
  id: ID, canonicalName: 'UPSERT TEST LTD', entityType: 'unconfirmed',
  firstSeenAt: new Date(), trustState: 'active', commercialState: 'unassessed',
  strictReachable: false, profileAssistedReachable: false,
});

test('upsertEntity · a re-touch does not undo the assessment', async () => {
  const sql = connect();
  const db = contractWriter(process.env.DATABASE_URL ?? '');
  try {
    await db.upsertEntity(seed());
    // What the assessor and the contact adjudicator write once claims exist.
    await sql`UPDATE s2_entity SET commercial_state='qualifying', strict_reachable=true,
                profile_assisted_reachable=true, postal_reachable=true WHERE id=${ID}`;

    // A second reading of the same firm: identity may have been tidied, and the
    // caller again supplies the placeholders it has no better value for.
    await db.upsertEntity({ ...seed(), canonicalName: 'UPSERT TEST LIMITED' });

    const [row] = (await sql`SELECT canonical_name, commercial_state, strict_reachable,
        profile_assisted_reachable, postal_reachable FROM s2_entity WHERE id=${ID}`) as unknown as
      Array<Record<string, unknown>>;
    assert.ok(row, 'the row must still exist');

    assert.equal(row.canonical_name, 'UPSERT TEST LIMITED', 'identity still updates');
    assert.equal(row.commercial_state, 'qualifying', 'assessment must survive the upsert');
    assert.equal(row.strict_reachable, true);
    assert.equal(row.profile_assisted_reachable, true);
    assert.equal(row.postal_reachable, true);
  } finally {
    await sql`DELETE FROM s2_entity WHERE id=${ID}`;
  }
});
