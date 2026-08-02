/**
 * Dataset counts are not generative either.
 *
 * Firm names were made non-generative first; numbers were left alone, and the
 * composer then reported "0 firms matched out of 119 searched" on a query whose
 * tool scope said `matched: 1` and `releasedClaims: 9`. It happened on roughly
 * one run in four. A wrong count is not a rounding error in this product — the
 * whole claim is that every figure traces to something checked.
 *
 * So the composer writes `[[count:search_firms.matched]]` and the server
 * substitutes the integer the tool actually returned. Whatever the model writes
 * about numbers, the digits a reader sees come from the tool output.
 *
 * The validator afterwards is the backstop: any bare number sitting in
 * count-shaped prose that does not correspond to a real metric blocks the
 * answer. Narrowly scoped to dataset metrics — phone numbers, postcodes, years
 * and money in evidence spans are untouched.
 */

export interface MetricRegistry {
  /** e.g. "search_firms.matched" -> 43 */
  values: Map<string, number>;
  /** every legitimate metric value, for the backstop scan */
  known: Set<number>;
}

export function newMetrics(): MetricRegistry {
  return { values: new Map(), known: new Set() };
}

/**
 * Record the countable facts a tool returned.
 *
 * Repeat calls to the same tool get an indexed key as well as the bare one, so
 * `search_firms.matched` stays stable for the common single-call case while a
 * second call is still addressable as `search_firms#2.matched`.
 */
export function recordMetrics(
  reg: MetricRegistry,
  tool: string,
  callIndex: number,
  scope: Record<string, unknown>,
  excluded: Array<{ reason: string; count: number }>,
  data: unknown,
): void {
  const put = (field: string, value: unknown) => {
    if (typeof value !== 'number' || !Number.isFinite(value)) return;
    const bare = `${tool}.${field}`;
    if (!reg.values.has(bare)) reg.values.set(bare, value);
    reg.values.set(`${tool}#${callIndex}.${field}`, value);
    reg.known.add(value);
  };

  // Every count a tool exposes must be registered here or the composer cannot
  // quote it: it emits the token, the resolver does not know the name, and the
  // whole answer is refused for citing an untraceable figure.
  //
  // That refusal is correct and it caught a rename. Splitting `gateOutcomes`
  // into passed/skipped/failed -- so a skipped gate could not be counted as a
  // check -- left the new names unregistered, and Goal 3 blocked on tokens the
  // tool was itself offering. Superseded names stay registered so older traces
  // still resolve.
  for (const field of [
    'searched', 'matched', 'returned', 'releasedClaims', 'offset',
    'gatesPassed', 'gatesSkipped', 'gatesFailed',
    'rows', 'gateOutcomes',
  ]) {
    put(field, scope[field]);
  }
  if (data && typeof data === 'object' && !Array.isArray(data)) {
    put('count', (data as Record<string, unknown>).count);
  }
  if (Array.isArray(data)) put('dataLength', data.length);

  // Only register an exclusion total when there were exclusions. A tool with
  // none would otherwise register 0 as a legitimate figure and whitelist the
  // exact number the composer invented ("0 firms matched").
  if (excluded.length) {
    let excludedTotal = 0;
    for (const e of excluded) {
      excludedTotal += e.count;
      reg.known.add(e.count);
    }
    put('excludedTotal', excludedTotal);
  }
}

/** Tokens the composer may use, with what each means. */
export function tokenRoster(reg: MetricRegistry): string {
  const lines: string[] = [];
  for (const [key, value] of reg.values) {
    if (key.includes('#')) continue; // keep the roster short; indexed keys still resolve
    lines.push(`  [[count:${key}]] = ${value}`);
  }
  return lines.join('\n');
}

const TOKEN = /\[\[count:([A-Za-z_]+(?:#\d+)?\.[A-Za-z]+)\]\]/g;

/**
 * Numbers written next to count language. Deliberately narrow: this must not
 * fire on a phone number, a postcode, a year, or a figure inside a quoted
 * evidence span.
 */
const COUNT_NOUN = 'firms?|entities|entity|records?|results?|matches|claims?|rows?|companies|offices';

const COUNT_CONTEXT = new RegExp(
  [
    // "43 firms", "9 claims", "1 of 119 records"
    `\\b(\\d{1,6})\\s+(?:of\\s+)?(?:${COUNT_NOUN})\\b`,
    // "matched: 43", "searched 119"
    `\\b(?:matched|searched|returned|excluded)\\b\\s*[:=]?\\s*(\\d{1,6})\\b`,
    // "43 matched", "8 were excluded"
    `\\b(\\d{1,6})\\s+(?:were\\s+|was\\s+)?(?:matched|searched|returned|excluded)\\b`,
  ].join('|'),
  'gi',
);

export interface CountResolution {
  text: string;
  resolved: Array<{ token: string; value: number }>;
  /** tokens naming a metric no tool produced */
  unresolvedTokens: string[];
  /** bare numbers in count prose that match no metric */
  unsupported: number[];
}

export function resolveCounts(answer: string, reg: MetricRegistry): CountResolution {
  const resolved: Array<{ token: string; value: number }> = [];
  const unresolvedTokens: string[] = [];
  const unsupported: number[] = [];

  const text = answer.replace(TOKEN, (_m, key: string) => {
    const v = reg.values.get(key);
    if (v === undefined) {
      unresolvedTokens.push(key);
      return '(a count no tool produced)';
    }
    resolved.push({ token: key, value: v });
    return String(v);
  });

  // Backstop. A number in count-shaped prose must be one the tools produced.
  for (const m of text.matchAll(COUNT_CONTEXT)) {
    const raw = m[1] ?? m[2] ?? m[3];
    if (raw === undefined) continue;
    const n = Number(raw);
    if (!Number.isFinite(n)) continue;
    if (reg.known.has(n)) continue;
    if (!unsupported.includes(n)) unsupported.push(n);
  }

  return { text, resolved, unresolvedTokens, unsupported };
}
