/**
 * Finds a firm's own website.
 *
 * Separate from establish-type because most qualifying records came through the
 * UK registry, which proves who controls a company and says nothing about where
 * it lives online. Without a domain there is no contact enrichment, and without
 * contact enrichment the file is candid but not sellable.
 *
 * The bar for accepting a domain is deliberately high. Attaching the wrong
 * firm's site produces contact details for the wrong company, which is worse
 * than an honest blank - it is a confident error a client would act on.
 */
import { promises as dns } from 'node:dns';
import { fetchPageText, search } from '../lib/serper.js';
import { isOwnDomain } from './source-tier.js';

export interface WebsiteFinding {
  website: string | null;
  confirmedBy: string;
  candidatesSeen: number;
}

const DIRECTORY =
  /(linkedin|facebook|twitter|x\.com|instagram|crunchbase|bloomberg|zoominfo|dnb\.com|opencorporates|bizapedia|companieshouse|find-and-update|endole|companycheck|glassdoor|indeed|yell\.com|trustpilot|wikipedia)/i;

/**
 * Likely domains built straight from the firm's name. Free, instant, and it works
 * for exactly the firms search engines rank poorly - a small family office with
 * one page and no inbound links is often invisible to search but sitting on the
 * obvious domain.
 */
function guessDomains(firmName: string): string[] {
  const bare = firmName
    .toLowerCase()
    .replace(/\b(llc|l\.l\.c\.|inc|corp|corporation|ltd|limited|lp|l\.p\.|plc|the)\b/g, ' ')
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
  if (bare.length === 0) return [];

  const full = bare.join('');
  const noFamilyOffice = bare.filter((w) => w !== 'family' && w !== 'office').join('');

  const stems = [...new Set([full, noFamilyOffice].filter((s) => s.length >= 5))];
  const tlds = ['.com', '.co.uk', '.net', '.org'];
  return stems.flatMap((s) => tlds.map((t) => s + t)).slice(0, 8);
}

async function domainResolves(domain: string): Promise<boolean> {
  try {
    await dns.resolve4(domain);
    return true;
  } catch {
    try {
      await dns.resolveCname(domain);
      return true;
    } catch {
      return false;
    }
  }
}

export async function findWebsite(firmName: string, location = ''): Promise<WebsiteFinding> {
  const out: WebsiteFinding = { website: null, confirmedBy: '', candidatesSeen: 0 };

  // Cheapest path first: guess the obvious domain and see if it exists and
  // actually belongs to this firm.
  for (const domain of guessDomains(firmName)) {
    if (!(await domainResolves(domain))) continue;
    out.candidatesSeen++;
    const url = `https://${domain}`;
    try {
      const text = await fetchPageText(url, 4000);
      if (text.length < 200) continue;
      if (!isOwnDomain(url, firmName, text)) continue;
      return { website: url, confirmedBy: 'domain derived from the firm name, and the live page names the firm', candidatesSeen: out.candidatesSeen };
    } catch {
      continue;
    }
  }

  let results;
  try {
    results = await search(`"${firmName}" ${location}`.trim());
  } catch {
    return { ...out, confirmedBy: 'search failed' };
  }

  const candidates = results.filter((r) => !DIRECTORY.test(r.link)).slice(0, 5);
  out.candidatesSeen = candidates.length;

  for (const r of candidates) {
    // Cheap check first: does the host look like the firm at all?
    if (!isOwnDomain(r.link, firmName)) {
      let text: string;
      try {
        text = await fetchPageText(r.link, 4000);
      } catch {
        continue;
      }
      // Expensive check: the page must actually name the firm.
      if (!isOwnDomain(r.link, firmName, text)) continue;
      out.website = new URL(r.link).origin;
      out.confirmedBy = 'domain derived from the firm name, and the page names the firm';
      return out;
    }
    out.website = new URL(r.link).origin;
    out.confirmedBy = 'domain derived from the firm name';
    return out;
  }

  return { ...out, confirmedBy: 'no candidate domain could be tied to this firm' };
}
