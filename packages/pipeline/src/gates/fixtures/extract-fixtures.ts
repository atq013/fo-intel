/**
 * Snapshots the Stage 1 defects out of the delivered dataset into a committed
 * fixture file.
 *
 * These are not invented test cases. Every one is a value that shipped to the
 * customer in `data/fo-dataset.json` and was either flagged in the Stage 1
 * feedback or found by the audit that followed it. Testing gates against real
 * measured failures is worth more than testing them against cases imagined by
 * the person writing the gate, who will imagine the failures he already knows to
 * avoid.
 *
 * Run: npx tsx packages/pipeline/src/gates/fixtures/extract-fixtures.ts
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../../../../', import.meta.url));
const rows = JSON.parse(readFileSync(root + 'data/fo-dataset.json', 'utf8')) as any[];

type Fixture = {
  id: string;
  defect: string;
  gate: string;
  firm: string;
  field: string;
  value: unknown;
  valueType: string;
  spanText: string;
  sourceUrl: string;
  /** what the gate must decide, and why it is a defect */
  expect: 'failed' | 'passed';
  note: string;
};

const fixtures: Fixture[] = [];
const pick = (name: RegExp) => rows.find((r) => name.test(r.legalName));
const span = (f: any) => f?.evidence?.[0]?.method ?? '';
const url = (f: any) => f?.evidence?.[0]?.sourceUrl ?? '';

// --- attribution: the value is not in the span that supposedly established it
const kopp = pick(/kopp/i);
fixtures.push({
  id: 'kopp-street',
  defect: 'street value absent from its own evidence span',
  gate: 'attribution',
  firm: kopp.legalName,
  field: 'street',
  value: kopp.street.value,
  valueType: 'string',
  spanText: span(kopp.street),
  sourceUrl: url(kopp.street),
  expect: 'failed',
  note: 'shipped 701 CARLSON PARKWAY; the cited filing says 8400 NORMANDALE LAKE BOULEVARD',
});
fixtures.push({
  id: 'kopp-postcode',
  defect: 'postcode contradicts its own evidence span',
  gate: 'attribution',
  firm: kopp.legalName,
  field: 'postcode',
  value: kopp.postcode.value,
  valueType: 'string',
  spanText: span(kopp.postcode),
  sourceUrl: url(kopp.postcode),
  expect: 'failed',
  note: 'shipped 55305; the cited filing says 55437',
});
// The control. Same record, same span, and the city genuinely is in it. A gate
// that fails this one is not strict, it is broken.
fixtures.push({
  id: 'kopp-city',
  defect: 'none - city really does appear in the span',
  gate: 'attribution',
  firm: kopp.legalName,
  field: 'city',
  value: kopp.city.value,
  valueType: 'string',
  spanText: span(kopp.city),
  sourceUrl: url(kopp.city),
  expect: 'passed',
  note: 'control case: BLOOMINGTON is present in the quote',
});

const duq = pick(/duquesne/i);
fixtures.push({
  id: 'duquesne-street',
  defect: 'address wearing a quote about a person and a ranking',
  gate: 'attribution',
  firm: duq.legalName,
  field: 'street',
  value: duq.street.value,
  valueType: 'string',
  spanText: span(duq.street),
  sourceUrl: url(duq.street),
  expect: 'failed',
  note: 'the canonical mis-wiring: "Duquesne Family Office Stanley Druckenmiller 7" cited for 40 WEST 57TH STREET',
});

// principal name carrying a span that names nobody, or names someone else
for (const [id, firmRe] of [['duquesne-principal', /duquesne/i], ['kopp-principal', /kopp/i]] as const) {
  const r = pick(firmRe);
  const p = r.principals?.[0];
  if (!p?.fullName?.value) continue;
  fixtures.push({
    id,
    defect: 'principal name absent from its own evidence span',
    gate: 'attribution',
    firm: r.legalName,
    field: 'principal.fullName',
    value: p.fullName.value,
    valueType: 'person_name',
    spanText: span(p.fullName),
    sourceUrl: url(p.fullName),
    expect: 'failed',
    note: `${p.fullName.value} does not appear in the span cited for them`,
  });
}

// --- value_type: a person field holding a company
const COMPANYISH = /\b(LLC|LTD|LIMITED|INC|CORP|GMBH|PLC|HOLDINGS?|GROUP|TRUST|COMPANY|PARTNERS|LP)\b/i;
for (const r of rows) {
  for (const p of r.principals ?? []) {
    const nm = p.fullName?.value;
    if (nm && COMPANYISH.test(nm)) {
      fixtures.push({
        id: `company-as-person-${fixtures.filter((f) => f.gate === 'value_type').length + 1}`,
        defect: 'company shipped in a person field',
        gate: 'value_type',
        firm: r.legalName,
        field: 'principal.fullName',
        value: nm,
        valueType: 'person_name',
        spanText: span(p.fullName),
        sourceUrl: url(p.fullName),
        expect: 'failed',
        note: `titled "${p.title?.value}" - a Companies House PSC can be a corporate body, and the extractor did not check`,
      });
    }
  }
}
// control: a real person in a person field
const realPerson = rows.flatMap((r: any) =>
  (r.principals ?? []).map((p: any) => ({ r, p })),
).find(({ p }: any) => p.fullName?.value && !COMPANYISH.test(p.fullName.value));
fixtures.push({
  id: 'real-person-control',
  defect: 'none',
  gate: 'value_type',
  firm: realPerson.r.legalName,
  field: 'principal.fullName',
  value: realPerson.p.fullName.value,
  valueType: 'person_name',
  spanText: span(realPerson.p.fullName),
  sourceUrl: url(realPerson.p.fullName),
  expect: 'passed',
  note: 'control case: a natural person',
});

// --- value_type: a timestamp shipped as a phone number
for (const r of rows) {
  for (const p of r.principals ?? []) {
    const ph = p.phone?.value;
    if (!ph) continue;
    const digits = String(ph).replace(/\D/g, '');
    if (digits.length === 10 && digits[0] === '1') {
      fixtures.push({
        id: 'timestamp-as-phone',
        defect: 'unix timestamp shipped as a phone number',
        gate: 'value_type',
        firm: r.legalName,
        field: 'principal.phone',
        value: ph,
        valueType: 'phone',
        spanText: span(p.phone),
        sourceUrl: url(p.phone),
        expect: 'failed',
        note: `${digits} is ${new Date(Number(digits) * 1000).toISOString().slice(0, 10)} as a unix timestamp, and no NANP area code begins with 1`,
      });
    }
  }
}

// --- contact_ownership: a shared inbox as a named individual's address
for (const r of rows) {
  for (const p of r.principals ?? []) {
    const em = p.email?.value;
    if (em && /^(info|contact|hello|admin|enquiries|office|team|hi)@/i.test(em)) {
      fixtures.push({
        id: `shared-inbox-${fixtures.filter((f) => f.gate === 'contact_ownership').length + 1}`,
        defect: 'role mailbox presented as a named principal\'s email',
        gate: 'contact_ownership',
        firm: r.legalName,
        field: 'principal.email',
        value: em,
        valueType: 'email',
        spanText: span(p.email),
        sourceUrl: url(p.email),
        expect: 'failed',
        note: `attributed to ${p.fullName?.value}; the brief excludes shared inboxes explicitly`,
      });
    }
  }
}

// --- identity: a profile URL belonging to a different person
for (const r of rows) {
  for (const p of r.principals ?? []) {
    const li = p.linkedinUrl?.value;
    const nm = p.fullName?.value;
    if (!li || !nm) continue;
    const slug = (li.split('/in/')[1] ?? '').toLowerCase();
    const toks = nm.toLowerCase().replace(/[^a-z ]/g, '').split(/\s+/).filter((t: string) => t.length > 2);
    if (toks.length && !toks.some((t: string) => slug.includes(t))) {
      fixtures.push({
        id: `wrong-profile-${fixtures.filter((f) => f.gate === 'identity').length + 1}`,
        defect: 'profile URL encodes a different person',
        gate: 'identity',
        firm: r.legalName,
        field: 'principal.linkedinUrl',
        value: li,
        valueType: 'profile_url',
        spanText: span(p.linkedinUrl),
        sourceUrl: url(p.linkedinUrl),
        expect: 'failed',
        note: `attributed to ${nm}; the slug names someone else entirely`,
      });
    }
  }
}

const out = fileURLToPath(new URL('./stage1-defects.json', import.meta.url));
writeFileSync(out, JSON.stringify({
  provenance: 'extracted from data/fo-dataset.json, the 50 records delivered in Stage 1',
  extractedAt: new Date().toISOString(),
  fixtures,
}, null, 2));

const byGate = fixtures.reduce<Record<string, number>>((a, f) => {
  a[f.gate] = (a[f.gate] ?? 0) + 1;
  return a;
}, {});
console.log(`${fixtures.length} fixtures ->`, byGate);
console.log(`expect failed: ${fixtures.filter((f) => f.expect === 'failed').length}, expect passed: ${fixtures.filter((f) => f.expect === 'passed').length}`);
