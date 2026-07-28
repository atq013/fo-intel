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
| Answering | `llama-3.3-70b-versatile`, then `llama-3.1-8b-instant`, then `openai/gpt-oss-20b` | see below |
| Auditing | `openai/gpt-oss-120b` (Groq) | different model family from the answerer |
| Query parsing | `openai/gpt-oss-20b` (Groq) | kept off the answer model so a fallback does not starve both stages |

**Why 1536 dimensions.** The model defaults to 3072. pgvector will store that and
cannot index it — both hnsw and ivfflat cap at 2000. 1536 indexes cleanly with
hnsw and costs nothing measurable at this corpus size.

**The answer model moved three times**, and the history is worth recording.

Gemini Flash first, until its free generation quota — a few hundred calls a day —
was spent by a single bulk extraction pass. Then Llama 3.3 70B, until evaluation
exhausted Groq's 100,000 tokens-per-day ceiling. Then Qwen, which returned HTTP
200 with an empty body: it is a reasoning model and spent its whole output budget
on thinking tokens. **That failure only appeared in production**, on a prompt large
enough to provoke it, which is a fair argument for testing against the deployed
system rather than only locally.

Back on Llama 3.3, now with a fallback rather than a hope. The fallback is
deliberately the *smaller Llama* rather than a stronger model from another family,
because the answerer and the auditor must never share a lineage. Degrading to a
weaker answer is acceptable; degrading to an answer its own auditor cannot judge
independently is not.

The requirement was never "two providers" — it is that the model checking an
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
| Correct | **14 (93%)** |
| **False negative rate** (answered when it should have refused) | **0%** |
| False positive rate (refused when it could have answered) | **0%** |
| Claims kept / dropped | 36 / 20 |
| Provider outages (excluded from both rates) | 1 |
| Median latency | 9.5s |

An earlier run of the same suite scored 15/15 with zero outages. Both runs put the
false negative rate at 0%, which is the number that matters.

20 of 56 drafted claims were dropped by the audit — roughly a third. That rate is
the point of the control, not a defect in it.

False negative rate is the number that matters. Framed as a validation layer, the
dangerous error is letting an unsupported claim through, because it then ships
with the system's confidence behind it.

**Provider outages are excluded and reported separately** rather than scored as
declines. Telling a user "there is not enough evidence" when the truth is "we were
rate limited" is a false statement about their data, so the two are distinguished
in the code and in the interface.

An earlier run of this same suite reported 0% on both rates with 2 outages, and
that number was partly luck: rate limiting was suppressing answers that would
otherwise have been wrong. Measuring a control while the infrastructure beneath it
is failing flatters it. The numbers above come from a run with zero outages.

## The failure that nearly took the demo down

Late in the build both Llama models hit their daily token ceilings within minutes
of each other — the 70B at 100,000 tokens and the 8B at 500,000. The deployed
system could not answer at all. Not a bug, not a rate limit that clears in a
minute: a hard daily wall, hit while running evaluations.

The fallback was one model deep, so when the fallback died there was nothing
behind it. It is now a chain, and the order encodes a priority: the two Llama
models first, then `gpt-oss-20b`.

That order matters more than it looks. The auditor is `gpt-oss-120b`, so answering
on Llama keeps the answerer and its auditor in different families, which is the
entire point of the control. Falling into gpt-oss is a genuine degradation of that
independence, so it sits last and only runs when both Llama models are exhausted.
The model that actually produced an answer is logged, because a degraded answer is
acceptable and a silently degraded one is not.

Two smaller changes came out of the same incident. A daily ceiling is remembered
for thirty minutes rather than rediscovered on every request, which was costing
three failed attempts and about fifteen seconds per query. And query parsing moved
off the answer model onto `gpt-oss-20b`, because when the primary falls back to the
small Llama, having parsing on the same model doubles its per-minute load and
starves both stages at once.

## A fourth defect, found by a user rather than the test set

Someone using the deployed system counted sixteen statements in an answer and only
eight firm cards, and asked whether that was a bug.

The count itself was correct - each firm produces two separately audited claims,
one for its classification and one for its principal, which is deliberate: a
combined sentence would be a single claim where half could be invented and the
auditor would have to pass or fail it whole.

But the question exposed something real underneath. The dataset holds 22 UK
single-family offices and the answer showed 8, because the prompt-size fix
described below had capped sources at eight - and nothing in the interface said so,
which made eight look like all of them.

Three changes followed. Sources per prompt raised to 14 and trimmed to 210
characters each, which fits more firms into a smaller prompt than eight long ones
did. The interface now reports "showing 14 of 22 matching" whenever a structured
filter has run, and stays silent when one has not, since without a filter that
count is simply the size of the file.

The third change was a latent bug the first two exposed. The field gate asked
"does any retrieved firm hold this field", so once a few records had email
addresses, the question "what is the email address for Francis Family Office"
returned three *other* firms' emails - every claim true, none of them the answer.
The gate now looks up firms whose name appears in the question, against the whole
table rather than the retrieved set, because similarity search will rank firms
that *have* the field above the firm that was asked about.

## Three defects this evaluation found

**Junk evidence became a citable fact.** The profile chunk embedded the raw
classification quote. For Duquesne that quote was `page states: "Duquesne Family
Office Stanley Druckenmiller 7"` - a scraped LinkedIn fragment. The model then
cited it to claim Druckenmiller runs the firm, and the auditor passed the claim,
correctly: the text genuinely was in the retrieved source.

Two fixes. The informativeness check now strips the firm's name token by token
rather than as one string, so a quote using a shorter form of the name no longer
survives on the strength of its own subject. And the embedded chunk now carries
the classification *conclusion and source class* rather than the raw quote. The
full quote stays on the record for the provenance disclosure, where a human reads
it, rather than in the corpus, where a model can cite it.

**Grounding is not relevance.** Asked what sectors a firm invests in - a field
blank throughout the file - the system returned nine true statements about that
firm's location and type. Every claim supported, none responsive, and the audit
passed them all because it checks support.

The fix is a deterministic field gate rather than a relevance judge: patterns
detect when a question asks for a specific field, and the system checks whether
any retrieved record actually holds it before generating. AUM, sectors, thesis and
ranking are refused outright, because no record carries them. A regex gate is
worth more than a cleverer one here, because it decides a refusal.

**Prompt size was silently breaking the fallback.** A 14-chunk prompt costs about
3,900 tokens. The fallback model's ceiling is 6,000 per minute, so once the
primary hit its daily cap the fallback failed too, and the user saw "not enough
records" when the truth was "prompt too large". Sources sent to the model are now
capped at 8, truncated to 320 characters, and the schema is echoed compactly
rather than pretty-printed: roughly 510 tokens. The system now degrades to the
smaller model instead of failing.

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
