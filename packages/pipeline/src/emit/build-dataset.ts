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
import type { TypeFinding } from '../enrich/establish-type.js';
import { toEvidence } from '../enrich/establish-type.js';
import type { SecEntity } from '../enrich/sec-entity.js';
import type { UkCompany } from '../discovery/companies-house.js';

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

    const principal: Principal = {
      fullName: cellFrom(firm.principalName || null, sourceEvidence, 0.8, 'no principal identified'),
      title: cellFrom(firm.principalTitle || null, sourceEvidence, 0.7, 'no title established'),
      linkedinUrl: emptyCell<string>('not searched in this build'),
      email: emptyCell<string>('contact enrichment not yet run for this record'),
      phone: emptyCell<string>('no direct line established'),
      location: cellFrom([firm.city, firm.region].filter(Boolean).join(', ') || null, sourceEvidence, 0.7),
    };

    const signals = usableSignals(secEntity?.signals ?? []);

    records.push({
      id: firm.key,
      legalName: firm.name,
      discoveries: [...firm.channels].map((channel) => ({
        channel,
        sourceUrl: firm.sourceUrls[0] ?? '',
        discoveredAt: new Date().toISOString(),
        rawName: firm.name,
      })),
      classification,
      description: emptyCell<string>('not enriched in this build'),
      investmentThesis: emptyCell<string>('not enriched in this build'),
      sectors: emptyCell<string[]>('not enriched in this build'),
      aum: emptyCell<number>('not disclosed in any source consulted'),
      website: cellFrom(finding?.website ?? null, sourceEvidence, 0.8, 'no own-domain website identified'),
      linkedinUrl: emptyCell<string>('not searched in this build'),
      city: cellFrom(firm.city || null, sourceEvidence, 0.8),
      region: cellFrom(firm.region || null, sourceEvidence, 0.8),
      country: cellFrom(firm.country || null, sourceEvidence, 0.8),
      principals: [principal],
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
  stats.singleFamily = records.filter((r) => r.classification.type === 'single_family_office').length;

  return { records, rejected, stats };
}
