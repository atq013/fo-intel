/**
 * DNS resilience.
 *
 * The machine this pipeline runs on sits behind a router whose resolver returns
 * intermittent SERVFAILs - observed failing on google.serper.dev and data.sec.gov
 * minutes apart, while public resolvers answered both correctly. Node's fetch
 * uses getaddrinfo, so dns.setServers() does not help; the resolver has to be
 * replaced at the socket layer.
 *
 * Left unhandled this surfaces as random ENOTFOUND failures scattered through a
 * long run, which is indistinguishable from a source being down and would
 * quietly cost records.
 */
import { Resolver } from 'node:dns/promises';
import type { LookupFunction } from 'node:net';
import { Agent, setGlobalDispatcher } from 'undici';

const PUBLIC_RESOLVERS = [
  ['1.1.1.1', '1.0.0.1'],
  ['8.8.8.8', '8.8.4.4'],
];

const cache = new Map<string, { address: string; family: number; expires: number }>();
const TTL_MS = 5 * 60_000;

let dnsFailures = 0;
let dnsRecoveries = 0;

export function dnsStats() {
  return { failures: dnsFailures, recoveries: dnsRecoveries, cached: cache.size };
}

async function resolveVia(servers: string[], hostname: string): Promise<{ address: string; family: number } | null> {
  const resolver = new Resolver({ timeout: 4000, tries: 2 });
  resolver.setServers(servers);
  try {
    const [v4] = await resolver.resolve4(hostname);
    if (v4) return { address: v4, family: 4 };
  } catch {
    /* try the next resolver */
  }
  try {
    const [v6] = await resolver.resolve6(hostname);
    if (v6) return { address: v6, family: 6 };
  } catch {
    /* fall through */
  }
  return null;
}

/**
 * Tries the system resolver first so normal operation is unchanged, then falls
 * back to public resolvers. Results are cached briefly - a long run hits the same
 * few hosts thousands of times.
 */
const lookup: LookupFunction = (hostname, options, callback) => {
  // undici calls this with { all: true } and expects an array of records back.
  // Returning the single-address form leaves it with address === undefined,
  // which surfaces much later as ERR_INVALID_IP_ADDRESS on every request.
  const wantAll = typeof options === 'object' && options !== null && (options as { all?: boolean }).all === true;

  const cb = (err: NodeJS.ErrnoException | null, address?: string, family?: number) => {
    const done = callback as unknown as (
      e: NodeJS.ErrnoException | null,
      a?: string | Array<{ address: string; family: number }>,
      f?: number,
    ) => void;
    if (err) {
      done(err);
      return;
    }
    if (wantAll) done(null, [{ address: address!, family: family! }]);
    else done(null, address, family);
  };

  const hit = cache.get(hostname);
  if (hit && hit.expires > Date.now()) {
    cb(null, hit.address, hit.family);
    return;
  }

  void (async () => {
    const { lookup: systemLookup } = await import('node:dns');

    systemLookup(hostname, { family: 0 }, async (err, address, family) => {
      if (!err && address) {
        cache.set(hostname, { address, family, expires: Date.now() + TTL_MS });
        cb(null, address, family);
        return;
      }

      dnsFailures++;
      for (const servers of PUBLIC_RESOLVERS) {
        const resolved = await resolveVia(servers, hostname);
        if (resolved) {
          dnsRecoveries++;
          cache.set(hostname, { ...resolved, expires: Date.now() + TTL_MS });
          cb(null, resolved.address, resolved.family);
          return;
        }
      }
      cb(err ?? new Error(`could not resolve ${hostname}`));
    });
  })();
};

let installed = false;

export function installResilientDns() {
  if (installed) return;
  setGlobalDispatcher(
    new Agent({
      connect: { lookup, timeout: 15_000 },
      keepAliveTimeout: 30_000,
      connections: 64,
    }),
  );
  installed = true;
}
