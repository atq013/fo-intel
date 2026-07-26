import { ANSWER_MODEL, VERIFIER_MODEL } from '@fo/core';

/**
 * Two providers, deliberately. Gemini generates; Groq verifies. A model checking
 * its own output shares its own blind spots, so the attribution checker in the
 * RAG layer must not run on the model that produced the text it is checking.
 */

interface JsonSchema {
  type: string;
  properties?: Record<string, unknown>;
  items?: unknown;
  required?: string[];
}

export async function generateJson<T>(prompt: string, schema: JsonSchema, opts: { temperature?: number } = {}): Promise<T> {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new Error('GEMINI_API_KEY not set');

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

  if (!res.ok) throw new Error(`gemini ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const json = (await res.json()) as { candidates?: Array<{ content: { parts: Array<{ text: string }> } }> };
  const text = json.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) throw new Error('gemini returned no content');
  return JSON.parse(text) as T;
}

/** Independent second opinion. Used by validation, never by generation. */
export async function verifyJson<T>(prompt: string): Promise<T> {
  const key = process.env.GROQ_API_KEY;
  if (!key) throw new Error('GROQ_API_KEY not set');

  const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: VERIFIER_MODEL,
      temperature: 0,
      response_format: { type: 'json_object' },
      messages: [{ role: 'user', content: prompt }],
    }),
  });

  if (!res.ok) throw new Error(`groq ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const json = (await res.json()) as { choices: Array<{ message: { content: string } }> };
  return JSON.parse(json.choices[0]!.message.content) as T;
}

export async function embed(text: string): Promise<number[]> {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new Error('GEMINI_API_KEY not set');
  const { EMBEDDING_MODEL, EMBEDDING_DIMS } = await import('@fo/core');

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

  if (!res.ok) throw new Error(`gemini embed ${res.status}`);
  const json = (await res.json()) as { embedding: { values: number[] } };
  return json.embedding.values;
}
