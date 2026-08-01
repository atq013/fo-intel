export * from './schema.js';
export * from './models.js';
export * from './meter.js';

// The Stage 2 contract is NOT re-exported here on purpose. Stage 1's schema
// exports its own `Evidence` and `Signal`, and the Stage 1 `Evidence` is the
// loose, assignable shape that made the mis-wiring possible. Flattening both
// into one barrel would let an import pick the defective one silently.
// Import the contract explicitly:  from '@fo/core/contract/index.js'
