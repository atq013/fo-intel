# Run-integrity fix — Step 7 verification against a live database

**Branch:** `fix/orphaned-run-integrity` · **Date:** 15 August 2026 · **Status:** all checks passed

This file is new. It records how the fix was verified against a real database rather than a fixture,
including the parts that were simulated and the one place the test conditions were deliberately
shortened.

**What this branch does and does not touch.** `exports/operating-window.json`, `docs/goals/`,
`docs/ai-session/`, `SUBMISSION.md` and `docs/ACCEPTANCE_M3.md` are unmodified — the operating
export in particular is the artifact whose defects this work describes, and rewriting it would
destroy the evidence.

One submitted document **is** changed, deliberately: **`docs/ARCHITECTURE_NOTES.md`**. Architecture
Note 4 asserted that two run rows left in `running` were present in the exported log, and the export
contains none. A false statement in a scored deliverable cannot be left standing once it is known to
be false, so the sentence is corrected in place — quoted first, then what actually happened — rather
than deleted. That change exists **only on `fix/orphaned-run-integrity`**. The `main` branch, and
therefore the submitted and deployed state, is untouched.

The database used was a **temporary Neon branch created from production**, `stage2-sigkill-test`.
Production was never written to. **The branch still exists at the time of writing and has not been
deleted**, deliberately: it holds the two verification runs and every value quoted below, so they
can be checked at source rather than taken on trust. That check needs the connection string, which
appears nowhere in this file, in the repository, or in the session record — so it is available on
request, not self-service. The branch is to be deleted once that is no longer wanted.

---

## 1. What was being verified

A run whose process is killed by `SIGKILL` never reaches `finish()`, so its row stayed in `running`
with the counters at their schema default of `0`. Those rows were later closed by hand:

```
UPDATE s2_run SET status='aborted', ended_at=now() WHERE status='running'
```

`ended_at` means *the run stopped here*, and it was given the time of the cleanup.

**All seven `aborted` rows in the submitted export carry an administrative end time.** That follows
from the mechanism rather than from any timestamp: `finish()` is the only code path that writes
`ended_at`, it writes the counters in the same statement, and all seven still hold counters at the
schema default — so `finish()` never ran on any of them, and every one of those end times was
written by the cleanup.

**Three of the seven also show extreme spans**, where the cleanup ran long after the process died:
**43.9h, 50.1h and 74.0h**. The export holds **109** completed rows; across the **108** carrying log
lines the longest duration is **40 minutes**, and the 109th (`run_m1_demo`, no log lines, 0.1 min)
does not move that maximum. The other
four are closer to their last recorded activity, because the cleanup happened to be run sooner —
but they are administrative in exactly the same way. The gap size shows *when someone noticed*, not
whether the value was observed.

The counters stayed at zero throughout. `run_20260730191237_40bd4888` holds 43 log lines and 42
decisions, including a quarantine, above a row reporting `claimsQuarantined: 0`.

Step 7 asked one question: **does the fix hold against a real kill, on real data?**

---

## 2. Method, and what was synthetic

The database, the schema, the data, the process kill and every line of run-lifecycle code were real.
**The job body was not.**

`contract` had zero claims to evaluate on the branch, and `readjudicate-postal` — the only other
database-only job — never touches `run.counts`. No shipped job could exercise the counter path, so a
harness drove the real `withRun` instead:

| element | real or harness |
|---|---|
| Neon branch, schema, 741 entities, 319 pre-existing runs | real, copied from production |
| `withRun`, `startRun`, `log`, `checkpoint`, counter flush policy | real, imported unmodified |
| `closeOrphanedRuns`, the lifecycle audit, migration 007 | real |
| `SIGKILL` (`kill -9` on the OS process) | real |
| the loop incrementing the counters | **harness** |

This is the right target regardless: the defect and the fix both live in `runner.ts`, not in any
particular job. But the distinction is stated rather than glossed over.

The harness looped, incremented `run.counts`, logged every 25 units, and checkpointed once. Full
source is preserved with the session record.

---

## 3. Commands

Sanitized. The branch URL was held in a gitignored file and read inline, never printed:

```bash
# every command took this form; the value was never echoed
DATABASE_URL="$(grep '^DATABASE_URL=' .env.scratch.local | cut -d= -f2-)" npx tsx <target>
```

```bash
npx tsx packages/db/src/migrate2.ts                              # apply migrations 001-007
npx tsx <harness>                                                # start a killable run
kill -9 <pid>                                                    # real SIGKILL
CLOSE_ORPHANS_SILENCE_MIN=0.2 npx tsx packages/pipeline/src/jobs/close-orphaned-runs.ts
CLOSE_ORPHANS_APPLY=1 CLOSE_ORPHANS_SILENCE_MIN=0.2 npx tsx packages/pipeline/src/jobs/close-orphaned-runs.ts
npx tsx packages/pipeline/src/jobs/contract.ts                   # the audit, wired in
```

### The shortened threshold, stated plainly

`close-orphaned-runs` treats a run as dead after **30 minutes of silence** by default. That figure is
measured: across the 108 completed runs in the submitted export that carry log lines — the other
completed row, `run_m1_demo`, has none — the longest gap between
consecutive log lines is 1,036s (17.3 minutes) and the 95th percentile is 238s (4 minutes). Thirty
minutes is ~1.7x the worst case observed.

Waiting 30 minutes per test run was impractical, so `CLOSE_ORPHANS_SILENCE_MIN=0.2` (12 seconds) was
passed for these two invocations. **Only the threshold was shortened. No other behaviour changed**,
and the parameter is a documented environment variable rather than an edit. The default remains 30
minutes; the tests in `close-orphaned-runs.test.ts` assert that a 17-minute pause is never swept.

---

## 4. Migration over real historical rows

```
007_run_closure.sql  (12 statements)      0 failures
s2_* tables present: 14

closed_at              nullable=YES     (new)
close_reason           nullable=YES     (new)
records_touched        nullable=YES     (was NOT NULL DEFAULT 0)
claims_quarantined     nullable=YES     (was NOT NULL DEFAULT 0)
constraint             s2_run_outcome_times present, NOT VALID=true
historical rows        7 aborted, 7 still carrying ended_at  (preserved, unmodified)
new bad write          refused
```

The seven historical rows are **not repaired**. Correcting them would mean rewriting evidence that
has already been submitted. `NOT VALID` enforces every future write while leaving them exactly as
exported.

---

## 5. Run 1 — `run_20260815150951_39d94b41`

Killed at approximately unit 25, before the checkpoint. Tests the flush that hangs off `log()`.

Queried directly from the branch after the fact, not transcribed from console output:

```
id             run_20260815150951_39d94b41
job / trigger  contract / manual
started_at     2026-08-15T15:09:52.032Z
git_sha        30c291c        policy_version 2025-07-31.2
```

| stage | status | ended_at | closed_at | counters (touched/created/released/quarantined) | log lines | checkpoint |
|---|---|---|---|---|---|---|
| after `SIGKILL` | `running` | NULL | NULL | **25 / 50 / 0 / 2** | 2 | none |
| after dry run | `running` | NULL | NULL | 25 / 50 / 0 / 2 | 2 | none |
| after apply | `aborted` | **NULL** | `2026-08-15T15:10:54.726Z` | 25 / 50 / 0 / 2 | 3 | none |

Elapsed from `started_at` to `closed_at`: **62.7 seconds**. Under the pre-fix cleanup this row would
have carried an `ended_at` of `15:10:54.726Z` — presented as the moment the run stopped, when the
run had in fact gone silent at `15:09:59.312Z`, 55 seconds earlier.

**Under the old code the counters would read `0/0/0`.** That is the defect from
`run_20260730191237_40bd4888`, prevented rather than reproduced.

The dry-run row is the middle line: the default wrote nothing, confirmed by re-reading the row
rather than by trusting the report.

Recorded reason, verbatim:

> `no completion record; last activity 2026-08-15T15:09:59.312Z, silent for 0 minute(s) when the row
> was closed. The end time is unknown and is not recorded.`

It reports silence, not a cause of death. Nothing observable from a database row says why a process
stopped, and guessing would repeat the original error in a different field.

---

## 6. Run 2 — `run_20260815151111_53c4673f`

Checkpoint moved to unit 8 so it would fire before the kill. Tests the atomic cursor-plus-counters
write.

```
id             run_20260815151111_53c4673f
job / trigger  contract / manual
started_at     2026-08-15T15:11:13.451Z
git_sha        30c291c        policy_version 2025-07-31.2
```

| stage | status | ended_at | closed_at | counters (touched/created/released/quarantined) | log lines | checkpoint |
|---|---|---|---|---|---|---|
| after `SIGKILL` | `running` | NULL | NULL | **8 / 16 / 0 / 0** | 1 | `HARNESS-UNIT-8` units=8 |
| after apply | `aborted` | **NULL** | `2026-08-15T15:11:47.136Z` | 8 / 16 / 0 / 0 | 2 | `HARNESS-UNIT-8` units=8 |

Elapsed from `started_at` to `closed_at`: **33.7 seconds**.

Both rows carry the same recorded reason, differing only in the timestamp:

> `no completion record; last activity 2026-08-15T15:11:15.702Z, silent for 0 minute(s) when the row
> was closed. The end time is unknown and is not recorded.`

**One log line.** The progress log fires every 25 units and never ran, so those counters came
*solely* from the checkpoint's own write. The cursor and the counters agree exactly — 8 and 8 —
because they move in one statement or neither moves:

```sql
WITH counted AS (UPDATE s2_run SET records_touched = ... WHERE id = ... RETURNING id)
INSERT INTO s2_checkpoint (...) SELECT ..., counted.id FROM counted
ON CONFLICT (job, source_id) DO UPDATE SET ...
RETURNING id
```

If the run row is missing the CTE returns nothing, the insert inserts nothing, and the cursor does
not advance. A cursor that advanced past work whose count was never recorded would under-report
permanently, with nothing to indicate it.

---

## 7. The audit

Run against live state, then again through the real `contract` job:

```
runsAudited : 322
BLOCKING    : 0          (the job passes)
legacy      : 23 violations across 7 pre-fix runs
warnings    : 6

byRule: administrative_close_recorded_as_end  7
        orphan_closed_without_reason          7
        administrative_close_without_time     7
        counts_contradict_decisions           2
        no_work_recorded_despite_activity     6
```

The `contract` job completed with `run_lifecycle_audit` logged and `status: completed`.

Both new runs are dated after the legacy cutoff and were therefore **eligible to block**. They raise
nothing, because they are correctly closed. The seven historical rows are reported on every
execution and block none — a permanently red check is a check nobody reads, and those rows cannot be
repaired without altering submitted evidence.

### Defence in depth

An attempt to insert a post-cutoff row in the historical shape, to exercise the blocking path:

```
new bad row : refused by s2_run_outcome_times (never reaches the audit)
```

The audit is the second line of defence. The database is the first.

---

## 8. Test results

```
full suite   178 passing, 0 failing     (baseline before this branch: 127)
typecheck    clean
```

New tests: 26 lifecycle, 14 orphan closure including the revival race, 11 flush policy. The
lifecycle tests run against `exports/operating-window.json` **exactly as submitted**, read-only, and
assert both that the rules fire on the seven real rows and that they stay silent on all 109 runs
that completed normally.

---

## 9. Scope and honest limits

- **Not repaired:** the seven historical rows, deliberately. They remain as submitted.
- **Not repaired, disclosed:** two runs that *completed* normally report `recordsTouched: 0` while
  holding decisions, one of them 130. Those jobs never increment the counter. A real gap, a
  different one from the sweep, reported as a warning rather than folded in.
- **Unchanged:** `run_finished` is still written to stdout only and never reaches `s2_run_log`, so
  no run in the database carries a completion record. Left alone by instruction.
- **The recheck is one statement, not a lock.** Under `READ COMMITTED` a concurrent log insert
  committing at exactly the wrong moment could still let a just-revived run be closed. The
  consequence is recoverable — the row keeps its reason and nothing is deleted.
- **The job body was a harness**, per §2.
- The branch retains three rows from this exercise: two correctly-closed harness runs and one
  completed `contract` run.

---

## 10. The session records

Two continuous assistant work sessions contributed. The Claude implementation record and the Codex
review record are preserved separately, and neither overwrites a submitted artifact. Deployed Agent
probes used as product tests are preserved inline in those records.

**1. Claude formatted export — `docs/final-question-session/`**

```
docs/final-question-session/
  transcript-raw.jsonl             the original records, redacted, otherwise untouched
  transcript.md                    the same conversation, readable
  prompts.md                       every instruction given, quoted as entered
  redaction-log.md                 what was removed, by pattern, with counts
  SHA256SUMS                       hashes of the four files above
  README.md                        rewritten by hand — see below
```

**The filenames deliberately match `docs/ai-session/` and the contents do not.** Same exporter, two
different sessions: `docs/ai-session/transcript-raw.jsonl` is the Stage 2 build record submitted as
deliverable 9, and `docs/final-question-session/transcript-raw.jsonl` is this task. Always cite the
directory, never the filename alone. Their SHA256SUMS differ, which is the quickest way to tell them
apart.

`README.md` as generated was wrong for this session — the exporter templates it for deliverable 9,
so it announced itself as such and described a Stage 1/Stage 2 boundary that does not exist here. It
has been rewritten to describe this session accurately. `SHA256SUMS` covers the four data files and
not the README, so the rewrite does not invalidate it.

**Message and record counts are deliberately not quoted here.** They change with every re-export,
and a figure repeated across three documents is a figure that goes stale in two of them. The
authoritative numbers for any given export are in that export's own `README.generated.md` and
`redaction-log.md`.

What is stable is the *character* of the redactions: every one is an environment assignment of a
secret, the variable name preserved and only the value replaced. They are the `DATABASE_URL="$(…)"`
invocations from Step 7. Separately re-scanned afterwards: **zero** postgres URLs carrying
credentials anywhere in the export. The branch hostname appears in the checks that confirmed the
target was not production — a hostname, not a credential, carrying no password and granting no
access on its own — and it belongs to a temporary branch that still exists and will be deleted when
it is no longer needed for inspection.

**2. Claude unprocessed snapshot, outside the repository** — kept so the export can be checked against a
copy that no tooling has touched:

```
~/fo-intel-final-question-session/transcript-raw.snapshot-20260815T160119Z.jsonl
~/fo-intel-final-question-session/SHA256-20260815T160119Z.txt

sha256  4b2250ac995cd1d4bbcb8e0d73e3f992a34d76362d7868cde81057e9651fef8e
lines   1191 at time of snapshot
```

**3. Codex user-visible export — `docs/final-question-codex-session/`**

This continuous record begins at `2026-08-13T08:55:10.049Z`, the first Codex message concerning
Brian's Final Question. It contains every visible operator message, Codex response, tool call and
tool result in order, plus exact prompts, model/effort metadata, redaction log, hashes and a short
navigation index. Session metadata records `gpt-5.6-sol` with `xhigh` reasoning effort throughout.
Codex was an additional reviewer and did not implement the product fix.

### The footgun this exposed, and the fix

`export-ai-session.ts` hardcoded its output to `docs/ai-session/` — Stage 2 deliverable 9. Running
it for any later session would have overwritten a submitted artifact in place, silently, with no
copy of the original anywhere. On a script whose entire purpose is preserving a record faithfully,
that is the wrong default.

It now accepts `AI_SESSION_OUT`. The default is unchanged, so the original command still reproduces
the original deliverable. This export used:

```bash
AI_TRANSCRIPT=<this session's jsonl> \
STAGE2_START=2026-08-13T00:00:00.000Z \
AI_SESSION_OUT=../../../../docs/final-question-session/ \
npx tsx packages/pipeline/src/jobs/export-ai-session.ts
```

`docs/ai-session/` was checksummed before and after the run and is **byte-identical**; `git status`
on that directory is clean.

### One limit worth stating

All session exports are point-in-time. An export cannot contain messages that come after it. The
Claude export and the Codex export must each be run once more after their respective work stops;
those final runs supersede the provisional copies now present.
