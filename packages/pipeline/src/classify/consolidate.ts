/**
 * Merges the four discovery pools into one firm per real-world entity, then
 * applies the inclusion rubric.
 *
 * Deduplication matters more than it looks. A firm surfaced by two independent
 * channels is corroborated, but only if we actually recognise the two records as
 * the same firm - otherwise the file carries it twice and the corroboration is
 * lost. Matching is on normalised name first, then on shared phone number, which
 * catches the cases where the legal name and the trading name differ.
 */
import { readFileSync, existsSync } from 'node:fs';
import type { DiscoveryChannel } from '@fo/core';
import { scoreCandidates, type Candidate } from '../discovery/sec-13f.js';
import type { SecEntity } from '../enrich/sec-entity.js';
import type { WebCandidate } from '../discovery/web.js';
import type { UkCompany } from '../discovery/companies-house.js';
import { classify, type RuleInput } from './rubric.js';
import { isUsableName, normaliseCountry } from './normalise.js';
import type { Classification } from '@fo/core';

export interface MergedFirm {
  key: string;
  name: string;
  channels: Set<DiscoveryChannel>;
  city: string;
  region: string;
  country: string;
  phone: string;
  principalName: string;
  principalTitle: string;
  sourceUrls: string[];
  ruleInput: RuleInput;
  classification: Classification;
  signalCount: number;
  latestSignal: string;
}

const SUFFIXES =
  /\b(llc|l\.l\.c\.|lp|l\.p\.|llp|inc|incorporated|corp|corporation|co|company|ltd|limited|plc|gmbh|ag|s\.a\.|sa|nv|bv|kg|pte|ulc|holdco)\b/gi;

export function normaliseKey(name: string): string {
  return name
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(SUFFIXES, ' ')
    .replace(/[^a-z0-9]/g, '')
    .trim();
}

function normalisePhone(phone: string): string {
  const digits = phone.replace(/\D/g, '');
  return digits.length >= 7 ? digits.slice(-10) : '';
}

function readJson<T>(path: string): T | null {
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, 'utf8')) as T;
}

export function consolidate(): MergedFirm[] {
  const byKey = new Map<string, MergedFirm>();
  const byPhone = new Map<string, MergedFirm>();

  const upsert = (name: string, channel: DiscoveryChannel, phone: string): MergedFirm | null => {
    if (!isUsableName(name)) return null;
    const key = normaliseKey(name);
    const phoneKey = normalisePhone(phone);

    let firm = byKey.get(key) ?? (phoneKey ? byPhone.get(phoneKey) : undefined);
    if (!firm) {
      firm = {
        key,
        name,
        channels: new Set(),
        city: '',
        region: '',
        country: '',
        phone: '',
        principalName: '',
        principalTitle: '',
        sourceUrls: [],
        ruleInput: { name, channelCount: 0 },
        classification: {
          type: 'unconfirmed',
          evidence: [],
          rulesMatched: [],
          confidence: 0,
          qualifies: false,
        },
        signalCount: 0,
        latestSignal: '',
      };
      byKey.set(key, firm);
    }
    firm.channels.add(channel);
    if (phoneKey && !byPhone.has(phoneKey)) byPhone.set(phoneKey, firm);
    return firm;
  };

  // 13F structural census. Discovery only - these signals never qualify a record.
  let scored: Candidate[] = [];
  try {
    scored = scoreCandidates().filter((c) => c.score >= 50);
  } catch {
    scored = [];
  }
  for (const c of scored) {
    const firm = upsert(c.name, 'sec_13f', c.signatoryPhone);
    if (!firm) continue;
    firm.city ||= c.city;
    firm.region ||= c.state;
    firm.country ||= 'United States';
    firm.phone ||= c.signatoryPhone;
    firm.principalName ||= c.signatoryName;
    firm.principalTitle ||= c.signatoryTitle;
    firm.ruleInput.structuralScore = c.score;
    firm.ruleInput.secHasCrd = c.hasCrd;
  }

  // SEC full-text, resolved against the submissions API.
  const sec = readJson<{ entities: SecEntity[] }>('data/candidates-sec.json');
  for (const e of sec?.entities ?? []) {
    const firm = upsert(e.legalName, 'sec_13dg', e.phone.value ?? '');
    if (!firm) continue;
    firm.city ||= e.city;
    firm.region ||= e.region;
    firm.country ||= 'United States';
    firm.phone ||= e.phone.value ?? '';
    firm.sourceUrls.push(`https://data.sec.gov/submissions/CIK${e.cik}.json`);
    firm.ruleInput.secCik = e.cik;
    firm.ruleInput.secEntityType = e.entityType;
    firm.ruleInput.secIsOperating = e.isOperatingCompany;
    firm.signalCount += e.signals.length;
    const latest = e.signals[0]?.occurredAt ?? '';
    if (latest > firm.latestSignal) firm.latestSignal = latest;
  }

  // Web extraction. Every record here already passed the quote check.
  const web = readJson<{ candidates: WebCandidate[] }>('data/candidates-web.json');
  for (const c of web?.candidates ?? []) {
    const firm = upsert(c.name, c.channel, '');
    if (!firm) continue;
    firm.country ||= c.location ?? '';
    firm.principalName ||= c.principalName ?? '';
    firm.principalTitle ||= c.principalTitle ?? '';
    firm.sourceUrls.push(c.sourceUrl);
    firm.ruleInput.webQuote = c.supportingQuote;
    firm.ruleInput.webTypeClaim = c.typeClaim;
    firm.ruleInput.webSourceUrl = c.sourceUrl;
  }

  // UK registry. Carries the strongest single-family evidence available.
  const uk = readJson<{ companies: UkCompany[] }>('data/candidates-uk.json');
  for (const c of uk?.companies ?? []) {
    const firm = upsert(c.name, 'companies_house', '');
    if (!firm) continue;
    firm.city ||= c.city;
    firm.region ||= c.region;
    firm.country ||= c.country;
    firm.sourceUrls.push(`https://find-and-update.company-information.service.gov.uk/company/${c.companyNumber}`);

    const controller = [...c.psc, ...c.officers].find((p) =>
      c.sharedSurnames.some((s) => p.name.toLowerCase().replace(/[^a-z]/g, '').includes(s)),
    );
    firm.principalName ||= controller?.name ?? c.psc[0]?.name ?? '';
    firm.ruleInput.ukSharedSurnames = c.sharedSurnames;
    firm.ruleInput.ukControllerName = controller?.name ?? '';
    firm.ruleInput.ukHasSubstance = c.hasSubstance;
    firm.ruleInput.ukCompanyNumber = c.companyNumber;
  }

  const firms = [...new Set(byKey.values())];
  for (const f of firms) {
    f.country = normaliseCountry(f.country);
    f.ruleInput.channelCount = f.channels.size;
    f.ruleInput.name = f.name;
    f.classification = classify(f.ruleInput);
  }

  return firms;
}
