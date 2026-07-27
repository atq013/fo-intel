/**
 * Contact discovery.
 *
 * Order is deliberate and runs cheapest-first:
 *   1. the firm's own site - published addresses, free, highest confidence
 *   2. pattern derivation against a confirmed domain, verified by SMTP - free
 *   3. Hunter - a paid vendor with 50 free credits, reserved for firms where the
 *      first two failed and the record is otherwise strong
 *
 * Hunter is named plainly wherever it contributed, per the brief's rule about
 * vendors appearing in the trail. It is used to verify and to surface published
 * addresses - never to hand over a finished record, which would demonstrate the
 * vendor's capability rather than this system's.
 */
import type { Cell, Evidence } from '@fo/core';
import { fetchText } from '../lib/http.js';
import { verifyEmail, isCustomerFacing, mxHostFor, type EmailCheck } from '../validate/email-verify.js';

const EMAIL_RE = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g;

/** Addresses that belong to the web stack rather than the firm. */
const NOISE =
  /(sentry|wixpress|example\.|yourdomain|sentry\.io|\.png$|\.jpg$|\.gif$|godaddy|squarespace|wordpress|no-?reply|postmaster|abuse@|privacy@|dmca)/i;

let hunterCallsUsed = 0;
export const hunterUsage = () => hunterCallsUsed;

export interface ContactFinding {
  emails: Array<EmailCheck & { source: string; vendor?: string; personName?: string; personTitle?: string }>;
  phones: Array<{ value: string; source: string }>;
  pagesTried: string[];
}

function candidatePages(website: string): string[] {
  let origin: string;
  try {
    origin = new URL(website).origin;
  } catch {
    return [];
  }
  return [origin, `${origin}/contact`, `${origin}/contact-us`, `${origin}/about`, `${origin}/team`];
}

function harvestEmails(html: string, domain: string): string[] {
  const found = new Set<string>();
  for (const raw of html.match(EMAIL_RE) ?? []) {
    const addr = raw.toLowerCase();
    if (NOISE.test(addr)) continue;
    // Only keep addresses on the firm's own domain; anything else is a third party.
    if (!addr.endsWith(`@${domain}`)) continue;
    found.add(addr);
  }
  return [...found];
}

const PHONE_RE = /(\+?\d[\d\s().-]{8,18}\d)/g;

function harvestPhones(text: string): string[] {
  const out = new Set<string>();
  for (const raw of text.match(PHONE_RE) ?? []) {
    const digits = raw.replace(/\D/g, '');
    if (digits.length < 9 || digits.length > 15) continue;
    // Reject strings that are obviously dates or ids rather than numbers.
    if (/^(19|20)\d{6,}$/.test(digits)) continue;
    out.add(raw.trim());
  }
  return [...out];
}

/** Common corporate address shapes, ordered by how often they are right. */
function patternsFor(fullName: string, domain: string): string[] {
  const parts = fullName
    .replace(/,/g, ' ')
    .toLowerCase()
    .replace(/[^a-z\s]/g, '')
    .split(/\s+/)
    .filter(Boolean);
  if (parts.length < 2) return [];
  const first = parts[0]!;
  const last = parts[parts.length - 1]!;
  return [
    `${first}.${last}@${domain}`,
    `${first[0]}${last}@${domain}`,
    `${first}@${domain}`,
    `${first}${last}@${domain}`,
    `${last}${first[0]}@${domain}`,
  ];
}

async function hunterDomainSearch(domain: string): Promise<Array<{ email: string; name: string; position: string }>> {
  const key = process.env.HUNTER_API_KEY;
  if (!key) return [];
  try {
    const res = await fetch(`https://api.hunter.io/v2/domain-search?domain=${encodeURIComponent(domain)}&limit=10&api_key=${key}`);
    hunterCallsUsed++;
    if (!res.ok) return [];
    const json = (await res.json()) as {
      data?: { emails?: Array<{ value: string; first_name?: string; last_name?: string; position?: string }> };
    };
    return (json.data?.emails ?? []).map((e) => ({
      email: e.value,
      name: [e.first_name, e.last_name].filter(Boolean).join(' '),
      position: e.position ?? '',
    }));
  } catch {
    return [];
  }
}

export async function findContacts(
  website: string | null,
  principalName: string,
  opts: { allowVendor?: boolean } = {},
): Promise<ContactFinding> {
  const finding: ContactFinding = { emails: [], phones: [], pagesTried: [] };
  if (!website) return finding;

  let domain: string;
  try {
    domain = new URL(website).hostname.replace(/^www\./, '').toLowerCase();
  } catch {
    return finding;
  }

  // 1. The firm's own pages.
  const published = new Set<string>();
  for (const url of candidatePages(website)) {
    try {
      const html = await fetchText(url, { retries: 1, timeoutMs: 15_000 });
      finding.pagesTried.push(url);
      for (const e of harvestEmails(html, domain)) published.add(e);
      const text = html.replace(/<[^>]+>/g, ' ');
      for (const p of harvestPhones(text).slice(0, 2)) finding.phones.push({ value: p, source: url });
    } catch {
      /* a page that will not load is simply not evidence */
    }
  }

  for (const addr of [...published].slice(0, 6)) {
    const check = await verifyEmail(addr, true);
    finding.emails.push({ ...check, source: finding.pagesTried[0] ?? website });
  }

  // 2. Pattern derivation, only against a domain that can actually receive mail.
  const haveUsable = finding.emails.some((e) => isCustomerFacing(e.status));
  if (!haveUsable && principalName && (await mxHostFor(domain))) {
    for (const candidate of patternsFor(principalName, domain)) {
      const check = await verifyEmail(candidate, false);
      if (check.status === 'rejected') continue;
      finding.emails.push({ ...check, source: 'derived from the firm domain', personName: principalName });
      if (isCustomerFacing(check.status)) break;
    }
  }

  // 3. Vendor fallback, for strong records the free path could not reach.
  const stillNothing = !finding.emails.some((e) => isCustomerFacing(e.status));
  if (stillNothing && opts.allowVendor && hunterCallsUsed < 45) {
    for (const hit of await hunterDomainSearch(domain)) {
      const check = await verifyEmail(hit.email, true);
      finding.emails.push({
        ...check,
        source: `https://hunter.io/search/${domain}`,
        vendor: 'Hunter.io',
        personName: hit.name,
        personTitle: hit.position,
      });
      if (isCustomerFacing(check.status)) break;
    }
  }

  return finding;
}

export function emailCell(finding: ContactFinding): Cell<string> {
  const best = finding.emails.find((e) => isCustomerFacing(e.status));
  if (!best) {
    const inferred = finding.emails.find((e) => e.status === 'inferred');
    return {
      value: null,
      status: 'could_not_verify',
      evidence: [],
      confidence: 0,
      note: inferred
        ? `an address was derived but could not be confirmed: ${inferred.method}`
        : 'no address could be established',
    };
  }

  const evidence: Evidence = {
    sourceUrl: best.source,
    sourceClass: best.vendor ? 'vendor' : 'primary_web',
    method: best.method,
    observedAt: best.checkedAt,
    ...(best.vendor ? { vendor: best.vendor } : {}),
  };

  return {
    value: best.address,
    status: 'verified',
    evidence: [evidence],
    confidence: best.status === 'verified_published' ? 0.9 : 0.75,
  };
}

/** Addresses we found but will not present as verified. Carried separately, never in the contact cell. */
export function inferredEmails(finding: ContactFinding): string[] {
  return finding.emails.filter((e) => e.status === 'inferred').map((e) => e.address);
}
