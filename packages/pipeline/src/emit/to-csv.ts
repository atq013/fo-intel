import type { Cell, FamilyOffice } from '@fo/core';

/**
 * Flattens records for delivery. Every high-value cell ships alongside a
 * `*_basis` column carrying how it was confirmed, so the file itself answers
 * "where did this come from" without anyone needing the repository.
 */
function esc(v: unknown): string {
  const s = v === null || v === undefined ? '' : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function val<T>(c: Cell<T> | undefined): string {
  if (!c || c.value === null) return '';
  return Array.isArray(c.value) ? c.value.join('; ') : String(c.value);
}

function basis<T>(c: Cell<T> | undefined): string {
  if (!c) return '';
  if (c.value === null) return c.note ? `could not verify: ${c.note}` : 'could not verify';
  const e = c.evidence[0];
  if (!e) return 'no basis recorded';
  return `${e.method}${e.vendor ? ` [vendor: ${e.vendor}]` : ''} — ${e.sourceUrl}`;
}

export const COLUMNS = [
  'firm_name', 'firm_type', 'type_confidence', 'type_basis',
  'country', 'city', 'region',
  'website', 'website_basis',
  'principal_name', 'principal_title',
  'principal_phone', 'principal_phone_basis',
  'principal_email', 'principal_email_basis',
  'recent_signal_count', 'latest_signal_date', 'latest_signal', 'latest_signal_basis',
  'discovery_channels', 'rules_matched',
];

export function toCsv(records: FamilyOffice[]): string {
  const lines = [COLUMNS.join(',')];

  for (const r of records) {
    const p = r.principals[0];
    const s = r.signals[0];
    lines.push([
      r.legalName,
      r.classification.type,
      r.classification.confidence.toFixed(2),
      r.classification.evidence[0]
        ? `${r.classification.evidence[0].method} — ${r.classification.evidence[0].sourceUrl}`
        : 'no basis recorded',
      val(r.country), val(r.city), val(r.region),
      val(r.website), basis(r.website),
      val(p?.fullName), val(p?.title),
      val(p?.phone), basis(p?.phone),
      val(p?.email), basis(p?.email),
      String(r.signals.length),
      s?.occurredAt ?? '',
      s?.summary ?? '',
      s?.evidence.method ?? '',
      [...new Set(r.discoveries.map((d) => d.channel))].join('; '),
      r.classification.rulesMatched.join('; '),
    ].map(esc).join(','));
  }

  return lines.join('\n');
}
