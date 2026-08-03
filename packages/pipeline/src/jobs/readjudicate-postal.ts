import 'dotenv/config';
import { withRun } from '../run/runner.js';
import { connect } from '../../../db/src/connect.js';
import { sameBuilding } from '../collect/uk-director-address.js';

/**
 * Re-adjudicate postal routes under the corrected registered-office test.
 *
 * The rule used to compare the service address to the registered office as
 * strings. The same building filed two ways passed it, and an audit of all 276
 * routes found 132 in that shape: the company's own premises counted as a
 * personal route. The rule now compares buildings -- postcode plus an agreeing
 * street word -- and this applies that to the routes already stored.
 *
 * A route that fails now has `counts_postal` cleared. **The route itself is
 * kept, not deleted.** It is a real address that a real director filed, and
 * erasing it would hide the correction; what changes is whether it counts toward
 * reachability. The reason is written to the decision log so the drop from 207
 * to whatever this leaves is explainable from the record rather than from memory.
 *
 * Entity-level `postal_reachable` is then recomputed from the surviving routes,
 * because a flag that disagrees with the rows underneath it is worse than either.
 */

const sql = connect();

interface Row {
  id: string;
  entity_id: string;
  value: string;
  office: string | null;
}

const routes = (await sql`
  SELECT c.id, c.entity_id, c.value,
         (SELECT string_agg(x.value_json #>> '{}', '|' ORDER BY
                   CASE x.field WHEN 'street' THEN 1 WHEN 'city' THEN 2
                                WHEN 'postcode' THEN 3 ELSE 4 END)
            FROM s2_claim x
           WHERE x.entity_id = c.entity_id AND x.status = 'released'
             AND x.field IN ('street','city','postcode')) AS office
  FROM s2_contact c
  WHERE c.channel = 'postal' AND c.status = 'released' AND c.counts_postal
  ORDER BY c.entity_id`) as unknown as Row[];

await withRun('contract', 'manual', async (run) => {
  await run.log('info', 'readjudicate_scope', {
    routes: routes.length,
    rule: 'registered office compared by building (postcode + street), not by string',
  });

  let cleared = 0;
  const touched = new Set<string>();

  for (const r of routes) {
    if (!r.office || !sameBuilding(r.value, r.office)) continue;

    await sql`UPDATE s2_contact SET counts_postal = FALSE, updated_at = now() WHERE id = ${r.id}`;
    cleared++;
    touched.add(r.entity_id);

    await run.decision('classify', {
      entityId: r.entity_id,
      rule: 'postal_route_is_registered_office',
      before: { countsPostal: true },
      after: { countsPostal: false },
      reason:
        `service address "${r.value}" is the same building as the registered office ` +
        `"${r.office}", so it is the company's address rather than a route to the individual`,
    });
  }

  // Recompute the entity flag from what actually survives.
  const affected = [...touched];
  for (const entityId of affected) {
    const rows = (await sql`
      SELECT bool_or(counts_postal) AS postal FROM s2_contact
      WHERE entity_id = ${entityId} AND status = 'released'`) as unknown as
      Array<{ postal: boolean | null }>;
    await sql`UPDATE s2_entity SET postal_reachable = ${rows[0]?.postal ?? false}, updated_at = now()
              WHERE id = ${entityId}`;
  }

  await run.log('info', 'readjudicate_finished', {
    routesCleared: cleared,
    entitiesRecomputed: affected.length,
  });
  console.log(`routes examined     : ${routes.length}`);
  console.log(`routes cleared      : ${cleared}`);
  console.log(`entities recomputed : ${affected.length}`);
});
