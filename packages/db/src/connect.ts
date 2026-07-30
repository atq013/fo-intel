import 'dotenv/config';
import { neon } from '@neondatabase/serverless';
import { installResilientDns } from '@fo/core/net/dns.js';

/**
 * The only way Stage 2 code opens a database connection.
 *
 * Neon's serverless driver talks HTTP, so it goes through undici and inherits
 * undici's defaults: the system resolver, and a 10-second connect timeout. On
 * this machine the router's resolver returns intermittent SERVFAILs, which is
 * the whole reason `installResilientDns` exists -- it swaps in public resolvers
 * and raises the connect timeout to 15s.
 *
 * Stage 1 installed it as an import side-effect in three pipeline modules. The
 * Stage 2 database scripts were written without it and failed with
 * ConnectTimeoutError against api.*.neon.tech, which reads like Neon being down
 * and is actually local DNS. Routing every connection through one function is
 * what stops the next script from forgetting.
 */
export function connect(url = process.env.DATABASE_URL) {
  if (!url) throw new Error('DATABASE_URL not set');
  installResilientDns();
  return neon(url);
}

/**
 * Retry the wrapper for transient connection faults.
 *
 * Kept even though the DNS fix addresses the cause, because it does not address
 * every cause: Neon suspends idle compute and the first query after a suspend
 * can still time out while the instance wakes. Retrying a connection error is
 * safe; retrying a constraint violation would hide a real defect, so only
 * transport-shaped failures are retried and everything else rethrows at once.
 */
const TRANSIENT = /fetch failed|ECONNRESET|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|UND_ERR_CONNECT_TIMEOUT|Connect Timeout|socket hang up/i;

export async function withRetry<T>(fn: () => Promise<T>, attempts = 4, label = 'query'): Promise<T> {
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      const msg = err instanceof Error ? `${err.message} ${String((err as { sourceError?: unknown }).sourceError ?? '')}` : String(err);
      if (!TRANSIENT.test(msg)) throw err;
      if (i < attempts - 1) {
        const wait = 800 * 2 ** i;
        console.warn(`  ${label}: transient connection fault, retrying in ${wait}ms (${i + 1}/${attempts - 1})`);
        await new Promise((r) => setTimeout(r, wait));
      }
    }
  }
  throw lastErr;
}
