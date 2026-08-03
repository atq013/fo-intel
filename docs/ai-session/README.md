# AI working-session record

Deliverable 9. The complete record of AI use on this assessment.

## What is here

| file | size | what it is |
|---|---|---|
| `transcript-raw.jsonl` | 12.88 MB | the original session log, one JSON record per line, redacted and otherwise untouched |
| `transcript.md` | 3.27 MB | the same conversation, readable, grouped by day |
| `prompts.md` | 0.16 MB | every instruction given, quoted as entered |
| `redaction-log.md` | 0.00 MB | what was removed, by pattern, with counts |
| `SHA256SUMS` | — | hashes of the four files above |

Verify with `shasum -a 256 -c SHA256SUMS`.

## Coverage

**3330 messages**, 2026-07-30T09:09:51.439Z to 2026-08-03T18:28:14.868Z.

**The record begins with the first AI interaction concerning Stage 2**, at
2026-07-30T09:09:51.000Z — the message sharing the Stage 1 feedback and the Stage 2
Differentiator brief. Stage 1 ran in the same session, and its 1826
earlier records are excluded so that this record begins where the deliverable
says it must. The last Stage 1 message is 28 July at 19:54Z, so a 37-hour gap
precedes the boundary and the cut lands in silence rather than mid-thread.

That is a cut by **time**, at a stated boundary — not by content. Nothing inside
the Stage 2 period is removed. Failed attempts, defects I introduced and later
corrected, guards that misfired and were narrowed, and stretches where the
approach was simply wrong are all present in sequence. Several are load-bearing
in the build summary and architecture notes, and those documents were written to
match this record rather than the other way round.

Nothing was selectively removed. Failed attempts, defects I introduced and later
had to correct, guards that misfired and were narrowed, and stretches where the
approach was simply wrong are all present in sequence. Several are load-bearing
in the build summary and architecture notes, and those documents were written to
match this record rather than the other way round.

## Prompts given to the system's own models

`prompts.md` covers instructions given to the assistant. The prompts this system
sends to its own models live in the repository, because they are code and any
copy here would drift:

| prompt | file |
|---|---|
| agent planner | `packages/rag/src/agent/run.ts` — `PLAN_PROMPT` |
| answer composer | `packages/rag/src/agent/run.ts` — `COMPOSE_PROMPT` |
| Stage 1 answerer | `packages/rag/src/answer.ts` |
| grounding auditor | `packages/rag/src/llm.ts` — `verifyJson` |

Models used: `llama-3.3-70b-versatile` (primary), `llama-3.1-8b-instant` and
`openai/gpt-oss-20b` (fallbacks), all via Groq. Token counts and cost per run are
measured and recorded — see `packages/core/src/meter.ts` and the `cost` field on
every run in `exports/operating-window.json`.

## Secrets

API keys and the database URL were configured during these sessions and appear in
the raw log. They are redacted by pattern; the counts are in `redaction-log.md`.
No exchange was removed to hide a credential — only the credential values inside
otherwise intact messages.
