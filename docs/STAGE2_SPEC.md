# Stage 2 — Technical Specification

Version 0.2 · **architecture draft, pending pre-build decisions** · owner: Muhammad Attique Ur Rehman

This is the specification we build from. It is not a description of what exists.
Anything here that turns out to be wrong gets amended here first, with the reason,
before the code changes.

---

## 0. What this system is

A family office intelligence platform whose product is **trustworthy claims**, not
answers. Every value a customer sees is a claim that survived a release gate, and
the evidence shown beside it is the evidence that established it.

Stage 1 promised that and did not deliver it. The measured failure: of 155
delivered values carrying a verbatim quote as evidence, **93 (60%) cite a quote
that does not contain or establish the value**. Root cause found at
`packages/pipeline/src/emit/build-dataset.ts:144` — a single line copying the
firm's *classification* evidence onto nine unrelated fields at assembly time.

That defect is the reason for most of the architecture below. The value was
correct; the binding between value and evidence was invented after the fact. The
fix is not a better validator. It is a data model in which that binding cannot be
created after the fact.

---

## 1. Architecture

### Deployables

| # | Deployable | Runs on | Responsibility |
|---|---|---|---|
| 1 | `pipeline` | GitHub Actions (scheduled) | discovery, enrichment, validation, release, refresh |
| 2 | `web` | Vercel | customer product, retrieval, agent runtime |

Postgres (Neon) is the only thing they share. The pipeline writes; the web app
reads **released claims only** and has no write path to claim state.

### Why two, not ten

Collection → normalization → resolution → validation → release is a sequential
pipeline over one database. None of those stages scales independently, fails
independently in a useful way, or has a separate owner. Splitting them into
services would add nine network failure modes and a distributed release gate in
exchange for nothing at 500 records.

Boundaries are enforced as **modules with explicit interfaces**, so any stage can
be extracted later without redesign.

### Why the agent is not a third deployable

It needs the same released-claim reader and the same refusal boundary as
retrieval. A separate deployment adds a second thing that can be down when the
system is tested, and buys no isolation that matters — the authority boundary is
enforced in the tool interface, not by process separation.

### Module map

```
packages/
  core/          claim, evidence, source, status vocabulary, truth contract types
  db/            schema, migrations, released-claim reader, claim writer
  collect/       source adapters. one per source class. produce Observations only.
  extract/       Observation -> Claim + Evidence. the ONLY place evidence is created.
  resolve/        entity resolution, duplicate detection, cross-source conflict
  validate/      the gate battery. pure functions over claims. no I/O to sources.
  release/       the single chokepoint. claim trust + entity commercial state.
  refresh/       re-observation, decay detection, trust reduction
  contract/      Product Truth Contract as executable assertions
  agent/         tools, planner, authority boundary
apps/
  web/           product UI, retrieval API, agent route
```

---

## 2. Data model

### Principle

> A claim and the evidence that established it are produced by one act of reading
> one observation, share an immutable `extraction_event_id`, and are written in one
> transaction. Establishing evidence cannot be attached afterwards, by any code
> path.

This is the structural fix for the Stage 1 defect. `build-dataset.ts:144` was only
possible because evidence was a field you could assign. Here the binding is an
identity relationship the database can verify, not a convention the writer is
trusted to follow.

### Tables

**`source`** — a source *class* instance we can fetch from.
`id, kind, identifier, base_url, tier, rate_limit_per_min, last_ok_at, consecutive_failures`

`kind` ∈ `sec_submissions | sec_13f | sec_fulltext | companies_house | web_page | search_result`
`tier` ∈ `1 statutory/self | 2 press | 3 aggregator | 4 unranked` (carried from Stage 1, it worked)

**`observation`** — what a source returned, at a time. Immutable.
`id, source_id, url, fetched_at, content_hash, raw_ref, http_status, notes`

Raw bodies go to disk/object storage keyed by `content_hash`; the row holds the
pointer. Two fetches returning identical content share a hash — that is how decay
is detected in §7.

**`entity`** — a firm.
`id, canonical_name, entity_type, first_seen_at, merged_into_id, trust_state, commercial_state`

`trust_state` ∈ `active | merged | quarantined | retired`
`commercial_state` ∈ `qualifying | withheld | unassessed`

An entity enters customer retrieval only when `trust_state = active` **and**
`commercial_state = qualifying`. Splitting these is deliberate: a firm can be
entirely trustworthy and still too thin to sell, and the two failures need
different remedies — one needs better evidence, the other needs more enrichment.

**`claim`** — one assertion about one entity.
`id, entity_id, field, value_json, value_type, status, confidence, refresh_policy, established_at, expires_at, superseded_by_id`

`status` ∈ `candidate | validated | released | stale | quarantined | retired`

Note: there is no `withheld` claim status. Commercial sufficiency is judged on the
entity, not the claim — see §5.

**`extraction_event`** — one act of reading a source and deriving assertions.
`id, run_id, observation_id, extractor, started_at, ended_at`

Every claim and its establishing evidence are written inside one extraction event,
in one transaction. This is the identity relationship that makes the Stage 1
defect unexpressible — see PTC-10.

**`evidence`** — why we believe a claim.
`id, claim_id, observation_id, extraction_event_id, role, span_text, span_start, span_end, method, created_at`

`role` ∈ `establishing | corroborating | conflicting | superseding`

- **establishing** — the span the extractor actually read to derive this value.
  Exactly one per claim. Written in the claim's own extraction event. Never
  attachable afterwards.
- **corroborating** — an independent source later found to agree. May be attached
  after the fact, raises confidence, **cannot** promote status on its own.
- **conflicting** — an independent source that disagrees. Attaching one is a
  trust event and routes the claim to gate 7.
- **superseding** — a later observation that replaces the value. Creates a *new*
  claim in a new extraction event; the old claim is retired, not edited.

`span_text` is the exact text read. `method` is the human sentence shown to a
customer. There is **no generic attach-evidence API**: the writer takes a role and
refuses `establishing` outside an open extraction event.

**`validation_result`** — one row per gate per claim per run.
`id, claim_id, run_id, gate, outcome, detail, counterfactual`

`counterfactual` records what the claim *would have been* had the gate not fired.
That is what proves a validator is load-bearing rather than decorative.

**`release_decision`** — the audit trail of the chokepoint.
`id, claim_id, run_id, decision, gates_passed, gates_failed, policy_version, decided_at`

**`contact`** — specialised claim, because reachability is a hard bar.
`id, entity_id, person_claim_id, channel, value, reaches, ownership_evidence_id, verification_method, verified_at, status`

`reaches` ∈ `individual | team | company | unknown` — **never inferred, always evidenced**
`channel` ∈ `email | phone | linkedin | postal`

A contact counts toward the reachability bar only when `reaches = individual` and
`ownership_evidence_id` is non-null.

**`signal`** — dated activity. Append-only, never re-verified.
`id, entity_id, kind, summary, occurred_at, evidence_id, source_tier`

**`run`** — one scheduled execution.
`id, trigger, started_at, ended_at, job, records_touched, claims_created, claims_released, claims_quarantined, failures_json, cost_json, status`

**`decision_log`** — every consequential decision, one row.
`id, run_id, entity_id, claim_id, kind, rule, before_json, after_json, reason, at`

### Deferred

`relationship` and `retrieval_document`. The first is real intelligence but no
Stage 2 requirement needs it. The second must be a **projection built at index
time from released claims**, never a stored table — a stored copy drifts from its
claims, and a drifted chunk enters retrieval, passes every downstream check, and
misleads the customer. That is exactly the failure mode Correction 7 describes.

---

## 3. Claim lifecycle

```
                 extract
  observation ─────────────► candidate
                                 │
                          validate battery
                                 │
                    ┌────────────┴────────────┐
                    ▼                         ▼
               validated                 quarantined
                    │                    (evidence problem)
              release gate
                    │
                    ▼
                released ──── refresh cycle ────► stale ──► re-extract
                    │                                          │
                    └──────── superseded ◄─────────────────────┘
```

**Rules**

- A claim may only move to `released` through `release/gate.ts`. One function. All
  other write paths are compile-time prevented by not exporting a setter.
- **Trust is claim-level. Commercial sufficiency is record-level.** A claim that
  passes its trust gates is `released` and stays valid even if the record it
  belongs to is not yet commercially complete. `withheld` is therefore *not* a
  claim status — it is an **entity** state (§5).
- A superseded claim is retained, not deleted. Retraction history is product value
  and is required for the staleness evidence.

---

## 4. Validation pipeline

Gates run in two bands.

**Band A — cheap, deterministic (gates 1–6 where they need no network).** All of
them run, always, and every outcome is recorded even after one fails. Stopping at
the first failure saves compute and costs diagnosis: you fix one defect, re-run
500 records, and discover the second. At this volume the compute is trivial and
the round trip is not.

**Band B — expensive or probabilistic (pointer resolution, conflict adjudication,
commercial scoring).** Skipped once Band A has already made release impossible,
and the skip is recorded as `skipped: release already blocked` rather than as a
pass. A gate that did not run never counts as a gate that passed — that is PTC-2.

| # | Gate | Question | Catches (Stage 1 evidence) |
|---|---|---|---|
| 1 | `schema` | right shape, right type? | — |
| 2 | `attribution` | does the cited span contain or establish this value? | the 93 mis-wired values |
| 3 | `value_type` | does a person field hold a person? | 5 companies shipped as "Person with significant control" |
| 4 | `identity` | is this the entity we think, not a namesake? | 2 LinkedIn profiles belonging to different people |
| 5 | `contact_ownership` | does this route demonstrably reach the named individual? | 3 `info@` inboxes as principal email |
| 6 | `coherence` | is the record true as a whole, one source per composite? | Kopp address assembled from two filings |
| 7 | `conflict` | do sources disagree? which wins, at what confidence? | classification badge over a 3-way-described firm |
| 8 | `freshness` | is this within its refresh policy? | 25 records with no dated signal |
| 9 | `commercial` | does the record help decide whom to approach and why now? | no AUM/sector/thesis anywhere |
| 10 | `copy` | does every rendered sentence check its own precondition? | "reachable at the registered address above" on 10 cards with no address |

**Gate 2 is the centrepiece.** It is the same lexical test Stage 1 applied to
generated answers, now pointed at the dataset — which is exactly what Correction 2
demands. Two evidence kinds are scored differently:

- **quoting evidence** — the span must contain the value's hard tokens (numbers,
  dates, proper nouns) and reach 60% content-word coverage
- **pointer evidence** — the span names a record locator (company number, CIK,
  accession). Passes only if the locator resolves and the pointed-at record
  contains the value. Slower; runs asynchronously and downgrades on failure.

**Gate 10 is unusual and deliberate.** Interface copy is data. Every fixed
sentence in the UI registers a precondition; the gate asserts the precondition is
checked before render. Correction 8 says user-visible sentences are held to the
same truth standard as values, and almost nothing in the industry tests this.

---

## 5. Release gate

```ts
// release/gate.ts — the only path to released state
releaseDecision(claim, evidence, gateResults, policy) -> Decision
```

**Two independent questions at two different levels**, per Correction 4:

1. **Is this claim trustworthy?** Gates 1–8, per claim. Failure → claim
   `quarantined`, reason recorded. Passing claims are `released` and remain valid
   regardless of what the rest of the record looks like.
2. **Is this entity commercially sufficient?** Gate 9, per entity, over its
   released claims. Failure → `commercial_state = withheld`. The claims stay
   released and true; the entity does not enter customer retrieval and does not
   count toward the 500.

The separation matters operationally: a withheld entity is a **work item for
enrichment**, not a data-quality problem. Conflating the two would send us hunting
for evidence defects in records whose only fault is thinness.

A record is *counted toward the 500* only when it holds a released identity claim,
a released classification claim with function evidence (§9), and passes the
record-level commercial floor.

**Policy is versioned data, not code.** `policy_version` on every decision. When
the standard tightens, previously released claims are re-evaluated on the next run
and can be demoted. This is what makes release a pipeline rather than a boolean.

**Invariant:** no released claim exists without a `release_decision` row naming the
gates that ran. A claim in released state with no decision row is a bug that fails
the build.

---

## 6. Product Truth Contract — executable

Not a document. A test suite that runs in CI and at release, and **fails the build**.

`contract/rules.ts` exports one function per clause, each returning
`{ pass, violations[] }` over the released dataset and the rendered interface.

| ID | Clause | Assertion |
|---|---|---|
| PTC-1 | No claim without evidence | every released claim has ≥1 evidence row passing gate 2 |
| PTC-2 | No status without a check | status vocabulary is closed; each status names the gate granting it; assert no claim carries a status whose gate never ran on it |
| PTC-3 | Contacts state who they reach | no contact labelled `individual` without `ownership_evidence_id` |
| PTC-4 | Labels match state | every rendered string has a registered precondition, checked before render |
| PTC-5 | Records coherent whole | gate 6 passed at record level, not only field level |
| PTC-6 | Counts are computed | every displayed number derives from released data at render time; no constants |
| PTC-7 | Absence ≠ failure | "looked, found nothing" and "could not look" are distinct states with distinct copy |
| PTC-8 | Refresh policy declared | every released claim names its policy and `expires_at` |
| PTC-9 | No label upgrade | a value's presented term is derived from its status, never chosen for tone |
| PTC-10 | Evidence is bound at extraction | every released claim has exactly one `establishing` evidence row sharing its `extraction_event_id`; no `establishing` row exists whose extraction event differs from its claim's |

PTC-10 is the regression test for the Stage 1 defect, and it is an **identity**
invariant rather than a temporal one. An earlier draft asserted that evidence must
not be created after its claim, tested on timestamps. That was weak: clock skew,
batched inserts inside the same millisecond, and back-dated writes all defeat it,
and it does not actually prevent post-hoc attachment — it only makes some cases
detectable.

Sharing an `extraction_event_id` is structural. The claim and the span that
established it were produced by one act of reading one observation, and the
database can prove it. Corroborating and conflicting evidence attach later by
design, carry a different role, and cannot promote a claim on their own.

**The contract's pass rate is published in the product**, with failures visible.
The differentiator is not "we verify our data" — it is "here are ten assertions
our data must satisfy, here is today's score, here is what failed."

---

## 7. Scheduler and operating model

**Platform: GitHub Actions.** Keeps its own run history, screenshot-able,
free, and the history is independently inspectable — which the brief requires.

### Jobs

| Job | Cadence | Does |
|---|---|---|
| `discover` | every 6h | climb toward 500: new candidates, extract, validate, release |
| `refresh` | every 12h, offset | re-observe released claims past `expires_at`, detect decay |
| `contract` | after each | run the PTC suite, write results, demote violators |

**Concurrency and budget** — the brief scores this explicitly.

- Per-run token budget, checked before each model call; run halts cleanly at 80%
  and records why rather than dying mid-record
- Per-source rate limits from the `source` table; a source returning 429 or 5xx
  three times consecutively opens a circuit breaker and is skipped for the run
- Work queue with bounded concurrency per source class (SEC 4, Companies House 2,
  web 8 — carried from Stage 1 where these were tuned against real limits)
- Every unit of work is idempotent and checkpointed: a run interrupted at record
  300 resumes at 300, and re-running a completed unit is a no-op

### Staleness — evidence-based, not clock-based

The brief is explicit that clock expiry alone does not satisfy the requirement.
Mechanism:

1. `refresh` re-fetches the observation behind a released claim
2. Compares `content_hash` to the stored one
3. **Unchanged** → bump `last_reverified_at`, claim stays released
4. **Changed** → re-extract; if the value differs, the old claim is superseded and
   the new one enters validation; the decision log records *what changed*
5. **Source dark** (404/410/persistent 5xx) → trust reduced, claim → `stale`,
   reason `source no longer reachable at T`
6. **Contradiction** → claim → `quarantined`, both observations retained

Only paths 4–6 count as the required staleness event, because only they carry an
evidence-based reason.

---

## 8. Agent decision boundaries

### Tools

| Tool | Reads | Cannot |
|---|---|---|
| `search_firms` | released claims only | see candidate, quarantined, withheld |
| `get_firm` | one entity's released claims + evidence | fabricate absent fields |
| `compare_firms` | released claims across entities | rank on a metric no claim holds |
| `check_evidence` | evidence + validation results | assert beyond the gate outcome |
| `count_matching` | released claims | estimate |

Every tool returns `{ data, scope, excluded, limits }`. **Scope is mandatory** —
what was searched, what matched, what was excluded and why. That is how the agent
can state scope in its answer, which Correction 8 requires everywhere.

### Authority

**May decide alone:** how to decompose a goal, which tools and in what order, when
it has enough, how to structure output, when to stop.

**Must abstain, with reason:** any claim not backed by released data; any ranking
where no claim holds the metric; any confidence assertion where evidence is thin
or conflicting; any contact characterisation beyond the `reaches` value.

**Must refuse:** naming a firm not in the dataset, upgrading a label (company
inbox → principal email, one dated investment → standing mandate, "not found" →
"does not exist"), answering a narrower question than asked without saying so.

That last one is the Stage 1 live failure: asked for principal-owned contact
routes excluding inboxes, the system answered "firms with any populated contact
field" and never said it had narrowed the question. **A constraint the system
cannot honour must be declined or explicitly narrowed in the answer, in plain
words.** This is enforced in control flow: the planner records the constraints it
could not honour, and the composer must surface them or the answer is blocked.

### Deliberately not agentic

Extraction, validation, release, and refresh are **fixed pipelines with no model
deciding control flow**. A model that can decide whether a claim is released can
decide to release a bad one. The model's role there is bounded extraction inside a
step whose output is mechanically checked. Architecture Note 2 asks what we kept
under fixed control and why — this is the answer.

---

## 9. Entity classification — function, not ownership

Correction 3: family ownership proves control, not that the firm *operates* as a
family office.

**Categories** — each requires affirmative evidence of the named kind:

| Category | Requires |
|---|---|
| `single_family_office` | evidence of managing one family's wealth/investments as its purpose |
| `multi_family_office` | evidence of serving multiple unrelated families as clients |
| `family_holding_company` | family control evidenced, **no** evidence of wealth-management function |
| `adviser_or_wealth_manager` | excluded |
| `unconfirmed` | does not count |

`family_holding_company` is a new category and exists because Stage 1's SFO-1 rule
(surname match + PSC + substance) proves exactly that and no more. Twenty of the
fifty qualified under it. Under this spec those records **do not count as family
offices** until function evidence is found — and the honest ones will be
reclassified rather than relabelled.

**Function evidence** examples, in tier order: the firm describing its own purpose;
a statutory filing stating it manages family capital; a filing describing a pooled
vehicle for a single family (the Piton case in Stage 1 — the strongest evidence in
the whole file); credible press describing the function.

---

## 10. Logging

Three streams, three purposes.

**`run`** — one row per scheduled execution. Proves the operating window. Permanent.

**`decision_log`** — every consequential decision with rule, before, after, reason.
Includes the counterfactual on rejection. **This is the log that earns credit**,
because a control earns credit when it changes what the system may do.

**Agent trace** — per goal: action sequence, tool calls with arguments and returns,
intermediate decisions, retries, rejected paths, abstentions. JSON, raw,
submitted unedited for the three goals.

Not logged: per-request debug noise. Raw enough to see what happened, quiet enough
that the signal is findable.

---

## 11. Evaluation

Stage 1's suite measured the layer we were confident in. Stage 2 attacks the
surfaces where the live failures actually were.

**Retained:** the 15 grounding cases, re-run against the deployed system after any
material change. Stage 1 shipped numbers from a system that no longer existed;
that does not repeat.

**New case families, one per known failure class:**

| Family | Probes |
|---|---|
| contact ownership | "email addresses that reach the named principal, not company inboxes" — must return only `reaches=individual` and state the count |
| evidence provenance | "show me the evidence for X's address" — the panel must prove the value above it |
| profile identity | LinkedIn/profile links belong to the named person |
| constraint preservation | a request with three constraints the system can only honour two of — must narrow explicitly |
| headline counts | every displayed number recomputes from the file |
| absence | ask for a firm not present — plain business answer, no machinery description |
| whole-record coherence | ask for the address of the record with the known assembly defect |

**Rule:** a measured result must change what ships, or the notes must defend from
evidence why it did not.

---

## 12. UI architecture

Not a chat box with cards. A workspace.

**Search** → filters on commercially meaningful criteria (type, geography, mandate
signals, contact reachability, evidence grade, freshness), each stating why a
result matched.

**Results** → sortable, comparable without opening each record. Trust grade and
freshness visible in the row, not buried.

**Compare** → selected firms side by side, fields aligned, differences and gaps
explicit.

**Record** → claims with status, evidence inspectable inline, contact routes
labelled with who they reach, signals dated, conflicts shown rather than resolved
silently.

**Trust surface** → the PTC pass rate, what failed, what it means. This is the
product's differentiator made visible.

**Absence and failure states** → business language, no machinery. "We hold no
mandate evidence for these firms; here is what we do hold" — not "the retrieval
returned no matching chunks."

Every string registers a precondition (PTC-4). A sentence that can be false is a
defect of the same severity as a wrong value.

---

## 13. Failure handling

| Failure | Response |
|---|---|
| source 429 / 5xx | exponential backoff; 3 consecutive → circuit breaker, skip for run, log |
| source blocks / 403 | mark source degraded, record in run log, continue with others |
| model malformed output | retry once; then fall back down the model chain; then abstain and record |
| model quota exhausted | remembered for 30 min, chain advances, run continues (Stage 1 lesson: both Llama models hit daily ceilings and the demo went dark) |
| entity unresolvable | quarantine, do not guess, replenish from discovery |
| run interrupted | checkpointed; resume from last committed unit; idempotent writes make re-run safe |
| DB unavailable | run fails fast and loudly rather than half-writing |

**Induced failure**, if nothing breaks naturally: point a source adapter at a URL
that 403s, or feed the extractor a deliberately malformed page. Labelled as induced
in the log. The brief permits this and asks for honesty about it.

---

## 14. ADRs

**ADR-1 · Two deployables, not ten services.**
The stages are a sequential pipeline over one database with no independent scaling
or failure domains. Services would add nine network failure modes and a distributed
release gate for no benefit at this scale. *Rejected:* microservices. *Cost:* one
process can exhaust another's resources; accepted because budget guards are
per-run.

**ADR-2 · Evidence is created only by extractors, bound to an observation span.**
The Stage 1 defect was possible because evidence was an assignable field. Here
there is no setter. *Cost:* extractors become the only place enrichment can add
provenance; more code duplication across adapters. Accepted — the alternative is
the bug that failed Stage 1.

**ADR-3 · Claim and Fact are one table with a status.**
Two tables means a sync problem and two sources of truth. *Rejected:* separate
`fact` table.

**ADR-4 · RetrievalDocument is a projection, never stored state.**
A stored copy drifts from its claims; a drifted chunk passes every downstream
check and misleads the customer. *Cost:* index rebuild on release. Cheap at 500.

**ADR-5 · The release gate is one function.**
Multiple write paths mean no gate. *Cost:* a bottleneck in code; irrelevant at this
volume.

**ADR-6 · Extraction, validation and release contain no agentic control flow.**
A model that decides releases can release a bad claim. Models are used inside
bounded steps whose output is mechanically checked. *Cost:* less adaptive; that is
the point.

**ADR-7 · Release policy is versioned data.**
Lets a tightened standard demote already-released claims on the next run, which is
what makes release a pipeline. *Cost:* re-evaluation cost per run.

**ADR-8 · Staleness is evidence-based, via content hashing.**
Clock expiry alone is explicitly insufficient. *Cost:* every refresh is a real
fetch. This is the dominant cost driver — see §15.

**ADR-9 · `family_holding_company` is a distinct category.**
Stage 1's SFO-1 rule proved family control, not family-office function. Twenty
records qualified on it. Splitting the category is honest reclassification rather
than relabelling. *Cost:* the qualifying count drops before it rises.

**ADR-10 · Interface copy is validated data.**
Correction 8 holds user-visible sentences to the data truth standard. *Cost:* a
precondition registry every string must join.

---

## 15. Pre-build decisions

Five decisions must be settled before the collect module is written, because each
one changes what we build rather than how well we build it.

### D1 · Reachability feasibility spike — **run this first**

200 of 500 must reach a named individual. Stage 1 produced roughly one. This is
the single requirement most likely to fail the stage, and no amount of validation
architecture solves it: validation rejects, it cannot create.

**Spike design.** 60 candidate firms, stratified 10 per channel, drawn from the
existing Stage 1 candidate pools so no new discovery is needed.

| Channel | What it might yield | Known risk |
|---|---|---|
| SEC 13F signature block | signatory name, title, phone from a statutory filing | the phone is a filing contact number and may be a **switchboard**, which the corrected standard explicitly excludes |
| SEC ADV Schedule A | named direct owners and executive officers | coverage limited to registered advisers, which most SFOs are not |
| Firm leadership page | named people, sometimes role-specific email | most SFOs have no site; Stage 1 found 14 of 50 |
| Verified principal profile | LinkedIn `/in/` page | proving the profile *belongs* to the named person is the hard part, not finding it |
| Regulatory filing signatories | 13D/G and Form D signature pages | sparse, but statutory |
| Conference speaker profile | name, title, org, occasionally direct contact | recency is good; ownership proof is weak |

**Metrics collected per channel**, fixed before we start so the comparison is
honest:

1. `candidates_attempted`
2. `person_identified` — a named human tied to the firm
3. `route_found` — any contact value at all
4. `ownership_evidenced` — evidence that the route reaches *that person*, not the firm
5. `passes_gate_5` — survives the contact-ownership gate
6. `cost_per_qualified` — API calls + wall time per record that reaches (5)
7. `source_concentration_delta` — how far this channel pushes the file toward one source class

**Decision rule.** Extrapolate (5) to 500 records. If no combination of channels
projects ≥200, we do not proceed to build and instead revisit whether the target
is reachable at all — and say so in the submission rather than shipping 120 and
hoping. A projected shortfall found on day 1 is a design input; found on day 4 it
is a failure.

**My prior, stated so it can be proven wrong:** the SEC signatory phone is the
highest-volume channel and I expect it to have the *worst* ownership evidence,
because a cover-page number is usually the firm's. If that is right, the highest
yield comes from firm leadership pages and profile verification, which are lower
volume and push the file toward firms with a web presence — the exact opposite of
the invisible-SFO thesis that made Stage 1 interesting. That tension is real and
the spike exists to price it.

### D2 · Minimum qualifying-record standard

A record counts toward the 500 only when **all** hold:

| # | Requirement | Gate |
|---|---|---|
| 1 | **Identity resolved** — one real entity, not a duplicate or an unmerged variant | 4 |
| 2 | **Family-office function evidenced** — affirmative evidence of managing family wealth, not merely family ownership (§9) | 2, 7 |
| 3 | **Named human decision-maker** — a person, not a corporate controller | 3 |
| 4 | **Commercial intelligence present** — at least one released claim from the value set: mandate, sector focus, AUM band, or a dated signal within 12 months | 9 |
| 5 | **Freshness** — no released claim past `expires_at` without re-observation | 8 |
| 6 | **No unresolved blocking conflict** — a same-tier contradiction on identity, classification, or principal is blocking; on a secondary field it is disclosed, not blocking | 7 |

Reachability is **not** in this list. It is a separate count (≥200) reported
independently, because conflating them would let a thin-but-reachable record
qualify and a rich-but-unreachable one fail.

### D3 · Field-class refresh policies

Per-field twice-daily refresh is ~6,000 fetches/day at 500 records and would
dominate every other cost. Replaced by four classes with rotating re-observation:

| Class | Fields | TTL | Cycle behaviour |
|---|---|---|---|
| **Statutory** | registered address, company number, incorporation, control register | 30d | rotate ~1/30th of the set per cycle |
| **Volatile** | principal, title, contact routes, website | 7d | rotate ~1/7th per cycle |
| **Append-only** | dated signals, filings | never | never re-observed; new ones appended |
| **Derived** | classification, commercial completeness | on input change | recomputed when a source claim changes |

Rotation is deterministic by `entity_id` hash so every record is re-observed on a
predictable schedule, and a run that dies mid-rotation resumes at the same offset.
Expected steady-state load: ~120 fetches/cycle, not 3,000.

### D4 · Retrieval extension — evidence-aware shortlist retrieval

The new capability is **multi-dimensional scored retrieval**: a single query
filters and ranks simultaneously on fit, evidence grade, freshness, classification
confidence, and principal-level reachability, and returns per-result *why it
matched* and *what is missing*.

Stage 1 could rank on semantic similarity and filter on type and country. It could
not answer "firms with mandate evidence, verified within 30 days, where I can
reach a named principal, ranked by fit" — which is the question a user with money
actually has.

**Boundary against the agent, kept deliberately sharp:** this is a *tool*, not a
workflow. It takes a structured query and returns scored results with scope
metadata. It does not decompose goals, call itself repeatedly, or compose prose.
The agent does those things using this as one of its tools. Keeping the line here
means the retrieval extension is independently demonstrable — which the brief
requires, since it asks for a link to the retrieval feature *and* a link to the
agent.

### D5 · Goal 3 — change intelligence

Detect what changed across operating cycles and turn it into a defensible updated
shortlist: *"three firms entered your shortlist since Tuesday, one left because its
principal evidence went stale, and here is the evidence for each move."*

This is the strongest paid-tier argument available to us because it is
**structurally impossible to get from a one-time export**, which is what every
competing data product sells. It also exploits the operating window rather than
merely surviving it.

**Risk, and it is real:** it depends on changes actually occurring across a 48-hour
window. If nothing moves, there is nothing to demonstrate. Mitigations, in order of
honesty: the volatile field class is re-observed fastest so it has the best chance
of catching real movement; the induced failure (§13) produces a genuine
trust-reduction event; and if the window genuinely produces no material change we
say so plainly and show the mechanism firing on the events we do have. We do not
manufacture a change to make the demo work.

### Decision table

| ID | Decision | Status | Blocks |
|---|---|---|---|
| D1 | Source mix for reachability | **spike first, then decide** | collect module, the 500 climb |
| D2 | Minimum qualifying standard | proposed above, needs sign-off | release gate, the count |
| D3 | Field-class refresh policies | proposed above, needs sign-off | refresh module, scheduler cadence |
| D4 | Retrieval extension scope | proposed above, needs sign-off | web app, agent tools |
| D5 | Goal 3 = change intelligence | proposed above, needs sign-off | logging detail, demo plan |

### Still unresolved

**U1 · Does D2 drop the Stage 1 base too far?** If 20 of 50 become
`family_holding_company` and others fail requirement 4, the usable base may be
nearer 25 than 50. That changes the climb from +450 to +475 and is worth knowing
before we commit.

**U2 · What is the actual cost per refreshed record?** D3 reduces the fetch count
but the model cost per re-extraction is unmeasured. Needed for the day-2 checkpoint
prediction, which asks for exactly this number.
