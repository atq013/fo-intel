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

**Time.** ~34 hours across 30 Jul – 3 Aug; roughly nine hands-on, the rest the
system running. Not padded.

**Sessions.** Spec, contract schema and gates, then the Companies House and SEC
collectors and scheduled jobs deployed by end of day two; shortlist and agent on
day three; discovery and cost work on day four; audits and packaging on day five.

**AI, and my decisions on top.** AI wrote most of the implementation. Mine: three
reachability metrics never merged; refusing to lower the qualification standard
when the count was short; recording a duplicate-key failure as my defect rather
than the brief's required dependency failure; spending the last two days auditing
rather than building.

**Corrections against AI output.** It called the 500 shortfall a ceiling — it was
a bug (no pagination, and a SIC filter excluding 95% of matches). It cited "3 of 3
re-read records changed" as proof the refresh loop worked; the sample was three
because the rotation never rotated and 543 of 546 records had never been re-read.
Its postal audit compared cities rather than buildings; corrected, postal fell
207 → 87. Four of seven output guards needed fixing after shipping.

**The number I trust least: 581.** It grew late and I have not hand-checked every
record. What would check it is a source-level audit with deduplication and
classification reasons — `exports/audit-source-level.csv` — and running it is what
removed a bakery, a funeral home, a golf club and eleven hedge funds that had
qualified on an address and a director. Next least certain: the 87 postal routes
(`exports/audit-postal-routes.csv`).

**Would do differently.** Define the qualification standard before scaling
discovery. The floor asked whether a record was complete, never whether the firm
was a family office, and that survived until an external audit found it.

**Review.** I personally reviewed the production pages, tested their main actions,
and checked displayed totals against production; also the README, architecture
notes, acceptance matrix, operating-window evidence, goal traces and exports. **I
did not** inspect every field across all 581 records, every line of the AI
transcript, every scheduled log line, or every postal route — those were covered
by tests, invariants, the audits above and sampling. That review found the
homepage still describing the original 50-record corpus; it now shows current
totals and says which search covers what.

**Final:** 740 entities · **581 qualifying** · 54 strict · 388 profile-assisted ·
87 postal · 127 tests. All three window conditions met, the third late. **Unmet:
≥200 reachable** — Stage 1 defined that as phone or email; this file has 54, and
it could have been 68 by re-admitting the hedge funds. It was not.
