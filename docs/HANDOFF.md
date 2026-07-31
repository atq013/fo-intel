# Stage 2 — Handoff

Written 31 Jul 2026, last refreshed 15:40 UTC. Every figure below is a query against the live
database or the GitHub Actions API at that moment, not a recollection.

No secrets in this file. `DATABASE_URL`, `COMPANIES_HOUSE_API_KEY`,
`GEMINI_API_KEY`, `GROQ_API_KEY` and `SERPER_API_KEY` live in `.env` locally
(gitignored), in GitHub Secrets for the workflows, and in Vercel's environment
for the deployed app.

---

## Where things are

| | |
|---|---|
| commit | see `git log -1`; this doc last updated at `93c2d7f`+ |
| repository | https://github.com/atq013/fo-intel |
| retrieval feature | https://fo-intel-web.vercel.app/shortlist |
| agent | https://fo-intel-web.vercel.app/agent |
| operating view | https://fo-intel-web.vercel.app/operations |
| Stage 1 product (unchanged) | https://fo-intel-web.vercel.app/ |
| retrieval API | `GET /api/shortlist?strict=1&tier=1&limit=25` |
| agent API | `POST /api/agent` with `{"question":"..."}` |

---

## Current metrics

| metric | value | target |
|---|---|---|
| total entities | **242** | — |
| qualifying | **218** | 500 |
| qualifying + **strict** reachable (phone/email) | **67** | 200 |
| qualifying + **profile-assisted** reachable | **174** | — |
| qualifying + **postal** reachable | **47** | — |
| **qualifying + any defensible named-individual route** | **187** | — |
| released claims | **2,842** | — |
| quarantined claims | **11** | — |
| scheduled runs | **9** | ≥2, ≥48h apart |
| window elapsed | **21.5h** of 48 | closes 1 Aug 18:07Z |
| tests | **69/69** | — |

Routes by channel: 68 phone (strict) · 107 LinkedIn (profile-assisted) · 81 postal.

**All five invariants are zero** and are re-checked on every `contract` run:
PTC-1 (released without a decision row), PTC-10 (establishing evidence from a
foreign extraction event), claims with no basis, reachability without ownership
evidence, and strict contamination (a postal or profile route counted as strict).

### Reachability is three separate numbers, never one

ADR-11 and ADR-12. `strict` is a phone or personal mailbox. `profile-assisted`
adds verified personal profiles under assumption A1. `postal` is an adjudicated
statutory service address. The database refuses `counts_strict` on a linkedin or
postal row, so the separation is enforced rather than remembered. A reviewer who
rejects A1 should read 67; one who accepts postal routes should read 187.

---

## Completed

- **Contract core.** 14 tables. A claim and its establishing evidence share an
  extraction event, enforced by a composite foreign key — the Stage 1 defect
  (93 values wearing another fact's evidence) is unexpressible. Verified
  adversarially against the live database, not assumed.
- **Gates 1–6** with 19 fixtures extracted mechanically from the Stage 1
  delivered file. Three evidence kinds: quoting, pointer, and `derivation`
  (re-runs a registered rule at validation time).
- **Four collectors**, all through one observation → extraction → validation →
  release path: Companies House, SEC 13F signatory, SEC Form ADV, verified
  profiles.
- **Retrieval extension** (`/shortlist`): multi-dimensional scoring on fit,
  evidence grade, freshness and reachability, returning why each matched and what
  is missing, with mandatory scope and exclusion reporting.
- **Bounded agent** (`/agent`): four tools over released claims only. Firm names
  and dataset counts are resolved server-side from tool output — the model emits
  tokens and cannot type either. An answer that fails to surface a constraint the
  planner could not honour is blocked in control flow.
- **Scheduled operation**: 9 scheduled runs, window open since 30 Jul 18:07:53Z.
- **Day-2 checkpoint email** sent.

---

## Web-discovery spike — completed, NOT IMPORTED

Ran 31 Jul, 40 Serper queries across the four exact phrases, 153 unique
candidate domains, 45 fetched for first-party verification, 150s, $0.

| measure | value |
|---|---|
| unique candidate domains | 153 |
| directory results skipped (discovery only) | 40 |
| sites fetched | 45 |
| passed the automated filter | 12 (27%) |
| **actually family offices on inspection** | **1, possibly 2** |
| **true precision** | **~2–4%** |
| duplicates against existing entities | 0 |
| projected strict / postal reachability | **0 / 0** |

### Decision: do not import. Recorded with the reason.

The 27% headline is false and must not be quoted. Reading what "qualified":
`privatebank.jpmorgan.com` and `bbh.com` are **banks**; `daypitney.com` and
`pillsburylaw.com` are **law firms**; `kaufmanrossin.com` is an **accountancy**;
`sage.com` is **accounting software**; `kellogg.northwestern.edu` is a
**university**; `cowenpartners.com` is an **executive search firm**;
`uhnwinstitute.org` is a **trade body**. Only `legacyknight.com` is plausibly a
multi-family office.

Principal extraction returned page furniture, not people: *"Insights Reports
Family"*, *"Enterprise Value"*, *"Topics Asena Client"*, *"Chief Investment
Officer"*.

**The structural reason, which no regex fixes:** a single family office has no
commercial reason to have a website. It serves one family and seeks no clients.
The organisations ranking for `"family office"` are precisely those *selling
services to* family offices. A wording test cannot separate "we are a family
office" from "we advise family offices", and the corpus is ~95% content
marketing.

Importing at this precision would place banks and law firms in a family-office
dataset — a worse version of the `family wealth` IFA problem already rejected,
and exactly what the brief fails a submission for. Same call, same reasoning, as
Phase 0's leadership-page probe (measured 0 of 26, reported rather than salvaged).

**Reproduce:** `WEB_QUERIES=40 WEB_FETCH=45 npx tsx packages/pipeline/src/discovery/sample-web.ts`

---

## Remaining, in priority order

1. **The 500 gap — the one open decision, now fully measured.** 218 of 500.
   Every channel including web discovery has been measured and is at its ceiling
   (see Risks). There is no measured path to 500 that does not involve importing
   firms that are not family offices. The decision — submit 218 honest records
   with the ceiling evidence attached, or something else — is the user's.
2. **Operating window completion.** Opened 30 Jul 18:07:53Z, closes 1 Aug
   18:07Z. 9 scheduled runs, 21.5h elapsed.
   - two scheduled runs ≥48h apart — **on track**, needs a scheduled run after
     1 Aug 18:07Z
   - one genuine dependency failure — **captured** (see below)
   - cross-run staleness with an evidence-based reason — **NOT yet satisfied.**
     `s2_decision_log` holds 6 rows of kind `stale`, and they must not be
     presented as meeting this condition: all 6 fired in **manual** runs inside a
     single working session, and the "change" is a search engine returning a
     different LinkedIn profile on a re-query — not a source contradicting a held
     record. The brief excludes both ("staleness detected within a single
     compressed session is not staleness"). A qualifying event needs a
     **scheduled** `refresh` to find a Companies House or SEC content hash
     genuinely changed across cycles.
3. **The three official goals** run against production with raw traces saved.
   Goal 2 must be used verbatim.
4. **Architecture notes** (2–3 pages), **build session summary**, **AI
   working-session record**, **final requirement-to-evidence checklist**.
5. Deferred and harmless: Puerto Rico is absent from the derivation table so one
   reachable filer stays withheld; a SIGKILL leaves a run row in `running`
   (`withRun` closes on normal failure, not on SIGKILL).

---

## Operating evidence — keep these distinct

**Genuine dependency failure.** `run_20260731081923_76ecb6b1` — a Neon
connection dropped mid-run on company `SC633205`. The system logged it, recorded
it on the run's `failures_json`, continued to the next unit and completed. One
unit lost, no corruption. This is the external-dependency failure the brief
requires.

**Application correctness defect, NOT a dependency failure.** `contract #6`
(scheduled, 31 Jul 09:25:07Z) failed on a duplicate primary key because the
validation-result id omitted the policy version. That was my bug. It is preserved
as a failed run with its logs, and must not be presented as a dependency failure.

**Policy re-admission.** `Capitol Family Office, Inc.` region `OR` was
quarantined under `2025-07-30.1` (*"content coverage 0% below 60%"* — "OR" was
filtered as the English conjunction) and re-admitted under `2025-07-31.1`
(*"span contains the value"*). Both verdicts are stored; the earlier one is never
overwritten. `s2_decision_log` carries *"re-admitted under 2025-07-31.1"*.

---

## Workflows and schedules

| workflow | schedule (UTC) | notes |
|---|---|---|
| `discover` | 02:00, 08:00, 14:00, 20:00 | Companies House, then SEC 13F with `if: always()` |
| `refresh` | 05:00, 17:00 | offset so the two never contend for the CH rate limit |
| `contract` | on `workflow_run` of either, plus 06:30 | re-judges under the current policy; **fails the job on a PTC-1 violation** |

Each has a `concurrency` group: two `discover` runs at once would share a
checkpoint, both advance it, and silently skip units.

GitHub fires cron 60–70 minutes late under load. Consistent, documented, not a
fault — but run times cannot be predicted, only observed.

Only `event: schedule` counts as unattended operation. Filter the Actions list
with `event:schedule`. Local runs never appear there and record as
`trigger: 'manual'`.

---

## Commands

```bash
npm test                                     # 69 tests
npm run typecheck
npx tsx packages/db/src/migrate2.ts          # idempotent, applies 001-006
npx tsx packages/db/src/verify-ptc10.ts      # adversarial contract check
```

Collectors — each has its own source and checkpoint, so they cannot collide:

```bash
MAX_UNITS=60   npx tsx packages/pipeline/src/jobs/discover.ts        # Companies House
               npx tsx packages/pipeline/src/jobs/discover-sec.ts    # SEC 13F signatory
               npx tsx packages/pipeline/src/jobs/discover-adv.ts    # SEC Form ADV
PROFILE_BATCH=200 npx tsx packages/pipeline/src/jobs/discover-profiles.ts
REFRESH_BATCH=40  npx tsx packages/pipeline/src/jobs/refresh.ts
CONTRACT_BATCH=600 npx tsx packages/pipeline/src/jobs/contract.ts
```

Measurement spikes (write nothing):

```bash
SAMPLE_COMBOS=48 npx tsx packages/pipeline/src/discovery/sample-uk.ts
PROFILE_SAMPLE=30 npx tsx packages/pipeline/src/discovery/sample-profiles.ts
WEB_QUERIES=40 WEB_FETCH=45 npx tsx packages/pipeline/src/discovery/sample-web.ts
```

Verification: `/operations` renders runs, gate outcomes, decisions and refused
values. `curl "https://fo-intel-web.vercel.app/api/shortlist?strict=1&limit=1"`
returns the reachability count independently of the agent.

---

## Risks and decisions

**The 500 is not reachable from built sources.** Measured ceilings, not
projections: Companies House narrow pool exhausted (109 unique returned, 72%
already held, 15 net-new kept); SEC 13F holds exactly 56 family-named filers with
an individually-owned route; Form ADV holds 78 family-office-named registrants,
49 recent, 27 net-new. Total measured ceiling ≈ 240.

**The 200 is harder still on strict.** Companies House publishes no contact
routes and Form ADV has no contact field. 67 strict routes all come from SEC 13F
signature blocks, whose ceiling is the same 56 filers.

**Broad name terms were tried and rejected.** `family wealth`, `family services`
and `family management` returned `IFS FAMILY WEALTH ADVISERS` and
`REDWOOD FINANCIAL FAMILY WEALTH & ESTATE PLANNERS` — independent financial
advisers. Including them would have added ~56 records by putting a different
industry in a family-office dataset. Precision was chosen over the count, and
that trade should be defended rather than quietly reversed.

**SEC filer counts, reconciled.** *Selected filers* = census filers that either
carry `FAMILY`/`FAMILIES` in their registered name **or** appear in Stage 1's SEC
candidate list. 90 selected, 68 with an individually-owned route: 56 family-named
plus 12 inherited from Stage 1's structural scoring. Those 12 — `Voss Capital`,
`QVT Financial`, `Barington` — deserve classification review; they are candidates
on inherited authority and some read like hedge funds.

**ADV can never contain a single family office.** SEC Rule 202(a)(11)(G)-1
excludes them from registration. Everything from that source is a multi-family
office or a registered adviser, classified `unconfirmed_registered_adviser`
unless the firm's own registered name says multi-family office. `family_office`
is never assigned from ADV.

**ADV data ends 2024-12-31** and the live registrant feed is WAF-blocked (403).
No `active` claim is stored; the asserted fact is `latestObservedFilingDate` with
the cutoff carried on every observation.

**The 13F dataset is a committed quarterly snapshot** (`data/sec/`, 2.9 MB). It
will not pick up new filings until refreshed.

**Assessment reads the whole record, not the current batch.** Both the contract
job and the pipeline once fed `assessEntity` only the claims in the current
batch, silently withholding complete records — qualifying oscillated 206 → 104 →
184 before it was found. Fixed in both. If that figure ever moves without a
matching change in claims, suspect this first.
