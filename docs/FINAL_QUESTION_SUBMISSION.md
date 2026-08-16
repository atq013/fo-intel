# Final question — submission

*Muhammad Attique Ur Rehman · 16 August 2026*

One substantive failure in the released Stage 2 work, not present in the false-statement register:
**the operating-window log records end times and work counts that the system never observed.**

**What can be checked, and from where.** The evidence sits in three places, and only the first is
in this repository:

| what | where it can be reproduced |
|---|---|
| The defect itself, the proof commands, the fix, the tests | the `fix/orphaned-run-integrity` branch. `exports/operating-window.json` and `docs/ai-session/` are on `main` too and unchanged, so the defect reproduces there as well |
| The novelty claim — that this is not already registered | **not in the repository.** It compares against `Attique_False_Statement_Register_v1.docx`, supplied with the final question, and `docs/review/PRODUCT_REVIEW.md`. The register has to be supplied to re-run that check |
| The live verification values in §3 | **not in the repository.** They are rows on the retained Neon branch `stage2-sigkill-test`, queryable with its connection string, which is deliberately not published. `docs/RUN_INTEGRITY_VERIFICATION.md` records them; the branch is kept so they can be checked at source rather than taken on trust |

The test results and every `jq` command below run offline from a clone of the branch. The other two
need something this repository does not contain, and saying otherwise would be the same kind of
overstatement this submission is about.

**`main` is untouched** — the submitted and deployed state is exactly as it was. The fix lives
entirely on `fix/orphaned-run-integrity`, nothing is merged, and no submitted data artifact is
rewritten anywhere: `exports/operating-window.json`, `docs/goals/`, `docs/ai-session/`,
`SUBMISSION.md` and `docs/ACCEPTANCE_M3.md` are byte-identical to `main`. The operating export in
particular is the evidence this finding is about, so rewriting it would destroy the thing being
reported.

One submitted **document** is changed, and only on the fix branch: **`docs/ARCHITECTURE_NOTES.md`**.
Architecture Note 4 states that two run rows left in `running` are present in the exported log, and
the export contains none. That sentence is false and is corrected there — quoted first, then what
actually happened — rather than deleted. On `main` it still reads as submitted.

---

## 1. How I searched

I looked first at the customer-facing pages — Search, Shortlist, the Agent — and several of the
candidates AI found and I skim through there overlapped the register (#8, #9, #31, #29, #15, and a live Agent
reproduction falling under #34), while one that did not — a prompt-length weakness on Search — I set
aside with the verification of Codex because the log failure was the stronger finding, not because it was a repeat. That pattern
was the signal: three passes had swept the front end and none had opened the released
operating-window logs, because they are a submitted file rather than a page. So I chose that area
and asked Claude to inspect the run rows against their own logs; it identified the specific
contradiction, and I then reproduced the released-artifact evidence listed in §2 myself before
selecting this as the finding to report.

## 2. The failure, and the proof

### As it appears

`exports/operating-window.json` is Stage 2 deliverable 4 — *the complete run logs for the entire
operating window*. It contains 118 runs. Seven are `aborted`, and all seven carry an `ended_at` that
nothing measured.

Three of them are visibly impossible:

| run | job | recorded duration |
|---|---|---|
| `run_20260731132340_912a6e93` | contract | **74.0 h** |
| `run_20260801122946_fb35e395` | discover | **50.1 h** |
| `run_20260801193042_3a9c5f03` | refresh | **43.9 h** |

There are **109** completed rows. Across the **108** of them that carry log lines the longest
duration is **40 minutes**; the 109th, `run_m1_demo`, logged nothing and lasted 0.1 minutes, so it
does not change that maximum either way.

The other four are administrative in exactly the same way; their gaps are smaller only because the
cleanup was run sooner. The gap size shows when someone noticed, not whether the value was observed.

All seven also report **zero work**. One of them, `run_20260730191237_40bd4888`, carries **43 log
lines and 42 decisions including a quarantine** — above a row saying `claimsQuarantined: 0`.

And `docs/ARCHITECTURE_NOTES.md`, a scored deliverable, said of that same file:

> *"Two such rows are in the exported log, not hidden."*

There are none.

### The proof

Every command in this section is read-only and runs from the repository root against files that are
committed. The register comparison further down needs an external file and is marked where it
appears.

**The file contradicts the Architecture Note.**

```bash
jq -r '[.runs[].status] | group_by(.) | map("\(length)\t\(.[0])") | .[]' exports/operating-window.json
```

`109 completed · 7 aborted · 2 failed` — **no `running` row exists**.

**The end times came from a bulk cleanup, not from the runs.**

```bash
jq -r '[.runs[].endedAt] | group_by(.) | map(select(length>1)) | .[] | "\(length) runs share endedAt \(.[0])"' exports/operating-window.json
```

Two clusters of three runs each, **identical to the millisecond**, across different jobs started on
different days. That pattern prompted the check; the submitted session record below contains the
bulk cleanup update that set them.

**The durations are impossible against the file's own baseline.**

```bash
jq -r '
  [.runs[] | select(.status=="completed" and ((.log // [])|length > 0))] as $runs |
  [$runs[] | ((.endedAt|sub("\\.[0-9]+Z$";"Z")|fromdateiso8601) - (.startedAt|sub("\\.[0-9]+Z$";"Z")|fromdateiso8601))] as $durations |
  "completed runs with log lines: \($runs|length); longest duration: \($durations|max/60|round) minutes"
' exports/operating-window.json
```

`completed runs with log lines: 108; longest duration: 40 minutes`.

**A row contradicts itself.**

```bash
jq -r '.runs[] | select(.runId=="run_20260730191237_40bd4888") | .decisions | group_by(.kind) | map("\(length) x \(.[0].kind)") | join(", ")' exports/operating-window.json
```

`41 x classify, 1 x quarantine` — in the run whose record says `claimsQuarantined: 0`.

**The mechanism is in the submitted session record**, so nothing here rests on inference:

```bash
grep -ohiE ".{200}status\s*=\s*'running'.{200}" docs/ai-session/transcript-raw.jsonl | sed 's/\\n/\n/g' | grep -iE "UPDATE s2_run" | sort -u
```

Three statements, two of which record no reason at all:

```sql
UPDATE s2_run SET status='aborted', ended_at=now() WHERE status='running'
UPDATE s2_run SET status='aborted', ended_at=now() WHERE status='running' AND job='discover'
```

The job-scoped one matches the all-`discover` cluster exactly. **Nothing was concealed** — the fix
was recorded at the time. The failure is that the log does not reflect what that record shows was
done to it.

**Why it is structural, not a coincidence.** `finish()` is the only code path that writes `ended_at`,
and it writes the four counters in the same statement. All seven rows still hold counters at the
schema default, so `finish()` never ran on any of them — therefore every one of those end times was
written by something else. `aborted` is a status **no code path writes**: `withRun` only ever calls
`finish('completed')` or `finish('failed')`, and the word appears in the codebase solely in the
vocabulary and a `CHECK` constraint.

```bash
git grep -n "aborted" main -- packages apps
```

Run against **`main`**, not this branch. `main` is the released code the finding is about, and it
returns exactly three hits: the vocabulary list, the `CHECK` constraint in `003_operating.sql`, and
the word inside the export's own note. **No call site passes it to `finish()`.** On
`fix/orphaned-run-integrity` the same grep also matches the new closure code, which is why the proof
has to name the branch it is asserted about.

### Why it matters more than a wrong number

The product does not sell family-office records; it sells the claim that you can inspect what the
system did, when, what it caught and what it refused. `/operations` exists for that. This is the one
file whose entire job is to be trustworthy, and it reported a `contract` run — which the acceptance
report says evaluates nothing until the policy version moves — as having run for three days.

The sharpest part: the run that **caught** something is logged as having caught nothing. `/operations`
tells a buyer *"the part worth paying for is not the records that passed, it is these — specific
defects caught before they reached a customer."* The one number proving that control fired is zeroed
on the run where it fired.

Everywhere else in this system, *"we don't know"* is kept apart from *"we checked."* Here, in the
file that must be trustworthy, unknown was written down as a number.

### Not in the register or the QA report

The register's 72 entries cover Stage 1 records, build traces, deployed statements, agent probes,
the review PDF, the README and the email. Its Stage 2 section is entirely about the **goal traces**.

```bash
pandoc -t plain "Attique_False_Statement_Register_v1.docx" \
  | grep -niE "run log|operating window|aborted|running|duration|endedAt|sigkill|withRun|sweep|s2_run"
grep -niE "aborted|sigkill|running|duration|endedAt|operating-window|run log" docs/review/PRODUCT_REVIEW.md
```

`Attique_False_Statement_Register_v1.docx` is the register supplied with the final question; it
lives outside the repository, so the path above is wherever you saved it.

Register: no output. QA report: two hits, both the ordinary word *"running"* in prose about the
scheduler. The nearest neighbours and why they differ:

- **E7** — *"a run that touched nothing is ambiguous."* E7's zero is **true and uninterpretable**;
  this one is **false**, contradicted three lines down in the same object. Different defect,
  different fix.
- **E9** — *missing* fields on a page. This is *wrong* data in a file.
- **E3** — two artifacts disagreeing with each other. This is one artifact disagreeing with itself.

## 3. The fix

**Branch: `fix/orphaned-run-integrity`** — off `main`, nothing merged, `main` untouched.

The root cause is that the schema could not express the honest answer. There was nowhere to record
when a row was closed, nowhere to say why, and the counters were `NOT NULL DEFAULT 0`, so *"we never
found out"* had to be written as a number.

| # | change | file |
|---|---|---|
| 1 | `closed_at` + `close_reason`; counters nullable; per-status `CHECK` (`NOT VALID`) | `packages/db/src/migrations/007_run_closure.sql` |
| 2 | the supported closure — dry-run by default, never writes `ended_at`, atomic liveness recheck | `packages/pipeline/src/run/close-orphaned-runs.ts` |
| 3 | counters written as work commits; checkpoint and counter flush in one statement | `packages/pipeline/src/run/runner.ts` |
| 4 | lifecycle rules + audit wired into `contract` | `run-lifecycle.ts`, `audit-run-lifecycle.ts`, `jobs/contract.ts` |
| 5 | exporter emits the new fields; its false self-description corrected; writes to a new path | `jobs/export-operating-window.ts` |
| 6 | `docs/ARCHITECTURE_NOTES.md` corrected in place, quoted rather than deleted | `docs/ARCHITECTURE_NOTES.md` |

The constraint is stated per status, so the historical shape is not merely discouraged but
unwritable:

```sql
CASE status
  WHEN 'running' THEN ended_at IS NULL AND closed_at IS NULL AND close_reason IS NULL
  WHEN 'aborted' THEN ended_at IS NULL AND closed_at IS NOT NULL
                      AND close_reason IS NOT NULL AND length(btrim(close_reason)) > 0
  ELSE                ended_at IS NOT NULL AND closed_at IS NULL AND close_reason IS NULL
END
```

`NOT VALID` on purpose: it binds every future write and leaves the seven historical rows exactly as
submitted. **They are not repaired.** Correcting them would mean rewriting evidence already
submitted. They are reported as legacy violations on every audit and block nothing; any row written
after the fix blocks normally.

### That it resolves the failure

Verified against a **temporary Neon branch copied from production**, `stage2-sigkill-test`.
Production was never written to. **The branch has not been deleted** — it is retained so the two
verification runs and every value below can be checked at source rather than taken on trust. That
check needs the connection string, which is deliberately unpublished, so it is available on request
rather than self-service. The branch will be deleted once it is no longer wanted. Full record:
`docs/RUN_INTEGRITY_VERIFICATION.md`.

A real `kill -9` on a real process against real data:

```
after SIGKILL   status: running   ended_at: NULL
                counters: touched=25  created=50  quarantined=2     ← would have been 0/0/0
after apply     status: aborted   ended_at: NULL   closed_at: set   counters unchanged
```

A second run, killed after its checkpoint, with **one** log line so the counters could only have come
from the checkpoint's own write:

```
checkpoint: HARNESS-UNIT-8  units=8     counters: touched=8
```

The cursor and the counters agree exactly, because they move in one statement or neither moves.

The audit, through the real `contract` job:

```
runsAudited: 322   blocking: 0   legacy: 23 across 7 pre-fix runs   warnings: 6
```

And an attempt to insert a post-cutoff row in the historical shape:

```
refused by s2_run_outcome_times (never reaches the audit)
```

```
full suite   178 passing, 0 failing   (baseline 127)
typecheck    clean
```

**Honest limits**, all recorded in the verification file: the job body driving the kill was a harness
because no shipped job could exercise the counter path — the run lifecycle itself is production code;
the closure threshold was shortened from 30 minutes to 12 seconds for the test via a documented
environment variable and nothing else changed; two runs that *completed* normally also under-report
their counters, which is a separate pre-existing gap reported as a warning; and `run_finished` still
never reaches the database, so no run carries a completion record.

## 4. The complete sessions

Two continuous assistant work sessions contributed and both are supplied separately. The deployed
product Agent was also queried as a test target; its prompts and responses appear in chronological
order inside these records rather than as a separate planning or coding session.

- `docs/final-question-session/` — the complete Claude session, from its first message on this task
  through the implementation and live verification. Raw JSONL, readable transcript, every
  instruction quoted as entered, redaction log and checksums.
- `docs/final-question-codex-session/` — the continuous Codex record beginning with the first Codex
  message about Brian's Final Question on 13 August. It contains every visible user message, Codex
  response, tool call and tool result in order, plus a short contribution index for navigation.

Message and record counts are not quoted in this document: they change with every re-export, and the
current figures live in that directory's own `README.generated.md`. `shasum -a 256 -c SHA256SUMS`
verifies the four data files.

The Claude record begins at **2026-08-13T12:59:01.737Z** with *"hi, I want you to understand this
project and the product from top to bottom"*. The Codex record begins at
**2026-08-13T08:55:10.049Z** with the message attaching `Final Question Attique.docx`. Each boundary
is the first message concerning this task in that session; nothing after either boundary is selected
out.

Every redaction is one pattern — an environment assignment of a secret, variable name preserved and
only the value replaced. They are the database URLs from the live verification, and the count is in
`redaction-log.md`. I separately re-ran a scan over the exported transcript afterwards: zero
postgres URLs carrying credentials anywhere in it.

The dead ends are present and are the honest part of the record: two failure candidates abandoned
because they matched the register, a validation rule that was unsound against real data and had to
be rewritten twice, a first draft of the closure function that would itself have written a false log
line, and a test assertion that was wrong rather than the code under it.

`docs/ai-session/` — the Stage 2 build record, deliverable 9 — is **unmodified**. It was checksummed
before and after this export and is byte-identical.

## 5. AIs, tools and sessions

Two external working assistants, two continuous sessions: **Claude Opus 5 via Claude Code**, and
**GPT-5.6 Sol (`gpt-5.6-sol`) via Codex Desktop with `xhigh` reasoning effort**. The deployed
Sightline Agent was tested from within those sessions; its inputs and outputs are preserved inline.

Tools captured within the records include file reads and edits, shell commands, a local throwaway
PostgreSQL cluster for schema testing (stopped and discarded afterwards), read-only HTTP calls to
the deployed product, and the temporary Neon branch for live verification, which is retained for
review.

**Where the boundary sat.** Stated precisely, because the register's largest cluster is work
attributed to the wrong author and I would rather be exact than flattering.

In its first reply, before I set any rules, Claude volunteered several findings of its own. I then
instructed Claude not to search for the failure and to let me find it; that instruction is in
`prompts.md`, timestamped.

**Mine.** Rejecting the front-end candidates that matched the register, then setting aside the novel
Search prompt-length lead when the log failure proved stronger. Choosing the operating-window logs
as the area to investigate, and directing Claude to inspect the run rows against their own logs.
Reproducing the released-artifact evidence manually afterwards — the status counts, the
millisecond-identical clusters, the 40-minute baseline, and the self-contradicting row. Deciding this
was the finding to submit. Directing the fix step by step and reviewing each stage before the next
began, including the corrections listed below.

**Claude's.** Identifying the specific failure inside that file — that the seven `aborted`
rows carry end times nothing observed and counters contradicted by their own decision logs — and
tracing it to `finish()` never running. Writing the migration, the closure function, the counter
persistence and the audit under that review. Producing the verification record.

**Codex's.** Acting as an additional reviewer: assessing earlier candidates, explaining the
operating-log issue after Claude found it, and separately re-running the final evidence, tests,
build, Neon queries and document checks. That review came after Claude's work and with sight of it,
so it is a second pass rather than an independent one. Codex did not discover or implement the
selected fix.

**Corrections I made to Claude's work**, all visible in the session: a validation rule that was unsound
against the real data and had to be rewritten twice; a constraint that still admitted the exact
defect it was written for; a first draft of the closure that would itself have written a false log
line; a test asserting on source text rather than behaviour; a claim that six rows were affected
when it was seven; and a statement that this branch touched no submitted artifact when it changes
`ARCHITECTURE_NOTES.md`.

I have not claimed either assistant's work as mine, and both records show the boundaries above.

---

## Index

| item | location |
|---|---|
| This submission | `docs/FINAL_QUESTION_SUBMISSION.md` |
| Live-database verification | `docs/RUN_INTEGRITY_VERIFICATION.md` |
| Claude session record | `docs/final-question-session/` |
| Codex session record | `docs/final-question-codex-session/` |
| Branch | `fix/orphaned-run-integrity` |
| Migration | `packages/db/src/migrations/007_run_closure.sql` |
| Closure | `packages/pipeline/src/run/close-orphaned-runs.ts` · `jobs/close-orphaned-runs.ts` |
| Counters | `packages/pipeline/src/run/runner.ts` · `run/count-flush.ts` |
| Rules and audit | `run/run-lifecycle.ts` · `run/audit-run-lifecycle.ts` · `jobs/contract.ts` |
| Corrected Architecture Note | `docs/ARCHITECTURE_NOTES.md` (branch only) |
