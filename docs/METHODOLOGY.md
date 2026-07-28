# Methodology

How the system found the records, how it enriched them, how I validated its
output, which source classes supported which kinds of claim, and the blind spots
that remain.

---

## 1. The rule that shaped everything

> Verification can prove facts about the firms you found. It cannot recover the
> firms your source never showed you.

I took this as the binding constraint and built four discovery channels with
deliberately different blind spots before doing any enrichment at all. The order
matters: breadth is the one property that cannot be added later.

| Channel | What it can see | What it is structurally blind to |
|---|---|---|
| SEC Form 13F quarterly datasets | US managers holding >$100M in listed equities | anyone below the threshold, or holding no listed equities |
| EDGAR full-text search (SC 13D/13G, Form D) | US filers of 5%+ stakes and private placements | firms that file nothing |
| UK Companies House | UK-registered entities, with statutory control data | everything outside the UK |
| Structured web search | firms with any public footprint anywhere | firms with none |

The first two are both SEC and share a blind spot. That is exactly why the other
two are not optional.

## 2. Discovery, channel by channel

### SEC 13F — a census, not a list

The obvious filter is a name match on "family". It returns 73 firms out of 9,861
and misses Cascade Investment, Bezos Expeditions, Bayshore Global and Willett
Advisors — that is, it misses precisely the invisible single-family offices worth
the most.

So the system scores structural signals instead:

- **no adviser CRD despite 13F-scale assets** — single-family offices rely on the
  family-office exclusion from adviser registration, so managing >$100M while
  holding no CRD is a real signal
- **entity clustering** — several filing entities registered at one address
- **concentrated book**, **no other included managers**
- **owner-operator signatory title** (Trustee, Managing Member) rather than Chief
  Compliance Officer, which implies a regulated adviser

This produced 1,173 candidates, **1,137 of which a name filter would never have
surfaced**.

The first version of this scorer was wrong, and reading its output is how I found
out. It ranked Khosla Ventures, Foresite Capital and Yorktown Energy in the top
twenty, because VC and PE firms also register several vehicles at one address —
one per fund. The tell that separates them is sequential naming: a family office
does not raise Fund V. The same fix caught `American Family Investments, Inc.`,
which had scored top-three on its name and is the investment arm of American
Family *Insurance*, sharing a Madison address with the insurer.

### EDGAR full-text — reaching firms 13F cannot

Five self-description phrases across SC 13D, SC 13G and Form D. 1,133 filings
matched, yielding 612 distinct parties, of which 486 were firms.

Position in a filing does not reliably indicate who filed it — I checked, and
found counter-examples — so every firm CIK is resolved against
`data.sec.gov/submissions/CIK*.json`, and the SEC's own `entityType` decides.
293 resolved as operating companies and were dropped; 193 investment vehicles
remained, **191 of them carrying a phone number published in a statutory filing**.

### UK Companies House — the strongest single-family evidence available

Advanced search over six SIC codes crossed with seven name fragments, then
`/officers` and `/persons-with-significant-control` for each hit.

PSC is a statutory register of who actually controls a company. That makes one
test available here that exists almost nowhere else: **when a company's name
carries a surname and its PSC carries the same surname, the entity is controlled
by that family.** That is affirmative evidence of single-family control from a
legal filing, not an inference from the words "family office" in a name.

### Web search — everything with no regulatory footprint

33 structured queries across conference programmes, job postings and news,
spanning twelve regions. Every extracted firm must carry a verbatim quote which is
then located in the page text **in code**. An extractor that cannot produce a
locatable quote has invented the firm and the record is dropped.

That check fires at a measurable rate: in the first run, **7 of 38 extractions
(18%) were discarded** because their supporting quote was not in the page.

## 3. Which source classes supported which claims

This separation is enforced in the type system: `Discovery` and `Evidence` are
distinct types, so a source that told us a firm exists is structurally prevented
from being the source that proves what it is.

| Claim | Source classes that may support it |
|---|---|
| the firm exists | any discovery channel |
| **what the firm is** | statutory registers (tier 1); the firm's own site (tier 1); recognised press (tier 2); profile databases only with corroboration (tier 3) |
| who controls it | UK PSC register only |
| registered address | SEC registration record; Companies House |
| phone | SEC registration record (published by the entity itself) |
| dated activity | SEC filing history; Companies House appointment dates |
| email | the firm's own site, then pattern derivation verified by SMTP, then Hunter — never a pattern presented as verified |

## 4. How I validated the AI's output

Three separate mechanisms, because they catch different failures.

**Fabrication — mechanical.** Every LLM-extracted claim must cite a verbatim span,
which is then located in the specific page it was attributed to. A quote lifted
from a different source cannot pass. A second check requires the span to carry
type-bearing language and to survive removal of the firm's own name — the
extractor was satisfying the rule by echoing `"DUQUESNE FAMILY OFFICE LLC"` back,
which is present in the page and establishes nothing.

**Untrue-but-real sources — tiering and reconciliation.** This one I got wrong
first, and a known-answer test caught it. Cascade Investment is documented as Bill
Gates's *single*-family office. Two runs quoted two sources, both verbatim, both
genuinely in their pages:

- `altss.com` — "a single-family office ... controlled by William H. Gates III"
- `preqin.com` — "Cascade Investment is a US-based **multi**-family office"

The pipeline asserted whichever the extractor happened to read. **Verifying that a
quote exists is not verifying that it is true.** I had built a fabrication check
and mistaken it for a truth check.

Each source is now read independently and produces its own claim; reconciliation
happens in code. Equal-standing sources disagreeing with no majority means the
claim is withheld. A majority wins but carries a 0.25 confidence penalty and the
dissent is stored in the record.

**Answers, as distinct from records.** The deployed system's answers are audited
separately — see `RAG_NOTES.md`. A correct record can still produce a wrong
answer.

## 5. Findings governed releases

Every value our own validation rejected went to `data/audit-rejected.json` and
none reached a customer-facing cell.

The largest single case: of 138 UK entities with statutorily confirmed
family-surname control, **83 failed the substance test** — 60 had never filed
accounts, 14 file as micro-entities, 4 as dormant, 5 are under two years old.
Every one is genuinely family-controlled, and a fund manager can act on none of
them. Reporting 138 would have been literally true and commercially worthless.

## 6. Blind spots that remain

**The contact paradox, which is the most important finding here.** The records
that are most valuable are the least reachable. A single-family office serving one
family has no website, no published email and no listed phone — that is what the
category *is*. Meanwhile the firms that do carry regulatory-grade phones are
mostly not family offices: type establishment across 332 phone-carrying SEC firms
returned only 9 family offices, because most 13F filers are hedge funds. The
brief's two demands — surface invisible single-family offices, and deliver
actionable contact data — are in genuine tension, and I have not resolved it. I
have reported it.

**No IRS 990-PF channel.** I expected private foundation filings to be my
strongest route: wealthy families run foundations, and the foundation is often
administered by the family office at its own address. ProPublica's API turned out
to return nonprofits *about* family offices and to expose no officer names. The
approach still holds but needs IRS bulk XML, which I did not build.

**Geographic concentration.** The UK channel is the most productive per query
because PSC data has no equivalent elsewhere. That is a real risk of inheriting
one source's view, and it is why the web channel was expanded across twelve
regions rather than left at its first pass.

**No AUM, thesis, or sector data.** Nothing in the free statutory sources carries
it, and I would not infer it. Those cells are honestly blank across the file, and
the deployed system refuses questions about them outright rather than answering
around them.

**Background and LinkedIn coverage is partial.** 32 of 50 records carry a
description, 12 a corporate LinkedIn page and 12 a principal profile. Seven
further descriptions were discarded for saying only what legal form the company
takes — "a private company limited by shares" is true of most of the file and
tells a reader nothing, so it is worth less than an honest blank.

**Deduplication is name-and-phone based.** A firm trading under a name materially
different from its registered name could appear twice. I saw one near-miss
(`Cascade Investments` and `CASCADE INVESTMENT, L.L.C.`) and did not build entity
resolution beyond normalised names and shared phone numbers.
