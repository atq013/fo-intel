# Build session summary

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
