# Deploying

The app is a Next.js workspace package that reads from Neon. It has no build-time
dependency on the pipeline — the pipeline writes to Postgres, the app reads from
it, and Postgres is the only contract between them.

## Vercel

1. Import the repository at [vercel.com/new](https://vercel.com/new).
2. Leave **Root Directory** as the repository root. `vercel.json` already points
   the build at the `@fo/web` workspace; overriding the root directory breaks the
   workspace resolution.
3. Add these environment variables (Production and Preview):

   | Variable | Why |
   |---|---|
   | `DATABASE_URL` | Neon pooled connection string |
   | `GEMINI_API_KEY` | query embeddings only — metered separately from generation |
   | `GROQ_API_KEY` | answer generation and the independent attribution audit |

   The SEC, Companies House, Serper and Hunter keys are **not** needed: they are
   pipeline-only. The deployed app never calls an external data source, it only
   reads records that were already verified.

4. Deploy.

## Why serverless rather than a long-running server

Free-tier container hosts spin down after idle and cold-start in roughly fifty
seconds. For a page whose whole purpose is that someone can open it and ask a
question, a blank minute is a failure of the deliverable regardless of what
happens afterwards. Vercel's functions cold-start in the low hundreds of
milliseconds.

## Verifying a deployment

```
curl -s -X POST https://<deployment>/api/search \
  -H 'content-type: application/json' \
  -d '{"question":"Who runs Duquesne Family Office?"}' | head -c 400
```

A healthy response contains `"answered":true` with a non-empty `claims` array.
`"answered":false` with a `declineReason` is also healthy — it means the grounding
control fired. What is not healthy is a 500, which indicates the database or a
model provider is unreachable.

## Raw source files not kept in git

Two source dumps are regenerable and excluded from the repository because they
are large and are not deliverables. Fetch them only if you need to re-run
discovery from scratch; the records they produced are already in `exports/`.

**SEC investment-adviser roster** (~40 MB, 17,018 registered advisers with legal
name, address, website and registration status). Used to identify SEC-registered
firms whose registered name says "family office".

```
curl -L -A "your-name your@email" -o ia.zip \
  "https://www.sec.gov/files/investment/data/other/information-about-registered-investment-advisers-exempt-reporting-advisers/ia08032026-exempt.zip"
unzip ia.zip -d data/adv/
```

The dated filename changes; the current list is at
<https://www.sec.gov/data-research/sec-markets-data/information-about-registered-investment-advisers-exempt-reporting-advisers>.
The companion `ia08032026.zip` (without `-exempt`) is the exempt-reporting-adviser
file — smaller, and not the one used here.

**SEC Form 13F quarterly datasets** (~85 MB each). `data/sec/COVERPAGE.tsv` and
`SIGNATURE.tsv` are extracted from the most recent quarter and ARE kept in git,
because the signature block is the only free statutory source in this build that
publishes a personal phone number alongside a named signatory.

```
curl -L -A "your-name your@email" -o q.zip \
  "https://www.sec.gov/files/structureddata/data/form-13f-data-sets/01mar2026-31may2026_form13f.zip"
unzip q.zip COVERPAGE.tsv SIGNATURE.tsv -d data/sec/
```

Quarter list: <https://www.sec.gov/data-research/sec-markets-data/form-13f-data-sets>
