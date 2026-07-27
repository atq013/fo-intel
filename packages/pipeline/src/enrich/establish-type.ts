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
 * Each source is read separately and produces its own claim. Reconciliation
 * across sources happens in code, in source-tier.ts, so that a disagreement
 * between sources is visible rather than silently resolved by whichever page the
 * extractor happened to read first.
 *
 * A firm we cannot establish stays undetermined and does not enter the dataset.
 * That is the intended outcome, not a failure.
 */
import type { Evidence } from '@fo/core';
import { extractJson } from '../lib/llm.js';
import { fetchPageText, search } from '../lib/serper.js';
import { reconcile, tierOf, TIER_LABEL, isOwnDomain, type Claim, type SourceTier } from './source-tier.js';

export type EstablishedType = 'single_family_office' | 'multi_family_office' | 'not_a_family_office' | 'undetermined';

export interface TypeFinding {
  firmName: string;
  type: EstablishedType | 'undetermined';
  confidence: number;
  quote: string;
  sourceUrl: string;
  sourceTier: SourceTier | null;
  website: string | null;
  /** Every source that produced a claim, including ones that lost reconciliation. */
  claims: Claim<EstablishedType>[];
  conflicted: boolean;
  note: string;
}

const SCHEMA = {
  type: 'object',
  properties: {
    claims: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          source_url: { type: 'string' },
          type: {
            type: 'string',
            enum: ['single_family_office', 'multi_family_office', 'not_a_family_office', 'undetermined'],
          },
          quote: { type: 'string' },
        },
        required: ['source_url', 'type', 'quote'],
      },
    },
  },
  required: ['claims'],
};

interface Extraction {
  claims: Array<{ source_url: string; type: EstablishedType; quote: string }>;
}

function prompt(firmName: string, location: string, pages: Array<{ url: string; text: string }>) {
  const corpus = pages.map((p, i) => `--- SOURCE ${i + 1} (${p.url})\n${p.text}`).join('\n\n');

  return `Read each source below separately and report what EACH ONE says about "${firmName}"${location ? ` (${location})` : ''}.

${corpus}

For every source, give one claim object with:
- source_url: that source's URL exactly as written above
- type: one of
    single_family_office  - exists to manage the wealth of ONE family; no client acquisition surface
    multi_family_office   - serves several unrelated families as clients, and markets that service
    not_a_family_office   - hedge fund, private equity, venture firm, asset manager, RIA serving many individuals, bank, broker, insurer, or operating business
    undetermined          - this source does not establish which of the above it is
- quote: VERBATIM text copied from THAT source, 10 to 40 words, which is the specific span establishing your answer

Critical rules:
- Report each source independently. Do not let one source influence your reading of another. Sources genuinely disagree sometimes and we need to see that.
- The quote must come from the source you attribute it to, copied exactly. Never paraphrase or merge text from two sources.
- If a source does not establish the type, return "undetermined" for it with an empty quote. This is common and correct.
- A quote that merely repeats the firm's name is not evidence. The span must say what the firm does or who it serves.
- Never classify from the firm's name alone. "X Family Capital" proves nothing.
- Serving wealthy individuals is not being a family office. An RIA with many high-net-worth clients is not_a_family_office.`;
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();

function quoteAppears(quote: string, text: string): boolean {
  const q = norm(quote);
  if (q.length < 20) return false;
  const c = norm(text);
  if (c.includes(q)) return true;
  const head = q.split(' ').slice(0, 8).join(' ');
  return head.length >= 20 && c.includes(head);
}

/** Language that establishes a firm type, as opposed to merely naming the firm. */
const TYPE_BEARING =
  /\b(single[- ]family|multi[- ]family|family office|manages? (the )?(wealth|assets|capital|investments)|investment adviser|investment advisor|hedge fund|private equity|venture capital|asset manager|holding company|serves? .{0,20}famil|on behalf of|invests? (the )?(wealth|capital|assets))\b/i;

function quoteIsInformative(quote: string, firmName: string): boolean {
  const q = norm(quote);
  if (q.split(' ').length < 6) return false;
  const withoutName = q.replace(norm(firmName), '').trim();
  if (withoutName.split(' ').filter(Boolean).length < 4) return false;
  return TYPE_BEARING.test(quote);
}

export async function establishType(firmName: string, location = ''): Promise<TypeFinding> {
  const base: TypeFinding = {
    firmName,
    type: 'undetermined',
    confidence: 0,
    quote: '',
    sourceUrl: '',
    sourceTier: null,
    website: null,
    claims: [],
    conflicted: false,
    note: '',
  };

  let results;
  try {
    results = await search(`"${firmName}" ${location} family office`.trim());
  } catch (err) {
    return { ...base, note: `search failed: ${err instanceof Error ? err.message : err}` };
  }
  if (results.length === 0) return { ...base, note: 'no search results' };

  // Read the firm's own site first where one exists, then press, then databases.
  const ranked = [...results].sort((a, b) => tierOf(a.link, firmName) - tierOf(b.link, firmName));
  const targets = ranked.slice(0, 3);

  const pages: Array<{ url: string; text: string }> = [];
  await Promise.all(
    targets.map(async (r) => {
      try {
        const text = await fetchPageText(r.link, 4500);
        if (text.length > 300) pages.push({ url: r.link, text });
      } catch {
        /* unreachable pages are simply absent from the corpus */
      }
    }),
  );
  if (pages.length === 0) return { ...base, note: 'no page could be fetched' };

  let extracted: Extraction;
  try {
    extracted = await extractJson<Extraction>(prompt(firmName, location, pages), SCHEMA);
  } catch (err) {
    return { ...base, note: `extraction failed: ${err instanceof Error ? err.message : err}` };
  }

  // Each claim is checked against the specific page it is attributed to, so a
  // quote lifted from a different source cannot pass.
  const claims: Claim<EstablishedType>[] = [];
  for (const c of extracted.claims ?? []) {
    const page = pages.find((p) => p.url === c.source_url);
    if (!page) continue;
    if (c.type === 'undetermined') continue;
    if (!quoteAppears(c.quote, page.text)) continue;
    if (!quoteIsInformative(c.quote, firmName)) continue;
    claims.push({ sourceUrl: c.source_url, tier: tierOf(c.source_url, firmName, page.text), value: c.type, quote: c.quote });
  }

  const resolved = reconcile<EstablishedType>(claims, 'undetermined');
  const winner = resolved.supporting[0];

  return {
    firmName,
    type: resolved.value ?? 'undetermined',
    confidence: resolved.confidence,
    quote: winner?.quote ?? '',
    sourceUrl: winner?.sourceUrl ?? '',
    sourceTier: resolved.tier,
    website: pages.find((p) => isOwnDomain(p.url, firmName, p.text))?.url ?? null,
    claims,
    conflicted: resolved.conflicting.length > 0 && resolved.value === null,
    note: resolved.note,
  };
}

export function toEvidence(f: TypeFinding): Evidence | null {
  if (!f.type || f.type === 'undetermined' || !f.quote) return null;
  return {
    sourceUrl: f.sourceUrl,
    sourceClass: f.sourceTier === 1 ? 'primary_web' : f.sourceTier === 2 ? 'third_party' : 'vendor',
    method: `${TIER_LABEL[f.sourceTier ?? 4]} states: "${f.quote.slice(0, 200)}"`,
    observedAt: new Date().toISOString(),
  };
}
