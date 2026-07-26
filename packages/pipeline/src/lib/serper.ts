import { fetchText } from './http.js';
import { installResilientDns } from './dns.js';

installResilientDns();

export interface SearchResult {
  title: string;
  link: string;
  snippet: string;
  position: number;
}

interface SerperResponse {
  organic?: Array<{ title: string; link: string; snippet?: string; position: number }>;
}

let queriesUsed = 0;

/** Free tier is 2,500 queries, so the count is tracked and reported rather than assumed. */
export function serperUsage() {
  return queriesUsed;
}

/** Free accounts reject num > 10 with "Query pattern not allowed", so 10 is the ceiling. */
const MAX_RESULTS_PER_CALL = 10;

export async function search(q: string, opts: { num?: number; page?: number } = {}): Promise<SearchResult[]> {
  const key = process.env.SERPER_API_KEY;
  if (!key) throw new Error('SERPER_API_KEY not set');

  const body: Record<string, unknown> = { q, num: Math.min(opts.num ?? MAX_RESULTS_PER_CALL, MAX_RESULTS_PER_CALL) };
  if (opts.page && opts.page > 1) body.page = opts.page;

  const res = await fetch('https://google.serper.dev/search', {
    method: 'POST',
    headers: { 'X-API-KEY': key, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  queriesUsed++;

  if (!res.ok) throw new Error(`serper ${res.status} for "${q}": ${(await res.text()).slice(0, 120)}`);
  const json = (await res.json()) as SerperResponse;

  return (json.organic ?? []).map((o) => ({
    title: o.title,
    link: o.link,
    snippet: o.snippet ?? '',
    position: o.position,
  }));
}

/** Strips scripts, styles and tags. Good enough to feed an extractor, not a parser. */
export async function fetchPageText(url: string, maxChars = 18_000): Promise<string> {
  const html = await fetchText(url, { retries: 1, timeoutMs: 20_000 });
  const text = html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<nav[\s\S]*?<\/nav>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
  return text.slice(0, maxChars);
}
