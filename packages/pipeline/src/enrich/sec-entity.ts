/**
 * Evidence source: SEC submissions API, one authoritative record per CIK.
 *
 * Discovery channels surface names. This resolves each name to what the SEC
 * actually holds on the entity - legal name, entity type, SIC, registered
 * address, phone, and complete filing history. It is the difference between
 * "a filing mentioned this string" and "this entity exists and is of this type".
 *
 * Kept out of discovery/ deliberately: a source that told us a firm exists is not
 * the source that proves what it is.
 */
import type { Cell, Evidence, Signal } from '@fo/core';
import { fetchJson } from '../lib/http.js';

interface SubmissionsResponse {
  cik: string;
  name: string;
  sic: string;
  sicDescription: string;
  entityType: string;
  stateOfIncorporation: string;
  phone: string;
  formerNames: Array<{ name: string }>;
  addresses: {
    business?: {
      street1: string | null;
      street2: string | null;
      city: string | null;
      stateOrCountry: string | null;
      zipCode: string | null;
    };
  };
  filings: {
    recent: {
      form: string[];
      filingDate: string[];
      accessionNumber: string[];
      primaryDocument: string[];
    };
  };
}

export interface SecEntity {
  cik: string;
  legalName: string;
  formerNames: string[];
  entityType: string;
  sic: string;
  sicDescription: string;
  stateOfIncorporation: string;
  street: string;
  city: string;
  region: string;
  postcode: string;
  phone: Cell<string>;
  /** True when SEC classifies it as an operating business, i.e. not an investment vehicle. */
  isOperatingCompany: boolean;
  filingForms: string[];
  signals: Signal[];
}

/** SIC codes that denote investment vehicles rather than operating businesses. */
const INVESTMENT_SIC = new Set(['6726', '6799', '6733', '6282', '6221', '6770', '']);

function edgarUrl(cik: string) {
  return `https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=${cik}&type=&dateb=&owner=include&count=40`;
}

function evidenceFor(cik: string, method: string): Evidence {
  return {
    sourceUrl: `https://data.sec.gov/submissions/CIK${cik}.json`,
    sourceClass: 'regulatory',
    method,
    observedAt: new Date().toISOString(),
  };
}

/** Filings that represent a dated, reportable action rather than routine housekeeping. */
const SIGNAL_FORMS: Record<string, { kind: Signal['kind']; label: string }> = {
  'SC 13D': { kind: 'investment', label: 'disclosed an active stake above 5%' },
  'SC 13G': { kind: 'investment', label: 'disclosed a passive stake above 5%' },
  'SCHEDULE 13G': { kind: 'investment', label: 'disclosed a passive stake above 5%' },
  D: { kind: 'fund_commitment', label: 'filed a private placement notice' },
  'D/A': { kind: 'fund_commitment', label: 'amended a private placement notice' },
  '13F-HR': { kind: 'filing', label: 'reported quarterly holdings' },
};

export async function resolveEntity(cik: string): Promise<SecEntity | null> {
  const padded = cik.padStart(10, '0');
  let data: SubmissionsResponse;
  try {
    data = await fetchJson<SubmissionsResponse>(`https://data.sec.gov/submissions/CIK${padded}.json`);
  } catch {
    return null;
  }

  const biz = data.addresses?.business ?? {};
  const recent = data.filings?.recent;

  const signals: Signal[] = [];
  if (recent) {
    for (let i = 0; i < recent.form.length && signals.length < 12; i++) {
      const form = recent.form[i]!;
      const spec = SIGNAL_FORMS[form.replace(/\/A$/, '')] ?? SIGNAL_FORMS[form];
      const date = recent.filingDate[i];
      if (!spec || !date) continue;
      signals.push({
        kind: spec.kind,
        summary: `${data.name} ${spec.label} (${form})`,
        occurredAt: date,
        evidence: {
          sourceUrl: `https://www.sec.gov/Archives/edgar/data/${Number(cik)}/${(recent.accessionNumber[i] ?? '').replace(/-/g, '')}/`,
          sourceClass: 'regulatory',
          method: `${form} filed with the SEC on ${date}`,
          observedAt: new Date().toISOString(),
        },
      });
    }
  }

  const phoneValue = (data.phone ?? '').trim();

  return {
    cik: padded,
    legalName: data.name,
    formerNames: (data.formerNames ?? []).map((f) => f.name),
    entityType: data.entityType ?? '',
    sic: data.sic ?? '',
    sicDescription: data.sicDescription ?? '',
    stateOfIncorporation: data.stateOfIncorporation ?? '',
    street: [biz.street1, biz.street2].filter(Boolean).join(', '),
    city: biz.city ?? '',
    region: biz.stateOrCountry ?? '',
    postcode: biz.zipCode ?? '',
    phone: phoneValue
      ? {
          value: phoneValue,
          status: 'verified',
          evidence: [evidenceFor(padded, 'published by the entity in its SEC registration record')],
          confidence: 0.9,
        }
      : { value: null, status: 'could_not_verify', evidence: [], confidence: 0, note: 'no phone in SEC registration' },
    isOperatingCompany: data.entityType === 'operating' || !INVESTMENT_SIC.has(data.sic ?? ''),
    filingForms: recent ? [...new Set(recent.form)] : [],
    signals,
  };
}

export async function resolveMany(ciks: string[], onProgress?: (done: number, total: number) => void) {
  const out: SecEntity[] = [];
  let done = 0;
  // http.ts caps sec.gov concurrency; this just keeps memory flat and progress readable.
  const batch = 8;
  for (let i = 0; i < ciks.length; i += batch) {
    const slice = ciks.slice(i, i + batch);
    const resolved = await Promise.all(slice.map((c) => resolveEntity(c)));
    for (const r of resolved) if (r) out.push(r);
    done += slice.length;
    onProgress?.(done, ciks.length);
  }
  return out;
}

export { edgarUrl };
