import { readFileSync } from 'node:fs';

/** SEC structured-data TSVs are unquoted and tab-delimited. */
export function readTsv(path: string): Record<string, string>[] {
  const text = readFileSync(path, 'utf8');
  const lines = text.split('\n');
  const header = lines[0]?.split('\t').map((h) => h.trim()) ?? [];

  const rows: Record<string, string>[] = [];
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line || !line.trim()) continue;
    const cells = line.split('\t');
    const row: Record<string, string> = {};
    for (let c = 0; c < header.length; c++) {
      row[header[c]!] = (cells[c] ?? '').trim();
    }
    rows.push(row);
  }
  return rows;
}

export function indexBy<T extends Record<string, string>>(rows: T[], key: string): Map<string, T> {
  const map = new Map<string, T>();
  for (const r of rows) {
    const k = r[key];
    if (k) map.set(k, r);
  }
  return map;
}
