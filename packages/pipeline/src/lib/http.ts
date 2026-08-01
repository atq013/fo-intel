import { recordHostCall } from '@fo/core';
import pLimit from 'p-limit';
import { installResilientDns } from './dns.js';

installResilientDns();

/**
 * SEC asks for a declared contact in the User-Agent and rate limits at 10 req/s.
 * We stay well under it - the pipeline is not in a hurry and a block costs hours.
 */
const SEC_USER_AGENT = process.env.SEC_USER_AGENT ?? 'fo-intel research (contact not set)';

const limiters = new Map<string, ReturnType<typeof pLimit>>();

/** Companies House allows 600 requests per 5 minutes; the rest are courtesy limits. */
function concurrencyFor(host: string) {
  if (host.endsWith('sec.gov')) return 4;
  if (host.includes('company-information.service.gov.uk')) return 2;
  return 8;
}

function limiterFor(host: string) {
  if (!limiters.has(host)) {
    limiters.set(host, pLimit(concurrencyFor(host)));
  }
  return limiters.get(host)!;
}

export interface FetchOptions {
  headers?: Record<string, string>;
  retries?: number;
  timeoutMs?: number;
}

export async function fetchText(url: string, opts: FetchOptions = {}): Promise<string> {
  const { retries = 3, timeoutMs = 30_000 } = opts;
  const host = new URL(url).host;
  const isSec = host.endsWith('sec.gov');

  return limiterFor(host)(async () => {
    let lastErr: unknown;

    for (let attempt = 0; attempt <= retries; attempt++) {
      if (attempt > 0) {
        await sleep(Math.min(2 ** attempt * 500, 8_000));
      }
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), timeoutMs);
      const startedAt = Date.now();

      try {
        const res = await fetch(url, {
          signal: ac.signal,
          headers: {
            'User-Agent': isSec ? SEC_USER_AGENT : 'fo-intel/0.1',
            'Accept-Encoding': 'gzip, deflate',
            ...opts.headers,
          },
        });

        // 403 from SEC means the User-Agent was rejected; retrying will not help.
        if (res.status === 403 && isSec) {
          throw new Error(`SEC rejected the request (403). Set SEC_USER_AGENT to "Name email@domain".`);
        }
        // Every attempt is counted, including the ones a retry later fixes.
        // A run that succeeded on the third try still made three calls, and the
        // rate limit at 5,000 records binds on attempts, not on successes.
        recordHostCall(host, Date.now() - startedAt, !res.ok);

        if (res.status === 429 || res.status >= 500) {
          lastErr = new Error(`${res.status} from ${host}`);
          continue;
        }
        if (!res.ok) {
          throw new Error(`${res.status} ${res.statusText} for ${url}`);
        }
        return await res.text();
      } catch (err) {
        // A throw before the response arrived -- timeout, DNS, connection reset.
        // It cost wall time and no bytes, and it is still a call that happened.
        if (!(err instanceof Error && err.message.includes('SEC rejected'))) {
          recordHostCall(host, Date.now() - startedAt, true);
        }
        lastErr = err;
        if (err instanceof Error && err.message.includes('SEC rejected')) throw err;
        // ENOTFOUND / EAI_AGAIN are transient here - the resolver is flaky, not the host.
      } finally {
        clearTimeout(timer);
      }
    }
    throw lastErr instanceof Error ? lastErr : new Error(`failed to fetch ${url}`);
  });
}

export async function fetchJson<T>(url: string, opts: FetchOptions = {}): Promise<T> {
  const body = await fetchText(url, { ...opts, headers: { Accept: 'application/json', ...opts.headers } });
  return JSON.parse(body) as T;
}

export function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
