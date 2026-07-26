/**
 * Discovery channel: SEC Form 13F quarterly datasets.
 *
 * Any manager holding over $100M in listed US equities must file 13F. That makes
 * the quarterly dataset a complete census of institutional managers above that
 * line - including family offices, which is what we are after.
 *
 * The naive filter is a name match on "family". It finds 73 firms out of ~9,900
 * and misses every single-family office that does not put the word in its name,
 * which is most of the valuable ones. So this module scores structural signals
 * instead.
 *
 * Nothing here classifies a firm. This produces a ranked candidate pool for the
 * evidence stage to confirm or reject. Scores are hypotheses, not findings.
 */
import { join } from 'node:path';
import type { Discovery } from '@fo/core';
import { readTsv } from '../lib/tsv.js';

const DATA_DIR = join(process.cwd(), 'data/raw/sec');

export interface Candidate {
  name: string;
  city: string;
  state: string;
  street: string;
  /** Direct line published in the filing. Regulatory-grade contact data. */
  signatoryName: string;
  signatoryTitle: string;
  signatoryPhone: string;
  hasCrd: boolean;
  positions: number;
  portfolioValue: number;
  otherManagers: number;
  addressCohort: number;
  score: number;
  reasons: string[];
}

/**
 * Entities that file 13F but are structurally not family offices. Screened out
 * before scoring so the pool stays worth reading.
 */
const EXCLUDE = [
  /\b(bank|bancorp|bancshares|banque|credit union|savings)\b/i,
  /\b(insurance|assurance|mutual life|life insurance)\b/i,
  /\b(securities|brokerage|broker|clearing)\b/i,
  /\b(pension|retirement system|teachers|municipal|state of|city of|county)\b/i,
  /\b(university|college|endowment|foundation trust)\b/i,
  /\b(etf|index fund|mutual fund|fund services)\b/i,
];

/**
 * The address-cohort signal has a false-positive mode found by reading the first
 * run: VC and PE firms register a numbered vehicle per fund at one address, so
 * Khosla Ventures, Foresite Capital and Yorktown Energy all scored like family
 * clusters. Sequential vehicle naming is the tell that separates them - a family
 * office does not raise Fund V.
 */
const FUND_SEQUENCE = /(\b(fund|partners|associates|ventures|capital)\b.*\b([IVX]{1,5}|\d{1,2})\b\s*,?\s*(l\.?p\.?|llc|ltd)?$)|(\b[IVX]{2,5}\b\s*,?\s*(l\.?p\.?|llc)?$)/i;

/**
 * Weak positive signals. Weak on purpose: any single one of these is common in
 * ordinary asset managers. The hypothesis is that co-occurrence is rare.
 */
const NAME_HINTS: Array<[RegExp, number, string]> = [
  [/\bfamily (office|partners|capital|holdings|investments?|trust|group)\b/i, 40, 'name states family vehicle'],
  [/\bfamil(y|ies)\b/i, 18, 'name mentions family'],
  [/\b(legacy|heritage|dynasty|generations?|descendants)\b/i, 14, 'succession language in name'],
  [/\b(holdings?|enterprises|ventures)\b.*\b(llc|inc|lp|ltd)\b/i, 6, 'holding-company form'],
  [/^\d{4}\b/, 12, 'year-named entity (common for family vehicles)'],
  [/\b(trust|trustees)\b/i, 8, 'trust in name'],
];

/** A compliance-titled signatory implies a regulated adviser; an owner-operator title does not. */
const TITLE_HINTS: Array<[RegExp, number, string]> = [
  [/\b(trustee|managing member|member|owner|principal)\b/i, 16, 'owner-operator signatory title'],
  [/\b(president|chief investment officer|cio)\b/i, 10, 'principal-level signatory'],
  [/\bchief compliance officer|cco\b/i, -18, 'compliance-officer signatory implies registered adviser'],
  [/\b(general counsel|counsel)\b/i, -6, 'legal signatory implies larger firm'],
];

function normaliseAddress(street: string, city: string, state: string) {
  return `${street} ${city} ${state}`.toLowerCase().replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, ' ').trim();
}

export function scoreCandidates(): Candidate[] {
  const coverpages = readTsv(join(DATA_DIR, 'COVERPAGE.tsv'));
  const signatures = readTsv(join(DATA_DIR, 'SIGNATURE.tsv'));
  const summaries = readTsv(join(DATA_DIR, 'SUMMARYPAGE.tsv'));

  const sigByAccession = new Map(signatures.map((s) => [s.ACCESSION_NUMBER!, s]));
  const sumByAccession = new Map(summaries.map((s) => [s.ACCESSION_NUMBER!, s]));

  // Collapse to one row per manager, keeping the most recent filing.
  const latest = new Map<string, Record<string, string>>();
  for (const row of coverpages) {
    const name = row.FILINGMANAGER_NAME?.trim();
    if (!name) continue;
    const prev = latest.get(name);
    if (!prev || (row.DATEREPORTED ?? '') > (prev.DATEREPORTED ?? '')) latest.set(name, row);
  }

  // Family offices frequently register several vehicles at one address. Count the
  // cohort before scoring so each member can be credited for it.
  const cohort = new Map<string, number>();
  // An address is contaminated when any entity there is structurally excluded, or
  // when the cohort is really a numbered fund family. "American Family Investments"
  // is not a family office - it shares an address with American Family Insurance.
  const contaminated = new Set<string>();

  for (const row of latest.values()) {
    const key = normaliseAddress(row.FILINGMANAGER_STREET1 ?? '', row.FILINGMANAGER_CITY ?? '', row.FILINGMANAGER_STATEORCOUNTRY ?? '');
    if (!key) continue;
    cohort.set(key, (cohort.get(key) ?? 0) + 1);
    const name = row.FILINGMANAGER_NAME ?? '';
    if (EXCLUDE.some((re) => re.test(name)) || FUND_SEQUENCE.test(name)) contaminated.add(key);
  }

  const out: Candidate[] = [];

  for (const [name, row] of latest) {
    if (EXCLUDE.some((re) => re.test(name))) continue;

    const accession = row.ACCESSION_NUMBER ?? '';
    const sig = sigByAccession.get(accession);
    const sum = sumByAccession.get(accession);

    const hasCrd = Boolean(row.CRDNUMBER?.trim());
    const positions = Number(sum?.TABLEENTRYTOTAL ?? 0);
    const portfolioValue = Number(sum?.TABLEVALUETOTAL ?? 0);
    const otherManagers = Number(sum?.OTHERINCLUDEDMANAGERSCOUNT ?? 0);
    const addressKey = normaliseAddress(row.FILINGMANAGER_STREET1 ?? '', row.FILINGMANAGER_CITY ?? '', row.FILINGMANAGER_STATEORCOUNTRY ?? '');
    const addressCohort = cohort.get(addressKey) ?? 1;

    let score = 0;
    const reasons: string[] = [];

    // The load-bearing signal: managing >$100M while holding no adviser CRD is
    // consistent with relying on the family-office exclusion from registration.
    if (!hasCrd) {
      score += 30;
      reasons.push('no adviser CRD despite 13F-scale assets');
    }

    if (FUND_SEQUENCE.test(name)) {
      score -= 45;
      reasons.push('sequential fund vehicle, not a family entity');
    }

    if (addressCohort >= 2 && !contaminated.has(addressKey)) {
      score += Math.min(10 * addressCohort, 30);
      reasons.push(`${addressCohort} filing entities share this address`);
    } else if (addressCohort >= 2) {
      reasons.push(`${addressCohort} entities share this address, but the cohort is a fund family or excluded business`);
    }

    if (otherManagers === 0) {
      score += 6;
      reasons.push('no other included managers');
    }

    // Concentration cuts both ways, so it is worth little on its own.
    if (positions > 0 && positions <= 25) {
      score += 10;
      reasons.push(`concentrated book (${positions} positions)`);
    } else if (positions > 300) {
      score -= 10;
      reasons.push(`broad book (${positions} positions) looks like an asset manager`);
    }

    for (const [re, weight, why] of NAME_HINTS) {
      if (re.test(name)) {
        score += weight;
        reasons.push(why);
        break;
      }
    }

    for (const [re, weight, why] of TITLE_HINTS) {
      if (sig?.TITLE && re.test(sig.TITLE)) {
        score += weight;
        reasons.push(why);
        break;
      }
    }

    out.push({
      name,
      city: row.FILINGMANAGER_CITY ?? '',
      state: row.FILINGMANAGER_STATEORCOUNTRY ?? '',
      street: row.FILINGMANAGER_STREET1 ?? '',
      signatoryName: sig?.NAME ?? '',
      signatoryTitle: sig?.TITLE ?? '',
      signatoryPhone: sig?.PHONE ?? '',
      hasCrd,
      positions,
      portfolioValue,
      otherManagers,
      addressCohort,
      score,
      reasons,
    });
  }

  return out.sort((a, b) => b.score - a.score);
}

export function toDiscovery(c: Candidate, sourceUrl: string): Discovery {
  return {
    channel: 'sec_13f',
    sourceUrl,
    discoveredAt: new Date().toISOString(),
    rawName: c.name,
  };
}
