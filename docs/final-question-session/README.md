# Claude working-session record — the final question

The complete Claude record for the follow-up task: *find one substantive failure in the released
Stage 2 work that is not already in the false-statement register, fix it on a separate branch, and
submit the working sessions.* A separate Codex record is in
`docs/final-question-codex-session/`.

**This is not Stage 2 deliverable 9.** That record is `docs/ai-session/`, submitted earlier and
untouched by this work. The exporter that produced both files templates its own README for
deliverable 9, so the generated version of this file announced itself as such and described a
Stage 1 / Stage 2 boundary that does not exist in this session. It has been rewritten by hand to
describe what is actually here. `SHA256SUMS` covers the four data files and not this README, so the
rewrite does not affect verification.

## What is here

| file | what it is |
|---|---|
| `transcript-raw.jsonl` | the original session log, one JSON record per line, redacted and otherwise untouched |
| `transcript.md` | the same conversation, readable |
| `prompts.md` | every instruction given, quoted as entered |
| `redaction-log.md` | what was removed, by pattern, with counts |
| `SHA256SUMS` | hashes of the four files above |
| `README.generated.md` | current export statistics and the README the exporter would have written here |

Verify with `shasum -a 256 -c SHA256SUMS`.

**The filenames match `docs/ai-session/` and the contents do not** — same exporter, two different
sessions. Cite the directory, never the filename alone. The checksums differ, which is the quickest
way to tell them apart.

## Coverage

The current message and record counts are in `README.generated.md`, which the exporter rewrites on
every run; they are not repeated here, because a number copied by hand into a file the exporter does
not touch is a number that goes stale silently. The session opens at
**2026-08-13T12:59:01.737Z** with the first message of this task — *"hi, I want you to understand
this project and the product from top to bottom"* — and runs to the final verification of the fix.

`STAGE2_START=2026-08-13T00:00:00.000Z` was passed to the exporter as a floor earlier than the
session's own first record, so **nothing was cut**. The variable is named for its original purpose;
here it excludes zero records. This session is self-contained and no earlier conversation feeds it.

Nothing inside was removed. The dead ends are present in sequence and several are load-bearing:
two failure candidates that turned out to already be in the register, a validation rule that was
unsound on the real data and had to be rewritten twice, a first draft of the closure function that
would have written a false log line, and an assertion in a test that was wrong rather than the code
it tested. The submission describes that path rather than a tidied version of it.

## Redactions

Every redaction is one pattern: an environment assignment of a secret; the count is in
`redaction-log.md`. Each is a
`DATABASE_URL="$(…)"` invocation from the live-database verification. The variable name is preserved
and only the value replaced, so a reader can see which credential was configured without learning
it.

The connection string for the temporary Neon branch was deliberately never printed: it was written
to a gitignored file by the operator and read inline by each command. A separate scan over the
exported transcript finds **zero** postgres URLs carrying credentials. The branch hostname appears
seven times, from the checks confirming the target was not production; it is a hostname, not a
credential, and it belongs to a temporary branch that is retained for review and will be deleted
afterwards.

No message, turn or exchange was removed — only secret values inside otherwise intact messages.

## Assistant and tools

This directory contains one assistant and one continuous session: **Claude Opus 5, via Claude
Code**. Codex was used separately as an additional reviewer; its complete user-visible session is
preserved in `docs/final-question-codex-session/`. The tools used within the Claude session were
file reads and edits, shell commands, a local throwaway PostgreSQL cluster, and read-only HTTP calls
to the deployed product.

## Related records

| what | where |
|---|---|
| Stage 2 build session (deliverable 9) | `docs/ai-session/` — unmodified |
| Codex review session | `docs/final-question-codex-session/` |
| Verification of the fix against a live database | `docs/RUN_INTEGRITY_VERIFICATION.md` |
| The submission answering the final question | `docs/FINAL_QUESTION_SUBMISSION.md` |
| Unprocessed snapshot of this session | outside the repository, hash in the verification record |

## One limit

This export is point-in-time. It cannot contain messages that came after it, so the current message
and record counts in `README.generated.md` move with every re-run.

The exporter no longer overwrites this file. If `README.md` exists it is left alone and the templated
version is written to `README.generated.md` instead, so a re-export refreshes the data files and
leaves this correction standing. `SHA256SUMS` covers the four data files only.
