/**
 * Channels 3-6: leadership pages, principal profiles, conference pages,
 * regulatory signature pages other than 13F.
 *
 * Identical adjudication to the SEC channel: a route counts only when evidence
 * ties it to a NAMED INDIVIDUAL, not to the firm. The shape rules are shared so
 * the comparison stays fair.
 */
import { fetchPageText, search } from '../lib/serper.js';
import { shapeDisqualifies } from './reachability.js';

export interface ProbeResult {
  firm: string;
  channel: string;
  personIdentified: string | null;
  routeFound: { channel: 'email' | 'phone'; value: string } | null;
  ownershipEvidenced: boolean;
  ownershipReason: string;
  passesGate5: boolean;
  apiCalls: number;
  wallMs: number;
}

const EMAIL = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g;
const PHONE = /(\+?\d[\d\s().-]{8,18}\d)/g;

const NOISE =
  /(sentry|wixpress|example\.|yourdomain|godaddy|squarespace|wordpress|no-?reply|postmaster|abuse@|privacy@|dmca|\.png|\.jpg)/i;

/**
 * Ownership test for a scraped route: the address must encode the person's name.
 * first.last@, flast@, firstl@ and similar. A route that does not encode a name
 * reaches the firm, whatever page it sat on.
 */
export function emailEncodesPerson(email: string, person: string): boolean {
  const local = email.split('@')[0]!.toLowerCase().replace(/[^a-z]/g, '');
  const parts = person.toLowerCase().replace(/[^a-z\s]/g, ' ').split(/\s+/).filter((t) => t.length >= 2);
  if (parts.length < 2 || local.length < 3) return false;
  const first = parts[0]!, last = parts[parts.length - 1]!;
  return (
    local === `${first}${last}` ||
    local === `${first}.${last}`.replace('.', '') ||
    local === `${first[0]}${last}` ||
    local === `${first}${last[0]}` ||
    (local.includes(last) && last.length >= 4) ||
    (local === first && first.length >= 5)
  );
}

/** Proximity: a phone counts only if it sits near the person's name on the page. */
export function phoneNearPerson(text: string, phone: string, person: string): boolean {
  const surname = person.toLowerCase().replace(/[^a-z\s]/g, ' ').split(/\s+/).filter(Boolean).pop();
  if (!surname || surname.length < 3) return false;
  const t = text.toLowerCase();
  const pi = t.indexOf(phone.toLowerCase().slice(0, 8));
  const ni = t.indexOf(surname);
  if (pi < 0 || ni < 0) return false;
  return Math.abs(pi - ni) < 400;
}

export async function probeLeadershipPage(firm: string, hint: string): Promise<ProbeResult> {
  const t0 = Date.now();
  let calls = 0;
  const base: ProbeResult = {
    firm, channel: 'firm_leadership_page', personIdentified: null, routeFound: null,
    ownershipEvidenced: false, ownershipReason: 'no leadership page reached',
    passesGate5: false, apiCalls: 0, wallMs: 0,
  };

  let results;
  try { results = await search(`"${firm}" ${hint} team OR leadership OR "our people"`.trim()); calls++; }
  catch { return { ...base, apiCalls: calls, wallMs: Date.now() - t0, ownershipReason: 'search failed' }; }

  const DIRECTORY = /(linkedin|crunchbase|bloomberg|zoominfo|dnb\.com|opencorporates|companieshouse|find-and-update|wikipedia|facebook|twitter)/i;
  for (const r of results.filter((x) => !DIRECTORY.test(x.link)).slice(0, 3)) {
    let text: string;
    try { text = await fetchPageText(r.link, 9000); calls++; } catch { continue; }
    if (text.length < 300) continue;

    const emails = [...new Set(text.match(EMAIL) ?? [])].filter((e) => !NOISE.test(e));
    const phones = [...new Set(text.match(PHONE) ?? [])];
    // a named person on the page, taken as two capitalised words near a title word
    const nameHit = text.match(/\b([A-Z][a-z]{2,}\s+[A-Z][a-z]{2,})\b(?=[^.]{0,60}\b(Partner|Director|Officer|President|Founder|Manager|Chief|Head)\b)/);
    const person = nameHit?.[1] ?? null;

    for (const e of emails) {
      if (shapeDisqualifies({ channel: 'email', value: e })) continue;
      if (person && emailEncodesPerson(e, person)) {
        return { firm, channel: 'firm_leadership_page', personIdentified: person,
          routeFound: { channel: 'email', value: e }, ownershipEvidenced: true,
          ownershipReason: `address encodes the person's name, published on ${new URL(r.link).hostname}`,
          passesGate5: true, apiCalls: calls, wallMs: Date.now() - t0 };
      }
    }
    for (const p of phones) {
      if (shapeDisqualifies({ channel: 'phone', value: p })) continue;
      if (person && phoneNearPerson(text, p, person)) {
        return { firm, channel: 'firm_leadership_page', personIdentified: person,
          routeFound: { channel: 'phone', value: p }, ownershipEvidenced: true,
          ownershipReason: `number published adjacent to the person's name on ${new URL(r.link).hostname}`,
          passesGate5: true, apiCalls: calls, wallMs: Date.now() - t0 };
      }
    }
    if (person || emails.length || phones.length) {
      return { firm, channel: 'firm_leadership_page', personIdentified: person,
        routeFound: emails[0] ? { channel: 'email', value: emails[0] } : null,
        ownershipEvidenced: false,
        ownershipReason: person ? 'person found but no route ties to them' : 'routes found but no named person',
        passesGate5: false, apiCalls: calls, wallMs: Date.now() - t0 };
    }
  }
  return { ...base, apiCalls: calls, wallMs: Date.now() - t0 };
}
