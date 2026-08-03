import 'dotenv/config';
import { writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { connect } from '../../../db/src/connect.js';

/**
 * Deliverable 5 — the records as they stand at the end of the operating window,
 * "including whatever the system uses to track how fresh or trustworthy each
 * record is".
 *
 * That clause is the whole design of this file. A list of names and phone
 * numbers would satisfy the word "records" and none of the requirement, so every
 * value carries the things that decide whether it can be trusted:
 *
 *   - the evidence span that established it, the URL it was read from, the tier
 *     of that source, and when it was observed
 *   - the gate outcomes recorded for it, and the policy version they were judged
 *     under, so `skipped` is visible as skipped and never reads as `passed`
 *   - the freshness fields the refresh loop uses: last observation, content hash,
 *     and expiry where the refresh policy sets one
 *
 * The brief also says the dataset must state its own reachable count and that
 * they will recompute it from this file. So reachability is emitted three ways,
 * never blended (ADR-11, ADR-12), and every contact route carries the flags the
 * database enforces -- `countsStrict`, `countsProfileAssisted`, `countsPostal` --
 * so the recomputation lands on the same numbers from the rows alone.
 *
 * Withheld and quarantined records are exported too, in a separate array. They
 * are outside the qualifying count by design, and hiding them would misrepresent
 * what the system did: the gates rejecting a record is the control working.
 *
 * Two formats. The JSON is the complete artifact. The CSV is one row per
 * qualifying record for anyone who wants to open the file and count.
 */

const OUT = fileURLToPath(new URL('../../../../exports/', import.meta.url));
mkdirSync(OUT, { recursive: true });

const sql = connect();

interface EntityRow {
  id: string; canonical_name: string; entity_type: string; commercial_state: string;
  trust_state: string; strict_reachable: boolean; profile_assisted_reachable: boolean;
  postal_reachable: boolean; first_seen_at: string; updated_at: string;
}

const entities = (await sql`
  SELECT id, canonical_name, entity_type, commercial_state, trust_state,
         strict_reachable, profile_assisted_reachable, postal_reachable,
         first_seen_at, updated_at
  FROM s2_entity WHERE merged_into_id IS NULL
  ORDER BY commercial_state, id`) as unknown as EntityRow[];

/** Every released claim, with the single piece of evidence that established it. */
const claims = (await sql`
  SELECT c.entity_id, c.id AS claim_id, c.field, c.value_json #>> '{}' AS value, c.value_type,
         c.status, c.confidence, c.refresh_policy, c.established_at, c.expires_at,
         e.span_text, e.method, e.span_start, e.span_end,
         o.url, o.fetched_at, o.content_hash, s.tier, s.kind AS source_kind, s.identifier AS source
  FROM s2_claim c
  JOIN s2_evidence e     ON e.claim_id = c.id AND e.role = 'establishing'
  JOIN s2_observation o  ON o.id = e.observation_id
  JOIN s2_source s       ON s.id = o.source_id
  WHERE c.status = 'released'
  ORDER BY c.entity_id, c.field`) as unknown as Array<Record<string, any>>;

/**
 * Gate outcomes, newest policy version per gate.
 *
 * A claim judged under two policy versions has both stored; the current position
 * is the newest, and emitting both without saying which is current would let a
 * superseded verdict be read as live.
 */
const gates = (await sql`
  SELECT c.entity_id, c.id AS claim_id, v.gate, v.outcome, v.detail, v.policy_version
  FROM s2_claim c
  JOIN LATERAL (
    SELECT DISTINCT ON (x.gate) x.gate, x.outcome, x.detail, x.policy_version
    FROM s2_validation_result x WHERE x.claim_id = c.id
    ORDER BY x.gate, x.policy_version DESC
  ) v ON TRUE
  WHERE c.status = 'released'`) as unknown as Array<Record<string, any>>;

const contacts = (await sql`
  SELECT entity_id, channel, value, reaches, verification_method, verified_at, status,
         counts_strict, counts_profile_assisted, counts_postal
  FROM s2_contact WHERE status = 'released'
  ORDER BY entity_id, channel`) as unknown as Array<Record<string, any>>;

/** Withheld values, counted but never shown -- the buyer is told they exist. */
const withheldCounts = (await sql`
  SELECT entity_id,
         count(*) FILTER (WHERE status = 'quarantined')::int quarantined,
         count(*) FILTER (WHERE status = 'candidate')::int held
  FROM s2_claim GROUP BY entity_id`) as unknown as Array<Record<string, any>>;

type Keyed = Record<string, any>;
const by = (rows: Keyed[]) => {
  const m = new Map<string, Keyed[]>();
  for (const r of rows) {
    if (!m.has(r.entity_id)) m.set(r.entity_id, []);
    m.get(r.entity_id)!.push(r);
  }
  return m;
};

const claimsBy = by(claims);
const gatesBy = by(gates);
const contactsBy = by(contacts);
const withheldBy = new Map(withheldCounts.map((w) => [w.entity_id, w]));

function buildRecord(e: EntityRow) {
  const cs = claimsBy.get(e.id) ?? [];
  const gs = gatesBy.get(e.id) ?? [];
  const gatesByClaim = new Map<string, Array<Record<string, any>>>();
  for (const g of gs) {
    if (!gatesByClaim.has(g.claim_id)) gatesByClaim.set(g.claim_id, []);
    gatesByClaim.get(g.claim_id)!.push(g);
  }

  const observedAt = cs.map((c) => c.fetched_at).filter(Boolean).sort();
  const w = withheldBy.get(e.id);

  return {
    entityId: e.id,
    name: e.canonical_name,
    entityType: e.entity_type,
    commercialState: e.commercial_state,
    trustState: e.trust_state,

    // Three metrics, never merged. A reviewer recomputing from `contactRoutes`
    // must land on exactly these.
    reachability: {
      strict: e.strict_reachable,
      profileAssisted: e.profile_assisted_reachable,
      postal: e.postal_reachable,
      note:
        'Separate metrics by design (ADR-11, ADR-12). strict = phone or personal email. ' +
        'profileAssisted additionally counts a verified personal profile under assumption A1. ' +
        'postal = an adjudicated statutory service address. They are never summed into one figure.',
    },

    contactRoutes: (contactsBy.get(e.id) ?? []).map((c) => ({
      channel: c.channel, value: c.value, reaches: c.reaches,
      verificationMethod: c.verification_method, verifiedAt: c.verified_at,
      countsStrict: c.counts_strict,
      countsProfileAssisted: c.counts_profile_assisted,
      countsPostal: c.counts_postal,
    })),

    // How fresh this record is, in the terms the refresh loop actually uses.
    freshness: {
      firstSeenAt: e.first_seen_at,
      lastUpdatedAt: e.updated_at,
      oldestObservation: observedAt[0] ?? null,
      newestObservation: observedAt[observedAt.length - 1] ?? null,
      note:
        'Staleness is decided by re-reading the source and comparing content hashes, ' +
        'not by an elapsed-time expiry. Each value carries the hash it was read from.',
    },

    values: cs.map((c) => ({
      field: c.field,
      value: c.value,
      valueType: c.value_type,
      confidence: c.confidence,
      refreshPolicy: c.refresh_policy,
      establishedAt: c.established_at,
      expiresAt: c.expires_at,
      evidence: {
        span: c.span_text,
        spanStart: c.span_start,
        spanEnd: c.span_end,
        method: c.method,
        url: c.url,
        source: c.source,
        sourceKind: c.source_kind,
        sourceTier: c.tier,
        observedAt: c.fetched_at,
        contentHash: c.content_hash,
      },
      gates: (gatesByClaim.get(c.claim_id) ?? []).map((g) => ({
        gate: g.gate, outcome: g.outcome, detail: g.detail, policyVersion: g.policy_version,
      })),
    })),

    withheld: {
      quarantined: w?.quarantined ?? 0,
      held: w?.held ?? 0,
      note: 'Counted, never shown. A withheld value is not a value the firm lacks.',
    },
  };
}

const qualifying = entities.filter((e) => e.commercial_state === 'qualifying').map(buildRecord);
const notQualifying = entities.filter((e) => e.commercial_state !== 'qualifying').map(buildRecord);

const count = (rs: ReturnType<typeof buildRecord>[], f: (r: ReturnType<typeof buildRecord>) => boolean) =>
  rs.filter(f).length;

const dataset = {
  generatedAt: new Date().toISOString(),
  policyNote:
    'Records as held at export time. Nothing here was edited by hand: every value was ' +
    'written by the pipeline and every value carries the evidence that established it.',

  // The brief requires the dataset to state its own reachable count.
  counts: {
    qualifying: qualifying.length,
    notQualifying: notQualifying.length,
    reachable: {
      strict: count(qualifying, (r) => r.reachability.strict),
      profileAssisted: count(qualifying, (r) => r.reachability.profileAssisted),
      postal: count(qualifying, (r) => r.reachability.postal),
      anyRoute: count(qualifying, (r) =>
        r.reachability.strict || r.reachability.profileAssisted || r.reachability.postal),
      note:
        'Reported separately and never merged. `anyRoute` is given for completeness and is ' +
        'not the headline figure: it depends on accepting both assumption A1 (a verified ' +
        'personal profile is a route) and ADR-12 (an adjudicated service address is a route), ' +
        'and a reviewer may reasonably reject either. Recompute any of these from ' +
        '`contactRoutes` on each record.',
    },
  },

  sourceMix: {
    note:
      'Which source tiers stand behind the values in each record. A record counted under ' +
      '`tier1Only` has every value from a statutory or self-published source. A record under ' +
      '`mixedTier1And3` additionally holds a verified personal profile (tier 3), which is what ' +
      'carries profile-assisted reachability under assumption A1. Reporting only the best tier ' +
      'per record would let half the file read as fully statutory when it is not.',
    tier1Only: qualifying.filter((r) =>
      r.values.every((v) => v.evidence.sourceTier === 1)).length,
    mixedTier1And3: qualifying.filter((r) =>
      r.values.some((v) => v.evidence.sourceTier === 3)).length,
    bySource: Object.fromEntries(
      [...qualifying.reduce((m, r) => {
        for (const src of new Set(r.values.map((v) => v.evidence.source))) {
          m.set(src, (m.get(src) ?? 0) + 1);
        }
        return m;
      }, new Map<string, number>())].sort((a, b) => b[1] - a[1])),
  },

  inclusionStandard:
    'A record qualifies only with a named individual, a legal name, an address, and every ' +
    'value released by the gates. A contact route counts only if it reaches the named ' +
    'individual: shared inboxes, contact forms, switchboards and pattern-generated addresses ' +
    'are excluded by the data model, not by convention.',

  qualifying,
  notQualifying,
};

writeFileSync(OUT + 'records.json', JSON.stringify(dataset, null, 1));

/**
 * One row per qualifying record.
 *
 * Stage 1 shipped 33 columns and this shipped 21, which reads as a thinner
 * record and mostly is not. Six of Stage 1's columns were `_basis` fields --
 * its way of carrying evidence -- and Stage 2 carries evidence far more
 * strongly, with a span, URL, source tier, content hash, six gate outcomes and
 * the policy version behind every single value. All of that is in the JSON and
 * none of it was in this file, so the CSV understated the record it describes.
 *
 * The basis columns below restore that at CSV granularity: for each value, the
 * source it came from and the tier of that source. `rules_matched` and
 * `discovery_channel` were likewise derivable from what is already stored.
 *
 * What is still absent is absent for real: description, website, corporate
 * LinkedIn, principal email and principal location all needed the web discovery
 * channel, which measured 2-4% true precision and was rejected. Those columns
 * are not emitted rather than emitted empty, because a column of blanks invites
 * the reader to assume it was attempted and failed per row.
 */
const esc = (v: unknown) => {
  const s = v === null || v === undefined ? '' : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
const val = (r: ReturnType<typeof buildRecord>, field: string) =>
  r.values.find((v) => v.field === field);
const pick = (r: ReturnType<typeof buildRecord>, field: string) => val(r, field)?.value ?? '';

/** Where a value came from, at the granularity a spreadsheet can hold. */
const basis = (r: ReturnType<typeof buildRecord>, field: string) => {
  const v = val(r, field);
  if (!v) return '';
  return `${v.evidence.source} (tier ${v.evidence.sourceTier}) ${v.evidence.url}`;
};

/** Every named person on the record, so a second principal is not lost. */
const people = (r: ReturnType<typeof buildRecord>) =>
  r.values.filter((v) => v.field.endsWith('fullName')).map((v) => String(v.value));

const header = [
  'entityId', 'name', 'entityType', 'classification', 'classification_basis', 'commercialState',
  'strictReachable', 'profileAssistedReachable', 'postalReachable',
  'principalName', 'principalTitle', 'principalPhone', 'principalPhone_basis', 'principalProfile',
  'secondPrincipalName', 'thirdPrincipalName',
  'officerPostalAddress', 'controllerEntityName',
  'legalName', 'legalName_basis', 'street', 'city', 'region', 'postcode', 'country', 'address_basis',
  'companyNumber', 'companyStatus', 'incorporatedOn', 'cik', 'crd',
  'latestObservedFilingDate',
  'sources', 'sourceTiers', 'weakestSourceTier', 'rules_matched',
  'releasedValues', 'bestSourceTier', 'newestObservation', 'quarantinedValues',
];

const rows = qualifying.map((r) => {
  const named = people(r);
  // Which checks actually ran and passed for this record, deduplicated. The
  // Stage 1 column of the same name listed rubric rules; this lists the gates
  // that produced the record, which is the same question asked of real outcomes.
  const passed = [...new Set(r.values.flatMap((v) =>
    v.gates.filter((g) => g.outcome === 'passed').map((g) => g.gate)))].sort();
  const cls = val(r, 'entityClassification');

  return [
    r.entityId, r.name, r.entityType, cls?.value ?? '', cls ? cls.evidence.span : '', r.commercialState,
    r.reachability.strict, r.reachability.profileAssisted, r.reachability.postal,
    named[0] ?? '', pick(r, 'principal.title'), pick(r, 'principal.phone'),
    basis(r, 'principal.phone'), pick(r, 'principal.linkedinUrl'),
    named[1] ?? '', named[2] ?? '',
    pick(r, 'officer.postalAddress'), pick(r, 'controller.entityName'),
    pick(r, 'legalName'), basis(r, 'legalName'),
    pick(r, 'street'), pick(r, 'city'), pick(r, 'region'), pick(r, 'postcode'), pick(r, 'country'),
    basis(r, 'street') || basis(r, 'officer.postalAddress'),
    pick(r, 'companyNumber'), pick(r, 'companyStatus'), pick(r, 'incorporatedOn'),
    pick(r, 'cik'), pick(r, 'crd'),
    pick(r, 'latestObservedFilingDate'),
    // Every source behind the record, not just the first.
    //
    // This column named one source and `bestSourceTier` named the best tier, and
    // together they said "statutory" for 302 of 614 records that also hold
    // tier-3 evidence -- a LinkedIn profile carrying the profile-assisted route.
    // Neither field was false and the pair was misleading, which is the failure
    // the brief tests for: a value labelled more strongly than its evidence
    // supports. The weakest tier is now stated alongside the best, so a row
    // cannot read as fully statutory when half of it is not.
    [...new Set(r.values.map((v) => v.evidence.source))].sort().join('; '),
    [...new Set(r.values.map((v) => v.evidence.sourceTier))].sort().join('+'),
    r.values.length ? Math.max(...r.values.map((v) => v.evidence.sourceTier ?? 0)) : '',
    passed.join(' '),
    r.values.length,
    r.values.length ? Math.min(...r.values.map((v) => v.evidence.sourceTier ?? 9)) : '',
    r.freshness.newestObservation,
    r.withheld.quarantined,
  ].map(esc).join(',');
});
writeFileSync(OUT + 'records.csv', [header.join(','), ...rows].join('\n') + '\n');

console.log(`qualifying            : ${dataset.counts.qualifying}`);
console.log(`not qualifying        : ${dataset.counts.notQualifying}`);
console.log(`reachable  strict     : ${dataset.counts.reachable.strict}`);
console.log(`           profile    : ${dataset.counts.reachable.profileAssisted}`);
console.log(`           postal     : ${dataset.counts.reachable.postal}`);
console.log(`           any route  : ${dataset.counts.reachable.anyRoute}`);
console.log(`released values       : ${claims.length}`);
console.log(`gate outcomes         : ${gates.length}`);
console.log(`contact routes        : ${contacts.length}`);
console.log(`written               : exports/records.json, exports/records.csv`);
