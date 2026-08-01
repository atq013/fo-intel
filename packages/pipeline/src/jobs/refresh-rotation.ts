/**
 * Which records this refresh run re-reads.
 *
 * Extracted so the rotation can be tested. The previous version was a comment
 * asserting a sort that the code did not perform, and nothing caught it for the
 * life of the build -- 543 of 546 records were never re-read once. A claim about
 * ordering belongs in a test, not a comment.
 */
export interface Rotatable {
  url: string;
  /** the MOST RECENT reading of this record: when we last looked */
  fetched_at: string;
}

export function selectRotation(rows: Rotatable[], batch: number): string[] {
  return rows
    .map((r) => ({ number: r.url.split('/company/')[1] ?? '', lastSeen: new Date(r.fetched_at).getTime() }))
    .filter((r) => r.number)
    .sort((a, b) => a.lastSeen - b.lastSeen)
    .slice(0, batch)
    .map((r) => r.number);
}
