import type { Claim, Gate, GateContext, GateResult } from '@fo/core/contract/index.js';

/**
 * Gate 6 · coherence — is the record true as a whole?
 *
 * A composite value is one a customer reads as a single fact. A postal address
 * is the obvious case: street, postcode and city are separate columns but one
 * assertion, and assembling them from different readings produces a record where
 * every field is individually defensible and the address does not exist.
 *
 * **Why this gate keys on the extraction event and not the source URL.**
 *
 * Measuring the Stage 1 dataset settled this. Across the 39 delivered records
 * with a composite address, the number whose parts cite different source URLs is
 * *zero* -- and the addresses are still wrong. Kopp shipped street 701 CARLSON
 * PARKWAY with postcode 55305 (Minnetonka) and city BLOOMINGTON, while the cited
 * filing gives 8400 NORMANDALE LAKE BOULEVARD, BLOOMINGTON 55437. All four parts
 * name the same URL.
 *
 * They agree on the URL *because the evidence was copied*. Uniform provenance
 * was the fingerprint of the mis-wiring, not a sign of coherence. Any check
 * asking "do these parts share a source?" would have passed the Kopp record and
 * every record like it.
 *
 * The extraction event is the thing a copy cannot fake: it is minted per act of
 * reading, and a value derived from a different reading carries a different one
 * whether or not the URLs match. That is only checkable because M1 made the
 * event an identity relationship rather than a field.
 */

/** Fields a customer reads as one fact. */
export const COMPOSITES: Record<string, string[]> = {
  address: ['street', 'postcode', 'city', 'region', 'country'],
};

export function componentsOf(field: string): { composite: string; members: string[] } | null {
  for (const [composite, members] of Object.entries(COMPOSITES)) {
    if (members.includes(field)) return { composite, members };
  }
  return null;
}

export const coherenceGate: Gate = {
  name: 'coherence',
  band: 'A',
  async evaluate(claim: Claim, ctx: GateContext): Promise<GateResult> {
    const part = componentsOf(claim.field);
    if (!part) {
      return { gate: 'coherence', outcome: 'skipped', band: 'A', detail: 'not part of a composite value' };
    }

    const siblings = ctx.siblings.filter(
      (c) => c.id !== claim.id && part.members.includes(c.field) && c.status !== 'quarantined',
    );
    if (siblings.length === 0) {
      return { gate: 'coherence', outcome: 'passed', band: 'A', detail: `sole component of ${part.composite}` };
    }

    const foreign = siblings.filter((c) => c.extractionEventId !== claim.extractionEventId);
    if (foreign.length === 0) {
      return {
        gate: 'coherence',
        outcome: 'passed',
        band: 'A',
        detail: `all ${siblings.length + 1} components of ${part.composite} derive from one reading`,
      };
    }

    return {
      gate: 'coherence',
      outcome: 'failed',
      band: 'A',
      detail: `${part.composite} assembled across ${new Set([claim.extractionEventId, ...foreign.map((f) => f.extractionEventId)]).size} readings: ${foreign.map((f) => f.field).join(', ')} came from elsewhere`,
      counterfactual: {
        wouldHaveReleased: `${part.composite} combining ${claim.field}=${String(claim.value)} with ${foreign.map((f) => `${f.field}=${String(f.value)}`).join(', ')}`,
        fromDistinctReadings: true,
      },
    };
  },
};
