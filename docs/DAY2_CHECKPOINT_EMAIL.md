# Day-2 checkpoint email — FINAL

Verified against live production, the GitHub Actions API and the database at
30 Jul 2026 22:05 UTC. Figures below are re-queried, not carried forward.

**To:** optimize@falconscaling.com
**Subject:** Stage 2 Day-2 Checkpoint — deployed and scheduling · Muhammad Attique Ur Rehman

---

Brian,

Day-2 checkpoint. The system is deployed and running unattended on GitHub Actions.

**Extended retrieval feature**
https://fo-intel-web.vercel.app/shortlist

**Agent**
https://fo-intel-web.vercel.app/agent

**Operating view** (runs, gate outcomes, and what the gates refused)
https://fo-intel-web.vercel.app/operations

Scheduler screenshots attached: the full list of scheduled runs, and the detail
page for the scheduled `refresh` run showing it was triggered by schedule.

**Three predictions**

1. **What breaks first:** source composition, not infrastructure — Companies House
   scales the record count but publishes no principal contact routes, so the 500
   will arrive before the 200 and reachability is what falls short.
2. **Cost to refresh:** $0.00 direct at both scales — no model calls in the
   collect/refresh path and every dependency is free-tier; measured cost is 3
   Companies House calls and ~12s per record, so ~1,500 calls and ~1.7 runner-hours
   for all 500.
3. **Goal 2 confidence:** low-to-moderate and explicitly stated per firm — the
   dataset holds statutory identity and contact routes but almost no mandate or
   sector evidence, so I expect it to abstain on healthcare-fund fit for most
   records and say the evidence is absent rather than infer it.

**Operating status, honestly**

Three scheduled runs have executed without me triggering them, the first at
18:08 UTC today, spanning 3 hours so far; the 48-hour window is open and running.
Checkpoints advance and resume correctly, and each scheduled run automatically
chains the contract job that re-judges claims and audits the release invariants.

The dataset is at 159 entities, 145 of them qualifying, with 1,795 released claims
and 11 quarantined. Reachability is where I am behind: 40 records carry a route
that reaches a named individual, 39 of which also qualify, against the 200 needed.
That gap is the honest position at day two, and the reason is the source trade
above rather than throughput — the SEC signatory channel produces routes and the
UK registry does not, so the next work is weighted toward channels that do.

I report reachability as two separate figures that are never merged: strict
excludes personal profiles, profile-assisted includes them. They are both 40 today
because no profile routes exist yet.

Muhammad Attique Ur Rehman

---

## Evidence pack (working record — not part of the email)

### Live figures at 22:05 UTC 30 Jul

| metric | value |
|---|---|
| total entities | 159 |
| qualifying (of 500) | 145 |
| strict reachable | 40 |
| **qualifying AND strict reachable (of 200)** | **39** |
| profile-assisted reachable | 40 |
| released claims | 1,795 |
| quarantined · held | 11 · 0 |

### Scheduled-run evidence (GitHub Actions API)

| run | event | status | start → end |
|---|---|---|---|
| `refresh #1` (30569061299) | **schedule** | success | 18:07:53Z → 18:16:31Z |
| `contract #2` (30569689659) | workflow_run | success | 18:16:33Z → 18:16:58Z |
| `discover #2` (30581886223) | **schedule** | success | 21:04:12Z → 21:08:41Z |
| `contract #3` (30582200205) | workflow_run | success | 21:08:43Z → 21:09:03Z |

Checkpoints after the scheduled discover: `discover/companies_house` cursor
`11065001`, 40 units.

### Cost basis (measured, not estimated)

- `refresh`: 40 records in 495s → **12.4 s/record**
- `discover`: 40 records in 239s → **6.0 s/record**, 491 claims created
- Model calls in collect/refresh: **0** (extraction is deterministic field mapping)
- Companies House: 3 calls/record · SEC 13F: 0 (local quarterly dataset)

### Contract invariants (all zero at 22:05 UTC)

PTC-1 released-without-decision · PTC-10 foreign-event evidence ·
released-without-attribution-pass · reachability-without-ownership-evidence

### Operating window conditions still outstanding (not checkpoint requirements)

1. two scheduled runs ≥48h apart — **in progress**, 3.0h elapsed of 48
2. one real dependency failure met while running — **not yet recorded**
3. cross-run staleness event with an evidence-based reason — **not yet fired**
   (`s2_decision_log` holds 0 rows of kind `stale`; refresh found all hashes
   unchanged, which is the mechanism working but not yet a decay event)
