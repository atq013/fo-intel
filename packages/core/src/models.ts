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
 * This moved three times and the history is worth keeping. Gemini Flash first,
 * until its free generation quota - a few hundred calls a day - was spent by one
 * bulk extraction pass. Then Llama 3.3 70B, until evaluation exhausted Groq's
 * 100,000 tokens-per-day ceiling. Then Qwen, which returned HTTP 200 with an
 * empty body: it is a reasoning model and spent its entire output budget on
 * thinking tokens, leaving nothing for the answer. That failure only appeared in
 * production, on a prompt large enough to provoke it.
 *
 * Back on Llama 3.3, with a fallback rather than a hope. The fallback is
 * deliberately the smaller Llama rather than a better model from another family,
 * because ANSWER and VERIFIER must never share a lineage - degrading to a weaker
 * answer is acceptable, degrading to an answer its own auditor cannot judge
 * independently is not.
 */
export const ANSWER_MODEL = 'llama-3.3-70b-versatile';

/**
 * Fallback chain, tried in order, and the order encodes a priority.
 *
 * The Llama models come first because the auditor is gpt-oss: answering on Llama
 * keeps the answerer and its auditor in different families, which is the whole
 * point of the control. Crossing into gpt-oss is a real degradation of that
 * independence, so it sits last and is used only when both Llama models are at
 * their daily ceilings - which happened once during this build, and left the
 * deployed demo unable to answer at all.
 *
 * A degraded answer beats no answer; a silently degraded one does not, so the
 * model that actually produced an answer is logged.
 */
export const ANSWER_FALLBACK_MODELS = ['llama-3.1-8b-instant', 'openai/gpt-oss-20b'] as const;

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

/**
 * Query parsing in the served product. Deliberately not the same model as the
 * answerer: when the primary is at its daily ceiling the answerer falls back to
 * the small Llama, and having parsing on that model too doubles its per-minute
 * load and starves both stages.
 */
export const QUERY_PARSE_MODEL = 'openai/gpt-oss-20b';
