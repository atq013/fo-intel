import { createHash, randomUUID } from 'node:crypto';
import { fetchJson, sleep } from '../lib/http.js';
import { derivedMethod } from '../gates/derivation.js';
import { adjudicateDirectorAddress, normaliseAddress } from './uk-director-address.js';
import type {
  Collector,
  Extractor,
  Observation,
  Source,
} from '@fo/core/contract/index.js';
import type { OpenExtractionEvent } from '@fo/core/contract/index.js';

/**
 * Companies House, through the Stage 2 contract.
 *
 * The Stage 1 adapter is left untouched in `discovery/companies-house.ts`. This
 * is a separate path rather than a refactor of it, for one reason: the Stage 1
 * adapter returns a `UkCompany` object -- a bag of fields already detached from
 * the documents they came from. Anything built on top of it inherits the defect,
 * because by the time you hold that object, the association between a value and
 * the bytes that establish it has already been lost.
 *
 * Here the unit is the observation. One company, three endpoints, fetched and
 * hashed. The extractor reads that JSON and asserts values against the exact
 * field it read them from, inside one extraction event.
 *
 * Why Companies House first: it is statutory (tier 1), it was the best
 * understood adapter from Stage 1, and it exercises every part of the contract
 * -- entity identity, composite addresses, person claims, corporate PSCs that
 * must fail `value_type`, and derived country.
 */

const BASE = 'https://api.company-information.service.gov.uk';

export const COMPANIES_HOUSE_SOURCE: Source = {
  id: 'src_companies_house',
  kind: 'companies_house',
  identifier: 'gov.uk/companies-house',
  baseUrl: BASE,
  tier: 1,
  rateLimitPerMin: 550, // documented limit is 600/5min; stay under it
  consecutiveFailures: 0,
};

function authHeader(): Record<string, string> {
  const key = process.env.COMPANIES_HOUSE_API_KEY;
  if (!key) throw new Error('COMPANIES_HOUSE_API_KEY not set');
  return { Authorization: `Basic ${Buffer.from(`${key}:`).toString('base64')}` };
}

async function get<T>(path: string): Promise<T | null> {
  try {
    return await fetchJson<T>(`${BASE}${path}`, { headers: authHeader(), retries: 2 });
  } catch {
    return null;
  }
}

/** Exactly what we fetched, kept together so the extractor reads one document. */
export interface CompanyDocument {
  companyNumber: string;
  profile: Record<string, any> | null;
  officers: Record<string, any> | null;
  psc: Record<string, any> | null;
}

/**
 * Canonical hash of the document.
 *
 * Key order is normalised so a re-fetch that returns the same facts in a
 * different order hashes identically. Without that, every run would look like a
 * change and staleness detection would be noise.
 */
export function hashDocument(doc: CompanyDocument): string {
  const canonical = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(canonical);
    if (v && typeof v === 'object') {
      return Object.fromEntries(
        Object.entries(v as Record<string, unknown>)
          .filter(([k]) => !VOLATILE_KEYS.has(k))
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([k, val]) => [k, canonical(val)]),
      );
    }
    return v;
  };
  return 'sha256:' + createHash('sha256').update(JSON.stringify(canonical(doc))).digest('hex').slice(0, 32);
}

/**
 * Fields Companies House varies between identical responses. Including them
 * would make every re-fetch look like a content change, which would defeat the
 * whole point of hashing: a hash that always differs is a clock in disguise, and
 * the brief is explicit that a clock is not evidence of staleness.
 */
const VOLATILE_KEYS = new Set(['etag', 'links', 'kind', 'generated_at']);

export async function fetchCompany(companyNumber: string): Promise<CompanyDocument> {
  const [profile, officers, psc] = await Promise.all([
    get<Record<string, any>>(`/company/${companyNumber}`),
    get<Record<string, any>>(`/company/${companyNumber}/officers?items_per_page=50`),
    get<Record<string, any>>(`/company/${companyNumber}/persons-with-significant-control?items_per_page=50`),
  ]);
  return { companyNumber, profile, officers, psc };
}

export function companiesHouseCollector(companyNumbers: string[]): Collector {
  return {
    kind: 'companies_house',
    async *collect(source: Source, cursor?: string) {
      // The cursor is the last company number completed. Resuming from it rather
      // than restarting is what makes a run that was halted by the budget guard
      // or an Actions timeout cheap to continue.
      const start = cursor ? companyNumbers.indexOf(cursor) + 1 : 0;
      for (let i = Math.max(0, start); i < companyNumbers.length; i++) {
        const number = companyNumbers[i]!;
        const doc = await fetchCompany(number);
        if (!doc.profile) continue;

        const observation: Observation = {
          id: `obs_${randomUUID()}`,
          sourceId: source.id,
          url: `${BASE}/company/${number}`,
          fetchedAt: new Date(),
          contentHash: hashDocument(doc),
          httpStatus: 200,
          body: JSON.stringify(doc),
        };
        yield { observation, cursor: number };
        await sleep(120);
      }
    },
  };
}

/** Reads the address once, so every part shares one extraction event. */
const ADDRESS_FIELDS: Array<[string, string]> = [
  ['address_line_1', 'street'],
  ['locality', 'city'],
  ['region', 'region'],
  ['postal_code', 'postcode'],
];

export function companiesHouseExtractor(entityIdFor: (doc: CompanyDocument) => string): Extractor {
  return {
    name: 'companies_house@1',

    async extract(observation: Observation, event: OpenExtractionEvent): Promise<void> {
      const doc = JSON.parse(observation.body ?? '{}') as CompanyDocument;
      const p = doc.profile;
      if (!p) return;
      const entityId = entityIdFor(doc);

      // Each value cites the exact field it was read from. `span` is that field's
      // literal content -- not a summary of the document, which is what made
      // Stage 1's spans unfalsifiable.
      const say = (field: string, value: unknown, valueType: string, span: string, method: string, policy?: 'statutory' | 'volatile' | 'append_only' | 'derived') => {
        if (value === null || value === undefined || String(value).trim() === '') return;
        event.assert(
          { entityId, field, value, valueType, confidence: 0.9, refreshPolicy: policy ?? 'statutory' },
          { observationId: observation.id, spanText: span, method },
        );
      };

      const cited = (path: string, v: unknown) => `${path}: ${String(v)}`;

      say('legalName', p.company_name, 'string',
        cited('company_profile.company_name', p.company_name),
        'the registrar records this as the company name');

      say('companyNumber', p.company_number, 'string',
        cited('company_profile.company_number', p.company_number),
        'the registered company number');

      say('companyStatus', p.company_status, 'string',
        cited('company_profile.company_status', p.company_status),
        'the registrar records this status', 'volatile');

      say('incorporatedOn', p.date_of_creation, 'string',
        cited('company_profile.date_of_creation', p.date_of_creation),
        'date of incorporation on the register');

      const addr = (p.registered_office_address ?? {}) as Record<string, string>;
      for (const [chKey, field] of ADDRESS_FIELDS) {
        say(field, addr[chKey], 'string',
          cited(`registered_office_address.${chKey}`, addr[chKey]),
          'the registered office address on file');
      }

      // Country is the derived case that motivated the amendment. The register
      // gives a home nation; the record needs one country. The rule is named so
      // gate 2 can re-run it.
      const nation = addr.country;
      if (nation) {
        say('country', 'United Kingdom', 'string',
          cited('registered_office_address.country', nation),
          derivedMethod('uk_nation_to_country', nation), 'derived');
      }

      // People with significant control. A PSC may lawfully be a corporate body,
      // which is exactly what Stage 1 shipped five times as a "person". They are
      // asserted as they are recorded and left for `value_type` to judge -- the
      // extractor's job is to report the register faithfully, not to pre-filter
      // it, because a silent pre-filter is an unrecorded decision.
      for (const item of (doc.psc?.items ?? []) as Array<Record<string, any>>) {
        if (item.ceased_on) continue;
        const isCorporate = String(item.kind ?? '').includes('corporate') ||
          String(item.kind ?? '').includes('legal-person');
        say(
          isCorporate ? 'controller.entityName' : 'principal.fullName',
          item.name,
          isCorporate ? 'string' : 'person_name',
          cited('psc.items[].name', item.name),
          `named on the PSC register as ${item.kind ?? 'a person with significant control'}`,
        );
      }

      const officers = (doc.officers?.items ?? []) as Array<Record<string, any>>;
      const activeDirectors = officers.filter(
        (o) => !o.resigned_on && /director/i.test(String(o.officer_role ?? '')),
      );
      const siblingAddresses = activeDirectors.map((o) => normaliseAddress(o.address)).filter(Boolean);

      for (const item of officers) {
        if (item.resigned_on) continue;
        if (!/director|secretary|llp/i.test(String(item.officer_role ?? ''))) continue;
        say('officer.fullName', item.name, 'person_name',
          cited('officers.items[].name', item.name),
          `appointed ${item.officer_role} on the register`);

        // Postal route, adjudicated. Asserted only when the address survives the
        // ownership tests -- a rejected one is simply not claimed, rather than
        // claimed and labelled weakly.
        if (!/director/i.test(String(item.officer_role ?? ''))) continue;
        const verdict = adjudicateDirectorAddress({
          companyNumber: doc.companyNumber,
          personName: String(item.name ?? ''),
          address: item.address,
          registeredOffice: p.registered_office_address,
          siblingDirectorAddresses: siblingAddresses,
        });
        if (verdict.ownership === 'individual') {
          say('officer.postalAddress', verdict.normalised.replace(/\|/g, ', '), 'postal',
            `officers.items[].address for ${item.name}: ${verdict.normalised.replace(/\|/g, ', ')}`,
            verdict.reason);
        }
      }
    },
  };
}
