/**
 * Channel: SEC 13F signature block.
 *
 * A 13F cover page carries the filer; the signature block carries a named human,
 * their title, and a phone number, in a document signed under penalty of perjury.
 *
 * The ownership question is whether that number reaches the signatory or the
 * firm. Three disqualifiers, all decidable from the quarterly dataset alone:
 *
 *   1. the number appears against more than one named person at the same filer
 *      -> a shared line
 *   2. the number appears against more than one filer
 *      -> an administrator or fund-services number, not the firm's at all
 *   3. the signatory is not a natural person
 *      -> "Compliance Department" is not someone you can reach
 *
 * What survives is the number a named individual filed as their own contact.
 * That is not proof it rings on their desk, and the spike records it as such.
 */
import { readFileSync } from 'node:fs';
import { digits } from './reachability.js';

interface SigRow { ACCESSION_NUMBER: string; NAME: string; TITLE: string; PHONE: string }
interface CoverRow { ACCESSION_NUMBER: string; FILINGMANAGER_NAME: string; DATEREPORTED: string }

function tsv<T>(path: string): T[] {
  const lines = readFileSync(path, 'utf8').split('\n');
  const head = lines[0]!.split('\t').map((h) => h.trim());
  const out: T[] = [];
  for (let i = 1; i < lines.length; i++) {
    if (!lines[i]?.trim()) continue;
    const cells = lines[i]!.split('\t');
    const row: Record<string, string> = {};
    head.forEach((h, j) => (row[h] = (cells[j] ?? '').trim()));
    out.push(row as T);
  }
  return out;
}

/** A signatory must be a natural person, not a department or a company. */
const NOT_A_PERSON =
  /\b(department|compliance|committee|group|llc|inc|corp|ltd|limited|lp|trust|company|partners|management|administrator|services|team|office)\b/i;

export function isNaturalPerson(name: string): boolean {
  const n = name.trim();
  if (n.length < 4) return false;
  if (NOT_A_PERSON.test(n)) return false;
  // at least a forename and a surname
  return n.replace(/[^A-Za-z ,.'-]/g, '').split(/[\s,]+/).filter((t) => t.length > 1).length >= 2;
}

export interface SignatoryRoute {
  firm: string;
  accession: string;
  person: string;
  title: string;
  phone: string;
  filedOn: string;
  ownership: 'individual' | 'company' | 'unknown';
  reason: string;
}

export function buildSignatoryRoutes(dir = 'data/raw/sec'): SignatoryRoute[] {
  const sigs = tsv<SigRow>(`${dir}/SIGNATURE.tsv`);
  const covers = new Map(tsv<CoverRow>(`${dir}/COVERPAGE.tsv`).map((c) => [c.ACCESSION_NUMBER, c]));

  // pass 1 — how widely is each number used?
  const phoneToFirms = new Map<string, Set<string>>();
  const phoneToPeople = new Map<string, Set<string>>();
  for (const s of sigs) {
    const c = covers.get(s.ACCESSION_NUMBER);
    const p = digits(s.PHONE);
    if (!c || !p || !s.NAME) continue;
    const firm = c.FILINGMANAGER_NAME.trim();
    if (!phoneToFirms.has(p)) phoneToFirms.set(p, new Set());
    if (!phoneToPeople.has(p)) phoneToPeople.set(p, new Set());
    phoneToFirms.get(p)!.add(firm);
    // normalise name so "Jeff Sarrett" and "Jeffrey Sarrett" are not two people
    phoneToPeople.get(p)!.add(s.NAME.toLowerCase().replace(/[^a-z]/g, '').slice(0, 12));
  }

  // pass 2 — adjudicate each route
  const seen = new Set<string>();
  const out: SignatoryRoute[] = [];
  for (const s of sigs) {
    const c = covers.get(s.ACCESSION_NUMBER);
    const p = digits(s.PHONE);
    if (!c || !p || !s.NAME) continue;
    const firm = c.FILINGMANAGER_NAME.trim();
    const key = `${firm}|${s.NAME.trim()}`;
    if (seen.has(key)) continue;
    seen.add(key);

    let ownership: SignatoryRoute['ownership'] = 'individual';
    let reason = 'filed by this person as their contact in a signed statutory filing';

    if (!isNaturalPerson(s.NAME)) {
      ownership = 'company';
      reason = 'signatory is not a natural person';
    } else if ((phoneToFirms.get(p)?.size ?? 0) > 1) {
      ownership = 'company';
      reason = `number also filed by ${phoneToFirms.get(p)!.size - 1} other filer(s); administrator line`;
    } else if ((phoneToPeople.get(p)?.size ?? 0) > 1) {
      ownership = 'company';
      reason = 'number shared by more than one signatory at this filer';
    }

    out.push({
      firm,
      accession: s.ACCESSION_NUMBER,
      person: s.NAME.trim(),
      title: s.TITLE.trim(),
      phone: s.PHONE.trim(),
      filedOn: c.DATEREPORTED,
      ownership,
      reason,
    });
  }
  return out;
}
