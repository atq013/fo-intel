/**
 * Model access for the served product.
 *
 * Duplicated deliberately rather than imported from the pipeline: this runs in
 * serverless functions where the pipeline's DNS agent and rate limiters are both
 * unnecessary and harmful.
 *
 * Gemini answers, Groq audits. A model asked to check its own output shares its
 * own blind spots, so the attribution check must not run on the answering model.
 */
import {
  ANSWER_MODEL,
  ANSWER_FALLBACK_MODELS,
  EMBEDDING_MODEL,
  EMBEDDING_DIMS,
  VERIFIER_MODEL,
  QUERY_PARSE_MODEL,
  recordModelCall,
} from '@fo/core';

export async function embed(text: string): Promise<number[]> {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new Error('GEMINI_API_KEY not set');
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${EMBEDDING_MODEL}:embedContent?key=${key}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: `models/${EMBEDDING_MODEL}`,
        content: { parts: [{ text }] },
        outputDimensionality: EMBEDDING_DIMS,
      }),
    },
  );
  if (!res.ok) throw new Error(`embed ${res.status}`);
  const json = (await res.json()) as { embedding: { values: number[] } };
  return json.embedding.values;
}

/**
 * Once the primary model reports a daily ceiling, every later request would spend
 * three attempts and ~15 seconds rediscovering that before falling back. A daily
 * limit does not clear inside a session, so it is remembered and the primary is
 * skipped until the process restarts.
 */
let primaryExhaustedUntil = 0;

export async function generateJson<T>(prompt: string, schema: object): Promise<T> {
  // Compact, not pretty-printed: the indented form cost a few hundred tokens on
  // every single call for no benefit to the model.
  const withShape = `${prompt}

Respond with JSON only, no commentary, matching: ${JSON.stringify(schema)}`;

  const chain = Date.now() < primaryExhaustedUntil
    ? [...ANSWER_FALLBACK_MODELS]
    : [ANSWER_MODEL, ...ANSWER_FALLBACK_MODELS];

  let lastErr: unknown;
  for (const model of chain) {
    try {
      const result = await groq<T>(withShape, model);
      if (model !== ANSWER_MODEL) console.error(`answer produced by fallback model ${model}`);
      return result;
    } catch (err) {
      lastErr = err;
      const msg = err instanceof Error ? err.message : String(err);

      // A malformed request will fail identically on every model.
      const worthMovingOn =
        err instanceof ServiceUnavailable || /json_validate_failed|429|tokens per day/i.test(msg);
      if (!worthMovingOn) throw err;

      if (model === ANSWER_MODEL && /tokens per day|TPD/i.test(msg)) {
        primaryExhaustedUntil = Date.now() + 30 * 60_000;
        console.error('primary model at its daily ceiling; skipping it for 30 minutes');
      }
    }
  }
  throw lastErr instanceof Error ? lastErr : new ServiceUnavailable('no answer model available');
}

/**
 * Marks failures that are the provider being busy rather than the records being
 * insufficient. The distinction matters: telling a user "there is not enough
 * evidence" when the truth is "we were rate limited" is a false statement about
 * their data.
 */
export class ServiceUnavailable extends Error {}

async function groq<T>(prompt: string, model: string, attempts = 3): Promise<T> {
  const key = process.env.GROQ_API_KEY;
  if (!key) throw new Error('GROQ_API_KEY not set');

  let last = '';
  for (let i = 0; i < attempts; i++) {
    if (i > 0) await new Promise((r) => setTimeout(r, 900 * 2 ** i));

    const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        temperature: 0,
        response_format: { type: 'json_object' },
        messages: [{ role: 'user', content: prompt }],
      }),
    });

    if (res.ok) {
      const json = (await res.json()) as {
        choices: Array<{ message: { content: string } }>;
        usage?: { prompt_tokens?: number; completion_tokens?: number };
      };
      // The provider returns exact token counts on every call and this code
      // threw them away. They are the only measured input to the cost figures.
      recordModelCall(model, {
        promptTokens: json.usage?.prompt_tokens,
        completionTokens: json.usage?.completion_tokens,
      });
      return JSON.parse(json.choices[0]!.message.content) as T;
    }

    const body = (await res.text()).slice(0, 300);
    last = `${res.status} ${body}`;
    // A rejected call still consumed a round trip and often the input tokens.
    // Counting only successes would understate what a run costs to complete.
    recordModelCall(model, {}, true);
    // 429 and 5xx clear on their own; anything else will not.
    if (res.status !== 429 && res.status < 500) throw new Error(`groq ${res.status}: ${body}`);
  }
  throw new ServiceUnavailable(`groq unavailable after ${attempts} attempts (${last})`);
}

/** The independent auditor. Never the answering model. */
export const verifyJson = <T>(prompt: string) => groq<T>(prompt, VERIFIER_MODEL);

/** Cheap structured work, e.g. parsing a query into filters. */
export const extractJson = <T>(prompt: string, _schema: object) => groq<T>(prompt, QUERY_PARSE_MODEL);
