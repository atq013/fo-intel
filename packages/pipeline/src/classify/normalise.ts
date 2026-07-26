/**
 * Location and name normalisation applied at consolidation.
 *
 * Sources disagree about what a "country" is: Companies House returns the home
 * nation ("England", "Wales"), web extraction returns whatever the page said
 * ("Miami-Fort Lauderdale Area", "US & Middle East"). Left alone these become
 * distinct rows in any country facet the customer filters on, which makes the
 * product look broken even though every underlying record is correct.
 */

const HOME_NATIONS = /^(england|scotland|wales|northern ireland|great britain|uk|u\.k\.)$/i;
const UK_CITIES = /^(london|manchester|birmingham|leeds|edinburgh|glasgow|bristol|cardiff|belfast)$/i;
const US_TOKENS = /\b(usa|u\.s\.a\.|united states|us|america)\b/i;

const COUNTRY_ALIASES: Array<[RegExp, string]> = [
  [/^(usa|u\.s\.a\.|us|united states.*|america)$/i, 'United States'],
  [HOME_NATIONS, 'United Kingdom'],
  [UK_CITIES, 'United Kingdom'],
  [/^(uae|united arab emirates|dubai|abu dhabi)$/i, 'United Arab Emirates'],
  [/^(ksa|saudi.*)$/i, 'Saudi Arabia'],
  [/^(hong kong|hk)$/i, 'Hong Kong'],
  [/^(swiss|switzerland|zurich|geneva)$/i, 'Switzerland'],
  [/^(singapore|sg)$/i, 'Singapore'],
];

/** US state codes and names, for the many records that only carry a state. */
const US_STATES = new Set([
  'al','ak','az','ar','ca','co','ct','de','fl','ga','hi','id','il','in','ia','ks','ky','la','me','md','ma','mi','mn',
  'ms','mo','mt','ne','nv','nh','nj','nm','ny','nc','nd','oh','ok','or','pa','ri','sc','sd','tn','tx','ut','vt','va',
  'wa','wv','wi','wy','dc','vi','pr',
]);

export function normaliseCountry(raw: string): string {
  const v = (raw ?? '').trim();
  if (!v) return '';

  for (const [re, canonical] of COUNTRY_ALIASES) {
    if (re.test(v)) return canonical;
  }
  if (US_STATES.has(v.toLowerCase())) return 'United States';

  // Freeform strings from web extraction: take the last comma-separated token
  // and try again, so "Charleston, South Carolina, US" resolves.
  if (v.includes(',')) {
    const tail = v.split(',').pop()!.trim();
    if (tail && tail !== v) {
      const resolved = normaliseCountry(tail);
      if (resolved) return resolved;
    }
  }
  if (US_TOKENS.test(v)) return 'United States';

  // Multi-region strings describe presence, not domicile, and are not a country.
  if (/\s(&|and)\s/.test(v) || v.split(/\s+/).length > 4) return '';

  return v.replace(/\b\w/g, (c) => c.toUpperCase());
}

/**
 * Job postings hide the employer, so extraction faithfully returns "Confidential"
 * or "Single Family Office" as a firm name. Re-checked here as well as at
 * discovery, because a stale candidate file must not be able to reintroduce them.
 */
const PLACEHOLDER_NAME =
  /^(confidential|private|undisclosed|anonymous|a |an |the )?\s*(single[- ]?family|multi[- ]?family|global)?\s*family\s*office\s*(\(.*\))?$|^confidential\b|^(n\/a|unknown|not disclosed)$/i;

export function isUsableName(name: string): boolean {
  const n = (name ?? '').trim();
  if (n.length < 4) return false;
  if (PLACEHOLDER_NAME.test(n)) return false;
  const stripped = n
    .toLowerCase()
    .replace(/\b(family|office|single|multi|group|the|of|a|an)\b/g, '')
    .replace(/[^a-z0-9]/g, '');
  return stripped.length >= 3;
}
