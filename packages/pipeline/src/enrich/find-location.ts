/**
 * Establishes where a firm is based, for records discovered through the web.
 *
 * The registry and SEC channels carry a filed address; web-discovered records
 * carry whatever the page happened to say, which is usually nothing. That leaves
 * the most valuable firms in the file - Bezos Expeditions, Emerson Collective,
 * Thiel Capital and the like - as a name and a principal with no location, which
 * a client cannot act on and cannot filter by.
 *
 * Same discipline as everywhere else: a verbatim quote, located in the page it is
 * attributed to, or the field stays blank.
 */
import type { Cell, Evidence } from '@fo/core';
import { extractJson } from '../lib/llm.js';
import { fetchPageText, search } from '../lib/serper.js';
import { tierOf, TIER_LABEL, type SourceTier } from './source-tier.js';

export interface LocationFinding {
  city: string | null;
  region: string | null;
  country: string | null;
  quote: string;
  sourceUrl: string;
  sourceTier: SourceTier | null;
  note: string;
}

const SCHEMA = {
  type: 'object',
  properties: {
    city: { type: 'string' },
    region: { type: 'string' },
    country: { type: 'string' },
    quote: { type: 'string' },
    source_url: { type: 'string' },
  },
  required: ['city', 'region', 'country', 'quote', 'source_url'],
};

interface Extraction {
  city: string;
  region: string;
  country: string;
  quote: string;
  source_url: string;
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();

function quoteAppears(quote: string, text: string): boolean {
  const q = norm(quote);
  if (q.length < 15) return false;
  const c = norm(text);
  if (c.includes(q)) return true;
  const head = q.split(' ').slice(0, 6).join(' ');
  return head.length >= 15 && c.includes(head);
}

export async function findLocation(firmName: string, hint = ''): Promise<LocationFinding> {
  const empty: LocationFinding = {
    city: null,
    region: null,
    country: null,
    quote: '',
    sourceUrl: '',
    sourceTier: null,
    note: 'no location could be established',
  };

  let results;
  try {
    results = await search(`"${firmName}" ${hint} headquarters based in`.trim());
  } catch (err) {
    return { ...empty, note: `search failed: ${err instanceof Error ? err.message.slice(0, 70) : err}` };
  }
  if (results.length === 0) return empty;

  const ranked = [...results].sort((a, b) => tierOf(a.link, firmName) - tierOf(b.link, firmName)).slice(0, 3);

  const pages: Array<{ url: string; text: string }> = [];
  await Promise.all(
    ranked.map(async (r) => {
      try {
        const text = await fetchPageText(r.link, 4000);
        if (text.length > 300) pages.push({ url: r.link, text });
      } catch {
        /* unreachable pages are simply absent */
      }
    }),
  );
  if (pages.length === 0) return { ...empty, note: 'no page could be fetched' };

  const corpus = pages.map((p, i) => `--- SOURCE ${i + 1} (${p.url})\n${p.text}`).join('\n\n');

  let got: Extraction;
  try {
    got = await extractJson<Extraction>(
      `Where is "${firmName}" based? Use only the sources below. Respond with JSON.

${corpus}

- city, region, country: as stated in the sources. Use "" for anything not stated. Never infer a country from a city you happen to know.
- quote: VERBATIM text from the source that states the location, 5 to 30 words.
- source_url: the URL that quote came from, exactly as written above.

If no source states where this firm is based, return empty strings for every field. That is a correct answer and is common.`,
      SCHEMA,
    );
  } catch (err) {
    return { ...empty, note: `extraction failed: ${err instanceof Error ? err.message.slice(0, 70) : err}` };
  }

  const page = pages.find((p) => p.url === got.source_url);
  if (!page || !quoteAppears(got.quote, page.text)) {
    return { ...empty, note: 'the quote given could not be found in the source it cited' };
  }

  const tier = tierOf(got.source_url, firmName, page.text);
  return {
    city: got.city?.trim() || null,
    region: got.region?.trim() || null,
    country: got.country?.trim() || null,
    quote: got.quote,
    sourceUrl: got.source_url,
    sourceTier: tier,
    note: `stated by ${TIER_LABEL[tier]}`,
  };
}

export function locationEvidence(f: LocationFinding): Evidence[] {
  if (!f.sourceUrl || !f.quote) return [];
  return [
    {
      sourceUrl: f.sourceUrl,
      sourceClass: f.sourceTier === 1 ? 'primary_web' : f.sourceTier === 2 ? 'third_party' : 'vendor',
      method: `${TIER_LABEL[f.sourceTier ?? 4]} states: "${f.quote.slice(0, 160)}"`,
      observedAt: new Date().toISOString(),
    },
  ];
}

export function locationCell(value: string | null, f: LocationFinding): Cell<string> {
  if (!value) {
    return { value: null, status: 'could_not_verify', evidence: [], confidence: 0, note: f.note };
  }
  return {
    value,
    status: 'verified',
    evidence: locationEvidence(f),
    confidence: f.sourceTier === 1 ? 0.9 : f.sourceTier === 2 ? 0.8 : 0.65,
  };
}
