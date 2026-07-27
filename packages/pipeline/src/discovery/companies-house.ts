/**
 * Discovery + evidence channel: UK Companies House.
 *
 * Reaches family offices with no US regulatory footprint at all, and carries
 * something none of the SEC channels do - Persons with Significant Control.
 * PSC is a statutory register of who actually controls the company.
 *
 * That makes one classification test available here that is unavailable almost
 * anywhere else: when a company's name carries a surname and a PSC carries the
 * same surname, the entity is controlled by that family. It is affirmative
 * evidence of single-family control rather than an inference from naming.
 */
import type { Cell, Evidence } from '@fo/core';
import { fetchJson } from '../lib/http.js';

const BASE = 'https://api.company-information.service.gov.uk';

/** SIC codes UK family offices register under. Head offices and holding companies dominate. */
const SIC_CODES = ['64205', '64303', '66300', '64209', '70100', '64999'];

/** Name fragments that co-occur with family wealth vehicles. */
const NAME_FRAGMENTS = ['family office', 'family investment', 'family holdings', 'family capital', 'legacy', 'heritage', 'family trust'];

function authHeader(): Record<string, string> {
  const key = process.env.COMPANIES_HOUSE_API_KEY;
  if (!key) throw new Error('COMPANIES_HOUSE_API_KEY not set');
  return { Authorization: `Basic ${Buffer.from(`${key}:`).toString('base64')}` };
}

interface AdvancedSearchResponse {
  hits: number;
  items?: Array<{
    company_name: string;
    company_number: string;
    company_status: string;
    date_of_creation: string;
    sic_codes?: string[];
    registered_office_address?: {
      address_line_1?: string;
      locality?: string;
      region?: string;
      postal_code?: string;
      country?: string;
    };
  }>;
}

export interface Officer {
  name: string;
  officer_role: string;
  occupation?: string;
  nationality?: string;
  appointed_on?: string;
  resigned_on?: string;
  country_of_residence?: string;
}

export interface Psc {
  name: string;
  kind: string;
  natures_of_control?: string[];
  nationality?: string;
  country_of_residence?: string;
  notified_on?: string;
  ceased_on?: string;
}

export interface UkCompany {
  companyNumber: string;
  name: string;
  status: string;
  incorporated: string;
  sicCodes: string[];
  street: string;
  city: string;
  region: string;
  postcode: string;
  country: string;
  officers: Officer[];
  psc: Psc[];
  /** Surnames shared between the company name and its controlling persons. */
  sharedSurnames: string[];
  matchedFragment: string;
  /** Accounts filing category - the closest free proxy for whether the entity has substance. */
  accountsType: string;
  lastAccountsTo: string;
  /** False for dormant, never-filed, and micro-entity shells. */
  hasSubstance: boolean;
  substanceNote: string;
}

const COMPANY_WORDS = new Set([
  'family','office','investment','investments','holdings','holding','capital','group','limited','ltd','llp','plc',
  'trust','trustees','legacy','heritage','partners','management','company','uk','the','and','estates','ventures',
]);

/** Tokens from a company name that could be a surname. */
function nameTokens(companyName: string): string[] {
  return companyName
    .toLowerCase()
    .replace(/[^a-z\s]/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length >= 3 && !COMPANY_WORDS.has(t));
}

/** Companies House renders people as "SURNAME, Forename Middle". */
function surnameOf(personName: string): string {
  const comma = personName.indexOf(',');
  const surname = comma > 0 ? personName.slice(0, comma) : personName.split(/\s+/).pop() ?? '';
  return surname.toLowerCase().replace(/[^a-z]/g, '');
}

async function getJson<T>(path: string): Promise<T | null> {
  try {
    return await fetchJson<T>(`${BASE}${path}`, { headers: authHeader(), retries: 2 });
  } catch {
    return null;
  }
}

interface CompanyProfile {
  accounts?: {
    last_accounts?: { type?: string; made_up_to?: string };
  };
  has_charges?: boolean;
}

/**
 * A family office that has never filed accounts, or files as dormant or a
 * micro-entity, is a registration rather than an operating business. The PSC
 * register still proves the family controls it - it just proves nothing about
 * whether there is capital behind it, and a record a fund manager cannot act on
 * is filler however well evidenced its label.
 */
const SHELL_ACCOUNT_TYPES = new Set(['dormant', 'micro-entity', 'null', '']);

function assessSubstance(profile: CompanyProfile | null, incorporated: string, officerCount: number) {
  const type = profile?.accounts?.last_accounts?.type ?? '';
  const madeUpTo = profile?.accounts?.last_accounts?.made_up_to ?? '';
  const ageYears = incorporated ? (Date.now() - Date.parse(incorporated)) / 31_557_600_000 : 0;

  if (!madeUpTo) {
    return { type, madeUpTo, hasSubstance: false, note: 'no accounts ever filed' };
  }
  if (SHELL_ACCOUNT_TYPES.has(type)) {
    return { type, madeUpTo, hasSubstance: false, note: `accounts filed as ${type || 'unspecified'}` };
  }
  if (ageYears < 2) {
    return { type, madeUpTo, hasSubstance: false, note: 'incorporated less than two years ago' };
  }
  return {
    type,
    madeUpTo,
    hasSubstance: true,
    note: `${type} accounts to ${madeUpTo}, ${officerCount} active officer(s)`,
  };
}

async function enrich(companyNumber: string, incorporated: string) {
  const [officersRes, pscRes, profile] = await Promise.all([
    getJson<{ items?: Officer[] }>(`/company/${companyNumber}/officers`),
    getJson<{ items?: Psc[] }>(`/company/${companyNumber}/persons-with-significant-control`),
    getJson<CompanyProfile>(`/company/${companyNumber}`),
  ]);
  const officers = (officersRes?.items ?? []).filter((o) => !o.resigned_on);
  return {
    officers,
    psc: (pscRes?.items ?? []).filter((p) => !p.ceased_on),
    substance: assessSubstance(profile, incorporated, officers.length),
  };
}

export async function discoverUk(
  maxPerQuery = 40,
  onLog: (msg: string) => void = console.log,
): Promise<UkCompany[]> {
  const seen = new Map<string, UkCompany>();

  for (const fragment of NAME_FRAGMENTS) {
    for (const sic of SIC_CODES) {
      const path =
        `/advanced-search/companies?company_name_includes=${encodeURIComponent(fragment)}` +
        `&sic_codes=${sic}&company_status=active&size=${maxPerQuery}`;
      const res = await getJson<AdvancedSearchResponse>(path);
      if (!res?.items?.length) continue;

      let added = 0;
      for (const item of res.items) {
        if (seen.has(item.company_number)) continue;
        const addr = item.registered_office_address ?? {};
        seen.set(item.company_number, {
          companyNumber: item.company_number,
          name: item.company_name,
          status: item.company_status,
          incorporated: item.date_of_creation,
          sicCodes: item.sic_codes ?? [sic],
          street: addr.address_line_1 ?? '',
          city: addr.locality ?? '',
          region: addr.region ?? '',
          postcode: addr.postal_code ?? '',
          country: addr.country ?? 'United Kingdom',
          officers: [],
          psc: [],
          sharedSurnames: [],
          matchedFragment: fragment,
          accountsType: '',
          lastAccountsTo: '',
          hasSubstance: false,
          substanceNote: '',
        });
        added++;
      }
      if (added) onLog(`  ${fragment.padEnd(20)} sic ${sic}  +${added}`);
    }
  }

  const companies = [...seen.values()];
  onLog(`\n  resolving officers and PSC for ${companies.length} companies...`);

  for (let i = 0; i < companies.length; i += 6) {
    const batch = companies.slice(i, i + 6);
    await Promise.all(
      batch.map(async (c) => {
        const { officers, psc, substance } = await enrich(c.companyNumber, c.incorporated);
        c.officers = officers;
        c.psc = psc;
        c.accountsType = substance.type;
        c.lastAccountsTo = substance.madeUpTo;
        c.hasSubstance = substance.hasSubstance;
        c.substanceNote = substance.note;

        const tokens = new Set(nameTokens(c.name));
        const controllers = [...psc.map((p) => p.name), ...officers.filter((o) => o.officer_role === 'director').map((o) => o.name)];
        c.sharedSurnames = [...new Set(controllers.map(surnameOf).filter((s) => s.length >= 3 && tokens.has(s)))];
      }),
    );
    if ((i + 6) % 60 === 0) onLog(`    ${Math.min(i + 6, companies.length)}/${companies.length}`);
  }

  return companies;
}

export function evidenceFor(c: UkCompany, method: string): Evidence {
  return {
    sourceUrl: `https://find-and-update.company-information.service.gov.uk/company/${c.companyNumber}`,
    sourceClass: 'registry',
    method,
    observedAt: new Date().toISOString(),
  };
}

/** The strongest evidence this channel produces: named family control of a named entity. */
export function familyControlCell(c: UkCompany): Cell<string> {
  if (c.sharedSurnames.length === 0) {
    return {
      value: null,
      status: 'could_not_verify',
      evidence: [],
      confidence: 0,
      note: 'no controlling person shares a surname with the company name',
    };
  }
  const surname = c.sharedSurnames[0]!;
  const holder = [...c.psc, ...c.officers].find((p) => surnameOf(p.name) === surname);
  return {
    value: `${surname.replace(/^./, (ch) => ch.toUpperCase())} family`,
    status: 'verified',
    evidence: [
      evidenceFor(
        c,
        `UK register of Persons with Significant Control names ${holder?.name ?? surname} as controlling ${c.name}`,
      ),
    ],
    confidence: 0.85,
  };
}
