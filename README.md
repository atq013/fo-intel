# fo-intel

Family office intelligence: a pipeline that discovers family offices from public
sources and proves what each one is, and a product that makes the result
queryable in plain English.

**Live system:** https://fo-intel-web.vercel.app

Built for the PolarityIQ Differentiator. **Stage 2 is the current state**; see
[`docs/ACCEPTANCE_M3.md`](docs/ACCEPTANCE_M3.md) for the requirement-to-evidence
matrix and the deliverable index, and [`SUBMISSION.md`](SUBMISSION.md) for the
Stage 1 one, kept as history.

| surface | what it is |
|---|---|
| [`/`](https://fo-intel-web.vercel.app/) | plain-English search over the original Stage 1 corpus of 50 records |
| [`/shortlist`](https://fo-intel-web.vercel.app/shortlist) | the Stage 2 retrieval extension — filters, evidence grading, pagination over all 581 records |
| [`/agent`](https://fo-intel-web.vercel.app/agent) | the agent, using retrieval as a tool |
| [`/operations`](https://fo-intel-web.vercel.app/operations) | what ran, what it refused, and why |

Stage 2 documents: [architecture notes](docs/ARCHITECTURE_NOTES.md) ·
[inclusion standard](docs/INCLUSION_RUBRIC.md) ·
[build summary](docs/BUILD_SESSION_SUMMARY.md) ·
[AI working-session record](docs/ai-session/) ·
[exports](exports/)

---

## What it does

The pipeline finds candidate firms across four independent source classes, proves
what each firm actually is, enriches the ones that qualify, and writes records
where **every value carries its basis** — the exact evidence span it was read
from, the URL and tier of that source, the content hash at the time, and the
outcome of six validation gates under a named policy version. Stage 1 delivered
50 such records; Stage 2 operates the same contract at scale, unattended, on a
schedule. The product reads those records and answers questions about them
without being able to claim anything the records do not support.

The two halves share nothing but the database. The pipeline writes; the app reads.

## Layout

```
packages/core       the record schema, shared by pipeline and app
packages/pipeline   discovery, classification, enrichment, validation, emit
packages/db         Postgres access and hybrid retrieval
packages/rag        query parsing, answer generation, the grounding control
apps/web            the customer-facing product
docs/               methodology, validation chains, RAG notes, Task 2
data/               the delivered dataset, audit trails, run logs
```

## Running it

Requires Node 20+ and a `.env` (copy `.env.example`). Not every key is needed for
every command — the app needs three, the pipeline needs the rest.

```bash
npm install
```

**Inspect the delivered dataset** — no credentials needed beyond the database:

```bash
npx tsx packages/pipeline/src/emit/stats.ts
```

Prints every figure quoted in `SUBMISSION.md`. These are generated rather than
typed, so a stale number in the documentation shows up as a mismatch here.

**Check credentials** before running anything that calls out:

```bash
npx tsx packages/pipeline/src/lib/check-env.ts
```

Makes a real call against each service and reports pass or fail per credential.
It never prints a key.

**Rebuild the dataset** from the candidate pools already in `data/`:

```bash
npx tsx packages/pipeline/src/emit/run.ts
```

**Load it into Postgres and embed it:**

```bash
npx tsx packages/db/src/migrate.ts     # schema, safe to re-run
npx tsx packages/pipeline/src/emit/ingest.ts
```

**Run the product locally:**

```bash
npm run dev -w @fo/web
```

**Evaluate the grounding control:**

```bash
npx tsx packages/pipeline/src/eval/rag-eval.ts
```

15 adversarial cases, two thirds of which the system is supposed to *refuse*.
Reports false negative and false positive rates. Free-tier providers meter tokens
per minute, so `EVAL_PACE_MS=15000` in front of the command avoids measuring the
rate limiter instead of the control.

### Rediscovery

The discovery stages hit external APIs and take hours. The candidate pools they
produced are committed under `data/`, so the dataset can be rebuilt without
re-running them. To re-run a channel anyway:

```bash
npx tsx packages/pipeline/src/cli.ts discover    # SEC 13F structural scoring
npx tsx packages/pipeline/src/cli.ts fulltext    # EDGAR full-text search
npx tsx packages/pipeline/src/cli.ts uk          # Companies House + PSC
npx tsx packages/pipeline/src/cli.ts web         # conference, news, job postings
```

The SEC channel reads a quarterly dataset from `data/raw/sec/`, which is
gitignored for size. `discover` explains where to fetch it if absent.

## Reading the code

Three files carry most of the reasoning, and each opens with why it exists:

- [`packages/core/src/schema.ts`](packages/core/src/schema.ts) — why no high-value
  value is ever a bare primitive
- [`packages/pipeline/src/enrich/source-tier.ts`](packages/pipeline/src/enrich/source-tier.ts)
  — written after a known-answer test caught the pipeline asserting something false
- [`packages/rag/src/attribution.ts`](packages/rag/src/attribution.ts) — the control
  that decides what an answer is allowed to claim

[`DECISIONS.md`](DECISIONS.md) is the running log of what was chosen, what was got
wrong, and what changed as a result.
