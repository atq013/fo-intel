# Build session summary — Stage 1


**Time.** Roughly 22 hours: about three to four spent reading & understanding the brief,
the sample schema and settling the approach between receiving the assessment at
17:46 on Sun 26 Jul and starting to build at ~21:45, then roughly 18 hours of
build sessions, including time waiting on pipeline runs.

**Sessions**, as they appear in the commit history:

- *Sun 21:45 – Mon 02:00* — source strategy, record schema, the two SEC discovery
  channels, Companies House with PSC control evidence, classification rubric.
- *Mon 09:15 – 16:10* — source tiering after a known-answer test caught a false
  assertion; database, RAG layer, product, deployment; channel rebalancing and
  adversarial evaluation.
- *Mon 19:30 – Tue 01:40* — widened result sets and scoped the field gate after a
  defect surfaced in the deployed system rather than the test suite.
- *Tue 11:00 – 12:20* — background and LinkedIn enrichment; hardened the answer
  model fallback after both primaries hit daily token ceilings.

**What AI produced, and what I decided on top of it.** I used AI for most of the
implementation. I defined the structure, set the order of work, and made the calls
that shaped it: Next.js and TypeScript; global geography rather than US-only, which
is why the file reaches Singapore, Kuwait, Japan, Hong Kong, India and Saudi
Arabia; four independent discovery channels, after measuring that name-matching
finds 73 firms of 9,861 and misses Cascade Investment and Bezos Expeditions;
structural SEC signals used to choose which firms to investigate, never to assert
what one is; a schema where no value ships without its basis; a 40% cap on any
single channel in the delivered 50; and a grounding control that splits every
answer into claims and audits each against its cited source using a different
model family.

Corrections against AI output: dropped the IRS 990-PF channel after testing showed
it returns nonprofits *about* family offices; rejected 83 of 138 statutorily
family-controlled UK entities as shells with no filed accounts; stopped embedding
raw evidence quotes after a scraped fragment became citable as fact; replaced
hand-typed figures with generated ones; filtered records where extraction returned
a person's job title instead of a firm name.

**What I would do differently.** Design the source-trust model before writing any
extraction code. The worst defect was a category error, not a bug: I had built a
check that a quote appeared in its source and mistaken it for a check that it was
true. Two databases disagreed about Cascade Investment — both verbatim, one wrong —
and the pipeline asserted whichever it read first. Adding source tiering late meant
redoing work done on a wrong assumption. Second, I optimised discovery breadth
before measuring contact yield, then found the tension in the task: the
single-family offices worth most are exactly those hardest to reach. That is a
portfolio composition question and should have been modelled at the start.


---

# Build session summary — Stage 2

**Time.** Roughly 34 hours across five days, 30 Jul to 3 Aug, of which perhaps
nine were hands-on-keyboard and the rest was the system running and me reading
what it produced. Not padded: the operating window is mostly elapsed time, and
the brief asks for the real figure.

**Sessions**, from the commit history:

- *Thu 30 Jul* — Stage 2 spec and roadmap before any code; reachability spike
  measuring five channels; contract schema, evidence binding, gates 1–6;
  Companies House collector; scheduled jobs deployed by end of day two.
- *Fri 31 Jul* — SEC 13F signatory collector; evidence-aware shortlist; the
  bounded agent; three agent-correctness defects found and fixed structurally.
- *Sat 1 Aug* — discovery pagination and SIC-filter bug found (the register was
  never the ceiling); expanded pool climbed to 614; cost instrumentation;
  output guards.
- *Sun 2–3 Aug* — postal re-adjudication, qualification-risk review, URL audit,
  navigation and UI corrections, final exports and packaging.

**What AI produced, and what I decided on top of it.** AI wrote most of the
implementation. The decisions that shaped it were mine: separating reachability
into three metrics that are never merged (ADR-11, ADR-12) rather than reporting
one flattering number; refusing to lower the qualification standard when the
count was short; treating a duplicate-key failure as my application defect rather
than presenting it as the brief's required dependency failure; and ordering the
final days around auditing what had been built rather than building more.

**Corrections against AI output.** The load-bearing ones, all visible in the
session record:

- It proposed accepting a 500-record shortfall as a ceiling. The ceiling was a
  bug — searches never paginated, and a SIC filter chosen by assumption excluded
  ~95% of matches. `"family office"` filtered returns 11 hits; unfiltered, 286.
- It reported "3 of 3 re-read records had changed" as evidence the refresh loop
  was working. The sample was three because the rotation never rotated: 543 of
  546 records had never been re-read once.
- It wrote a postal-route audit whose registered-office test compared the *city*,
  flagging 224 of 276 routes. Corrected to compare postcode and street — 132 real
  matches, and postal reachability fell from 207 to 93 (87 in the final file).
- Four of the seven output guards needed correcting after they shipped, in both
  directions: one too permissive, one too aggressive, one comparing the answer
  against the wrong text, one firing on shared vocabulary rather than quoted
  instructions.
- It classified `THE LAW FAMILY OFFICE LLP` as a law firm. It is the Law family's
  office.

**The number I trust least.** The final count of **581 qualifying entities** — not
because I know it is wrong, but because it grew substantially during the final
discovery expansion and I have not manually reviewed every new record. What would
check it: a complete source-level audit showing records added per source,
deduplication results, evidence coverage, classification reasons, and a stratified
manual review of the newly added records, specifically checking that banks,
general asset managers, advisers, law firms and other service providers were not
classified as family offices without explicit supporting evidence. **That audit
now exists** — `exports/audit-source-level.csv` — and running it is what took the
count down in two rounds. The first withheld ten institutions -- two insurers,
two family law firms, a tax practice, an IFA, two grantmaking foundations and a
consultancy. The second, prompted by an external audit, found the deeper problem:
the commercial floor never asked for evidence that a firm was a family office at
all, only that its record was complete. That had admitted a bakery, a funeral
home, a golf club, a rail-supplies company, two acquisition shells and eleven
hedge funds. Qualification now requires affirmative evidence at one of three
stated tiers and a named individual is mandatory, and further collection under
that standard brought the file back to **581**.

Second least certain: the **87 postal routes**. Some addresses may be registered
offices, service addresses or shared professional addresses rather than a
practical route to the named individual. `exports/audit-postal-routes.csv` lists
every route with its named person, full address, address-reuse count and
registered-office match; 130 routes were cleared from the count on that basis
before submission.

**What I would do differently.** Design the reachability metric before building
the collectors. The postal channel was built, counted, reported and then had to
lose 55% of its routes to a comparison rule that should have existed on day one.
The same is true of the qualification exclusions: the rubric listed banks and
insurers but not law firms or foundations, and that gap survived until the final
review because nothing forced me to enumerate the classes before scaling.

## Manual review, and what I did not review

**Question: what did you personally review?**

I personally reviewed the final customer-facing production pages, including the
operations, shortlist/retrieval and agent experiences, after the final
deployment. I tested their main actions and checked that the displayed totals
matched the final production metrics.

I also reviewed the final README, architecture notes, acceptance matrix, build
summary, operating-window evidence, goal-trace summaries and export files for
completeness and consistency.

I did not manually inspect every field across all 581 qualifying records, every
line of the AI working-session transcript, every log line across all scheduled
executions, or every postal route individually. Those areas were verified through
automated tests, database invariants, source-level audits, exported counts and
targeted manual sampling.

**A finding from that review.** During my final manual review, I found that the
homepage still described and searched the original 50-record Stage 1 corpus,
while the Stage 2 product had expanded well beyond it. Simply
replacing 50 with the Stage 2 total would have misrepresented the search coverage. The page was
corrected to display the current Stage 2 totals, disclose that the legacy
plain-English search covers the original 50 records, and direct full-dataset
searches to Shortlist and Agent.

## Final state

| | |
|---|---|
| active unmerged entities | 740 |
| qualifying | **581** |
| strict reachable | 54 |
| profile-assisted reachable | 388 |
| postal reachable | 87 |
| any defensible route | 420 |
| unassessed | 0 |
| tests | 127 passing |

Reconciled across database, `exports/records.json`, `exports/records.csv` and the
live product by `packages/pipeline/src/jobs/reconcile.ts`, which exits non-zero
if any surface disagrees.

**Operating window: all three conditions met.** Two or more scheduled runs across
48 hours — met, 44 scheduled runs spanning 94.8 hours. A real dependency failure
— met, a Neon connection dropped mid-run, logged and survived. A cross-run
staleness event detected by a scheduled run — **met**, and it arrived late: for
most of the window this was unmet, because the refresh rotation never rotated and
543 of 546 records had never been re-read. After that was fixed, a scheduled
`discover` run on 3 August detected 7 content-hash changes against readings from
two days earlier. Nothing was manufactured; the condition was reported as unmet
right up until the system actually met it.

**What is still unmet: ≥200 reachable on the strict metric.** Stage 1 defined a
confirmed contact route as a direct phone or verified email. By that definition
the count is 54. SEC 13F signature blocks are the only free statutory source
publishing personal phone numbers and were exhausted across four quarters; SEC
ADV, IAPD and Companies House publish none; Hunter's free tier resets after the
deadline. The count could have been raised to 68 by re-admitting eleven hedge
funds, a VC firm, a large RIA and a foundation that carry 13F phone numbers —
they were withheld instead, because reachability is not a reason to call
something a family office.
