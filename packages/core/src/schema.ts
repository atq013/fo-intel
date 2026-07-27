/**
 * The record contract. Imported by both the pipeline and the web app so that
 * anything rendered to a user is the same shape the pipeline validated.
 */

export type SourceClass =
  | 'regulatory' // SEC, IRS, other statutory filings
  | 'registry' // company registries, state SOS, Companies House
  | 'primary_web' // the firm's own site or its principals' own profiles
  | 'third_party' // press, conference programmes, job boards
  | 'vendor'; // paid/freemium data services - always named

export interface Evidence {
  sourceUrl: string;
  sourceClass: SourceClass;
  /** How the value was confirmed. Surfaced to the user verbatim, so write it in plain English. */
  method: string;
  observedAt: string;
  /** Named plainly whenever a commercial service touched this value. */
  vendor?: string;
}

export type CellStatus =
  | 'verified' // published on an authoritative source and checked
  | 'inferred' // derived (e.g. email pattern) and not independently confirmed
  | 'could_not_verify' // looked for it, could not establish it
  | 'rejected'; // our own validation found it invalid - must not ship

/**
 * No high-value value is ever a bare primitive. A cell carries its own basis,
 * which is what lets the UI show provenance without the pipeline and the app
 * having to agree on a side channel.
 */
export interface Cell<T> {
  value: T | null;
  status: CellStatus;
  evidence: Evidence[];
  /** 0-1. Drives the retrieval confidence gate, not just display. */
  confidence: number;
  /** Reason, when status is could_not_verify or rejected. */
  note?: string;
}

export type FirmType =
  | 'single_family_office'
  | 'multi_family_office'
  | 'advisory_or_wealth_manager'
  | 'unconfirmed';

/**
 * Firm type is held to a stricter standard than any individual cell: a cell may
 * be honestly uncertain, a firm may not. `qualifies` is false unless we hold
 * affirmative evidence of what the firm actually is.
 */
export interface Classification {
  type: FirmType;
  evidence: Evidence[];
  /** Rule ids from docs/INCLUSION_RUBRIC.md that fired for this firm. */
  rulesMatched: string[];
  confidence: number;
  qualifies: boolean;
  note?: string;
}

export type DiscoveryChannel =
  | 'sec_13f'
  | 'sec_13dg'
  | 'sec_form_d'
  | 'sec_adv'
  | 'irs_990pf'
  | 'companies_house'
  | 'state_registry'
  | 'conference_programme'
  | 'job_posting'
  | 'news'
  | 'wealth_first';

/**
 * Kept deliberately separate from Evidence. A source that told us a firm exists
 * is not thereby allowed to tell us what the firm is.
 */
export interface Discovery {
  channel: DiscoveryChannel;
  sourceUrl: string;
  discoveredAt: string;
  /** CIK, EIN, company number - whatever the channel keys on. */
  externalId?: string;
  rawName: string;
}

export interface Signal {
  kind: 'investment' | 'fund_commitment' | 'key_hire' | 'news' | 'filing';
  summary: string;
  /** Undated signals are not intelligence. Records without a date are dropped at emit. */
  occurredAt: string;
  evidence: Evidence;
}

export interface Principal {
  fullName: Cell<string>;
  title: Cell<string>;
  /** Set when a statutory register records this person as controlling the entity. */
  controlBasis?: Cell<string>;
  linkedinUrl: Cell<string>;
  email: Cell<string>;
  phone: Cell<string>;
  location: Cell<string>;
}

export interface FamilyOffice {
  id: string;
  legalName: string;
  /** Every channel that independently surfaced this firm. Length > 1 is corroboration. */
  discoveries: Discovery[];
  classification: Classification;

  description: Cell<string>;
  investmentThesis: Cell<string>;
  sectors: Cell<string[]>;
  aum: Cell<number>;
  website: Cell<string>;
  linkedinUrl: Cell<string>;
  street: Cell<string>;
  postcode: Cell<string>;
  city: Cell<string>;
  region: Cell<string>;
  country: Cell<string>;

  principals: Principal[];
  signals: Signal[];

  createdAt: string;
  updatedAt: string;
}

export function emptyCell<T>(note?: string): Cell<T> {
  return { value: null, status: 'could_not_verify', evidence: [], confidence: 0, note };
}

/** Cells the customer sees. A rejected value in any of these blocks the record at emit. */
export const CUSTOMER_FACING_PATHS = [
  'website',
  'linkedinUrl',
  'principals[].email',
  'principals[].phone',
  'principals[].linkedinUrl',
] as const;
