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
 */
export const EMBEDDING_DIMS = 1536;

/** Answer generation for the served product. Low volume. */
export const ANSWER_MODEL = 'gemini-2.5-flash';

/**
 * Bulk extraction across discovery and enrichment. Runs on Groq because Gemini's
 * free tier is a few hundred calls a day and one discovery pass exceeds it.
 */
export const EXTRACTION_MODEL = 'llama-3.3-70b-versatile';

/**
 * The attribution checker runs on a different provider from the answer model on
 * purpose: a model asked to verify its own output is not an independent check.
 */
export const VERIFIER_MODEL = 'llama-3.3-70b-versatile';
