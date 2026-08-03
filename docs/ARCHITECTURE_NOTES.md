# Architecture notes — Stage 2

Every claim names the artifact behind it. Where something is unimplemented, or a
number is weaker than it looks, that is stated. Counts as of
`exports/records.json`: **740 entities, 581 qualifying, 159 withheld**, 9,941
claims, 59,646 gate outcomes.

---

## 1 · Retrieval extension

Stage 1 answered questions about firms; it could not answer questions about
*evidence*. The extension is an evidence-aware shortlist
(`packages/db/src/shortlist.ts`) returning per record why it matched, what a
buyer would want and it lacks (`missing`), best source tier, and last
observation — plus `check_evidence` (`packages/rag/src/agent/tools.ts`), which
exposes gate outcomes: which checks ran, passed, or were skipped, under which
policy version.

**New answerable question:** *"what did you refuse to tell me, and why?"* Stage 1
could return a phone number. It could not say the number was adjudicated as
reaching a named individual rather than a switchboard, which gate proved it
(`contact_ownership`), or that 84 of 162 checks on that firm never ran. A CSV
export cannot carry that.

**Rejected.** *Semantic search* — pgvector is in the schema, but with no mandate
or sector text to embed, similarity over 581 names produces confident ranking
over nothing. The agent reports the limitation instead: see `unhonoured` in
`docs/goals/final/goal-1-…json` — *"requires semantic similarity rather than a
name substring"*. *LLM re-ranking* — same reason; it would rank on the model's
prior, not the data. *Web enrichment* for `website`/`description`/`AUM` —
measured at 2–4% precision (`docs/SPIKE_REACHABILITY.md`); those columns ship
blank rather than plausible.

| Source | Strong enough for | Not strong enough for | Records |
|---|---|---|---|
| Companies House (profile/officers/PSC) | identity, incorporation, statutory control, service address, family-control classification | contact route to a person, mandate, AUM | 546 |
| SEC 13F | filer existence, signatory, cover-page address, phone | whether the filer is a family office at all | 85 |
| SEC ADV | registered-adviser identity, Schedule A decision-makers | SFO status — by law an SFO cannot appear here | 24 |
| Verified profiles | a route to a named individual (assumption A1) | identity itself; the slug must corroborate a name established elsewhere | 388 routes |

**Blind spots.** **UK-weighted** — 546 of 740 from one registry; a good source of
family-controlled entities, a poor sample of the global market, and the file's
largest weakness. **No mandate, sector or AUM evidence anywhere** — which is why
Goal 2 abstains. **`strict` reachability is 54 against a requirement of 200, and
this is the file's largest unmet gap.** Stage 1 defined a confirmed contact route
as a direct phone or verified email — its submission reports "10 of 50 for direct
phone lines and 4 for email" and holds a postal address separately as "a slower
contact route rather than no contact route" — so `strict` is the metric the
requirement is measured against, not `profileAssisted`.

Every source was tested and the ceiling is a property of the sources, not of the
effort:

| source | individual contact data | result |
|---|---|---|
| SEC 13F signature block | signatory name **and direct phone** | the only one that works; exhausted across four quarters, ~30 family-office-named filers per quarter and the set barely changes |
| SEC ADV roster (17,018 advisers) | main office telephone only | a switchboard, which the brief excludes by name |
| IAPD firm API | none — identity and address only | dead |
| Companies House | none | dead |
| Hunter.io | would need domains this file does not hold | 50 lookups/month, resetting after the deadline |

The count could have been 68. Eleven hedge funds, a VC firm, a PE manager, a large
RIA and a grantmaking foundation all carry 13F phone numbers and all qualified
under the earlier floor. They are withheld, because a phone number is not evidence
that a firm is a family office — and the shape of that trade is worth naming: the
firms most likely to publish a direct line are the ones least likely to be family
offices. Stage 1 measured the same thing from the other end, finding 9 family
offices among 332 phone-carrying SEC firms. **Classification covers 280 of
581**; the rest have no PSC individual, a corporate PSC, or a non-matching
surname, and are left blank.

---

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

**Decides alone:** which tools to call, ranking order, phrasing (subject to
guards). **Must escalate:** any constraint the data cannot express — Goal 2's
trace records three (*lower-middle-market*, *healthcare services*, *limited
partners*) and says so rather than inferring fit from a firm's name.

**Must refuse.** Seven deterministic guards, each written against a real
production failure preserved in `docs/goals/`:

1. **Relevance score as confidence** — attempt-1 wrote *"Confidence scores are
   Colony Family Offices, LLC: 0.9993"* for a question the dataset cannot answer.
2. **Tool internals in buyer-facing prose** — *"…with 0 rows and 0 data."*
3. **Absence from a failed check** — an invented field returned nothing and the
   agent concluded nothing was withheld. The tool now fails closed, the failed
   call is *repaired* in the trace, and an absence claim with no completed check
   behind it is blocked.
4. **A skipped gate as a check that cleared the record** — *"checked 54 aspects…
   all checks were either passed or skipped"*, where 84 of 162 never ran.
   `check_evidence` no longer returns a collapsible total, and citing the pass
   count without the skips is blocked too.
5. **The answer quoting its own instructions** — *"You MUST state this plainly in
   your answer, in the first two sentences"* reached a buyer. Caught as an
   eight-word overlap with the prompt that also carries its imperative voice.
6. **A refusal asserted where nothing was refused** — *"the evidence that was
   refused to be published includes the mandate, sector…"* for a firm with nine
   claims, all released, none quarantined, and no firm anywhere holding those
   fields. Never collected is not withheld.
7. **Database vocabulary in buyer-facing prose** — `commercial state`, *"the
   'missing' field"*, `requireProfileAssisted=true`. camelCase is not English.

Four of the seven needed correcting after they first shipped — too permissive,
then too aggressive, then comparing against the wrong text. Each correction came
from real production output rather than review, and each left a regression test.
The numeric guards (paired disclosure, count resolution) have needed none, which
is the honest lesson: lexical rules over generated prose are the fragile kind.

Prompts are not the control: each is a branch in `run.ts` that replaces the
answer, with regression tests that fail when reverted.

**Refusing correctly is not answering.** In the final Goal 3 run the agent blocked
itself for citing `check_evidence.gatesPassed` — a count the tool genuinely
offered, whose name I split without registering in `counts.ts`. The refusal was
right; the cause was my regression. Fixed, with a drift test asserting every
numeric field the tool exposes resolves.

---

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
is re-done rather than skipped — correct, but re-done, not rolled back. A
`SIGKILL` also leaves the run row in `running`; `withRun` closes on normal
failure, not on `SIGKILL`. Two such rows are in the exported log, not hidden.

---

## 5 · Cost and latency

Measured, not estimated (`packages/core/src/meter.ts`): provider-returned token
counts and every external call by host, on success *and* failure paths — a run
that succeeded on its third attempt made three calls. Money is derived from a
dated rate card kept separate, so a stale price cannot corrupt a measurement.

| Goal | Model calls | Tokens | Tools | Wall | Est. cost |
|---|---|---|---|---|---|
| 1 · multi-step search | 2 | 5,494 | 4 | 3.2s | $0.0034 |
| 2 · uncertain data | 2 | 3,533 | 2 | 2.2s | $0.0022 |
| 3 · paid tier | 4 | 4,668 | 5 | 7.8s | $0.0028 |

**Per record**, from a 25-record refresh: **75 external calls (exactly 3/record),
45.0s external, 64.2s wall** → 3 calls, ~2.6s per record, **no model calls**
(extraction is deterministic parsing). Refresh one record: 3 calls, ~2.6s, $0.00.
Refresh all 581: **~1,743 calls, ~26 min, $0.00**.

**External cost is $0 — a result, not a gap.** Companies House and SEC EDGAR are
free; Neon, Vercel free tier; Serper inside its allowance. Call counts are still
recorded, because those are what rate limits bind on.

**Cacheable:** the shortlist behind the agent — Goals 1 and 2 issue the same
unfiltered query and the data changes twice a day. **Downgradable:** the planner
call, which is structured extraction, not reasoning; the 8B model already serves
as fallback. **Deferred (already done):** officers and PSC are fetched only after
the profile shows the company is not a shell — cut the climb from ~4,400 calls to
~2,900. **Removable:** Goal 3's third `check_evidence` is a repair of a failed
call; fixing the planner's field vocabulary removes it.

**At 5,000 records, what breaks first: the shortlist query, at roughly
1,500–2,000 entities.** Component: `shortlist()` in `packages/db/src/shortlist.ts`.
Failure mode: linear in *total* entities, not in the page returned — it fetches
every entity with correlated subqueries, scores all of them in TypeScript, then
slices. Evidence: at 740 entities `limit: 1` takes **803ms** and `limit: 25`
takes **1,293ms** — the limit barely changes the cost, the signature of
scoring-before-slicing. Extrapolated, 5,000 entities is **6–10s per call**, past
interactive tolerance well before then, and the agent issues 2–4 per answer.

Second, further out: `s2_validation_result` is **51,798 rows for 8,633 claims**
(6.0/claim) → ~390,000 rows at 5,000 records, and `check_evidence` runs a
`DISTINCT ON` lateral per claim (247ms for one firm today). The fix for both, not
implemented: push filtering and ranking into SQL with an index on
`(commercial_state, strict_reachable)`, and materialise a per-entity summary.

---

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
annually**, with an optional **$3,000 onboarding and custom-source setup** fee for
buyers who want a registry or filing source added to the pipeline.

**Who pays.** A fund or placement agent running outbound to family offices, where
a wrong contact costs reputation rather than time, and where the cost of one
mis-addressed approach exceeds a month of subscription.

**The gap between manual retrieval and the agent.** Manual retrieval answers *who
matches*. It cannot answer *what did you refuse to tell me, and why* — that needs
gate outcomes per value, which a CSV cannot carry. From the final traces: the
manual equivalent of Goal 1 (`/api/shortlist?strict=1&tier=1&limit=25`) returns 54
records. The agent returns those plus an exact total, per-record evidence grading,
and an explicit statement that it could not honour "family office" semantically
and matched a name substring instead.

**Why a buyer keeps paying.** Four things, in the order they matter commercially:

1. **Continuous refresh.** Family office data decays — decision-makers move,
   sources go dark. The system re-reads its own sources on a schedule and
   compares content hashes, so a record that changed is re-derived rather than
   left to rot. A one-time export is stale the week after purchase.
2. **Change monitoring against a held position.** Because every value carries the
   content hash it was read from, "this changed" is a fact the system can state,
   not an inference the buyer has to make by re-checking manually.
3. **Traceable agent workflows.** Every answer carries its full tool trace —
   which tools ran, in what order, what each returned, what was refused. A buyer
   forwarding a shortlist internally can show where each value came from.
4. **Reduced revalidation.** The evidence span, source tier and gate outcomes per
   value are the work a diligent buyer would otherwise redo themselves. That is
   the labour the subscription displaces.

Refusals contribute to that trust — Goal 2 abstains rather than ranking 581 firms
for a healthcare mandate it has no evidence for — but they are a property of the
product, not the whole of its value.

**What it is not worth charging for yet, stated plainly.** Coverage. 546 of 740
records come from one UK registry, strict reachability is 54, and there is no
mandate or sector data at all. A buyer paying for *breadth* would be
disappointed, and the price above is set against evidence quality and freshness
rather than record count.
