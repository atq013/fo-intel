import pLimit from 'p-limit';
import { ANSWER_MODEL, EXTRACTION_MODEL, VERIFIER_MODEL } from '@fo/core';
import { installResilientDns } from './dns.js';

installResilientDns();

/**
 * Provider split, driven by two separate constraints.
 *
 * Independence: the model that writes a RAG answer must never be the model that
 * checks it. Gemini answers, Groq verifies.
 *
 * Capacity: Gemini's free tier allows a few hundred calls a day, which a bulk
 * extraction run exhausts in one pass - observed here after roughly 60 pages.
 * Groq's free tier is an order of magnitude larger, so all bulk extraction runs
 * there and Gemini is reserved for embeddings and for answering, both of which
 * are low volume.
 *
 * The two constraints happen to agree, but they are not the same constraint, and
 * if Gemini's quota were raised the independence rule would still hold.
 */

const geminiLimit = pLimit(4);
const groqLimit = pLimit(2);

interface JsonSchema {
  type: string;
  properties?: Record<string, unknown>;
  items?: unknown;
  required?: string[];
}

class QuotaError extends Error {
  constructor(provider: string) {
    super(`${provider} quota exhausted`);
  }
}

export function isQuotaError(err: unknown): boolean {
  return err instanceof QuotaError;
}

async function withRetry<T>(fn: () => Promise<T>, provider: string, attempts = 4): Promise<T> {
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      const msg = err instanceof Error ? err.message : String(err);
      // A daily quota will not clear inside this run; a per-minute limit will.
      if (/quota|RESOURCE_EXHAUSTED/i.test(msg) && /per day|daily|PerDay/i.test(msg)) {
        throw new QuotaError(provider);
      }
      if (!/429|rate|quota|503|502|overloaded/i.test(msg)) throw err;
      await new Promise((r) => setTimeout(r, Math.min(2 ** i * 4000, 45_000)));
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(`${provider} failed`);
}

async function groqChat(prompt: string, model: string): Promise<string> {
  const key = process.env.GROQ_API_KEY;
  if (!key) throw new Error('GROQ_API_KEY not set');

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

  if (!res.ok) throw new Error(`groq ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const json = (await res.json()) as { choices: Array<{ message: { content: string } }> };
  return json.choices[0]!.message.content;
}

/**
 * Bulk structured extraction. Groq has no responseSchema, so the shape is stated
 * in the prompt and the parsed result is still validated by the caller - which it
 * has to be anyway, since a schema-conformant object can still contain a quote
 * that does not appear in the source.
 */
export async function extractJson<T>(prompt: string, schema: JsonSchema): Promise<T> {
  const withShape = `${prompt}

Return ONLY a JSON object matching this shape, with no commentary:
${JSON.stringify(schema, null, 2)}`;

  return groqLimit(() =>
    withRetry(async () => {
      const text = await groqChat(withShape, EXTRACTION_MODEL);
      return JSON.parse(text) as T;
    }, 'groq'),
  );
}

/** Answer generation for the served product. Low volume, so Gemini is affordable here. */
export async function generateJson<T>(prompt: string, schema: JsonSchema, opts: { temperature?: number } = {}): Promise<T> {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new Error('GEMINI_API_KEY not set');

  return geminiLimit(() =>
    withRetry(async () => {
      const res = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${ANSWER_MODEL}:generateContent?key=${key}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contents: [{ parts: [{ text: prompt }] }],
            generationConfig: {
              temperature: opts.temperature ?? 0,
              responseMimeType: 'application/json',
              responseSchema: schema,
            },
          }),
        },
      );
      if (!res.ok) throw new Error(`gemini ${res.status}: ${(await res.text()).slice(0, 300)}`);
      const json = (await res.json()) as { candidates?: Array<{ content: { parts: Array<{ text: string }> } }> };
      const text = json.candidates?.[0]?.content?.parts?.[0]?.text;
      if (!text) throw new Error('gemini returned no content');
      return JSON.parse(text) as T;
    }, 'gemini'),
  );
}

/** Independent check on generated text. Must stay on a different provider. */
export async function verifyJson<T>(prompt: string): Promise<T> {
  return groqLimit(() =>
    withRetry(async () => {
      const text = await groqChat(prompt, VERIFIER_MODEL);
      return JSON.parse(text) as T;
    }, 'groq'),
  );
}

export async function embed(text: string): Promise<number[]> {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new Error('GEMINI_API_KEY not set');
  const { EMBEDDING_MODEL, EMBEDDING_DIMS } = await import('@fo/core');

  return geminiLimit(() =>
    withRetry(async () => {
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
      if (!res.ok) throw new Error(`gemini embed ${res.status}: ${(await res.text()).slice(0, 200)}`);
      const json = (await res.json()) as { embedding: { values: number[] } };
      return json.embedding.values;
    }, 'gemini'),
  );
}
