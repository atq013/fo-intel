import 'dotenv/config';
import { writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { connect } from '../../../db/src/connect.js';

/**
 * Two read-only audits, for a reviewer who wants to check the file rather than
 * take its counts on trust.
 *
 * **Nothing here writes.** No classification, release state or reachability flag
 * is changed by running this. It reads what is held and reports it, including
 * the parts that look weak -- an audit that quietly corrected what it found
 * would destroy the thing it was asked to measure.
 *
 * ### 1 · Source-level audit of every qualifying record
 *
 * Per record: which source it came from, whether the classification is present
 * and what evidence stands behind it, the named person and where that name was
 * read, and -- for the exclusion question -- whether the name looks like a bank,
 * adviser, law firm or other service provider rather than a family office.
 *
 * That last column is the one worth reading. The concern is not hypothetical:
 * Stage 1 shipped twenty records that were family-CONTROLLED but not family
 * offices, and the classification rule was rewritten because of it.
 *
 * ### 2 · Postal-route audit of every postal route
 *
 * A statutory service address is the weakest of the three reachability metrics
 * and ADR-12 says so out loud. This lists every one with its named person, the
 * full address, how many OTHER entities in the file share that address, and
 * whether the address equals the company's own registered office -- which is the
 * strongest single signal that it is not a personal route.
 */

const OUT = fileURLToPath(new URL('../../../../exports/', import.meta.url));
mkdirSync(OUT, { recursive: true });
const sql = connect();

const esc = (v: unknown) => {
  const s = v === null || v === undefined ? '' : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
const csv = (header: string[], rows: unknown[][]) =>
  [header.join(','), ...rows.map((r) => r.map(esc).join(','))].join('\n') + '\n';

/**
 * Names that suggest a regulated intermediary or professional firm rather than a
 * family office. Flagged for human review, never acted on automatically.
 */
const SERVICE_PROVIDER =
  /\b(bank|banking|insurance|insurer|assurance|broker|brokerage|securities|solicitor|law|legal|llp\b|accountant|accounting|audit|advisor[sy]?|adviser[sy]?|consultanc|consulting|wealth manage|asset manage|fund manage|investment manage|pension|university|college|charit|foundation|trustee services|corporate services|nominee|registrar|secretarial)\b/i;

// ---------------------------------------------------------------- audit 1
const recs = (await sql`
  SELECT e.id, e.canonical_name, e.commercial_state, e.entity_type,
         e.strict_reachable, e.profile_assisted_reachable, e.postal_reachable,
         (SELECT string_agg(DISTINCT s.identifier, ' | ')
            FROM s2_claim c
            JOIN s2_evidence ev ON ev.claim_id = c.id AND ev.role = 'establishing'
            JOIN s2_observation o ON o.id = ev.observation_id
            JOIN s2_source s ON s.id = o.source_id
           WHERE c.entity_id = e.id AND c.status = 'released')            AS sources,
         (SELECT min(s.tier)
            FROM s2_claim c
            JOIN s2_evidence ev ON ev.claim_id = c.id AND ev.role = 'establishing'
            JOIN s2_observation o ON o.id = ev.observation_id
            JOIN s2_source s ON s.id = o.source_id
           WHERE c.entity_id = e.id AND c.status = 'released')            AS best_tier,
         (SELECT max(s.tier)
            FROM s2_claim c
            JOIN s2_evidence ev ON ev.claim_id = c.id AND ev.role = 'establishing'
            JOIN s2_observation o ON o.id = ev.observation_id
            JOIN s2_source s ON s.id = o.source_id
           WHERE c.entity_id = e.id AND c.status = 'released')            AS worst_tier,
         (SELECT c.value_json #>> '{}' FROM s2_claim c
           WHERE c.entity_id = e.id AND c.field = 'entityClassification'
             AND c.status = 'released' LIMIT 1)                            AS classification,
         (SELECT ev.span_text FROM s2_claim c
            JOIN s2_evidence ev ON ev.claim_id = c.id AND ev.role = 'establishing'
           WHERE c.entity_id = e.id AND c.field = 'entityClassification'
             AND c.status = 'released' LIMIT 1)                            AS classification_evidence,
         (SELECT c.value_json #>> '{}' FROM s2_claim c
           WHERE c.entity_id = e.id AND c.field LIKE '%fullName'
             AND c.status = 'released' ORDER BY c.field LIMIT 1)           AS named_person,
         (SELECT ev.span_text FROM s2_claim c
            JOIN s2_evidence ev ON ev.claim_id = c.id AND ev.role = 'establishing'
           WHERE c.entity_id = e.id AND c.field LIKE '%fullName'
             AND c.status = 'released' ORDER BY c.field LIMIT 1)           AS named_person_evidence,
         (SELECT count(*)::int FROM s2_claim c
           WHERE c.entity_id = e.id AND c.status = 'released')             AS released_values,
         (SELECT count(*)::int FROM s2_claim c
           WHERE c.entity_id = e.id AND c.status = 'quarantined')          AS quarantined_values,
         (SELECT min(o.fetched_at) FROM s2_claim c
            JOIN s2_extraction_event xe ON xe.id = c.extraction_event_id
            JOIN s2_observation o ON o.id = xe.observation_id
           WHERE c.entity_id = e.id)                                       AS first_observed,
         e.first_seen_at, e.updated_at
  FROM s2_entity e
  WHERE e.merged_into_id IS NULL
  ORDER BY e.commercial_state, e.id`) as unknown as Array<Record<string, any>>;

/** Duplicate detection on the normalised legal name, across the whole file. */
const norm = (n: string) =>
  n.toLowerCase().replace(/[^a-z0-9 ]/g, ' ')
   .replace(/\b(limited|ltd|llp|llc|inc|plc|company|co|the)\b/g, ' ')
   .replace(/\s+/g, ' ').trim();
const nameGroups = new Map<string, string[]>();
for (const r of recs) {
  const k = norm(r.canonical_name);
  if (!nameGroups.has(k)) nameGroups.set(k, []);
  nameGroups.get(k)!.push(r.id);
}

const auditRows = recs.map((r) => {
  const dupes = nameGroups.get(norm(r.canonical_name)) ?? [];
  return [
    r.id, r.canonical_name, r.commercial_state,
    r.commercial_state === 'qualifying' ? '' : 'below the commercial floor — see quarantined_values',
    r.sources ?? '', r.best_tier ?? '', r.worst_tier ?? '',
    r.classification ?? '(none)',
    r.classification ? 'derivation rule family_surname_control, re-run by gate 2' : 'no PSC individual whose surname matches the company name',
    r.classification_evidence ?? '',
    r.named_person ?? '', r.named_person_evidence ?? '',
    r.released_values, r.quarantined_values,
    r.strict_reachable, r.profile_assisted_reachable, r.postal_reachable,
    dupes.length > 1 ? `SHARES NORMALISED NAME WITH: ${dupes.filter((x) => x !== r.id).join(' ')}` : 'unique',
    SERVICE_PROVIDER.test(r.canonical_name) ? 'REVIEW — name suggests a service provider' : '',
    r.first_observed, r.updated_at,
  ];
});

writeFileSync(OUT + 'audit-source-level.csv', csv([
  'entityId', 'name', 'commercialState', 'exclusionReason',
  'sources', 'bestSourceTier', 'worstSourceTier',
  'classification', 'classificationBasis', 'classificationEvidence',
  'namedPerson', 'namedPersonEvidence',
  'releasedValues', 'quarantinedValues',
  'strictReachable', 'profileAssistedReachable', 'postalReachable',
  'deduplication', 'serviceProviderFlag',
  'firstObserved', 'lastUpdated',
], auditRows));

// ---------------------------------------------------------------- audit 2
const postal = (await sql`
  SELECT c.entity_id, e.canonical_name, c.value AS address, c.reaches,
         c.verification_method, c.verified_at, c.counts_postal, c.status,
         (SELECT p.value_json #>> '{}' FROM s2_claim p
           WHERE p.id = c.person_claim_id)                                 AS named_person,
         (SELECT ev.span_text FROM s2_evidence ev
           WHERE ev.id = c.ownership_evidence_id)                          AS ownership_evidence,
         (SELECT s.identifier FROM s2_claim cl
            JOIN s2_evidence ev ON ev.claim_id = cl.id AND ev.role = 'establishing'
            JOIN s2_observation o ON o.id = ev.observation_id
            JOIN s2_source s ON s.id = o.source_id
           WHERE cl.id = c.person_claim_id LIMIT 1)                        AS source,
         (SELECT string_agg(x.value_json #>> '{}', ', ' ORDER BY x.field)
            FROM s2_claim x WHERE x.entity_id = c.entity_id
              AND x.status = 'released'
              AND x.field IN ('street','city','postcode','country'))       AS registered_office,
         (SELECT x.value_json #>> '{}' FROM s2_claim x WHERE x.entity_id = c.entity_id
            AND x.status = 'released' AND x.field = 'postcode' LIMIT 1)    AS office_postcode,
         (SELECT x.value_json #>> '{}' FROM s2_claim x WHERE x.entity_id = c.entity_id
            AND x.status = 'released' AND x.field = 'street' LIMIT 1)      AS office_street
  FROM s2_contact c JOIN s2_entity e ON e.id = c.entity_id
  WHERE c.channel = 'postal' AND c.status = 'released'
  ORDER BY e.canonical_name`) as unknown as Array<Record<string, any>>;

const normAddr = (a: string) => (a ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
const addrUse = new Map<string, number>();
for (const p of postal) addrUse.set(normAddr(p.address), (addrUse.get(normAddr(p.address)) ?? 0) + 1);

const postalRows = postal.map((p) => {
  const reuse = addrUse.get(normAddr(p.address)) ?? 1;
  // The registered office is the company's own address, not a route to a person.
  // The adjudicator rejects that case; this recomputes it independently so the
  // audit does not simply repeat what the adjudicator concluded.
  //
  // Compared on POSTCODE first, which identifies a building, plus street-name
  // agreement. An earlier version of this compared against whichever field came
  // first alphabetically -- the city -- and flagged 224 of 276 routes because
  // most of them are in London. The signal has to be the building, not the town.
  const pc = (t: string) =>
    (String(t ?? '').toUpperCase().match(/\b[A-Z]{1,2}\d[A-Z\d]?\s*\d[A-Z]{2}\b/) ?? [''])[0]
      .replace(/\s+/g, '');
  const streetTokens = (t: string) =>
    new Set(String(t ?? '').toLowerCase().replace(/[^a-z ]/g, ' ').split(/\s+/)
      .filter((w) => w.length > 3 && !['road','street','lane','close','house','floor','suite','unit'].includes(w)));

  const samePostcode = Boolean(pc(p.address)) && pc(p.address) === pc(p.office_postcode ?? '');
  const sharedStreet = [...streetTokens(p.address)].some((w) => streetTokens(p.office_street ?? '').has(w));
  const isRegisteredOffice = samePostcode && sharedStreet;

  const risks: string[] = [];
  if (reuse > 1) risks.push(`shared with ${reuse - 1} other route(s) in this file`);
  if (isRegisteredOffice) risks.push('matches the company registered office');
  if (!p.named_person) risks.push('no named person on the route');
  if (!p.ownership_evidence) risks.push('no ownership evidence recorded');

  return [
    p.entity_id, p.canonical_name, p.named_person ?? '', p.address,
    p.registered_office ?? '', p.source ?? '', p.verification_method ?? '', p.verified_at ?? '',
    reuse, isRegisteredOffice ? 'YES' : 'no',
    p.ownership_evidence ?? '',
    risks.length ? risks.join('; ') : 'none',
    // ADR-12's position, restated per row rather than assumed.
    risks.length
      ? 'REVIEW — the flags above weaken the personal-route claim'
      : 'defensible — a director-filed service address, adjudicated, not the registered office and not shared',
    p.counts_postal,
  ];
});

writeFileSync(OUT + 'audit-postal-routes.csv', csv([
  'entityId', 'name', 'namedPerson', 'serviceAddress',
  'companyRegisteredOffice', 'source', 'verificationMethod', 'verifiedAt',
  'addressReuseCount', 'equalsRegisteredOffice',
  'ownershipEvidence', 'riskFlags', 'defensibility', 'countsPostal',
], postalRows));

// ---------------------------------------------------------------- summary
const qualifying = recs.filter((r) => r.commercial_state === 'qualifying');
console.log('SOURCE-LEVEL AUDIT');
console.log(`  records audited        : ${recs.length} (${qualifying.length} qualifying)`);
const bySrc = new Map<string, number>();
for (const r of qualifying) bySrc.set(r.sources ?? '(none)', (bySrc.get(r.sources ?? '(none)') ?? 0) + 1);
for (const [s, n] of [...bySrc].sort((a, b) => b[1] - a[1])) console.log(`    ${String(n).padStart(4)}  ${s}`);
console.log(`  classified             : ${qualifying.filter((r) => r.classification).length}`);
console.log(`  duplicate name groups  : ${[...nameGroups.values()].filter((g) => g.length > 1).length}`);
console.log(`  SERVICE-PROVIDER FLAGS : ${qualifying.filter((r) => SERVICE_PROVIDER.test(r.canonical_name)).length}  <- needs human review`);
console.log(`  no named person        : ${qualifying.filter((r) => !r.named_person).length}`);
console.log('');
console.log('POSTAL-ROUTE AUDIT');
console.log(`  routes audited         : ${postal.length}`);
console.log(`  shared addresses       : ${postalRows.filter((r) => Number(r[8]) > 1).length}`);
console.log(`  equals registered office: ${postalRows.filter((r) => r[9] === 'YES').length}`);
console.log(`  no ownership evidence  : ${postalRows.filter((r) => !r[10]).length}`);
console.log(`  flagged for review     : ${postalRows.filter((r) => r[11] !== 'none').length}`);
console.log(`  defensible as-is       : ${postalRows.filter((r) => r[11] === 'none').length}`);
console.log('');
console.log('written: exports/audit-source-level.csv, exports/audit-postal-routes.csv');
console.log('NOTE: read-only. No classification, release state or reachability flag was modified.');
