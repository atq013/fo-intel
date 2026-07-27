# RAG documentation note

Stack, chunking, embeddings, retrieval, the grounding control, what works, what
does not, the queries I actually ran against the deployed system, and what I would
do next.

---

## Stack

| Layer | Choice | Why |
|---|---|---|
| Store | Neon Postgres + pgvector | one store for structured filters and vectors; no second system to keep in sync |
| App | Next.js on Vercel | serverless cold start is a few hundred ms. Free container hosts idle down and cold-start around fifty seconds, and a blank minute on a page whose entire purpose is "open it and ask" is a failed deliverable |
| Embeddings | `gemini-embedding-001` at 1536 dims | metered separately from generation, which is why it kept working after generation quota ran out |
| Answering | `qwen/qwen3.6-27b` (Groq) | see below |
| Auditing | `openai/gpt-oss-120b` (Groq) | different model family from the answerer |
| Extraction | `llama-3.1-8b-instant` (Groq) | bulk work; every output is mechanically checked anyway |

**Why 1536 dimensions.** The model defaults to 3072. pgvector will store that and
cannot index it — both hnsw and ivfflat cap at 2000. 1536 indexes cleanly with
hnsw and costs nothing measurable at this corpus size.

**Three answer models in one build**, which is worth recording honestly. Gemini
Flash first, until its free generation quota — a few hundred calls a day — was
spent by a single bulk extraction pass. Then Llama 3.3 70B, until that hit Groq's
100,000 tokens-per-day ceiling during evaluation. Now Qwen.

The churn produced a better property than I designed for. Extraction runs on
Llama, answering on Qwen, auditing on gpt-oss: **three different model families**.
The requirement was never "two providers" — it was that the model checking an
answer must not be the model that wrote it, because a model auditing itself shares
its own blind spots.

## Chunking

Chunks are **semantic units, not fixed windows**. A record produces:

- one **profile** chunk — what the firm is, where, who its principal is, whether contact data exists, and the basis for the classification
- one chunk **per dated signal** — filings, stake disclosures, director appointments

50 records produce 152 chunks. Fixed-size windows would split a firm's identity
from its evidence and let a signal be retrieved without knowing whose it is.

**What is deliberately not embedded:** validation notes, audit reasons, confidence
text. Embedding those lets a semantic match on an audit note surface a firm whose
customer-facing cells are empty — the retrieval equivalent of handing someone your
workings instead of your answer.

## Retrieval

**Hybrid, and the order is a correctness requirement rather than an optimisation.**

The query is first parsed into structured constraints and a semantic remainder.
"Single-family offices in Texas" contains a filter and a topic. Handed whole to an
embedding search it returns whatever reads similarly — a Californian multi-family
office scores well on that sentence — and the user has no way to see their
constraint was silently ignored. Constraints go to SQL; only the remainder is
matched by cosine distance.

Recognised constraints are shown back to the user as chips, so a wrongly-parsed
filter is visible rather than invisible.

A cosine distance above **0.62** on the nearest chunk means nothing retrieved is
about the question, and the system declines before generating anything.

## The grounding control

The brief is explicit that prompt instructions are not enough — telling a model to
use only the provided data does not prove that it will. So:

1. **The answer is never prose.** The model emits discrete claims, each citing the
   chunk ids it rests on.
2. **Lexical check** (deterministic). Numbers, dates and proper nouns in a claim
   must appear verbatim in the chunks it cites; content words must reach 60%
   coverage. Cheap, and catches the common failure of citing a real chunk for a
   fact it does not contain.
3. **Entailment check**, on a different model family. It is told it did not write
   the claims, and to reject anything more specific than its sources, any
   relationship the sources do not state, and any generalisation.
4. **Failure closes.** If the auditor is unreachable, claims are dropped, not
   passed. A claim nobody checked is not a verified claim.
5. **Dropped claims are dropped, not flagged.** Rendering an unsupported claim
   with a warning still puts it in front of the user.
6. **Only firms cited by a surviving claim are shown.** Retrieval reaching a firm
   is not a reason to display it.

## Measured accuracy

`packages/pipeline/src/eval/rag-eval.ts`, 15 cases, two thirds of which the system
is supposed to **refuse**. A system that answers everything scores zero here.

| | |
|---|---|
| Cases | 15 |
| Correct | **13 (87%)** |
| **False negative rate** (answered when it should have refused) | **0%** |
| False positive rate (refused when it could have answered) | **0%** |
| Claims kept / dropped | 11 / 1 |
| Provider outages (excluded from both rates) | 2 |
| Median latency | 4.9s |

False negative rate is the number that matters. Framed as a validation layer, the
dangerous error is letting an unsupported claim through, because it then ships
with the system's confidence behind it.

**Provider outages are excluded and reported separately** rather than scored as
declines. Telling a user "there is not enough evidence" when the truth is "we were
rate limited" is a false statement about their data, so the two are distinguished
in the code and in the interface.

## Two cases that changed my mind

Both started as test failures and turned out to be my expectations being wrong.

**"Who runs Duquesne Family Office?"** The model drafted *"Duquesne Family Office
is run by Stanley Druckenmiller."* That is **true in the world** and absent from
the record, whose principal is Sue Meng, General Counsel. The auditor rejected it:
*"the mention of his name does not confirm he runs it."*

A true-but-unsupported claim is the hardest hallucination to catch, because
nothing about it looks wrong. This is the single best piece of evidence that the
control does real work.

**"Which family offices are most likely to invest in AI startups?"** I wrote this
expecting a refusal. The system answered: *"Bezos Expeditions backed Unconventional
AI, which aims to build a more energy-efficient AI computer."* That is a dated,
sourced signal — not a prediction. Answering a speculative question with the
nearest evidenced fact is correct. The case now tests that forecasting language
never appears, which is the thing that actually matters.

## Live queries I ran against the deployed system

Through the interface, not the API:

| Query | Result |
|---|---|
| "Who runs Duquesne Family Office?" | answered — principal, filed phone `212-830-6500`, dated 13F signal, provenance disclosure |
| "Single-family offices in the United Kingdom" | answered — 11 firms with addresses, PSC principals, control rights |
| "Which family offices are based in the United States?" | answered 3 claims, **dropped 1** — the auditor rejected a claim about Cascade because its source called it "an American holding company and private investment firm" rather than a single-family office |
| "Family offices I can actually reach by phone" | answered — filtered to records with a verified contact route |
| "Tell me about the Rockefeller family office" | declined — not in the dataset, and the name did not leak into the response |

## What works

- Constraint parsing correctly separates filters from topic, and shows them back.
- The auditor catches true-but-unsupported claims, which is the hard case.
- Blank fields behave correctly: asking for AUM or sectors produces a clean
  refusal rather than an invention, because those cells are honestly empty.
- The interface never shows a raw error, an id, or an internal field name.

## What does not

- **Latency is 5–8 seconds.** Three sequential model calls — parse, answer, audit.
  Parsing could run concurrently with retrieval and would save roughly a second.
- **Free-tier token ceilings are a real operational constraint**, not a
  hypothetical. Two of fifteen evaluation cases hit one. In production this needs a
  paid tier; the architecture does not change.
- **The auditor verifies grounding, not responsiveness.** A claim that is fully
  supported but does not answer the question will pass. I saw this and decided it
  is the right trade — the alternative is a relevance judge that can suppress true
  statements.
- **The corpus is 50 records.** Retrieval quality at this size says little about
  behaviour at fifty thousand; hnsw is configured but barely exercised.

## What I would do next

1. Run parse and retrieval concurrently to cut a second off every query.
2. Cache the entailment verdict per claim-chunk pair — evaluation repeats identical
   checks constantly.
3. Expand the adversarial set to roughly 50 cases and track the false negative rate
   as a regression gate, not a one-off measurement.
4. Show the dropped-claim count in the interface by default rather than only when
   an answer is withheld. Users trust a system that visibly removes things more
   than one that silently succeeds.
