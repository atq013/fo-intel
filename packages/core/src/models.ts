/**
 * Model choices, in one place because both the pipeline and the web app depend
 * on them agreeing. If the embedding model or its dimensionality changes, every
 * stored vector has to be rebuilt, so this is deliberately not configurable
 * per-call.
 */

export const EMBEDDING_MODEL = 'gemini-embedding-001';

/**
 * The model defaults to 3072 dimensions, which pgvector can store but cannot
 * index - both hnsw and ivfflat cap at 2000. 1536 indexes cleanly and costs
 * nothing measurable in retrieval quality at this corpus size.
 *
 * Embeddings are metered separately from generation on the free tier, which is
 * why they keep working after the generation quota is spent.
 */
export const EMBEDDING_DIMS = 1536;

/**
 * Answer generation for the served product.
 *
 * Third model this build. Gemini Flash first, until its free generation quota -
 * a few hundred calls a day - was spent by one bulk pass. Then Llama 3.3 70B,
 * until that hit Groq's 100,000 tokens-per-day ceiling during evaluation.
 *
 * Qwen carries the answer now, and the churn turned out to be useful: with
 * extraction on Llama, answering on Qwen and auditing on gpt-oss, all three
 * stages run on different model families. Independence is a stronger property
 * here than it was when it merely meant two providers.
 */
export const ANSWER_MODEL = 'qwen/qwen3.6-27b';

/** Bulk extraction: query parsing, page extraction. Small and fast on purpose. */
export const EXTRACTION_MODEL = 'llama-3.1-8b-instant';

/**
 * The attribution auditor. Must be a different model family from ANSWER_MODEL -
 * a model asked to check its own output shares its own blind spots and will wave
 * its own hallucinations through.
 *
 * gpt-oss-120b shares neither architecture nor training lineage with the answer
 * model, so the independence property holds even though both are served by Groq.
 * Provider diversity was the original mechanism; model diversity is the actual
 * requirement.
 */
export const VERIFIER_MODEL = 'openai/gpt-oss-120b';
