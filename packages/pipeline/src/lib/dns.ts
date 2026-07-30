/**
 * Moved to @fo/core/net/dns.js so packages/db can use it too.
 *
 * The Stage 2 database scripts were failing with ConnectTimeoutError against
 * Neon for exactly the reason this module exists, and could not import it while
 * it lived under packages/pipeline. Re-exported here so every Stage 1 import
 * keeps working unchanged.
 */
export * from '@fo/core/net/dns.js';
