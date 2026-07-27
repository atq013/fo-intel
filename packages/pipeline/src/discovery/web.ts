/**
 * Discovery channel: the open web, reached through structured search.
 *
 * Every SEC channel shares one blind spot - it only sees entities that cross a US
 * regulatory reporting threshold. A family office that holds no listed equities,
 * takes no 5% stakes and raises no placements is invisible to all of them. This
 * channel reaches the places such firms do surface: conference programmes they
 * speak at, association directories they join, roles they hire for, and deals
 * the press reports.
 *
 * Extraction is done by an LLM, so every extracted firm must carry a verbatim
 * quote from the page. The quote is then checked against the page text in code.
 * An extractor that cannot produce a locatable quote has invented the firm, and
 * the record is dropped before it reaches the pool.
 */
import type { Discovery, DiscoveryChannel } from '@fo/core';
import { extractJson } from '../lib/llm.js';
import { fetchPageText, search, type SearchResult } from '../lib/serper.js';

export interface WebCandidate {
  name: string;
  typeClaim: 'single_family_office' | 'multi_family_office' | 'unclear';
  supportingQuote: string;
  principalName: string | null;
  principalTitle: string | null;
  location: string | null;
  sourceUrl: string;
  sourceTitle: string;
  channel: DiscoveryChannel;
  /** True when supportingQuote was located in the fetched page text. */
  quoteVerified: boolean;
}

interface QuerySpec {
  channel: DiscoveryChannel;
  queries: string[];
}

/**
 * Queries are grouped by what kind of page they are meant to reach, because the
 * channel a firm was discovered through is recorded per record and reported in
 * the methodology.
 */
const QUERY_SETS: QuerySpec[] = [
  {
    channel: 'conference_programme',
    queries: [
      '"family office" summit 2025 speakers "chief investment officer"',
      '"family office" conference agenda speakers "single family office"',
      '"family office" forum 2026 speaker list principal',
      'private wealth summit "family office" panellists agenda',
      '"family office" investment summit speakers Singapore',
      '"family office" summit speakers Dubai OR "Abu Dhabi"',
      '"family office" conference speakers Zurich OR Geneva OR Liechtenstein',
      '"family office" forum speakers "Hong Kong" OR Tokyo',
      '"family office" summit speakers India OR Mumbai',
      '"family office" event speakers Brazil OR "Sao Paulo" OR Mexico',
      '"family office" conference speakers Australia OR Sydney',
      '"family office" summit speakers Canada OR Toronto',
      '"family office" roundtable participants "managing director"',
      'impact investing summit "family office" speakers 2025',
      'alternative investments conference "family office" panel speakers',
    ],
  },
  {
    channel: 'job_posting',
    queries: [
      '"single family office" hiring "chief investment officer" job',
      '"family office" job opening controller OR "investment analyst" -recruiter',
      '"our family office" careers "we are seeking"',
      '"family office" hiring "head of investments" 2026',
      '"family office" vacancy "portfolio manager" London OR Singapore',
      '"family office" recruiting "investment associate" 2026',
    ],
  },
  {
    channel: 'news',
    queries: [
      '"family office" led investment round 2026 announcement',
      '"family office of" invests stake announcement 2026',
      '"family office" appoints "chief investment officer" 2026',
      '"single family office" launches OR opens office 2026',
      '"family office" backs startup funding round 2026',
      '"family office" acquires stake 2026 announcement',
      '"the family office of" billionaire investment 2026',
      '"family office" commits to fund 2026',
      '"family investment office" news 2026',
      '"family office" opens Singapore OR Dubai office 2026',
      '"family office" hires head of private equity 2026',
      '"family office" real estate acquisition 2026 announcement',
    ],
  },
];

const EXTRACTION_SCHEMA = {
  type: 'object',
  properties: {
    firms: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          type_claim: { type: 'string', enum: ['single_family_office', 'multi_family_office', 'unclear'] },
          supporting_quote: { type: 'string' },
          principal_name: { type: 'string' },
          principal_title: { type: 'string' },
          location: { type: 'string' },
        },
        required: ['name', 'type_claim', 'supporting_quote'],
      },
    },
  },
  required: ['firms'],
};

interface ExtractionResult {
  firms: Array<{
    name: string;
    type_claim: WebCandidate['typeClaim'];
    supporting_quote: string;
    principal_name?: string;
    principal_title?: string;
    location?: string;
  }>;
}

function prompt(pageText: string, url: string) {
  return `You are extracting family office records from a web page for a due-diligence dataset.

PAGE URL: ${url}

PAGE TEXT:
"""
${pageText}
"""

Extract every organisation on this page that is described as a family office.

Rules, which matter more than completeness:
- Only extract organisations actually named in the page text. Never infer a firm that is not written there.
- supporting_quote must be copied VERBATIM from the page text above, a span of 10 to 40 words that shows this organisation is a family office. Do not paraphrase, correct, or reformat it. If you cannot find such a span, do not extract the organisation at all.
- type_claim reflects only what the page states. Use "unclear" unless the page distinguishes single-family from multi-family. Do not guess from the name.
- Do not extract banks, asset managers, wealth advisory firms, private banks, or consultancies unless the page explicitly calls them a family office.
- Do not extract conference organisers, sponsors, or media companies.
- principal_name and principal_title only if a specific person is tied to that organisation on this page.

Return an empty firms array if the page contains no family offices.`;
}

/**
 * Job postings routinely hide the employer, so the extractor faithfully returns
 * "Confidential" or "Single Family Office" as the firm name. These are real
 * postings but unusable as records - there is no firm to verify - so they are
 * dropped here rather than carried into the pool as if they named something.
 */
const PLACEHOLDER_NAME =
  /^(confidential|private|undisclosed|anonymous|a |an |the )?\s*(single[- ]?family|multi[- ]?family|global)?\s*family\s*office\s*(\(.*\))?$|^confidential\b|^(n\/a|unknown|not disclosed)$/i;

function isUsableName(name: string): boolean {
  const n = name.trim();
  if (n.length < 4) return false;
  if (PLACEHOLDER_NAME.test(n)) return false;
  // A name that is only generic industry words identifies nothing.
  const stripped = n.toLowerCase().replace(/\b(family|office|single|multi|group|the|of|a|an)\b/g, '').replace(/[^a-z0-9]/g, '');
  return stripped.length >= 3;
}

/** Normalised containment check - the extractor often shifts whitespace or case. */
function quoteAppears(quote: string, pageText: string): boolean {
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
  const q = norm(quote);
  if (q.length < 20) return false;
  const page = norm(pageText);
  if (page.includes(q)) return true;

  // Allow a truncated tail: extractors sometimes clip mid-sentence.
  const head = q.split(' ').slice(0, 8).join(' ');
  return head.length >= 20 && page.includes(head);
}

async function extractFromPage(result: SearchResult, channel: DiscoveryChannel): Promise<WebCandidate[]> {
  let pageText: string;
  try {
    pageText = await fetchPageText(result.link);
  } catch {
    return [];
  }
  if (pageText.length < 400) return [];

  let extracted: ExtractionResult;
  try {
    extracted = await extractJson<ExtractionResult>(prompt(pageText, result.link), EXTRACTION_SCHEMA);
  } catch {
    return [];
  }

  return extracted.firms.map((f) => ({
    name: f.name.trim(),
    typeClaim: f.type_claim,
    supportingQuote: f.supporting_quote,
    principalName: f.principal_name?.trim() || null,
    principalTitle: f.principal_title?.trim() || null,
    location: f.location?.trim() || null,
    sourceUrl: result.link,
    sourceTitle: result.title,
    channel,
    quoteVerified: quoteAppears(f.supporting_quote, pageText),
  }));
}

export interface WebDiscoveryStats {
  queriesRun: number;
  pagesFetched: number;
  extracted: number;
  quoteFailed: number;
  placeholderDropped: number;
}

export async function discoverFromWeb(
  pagesPerQuery = 6,
  onLog: (msg: string) => void = console.log,
): Promise<{ candidates: WebCandidate[]; stats: WebDiscoveryStats }> {
  const stats: WebDiscoveryStats = { queriesRun: 0, pagesFetched: 0, extracted: 0, quoteFailed: 0, placeholderDropped: 0 };
  const byName = new Map<string, WebCandidate>();

  for (const set of QUERY_SETS) {
    for (const q of set.queries) {
      let results: SearchResult[];
      try {
        results = await search(q);
        stats.queriesRun++;
      } catch (err) {
        onLog(`  search failed: ${err instanceof Error ? err.message : err}`);
        continue;
      }

      const targets = results.slice(0, pagesPerQuery);
      const batches = await Promise.all(targets.map((r) => extractFromPage(r, set.channel)));
      stats.pagesFetched += targets.length;

      let added = 0;
      for (const found of batches) {
        for (const c of found) {
          stats.extracted++;
          if (!c.quoteVerified) {
            stats.quoteFailed++;
            continue;
          }
          if (!isUsableName(c.name)) {
            stats.placeholderDropped++;
            continue;
          }
          const key = c.name.toLowerCase().replace(/[^a-z0-9]/g, '');
          if (!key || byName.has(key)) continue;
          byName.set(key, c);
          added++;
        }
      }
      onLog(`  ${set.channel.padEnd(22)} +${String(added).padStart(3)}  ${q.slice(0, 58)}`);
    }
  }

  return { candidates: [...byName.values()], stats };
}

export { isUsableName };

export function toDiscovery(c: WebCandidate): Discovery {
  return {
    channel: c.channel,
    sourceUrl: c.sourceUrl,
    discoveredAt: new Date().toISOString(),
    rawName: c.name,
  };
}
