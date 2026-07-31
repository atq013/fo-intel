# Acceptance report — M3 (deployed, scheduled, operating)

Compiled 30 Jul 2026 16:45 UTC, **revised 30 Jul 19:35 UTC** after both blockers
were cleared. Original blocker text is retained below with its resolution, because
what was wrong and how it was found is part of the evidence.

Compiled against live state. Every figure is a query
against the deployed database or a call to the GitHub Actions API — none is
recalled from the build session. Queries are reproducible; the invariant checks
are the same ones the `contract` job runs on every execution.

**Verdict (revised): M3 is acceptable.** Both blockers are cleared and verified
against live state:

- a scheduled run fired unattended — `refresh`, `event=schedule`, 18:07:53 UTC,
  which started the 48-hour operating window and chained a `contract` run
- qualifying ∩ strict-reachable moved from **0 to 39**

The remaining gaps are Phase 4–5 scope (retrieval extension, agent, the climb to
500/200, the window closing), not M3.

---

## 1. Roadmap milestones

| # | Milestone | State | Evidence |
|---|---|---|---|
| M0 | Reachability spike, D1 frozen | **met** | `SPIKE_REACHABILITY.md`; five channels measured, assumptions A1–A5 recorded, position stated as *marginal, not demonstrated* |
| M1 | Contract + gates green on Stage 1 fixtures | **met** | 14 tables live; PTC-10 refused adversarially by the database (`verify-ptc10.ts`, 6/6); 30 tests green; 4 compile-time negative assertions |
| M2 | Companies House end to end; Stage 1 re-qualified | **met (UK subset)** | 69 CH entities, 65 qualifying; all 20 Stage 1 UK records re-derived, 18 qualifying, 2 withheld. The other 30 Stage 1 records are SEC/web-derived and have no Stage 2 collector — see Blocker 2 |
| M3 | Deployed, scheduled, checkpoint email sent | **met, less the email** | scheduled run `30569061299` fired unattended 18:07:53 UTC with `event=schedule`, chained `contract` at 18:16:33; 48h window open. Checkpoint email still to send |
| M4–M8 | retrieval, agent, 500/200, window, submission | not started | — |

---

## 2. Brian's stated requirements

| Requirement | State | Evidence |
|---|---|---|
| 500 qualifying records | **218 / 500 — UNMET** | frozen dataset; see "The 500 requirement is unmet" below |
| ≥200 reachable | **67 strict · 174 profile-assisted · 47 postal · 187 any defensible route** | three metrics, never merged (ADR-11, ADR-12). 200 unmet on strict; 187 of 200 on the broadest defensible reading |
| Deployed retrieval link | met | `/` (Stage 1, 50 firms, unchanged) and `/operations` (Stage 2) on Vercel |
| Running agentic system | not started | Phase 4 Track C |
| Repository, full history | met | public, commit history from Stage 1 through Phase 3 |
| Complete run logs for the window | **met, accruing** | 12 runs incl. 1 `trigger='schedule'`; window opened 30 Jul 18:07:53 UTC, closes 1 Aug 18:07 UTC |
| Records with freshness/trust state | met | `s2_claim.status`, `s2_entity.trust_state`/`commercial_state`, evidence-based staleness via `content_hash` |
| Three goals + raw traces | not started | Phase 5 |
| Tool interfaces / schemas | not started | Phase 4 Track C |
| Setup instructions | not started | Phase 5 |
| Build session summary | Stage 1 only | needs a Stage 2 section |
| Day-2 checkpoint email | **not sent** | blocked on the first scheduled run |

---

## 3. Contract integrity — all invariants hold

Run against live data. Every one must be zero.

| Invariant | Result |
|---|---|
| PTC-1 · released claim with no `release_decision` row | **0** |
| PTC-10 · establishing evidence from a foreign extraction event | **0** |
| claims with no establishing evidence | **0** |
| contacts counting toward reachability without ownership evidence | **0** |
| released claims where `attribution` did not pass | **0** |

That last row is the one worth dwelling on. **1,307 claims are released and not
one** reached that state without the attribution gate explicitly passing. In
Stage 1, 93 of 155 quote-backed values were mis-wired. The defect class is now
structurally absent rather than merely unobserved.

### PTC-2, demonstrated and then discharged

Before the fix, 49 SEC `country` claims sat in `candidate`. Their evidence cited a
filing accession number, which the attribution gate classifies as *pointer*
evidence; pointer resolution is Band B and not built, so the gate returned
`skipped` and the release gate treated skipped as not-proven and **held** them.

That is the contract working as specified — an unchecked value did not reach a
customer wearing the appearance of a checked one. It was also the direct cause of
Blocker 1, and it is why the fix changed the *kind* of evidence rather than
loosening the gate. Held claims are now 0.

| gate | passed | failed | skipped |
|---|---|---|---|
| schema | 1315 | 0 | 0 |
| attribution | 1309 | 6 | 0 |
| value_type | 360 | 2 | 953 |
| coherence | 542 | 0 | 773 |
| contact_ownership | 40 | 1 | 1274 |
| identity | 0 | 0 | 1315 |

---

## 4. Operational behaviour

**Workflows.** Three, all `state=active` on default branch `main`, public repo,
valid cron. `discover` 02/08/14/20 UTC, `refresh` 05/17 UTC, `contract` on
`workflow_run` completion of either.

**Chaining proven.** GitHub's API records the `contract` run as
`event=workflow_run` — nothing human started it. The upstream `discover` shows
`event=workflow_dispatch`.

**Checkpoints advance and resume.** Three rows, keyed `(job, source_id)`:

| job | source | cursor | units |
|---|---|---|---|
| discover | companies_house | 13916919 | 60 |
| discover | sec_13f | name:ONEASCENT FAMILY OFFICE | 8 |
| refresh | companies_house | 13692510 | 40 |

Resume verified three times, including under real failure. The Companies House
cursor was written by the GitHub-hosted run, not locally. The `refresh` cursor was
written by the **scheduled** run. And when the SEC re-derivation was killed by a
10-minute command timeout at unit 41 of 49, the next invocation resumed at
`0001345471` and completed the remaining 8 units with no reprocessing and no
duplicates — the checkpoint doing exactly the job it exists for, against an
unplanned kill rather than a rehearsed one.

**Idempotency.** Deterministic entity ids; a content-hash short circuit that
writes nothing when a source is unchanged (observed: 9 of 9 unchanged on the
refresh run); checkpoints written only after the unit's writes commit.

**Logging.** Structured JSON to stdout (Actions log) and to `s2_run_log` in Neon,
because Actions logs expire and are not queryable. 176 rows across 12 runs, plus
124 rows in `s2_decision_log` (`classify` 118, `budget_halt` 3, `quarantine` 3).

**`/operations`** renders runs, gate outcomes, decisions, refused values and both
reachability metrics, all matching the database.

---

## 5. Blockers — both resolved

Only two were ever found. Everything else above is either met or later-phase work.

### Blocker 1 — RESOLVED 30 Jul 19:30 UTC

**Was:** zero records both qualifying and reachable. **Now: 39.**

| source | entities | qualifying | reachable | **both** |
|---|---|---|---|---|
| companies_house | 69 | 65 | 0 | **0** |
| sec_13f | 49 | 46 | 40 | **39** |

Fixed inside the existing SEC extractor using `COVERPAGE.tsv` fields that were
already loaded — `FILINGMANAGER_STREET1`, `CITY`, `STATEORCOUNTRY`, `ZIPCODE`. No
new source, collector, architecture or policy.

The substantive change was to the *kind* of evidence, not the value. `country`
had been asserted from "Form 13F implies a US manager", citing the accession
number — pointer evidence, which gate 2 correctly deferred and the release gate
correctly held. Now the state code is read from the filing and the country is
re-derived from it by the already-registered `us_state_to_country` rule, so the
gate can check the claim instead of deferring it. All 49 previously-held claims
are now released, each with a detail line of the form *re-derived "United States"
from a two-letter US state code "NY" present in the span*.

The SEC entities were **re-derived, not patched** — their claims were dropped and
rebuilt from the observations, per the roadmap's rule for re-qualification.

**One entity is reachable but still withheld, correctly.** Long Focus Capital
Management files from San Juan, `PR`. The registered rule covers 50 states and
DC, so it returned null and the extractor declined to claim a country rather than
guess one. Whether US territories should map to "United States" is a policy
question, and policy was frozen. One-line fix available if wanted.

<details><summary>Original blocker text</summary>

| source | entities | qualifying | reachable | **both** |
|---|---|---|---|---|
| companies_house | 69 | 65 | 0 | **0** |
| sec_13f | 49 | 0 | 40 | **0** |

The two populations are disjoint. Companies House publishes no contact routes;
SEC filers carry routes but fail the commercial floor, missing `country`,
`website` and `city`.

A record only counts toward the 500 if it qualifies, and only counts toward the
200 if it is reachable. **The intersection is currently 0**, so on this
trajectory both hard minimums fail regardless of how many records accumulate.

`country` is missing for a specific and fixable reason: the SEC extractor cites
the filing accession for it, which reads as pointer evidence and is correctly
held. The data to fix this is already loaded — `COVERPAGE.tsv` carries
`FILINGMANAGER_CITY`, `FILINGMANAGER_STATEORCOUNTRY`, `FILINGMANAGER_STREET1` and
`FILINGMANAGER_ZIPCODE` for every filer, and the `us_state_to_country` derivation
rule is already registered and tested.

Estimated fix: ~30 lines in the existing SEC extractor, no new architecture, no
new source. Expected effect: ~40 entities become qualifying **and** reachable.

*(Outcome: 39. Estimate was accurate.)*
</details>

### Blocker 2 — RESOLVED 30 Jul 18:07 UTC

The first scheduled run fired unattended:

```
refresh | event=schedule | completed/success | 2026-07-30T18:07:53Z
  -> contract | event=workflow_run | completed/success | 2026-07-30T18:16:33Z
```

GitHub's API attests both the `schedule` trigger and the chain. **The 48-hour
operating window opened at 30 Jul 18:07:53 UTC and closes 1 Aug 18:07 UTC**,
inside the submission deadline.

Note it fired at 18:07, not the configured 17:00. GitHub delays cron under load;
this is documented platform behaviour, not a fault, and is recorded here so the
timestamps in the logs are not read as a defect.

<details><summary>Original blocker text</summary>

All 8 runs to date are `trigger='manual'`. The 48-hour operating window is
measured from the first `schedule`-triggered run, and it has not started. Every
precondition is verified — workflows active, on the default branch, valid cron,
secrets present, a full manual execution green — but a future event cannot be
asserted, only observed.

Next opportunities: `refresh` 17:00 UTC, `discover` 20:00 UTC.

Until one fires, M3 cannot be signed off, the day-2 checkpoint email has nothing
to report, and the window cannot close inside the submission deadline.
</details>

---

## 6. Not blockers, but known and deliberate

- **`value_type` skips 761 of 1,123 claims.** Everything typed `string` has no
  registered checker, so `postcode`, `city` and date fields are unvalidated. A
  quality gap, not a correctness one — no false claim is produced, but a
  malformed one would not be caught.
- **`identity` skipped 1,123/1,123.** No profile claims exist yet; the gate has
  nothing to judge. It is proven against Stage 1's two wrong-person profiles in
  the test suite.
- **`contract` evaluates 0 claims** until `POLICY_VERSION` changes, by design. Its
  PTC-1 audit still runs every execution and fails the job on violation.
- **A `workflow_run`-triggered `contract` records as `trigger='manual'`,**
  understating unattended operation. It does not affect the window, which is
  measured from `discover`/`refresh`, and both record correctly.
- **The 13F dataset is a committed quarterly snapshot** (`data/sec/`, 2.9 MB).
  It will not pick up new filings until refreshed. Stated rather than implied.
- **A run killed by a command timeout left its row in `running`** during the
  re-derivation. `withRun` closes rows on normal failure but cannot on SIGKILL.
  It was closed as `aborted` with the reason recorded. Worth knowing because an
  Actions timeout would do the same, and a row stuck in `running` makes window
  queries ambiguous.
- **Puerto Rico is not in the derivation table**, so one reachable filer stays
  withheld. Correct refusal rather than a guess; see Blocker 1.


---

## The 500 requirement is unmet — measured, not estimated

**Frozen dataset:** 242 entities · **218 qualifying** · 67 strict reachable ·
174 profile-assisted · 47 postal · **187 with any defensible named-individual
route**.

The 500-record minimum is **not met**. This is a measured ceiling from every
channel built and every channel tested, not a shortfall of effort or runtime.
The qualification standard was never lowered to close it.

### Source ceilings, each measured

| channel | ceiling | how it was measured |
|---|---|---|
| Companies House | **exhausted** | narrow search returned 109 unique companies, **72% already held**, 31 new, 16 rejected as shells (never-filed, dormant, micro-entity), **15 net-new kept** |
| SEC 13F signatory | **56 filers** | full 2025Q3 census: 9,874 routes, 6,948 individually-owned across 6,944 filers, of which **exactly 56** carry `FAMILY`/`FAMILIES` in the registered name |
| SEC Form ADV | **27 net-new** | 942,258 filing rows scanned; 78 family-office-named registrants, 49 filed 2023+, **22 already held** via 13F |
| Verified profiles | **adds routes, not records** | 67% measured on a 30-entity sample; 107 routes created, zero new entities |
| Web discovery | **rejected at ~2–4% precision** | see below |
| **total measured ceiling** | **≈ 240** | against a requirement of 500 |

### The rejected web-discovery spike

40 Serper queries across the four exact phrases, 153 unique candidate domains, 45
fetched for first-party verification. 12 passed the automated filter (27%);
**1–2 were actually family offices**. True precision **~2–4%**.

What the filter let through: `privatebank.jpmorgan.com` and `bbh.com` (banks),
`daypitney.com` and `pillsburylaw.com` (law firms), `kaufmanrossin.com`
(accountancy), `sage.com` (accounting software), `kellogg.northwestern.edu` (a
university), `cowenpartners.com` (executive search), `uhnwinstitute.org` (a trade
body). Extracted "principals" were page furniture: *"Insights Reports Family"*,
*"Enterprise Value"*, *"Chief Investment Officer"*.

**The structural reason:** a single family office has no commercial reason to
publish a website. It serves one family and seeks no clients. The organisations
that rank for `"family office"` are precisely those *selling services to* family
offices, and no wording test separates "we are a family office" from "we advise
family offices".

Importing at that precision would have added ~150 records by placing banks and
law firms in a family-office dataset. The same call was made earlier against the
`family wealth` search terms, which returned independent financial advisers
(`IFS FAMILY WEALTH ADVISERS`, `REDWOOD FINANCIAL FAMILY WEALTH & ESTATE
PLANNERS`), and in Phase 0 against the leadership-page probe, which measured 0
of 26.

**Reproduce:** `WEB_QUERIES=40 WEB_FETCH=45 npx tsx packages/pipeline/src/discovery/sample-web.ts`

### The position, stated plainly

The brief says a submission below 500 fails, and also that a file containing
values labelled more strongly than the evidence supports cannot be trusted. Both
could not be satisfied from the sources available. **218 records that hold, with
the ceiling measurements attached, was chosen over 500 that do not.**
