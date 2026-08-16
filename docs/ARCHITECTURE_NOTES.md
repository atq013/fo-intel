# Architecture notes — Stage 2

Every claim names the artifact behind it. Where something is unimplemented, or a
number is weaker than it looks, that is stated. Counts as of
`exports/records.json`: **740 entities, 581 qualifying, 159 withheld**, 9,941
claims, 59,646 gate outcomes.

---

## 1 · Retrieval extension

Stage 1 answered questions about firms; it could not answer questions about
*evidence*. The extension is an evidence-aware shortlist
(`packages/db/src/shortlist.ts`) returning per record why it matched, what it
lacks, best source tier and last observation — plus `check_evidence`
(`agent/tools.ts`), exposing which gates ran, passed or were skipped under which
policy version. The new answerable question is *"what did you refuse to tell me,
and why?"*: Stage 1 could return a phone number but not say it was adjudicated as
reaching a named individual rather than a switchboard, which gate proved it, or
that 84 of 162 checks on that firm never ran.

**Rejected.** Semantic search — pgvector is in the schema, but with no mandate or
sector text to embed, similarity over 581 names ranks confidently over nothing;
the agent reports the limitation instead. LLM re-ranking, same reason. Web
enrichment for website/description/AUM, measured at 2–4% precision
(`docs/SPIKE_REACHABILITY.md`); those columns ship blank.

| Source | Strong enough for | Not strong enough for |
|---|---|---|
| Companies House | identity, incorporation, statutory control, service address, family-control classification | contact route to a person, mandate, AUM |
| SEC 13F | filer existence, signatory, address, **personal phone** | whether the filer is a family office |
| SEC ADV / IAPD | registered-adviser identity, Schedule A control persons | SFO status (Rule 202(a)(11)(G)-1 excludes them); no individual contact data |
| Verified profiles | a route to a named individual (assumption A1) | identity itself |

**Blind spots.** UK-weighted — most records from one registry, a poor sample of the
global market. No mandate, sector or AUM evidence anywhere, which is why Goal 2
abstains. 301 of 581 carry no classification and rest on a registered
family-wealth-vehicle name (`docs/INCLUSION_RUBRIC.md`, tier C).

**`strict` reachability is 54 against a requirement of 200 — the largest unmet
gap.** Stage 1 defined a confirmed contact route as direct phone or verified email
("10 of 50 for direct phone lines and 4 for email", holding postal separately as
"a slower contact route"), so `strict` is the metric measured. The ceiling belongs
to the sources: SEC 13F signature blocks are the only free statutory source
publishing a personal phone beside a named signatory and were exhausted across
four quarters (~30 family-office-named filers each, barely changing); the SEC
adviser roster gives main-office numbers, which the brief excludes as
switchboards; IAPD and Companies House publish no individual contact data; Hunter
needs domains this file lacks. The count could have been 68 by re-admitting eleven
hedge funds, a VC firm, a PE manager, a large RIA and a foundation carrying 13F
phones — refused, because a phone number is not evidence of being a family office.
Stage 1 measured the same tension from the other end: 9 family offices among 332
phone-carrying SEC firms.

## 2 · Agentic vs deterministic boundary

**The model decides two things**, both in `packages/rag/src/agent/run.ts`: *plan*
(which tools, what arguments, which parts of the question the dataset cannot
honour) and *compose* (turning results into prose). It chooses what to look up
and how to say it. It never decides what is true, what may be published, or what
anything is called.

| Under fixed control | Where | Why not a model |
|---|---|---|
| Six validation gates | `packages/pipeline/src/gates/` | A gate that can be argued with is not a gate. `skipped` never counts as `passed` (PTC-2). |
| Release decision | `packages/pipeline/src/release/gate.ts` | Single chokepoint; no `status` setter exported elsewhere. |
| Classification | `family_surname_control`, `gates/derivation.ts` | Re-run by the gate at validation time; a label it cannot reproduce does not release, including one upgraded to `multi_family_office`. |
| Firm names | `agent/names.ts` | Model emits `[[entityId]]`; server substitutes. It cannot misspell a firm into existence. |
| Every number | `agent/counts.ts` | Model emits `[[count:tool.field]]`; server substitutes. An unregistered token refuses the answer. |
| Output guards | `agent/claims-guard.ts` | §3. |

**Sequencing is control flow, not instruction.** The planner runs before any tool
and cannot know an `entityId` that only exists after a search — in production it
emitted the literal `<firm_id>`. Discovery tools now run first, ids are harvested
from results, and ID-dependent tools run afterwards with a real id or are skipped
and recorded as skipped.

---

## 3 · Authority boundary

**Decides alone:** which tools to call, ranking order, phrasing — subject to the
guards. **Must escalate:** any constraint the data cannot express; Goal 2's trace
records three and says so rather than inferring fit from a firm's name.

**Must refuse.** Seven deterministic guards in `agent/claims-guard.ts`, each
written against a real production failure preserved in `docs/goals/`: a relevance
score presented as confidence (*"Confidence scores are Colony Family Offices, LLC:
0.9993"*); tool internals in buyer prose (*"with 0 rows and 0 data"*); absence
asserted from a check that errored; a skipped gate reported as one that cleared
the record (*"checked 54 aspects... all passed or skipped"*, where 84 of 162 never
ran), plus citing passes without the skips; the answer quoting its own
instructions; a refusal claimed where nothing was refused (never-collected is not
withheld); and database vocabulary reaching the reader — `commercial state`, *"the
'missing' field"*, `requireProfileAssisted=true`.

Prompts are not the control: each is a branch in `run.ts` that replaces the
answer, with regression tests that fail when reverted. **Four of the seven needed
correcting after they shipped** — too permissive, then too aggressive, then
comparing against the wrong text, then firing on shared vocabulary. Each
correction came from production output, not review. The numeric guards have needed
none, which is the honest lesson: lexical rules over generated prose are the
fragile kind.

**Refusing correctly is not answering.** In one final run the agent blocked itself
for citing `check_evidence.gatesPassed` — a count the tool offered, whose name I
split without registering in `counts.ts`. The refusal was right; the cause was my
regression. Fixed, with a drift test asserting every numeric field resolves.

## 4 · State, replay, idempotency

**Storage:** `s2_run` (trigger, status, git sha, policy version, counts,
failures, cost), `s2_run_log`, `s2_decision_log` (staleness, quarantine, release,
budget — with before/after). Exported whole in `exports/operating-window.json`:
runs, log lines and decisions as exported, including failed and aborted runs.

**Replay.** Every claim binds to the extraction event that produced it, and its
establishing evidence binds to the *same* event via a composite FK on a generated
column (`001_contract.sql`, PTC-10). Evidence from a different reading cannot be
attached — the database refuses it, verified adversarially (`verify-ptc10.ts`,
6/6). So any value traces to the exact observation, URL, content hash and span;
that chain is what `exports/records.json` carries per value.

**Against duplication and corruption.** *Content hashing* — a matching re-read
writes nothing; a differing hash is the staleness signal, recorded with both
hashes. *Checkpoint after commit* (`004_checkpoints.sql`) — an interrupted run
resumes at the last completed unit, never past it. *Deterministic ids* — entity
ids derive from the registry number; upserts are `ON CONFLICT` no-ops.
*Assessment separated from identity* — `upsertEntity` writes identity only; it
previously wrote `commercial_state` from caller placeholders, resetting
qualifying records to `unassessed` on every re-touch.

**Not implemented.** There is no run-level transaction: a run interrupted mid-unit
leaves that unit partially applied at claim granularity. The checkpoint means it
is re-done rather than skipped — correct, but re-done, not rolled back.

**Corrected — the sentence that used to end this paragraph was false.** It read
*"A `SIGKILL` also leaves the run row in `running`; `withRun` closes on normal
failure, not on `SIGKILL`. Two such rows are in the exported log, not hidden."*
The first half is true. The second is not: `exports/operating-window.json`
contains **zero** rows in `running` — 118 runs, 109 completed, 7 aborted, 2
failed. The export's own header repeated the claim.

What actually happened is that the orphans were closed by hand. Three statements
in the submitted session record did it, twice with no reason recorded:

```
UPDATE s2_run SET status='aborted', ended_at=now() WHERE status='running'
```

`ended_at` means "the run stopped here", and it was given the time of the
cleanup. All seven carry an end time written that way: `finish()` writes the end
time and the counters in one statement, and all seven still hold the schema
default of 0, so it never ran on any of them. Three also show extreme spans —
**43.9h, 50.1h and 74.0h** against a 40-minute maximum across the 108 completed
runs carrying log lines (109 completed rows in all; `run_m1_demo` logs nothing
and lasted 0.1 min, so it does not move the maximum) — while the rest are closer
to their last activity only because the cleanup was run sooner. `run_20260730191237_40bd4888`
holds 43 log lines and 42 decisions including a quarantine, above a row reporting
`claimsQuarantined: 0`. `aborted` is a status no code path writes, which is how
each of these rows can be identified without inference.

**What the branch changes.** `007_run_closure.sql` adds `closed_at` and
`close_reason`, makes the four counters nullable so an unwritten one is not a
zero, and adds a per-status CHECK (`NOT VALID`, so the historical rows survive as
submitted) under which an `aborted` row may never carry an `ended_at`.
`closeOrphanedRuns()` replaces the hand-written statement — dry run by default,
never writing `ended_at`, recording silence rather than guessing a cause, and
rechecking liveness inside the same UPDATE. The counters are now written as work
commits, and a checkpoint and its counter flush move in one statement or neither
moves. `contract` audits every run row on every execution.

The seven historical rows are **not repaired**: correcting them would mean
rewriting evidence that has already been submitted. They are reported as legacy
violations on every audit and are excluded from blocking the job; any row written
after the fix blocks normally.

**Also disclosed, and not repaired here.** Two runs that *completed* normally
report `recordsTouched: 0` while holding decisions, one of them 130 — those jobs
never incremented the counter. It is a real gap and a different one from the
sweep; it is reported as a warning rather than folded into the above.

---

## 5 · Cost and latency

Measured, not estimated (`packages/core/src/meter.ts`): provider-returned token
counts and every external call by host, on success *and* failure — a run that
succeeded on its third attempt made three calls. Money is derived from a dated
rate card kept separate, so a stale price cannot corrupt a measurement.

| Goal | Model calls | Tokens | Tools | Wall | Est. cost |
|---|---|---|---|---|---|
| 1 · multi-step search | 2 | 5,509 | 4 | 2.7s | $0.0034 |
| 2 · uncertain data | 2 | 3,494 | 2 | 2.1s | $0.0022 |
| 3 · paid tier | 4 | 4,939 | 5 | 7.6s | $0.0030 |

**Per record**, from a 25-record refresh: 75 external calls (exactly 3/record),
45.0s external, 64.2s wall — ~2.6s and **no model calls**, extraction being
deterministic parsing. Refresh all 581: ~1,743 calls, ~25 min, **$0.00**.

**External cost is $0 — a result, not a gap.** Companies House and SEC EDGAR are
free; Neon and Vercel free tier; Serper inside its allowance. Call counts are
still recorded, because those are what rate limits bind on.

**Cacheable:** the shortlist behind the agent. **Downgradable:** the planner call,
structured extraction rather than reasoning. **Already deferred:** officers and PSC
are fetched only after the profile shows the company is not a shell — cut the
climb from ~4,400 calls to ~2,900.

**At 5,000 records, what breaks first: the shortlist query, at roughly 1,500–2,000
entities.** `shortlist()` is linear in *total* entities, not the page returned — it
fetches every entity with correlated subqueries, scores all of them in TypeScript,
then slices. Evidence: at 664 entities `limit: 1` took 803ms and `limit: 25`
1,293ms — the limit barely changes the cost, the signature of scoring before
slicing. Extrapolated, 5,000 entities is 6–10s per call, and the agent issues 2–4
per answer. Second, further out: `s2_validation_result` holds 59,646 rows for
9,941 claims, and `check_evidence` runs a `DISTINCT ON` lateral per claim. The fix
for both, not implemented: push filtering and ranking into SQL with an index on
`(commercial_state, strict_reachable)`, and materialise a per-entity summary.

## 6 · What broke while building

Beyond the three required goals: **a firm name where an id belongs** — planner
emitted `<firm_id>`, both dependent calls returned nothing, which reads as "this
firm has no data" → two-phase execution. **A count question** — reported page
size (10) as the match count (24) → `countNote` and server-resolved count tokens.
**A non-existent field** — empty success read as "nothing withheld" → fail closed,
repair, absence guard. **What-was-refused, for a firm with many skips** → split
gate counts, skipped-as-checked guard. **Goal 2 verbatim, four times** —
attempt-1 presented `0.9993` as confidence; the final run abstains and names all
three unhonourable constraints.

Non-agent defects caught by the system's own invariants rather than by tests:
zero-sentinel filters applied but undisclosed; `assessEntity` fed a batch instead
of the whole record (qualifying oscillated 206→104→184→218); 32 basis-less claims
caught by the `no_basis` invariant; a profile-slug substring match (`curti` ⊂
`curtis`); `OR` filtered as an English stopword; the `upsertEntity` reset above;
and **refresh's rotation, which never rotated — 543 of 546 records had never been
re-read once.**

---

## 7 · Commercial tier logic

**Tier and price.** Paid tier at **$2,000 per team per month, or $20,000
annually**, with an optional **$3,000 onboarding and custom-source setup** fee.

**Who pays.** A fund or placement agent running outbound to family offices, where
one mis-addressed approach costs more in reputation than a month of subscription.

**The gap.** Manual retrieval answers *who matches*; it cannot answer *what did you
refuse to tell me, and why*, which needs gate outcomes per value. The manual
equivalent of Goal 1 (`/api/shortlist?strict=1&tier=1&limit=25`) returns 54
records; the agent returns those plus an exact total, per-record evidence grading,
and an explicit statement that it matched a name substring rather than semantically.

**Why a buyer keeps paying.** Continuous refresh — sources are re-read on a
schedule and content hashes compared, so a changed record is re-derived rather
than left to rot; a one-time export is stale the week after purchase. Change
monitoring against a held position, because every value carries the hash it was
read at. Traceable agent workflows — each answer carries its full tool trace, so a
forwarded shortlist shows where each value came from. And reduced revalidation:
the evidence span, source tier and gate outcomes are the diligence a buyer would
otherwise redo. Refusals contribute to that trust — Goal 2 abstains rather than
ranking 581 firms on evidence it lacks — but they are a property of the product,
not the whole of its value.

**Not worth charging for yet.** Coverage. Most records come from one UK registry,
strict reachability is 54, 301 records carry no classification, and there is no
mandate or sector data. The price is set against evidence quality and freshness,
not record count.
