# Product quality review — fo-intel / Sightline

## How I chose to review, and why

You reviewed as the customer, black-box, through the deployed UI. I deliberately took the **opposite** angle so the two don't duplicate: I reviewed as an **evaluator with source access**, asking one question throughout —

> **Does what each surface *tells* a customer match what the system *actually does*?**

That framing is chosen because this product's entire commercial claim is evidentiary honesty. A slow page loses a customer; a false statement about evidence quality loses the argument the product exists to make. So I prioritised **claims over cosmetics**.

Four layers:

1. **Stated-vs-actual** — take every assertion a surface makes (filter labels, match reasons, scope statements) and verify it against the API, the database and the code.
2. **Boundary and hostile input** — negative, absurd, malformed and oversized values on both APIs, because those are the states a demo never reaches.
3. **Drift** — compare the submitted deliverable against the live system, since eight days have passed.
4. **Launch controls** — auth, rate limiting, security headers, error surfaces.

I did not change anything. All commands were reads.

**One correction I owe you first:** I told you your figures of 10,073 / 10,115 didn't match the export and one must be wrong. **You were right and I was wrong.** Yours was the live page today; mine was the export from 3 August. Both are correct for their moment — which turns out to be a finding in itself, below.

---

## Severity 1 — would mislead a paying customer

### 1.1 "Every value traced to a statutory source" is false on 335 of 581 records

**Evidence.** `shortlist.ts:221` emits that string when `best_tier === 1`. `best_tier` is the **minimum** tier across a record's values, so it is 1 whenever *at least one* value is statutory. Live check on `HOLDUN FAMILY OFFICE LLC` — tiers present `[1, 3]` — the UI displays:

> *"every value traced to a statutory source or the firm itself"*

335 of 581 records hold at least one non-statutory value while eligible for that badge.

**Why it matters.** This is the exact failure the whole system was built to prevent — a value labelled more strongly than its evidence supports — and it appears in customer-facing text on the flagship surface. The export already knows better: we added `worstSourceTier` to `records.csv` for precisely this reason. The retrieval layer never got the same fix.

**Verdict: FIX.** Change to *"lowest source tier: 1"* or *"statutory for N of M values"*.

### 1.2 The `country` filter never filters — but is displayed as applied

**Evidence.** `?country=Neverland&limit=1` → `appliedFilters: ["country = Neverland"]`, `matched: 581`. `shortlist.ts:167` pushes the label; no filtering code exists.

**Why it matters.** `appliedFilters` is the product's own honesty mechanism — the thing that tells a customer what was and wasn't done. One of its entries is a lie. That is worse than a missing feature.

**Verdict: FIX or REMOVE the parameter.** Silently accepting and reporting an unimplemented filter is the worst of the three options.

### 1.3 The source-tier filter is a no-op at *every* value

**Evidence.** `tier=1`, `2`, `3`, `4` all → `matched: 581`. Same root cause as 1.1.

You found this at `tier=1`. It's broader: the control has **no effect at any setting**, while its chip reads "statutory sources only".

**Verdict: FIX.**

### 1.4 The agent answers the same question two ways, differing by 2×

**Evidence, both live:**

| question | tool used | answer |
|---|---|---|
| *"Which family offices can I reach by phone at a named individual?"* (the product's own example chip) | `search_firms` only | **"27 firms matched"**, 7 listed, `unhonoured: []` |
| *"How many … Give me the total."* | `count_matching` | **"54 have a named individual that can be reached by phone"**, narrowing disclosed |

Ground truth: `?strict=1` → **54**. The 27 comes from silently adding `q="family office"` — a name filter the customer never asked for.

**All seven guards stayed silent in both cases.**

**Why it matters.** This is an architectural gap, not a bug. The guards check *claims about values* — is this score being called confidence, was this gate skipped. They cannot see **whether the denominator matches the question asked**. Nothing false was asserted; a narrower question was answered and its denominator reported as the broad answer. The shipped example chip triggers the wrong path.

**Verdict: FIX.** The denominator needs to be a checked output, not prose.

---

## Severity 2 — would expose or embarrass you

### 2.1 `limit=-5` returns 576 records, bypassing the 100 cap

**Evidence.** `limit=25`→25, `limit=100`→100, **`limit=-5`→576**, `limit=-500`→81. `Math.min(-5, 100) = -5`, and `slice(0, -5)` returns all but the last five.

**Why it matters.** No auth, no rate limiting, and the page cap defeated by a minus sign — the entire dataset is one request away for anyone. **Verdict: FIX.**

### 2.2 An oversized question leaks your provider organisation ID

**Evidence.** 60,000-character question → **HTTP 500** with:

> `{"error":"groq 413: {\"error\":{\"message\":\"Request too large … in organization org_01kyfxatgve37a2b4d70v8ewhs …`

**Why it matters.** Raw upstream error to an anonymous caller, including an internal org identifier. No length cap before the outbound call. **Verdict: FIX.**

### 2.3 No auth, no rate limiting, no security headers

**Evidence.** 12 rapid unauthenticated calls, all 200. `/login`, `/signin`, `/api/auth`, `/account` → 404. Headers present: HSTS, cache-control. Absent: `X-Frame-Options`/frame-ancestors, `X-Content-Type-Options`, CSP, `Referrer-Policy`, `Permissions-Policy`. `x-powered-by: Next.js` is advertised.

**Verdict: FIX before any paid access.**

### 2.4 Malformed JSON returns 500 with a JavaScript parser message

**Evidence.** `{"question":` → `HTTP 500 {"error":"Unexpected end of JSON input"}`. Confirms your finding. *(Credit where due: an empty body returns a clean `400 "question is required"` — the handling exists, it just isn't applied to parse failures.)*

**Verdict: FIX.**

### 2.5 The injection defence works, but explains itself badly

**Evidence.** Injection attempt → no prompt leaked, no fabricated $4bn, no tool misuse. **The substance is right.** The wording:

> *"I could not ignore all previous instructions or print the system prompt verbatim **as the tools do not have this capability**"*

**Why it matters.** It repeats the attacker's instruction back, and frames a policy boundary as a tooling limitation — reading as *"I would if I could"*. **Verdict: FIX the wording, KEEP the mechanism.**

---

## Severity 3 — quality and trust signals

### 3.1 The `evidence` scoring dimension is constant

**Evidence.** Top three records: `evidence: 1` on all, identical total scores of `0.9825`, identical dimensions. `evidence = (5 - best_tier)/4`, and `best_tier` is 1 for every record.

A ranking dimension presented to the customer that has **zero discriminating power across the entire file**, and ties that make ordering arbitrary. **Verdict: FIX or REMOVE from display.**

### 3.2 The submitted export has drifted from the live product

**Evidence.** Export generated 3 Aug: 9,941 released, 37 quarantined. Live now: **10,073 released, 47 quarantined**. **113 runs since 4 August**, most recent 10 Aug. Headline counts (740/581/54/388/87) are unchanged, which is why they still reconcile.

**Why it matters.** The attached `records.csv` and the live site disagree, and **nothing on either says as-of what date**. A customer comparing them cannot tell which is authoritative. **Verdict: QUALIFY** — label both with an as-of date. *(This is expected behaviour for a system designed to keep running; it just isn't disclosed.)*

### 3.3 No data-age disclosure on the customer surfaces

**Evidence.** Freshness phrases found: homepage **0**, `/operations` **0**, `/shortlist` 3. Newest observation in the corpus: **9 August**. Per-record `lastObservedAt` exists in the API (e.g. 31 July) but there is no dataset-level statement anywhere.

**Verdict: FIX.** For a product whose pitch is freshness, the absence is conspicuous.

### 3.4 "Scheduled operation" table contains manual runs

**Evidence.** Trigger values in that table: **7 scheduled, 5 manual** — under a paragraph stating manual runs are excluded. Confirms your finding. **Verdict: FIX** (filter the table, or rename it "Recent runs").

### 3.5 `limit=abc` silently returns nothing

**Evidence.** `HTTP 200`, `returned=0`, `matched=581`. `NaN` propagates into `slice`. Customer sees an empty page with no error. `tier=99` and `freshDays=-1` are likewise accepted without validation. **Verdict: FIX.**

### 3.6 Two unstyled links on the homepage, and a spacing bug

**Evidence.** `page.tsx:54` renders bare `<a>` to Shortlist and Agent; `globals.css` has no rule for anchors inside `.coverage`, so they render browser-blue and purple-visited against the dark theme. Also the homepage reads **"the original 50 -record corpus"** — a stray space from the JSX interpolation.

Confirms your finding, and both are regressions from copy I wrote. **Verdict: FIX.**

---

## What I would keep, untouched

- **The refusal architecture.** Unknown firm → *"We do not hold any information on Wentworth Hall Family Office"*, no fabrication. Injection → no leak, no invented figure. The deterministic gate fires before the model sees input. This is resistance by design.
- **`unhonoured` constraints surfaced in the answer** — when the agent takes the `count_matching` path it names exactly what it could not do. That behaviour is right; it just isn't reliable.
- **Per-record `matched` / `missing` reasoning.** The idea is correct even though one string in it (1.1) is wrong.
- **The scope statement** — searched / matched / shown / excluded-with-reasons on every retrieval response.
- **The three-metric reachability paragraph on `/operations`**, which resists exactly the simplification a vendor would be tempted into.

---

## What I would qualify rather than fix

- **581 records with 198 at tier C** — disclose at onboarding, don't re-engineer.
- **54 strict routes** — state the number and the reason before a customer builds a workflow on it.
- **The Search tab's 50-record corpus** — it *is* disclosed on the page. The problem isn't honesty, it's that three denominators exist at all.

---

## Readiness call

**Not ready for a paying customer tomorrow. I reach the same conclusion you did, by a different route.**

Yours was that the customer product overstates qualification and permits uncontrolled access. Mine is narrower and, I think, more damaging: **the product makes specific false statements about evidence quality in exactly the surfaces built to prove evidence quality.** A badge saying "every value traced to a statutory source" on a record with LinkedIn-sourced evidence, and a filter labelled "statutory sources only" that filters nothing, are not polish items — they are the product contradicting its own thesis.

Ordering I'd defend:

1. **Truthfulness of displayed claims** — 1.1, 1.2, 1.3. Cheap, and until they're fixed every other improvement makes a misleading product look more finished.
2. **Access control and input validation** — 2.1–2.4.
3. **Agent denominator correctness** — 1.4. Architectural; needs the answer's scope to be a checked output.
4. **Data-age and version disclosure** — 3.2, 3.3.
5. **Everything else.**

The engineering underneath is better than the surface suggests. That's the frustrating part: the export layer already solved 1.1 with `worstSourceTier`, and the retrieval layer simply never received the fix.

---

Ready to combine this with yours into one file whenever you want. I'd suggest we keep both reviews distinct and attributed rather than merging them into a single voice — the fact that two independent passes converged on the tier problem from opposite directions is itself evidence, and merging would hide it.
