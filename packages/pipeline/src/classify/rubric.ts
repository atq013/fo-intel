/**
 * The inclusion rubric, in code. Prose version in docs/INCLUSION_RUBRIC.md - the
 * two must agree, so rule ids are shared between them.
 *
 * The governing principle: a firm qualifies on affirmative evidence of what it
 * is, never on the absence of evidence that it is something else. A firm we
 * merely failed to disprove is 'unconfirmed' and does not count toward the 50.
 *
 * This is deliberately stricter than the standard applied to individual cells.
 * A cell may be honestly blank. A firm may not be honestly ambiguous and still
 * ship as a family office.
 */
import type { Classification, Evidence, FirmType } from '@fo/core';

export interface RuleInput {
  name: string;
  /** UK PSC register: surnames shared between entity name and controlling persons. */
  ukSharedSurnames?: string[];
  ukControllerName?: string;
  ukHasSubstance?: boolean;
  ukCompanyNumber?: string;
  /** Verbatim quote from a web page, already checked to appear in that page. */
  webQuote?: string;
  webTypeClaim?: 'single_family_office' | 'multi_family_office' | 'unclear';
  webSourceUrl?: string;
  /** SEC submissions API. */
  secEntityType?: string;
  secIsOperating?: boolean;
  secHasCrd?: boolean;
  secCik?: string;
  /** 13F structural score. */
  structuralScore?: number;
  /** How many independent channels surfaced this firm. */
  channelCount: number;
}

export interface Rule {
  id: string;
  describes: FirmType | 'exclusion';
  /** Confidence contributed when the rule fires. Exclusions use 0. */
  weight: number;
  summary: string;
  test: (i: RuleInput) => boolean;
  evidence?: (i: RuleInput) => Evidence | null;
}

const MARKETS_TO_MULTIPLE = /\b(multi[- ]?family office|serving families|our clients|client families|fee schedule)\b/i;

export const RULES: Rule[] = [
  {
    id: 'SFO-1',
    describes: 'single_family_office',
    weight: 0.85,
    summary: 'A statutory control register names an individual whose surname matches the entity name',
    test: (i) => Boolean(i.ukSharedSurnames?.length && i.ukHasSubstance),
    evidence: (i) => ({
      sourceUrl: `https://find-and-update.company-information.service.gov.uk/company/${i.ukCompanyNumber}`,
      sourceClass: 'registry',
      method: `UK Persons with Significant Control register names ${i.ukControllerName} as controlling ${i.name}`,
      observedAt: new Date().toISOString(),
    }),
  },
  {
    id: 'SFO-2',
    describes: 'single_family_office',
    weight: 0.6,
    summary: 'A cited page states in its own words that the firm is a single-family office',
    test: (i) => i.webTypeClaim === 'single_family_office' && Boolean(i.webQuote),
    evidence: (i) => ({
      sourceUrl: i.webSourceUrl ?? '',
      sourceClass: 'third_party',
      method: `page states: "${(i.webQuote ?? '').slice(0, 180)}"`,
      observedAt: new Date().toISOString(),
    }),
  },
  {
    id: 'MFO-1',
    describes: 'multi_family_office',
    weight: 0.6,
    summary: 'A cited page states the firm is a multi-family office, or it markets to multiple families',
    test: (i) =>
      i.webTypeClaim === 'multi_family_office' || (Boolean(i.webQuote) && MARKETS_TO_MULTIPLE.test(i.webQuote ?? '')),
    evidence: (i) => ({
      sourceUrl: i.webSourceUrl ?? '',
      sourceClass: 'third_party',
      method: `page states: "${(i.webQuote ?? '').slice(0, 180)}"`,
      observedAt: new Date().toISOString(),
    }),
  },
  {
    id: 'X-1',
    describes: 'exclusion',
    weight: 0,
    summary: 'SEC classifies the entity as an operating business, not an investment vehicle',
    test: (i) => i.secIsOperating === true,
  },
  {
    id: 'X-2',
    describes: 'exclusion',
    weight: 0,
    summary: 'Name identifies a bank, insurer, broker, or public institution',
    test: (i) =>
      /\b(bank|bancorp|insurance|assurance|securities|brokerage|pension|university|endowment|municipal)\b/i.test(i.name),
  },
  {
    id: 'X-3',
    describes: 'exclusion',
    weight: 0,
    summary: 'Sequentially numbered fund vehicle rather than a family entity',
    test: (i) => /\b(fund|partners|associates|ventures)\b.*\b([IVX]{1,5}|\d{1,2})\b\s*,?\s*(l\.?p\.?|llc)?$/i.test(i.name),
  },
  {
    id: 'X-4',
    describes: 'exclusion',
    summary: 'UK entity with no filed accounts, or filing as dormant or micro-entity',
    weight: 0,
    test: (i) => i.ukCompanyNumber !== undefined && i.ukHasSubstance === false,
  },
];

/**
 * Structural signals from 13F - no adviser CRD, concentrated book, entity
 * clustering - are deliberately given no qualifying weight. They are good enough
 * to justify investigating a firm and not good enough to assert what it is.
 * Presenting an unconfirmed firm as a proven family office is the most serious
 * error available in this domain, so the pool is allowed to be large and the
 * qualifying set is not.
 */
export const STRUCTURAL_SIGNALS_DO_NOT_QUALIFY = true;

export function classify(input: RuleInput): Classification {
  const fired = RULES.filter((r) => r.test(input));
  const exclusions = fired.filter((r) => r.describes === 'exclusion');

  if (exclusions.length > 0) {
    return {
      type: 'advisory_or_wealth_manager',
      evidence: [],
      rulesMatched: exclusions.map((r) => r.id),
      confidence: 0,
      qualifies: false,
      note: exclusions[0]!.summary,
    };
  }

  const qualifying = fired.filter((r) => r.describes !== 'exclusion');
  if (qualifying.length === 0) {
    return {
      type: 'unconfirmed',
      evidence: [],
      rulesMatched: [],
      confidence: 0,
      qualifies: false,
      note: 'no affirmative evidence of firm type; discovery signals alone do not qualify a record',
    };
  }

  const best = qualifying.reduce((a, b) => (b.weight > a.weight ? b : a));
  const evidence = qualifying.map((r) => r.evidence?.(input)).filter((e): e is Evidence => Boolean(e));

  // Independent corroboration raises confidence but cannot manufacture it.
  const corroboration = Math.min((input.channelCount - 1) * 0.05, 0.1);

  return {
    type: best.describes as FirmType,
    evidence,
    rulesMatched: qualifying.map((r) => r.id),
    confidence: Math.min(best.weight + corroboration, 0.95),
    qualifies: true,
  };
}
