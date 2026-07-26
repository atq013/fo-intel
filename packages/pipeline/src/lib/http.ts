import pLimit from 'p-limit';

/**
 * SEC asks for a declared contact in the User-Agent and rate limits at 10 req/s.
 * We stay well under it - the pipeline is not in a hurry and a block costs hours.
 */
const SEC_USER_AGENT = process.env.SEC_USER_AGENT ?? 'fo-intel research (contact not set)';

const limiters = new Map<string, ReturnType<typeof pLimit>>();

function limiterFor(host: string) {
  if (!limiters.has(host)) {
    limiters.set(host, pLimit(host.endsWith('sec.gov') ? 4 : 8));
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
        if (res.status === 429 || res.status >= 500) {
          lastErr = new Error(`${res.status} from ${host}`);
          continue;
        }
        if (!res.ok) {
          throw new Error(`${res.status} ${res.statusText} for ${url}`);
        }
        return await res.text();
      } catch (err) {
        lastErr = err;
        if (err instanceof Error && err.message.includes('SEC rejected')) throw err;
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
