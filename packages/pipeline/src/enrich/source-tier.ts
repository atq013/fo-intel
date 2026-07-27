/**
 * Source tiering and claim reconciliation.
 *
 * Written after a known-answer test caught the pipeline asserting something
 * false. Cascade Investment is Bill Gates's single-family office. Two runs
 * quoted two different sources, both verbatim, both located in the page:
 *
 *   altss.com   "a single-family office ... controlled by William H. Gates III"
 *   preqin.com  "Cascade Investment is a US-based multi-family office"
 *
 * Verifying that a quote exists is not the same as verifying that it is true.
 * The pipeline had no notion that some sources deserve more belief than others,
 * so it accepted whichever the extractor happened to land on.
 *
 * Tiers rank how much a source's self-description is worth. Reconciliation then
 * prefers the best tier, and refuses to assert anything when equally credible
 * sources disagree - a conflict is a reason to withhold a claim, not to pick one.
 */

export type SourceTier = 1 | 2 | 3 | 4;

/** Recognised financial press. Reports on firms, and issues corrections. */
const PRESS =
  /(ft\.com|wsj\.com|bloomberg\.com|reuters\.com|nytimes\.com|forbes\.com|fortune\.com|economist\.com|barrons\.com|institutionalinvestor\.com|citywire|privateequityinternational|penews\.com|businessinsider\.com|cnbc\.com|axios\.com)/i;

/** Profile databases. Useful for discovery, frequently wrong about classification. */
const AGGREGATOR =
  /(preqin|altss|crunchbase|pitchbook|zoominfo|dnb\.com|opencorporates|unusualwhales|whalewisdom|marketscreener|stockcircle|fintel|holdingschannel|wikipedia|linkedin|bizapedia|corporationwiki)/i;

/** Statutory registries. Authoritative on existence and control, silent on type. */
const REGISTRY = /(sec\.gov|company-information\.service\.gov\.uk|companieshouse|irs\.gov|\.gov(\/|$))/i;

const STOP_TOKENS = new Set([
  'family', 'office', 'the', 'llc', 'inc', 'lp', 'ltd', 'group', 'capital', 'holdings',
  'management', 'trust', 'partners', 'company', 'investments', 'investment', 'limited',
]);

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return '';
  }
}

/**
 * True when the page lives on a domain derived from the firm's own name.
 *
 * A single shared token is not enough. "Cascade Investment" (Bill Gates's family
 * office) matched cascadeassetmanagement.com on the token "cascade" alone - a
 * different firm entirely, and attaching its site would have produced contact
 * details for the wrong company. So a lone token now has to be distinctive, and
 * ordinary industry words never count on their own.
 */
export function isOwnDomain(url: string, firmName: string, pageText?: string): boolean {
  const host = hostOf(url);
  if (!host || AGGREGATOR.test(host) || PRESS.test(host) || REGISTRY.test(host)) return false;

  const compact = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
  const bareName = firmName.replace(/\b(llc|l\.l\.c\.|inc|corp|corporation|ltd|limited|lp|l\.p\.|plc|company|co)\b/gi, '');
  const nameCompact = compact(bareName);

  // Strongest signal: the host contains the whole firm name. Checked before the
  // token logic because stop words like "family" and "office" are stripped from
  // tokens but are part of the domain - koppfamilyoffice.com is unmistakably
  // Kopp Family Office's site.
  if (nameCompact.length >= 6 && compact(host).includes(nameCompact)) return true;

  const tokens = firmName
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length >= 4 && !STOP_TOKENS.has(t));
  if (tokens.length === 0) return false;

  const matched = tokens.filter((t) => host.includes(t));
  if (matched.length === 0) return false;

  // Two or more name tokens in the host is strong enough on its own.
  if (matched.length >= 2) return true;

  // A single token has to be distinctive, and even then the page must name the
  // firm - otherwise "cascade" matches any firm with cascade in its domain.
  // A short single token needs the page to name the firm before it counts.
  // "kopp" alone could be anyone; kopp.com whose page says "Kopp Family Office"
  // could not.
  const token = matched[0]!;
  if (token.length < 4) return false;
  if (!pageText) return false;
  return nameCompact.length >= 6 && compact(pageText).includes(nameCompact);
}

export function tierOf(url: string, firmName: string, pageText?: string): SourceTier {
  if (isOwnDomain(url, firmName, pageText)) return 1;
  const host = hostOf(url);
  if (REGISTRY.test(host)) return 1;
  if (PRESS.test(host)) return 2;
  if (AGGREGATOR.test(host)) return 3;
  return 4;
}

export const TIER_LABEL: Record<SourceTier, string> = {
  1: 'the firm itself or a statutory registry',
  2: 'recognised financial press',
  3: 'a third-party profile database',
  4: 'an unranked web source',
};

export interface Claim<T extends string> {
  sourceUrl: string;
  tier: SourceTier;
  value: T;
  quote: string;
}

export interface Reconciled<T extends string> {
  value: T | null;
  confidence: number;
  tier: SourceTier | null;
  supporting: Claim<T>[];
  conflicting: Claim<T>[];
  note: string;
}

/**
 * Confidence starts from the best tier that supports the winning claim, is
 * raised slightly by independent agreement, and is cut hard when a source of
 * equal standing disagrees. Tier 4 alone never clears a usable threshold.
 */
const TIER_BASE: Record<SourceTier, number> = { 1: 0.85, 2: 0.7, 3: 0.5, 4: 0.3 };

export function reconcile<T extends string>(claims: Claim<T>[], undetermined: T): Reconciled<T> {
  const usable = claims.filter((c) => c.value !== undetermined && c.quote);
  if (usable.length === 0) {
    return { value: null, confidence: 0, tier: null, supporting: [], conflicting: [], note: 'no source established a type' };
  }

  const bestTier = Math.min(...usable.map((c) => c.tier)) as SourceTier;
  const atBestTier = usable.filter((c) => c.tier === bestTier);

  const votes = new Map<T, Claim<T>[]>();
  for (const c of atBestTier) {
    if (!votes.has(c.value)) votes.set(c.value, []);
    votes.get(c.value)!.push(c);
  }

  // Sources of equal standing disagreeing is a reason to distrust the answer.
  // A clear majority is still usable, at reduced confidence and with the dissent
  // recorded; a genuine tie is not, and the claim is withheld.
  const ordered = [...votes.entries()].sort((a, b) => b[1].length - a[1].length);
  const [top, runnerUp] = ordered;
  const contested = votes.size > 1;

  if (contested && runnerUp && top![1].length === runnerUp[1].length) {
    return {
      value: null,
      confidence: 0,
      tier: bestTier,
      supporting: [],
      conflicting: atBestTier,
      note: `sources of equal standing disagree with no majority (${[...votes.keys()].join(' vs ')}); withheld`,
    };
  }

  const [value, supporting] = top!;
  const dissent = contested ? atBestTier.filter((c) => c.value !== value) : [];
  const lowerTierAgreeing = usable.filter((c) => c.tier > bestTier && c.value === value);
  const lowerTierDisagreeing = usable.filter((c) => c.tier > bestTier && c.value !== value);

  let confidence = TIER_BASE[bestTier];
  if (supporting.length > 1 || lowerTierAgreeing.length > 0) confidence = Math.min(confidence + 0.08, 0.95);
  if (lowerTierDisagreeing.length > 0) confidence = Math.max(confidence - 0.15, 0.2);
  // A same-tier source contradicting the majority is the strongest warning available.
  if (dissent.length > 0) confidence = Math.max(confidence - 0.25, 0.15);

  const conflicting = [...dissent, ...lowerTierDisagreeing];
  const note = dissent.length
    ? `${supporting.length} of ${atBestTier.length} equally ranked sources say ${value}; ${dissent.length} disagree`
    : lowerTierDisagreeing.length
      ? `${TIER_LABEL[bestTier]} says ${value}; ${lowerTierDisagreeing.length} lower-ranked source(s) disagree`
      : `established by ${TIER_LABEL[bestTier]}${lowerTierAgreeing.length ? `, corroborated by ${lowerTierAgreeing.length} other source(s)` : ''}`;

  return { value, confidence, tier: bestTier, supporting, conflicting, note };
}
