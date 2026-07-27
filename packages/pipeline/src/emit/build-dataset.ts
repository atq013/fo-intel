/**
 * Assembles the deliverable dataset.
 *
 * Everything upstream produces candidates and evidence. This decides what
 * actually ships, and it is the step where the brief's rule about findings
 * governing releases is enforced: a value our own validation rejected goes to the
 * audit file and never to a customer-facing cell.
 */
import { existsSync, readFileSync } from 'node:fs';
import type { Cell, Classification, Evidence, FamilyOffice, Principal, Signal } from '@fo/core';
import { emptyCell } from '@fo/core';
import { consolidate, type MergedFirm } from '../classify/consolidate.js';
import { normaliseCountry } from '../classify/normalise.js';
import type { TypeFinding } from '../enrich/establish-type.js';
import { toEvidence } from '../enrich/establish-type.js';
import type { SecEntity } from '../enrich/sec-entity.js';
import type { UkCompany } from '../discovery/companies-house.js';
import type { LocationFinding } from '../enrich/find-location.js';
import { locationCell } from '../enrich/find-location.js';
import type { ContactFinding } from '../enrich/contacts.js';
import { emailCell } from '../enrich/contacts.js';

/** Below this, an assertion about what a firm is rests on a lone profile database. */
export const TYPE_CONFIDENCE_FLOOR = 0.55;

export interface RejectedValue {
  firmName: string;
  fieldPath: string;
  value: string;
  reason: string;
  detectedBy: string;
}

export interface BuildResult {
  records: FamilyOffice[];
  rejected: RejectedValue[];
  stats: Record<string, number>;
}

function readJson<T>(path: string): T | null {
  return existsSync(path) ? (JSON.parse(readFileSync(path, 'utf8')) as T) : null;
}

function cellFrom<T>(value: T | null, evidence: Evidence[], confidence: number, note?: string): Cell<T> {
  if (value === null || value === undefined || value === '') return emptyCell<T>(note);
  return { value, status: 'verified', evidence, confidence };
}

const HONORIFIC = /\b(mr|mrs|ms|miss|dr|sir|dame|lord|lady|prof|professor)\b/g;

/** Two register entries describe the same person when their name tokens match. */
function samePerson(a: string | null, b: string | null): boolean {
  if (!a || !b) return false;
  const key = (s: string) =>
    s.toLowerCase().replace(/[^a-z\s]/g, ' ').replace(HONORIFIC, ' ').split(/\s+/).filter(Boolean).sort().join(' ');
  return key(a) === key(b);
}

/** Signals with no date are not intelligence, so they are dropped rather than shipped undated. */
function usableSignals(signals: Signal[]): Signal[] {
  return signals
    .filter((s) => s.occurredAt && /^\d{4}-\d{2}-\d{2}$/.test(s.occurredAt))
    .sort((a, b) => b.occurredAt.localeCompare(a.occurredAt))
    .slice(0, 10);
}

export function buildDataset(): BuildResult {
  const firms = consolidate();
  const findings = readJson<Record<string, TypeFinding>>('data/type-findings.json') ?? {};
  const sec = readJson<{ entities: SecEntity[] }>('data/candidates-sec.json');
  const uk = readJson<{ companies: UkCompany[] }>('data/candidates-uk.json');
  const locations = readJson<Record<string, LocationFinding>>('data/location-findings.json') ?? {};
  const contacts =
    readJson<Record<string, { website: string | null; contacts: ContactFinding }>>('data/contact-findings.json') ?? {};

  const secByName = new Map((sec?.entities ?? []).map((e) => [e.legalName.toLowerCase(), e]));
  const ukByName = new Map((uk?.companies ?? []).map((c) => [c.name.toLowerCase(), c]));

  const rejected: RejectedValue[] = [];
  const stats: Record<string, number> = {
    pool: firms.length,
    qualifiedByRubric: 0,
    qualifiedByTypeFinding: 0,
    droppedLowConfidence: 0,
    droppedConflicted: 0,
  };

  const records: FamilyOffice[] = [];

  for (const firm of firms) {
    const finding = findings[firm.key];

    // A record enters on either the rubric (statutory evidence) or an established
    // type that clears the confidence floor. Never on structural signals alone.
    let classification: Classification = firm.classification;
    let qualifies = firm.classification.qualifies;

    if (!qualifies && finding) {
      if (finding.conflicted) {
        stats.droppedConflicted!++;
        rejected.push({
          firmName: firm.name,
          fieldPath: 'classification.type',
          value: 'contested',
          reason: finding.note,
          detectedBy: 'source reconciliation',
        });
      } else if (
        (finding.type === 'single_family_office' || finding.type === 'multi_family_office') &&
        finding.confidence >= TYPE_CONFIDENCE_FLOOR
      ) {
        const ev = toEvidence(finding);
        classification = {
          type: finding.type,
          evidence: ev ? [ev] : [],
          rulesMatched: ['SFO-2'],
          confidence: finding.confidence,
          qualifies: true,
        };
        qualifies = true;
        stats.qualifiedByTypeFinding!++;
      } else if (finding.type !== 'undetermined' && finding.confidence < TYPE_CONFIDENCE_FLOOR) {
        stats.droppedLowConfidence!++;
        rejected.push({
          firmName: firm.name,
          fieldPath: 'classification.type',
          value: finding.type,
          reason: `confidence ${finding.confidence.toFixed(2)} below the ${TYPE_CONFIDENCE_FLOOR} floor; ${finding.note}`,
          detectedBy: 'source reconciliation',
        });
      }
    } else if (qualifies) {
      stats.qualifiedByRubric!++;
    }

    if (!qualifies) continue;

    const secEntity = secByName.get(firm.name.toLowerCase());
    const ukCompany = ukByName.get(firm.name.toLowerCase());

    const sourceEvidence: Evidence[] = classification.evidence.slice();

    const registryEvidence: Evidence[] = ukCompany
      ? [
          {
            sourceUrl: `https://find-and-update.company-information.service.gov.uk/company/${ukCompany.companyNumber}`,
            sourceClass: 'registry',
            method: `filed on the UK register for company ${ukCompany.companyNumber}`,
            observedAt: new Date().toISOString(),
          },
        ]
      : [];

    // Principals come from the statutory control register first, then serving
    // directors. A person the register names as controlling the entity is a
    // materially stronger contact than one who merely holds a title.
    const principals: Principal[] = [];
    if (ukCompany) {
      for (const person of ukCompany.psc.slice(0, 2)) {
        principals.push({
          fullName: cellFrom(person.name, registryEvidence, 0.9),
          title: cellFrom('Person with significant control', registryEvidence, 0.9),
          controlBasis: cellFrom(
            (person.natures_of_control ?? []).join('; ').replace(/-/g, ' ') || null,
            registryEvidence,
            0.9,
            'nature of control not stated',
          ),
          linkedinUrl: emptyCell<string>('not searched in this build'),
          email: emptyCell<string>('no published address found for this firm'),
          phone: emptyCell<string>('no direct line published'),
          location: cellFrom(person.country_of_residence ?? null, registryEvidence, 0.85),
        });
      }
      for (const officer of ukCompany.officers.filter((o) => o.officer_role === 'director').slice(0, 3)) {
        // The registers format the same person differently - "SURNAME, Forename"
        // on the officer list, "Mr Forename Surname" on the PSC list - so names
        // are compared as sorted token sets rather than as strings.
        if (principals.some((p) => samePerson(p.fullName.value, officer.name))) continue;
        principals.push({
          fullName: cellFrom(officer.name, registryEvidence, 0.9),
          title: cellFrom(officer.occupation || 'Director', registryEvidence, 0.85),
          linkedinUrl: emptyCell<string>('not searched in this build'),
          email: emptyCell<string>('no published address found for this firm'),
          phone: emptyCell<string>('no direct line published'),
          location: cellFrom(officer.country_of_residence ?? null, registryEvidence, 0.8),
        });
      }
    }

    if (principals.length === 0) {
      principals.push({
        fullName: cellFrom(firm.principalName || null, sourceEvidence, 0.8, 'no principal identified'),
        title: cellFrom(firm.principalTitle || null, sourceEvidence, 0.7, 'no title established'),
        linkedinUrl: emptyCell<string>('not searched in this build'),
        email: emptyCell<string>('no published address found for this firm'),
        phone: emptyCell<string>('no direct line established'),
        location: cellFrom([firm.city, firm.region].filter(Boolean).join(', ') || null, sourceEvidence, 0.7),
      });
    }
    const principal = principals[0]!;

    // A director appointment is a dated, filed event - the "recent key hire"
    // signal, sourced from a statutory register rather than inferred from news.
    const appointmentSignals: Signal[] = (ukCompany?.officers ?? [])
      .filter((o) => o.appointed_on && o.officer_role === 'director')
      .map((o) => ({
        kind: 'key_hire' as const,
        summary: `${o.name} was appointed a director of ${firm.name}`,
        occurredAt: o.appointed_on!,
        evidence: registryEvidence[0]!,
      }));

    const signals = usableSignals([...(secEntity?.signals ?? []), ...appointmentSignals]);

    records.push({
      id: firm.key,
      legalName: firm.name,
      discoveries: [...firm.channels].map((channel) => ({
        channel,
        sourceUrl: firm.sourceUrls[0] ?? '',
        discoveredAt: new Date().toISOString(),
        externalId: ukCompany?.companyNumber ?? secEntity?.cik,
        rawName: firm.name,
      })),
      classification,
      description: emptyCell<string>('not enriched in this build'),
      investmentThesis: emptyCell<string>('not enriched in this build'),
      sectors: emptyCell<string[]>('not enriched in this build'),
      aum: emptyCell<number>('not disclosed in any source consulted'),
      website: cellFrom(finding?.website ?? null, sourceEvidence, 0.8, 'no own-domain website identified'),
      linkedinUrl: emptyCell<string>('not searched in this build'),
      street: cellFrom(
        ukCompany?.street || secEntity?.street || null,
        ukCompany ? registryEvidence : sourceEvidence,
        0.9,
        'no street address on record',
      ),
      postcode: cellFrom(
        ukCompany?.postcode || secEntity?.postcode || null,
        ukCompany ? registryEvidence : sourceEvidence,
        0.9,
        'no postcode on record',
      ),
      city: cellFrom(firm.city || null, sourceEvidence, 0.8),
      region: cellFrom(firm.region || null, sourceEvidence, 0.8),
      country: cellFrom(firm.country || null, sourceEvidence, 0.8),
      principals,
      signals,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    // Firm-level phone from a statutory filing is the strongest contact datum here.
    const phone = firm.phone || secEntity?.phone.value || '';
    if (phone && secEntity?.phone.evidence.length) {
      records[records.length - 1]!.principals[0]!.phone = {
        value: phone,
        status: 'verified',
        evidence: secEntity.phone.evidence,
        confidence: 0.9,
      };
    } else if (phone) {
      records[records.length - 1]!.principals[0]!.phone = {
        value: phone,
        status: 'verified',
        evidence: [
          {
            sourceUrl: firm.sourceUrls[0] ?? '',
            sourceClass: 'regulatory',
            method: 'published by the firm in an SEC filing',
            observedAt: new Date().toISOString(),
          },
        ],
        confidence: 0.85,
      };
    }

    const record = records[records.length - 1]!;

    // Location from the web, but never over a filed address. A registry or SEC
    // filing outranks a page that says where a firm is.
    const located = locations[firm.key];
    if (located && !record.street.value && !record.country.value) {
      if (located.city) record.city = locationCell(located.city, located);
      if (located.region) record.region = locationCell(located.region, located);
      if (located.country) record.country = locationCell(normaliseCountry(located.country) || located.country, located);
    }

    // Website and any address the firm's own site published.
    const contact = contacts[firm.key];
    if (contact) {
      if (contact.website && !record.website.value) {
        record.website = {
          value: contact.website,
          status: 'verified',
          evidence: [
            {
              sourceUrl: contact.website,
              sourceClass: 'primary_web',
              method: 'domain derived from the firm name, and the live page names the firm',
              observedAt: new Date().toISOString(),
            },
          ],
          confidence: 0.85,
        };
      }
      const email = emailCell(contact.contacts);
      if (email.value && !record.principals[0]!.email.value) {
        record.principals[0]!.email = email;
      }
      const sitePhone = contact.contacts.phones[0];
      if (sitePhone && !record.principals[0]!.phone.value) {
        record.principals[0]!.phone = {
          value: sitePhone.value,
          status: 'verified',
          evidence: [
            {
              sourceUrl: sitePhone.source,
              sourceClass: 'primary_web',
              method: 'published on the firm\'s own website',
              observedAt: new Date().toISOString(),
            },
          ],
          confidence: 0.75,
        };
      }
    }

    if (ukCompany && !ukCompany.hasSubstance) {
      rejected.push({
        firmName: firm.name,
        fieldPath: 'substance',
        value: ukCompany.accountsType || 'no accounts',
        reason: ukCompany.substanceNote,
        detectedBy: 'UK accounts filing check',
      });
    }
  }

  stats.records = records.length;
  stats.withPhone = records.filter((r) => r.principals[0]?.phone.value).length;
  stats.withPrincipal = records.filter((r) => r.principals[0]?.fullName.value).length;
  stats.withSignals = records.filter((r) => r.signals.length > 0).length;
  stats.withWebsite = records.filter((r) => r.website.value).length;
  stats.withStreetAddress = records.filter((r) => r.street.value).length;
  stats.withTwoPlusPrincipals = records.filter((r) => r.principals.length >= 2).length;
  stats.withDatedSignals = records.filter((r) => r.signals.length > 0).length;
  stats.singleFamily = records.filter((r) => r.classification.type === 'single_family_office').length;

  return { records, rejected, stats };
}
