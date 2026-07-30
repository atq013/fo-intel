# Stage 2 — Implementation Roadmap

Derived from `STAGE2_SPEC.md` v0.2. Ordered to minimise rework and to have
something demonstrable at every checkpoint.

**Clock:** received 30 Jul 05:00 · deployed and scheduling required by end of
31 Jul · submission ~4 Aug 05:00.

---

## Ordering principle

Two things create rework in this project, and the plan is built around avoiding
both.

**Producing records before the claim/evidence contract is right.** Every record
written under a wrong contract is a record to rewrite. This is exactly how Stage 1
failed — 93 mis-wired values were cheap to create and expensive to find. So the
contract and its enforcing gate come before any collector.

**Deploying late.** The 48-hour operating window has to fit inside five days, and
the brief permits the record count to climb *while* the system runs. So the goal
for the first 36 hours is not a complete system — it is a **deployed system with a
correct contract that can climb unattended**. Breadth comes after.

Consequence: we deploy at roughly 60 records, not 500.

---

## Phase 0 · Reachability spike — **blocks everything**

**Why first.** D1 is the only decision that can invalidate the architecture. If no
channel mix projects ≥200 reachable at 500, we need to know before we build the
collectors, not after.

| | |
|---|---|
| Input | existing `data/candidates-*.json` — no new discovery |
| Sample | 60 firms, 10 per channel |
| Output | `data/spike-reachability.json` + a decision on source mix |
| Budget | 2 hours, hard stop |

**Deliverable:** the seven metrics per channel from spec §15 D1, and an
extrapolation to 500. Recorded whatever it says, including if it says the target
is not reachable.

**Exit criteria:** a written source-mix decision, or an explicit finding that ≥200
is not achievable with the channels available — which becomes a submission
disclosure rather than a silent shortfall.

---

## Phase 1 · The contract core

Nothing here touches a network. It is the model, the gate, and the tests that
prove both.

### Migrations

| ID | Contents | Notes |
|---|---|---|
| **M1** | `source`, `observation`, `extraction_event`, `entity`, `claim`, `evidence` | the contract. Includes the PTC-10 constraint as a DB-level check |
| **M2** | `validation_result`, `release_decision`, `contact`, `signal` | gates and specialised claims |
| **M3** | `run`, `decision_log` | operating record |
| **M4** | retrieval indexes, `pgvector` on the projection | deferred to Phase 4 |

Stage 1 tables are left in place, not dropped. New schema lives alongside. Cost is
a few unused tables; benefit is that nothing we do can break the Stage 1 artifact
they have already reviewed.

### Interfaces to fix now

These are the seams. Getting them wrong is the expensive mistake, so they are
written before any implementation.

```
Collector    : (source, cursor) -> AsyncIterable<Observation>
Extractor    : (observation, event) -> { claims: Claim[], evidence: Evidence[] }
Gate         : (claim, context) -> GateResult
ReleaseGate  : (claim, gateResults, policy) -> ReleaseDecision
EntityGate   : (entity, releasedClaims, policy) -> CommercialDecision
```

**The invariant the types must enforce:** `Extractor` is the only signature that
returns `Evidence`, and it only returns it alongside the claims from the same
event. No other module can construct an `establishing` evidence row — enforced by
not exporting the constructor.

### Gates, in build order

1. `attribution` — the centrepiece. Both evidence kinds (quoting, pointer).
2. `value_type` — person fields hold persons.
3. `schema`
4. `coherence` — record-level, composite fields from one source.
5. `contact_ownership`
6. Remainder in Phase 4.

### Tests — Stage 1's defects become the fixtures

This is the strongest test material available, because these are **measured
failures from a real system**, not invented cases:

| Fixture | Source | Must be caught by |
|---|---|---|
| Kopp street + postcode from one filing, city from another | real record | `coherence` |
| Duquesne street with the "Stanley Druckenmiller 7" quote | real record | `attribution` |
| Principal name whose quote names a different person | 2 real records | `attribution` |
| Company shipped as "Person with significant control" | 5 real records | `value_type` |
| `info@` as a principal's email | 3 real records | `contact_ownership` |
| Emerson Collective timestamp-as-phone | real record | `value_type` + `contact_ownership` |

**Exit criteria:** every fixture above is red before the gate exists and green
after. A gate that cannot turn a known Stage 1 defect red is not doing work.

**Demonstrable at this checkpoint:** a SQL query showing one entity with claims,
each carrying establishing evidence from its own extraction event, and a
`release_decision` row naming the gates that ran.

---

## Phase 2 · First collector end to end

One source, all the way through. Breadth is worthless until depth works once.

**Order:** Companies House first. It is the best-understood adapter from Stage 1,
its data is statutory, and it exercises every part of the contract — observation,
extraction, entity resolution, multiple claim types, and the coherence gate that
caught the Kopp defect.

Then migrate the Stage 1 fifty **through the new pipeline**, not by copying rows.
They must be re-derived from observations so they carry real extraction events.
Records that fail the corrected standard are reclassified or quarantined, not
patched.

**Expected outcome, and it will look like a regression:** the qualifying count
drops. Spec §15 U1 estimates the usable base may fall from 50 to nearer 25 once
`family_holding_company` and the commercial floor apply. That is the correction
landing, and the number gets reported honestly.

**Exit criteria:** ≥40 entities in the new schema with released claims; the
re-qualified Stage 1 count known and recorded.

---

## Phase 3 · Deploy and schedule — **the day-2 gate**

Everything before this is preparation; this is the checkpoint that cannot slip.

| Item | Detail |
|---|---|
| Scheduler | GitHub Actions, three workflows: `discover` /6h, `refresh` /12h offset, `contract` after each |
| Concurrency | bounded per source class; budget guard halts at 80% and records why |
| Idempotency | run ID, per-unit checkpoint, idempotent upserts, resume from last committed unit |
| Web app | reads released claims; enough UI to be a working link |
| Failure handling | circuit breaker per source, model chain fallback, dead-letter |

**Day-2 checkpoint email** goes out from here: deployed retrieval link, agent link,
scheduler screenshot, and the three one-line predictions the brief asks for
(what breaks first, cost per record and per 500, confidence on Goal 2 and where it
will abstain).

**Exit criteria:** two workflow runs visible in Actions history, triggered by
schedule not by hand, with rows in `run`. The 48-hour clock starts at the first
one.

---

## Phase 4 · Climb and build, while it runs

The system is now accumulating operating evidence on its own. This is the
lightest-touch phase by design.

**Track A — the climb (unattended).** Remaining collectors ship one at a time,
each behind the same contract. Order set by the Phase 0 spike, not by preference.
Watch the qualifying count and the reachable count separately.

**Track B — retrieval extension (spec §D4).** Multi-dimensional scored retrieval:
fit, evidence grade, freshness, classification confidence, reachability, in one
query, returning why each result matched and what is missing. Demonstrable on its
own URL — the brief asks for a link to the retrieval feature *and* the agent.

**Track C — agent (spec §8).** Tools over released claims only, each returning
`{data, scope, excluded, limits}`. The authority boundary is the deliverable, not
the planner: what it may decide, must abstain from, must refuse. The
constraint-preservation rule is enforced in control flow — the composer is blocked
from answering if the planner recorded an unhonoured constraint that was not
surfaced.

**Track D — evaluation (spec §11).** New case families targeting contact
ownership, evidence provenance, profile identity, constraint preservation,
headline counts, absence, whole-record coherence. Run against the deployed path.

**Exit criteria:** 500 qualifying, ≥200 reachable, both recomputed from the file;
agent answering all three goals; evaluation re-run after the last material change.

---

## Phase 5 · Operating window completes, then document

No building. The window closes when the logs show all three conditions:

- two scheduled runs ≥48h apart, unattended
- one real dependency failure met while running (induced if nothing breaks
  naturally, labelled as induced)
- a cross-run staleness event with an evidence-based reason

Then: the three goals with raw traces, architecture notes written against what the
system actually did, build summary, session record index, submission email.

---

## Milestones

| # | Milestone | Proves | Target |
|---|---|---|---|
| M0 | Spike complete, source mix decided | the 200 is reachable, or is not | 30 Jul evening |
| M1 | Contract + gates green on Stage 1 fixtures | the defect class is now impossible | 30 Jul late |
| M2 | Companies House end to end; Stage 1 re-qualified | the pipeline produces correct records | 31 Jul midday |
| M3 | **Deployed, scheduled, checkpoint email sent** | day-2 requirement met; 48h clock starts | **31 Jul EOD** |
| M4 | Retrieval extension live | a paying user has something new | 1–2 Aug |
| M5 | Agent answering all three goals | the agentic mandate | 2 Aug |
| M6 | 500 qualifying, ≥200 reachable | the hard minimums | 2–3 Aug |
| M7 | Operating window conditions met | the operating mandate | 3 Aug |
| M8 | Submitted | — | before 4 Aug 05:00 |

**M3 is the only one that cannot move.** If M6 is at risk, the system keeps
climbing while we document — the brief allows the count to be reached inside the
window. If M3 slips, the operating window does not fit and the stage fails on a
structural requirement rather than on quality.

---

## Deliverables mapped to phases

| Brief requirement | Produced in |
|---|---|
| Link to extended retrieval feature | Phase 4 Track B |
| Link to running agentic system | Phase 4 Track C |
| Repository, full history | throughout |
| Complete run logs for the window | Phases 3–5 (`run`, `decision_log`) |
| The 500 records with freshness/trust state | Phase 4 Track A |
| Three goals: outputs + raw traces | Phase 5 |
| Tool interfaces/schemas | Phase 4 Track C |
| Environment/setup instructions | Phase 5 (README update) |
| Build session summary | Phase 5 |
| AI working-session record + index | Phase 5 |
| Day-2 checkpoint email | **Phase 3** |

---

## What we are deliberately not building

Named so it is a decision rather than an omission, and so the submission can say
so plainly:

- **`relationship` graph.** Real intelligence, no Stage 2 requirement needs it.
- **Stored `retrieval_document` table.** Projection only — ADR-4.
- **Human-in-the-loop review UI.** Judgment enters through policy, not runtime
  intervention; the brief forbids intervention inside scheduled runs anyway.
- **Multi-tenancy, auth, billing.** Not assessed.
- **A third deployable for the agent.** ADR-1.
- **AUM and investment thesis as required fields.** Pursued opportunistically;
  most SFOs do not publish them and a fabricated band is worse than a blank.

---

## Risk register

| Risk | Impact | Mitigation | Owner |
|---|---|---|---|
| ≥200 reachable is not achievable | **fails the stage** | Phase 0 spike decides on day 1, before build | Attique |
| M3 slips past 31 Jul | operating window will not fit | Phases 0–2 are time-boxed; deploy at ~60 records | Attique |
| Re-qualification drops base below 25 | longer climb | measured in Phase 2, before the climb commits | — |
| Free-tier quotas exhaust mid-window | demo dark, as in Stage 1 | model chain, budget guard, exhaustion cached 30 min | — |
| No real change during the window | Goal 3 has no material | volatile class refreshed fastest; induced failure; if genuinely nothing moved, say so | — |
| Entity resolution ships duplicates | duplicates are disqualifying | resolution is a gate, not a heuristic; duplicates quarantine both | — |
| Climb stalls below 500 | fails a hard minimum | discovery runs unattended from M3; count watched daily | — |

---

## Immediate next action

**Phase 0.** Two hours, existing data, no new discovery. It either confirms the
source mix or tells us the reachability target needs renegotiating in the
submission — and either answer is worth more than starting the collectors on an
assumption.
