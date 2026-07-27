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

/**
 * A field the question is specifically asking for. Detected with patterns rather
 * than by the model, because it gates a refusal and a deterministic gate is worth
 * more than a clever one.
 */
export type RequestedField = 'email' | 'phone' | 'aum' | 'sectors' | 'thesis' | 'website' | 'ranking' | null;

export interface ParsedQuery {
  semanticQuery: string;
  requestedField: RequestedField;
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

const FIELD_PATTERNS: Array<[RequestedField, RegExp]> = [
  ['email', /\b(e-?mail|email address|contact address)\b/i],
  ['phone', /\b(phone|telephone|call them|direct line|number to call)\b/i],
  ['aum', /\b(aum|assets under management|how much .{0,20}manage|fund size|how big)\b/i],
  ['sectors', /\b(sectors?|industry|industries|asset class(es)?|what do they invest in)\b/i],
  ['thesis', /\b(thesis|strategy|investment approach|mandate)\b/i],
  ['aum', /\bhow much .{0,25}(manage|worth)\b/i],
  ['website', /\b(website|web site|url|homepage)\b/i],
  ['ranking', /\b(largest|biggest|smallest|top \d+|rank|ranked|most active|wealthiest)\b/i],
];

export function detectRequestedField(question: string): RequestedField {
  for (const [field, re] of FIELD_PATTERNS) {
    if (re.test(question)) return field;
  }
  return null;
}

const COUNTRY_CANON: Record<string, string> = {
  uk: 'United Kingdom', 'united kingdom': 'United Kingdom', britain: 'United Kingdom', england: 'United Kingdom',
  us: 'United States', usa: 'United States', 'united states': 'United States', america: 'United States',
};

export async function parseQuery(question: string): Promise<ParsedQuery> {
  const fallback: ParsedQuery = {
    semanticQuery: question,
    requestedField: detectRequestedField(question),
    firmType: null,
    country: null,
    requireContact: false,
    sinceDate: null,
    appliedFilters: [],
  };

  let raw: Raw;
  try {
    raw = await extractJson<Raw>(
      `Extract search constraints from this question about a family office database. Respond with JSON.

Fields:
- semantic_query: the topic to match on, with constraints removed. If the question is purely a filter, restate what kind of firm is wanted.
- firm_type: "single_family_office" only if the question asks specifically for single-family offices; "multi_family_office" likewise; otherwise "any".
- country: the country named, or "" if none. Use the full country name.
- require_contact: true whenever the question is about reaching, contacting, calling, emailing or phoning firms.
- recency_months: if the question asks about recent activity, how many months back; otherwise 0.

Examples:

Q: "Single-family offices in the United Kingdom"
{"semantic_query":"single-family office","firm_type":"single_family_office","country":"United Kingdom","require_contact":false,"recency_months":0}

Q: "Family offices I can actually reach by phone"
{"semantic_query":"family office with a direct phone number","firm_type":"any","country":"","require_contact":true,"recency_months":0}

Q: "Which firms have filed something recently?"
{"semantic_query":"recent regulatory filing activity","firm_type":"any","country":"","require_contact":false,"recency_months":12}

Q: "Who runs Duquesne Family Office?"
{"semantic_query":"Duquesne Family Office principal","firm_type":"any","country":"","require_contact":false,"recency_months":0}

Now do the same for this question. Report only what it actually says; do not invent constraints.

QUESTION: ${question}`,
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
    requestedField: detectRequestedField(question),
    firmType,
    country,
    requireContact: Boolean(raw.require_contact),
    sinceDate,
    appliedFilters: applied,
  };
}
