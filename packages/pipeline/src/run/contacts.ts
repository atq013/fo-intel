import { randomUUID } from 'node:crypto';
import { connect } from '../../../db/src/connect.js';
import type { Claim, Evidence, GateResult } from '@fo/core/contract/index.js';
import type { ContactChannel } from '@fo/core/contract/index.js';

const sql = connect();

/**
 * Promote released contact claims into `s2_contact`, and recompute the two
 * reachability metrics for the entity.
 *
 * A contact row is not a copy of a claim. It is the answer to a different and
 * harder question: does this route demonstrably reach the named individual? So
 * it is created only when the `contact_ownership` gate actually **passed** --
 * not when it was skipped, and not when the value merely looks personal.
 *
 * ADR-11 is enforced here rather than trusted:
 *
 *   strict            — a route that reaches the individual, profiles excluded
 *   profile-assisted  — the same, plus verified personal profiles under A1
 *
 * The two are stored separately and never summed into one figure, because the
 * count swings from roughly 60 to roughly 160 on whether a reviewer accepts A1,
 * and a single blended number would hide exactly the judgement most worth
 * auditing.
 */

const CHANNEL_OF: Record<string, ContactChannel> = {
  phone: 'phone',
  email: 'email',
  profile_url: 'linkedin',
  postal: 'postal',
};

export async function syncContacts(
  entityId: string,
  released: Claim[],
  evidenceByClaim: Map<string, Evidence>,
  gateResultsByClaim: Map<string, GateResult[]>,
): Promise<{ created: number; strict: boolean; profileAssisted: boolean; postal: boolean }> {
  let created = 0;

  // A route is personal only if this entity also has a released person name.
  // Without one there is no "named individual" for the route to reach, and the
  // brief's bar is unmeetable by definition.
  const hasPerson = released.some((c) => c.field.endsWith('fullName') && c.valueType === 'person_name');

  for (const claim of released) {
    const channel = CHANNEL_OF[claim.valueType];
    if (!channel) continue;

    const results = gateResultsByClaim.get(claim.id) ?? [];
    const ownership = results.find((r) => r.gate === 'contact_ownership');
    const identity = results.find((r) => r.gate === 'identity');

    // PTC-2 in its most consequential form. A skipped ownership check must never
    // produce a route that counts toward the 200 -- that number is the one the
    // brief is testing, and inflating it with unchecked rows would be the exact
    // failure Stage 1 was corrected for.
    const ownershipProven = ownership?.outcome === 'passed';
    const evidence = evidenceByClaim.get(claim.id);

    const reaches = ownershipProven && hasPerson && evidence ? 'individual' : 'unknown';
    const counts = reaches === 'individual';

    // A profile can only ever be profile-assisted; the database refuses
    // counts_strict on a linkedin row, and this mirrors that rule in code so the
    // intent is legible rather than only enforced.
    // Three metrics, three separate booleans, and each channel can only ever
    // satisfy the one it actually is. ADR-11 and ADR-12: they are never summed
    // into a single headline, because the count swings on judgements a reviewer
    // may not share.
    const countsStrict = counts && channel !== 'linkedin' && channel !== 'postal';
    const countsProfileAssisted = counts && channel !== 'postal' &&
      (channel !== 'linkedin' || identity?.outcome === 'passed');
    const countsPostal = counts && channel === 'postal';

    await sql`
      INSERT INTO s2_contact (id, entity_id, person_claim_id, channel, value, reaches,
                              ownership_evidence_id, verification_method, verified_at, status,
                              counts_strict, counts_profile_assisted, counts_postal)
      VALUES (${`ct_${randomUUID()}`}, ${entityId},
              ${released.find((c) => c.field.endsWith('fullName'))?.id ?? null},
              ${channel}, ${String(claim.value)}, ${reaches},
              ${counts ? evidence!.id : null},
              ${ownership?.detail ?? null}, ${counts ? new Date() : null},
              ${'released'}, ${countsStrict}, ${countsProfileAssisted}, ${countsPostal})
      ON CONFLICT (entity_id, channel, value) DO UPDATE SET
        reaches = EXCLUDED.reaches,
        ownership_evidence_id = EXCLUDED.ownership_evidence_id,
        verification_method = EXCLUDED.verification_method,
        counts_strict = EXCLUDED.counts_strict,
        counts_profile_assisted = EXCLUDED.counts_profile_assisted,
        counts_postal = EXCLUDED.counts_postal,
        updated_at = now()`;
    created++;
  }

  // Recomputed from the contact rows rather than accumulated, so a demotion
  // lowers the metric instead of leaving a stale true behind.
  const rows = (await sql`
    SELECT bool_or(counts_strict) AS strict, bool_or(counts_profile_assisted) AS assisted,
           bool_or(counts_postal) AS postal
    FROM s2_contact WHERE entity_id = ${entityId} AND status = 'released'`) as unknown as
    Array<{ strict: boolean | null; assisted: boolean | null; postal: boolean | null }>;

  const strict = rows[0]?.strict ?? false;
  const profileAssisted = rows[0]?.assisted ?? false;
  const postal = rows[0]?.postal ?? false;

  await sql`
    UPDATE s2_entity SET strict_reachable = ${strict},
                         profile_assisted_reachable = ${profileAssisted},
                         postal_reachable = ${postal},
                         updated_at = now()
    WHERE id = ${entityId}`;

  return { created, strict, profileAssisted, postal };
}
