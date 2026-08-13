# AI session — product quality review

The complete record of AI use in reviewing the deployed product.

## What is here

| file | size | what it is |
|---|---|---|
| `transcript-raw.jsonl` | 4.40 MB | the original session log, one JSON record per line, redacted and otherwise untouched |
| `transcript.md` | 0.29 MB | the same conversation, readable, grouped by day |
| `prompts.md` | 0.04 MB | every instruction given, quoted as entered |
| `redaction-log.md` | 0.00 MB | what was removed, by pattern, with counts |
| `SHA256SUMS` | — | hashes of the four files above |

Verify with `shasum -a 256 -c SHA256SUMS`.

## Coverage

**334 messages**, 2026-08-10T17:40:09.768Z to 2026-08-11T08:45:18.981Z.

The record begins at **2026-08-10T17:40:09.768Z**, the message that started the review:

> "okay, so now we have to review the product from here and also we have to record
> the AI session and we can include from this message starting from here, I have
> already done the testing and reviewed the live product."

This record is merged from **2 session log files**: the session
exhausted its context window on 11 August and the tooling continued it in a second
file. They overlap around the handover, so records are deduplicated by uuid
(47 duplicates removed) and re-sorted by timestamp into one continuous
record. Exporting only the first file would have ended the record before most of
the second day's work while still appearing complete.

1988 earlier records from the same session — the Stage 2 build, which
is covered separately by `docs/ai-session/` — fall before that boundary and are
excluded. That is a cut by **time** at the boundary the operator named, not by
content. Nothing after it is removed.

## How AI was used in this review

The manual customer pass was done first, without AI, on the deployed site. The
assistant was then given source access and asked to run a second pass from the
opposite direction: check every claim each surface makes to a customer against the
API, the database and the code.

Both are in this record, including:

- the assistant's findings and the commands it ran to establish them
- the point where it challenged two of the operator's figures and **was wrong**,
  and the correction that followed
- the operator's critique of the assistant's own review
- the drafting of the consolidated review document

No change was made to the product or to the submission at any point in this
session. Every command run against the deployed system was a read.

## Models

`claude-opus-5` via Claude Code. The product's own models — `llama-3.3-70b-versatile`
with `llama-3.1-8b-instant` and `openai/gpt-oss-20b` as fallbacks, all via Groq —
were exercised only as a user of the deployed product, through its public
interfaces.

## Secrets

API keys and the database URL appear in this session because it has access to the
project. They are redacted by pattern; counts are in `redaction-log.md`. No
exchange was removed to hide a credential — only the credential values inside
otherwise intact messages.
