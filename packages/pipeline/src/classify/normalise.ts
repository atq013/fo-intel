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

/**
 * Web extraction returns whatever form the page used: "U.S.", "JP", "KW", "UK".
 * Each becomes its own row in the country facet a customer filters on, which
 * makes the product look broken even though every record is correct.
 */
const COUNTRY_ALIASES: Array<[RegExp, string]> = [
  [/^(usa|u\.s\.a?\.?|us|united states.*|america|north america)$/i, 'United States'],
  [/^(jp|jpn|japan)$/i, 'Japan'],
  [/^(kw|kwt|kuwait)$/i, 'Kuwait'],
  [/^(in|ind|india)$/i, 'India'],
  [/^(hk|hkg|hong kong.*)$/i, 'Hong Kong'],
  [/^(ca|can|canada)$/i, 'Canada'],
  [/^(au|aus|australia)$/i, 'Australia'],
  [/^(de|deu|germany|deutschland)$/i, 'Germany'],
  [/^(fr|fra|france)$/i, 'France'],
  [/^(ch|che)$/i, 'Switzerland'],
  [/^(ae|are)$/i, 'United Arab Emirates'],
  [/^(sa|sau|kingdom of saudi arabia|saudi.*)$/i, 'Saudi Arabia'],
  [/^(sultanate of oman|oman)$/i, 'Oman'],
  [/^(uae|united arab emirates|u\.a\.e\.?)$/i, 'United Arab Emirates'],
  [/^(sg|sgp)$/i, 'Singapore'],
  [/^(gb|gbr)$/i, 'United Kingdom'],
  [HOME_NATIONS, 'United Kingdom'],
  [UK_CITIES, 'United Kingdom'],
  [/^(uae|united arab emirates|dubai|abu dhabi)$/i, 'United Arab Emirates'],
  [/^(ksa|saudi.*)$/i, 'Saudi Arabia'],
  [/^(hong kong|hk)$/i, 'Hong Kong'],
  [/^(swiss|switzerland|zurich|geneva)$/i, 'Switzerland'],
  [/^(singapore|sg)$/i, 'Singapore'],
];

/**
 * US states, by code and by full name. Records frequently carry only a state -
 * SEC addresses give "NY", web extraction gives "New York" - and left alone each
 * becomes its own row in the country facet a customer filters on.
 */
const US_STATES = new Set([
  'al','ak','az','ar','ca','co','ct','de','fl','ga','hi','id','il','in','ia','ks','ky','la','me','md','ma','mi','mn',
  'ms','mo','mt','ne','nv','nh','nj','nm','ny','nc','nd','oh','ok','or','pa','ri','sc','sd','tn','tx','ut','vt','va',
  'wa','wv','wi','wy','dc','vi','pr',
  'alabama','alaska','arizona','arkansas','california','colorado','connecticut','delaware','florida','georgia',
  'hawaii','idaho','illinois','indiana','iowa','kansas','kentucky','louisiana','maine','maryland','massachusetts',
  'michigan','minnesota','mississippi','missouri','montana','nebraska','nevada','new hampshire','new jersey',
  'new mexico','new york','north carolina','north dakota','ohio','oklahoma','oregon','pennsylvania','rhode island',
  'south carolina','south dakota','tennessee','texas','utah','vermont','virginia','washington','west virginia',
  'wisconsin','wyoming','district of columbia',
]);

/** Values web extraction returns when the page named no location. */
const NOT_A_COUNTRY =
  /^(unclear|unknown|n\/a|none|global|international|worldwide|various|multiple|gulf region|middle east|europe|asia|africa|americas|north america|emea|apac)$/i;

export function normaliseCountry(raw: string): string {
  const v = (raw ?? '').trim();
  if (!v || NOT_A_COUNTRY.test(v)) return '';

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

/**
 * Extraction sometimes returns something that is not a firm name at all: a
 * sentence lifted from a job advert ("JRG Partners is proud to conduct an
 * exclusive search..."), or a person with their title ("Royan Jade, 3rd
 * Generation Leader, Wing Cheung Jewellery"). Both look plausible in isolation
 * and neither identifies an entity a client could contact.
 */
const SENTENCE_FRAGMENT = /\b(is proud|we are|we're|is seeking|is looking|our client|is conducting|is pleased|has been retained|on behalf of our)\b/i;

/** A role title following a comma marks the string as a person, not a firm. */
const PERSON_WITH_TITLE =
  /,\s*(\d(st|nd|rd|th)\s+generation|founder|ceo|cio|chair|chairman|president|partner|director|principal|head of|managing|owner|trustee)\b/i;

function looksLikeAFirmName(name: string): boolean {
  const n = name.trim();
  if (n.length > 62) return false;
  if (n.split(/\s+/).length > 7) return false;
  if (SENTENCE_FRAGMENT.test(n)) return false;
  if (PERSON_WITH_TITLE.test(n)) return false;
  return true;
}

export function isUsableName(name: string): boolean {
  const n = (name ?? '').trim();
  if (n.length < 4) return false;
  if (PLACEHOLDER_NAME.test(n)) return false;
  if (!looksLikeAFirmName(n)) return false;
  const stripped = n
    .toLowerCase()
    .replace(/\b(family|office|single|multi|group|the|of|a|an)\b/g, '')
    .replace(/[^a-z0-9]/g, '');
  return stripped.length >= 3;
}
