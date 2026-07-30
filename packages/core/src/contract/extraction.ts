import { randomUUID } from 'node:crypto';
import type {
  Assertion,
  Claim,
  ClaimInput,
  Evidence,
  EvidenceInput,
  ExtractionEvent,
  Observation,
} from './types.js';
import type { EvidenceRole } from './vocab.js';

/**
 * The only place in the codebase that constructs Evidence.
 *
 * Stage 1 shipped 93 values wearing evidence belonging to a different fact. The
 * mechanism was mundane: evidence was an ordinary array field, so
 * `build-dataset.ts:144` could do `classification.evidence.slice()` and hand the
 * same classification quote to nine unrelated values at assembly time. Nothing
 * in the code objected, because nothing in the code could.
 *
 * The fix is not a rule about where evidence may be assigned. It is that a claim
 * and its establishing evidence are minted together, by one call, from one open
 * event -- so there is no moment at which a claim exists without its basis and
 * could be given someone else's.
 *
 * Three things hold the line, and they fail independently:
 *
 *   1. `Evidence` carries an unexported brand, so no other module can build one.
 *   2. `assert()` is the only function that emits role `establishing`, and it
 *      emits it inseparably from the claim it belongs to.
 *   3. The database refuses the write anyway (composite FK, PTC-10) -- because
 *      the type system does not survive a JSON boundary.
 */

/** Minted with the brand. Local to this module by construction. */
function mintEvidence(
  claimId: string,
  eventId: string,
  role: EvidenceRole,
  input: EvidenceInput,
): Evidence {
  return {
    id: `ev_${randomUUID()}`,
    claimId,
    observationId: input.observationId,
    extractionEventId: eventId,
    role,
    spanText: input.spanText,
    spanStart: input.spanStart,
    spanEnd: input.spanEnd,
    method: input.method,
    createdAt: new Date(),
  } as Evidence;
}

export interface OpenExtractionEvent {
  readonly event: ExtractionEvent;

  /**
   * Derive a value from the observation being read, together with the span that
   * establishes it. The two are returned as one object and written in one
   * transaction; there is no ordering in which the claim exists first.
   *
   * `spanText` must be text actually present in the observation. Gate 2
   * (`attribution`) re-checks that independently -- this signature makes the
   * mistake awkward, the gate makes it detectable.
   */
  assert(claim: ClaimInput, evidence: EvidenceInput): Assertion;

  /**
   * Attach evidence to a claim established elsewhere -- a second source that
   * agrees, one that disagrees, or one that replaces the value.
   *
   * Deliberately cannot express `establishing`: that role is unavailable in this
   * signature's type, so "attach the establishing evidence afterwards" is not a
   * thing a caller can write, whatever they intend.
   */
  attach(
    claimId: string,
    role: Exclude<EvidenceRole, 'establishing'>,
    evidence: EvidenceInput,
  ): Evidence;

  /** Everything derived in this event, for a single transactional write. */
  close(): { event: ExtractionEvent; assertions: Assertion[]; attached: Evidence[] };
}

export function openExtractionEvent(opts: {
  observation: Observation;
  extractor: string;
  runId?: string;
}): OpenExtractionEvent {
  const event: ExtractionEvent = {
    id: `xe_${randomUUID()}`,
    runId: opts.runId,
    observationId: opts.observation.id,
    extractor: opts.extractor,
    startedAt: new Date(),
  };

  const assertions: Assertion[] = [];
  const attached: Evidence[] = [];
  let closed = false;

  const guard = () => {
    // A closed event has already been written. Deriving into it afterwards would
    // produce claims whose evidence never reaches the database -- silently, and
    // only visible later as a claim with no basis.
    if (closed) throw new Error(`extraction event ${event.id} is closed`);
  };

  return {
    event,

    assert(input, evidenceInput) {
      guard();
      if (!evidenceInput.spanText.trim()) {
        throw new Error(`empty span for ${input.field}: evidence must quote something`);
      }
      const claim: Claim = {
        id: `cl_${randomUUID()}`,
        entityId: input.entityId,
        extractionEventId: event.id,
        field: input.field,
        value: input.value,
        valueType: input.valueType,
        status: 'candidate',
        confidence: input.confidence ?? 0,
        refreshPolicy: input.refreshPolicy ?? 'statutory',
        establishedAt: new Date(),
        expiresAt: input.expiresAt,
      };
      const assertion: Assertion = {
        claim,
        establishing: mintEvidence(claim.id, event.id, 'establishing', evidenceInput),
      };
      assertions.push(assertion);
      return assertion;
    },

    attach(claimId, role, evidenceInput) {
      guard();
      const ev = mintEvidence(claimId, event.id, role, evidenceInput);
      attached.push(ev);
      return ev;
    },

    close() {
      guard();
      closed = true;
      event.endedAt = new Date();
      return { event, assertions, attached };
    },
  };
}
