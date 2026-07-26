/**
 * Establishes what a firm actually is, for firms that discovery found
 * structurally but could not classify.
 *
 * The 13F and ownership-filing channels produce firms with regulatory-grade
 * contact data and dated activity, but SEC filings never state "we are a family
 * office" in a machine-readable field. Structural signals - no adviser CRD, a
 * concentrated book, entities clustered at one address - are good enough to
 * justify looking at a firm and not good enough to assert what it is.
 *
 * So this goes and looks: finds the firm's own site and its public profile, and
 * requires a verbatim, locatable quote before it will assert a type. A firm we
 * cannot establish stays unconfirmed and does not enter the dataset. That is the
 * intended outcome, not a failure - it is the difference between a dataset and a
 * list of guesses.
 */
import type { Evidence } from '@fo/core';
import { extractJson } from '../lib/llm.js';
import { fetchPageText, search } from '../lib/serper.js';

export type EstablishedType = 'single_family_office' | 'multi_family_office' | 'not_a_family_office' | 'undetermined';

export interface TypeFinding {
  firmName: string;
  type: EstablishedType;
  quote: string;
  quoteVerified: boolean;
  sourceUrl: string;
  sourceIsOwnSite: boolean;
  website: string | null;
  reasoning: string;
}

const SCHEMA = {
  type: 'object',
  properties: {
    type: {
      type: 'string',
      enum: ['single_family_office', 'multi_family_office', 'not_a_family_office', 'undetermined'],
    },
    quote: { type: 'string' },
    source_url: { type: 'string' },
    reasoning: { type: 'string' },
  },
  required: ['type', 'quote', 'source_url', 'reasoning'],
};

interface Extraction {
  type: EstablishedType;
  quote: string;
  source_url: string;
  reasoning: string;
}

function prompt(firmName: string, location: string, pages: Array<{ url: string; text: string }>) {
  const corpus = pages.map((p, i) => `--- SOURCE ${i + 1}: ${p.url}\n${p.text}`).join('\n\n');

  return `Determine what kind of firm "${firmName}"${location ? ` (${location})` : ''} is, using only the sources below.

${corpus}

Classify into exactly one:

- single_family_office: exists to manage the wealth of ONE family. Typically no client acquisition surface: no fee schedule, no "become a client" page, no marketing to prospective clients.
- multi_family_office: serves several unrelated families as clients, and markets that service.
- not_a_family_office: a hedge fund, private equity or venture firm, asset manager, RIA serving many individuals, bank, broker, insurer, or operating business.
- undetermined: the sources do not establish which of the above it is.

Rules:
- quote must be copied VERBATIM from one of the sources above, 10 to 40 words, and must be the specific text that establishes your classification. Never paraphrase or reconstruct it.
- source_url must be the URL of the source the quote came from.
- If no source contains such a span, return "undetermined" with an empty quote. This is expected and correct for many firms.
- Do not classify from the firm's name. "X Family Capital" is not evidence. Only what the sources say counts.
- Serving wealthy individuals is not the same as being a family office. An RIA with many high-net-worth clients is not_a_family_office.`;
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();

function quoteAppears(quote: string, corpus: string): boolean {
  const q = norm(quote);
  if (q.length < 20) return false;
  const c = norm(corpus);
  if (c.includes(q)) return true;
  const head = q.split(' ').slice(0, 8).join(' ');
  return head.length >= 20 && c.includes(head);
}

/**
 * Language that actually establishes a firm type, as opposed to merely naming
 * the firm. Without this an extractor satisfies the quote rule by echoing the
 * company name back - "DUQUESNE FAMILY OFFICE LLC" is present in the page and
 * tells us nothing, because a name is not evidence.
 */
const TYPE_BEARING =
  /\b(single[- ]family|multi[- ]family|family office|manages? (the )?(wealth|assets|capital|investments)|investment adviser|investment advisor|hedge fund|private equity|venture capital|asset manager|holding company|serves? .{0,20}famil|on behalf of)\b/i;

function quoteIsInformative(quote: string, firmName: string): boolean {
  const q = norm(quote);
  if (q.split(' ').length < 6) return false;
  // A quote that is only the firm name, however long that name is, says nothing.
  const withoutName = q.replace(norm(firmName), '').trim();
  if (withoutName.split(' ').filter(Boolean).length < 4) return false;
  return TYPE_BEARING.test(quote);
}

/** Domains that host profiles about firms rather than firms' own statements. */
const AGGREGATOR =
  /(wikipedia|bloomberg|crunchbase|pitchbook|linkedin|zoominfo|dnb\.com|opencorporates|unusualwhales|altss|whalewisdom|sec\.gov|marketscreener|stockcircle|fintel|holdingschannel)/i;

/** True when the page is hosted on a domain derived from the firm's own name. */
function isOwnDomain(url: string, firmName: string): boolean {
  if (AGGREGATOR.test(url)) return false;
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return false;
  }
  const stop = new Set(['family', 'office', 'the', 'llc', 'inc', 'lp', 'ltd', 'group', 'capital', 'holdings', 'management', 'trust', 'partners', 'company']);
  const tokens = norm(firmName).split(' ').filter((t) => t.length >= 4 && !stop.has(t));
  return tokens.some((t) => host.includes(t));
}

export async function establishType(firmName: string, location = ''): Promise<TypeFinding> {
  const base: TypeFinding = {
    firmName,
    type: 'undetermined',
    quote: '',
    quoteVerified: false,
    sourceUrl: '',
    sourceIsOwnSite: false,
    website: null,
    reasoning: '',
  };

  let results;
  try {
    results = await search(`"${firmName}" ${location} family office`.trim());
  } catch {
    return { ...base, reasoning: 'search failed' };
  }
  if (results.length === 0) return { ...base, reasoning: 'no search results' };

  // Prefer the firm's own site over aggregator profiles, but keep both.
  const ranked = [...results].sort((a, b) => Number(AGGREGATOR.test(a.link)) - Number(AGGREGATOR.test(b.link)));
  const targets = ranked.slice(0, 4);

  const pages: Array<{ url: string; text: string }> = [];
  await Promise.all(
    targets.map(async (r) => {
      try {
        const text = await fetchPageText(r.link, 9000);
        if (text.length > 300) pages.push({ url: r.link, text });
      } catch {
        /* unreachable pages are simply absent from the corpus */
      }
    }),
  );
  if (pages.length === 0) return { ...base, reasoning: 'no page could be fetched' };

  let extracted: Extraction;
  try {
    extracted = await extractJson<Extraction>(prompt(firmName, location, pages), SCHEMA);
  } catch (err) {
    return { ...base, reasoning: `extraction failed: ${err instanceof Error ? err.message : err}` };
  }

  const corpus = pages.map((p) => p.text).join('\n');
  const located = quoteAppears(extracted.quote, corpus);
  const informative = quoteIsInformative(extracted.quote, firmName);
  const verified = extracted.type !== 'undetermined' && located && informative;

  const ownSite = isOwnDomain(extracted.source_url, firmName);

  const why = !located
    ? 'quote not found in fetched sources'
    : !informative
      ? 'quote names the firm but does not establish what it is'
      : '';

  return {
    firmName,
    // An unverifiable quote means the claim is not supported, whatever it asserts.
    type: verified ? extracted.type : 'undetermined',
    quote: extracted.quote,
    quoteVerified: verified,
    sourceUrl: extracted.source_url,
    sourceIsOwnSite: ownSite,
    website: pages.find((p) => !AGGREGATOR.test(p.url))?.url ?? null,
    reasoning: verified ? extracted.reasoning : `${why}; ${extracted.reasoning}`.slice(0, 240),
  };
}

export function toEvidence(f: TypeFinding): Evidence | null {
  if (!f.quoteVerified) return null;
  return {
    sourceUrl: f.sourceUrl,
    sourceClass: f.sourceIsOwnSite ? 'primary_web' : 'third_party',
    method: `${f.sourceIsOwnSite ? 'the firm' : 'a published profile'} states: "${f.quote.slice(0, 200)}"`,
    observedAt: new Date().toISOString(),
  };
}
