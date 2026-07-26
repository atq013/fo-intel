/**
 * Discovery channel: EDGAR full-text search over ownership filings.
 *
 * Complements the 13F census, which only sees managers above $100M in listed
 * equities. A family office that holds a concentrated stake in one operating
 * company, or invests privately, never appears there but does file SC 13D/13G
 * or Form D. Those filings are also free text, so the phrase "family office"
 * appears where the filer describes itself.
 *
 * In an ownership filing the first display name is the subject company and the
 * rest are filers. We want the filers.
 */
import type { Discovery } from '@fo/core';
import { fetchJson } from '../lib/http.js';

const EFTS = 'https://efts.sec.gov/LATEST/search-index';
const PAGE_SIZE = 10;

interface EftsResponse {
  hits: {
    total: { value: number };
    hits: Array<{
      _source: {
        ciks: string[];
        display_names: string[];
        biz_locations: string[];
        inc_states: string[];
        form: string;
        file_date: string;
        adsh: string;
      };
    }>;
  };
}

export interface FullTextCandidate {
  cik: string;
  name: string;
  location: string;
  forms: Set<string>;
  phrases: Set<string>;
  filingCount: number;
  latestFiling: string;
  exampleAccession: string;
  /** False when EDGAR filed this under a personal name - feeds wealth-first discovery. */
  isEntity: boolean;
  /** Distinct counterparties. A vehicle that invests appears against many; a subject company does not. */
  counterparties: Set<string>;
}

/** Phrases a family office is likely to use about itself in a filing. */
const PHRASES = [
  '"family office"',
  '"single family office"',
  '"single-family office"',
  '"family investment office"',
  '"family holding company"',
];

const FORMS = ['SC 13D', 'SC 13G', 'D'];

/**
 * EDGAR files individuals under their own name with no corporate suffix, so the
 * presence of one separates firms from people. Individuals are kept rather than
 * dropped: a person filing a 13D is a wealthy family, which is the starting point
 * for the wealth-first channel that looks for their investment vehicle.
 */
const CORPORATE_SUFFIX =
  /\b(llc|l\.l\.c\.|lp|l\.p\.|llp|inc|inc\.|corp|corporation|co|company|ltd|limited|trust|group|partners|capital|holdings?|holdco|ventures|management|associates|gmbh|ag|s\.a\.|sa|nv|bv|kg|pte|plc|foundation|office)\b/i;

function cleanName(display: string): string {
  return display.replace(/\s*\(CIK \d+\)\s*$/, '').replace(/\s*\([A-Z0-9,\s.-]+\)\s*$/, '').trim();
}

async function searchPage(phrase: string, forms: string, from: number): Promise<EftsResponse> {
  const url = `${EFTS}?q=${encodeURIComponent(phrase)}&forms=${encodeURIComponent(forms)}&from=${from}`;
  return fetchJson<EftsResponse>(url);
}

export async function searchFullText(maxPagesPerPhrase = 20): Promise<FullTextCandidate[]> {
  const byCik = new Map<string, FullTextCandidate>();

  for (const phrase of PHRASES) {
    const forms = FORMS.join(',');
    let total = Infinity;

    for (let page = 0; page < maxPagesPerPhrase && page * PAGE_SIZE < total; page++) {
      let res: EftsResponse;
      try {
        res = await searchPage(phrase, forms, page * PAGE_SIZE);
      } catch (err) {
        console.warn(`  efts ${phrase} page ${page} failed: ${err instanceof Error ? err.message : err}`);
        break;
      }
      total = res.hits.total.value;
      if (res.hits.hits.length === 0) break;

      for (const hit of res.hits.hits) {
        const { ciks, display_names, biz_locations, form, file_date, adsh } = hit._source;

        // Index 0 is usually the subject company, but EDGAR does not guarantee the
        // ordering, so every party is recorded and the counterparty count is used
        // later to tell investors from subjects rather than trusting position.
        for (let i = 0; i < display_names.length; i++) {
          const cik = ciks[i];
          const display = display_names[i];
          if (!cik || !display) continue;

          const name = cleanName(display);
          if (!name) continue;

          const others = display_names.filter((_, j) => j !== i).map(cleanName);
          const existing = byCik.get(cik);

          if (existing) {
            existing.forms.add(form);
            existing.phrases.add(phrase);
            existing.filingCount++;
            for (const o of others) existing.counterparties.add(o);
            if (file_date > existing.latestFiling) existing.latestFiling = file_date;
          } else {
            byCik.set(cik, {
              cik,
              name,
              location: biz_locations[i] ?? '',
              forms: new Set([form]),
              phrases: new Set([phrase]),
              filingCount: 1,
              latestFiling: file_date,
              exampleAccession: adsh,
              isEntity: CORPORATE_SUFFIX.test(name),
              counterparties: new Set(others),
            });
          }
        }
      }
    }
    console.log(`  ${phrase.padEnd(30)} ${total} filings matched`);
  }

  return [...byCik.values()].sort((a, b) => b.filingCount - a.filingCount);
}

export function toDiscovery(c: FullTextCandidate): Discovery {
  const form = [...c.forms][0] ?? '';
  return {
    channel: form.startsWith('SC 13') ? 'sec_13dg' : 'sec_form_d',
    sourceUrl: `https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=${c.cik}&type=&dateb=&owner=include&count=40`,
    discoveredAt: new Date().toISOString(),
    externalId: c.cik,
    rawName: c.name,
  };
}
