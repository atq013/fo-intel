import type {
  ClaimStatus,
  CommercialState,
  ContactChannel,
  ContactReaches,
  EvidenceRole,
  GateName,
  GateOutcome,
  RefreshPolicy,
  ReleaseDecisionKind,
  SourceKind,
  SourceTier,
  TrustState,
} from './vocab.js';

/**
 * A source class instance we can fetch from.
 */
export interface Source {
  id: string;
  kind: SourceKind;
  identifier: string;
  baseUrl?: string;
  tier: SourceTier;
  rateLimitPerMin: number;
  lastOkAt?: Date;
  consecutiveFailures: number;
}

/**
 * What a source returned, at a time. Immutable once written.
 *
 * `contentHash` is the whole staleness mechanism: re-fetching and getting the
 * same hash means nothing changed, and a different hash is a concrete reason to
 * re-extract. A clock alone never satisfies the brief's staleness requirement,
 * because "30 days elapsed" is not evidence that anything moved.
 */
export interface Observation {
  id: string;
  sourceId: string;
  url: string;
  fetchedAt: Date;
  contentHash: string;
  /** pointer to the raw body on disk, keyed by contentHash */
  rawRef?: string;
  httpStatus?: number;
  notes?: string;
  /** present in memory during extraction; never persisted on the row */
  body?: string;
}

/**
 * One act of reading one observation and deriving assertions from it.
 *
 * This is the row a claim and its establishing evidence share, and sharing it is
 * what makes the Stage 1 defect unexpressible.
 */
export interface ExtractionEvent {
  id: string;
  runId?: string;
  observationId: string;
  extractor: string;
  startedAt: Date;
  endedAt?: Date;
}

export interface Entity {
  id: string;
  canonicalName: string;
  entityType: string;
  firstSeenAt: Date;
  mergedIntoId?: string;
  trustState: TrustState;
  commercialState: CommercialState;
  /** ADR-11: two metrics, stored separately, never merged into one figure. */
  strictReachable: boolean;
  profileAssistedReachable: boolean;
}

export interface Claim {
  id: string;
  entityId: string;
  extractionEventId: string;
  field: string;
  value: unknown;
  valueType: string;
  status: ClaimStatus;
  confidence: number;
  refreshPolicy: RefreshPolicy;
  establishedAt: Date;
  expiresAt?: Date;
  supersededById?: string;
}

/**
 * The brand.
 *
 * This symbol is deliberately not exported. A module outside this directory can
 * name the `Evidence` type but cannot construct a value that satisfies it --
 * there is no way to write the property. Establishing evidence therefore has
 * exactly one origin in the codebase: the extraction-event writer, which is the
 * only thing that can mint it.
 *
 * The database enforces the same rule independently (PTC-10, the composite
 * foreign key). Two mechanisms, because the type system does not survive a JSON
 * boundary and the database does not catch mistakes at compile time.
 */
declare const EVIDENCE_BRAND: unique symbol;

export interface Evidence {
  id: string;
  claimId: string;
  observationId: string;
  extractionEventId: string;
  role: EvidenceRole;
  /** the exact text read; not a paraphrase and not a summary */
  spanText: string;
  spanStart?: number;
  spanEnd?: number;
  /** the sentence a customer reads. Must describe what was actually checked. */
  method: string;
  createdAt: Date;
  readonly [EVIDENCE_BRAND]: true;
}

/**
 * What a caller supplies. Note there is no claimId, no extractionEventId and no
 * role -- all three are supplied by the writer from the open event, so a caller
 * cannot point evidence at a claim it did not just derive.
 */
export interface EvidenceInput {
  observationId: string;
  spanText: string;
  spanStart?: number;
  spanEnd?: number;
  method: string;
}

export interface ClaimInput {
  entityId: string;
  field: string;
  value: unknown;
  valueType: string;
  confidence?: number;
  refreshPolicy?: RefreshPolicy;
  expiresAt?: Date;
}

/** A claim and the establishing evidence minted with it. Never separable. */
export interface Assertion {
  claim: Claim;
  establishing: Evidence;
}

export interface GateResult {
  gate: GateName;
  outcome: GateOutcome;
  band: 'A' | 'B';
  detail?: string;
  /**
   * What the claim would have been had this gate not fired. A gate whose
   * counterfactual never differs from the outcome is decorative, and §11 reads
   * this field to prove which gates are load-bearing.
   */
  counterfactual?: unknown;
}

export interface ReleaseDecision {
  claimId: string;
  decision: ReleaseDecisionKind;
  gatesPassed: GateName[];
  gatesFailed: GateName[];
  gatesSkipped: GateName[];
  policyVersion: string;
  reason?: string;
}

export interface CommercialDecision {
  entityId: string;
  commercialState: CommercialState;
  reason: string;
  missing: string[];
  policyVersion: string;
}

export interface Contact {
  id: string;
  entityId: string;
  personClaimId?: string;
  channel: ContactChannel;
  value: string;
  reaches: ContactReaches;
  ownershipEvidenceId?: string;
  verificationMethod?: string;
  verifiedAt?: Date;
  status: ClaimStatus;
  countsStrict: boolean;
  countsProfileAssisted: boolean;
}

export interface Signal {
  id: string;
  entityId: string;
  kind: string;
  summary: string;
  occurredAt: Date;
  evidenceId?: string;
  sourceTier: SourceTier;
}
