import { readFileSync } from 'node:fs';

/**
 * Adjudicating a UK director's service address to an individual.
 *
 * Companies House requires every director to file a service address — where
 * they personally accept legal documents. Most are useless as a contact route
 * because they are the company's own address, or a formation agent's, or one
 * floor of a building shared by every director of the firm.
 *
 * The test is the same one that made the SEC phone channel credible: an
 * identifier used by more than one party belongs to none of them.
 *
 *   - equal to the registered office        -> the company's address, not theirs
 *   - used by more than one company         -> a formation agent or accountant
 *   - shared by two directors at the firm   -> belongs to neither individually
 *
 * On the Stage 1 candidate file this rejects 435 of 641 records and adjudicates
 * 206 to an individual. The rejection rate is the point: an unadjudicated
 * "director address" figure would be more than three times larger and mean
 * nothing.
 *
 * **Known limit, stated rather than hidden.** The cross-company index is built
 * from the candidate file we already hold, exactly as the SEC index is built
 * from one quarterly census. An agent address that appears only outside that
 * file cannot be detected, so the check is conservative in one direction only:
 * it can miss an agent, never invent one.
 */

export interface AddressAdjudication {
  ownership: 'individual' | 'company' | 'unknown';
  reason: string;
  normalised: string;
}

export function normaliseAddress(a: Record<string, unknown> | null | undefined): string {
  if (!a) return '';
  return [a.address_line_1, a.address_line_2, a.locality, a.postal_code]
    .filter(Boolean)
    .join('|')
    .toUpperCase()
    .replace(/\s+/g, ' ')
    .trim();
}

const addressToCompanies = new Map<string, Set<string>>();
const addressToPeople = new Map<string, Map<string, Set<string>>>();
let built = false;

/** Built once from the candidate file, which is our address census. */
export function buildAddressIndex(candidatesPath: string): void {
  if (built) return;
  const uk = JSON.parse(readFileSync(candidatesPath, 'utf8')) as {
    companies: Array<{ companyNumber: string; officers?: Array<Record<string, any>> }>;
  };
  for (const c of uk.companies) {
    for (const o of c.officers ?? []) {
      if (o.resigned_on || !/director/i.test(String(o.officer_role ?? ''))) continue;
      const a = normaliseAddress(o.address);
      if (!a) continue;
      if (!addressToCompanies.has(a)) addressToCompanies.set(a, new Set());
      addressToCompanies.get(a)!.add(c.companyNumber);
      if (!addressToPeople.has(a)) addressToPeople.set(a, new Map());
      const perCo = addressToPeople.get(a)!;
      if (!perCo.has(c.companyNumber)) perCo.set(c.companyNumber, new Set());
      perCo.get(c.companyNumber)!.add(String(o.name ?? '').toLowerCase().replace(/[^a-z]/g, ''));
    }
  }
  built = true;
}

/** Live officers from the current fetch, so a company outside the index still adjudicates. */
export function adjudicateDirectorAddress(opts: {
  companyNumber: string;
  personName: string;
  address: Record<string, unknown> | null | undefined;
  registeredOffice: Record<string, unknown> | null | undefined;
  siblingDirectorAddresses: string[];
}): AddressAdjudication {
  const normalised = normaliseAddress(opts.address);
  if (!normalised) {
    return { ownership: 'unknown', reason: 'no service address filed', normalised };
  }

  const reg = normaliseAddress(opts.registeredOffice);
  if (reg && normalised === reg) {
    return {
      ownership: 'company',
      reason: 'service address is the registered office, so it is the company address rather than the individual\'s',
      normalised,
    };
  }

  const companies = addressToCompanies.get(normalised);
  if (companies && companies.size > 1) {
    return {
      ownership: 'company',
      reason: `address also filed by ${companies.size - 1} other company/companies; formation agent or professional address`,
      normalised,
    };
  }

  // Live check against the other directors on this same filing, which catches a
  // shared floor even when the company is not in the index.
  const shared = opts.siblingDirectorAddresses.filter((a) => a === normalised).length;
  if (shared > 1) {
    return {
      ownership: 'company',
      reason: `address shared by ${shared} directors at this company, so it belongs to none of them individually`,
      normalised,
    };
  }

  const perCo = addressToPeople.get(normalised);
  if (perCo) {
    for (const people of perCo.values()) {
      if (people.size > 1) {
        return {
          ownership: 'company',
          reason: 'address shared by more than one director at this company',
          normalised,
        };
      }
    }
  }

  return {
    ownership: 'individual',
    reason:
      'service address filed by this director on the statutory register, not the registered office, ' +
      'not reused by another company, and not shared with another director',
    normalised,
  };
}
