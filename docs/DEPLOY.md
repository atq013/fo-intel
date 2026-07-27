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
