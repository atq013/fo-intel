import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { Collector, Extractor, Observation, Source } from '@fo/core/contract/index.js';
import type { OpenExtractionEvent } from '@fo/core/contract/index.js';
import { US_STATE_CODES, derivedMethod } from '../gates/derivation.js';

/**
 * SEC 13F signature blocks — the reachability channel.
 *
 * Companies House gives breadth and statutory control evidence and zero contact
 * routes. This is the only measured channel that produces a phone number filed
 * beside a named individual in a document that individual signed.
 *
 * The Phase 0 census found 9,874 unique firm+person routes, of which 6,940
 * adjudicate to an individual. My stated prior before measuring was that these
 * would mostly be switchboards and fail ownership; that was wrong, and the
 * adjudication below is why. Exclusions are deterministic and principled:
 *
 *   - a number filed by more than one filer is an administrator line (one number
 *     covered 18 JPMorgan entities)
 *   - a signatory that is not a natural person is not a person
 *   - a number shared by two signatories at the same filer belongs to neither
 *
 * What this channel cannot do is reach beyond US 13F filers. A UK company or a
 * Gulf family office cannot appear in this census at all, which is assumption A5
 * and the reason the file's composition is a trade rather than a free choice.
 */

const SEC_DIR = 'data/sec';

export const SEC_13F_SOURCE: Source = {
  id: 'src_sec_13f',
  kind: 'sec_13f',
  identifier: 'sec.gov/form-13f/2025q3',
  baseUrl: 'https://www.sec.gov',
  tier: 1,
  rateLimitPerMin: 600,
  consecutiveFailures: 0,
};

interface SigRow { ACCESSION_NUMBER: string; NAME: string; TITLE: string; PHONE: string }
interface CoverRow {
  ACCESSION_NUMBER: string; FILINGMANAGER_NAME: string; DATEREPORTED: string;
  FILINGMANAGER_STREET1: string; FILINGMANAGER_CITY: string;
  FILINGMANAGER_STATEORCOUNTRY: string; FILINGMANAGER_ZIPCODE: string;
}

function tsv<T>(path: string): T[] {
  const lines = readFileSync(path, 'utf8').split('\n').filter(Boolean);
  const head = lines[0]!.split('\t').map((h) => h.trim());
  return lines.slice(1).map((l) => {
    const cells = l.split('\t');
    const o: Record<string, string> = {};
    head.forEach((h, i) => { o[h] = (cells[i] ?? '').trim(); });
    return o as T;
  });
}

const digits = (s: string) => (s ?? '').replace(/\D/g, '');

const NOT_A_PERSON =
  /\b(department|compliance|committee|group|llc|inc|corp|ltd|limited|lp|trust|company|partners|management|administrator|services|team|office)\b/i;

export function isNaturalPerson(name: string): boolean {
  const n = name.trim();
  if (n.length < 4) return false;
  if (NOT_A_PERSON.test(n)) return false;
  return n.replace(/[^A-Za-z ,.'-]/g, '').split(/[\s,]+/).filter((t) => t.length > 1).length >= 2;
}

export interface SignatoryRoute {
  firm: string; accession: string; person: string; title: string;
  phone: string; filedOn: string;
  ownership: 'individual' | 'company' | 'unknown';
  reason: string;
  cik?: string;
}

/**
 * The filer's own address, as filed on the cover page.
 *
 * Already present in COVERPAGE.tsv beside the manager name -- no new source and
 * no extra fetch. It matters because a route to a person is only commercially
 * usable alongside enough context to act on, and without it a reachable record
 * fails the commercial floor and counts toward nothing.
 */
export interface FilerAddress {
  street: string; city: string; stateOrCountry: string; zip: string;
}

/** Normalised for joining a filer name to a candidate's legal name. */
export function normFirm(s: string): string {
  return s.toUpperCase()
    .replace(/[.,]/g, ' ')
    .replace(/\b(L\s?L\s?C|L\s?P|LLP|INC|CORP|CORPORATION|COMPANY|CO|LTD|LIMITED|TRUST|THE)\b/g, ' ')
    .replace(/[^A-Z0-9 ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Populated as a side effect of the census pass; keyed by accession. */
const addressByAccession = new Map<string, FilerAddress>();

export function addressFor(accession: string): FilerAddress | undefined {
  return addressByAccession.get(accession);
}

export function buildSignatoryRoutes(dir = SEC_DIR): SignatoryRoute[] {
  const sigs = tsv<SigRow>(`${dir}/SIGNATURE.tsv`);
  const covers = new Map(tsv<CoverRow>(`${dir}/COVERPAGE.tsv`).map((c) => [c.ACCESSION_NUMBER, c]));

  // pass 1 — how widely is each number used across the whole census?
  const phoneToFirms = new Map<string, Set<string>>();
  const phoneToPeople = new Map<string, Set<string>>();
  for (const s of sigs) {
    const c = covers.get(s.ACCESSION_NUMBER);
    const p = digits(s.PHONE);
    if (!c || !p || !s.NAME) continue;
    const firm = c.FILINGMANAGER_NAME.trim();
    if (!phoneToFirms.has(p)) phoneToFirms.set(p, new Set());
    if (!phoneToPeople.has(p)) phoneToPeople.set(p, new Set());
    phoneToFirms.get(p)!.add(firm);
    // normalise so "Jeff Sarrett" and "Jeffrey Sarrett" are not counted as two
    phoneToPeople.get(p)!.add(s.NAME.toLowerCase().replace(/[^a-z]/g, '').slice(0, 12));
  }

  const seen = new Set<string>();
  const out: SignatoryRoute[] = [];
  for (const s of sigs) {
    const c = covers.get(s.ACCESSION_NUMBER);
    const p = digits(s.PHONE);
    if (!c || !p || !s.NAME) continue;
    const firm = c.FILINGMANAGER_NAME.trim();
    const key = `${firm}|${s.NAME.trim()}`;
    if (seen.has(key)) continue;
    seen.add(key);

    let ownership: SignatoryRoute['ownership'] = 'individual';
    let reason = 'filed by this person as their own contact in a statutory filing they signed';

    if (!isNaturalPerson(s.NAME)) {
      ownership = 'company';
      reason = 'signatory is not a natural person';
    } else if ((phoneToFirms.get(p)?.size ?? 0) > 1) {
      ownership = 'company';
      reason = `number also filed by ${phoneToFirms.get(p)!.size - 1} other filer(s); administrator line`;
    } else if ((phoneToPeople.get(p)?.size ?? 0) > 1) {
      ownership = 'company';
      reason = 'number shared by more than one signatory at this filer';
    }

    out.push({
      firm, accession: s.ACCESSION_NUMBER, person: s.NAME.trim(), title: s.TITLE.trim(),
      phone: s.PHONE.trim(), filedOn: c.DATEREPORTED, ownership, reason,
    });
    addressByAccession.set(s.ACCESSION_NUMBER, {
      street: (c.FILINGMANAGER_STREET1 ?? '').trim(),
      city: (c.FILINGMANAGER_CITY ?? '').trim(),
      stateOrCountry: (c.FILINGMANAGER_STATEORCOUNTRY ?? '').trim(),
      zip: (c.FILINGMANAGER_ZIPCODE ?? '').trim(),
    });
  }
  return out;
}

/**
 * Stable entity id for a filer.
 *
 * Filers found only in the census have no CIK, so they are keyed by their
 * normalised name slugged into an id-safe form. Deterministic either way, so a
 * re-run upserts the same entity rather than duplicating it.
 */
export function secEntityId(cik: string): string {
  return cik.startsWith('name:')
    ? `ent_sec_n_${cik.slice(5).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '')}`
    : `ent_sec_${cik}`;
}

/** One filer, with the routes filed under it. The collector's unit. */
export interface FilerUnit {
  firm: string;
  cik: string;
  routes: SignatoryRoute[];
  address?: FilerAddress;
}

/**
 * Join the census to the family-office candidates found in Stage 1.
 *
 * The census is every 13F filer in the quarter, most of which are ordinary asset
 * managers. Only filers we have independent reason to believe are family offices
 * are collected -- the structural signals decide *which firms to investigate*,
 * never *what a firm is*. That distinction is the Stage 1 correction.
 */
/**
 * Filer names that are self-declared family wealth vehicles.
 *
 * This selects *which firms to investigate*, never *what a firm is* -- entities
 * created this way are `unconfirmed` and must earn a classification from
 * evidence like any other. That distinction is the Stage 1 correction: a
 * structural signal is a reason to look, not a finding.
 *
 * Widened from `FAMILY + vehicle word` to any `FAMILY`/`FAMILIES` after
 * measuring the census: the narrow form matched 27 filers carrying an
 * individually-owned route, the wide form matches 56. The 29 it was missing are
 * names like "Colony Family Offices, LLC", "West Family Investments, Inc." and
 * "Omnia Family Wealth, LLC" -- self-declared family vehicles that simply do not
 * use one of seven enumerated nouns.
 *
 * It is still a NAME test, deliberately. The census holds 6,944 filers with an
 * individually-owned route; the other 6,888 are ordinary asset managers and are
 * not collected, because having a reachable signatory is not evidence of being a
 * family office. 56 is this channel's honest ceiling, not a number to widen
 * until it reaches a target.
 */
const FAMILY_FILER = /\b(FAMILY|FAMILIES)\b/i;

export function filerUnits(candidatesPath: string, dir = SEC_DIR): FilerUnit[] {
  const cand = JSON.parse(readFileSync(candidatesPath, 'utf8')) as {
    entities: Array<{ cik: string; legalName: string }>;
  };
  const byName = new Map<string, string>();
  for (const e of cand.entities) {
    const k = normFirm(e.legalName);
    if (k) byName.set(k, e.cik);
  }

  const grouped = new Map<string, FilerUnit>();
  for (const r of buildSignatoryRoutes(dir)) {
    // Two ways in. Stage 1's candidate list carries a real CIK; a self-declared
    // family filer found only in the census does not, so it is keyed by its
    // normalised name and the CIK is resolved later if we ever need one.
    const cik = byName.get(normFirm(r.firm)) ?? (FAMILY_FILER.test(r.firm) ? `name:${normFirm(r.firm)}` : undefined);
    if (!cik) continue;
    const u = grouped.get(cik) ?? { firm: r.firm, cik, routes: [] };
    u.routes.push({ ...r, cik });
    u.address ??= addressFor(r.accession);
    grouped.set(cik, u);
  }
  // Filers carrying at least one individually-owned route first: those are the
  // ones that can move the reachability number.
  return [...grouped.values()].sort(
    (a, b) =>
      b.routes.filter((r) => r.ownership === 'individual').length -
      a.routes.filter((r) => r.ownership === 'individual').length,
  );
}

export function secSignatoryCollector(units: FilerUnit[]): Collector {
  return {
    kind: 'sec_13f',
    async *collect(source: Source, cursor?: string) {
      const start = cursor ? units.findIndex((u) => u.cik === cursor) + 1 : 0;
      for (let i = Math.max(0, start); i < units.length; i++) {
        const u = units[i]!;
        const payload = JSON.stringify(u);
        yield {
          observation: {
            id: `obs_${randomUUID()}`,
            sourceId: source.id,
            // The filing index for this filer on EDGAR. No fetch is performed --
            // the quarterly dataset is the same data the page renders, and the
            // URL is the human-checkable locator for it.
            url: `https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=${u.cik}&type=13F`,
            fetchedAt: new Date(),
            contentHash: 'sha256:' + createHash('sha256').update(payload).digest('hex').slice(0, 32),
            httpStatus: 200,
            body: payload,
          },
          cursor: u.cik,
        };
      }
    },
  };
}

export function secSignatoryExtractor(): Extractor {
  return {
    name: 'sec_13f_signatory@1',

    async extract(observation: Observation, event: OpenExtractionEvent): Promise<void> {
      const unit = JSON.parse(observation.body ?? '{}') as FilerUnit;
      if (!unit.cik) return;
      const entityId = secEntityId(unit.cik);

      const say = (field: string, value: unknown, valueType: string, span: string, method: string) => {
        if (value === null || value === undefined || String(value).trim() === '') return;
        event.assert(
          { entityId, field, value, valueType, confidence: 0.9, refreshPolicy: 'statutory' },
          { observationId: observation.id, spanText: span, method },
        );
      };

      say('legalName', unit.firm, 'string',
        `COVERPAGE.FILINGMANAGER_NAME: ${unit.firm}`,
        'the name under which this manager files its 13F');
      if (!unit.cik.startsWith('name:')) {
        say('cik', unit.cik, 'string',
          `EDGAR central index key: ${unit.cik}`,
          'the filer identifier on EDGAR');
      }
      // The filer's own address, as filed on the cover page beside its name.
      //
      // `country` was previously asserted from "Form 13F implies a US manager",
      // citing the accession number. That reads as pointer evidence, so gate 2
      // correctly returned `skipped` and the release gate held all 49 of them --
      // which in turn left every SEC entity below the commercial floor. The gate
      // was right; the evidence was the wrong kind. Here the state code is read
      // from the filing and the country is re-derived from it by a registered
      // rule, so gate 2 can actually check the claim instead of deferring it.
      const addr = unit.address;
      if (addr) {
        const cited = (field: string, v: string) => `COVERPAGE.FILINGMANAGER_${field}: ${v}`;

        say('street', addr.street, 'string', cited('STREET1', addr.street),
          'the business address on the filing cover page');
        say('city', addr.city, 'string', cited('CITY', addr.city),
          'the business address on the filing cover page');
        say('postcode', addr.zip, 'string', cited('ZIPCODE', addr.zip),
          'the business address on the filing cover page');

        if (addr.stateOrCountry) {
          const state = addr.stateOrCountry.toUpperCase();
          const span = cited('STATEORCOUNTRY', addr.stateOrCountry);

          // Only claimed when the registered rule actually applies. A filer
          // domiciled outside the US carries a country code here, not a state
          // code, and asserting "United States" for it would be a fabrication
          // the gate would have to catch. Better not to make the claim.
          if (US_STATE_CODES.has(state)) {
            say('region', addr.stateOrCountry, 'string', span,
              'the state given on the filing cover page');
            say('country', 'United States', 'string', span,
              derivedMethod('us_state_to_country', addr.stateOrCountry));
          }
        }
      }

      // One person per assertion set, each citing its own signature block. The
      // span carries name, title and number together because that is how the
      // filing presents them -- and it is what lets contact_ownership verify the
      // number belongs to this person rather than to the firm.
      for (const r of unit.routes) {
        const block =
          `SIGNATURE block, accession ${r.accession}, reported ${r.filedOn} — ` +
          `Name: ${r.person} | Title: ${r.title || 'not stated'} | Phone: ${r.phone}`;

        say('principal.fullName', r.person, 'person_name', block,
          `signed the Form 13F filed by ${unit.firm}`);

        if (r.title) {
          say('principal.title', r.title, 'string', block,
            'the title given in the signature block');
        }

        // Only individually-adjudicated numbers are asserted as a person's
        // route. An administrator line is not withheld silently -- it is simply
        // not claimed to be personal, which is the distinction the brief draws.
        if (r.ownership === 'individual') {
          say('principal.phone', r.phone, 'phone', block, r.reason);
        }
      }
    },
  };
}
