import type { Gate } from '@fo/core/contract/index.js';
import { schemaGate } from './schema.js';
import { attributionGate } from './attribution.js';
import { valueTypeGate } from './value-type.js';
import { identityGate } from './identity.js';
import { contactOwnershipGate } from './contact-ownership.js';
import { coherenceGate } from './coherence.js';

export * from './schema.js';
export * from './attribution.js';
export * from './value-type.js';
export * from './identity.js';
export * from './contact-ownership.js';
export * from './coherence.js';
export * from './derivation.js';

/** Build order from the roadmap. Order within a band does not affect outcome. */
export const GATES: Gate[] = [
  schemaGate,
  attributionGate,
  valueTypeGate,
  identityGate,
  contactOwnershipGate,
  coherenceGate,
];
