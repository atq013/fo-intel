/**
 * Phase 0 · Reachability feasibility spike  (STAGE2_SPEC.md §15 D1)
 *
 * 200 of 500 delivered records must carry a contact route that demonstrably
 * reaches a NAMED INDIVIDUAL. Stage 1 produced roughly one. Validation cannot
 * create contacts, so this is a sourcing question and it has to be answered
 * before the collect module is written.
 *
 * This measures seven metrics per channel over a stratified sample drawn from
 * the candidate pools already on disk. It performs no new discovery and writes
 * nothing to the production schema.
 *
 * The output is a decision, not a dataset.
 */
import { readFileSync, existsSync } from 'node:fs';

export type Channel =
  | 'sec_signatory'
  | 'sec_adv'
  | 'firm_leadership_page'
  | 'principal_profile'
  | 'regulatory_signature'
  | 'conference_profile';

/** The seven metrics fixed in the spec before collection, so the comparison is honest. */
export interface ChannelMetrics {
  channel: Channel;
  candidatesAttempted: number;
  personIdentified: number;
  routeFound: number;
  ownershipEvidenced: number;
  passesGate5: number;
  costPerQualified: { apiCalls: number; wallMs: number; perQualified: number | null };
  sourceConcentrationDelta: string;
  notes: string[];
}

export interface SpikeCandidate {
  channel: Channel;
  firmName: string;
  /** Whatever identifier the channel keys on: CIK, company number, URL. */
  externalId?: string;
  location?: string;
  /** A named human already known from the pool, if the channel supplies one. */
  knownPerson?: string;
  knownTitle?: string;
  /** A contact value already present in the pool, if any. */
  knownRoute?: { channel: 'email' | 'phone'; value: string; source: string };
}

/** Reads a Stage 1 pool without assuming its shape survived. */
export function readPool<T>(path: string, key?: string): T[] {
  if (!existsSync(path)) return [];
  const parsed = JSON.parse(readFileSync(path, 'utf8'));
  if (Array.isArray(parsed)) return parsed as T[];
  if (key && Array.isArray(parsed[key])) return parsed[key] as T[];
  return [];
}

export const digits = (s: string | undefined | null): string =>
  (s ?? '').replace(/\D/g, '').slice(-10);

/**
 * A route is disqualified before any network call when its shape alone proves it
 * cannot reach an individual. Cheap, deterministic, and it encodes the corrected
 * Stage 1 standard directly.
 */
const ROLE_MAILBOX =
  /^(info|contact|hello|enquiries|inquiries|admin|office|mail|team|support|sales|general|reception)@/i;

export function shapeDisqualifies(route: { channel: string; value: string }): string | null {
  if (route.channel === 'email') {
    if (ROLE_MAILBOX.test(route.value)) return 'role mailbox, reaches a company not a person';
    if (!/^[^@\s]+@[^@\s]+\.[a-z]{2,}$/i.test(route.value)) return 'not a valid address';
  }
  if (route.channel === 'phone') {
    const d = digits(route.value);
    if (d.length < 9) return 'malformed number';
    // Stage 1 shipped a machine timestamp as a phone number on one record.
    if (/^(19|20)\d{8,}$/.test(route.value.replace(/\D/g, ''))) return 'looks like a timestamp, not a number';
  }
  return null;
}
