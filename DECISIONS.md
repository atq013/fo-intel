# Decisions log

Running notes on what I chose, what I got wrong, and what changed my mind. Kept as
I worked rather than written afterwards, so the order is the order things actually
happened in.

## Direction and the calls that shaped the build

Set before or during implementation, and the reasoning behind each is in the
sections below.

- **Stack**: Next.js and TypeScript throughout, single workspace.
- **Geography**: global rather than US-only. The brief never restricts it and the
  reference sample is a third non-US, so restricting would have thrown away the
  least visible and most valuable firms.
- **Discovery**: four independent channels, adopted after measuring what a single
  convenient source actually costs.
- **Scoring**: structural signals decide what to investigate, never what a firm is.
- **Schema**: no high-value value ships without its basis; discovery sources are
  structurally separated from evidence sources.
- **Selection**: a 40% cap on any single channel in the delivered fifty.
- **Grounding**: answers decomposed into claims, each audited against its cited
  source by a different model family, failing closed.
- **Infrastructure**: Postgres with pgvector on serverless hosting, because a free
  container host cold-starts in ~50s and the live URL is a graded deliverable.
- **Refusal**: a deterministic gate for questions about fields the file does not
  hold, rather than a model judging relevance.
- **Process**: plan reviewed and approved before any code; every commit pushed by
  hand; no AI-attribution artifacts in the repository; completeness and a verified
  deployment prioritised over polish throughout.

---

## Discovery: breadth first, because breadth cannot be recovered later

The single instruction I took most seriously: a file discovered mostly through
one source inherits that source's blind spots, and no amount of verification
afterwards recovers the firms that source never showed me.

So I built four channels with genuinely different blind spots before doing any
enrichment at all:

| Channel | Sees | Cannot see |
|---|---|---|
| SEC 13F quarterly datasets | US managers over $100M in listed equities | anyone below the threshold, or holding no listed equities |
| EDGAR full-text (13D/G, Form D) | US filers of 5% stakes and private placements | firms that file nothing |
| UK Companies House | UK entities, with statutory control data | anything outside the UK |
| Structured web search | firms with any public footprint at all | firms with none |

The first two are both SEC and share a blind spot, which is why the other two are
not optional. I report the channel distribution rather than asserting diversity.

## Rejected: name matching

The obvious 13F filter is to search filer names for "family". It finds 73 firms
out of 9,861 — and misses Cascade Investment, Bezos Expeditions, Bayshore Global,
and Willett Advisors, which is to say it misses precisely the invisible
single-family offices that are worth the most.

I scored structural signals instead: no adviser CRD despite 13F-scale assets
(single-family offices rely on the exclusion from adviser registration), a
concentrated book, no other included managers, several entities registered at one
address. That produced 1,173 candidates, **1,137 of which a name filter would
never have surfaced**.

## Got it wrong: address clustering

My first run put Khosla Ventures, Foresite Capital and Yorktown Energy in the top
20. The address-cohort signal was supposed to catch family structures registering
several vehicles at one address — but VC and PE firms do exactly the same thing,
one vehicle per fund.

The tell that separates them is sequential naming. A family office does not raise
Fund V. Added a fund-sequence penalty and cohort contamination, and all three
dropped out.

The same fix caught a better one. `American Family Investments, Inc.` had scored
top-three on its name — it is the investment arm of American Family *Insurance*,
sharing a Madison address with the insurer. Name matching walks straight into
that. It now surfaces with an explicit flag that its cohort is contaminated.

## Rejected after testing: ProPublica for 990-PF

I expected private foundation filings to be my strongest channel — wealthy
families run foundations, and the foundation is often administered by the family
office at the family office's own address.

Searching ProPublica's API for "family office" returns 33 results that are mostly
nonprofits *about* family offices (Family Office University Network, Midwest
Family Office Forum). The API also exposes only financial fields, not the officer
and trustee names that made the idea valuable. The underlying approach still
holds but needs IRS bulk XML, which I have not built. Recorded here because I
told myself this was the best channel before I tested it.

## Schema: no high-value value is ever a bare primitive

Every one is a `Cell<T>` carrying value, status, evidence array, and confidence.
`Discovery` is a separate type from `Evidence` so that a source which told me a
firm exists is structurally prevented from being the source that proves what it
is.

Because the pipeline and the web app import the same type, the interface cannot
render a value without its provenance attached. That is what makes "every cell
carries its basis" a property of the system rather than a claim in a document.

## UK: 60% of family-controlled entities are shells

The PSC register gave me 138 UK entities where the company name and a controlling
person share a surname — statutory proof of family control, the strongest
evidence in the build.

Then I checked whether they were real businesses. 60 had never filed accounts, 14
file as micro-entities, 4 as dormant, 5 are under two years old. **83 of 138
failed.**

Every one of those is genuinely family-controlled. Not one is something a fund
manager could act on. I could have reported 138 and been literally correct. The
number is 55.

## The one that mattered most: my sources contradict each other

A known-answer test on Cascade Investment — definitively Bill Gates's
*single*-family office — returned this across two runs:

- `altss.com`: "a single-family office and private holding company controlled by
  William H. Gates III"
- `preqin.com`: "Cascade Investment is a US-based **multi**-family office"

Both quotes real. Both verbatim. Both located in their pages. My verification
passed both, and the pipeline asserted whichever the extractor happened to read.

**Verifying that a quote exists is not verifying that it is true.** I had built a
fabrication check and mistaken it for a truth check.

The fix reads each source separately, tiers sources by how much their
self-description is worth, and reconciles in code. Equal-standing sources
disagreeing with no majority means the claim is withheld. A majority wins but
carries a 0.25 confidence penalty and the dissent is recorded in the record.

I only caught this because I tested against firms whose answer I already knew.
That is the argument for building the gold set before scaling anything, not
after.

## Infrastructure decisions

**Public repository.** Their brief permits public or shared-with-them. I weighed
keeping it private, since the file names principals of firms whose defining
characteristic is that they avoid visibility, and UK records carry data-protection
weight. I went public because it removes a step and a failure mode from the
review: a collaborator invite can expire or go unaccepted, and a reviewer who
cannot open the repository cannot assess the work. The contact data in the file is
drawn from public statutory registers and firms' own published pages, so
publishing it re-publishes what is already public rather than exposing anything
new.

**Groq for bulk extraction, Gemini for answers.** Two separate constraints
happening to agree. Independence: the model that writes a RAG answer must not be
the model that checks it. Capacity: Gemini's free tier is a few hundred calls a
day and one discovery pass exhausted it. If the quota were raised the
independence rule would still hold.

Extraction runs on the small Groq model because the large one's tokens-per-minute
budget allows roughly one multi-page extraction per minute. Quality matters less
than it looks here — every quote is checked against source text mechanically, so
a weaker model produces more *withheld* claims, not more wrong ones.

**DNS resilience.** This machine's router returns intermittent SERVFAILs —
observed failing on `google.serper.dev` and `data.sec.gov` minutes apart while
public resolvers answered both. Unhandled it appears as random ENOTFOUND failures
scattered through a long run, indistinguishable from a source being down, quietly
costing records. Node's fetch uses getaddrinfo so `dns.setServers()` does not
help; the resolver had to be replaced at the socket layer.

I then lost a while debugging my own bug: undici calls `lookup` with
`{ all: true }` and expects an array, and I was returning a single address. The
live batch reports failures and recoveries as it runs, so the layer's value is
measured rather than assumed.
