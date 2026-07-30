/**
 * Firm names are not generative.
 *
 * In production the agent wrote "BARRINGTON COMPANIES MANAGEMENT, LLC" when the
 * dataset holds "BARINGTON" — one letter, invented on the way out of the
 * composer while the tool data underneath was correct. For a product whose whole
 * claim is that every value traces to evidence, a firm name the model typed from
 * memory is a fabricated value, however small the edit.
 *
 * So the composer never writes firm names at all. It writes `[[entityId]]`
 * tokens, and the server substitutes the stored `legalName`. A name that does
 * not exist in the tool output cannot be produced, because the model is not the
 * thing producing names.
 *
 * The scan afterwards is the backstop for a model that ignores the instruction:
 * anything that still looks like a firm name is matched against the canonical
 * set, near-misses are corrected to the stored spelling, and anything with no
 * match at all blocks the answer.
 */

/** Tokens that make a capitalised phrase look like a company rather than prose. */
const COMPANYISH =
  /\b(LLC|L\.L\.C\.?|LTD|LIMITED|INC|INCORPORATED|CORP|CORPORATION|COMPANY|CO|PLC|GMBH|LP|L\.P\.?|LLP|PARTNERS|HOLDINGS?|CAPITAL|MANAGEMENT|INVESTMENTS?|VENTURES?|GROUP|TRUST|OFFICE)\b/i;

/** A run of capitalised / all-caps words, i.e. a plausible firm mention. */
const CANDIDATE = /\b([A-Z][A-Za-z&'’.-]*(?:[ ,]+(?:[A-Z][A-Za-z&'’.-]*|of|and|the|for)){0,7}(?:,?\s*(?:LLC|L\.L\.C\.?|LTD|LIMITED|INC\.?|CORP\.?|L\.P\.?|LP|LLP|PLC))?)/g;

/**
 * A legal suffix ends a firm name, so the comma after it separates list items
 * rather than continuing one name.
 *
 * Without this the matcher swallows "Timonier Family Office, LTD., Virtus Family
 * Office LLC" as a single phrase, finds no firm by that name, and blocks an
 * answer in which every firm was real. Over-blocking a correct answer is worse
 * than the misspelling this guard exists to catch.
 */
const LIST_BREAK = /(?<=\b(?:LLC|L\.L\.C\.?|LTD\.?|LIMITED|INC\.?|CORP\.?|L\.P\.?|LP|LLP|PLC))\s*[,;]\s+(?=[A-Z])/g;

/** Trailing punctuation is sentence grammar, not part of the stored name. */
function trimEdges(s: string): string {
  return s.replace(/^[\s,;.]+/, '').replace(/[\s,;]+$/, '').replace(/\.$/, '');
}

export function normaliseName(s: string): string {
  return s
    .toUpperCase()
    .replace(/[.,'’&-]/g, ' ')
    .replace(/\b(L\s*L\s*C|L\s*P|LLP|INC|CORP|CORPORATION|COMPANY|CO|LTD|LIMITED|PLC|THE)\b/g, ' ')
    .replace(/[^A-Z0-9 ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Cheap edit distance, capped — only used to decide "did they mean this one?" */
function editDistance(a: string, b: string): number {
  if (Math.abs(a.length - b.length) > 4) return 99;
  const prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  const cur = new Array<number>(b.length + 1);
  for (let i = 1; i <= a.length; i++) {
    cur[0] = i;
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(
        prev[j]! + 1,
        cur[j - 1]! + 1,
        prev[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    for (let j = 0; j <= b.length; j++) prev[j] = cur[j]!;
  }
  return prev[b.length]!;
}

export interface NameResolution {
  text: string;
  /** names silently corrected to their stored spelling */
  corrected: Array<{ wrote: string; stored: string }>;
  /** firm-like names with no counterpart in the tool output at all */
  fabricated: string[];
  /** [[entityId]] tokens the tools never returned */
  unresolvedTokens: string[];
}

/**
 * Substitute `[[entityId]]` tokens, then audit whatever prose remains.
 *
 * `canonical` is entityId -> stored legalName, built only from tool output. If a
 * name is not in here it did not come from the data.
 */
export function resolveNames(answer: string, canonical: Map<string, string>): NameResolution {
  const corrected: Array<{ wrote: string; stored: string }> = [];
  const fabricated: string[] = [];
  const unresolvedTokens: string[] = [];

  // 1. the intended path: tokens in, stored names out
  let text = answer.replace(/\[\[([^\]]+)\]\]/g, (_m, id: string) => {
    const key = String(id).trim();
    const name = canonical.get(key);
    if (name) return name;
    unresolvedTokens.push(key);
    return '(a firm the tools did not return)';
  });

  if (canonical.size === 0) return { text, corrected, fabricated, unresolvedTokens };

  const byNorm = new Map<string, string>();
  for (const name of canonical.values()) byNorm.set(normaliseName(name), name);
  const exact = new Set(canonical.values());

  // 2. Account for every stored name that actually appears, before judging
  //    anything. Segmenting prose into firm mentions with a regex proved
  //    unreliable in both directions -- it swallowed comma-separated lists of
  //    real firms as one phantom name, and its suffix list was case-sensitive.
  //
  //    Inverting is sturdier: mark the spans that ARE stored names, then only
  //    scrutinise what is left over. A real name can never be flagged, because
  //    it is matched before the scan runs.
  const consumed: Array<[number, number]> = [];
  const claim = (from: number, len: number) => consumed.push([from, from + len]);
  const overlaps = (from: number, to: number) =>
    consumed.some(([a, b]) => from < b && to > a);

  for (const stored of [...exact].sort((a, b) => b.length - a.length)) {
    const needle = stored.toLowerCase();
    let at = text.toLowerCase().indexOf(needle);
    while (at !== -1) {
      if (!overlaps(at, at + stored.length)) claim(at, stored.length);
      at = text.toLowerCase().indexOf(needle, at + 1);
    }
  }

  // 3. Whatever firm-like prose remains was written by the model, not taken
  //    from the data. Correct a near miss to the stored spelling; flag anything
  //    with no counterpart at all.
  //    Claimed spans are masked character-for-character rather than skipped.
  //    Skipping a candidate that merely *touches* a known name would let a
  //    fabricated firm hide behind a real one in the same sentence — the
  //    greedy match spans both, overlaps, and gets waved through. Masking keeps
  //    offsets intact while making the real names unmatchable.
  const MASK = '\u0001';
  let masked = text;
  for (const [a, b] of consumed) {
    masked = masked.slice(0, a) + MASK.repeat(b - a) + masked.slice(b);
  }

  const rewrites: Array<{ from: number; to: number; text: string }> = [];
  for (const m of masked.matchAll(CANDIDATE)) {
    const raw = m[0];
    const at = m.index ?? 0;
    if (raw.includes(MASK)) continue;
    if (!COMPANYISH.test(raw)) continue;

    const phrase = trimEdges(raw);
    if (!phrase) continue;
    const offset = at + raw.indexOf(phrase);
    if (overlaps(offset, offset + phrase.length)) continue;

    const norm = normaliseName(phrase);
    if (!norm) continue;

    const hit = byNorm.get(norm);
    if (hit) {
      corrected.push({ wrote: phrase, stored: hit });
      rewrites.push({ from: offset, to: offset + phrase.length, text: hit });
      claim(offset, phrase.length);
      continue;
    }

    let best: { name: string; d: number } | null = null;
    for (const [n, name] of byNorm) {
      const d = editDistance(norm, n);
      if (!best || d < best.d) best = { name, d };
    }
    if (best && best.d <= Math.max(2, Math.floor(norm.length * 0.12))) {
      corrected.push({ wrote: phrase, stored: best.name });
      rewrites.push({ from: offset, to: offset + phrase.length, text: best.name });
      claim(offset, phrase.length);
      continue;
    }

    fabricated.push(phrase);
  }

  for (const r of rewrites.sort((a, b) => b.from - a.from)) {
    text = text.slice(0, r.from) + r.text + text.slice(r.to);
  }

  return { text, corrected, fabricated, unresolvedTokens };
}
