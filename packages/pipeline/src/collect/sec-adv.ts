import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { Collector, Extractor, Observation, Source } from '@fo/core/contract/index.js';
import type { OpenExtractionEvent } from '@fo/core/contract/index.js';
import { US_STATE_CODES, derivedMethod } from '../gates/derivation.js';

/**
 * SEC Form ADV — an identity channel, deliberately not a reachability one.
 *
 * Phase 0 measured Schedule A for contact routes and found zero, because the
 * form has no field for individual contact data. That has not changed. What ADV
 * gives is the best control-person evidence available to us: a named individual
 * with a title, an ownership code and a control-person flag, filed under
 * penalty. A 13F signature block cannot match that -- 45% of its signatories are
 * compliance and back-office staff.
 *
 * ### The constraint that shapes everything here
 *
 * SEC Rule 202(a)(11)(G)-1, the family office rule, EXCLUDES single family
 * offices from the definition of investment adviser. They do not register. So
 * every firm in this file is a multi-family office or a registered adviser --
 * never an SFO -- and no amount of family-office naming changes that.
 *
 * The classification therefore refuses to guess:
 *
 *   - `multi_family_office` only where the firm's own registered name says so
 *   - `unconfirmed_registered_adviser` otherwise
 *   - `family_office` (meaning single) is never assigned from this source
 *
 * ### Staleness is carried, not hidden
 *
 * The archive ends 2024-12-31. A 2024 filing date is evidence the firm filed on
 * that date, and nothing more -- it is not evidence the firm is registered
 * today. So the claim asserted is `latestObservedFilingDate`, a dated fact that
 * stays true, rather than a status like "active" that quietly decays.
 */

export interface AdvRegistrant {
  crd: string;
  legalName: string;
  city: string;
  state: string;
  street: string;
  latestFilingDate: string;
  filingId: string;
  selfDescribedMultiFamilyOffice: boolean;
  controlPersons: Array<{
    name: string; title: string; statusAcquired: string;
    ownershipCode: string; controlPerson: string;
  }>;
}

export interface AdvFile {
  source: string;
  archiveCutoff: string;
  staleness: string;
  registrants: AdvRegistrant[];
}

export const SEC_ADV_SOURCE: Source = {
  id: 'src_sec_adv',
  kind: 'sec_adv',
  identifier: 'sec.gov/form-adv-archive/20111105-20241231',
  baseUrl: 'https://www.sec.gov',
  tier: 1,
  rateLimitPerMin: 600,
  consecutiveFailures: 0,
};

export function loadAdv(path: string): AdvFile {
  return JSON.parse(readFileSync(path, 'utf8')) as AdvFile;
}

/** Deterministic and CRD-keyed, so a re-run upserts rather than duplicating. */
export function advEntityId(crd: string): string {
  return `ent_adv_${crd.replace(/[^A-Za-z0-9]/g, '_').toLowerCase()}`;
}

export function advCollector(registrants: AdvRegistrant[], meta: Pick<AdvFile, 'archiveCutoff' | 'staleness'>): Collector {
  return {
    kind: 'sec_adv',
    async *collect(source: Source, cursor?: string) {
      const start = cursor ? registrants.findIndex((r) => r.crd === cursor) + 1 : 0;
      for (let i = Math.max(0, start); i < registrants.length; i++) {
        const r = registrants[i]!;
        const payload = JSON.stringify({ ...r, archiveCutoff: meta.archiveCutoff });
        yield {
          observation: {
            id: `obs_${randomUUID()}`,
            sourceId: source.id,
            // The firm's own IAPD record: the human-checkable locator for this data.
            url: `https://adviserinfo.sec.gov/firm/summary/${r.crd}`,
            fetchedAt: new Date(),
            contentHash: 'sha256:' + createHash('sha256').update(payload).digest('hex').slice(0, 32),
            httpStatus: 200,
            notes: meta.staleness,
            body: payload,
          },
          cursor: r.crd,
        };
      }
    },
  };
}

export function advExtractor(): Extractor {
  return {
    name: 'sec_adv@1',

    async extract(observation: Observation, event: OpenExtractionEvent): Promise<void> {
      const r = JSON.parse(observation.body ?? '{}') as AdvRegistrant & { archiveCutoff: string };
      if (!r.crd) return;
      const entityId = advEntityId(r.crd);

      const say = (field: string, value: unknown, valueType: string, span: string, method: string,
                   policy: 'statutory' | 'volatile' | 'append_only' | 'derived' = 'statutory') => {
        if (value === null || value === undefined || String(value).trim() === '') return;
        event.assert(
          { entityId, field, value, valueType, confidence: 0.9, refreshPolicy: policy },
          { observationId: observation.id, spanText: span, method },
        );
      };
      const cited = (path: string, v: unknown) => `${path}: ${String(v)}`;

      say('legalName', r.legalName, 'string',
        cited('ADV Item 1A (full legal name)', r.legalName),
        'the name under which this adviser is registered with the SEC');

      say('crd', r.crd, 'string', cited('ADV Item 1D (CRD number)', r.crd),
        'the adviser CRD number on the SEC register');

      say('street', r.street, 'string', cited('ADV Item 1F1 street', r.street),
        'principal office address on the adviser\'s registration');
      say('city', r.city, 'string', cited('ADV Item 1F1 city', r.city),
        'principal office address on the adviser\'s registration');

      if (r.state && US_STATE_CODES.has(r.state.toUpperCase())) {
        const span = cited('ADV Item 1F1 state', r.state);
        say('region', r.state, 'string', span, 'the state on the adviser\'s registration');
        say('country', 'United States', 'string', span, derivedMethod('us_state_to_country', r.state));
      }

      // A DATE, not a status. "Active" would be an inference that rots the
      // moment the archive ages; the date this firm last filed stays true
      // forever and lets the reader draw their own conclusion.
      say('latestObservedFilingDate', r.latestFilingDate, 'string',
        cited('ADV DateSubmitted (most recent filing in the archive)', r.latestFilingDate),
        `most recent Form ADV filing in the SEC bulk archive, which ends ${r.archiveCutoff}. ` +
        'Evidence the firm filed on this date, not evidence it is registered today.',
        'volatile');

      // Classification is asserted ONLY where the source states it.
      //
      // A firm whose registered name says "multi-family office" has told the
      // registrar what it is, and that is quotable. `unconfirmed_registered_
      // adviser` is the opposite: a statement about the ABSENCE of
      // classification evidence. Asserting it as a claim produced 25 rows that
      // failed attribution -- correctly, because no filing contains those words
      // -- and filled the customer-facing "what the gates refused" list with
      // noise that reads like 25 caught defects.
      //
      // The honest place for that label is the entity's `entity_type`, which the
      // job sets. A claim we know cannot be evidenced is not made at all.
      if (r.selfDescribedMultiFamilyOffice) {
        say('entityClassification', 'multi_family_office', 'string',
          cited('ADV Item 1A (full legal name)', r.legalName),
          'the adviser\'s own registered name describes it as a multi-family office');
      }

      // Schedule A individuals: control-person evidence. NOT a contact route --
      // Form ADV carries no individual contact field, which Phase 0 measured
      // directly. Asserting these as `person_name` only is the point.
      for (const p of r.controlPersons ?? []) {
        if (!p.name) continue;
        const span =
          `ADV Schedule A — Full Legal Name: ${p.name} | DE/FE/I: I | ` +
          `Title or Status: ${p.title || 'not stated'} | Ownership Code: ${p.ownershipCode || '-'} | ` +
          `Control Person: ${p.controlPerson || '-'}`;

        say('principal.fullName', p.name, 'person_name', span,
          'named on Schedule A of the adviser\'s Form ADV as a direct owner or executive officer');

        if (p.title) {
          say('principal.title', p.title, 'string', span,
            'the title given for this person on Schedule A');
        }
      }
    },
  };
}
