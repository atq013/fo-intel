/**
 * Compile-time negative tests. This file is checked by `npm run typecheck`.
 *
 * Every `@ts-expect-error` below asserts that the line under it does NOT
 * compile. If a future change makes any of them legal, TypeScript reports
 * "unused '@ts-expect-error' directive" and the build fails -- so this file
 * fails loudly in the direction that matters: the contract getting weaker.
 *
 * There are no runtime assertions here. Nothing is exported and nothing runs.
 */
import { openExtractionEvent } from './extraction.js';
import type { ClaimInput, Evidence, Observation } from './types.js';

const observation: Observation = {
  id: 'obs_1',
  sourceId: 'src_1',
  url: 'https://example.test/filing',
  fetchedAt: new Date(),
  contentHash: 'h',
};

const event = openExtractionEvent({ observation, extractor: 'type-test' });

const { claim } = event.assert(
  { entityId: 'ent_1', field: 'registered_address', value: '1 Test Street', valueType: 'address' },
  { observationId: observation.id, spanText: 'Registered office: 1 Test Street', method: 'read from the filing' },
);

// ---------------------------------------------------------------------------
// 1. The Stage 1 defect: evidence built by hand and assigned to a claim.
//    `build-dataset.ts:144` did exactly this with a plain object graph.
// ---------------------------------------------------------------------------

// @ts-expect-error - Evidence carries an unexported brand; no module outside
// extraction.ts can construct one, whatever fields it supplies.
const forged: Evidence = {
  id: 'ev_forged',
  claimId: claim.id,
  observationId: 'obs_somewhere_else',
  extractionEventId: 'xe_somewhere_else',
  role: 'establishing',
  spanText: "a quote about an entirely different fact",
  method: 'copied at assembly time',
  createdAt: new Date(),
};
void forged;

// ---------------------------------------------------------------------------
// 2. Attaching establishing evidence after the fact.
//    `attach()` excludes the role from its own type, so this is not a rule a
//    caller can forget -- it is a sentence they cannot write.
// ---------------------------------------------------------------------------

// @ts-expect-error - 'establishing' is not assignable to Exclude<EvidenceRole, 'establishing'>
event.attach(claim.id, 'establishing', {
  observationId: observation.id,
  spanText: 'some later quote',
  method: 'attached afterwards',
});

// The permitted roles must keep working, or the contract is merely restrictive
// rather than correct. These lines carry no directive and must compile.
event.attach(claim.id, 'corroborating', {
  observationId: observation.id,
  spanText: 'an independent source agreeing',
  method: 'independent confirmation',
});
event.attach(claim.id, 'conflicting', {
  observationId: observation.id,
  spanText: 'an independent source disagreeing',
  method: 'independent source disagrees',
});

// ---------------------------------------------------------------------------
// 3. Claims are minted with status 'candidate' and cannot be waved to released.
//    Release happens through the release gate or not at all.
// ---------------------------------------------------------------------------

// @ts-expect-error - 'status' is not part of ClaimInput; a caller cannot ask for one
const presetStatus: ClaimInput = { entityId: 'e', field: 'name', value: 'X', valueType: 'string', status: 'released' };
void presetStatus;

// ---------------------------------------------------------------------------
// 4. A claim cannot be asserted without a span. There is no overload that omits
//    the evidence argument, so "add the basis later" has no expression.
// ---------------------------------------------------------------------------

// @ts-expect-error - Expected 2 arguments, but got 1
event.assert({ entityId: 'ent_1', field: 'name', value: 'X', valueType: 'string' });
