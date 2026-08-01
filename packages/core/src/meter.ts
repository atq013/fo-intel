/**
 * What a run actually spent.
 *
 * The architecture notes have to give cost and latency per goal, per record and
 * across the whole file, broken out by model call, retrieval call and external
 * API call. None of that can be written honestly from memory, so it is measured
 * here and stored on the run.
 *
 * The split matters. **Tokens and calls are measured** -- they come back from
 * the provider or are counted at the call site, and they stay true whatever
 * anyone charges. **Money is derived** by applying the rate card below, which is
 * a set of published prices on a date, not a fact about this system. Keeping
 * them apart means a stale rate does not silently corrupt a measurement, and a
 * reviewer can re-price the same tokens against whatever the rates are when they
 * read it.
 *
 * The meter is module-level state, deliberately. Threading a counter through
 * every collector, extractor and tool would touch every signature in the build
 * for a diagnostic, and a diagnostic that invasive tends to get removed.
 */

export interface ModelSpend {
  model: string;
  calls: number;
  promptTokens: number;
  completionTokens: number;
  /** provider errors and retries, which cost time and sometimes tokens */
  failures: number;
}

export interface HostSpend {
  host: string;
  calls: number;
  /** calls that returned non-2xx, including ones a retry later fixed */
  failures: number;
  totalMs: number;
}

export interface MeterSnapshot {
  models: ModelSpend[];
  hosts: HostSpend[];
  totals: {
    modelCalls: number;
    promptTokens: number;
    completionTokens: number;
    externalCalls: number;
    externalMs: number;
  };
  estimatedUsd: {
    model: number;
    external: number;
    total: number;
    rateCard: string;
    note: string;
  };
}

/**
 * Published rates, per million tokens, on the date named.
 *
 * Every source used in this build is on a free tier at the volume this runs at:
 * Companies House is free and unmetered, SEC EDGAR is free with a User-Agent,
 * Neon and Vercel are free tier, and Serper has a free allowance this stays
 * inside. So the external figure below is zero and that is a real result, not a
 * missing measurement -- the brief says nothing in this stage requires paid
 * tools, and it does not. Call counts are still recorded, because they are what
 * would cost money at 5,000 records and what the rate limits actually bind on.
 */
const RATE_CARD_DATE = '2026-08-01';

const MODEL_RATES: Record<string, { inPerM: number; outPerM: number }> = {
  'llama-3.3-70b-versatile': { inPerM: 0.59, outPerM: 0.79 },
  'llama-3.1-8b-instant': { inPerM: 0.05, outPerM: 0.08 },
  'openai/gpt-oss-20b': { inPerM: 0.10, outPerM: 0.50 },
};

const models = new Map<string, ModelSpend>();
const hosts = new Map<string, HostSpend>();

export function recordModelCall(
  model: string,
  usage: { promptTokens?: number; completionTokens?: number } = {},
  failed = false,
): void {
  const m = models.get(model) ?? { model, calls: 0, promptTokens: 0, completionTokens: 0, failures: 0 };
  m.calls++;
  m.promptTokens += usage.promptTokens ?? 0;
  m.completionTokens += usage.completionTokens ?? 0;
  if (failed) m.failures++;
  models.set(model, m);
}

export function recordHostCall(host: string, ms: number, failed = false): void {
  const h = hosts.get(host) ?? { host, calls: 0, failures: 0, totalMs: 0 };
  h.calls++;
  h.totalMs += ms;
  if (failed) h.failures++;
  hosts.set(host, h);
}

export function resetMeter(): void {
  models.clear();
  hosts.clear();
}

export function meterSnapshot(): MeterSnapshot {
  const ms = [...models.values()].sort((a, b) => b.calls - a.calls);
  const hs = [...hosts.values()].sort((a, b) => b.calls - a.calls);

  let modelUsd = 0;
  for (const m of ms) {
    const rate = MODEL_RATES[m.model];
    // An unpriced model contributes 0 and is visible as such in `models`, rather
    // than being guessed at some average rate.
    if (!rate) continue;
    modelUsd += (m.promptTokens / 1e6) * rate.inPerM + (m.completionTokens / 1e6) * rate.outPerM;
  }

  const round = (n: number) => Number(n.toFixed(6));

  return {
    models: ms,
    hosts: hs,
    totals: {
      modelCalls: ms.reduce((n, m) => n + m.calls, 0),
      promptTokens: ms.reduce((n, m) => n + m.promptTokens, 0),
      completionTokens: ms.reduce((n, m) => n + m.completionTokens, 0),
      externalCalls: hs.reduce((n, h) => n + h.calls, 0),
      externalMs: hs.reduce((n, h) => n + h.totalMs, 0),
    },
    estimatedUsd: {
      model: round(modelUsd),
      external: 0,
      total: round(modelUsd),
      rateCard: `published rates as of ${RATE_CARD_DATE}`,
      note:
        'Tokens and call counts are measured. Money is derived from the rate card and is an ' +
        'estimate: re-price the same tokens if the rates have moved. External cost is 0 ' +
        'because every source used is free at this volume -- Companies House and SEC EDGAR ' +
        'are free, Neon and Vercel are free tier, Serper stays inside its free allowance. ' +
        'Call counts are recorded anyway, since those are what rate limits bind on and what ' +
        'would carry a price at 5,000 records.',
    },
  };
}
