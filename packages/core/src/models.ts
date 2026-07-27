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
 * Originally Gemini Flash. Moved to Groq after Gemini's free generation quota
 * proved to be a few hundred calls a day - one bulk pass exhausts it, and a demo
 * that stops answering at 6pm is worse than a slightly weaker model.
 */
export const ANSWER_MODEL = 'llama-3.3-70b-versatile';

/** Bulk extraction: query parsing, page extraction. Small and fast on purpose. */
export const EXTRACTION_MODEL = 'llama-3.1-8b-instant';

/**
 * The attribution auditor. Must be a different model family from ANSWER_MODEL -
 * a model asked to check its own output shares its own blind spots and will wave
 * its own hallucinations through.
 *
 * gpt-oss-120b is a different architecture and training lineage from Llama, so
 * the independence property holds even though both are served by Groq. Provider
 * diversity was the original mechanism; model diversity is the actual
 * requirement.
 */
export const VERIFIER_MODEL = 'openai/gpt-oss-120b';
