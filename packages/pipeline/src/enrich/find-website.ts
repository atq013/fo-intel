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
import { promises as dnsPromises } from 'node:dns';
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

  const distinctive = bare.filter((w) => w !== 'family' && w !== 'office' && w !== 'holdings' && w !== 'group');

  /**
   * Firms use a narrower form of their name as a domain far more often than the
   * full registered one. Kopp Family Office LLC is kopp.com; Pinnacle Family
   * Office Investments L.P. is pinnaclefamilyoffice.com. Generating only the full
   * name and the name minus "family office" missed both.
   */
  const stems = [
    bare.join(''),
    distinctive.join(''),
    distinctive.slice(0, 2).join(''),
    distinctive[0] ? `${distinctive[0]}familyoffice` : '',
    distinctive[0] ? `${distinctive[0]}family` : '',
    distinctive[0] ?? '',
    bare.slice(0, 2).join(''),
  ];

  const unique = [...new Set(stems.filter((s) => s.length >= 4))];
  const tlds = ['.com', '.co.uk', '.net'];
  return unique.flatMap((s) => tlds.map((tld) => s + tld)).slice(0, 16);
}

const resolver = new dnsPromises.Resolver({ timeout: 2500, tries: 1 });
resolver.setServers(['1.1.1.1', '8.8.8.8']);

/** Uses public resolvers directly - the local one is unreliable on this network. */
async function domainResolves(domain: string): Promise<boolean> {
  try {
    await resolver.resolve4(domain);
    return true;
  } catch {
    try {
      await resolver.resolveCname(domain);
      return true;
    } catch {
      return false;
    }
  }
}

export async function findWebsite(firmName: string, location = ''): Promise<WebsiteFinding> {
  const out: WebsiteFinding = { website: null, confirmedBy: '', candidatesSeen: 0 };

  // Cheapest path first: guess the obvious domains and see which exist. Resolved
  // in parallel - sixteen sequential lookups against a flaky resolver took longer
  // than the search path they were meant to avoid.
  const guesses = guessDomains(firmName);
  const resolved = (
    await Promise.all(guesses.map(async (d) => ((await domainResolves(d)) ? d : null)))
  ).filter((d): d is string => d !== null);
  out.candidatesSeen = resolved.length;

  for (const domain of resolved.slice(0, 4)) {
    const url = `https://${domain}`;
    try {
      const text = await fetchPageText(url, 4000);
      // A domain that resolves but serves almost nothing is parked, not a website.
      if (text.length < 200) continue;
      if (!isOwnDomain(url, firmName, text)) continue;
      return {
        website: url,
        confirmedBy: 'domain derived from the firm name, and the live page names the firm',
        candidatesSeen: out.candidatesSeen,
      };
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
