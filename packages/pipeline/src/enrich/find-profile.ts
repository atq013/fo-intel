/**
 * Establishes what a firm actually is in prose, plus its LinkedIn pages.
 *
 * The brief names background information, corporate LinkedIn addresses and
 * principal LinkedIn addresses among the cells where the value of the file
 * lives, and the reference schema carries all three. Without them a record
 * proves a firm exists and says nothing about who these people are, which is a
 * name and an address rather than intelligence.
 *
 * Same discipline as every other enrichment here: a verbatim quote located in
 * the page it is attributed to, or the field stays blank with a reason.
 */
import type { Cell, Evidence } from '@fo/core';
import { extractJson } from '../lib/llm.js';
import { fetchPageText, search } from '../lib/serper.js';
import { tierOf, TIER_LABEL, type SourceTier } from './source-tier.js';

export interface ProfileFinding {
  description: string | null;
  descriptionQuote: string;
  descriptionSourceUrl: string;
  descriptionTier: SourceTier | null;
  corporateLinkedin: string | null;
  principalLinkedin: string | null;
  note: string;
}

const SCHEMA = {
  type: 'object',
  properties: {
    description: { type: 'string' },
    quote: { type: 'string' },
    source_url: { type: 'string' },
  },
  required: ['description', 'quote', 'source_url'],
};

interface Extraction {
  description: string;
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

/** A LinkedIn company URL, not a post, job ad, or people-directory page. */
function companyLinkedin(url: string): string | null {
  const m = url.match(/^https?:\/\/[a-z]{0,3}\.?linkedin\.com\/company\/[a-zA-Z0-9._-]+/);
  return m ? m[0].replace(/^http:/, 'https:') : null;
}

/** A LinkedIn member profile URL. */
function personLinkedin(url: string): string | null {
  const m = url.match(/^https?:\/\/[a-z]{0,3}\.?linkedin\.com\/in\/[a-zA-Z0-9._%-]+/);
  return m ? m[0].replace(/^http:/, 'https:') : null;
}

/**
 * A person's profile only counts when the search that found it named both the
 * person and their firm. Matching on surname alone attaches the wrong Smith.
 */
function nameMatches(url: string, title: string, snippet: string, personName: string): boolean {
  const parts = personName
    .replace(/,/g, ' ')
    .toLowerCase()
    .replace(/\b(mr|mrs|ms|miss|dr|sir|dame|lord|lady|prof)\b/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length >= 3);
  if (parts.length < 2) return false;

  const haystack = `${url} ${title} ${snippet}`.toLowerCase();
  const hits = parts.filter((p) => haystack.includes(p)).length;
  return hits >= 2;
}

export async function findProfile(
  firmName: string,
  principalName: string,
  hint = '',
): Promise<ProfileFinding> {
  const out: ProfileFinding = {
    description: null,
    descriptionQuote: '',
    descriptionSourceUrl: '',
    descriptionTier: null,
    corporateLinkedin: null,
    principalLinkedin: null,
    note: 'no description could be established',
  };

  // One search serves both jobs: pages describing the firm, and its LinkedIn page.
  let results;
  try {
    results = await search(`"${firmName}" ${hint} about`.trim());
  } catch (err) {
    return { ...out, note: `search failed: ${err instanceof Error ? err.message.slice(0, 60) : err}` };
  }

  for (const r of results) {
    const c = companyLinkedin(r.link);
    if (c && !out.corporateLinkedin) out.corporateLinkedin = c;
  }

  // Description comes from non-LinkedIn pages; LinkedIn blocks scraping and its
  // snippets are not a source we can quote against.
  const ranked = results
    .filter((r) => !/linkedin\.com/.test(r.link))
    .sort((a, b) => tierOf(a.link, firmName) - tierOf(b.link, firmName))
    .slice(0, 3);

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

  if (pages.length > 0) {
    const corpus = pages.map((p, i) => `--- SOURCE ${i + 1} (${p.url})\n${p.text}`).join('\n\n');
    try {
      const got = await extractJson<Extraction>(
        `Describe "${firmName}" in one or two sentences, using only the sources below. Respond with JSON.

${corpus}

- description: what this firm is and what it does, in plain English, 15 to 45 words. Say only what the sources say.
- quote: VERBATIM text from a source that supports your description, 8 to 35 words.
- source_url: the URL that quote came from, exactly as written above.

If the sources do not describe this firm, return empty strings for all three. That is correct and common.`,
        SCHEMA,
      );

      const page = pages.find((p) => p.url === got.source_url);
      if (page && got.description?.trim() && quoteAppears(got.quote, page.text)) {
        const tier = tierOf(got.source_url, firmName, page.text);
        out.description = got.description.trim();
        out.descriptionQuote = got.quote;
        out.descriptionSourceUrl = got.source_url;
        out.descriptionTier = tier;
        out.note = `described by ${TIER_LABEL[tier]}`;
      } else if (got.description?.trim()) {
        out.note = 'a description was drafted but its quote was not found in the source it cited';
      }
    } catch (err) {
      out.note = `extraction failed: ${err instanceof Error ? err.message.slice(0, 60) : err}`;
    }
  }

  // The principal's profile needs its own search - the firm search rarely surfaces it.
  if (principalName) {
    try {
      const people = await search(`"${principalName}" "${firmName}" linkedin`);
      for (const r of people) {
        const p = personLinkedin(r.link);
        if (p && nameMatches(r.link, r.title, r.snippet, principalName)) {
          out.principalLinkedin = p;
          break;
        }
      }
    } catch {
      /* leaving it blank is the honest outcome */
    }
  }

  return out;
}

/**
 * Registry boilerplate describing a legal form rather than a business. "A private
 * company limited by shares" is true of most of the file and tells a reader
 * nothing, so it is worth less than an honest blank.
 */
const BOILERPLATE_ONLY =
  /^(a |an |the )?(private |public )?(company |limited company |limited liability company )?(limited by shares|limited by guarantee|not elsewhere classified|incorporated in [a-z ]+)\.?$/i;

function saysSomething(description: string): boolean {
  const d = description.trim();
  if (BOILERPLATE_ONLY.test(d)) return false;
  // Strip generic company-law vocabulary; what remains must carry actual content.
  const residue = d
    .toLowerCase()
    .replace(/\b(a|an|the|is|of|for|and|with|that|which|private|public|limited|company|companies|shares|guarantee|incorporated|registered|holding|not|elsewhere|classified|entity|business)\b/g, ' ')
    .replace(/[^a-z ]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 2);
  return residue.length >= 2;
}

export function descriptionCell(f: ProfileFinding): Cell<string> {
  if (f.description && !saysSomething(f.description)) {
    return {
      value: null,
      status: 'could_not_verify',
      evidence: [],
      confidence: 0,
      note: 'the only description found described the legal form rather than the business',
    };
  }
  if (!f.description) {
    return { value: null, status: 'could_not_verify', evidence: [], confidence: 0, note: f.note };
  }
  const evidence: Evidence = {
    sourceUrl: f.descriptionSourceUrl,
    sourceClass: f.descriptionTier === 1 ? 'primary_web' : f.descriptionTier === 2 ? 'third_party' : 'vendor',
    method: `${TIER_LABEL[f.descriptionTier ?? 4]} states: "${f.descriptionQuote.slice(0, 160)}"`,
    observedAt: new Date().toISOString(),
  };
  return {
    value: f.description,
    status: 'verified',
    evidence: [evidence],
    confidence: f.descriptionTier === 1 ? 0.9 : f.descriptionTier === 2 ? 0.8 : 0.65,
  };
}

export function linkedinCell(url: string | null, what: 'firm' | 'principal'): Cell<string> {
  if (!url) {
    return {
      value: null,
      status: 'could_not_verify',
      evidence: [],
      confidence: 0,
      note: what === 'firm' ? 'no company page found' : 'no profile found that names both the person and the firm',
    };
  }
  return {
    value: url,
    status: 'verified',
    evidence: [
      {
        sourceUrl: url,
        sourceClass: 'third_party',
        method:
          what === 'firm'
            ? 'LinkedIn company page found under the firm name'
            : 'LinkedIn profile naming both the person and the firm',
        observedAt: new Date().toISOString(),
      },
    ],
    confidence: 0.7,
  };
}
