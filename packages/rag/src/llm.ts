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
  ANSWER_FALLBACK_MODEL,
  EMBEDDING_MODEL,
  EMBEDDING_DIMS,
  VERIFIER_MODEL,
  EXTRACTION_MODEL,
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

export async function generateJson<T>(prompt: string, schema: object): Promise<T> {
  // Compact, not pretty-printed: the indented form cost a few hundred tokens on
  // every single call for no benefit to the model.
  const withShape = `${prompt}

Respond with JSON only, no commentary, matching: ${JSON.stringify(schema)}`;

  try {
    return await groq<T>(withShape, ANSWER_MODEL);
  } catch (err) {
    // Falling back is worth it for a daily ceiling or a refused generation. It is
    // not worth it for a malformed request, which will fail identically.
    const msg = err instanceof Error ? err.message : String(err);
    const worthRetrying = err instanceof ServiceUnavailable || /json_validate_failed|429|tokens per day/i.test(msg);
    if (!worthRetrying) throw err;
    console.error(`answer model fell back to ${ANSWER_FALLBACK_MODEL}: ${msg.slice(0, 160)}`);
    return groq<T>(withShape, ANSWER_FALLBACK_MODEL);
  }
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
      const json = (await res.json()) as { choices: Array<{ message: { content: string } }> };
      return JSON.parse(json.choices[0]!.message.content) as T;
    }

    const body = (await res.text()).slice(0, 300);
    last = `${res.status} ${body}`;
    // 429 and 5xx clear on their own; anything else will not.
    if (res.status !== 429 && res.status < 500) throw new Error(`groq ${res.status}: ${body}`);
  }
  throw new ServiceUnavailable(`groq unavailable after ${attempts} attempts (${last})`);
}

/** The independent auditor. Never the answering model. */
export const verifyJson = <T>(prompt: string) => groq<T>(prompt, VERIFIER_MODEL);

/** Cheap structured work, e.g. parsing a query into filters. */
export const extractJson = <T>(prompt: string, _schema: object) => groq<T>(prompt, EXTRACTION_MODEL);
