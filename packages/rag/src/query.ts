/**
 * Query understanding.
 *
 * Separating structured constraints from the semantic part is a correctness
 * requirement, not an optimisation. "Single-family offices in Texas" contains a
 * filter and a topic. Handing the whole sentence to an embedding search returns
 * whatever reads similarly - a Californian multi-family office scores well on
 * that sentence - and the user has no way to see their constraint was ignored.
 * Constraints are enforced in SQL; only the remainder is matched semantically.
 */
import { extractJson } from './llm.js';

export interface ParsedQuery {
  semanticQuery: string;
  firmType: 'single_family_office' | 'multi_family_office' | null;
  country: string | null;
  requireContact: boolean;
  sinceDate: string | null;
  /** Constraints we recognised, phrased for display back to the user. */
  appliedFilters: string[];
}

const SCHEMA = {
  type: 'object',
  properties: {
    semantic_query: { type: 'string' },
    firm_type: { type: 'string', enum: ['single_family_office', 'multi_family_office', 'any'] },
    country: { type: 'string' },
    require_contact: { type: 'boolean' },
    recency_months: { type: 'number' },
  },
  required: ['semantic_query', 'firm_type', 'country', 'require_contact', 'recency_months'],
};

interface Raw {
  semantic_query: string;
  firm_type: string;
  country: string;
  require_contact: boolean;
  recency_months: number;
}

const COUNTRY_CANON: Record<string, string> = {
  uk: 'United Kingdom', 'united kingdom': 'United Kingdom', britain: 'United Kingdom', england: 'United Kingdom',
  us: 'United States', usa: 'United States', 'united states': 'United States', america: 'United States',
};

export async function parseQuery(question: string): Promise<ParsedQuery> {
  const fallback: ParsedQuery = {
    semanticQuery: question,
    firmType: null,
    country: null,
    requireContact: false,
    sinceDate: null,
    appliedFilters: [],
  };

  let raw: Raw;
  try {
    raw = await extractJson<Raw>(
      `Extract search constraints from this question about a family office database.

QUESTION: ${question}

- semantic_query: the topic to match on, with constraints removed. If the question is purely a filter, restate what kind of firm is wanted.
- firm_type: "single_family_office" only if the question asks specifically for single-family offices; "multi_family_office" likewise; otherwise "any".
- country: the country named, or "" if none. Use the full country name.
- require_contact: true only if the question asks for firms you can contact or reach.
- recency_months: if the question asks about recent activity, how many months back; otherwise 0.

Report only what the question actually says. Do not infer constraints the user did not state.`,
      SCHEMA,
    );
  } catch {
    return fallback;
  }

  const applied: string[] = [];
  const firmType =
    raw.firm_type === 'single_family_office' || raw.firm_type === 'multi_family_office' ? raw.firm_type : null;
  if (firmType) applied.push(firmType === 'single_family_office' ? 'single-family offices only' : 'multi-family offices only');

  const countryRaw = (raw.country ?? '').trim();
  const country = countryRaw ? (COUNTRY_CANON[countryRaw.toLowerCase()] ?? countryRaw) : null;
  if (country) applied.push(`located in ${country}`);

  if (raw.require_contact) applied.push('has a verified contact route');

  let sinceDate: string | null = null;
  if (raw.recency_months > 0) {
    const d = new Date();
    d.setMonth(d.getMonth() - Math.min(raw.recency_months, 60));
    sinceDate = d.toISOString().slice(0, 10);
    applied.push(`activity since ${sinceDate}`);
  }

  return {
    semanticQuery: raw.semantic_query?.trim() || question,
    firmType,
    country,
    requireContact: Boolean(raw.require_contact),
    sinceDate,
    appliedFilters: applied,
  };
}
