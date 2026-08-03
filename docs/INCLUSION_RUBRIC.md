# Inclusion rubric

What has to be true before a firm is allowed into the dataset, and what each
label means. Rule ids here match `packages/pipeline/src/classify/rubric.ts`; if
the two ever disagree, the code is what actually ran.

## The governing principle

A firm qualifies on **affirmative evidence of what it is**. Never on the absence
of evidence that it is something else.

This is stricter than the standard I hold individual cells to, and deliberately
so. A cell may be honestly blank — I looked, I could not establish it, I say so.
A firm may not be honestly ambiguous and still ship as a family office, because
the whole record is worthless if the entity behind it is not what the label
claims. A perfectly verified email address on a misclassified firm is worse than
no record at all: it is a confident falsehood, and a client acting on it wastes a
relationship.

So the pool is allowed to be large and the qualifying set is not. As of the last
run, 1,323 firms in the pool and 65 qualifying. That ratio is the rubric working,
not the pipeline underperforming.

## Categories

**`single_family_office`** — exists to manage the wealth of one family. Typically
has no client-acquisition surface: no fee schedule, no "become a client" page, no
marketing to prospective clients. Often no website at all.

**`multi_family_office`** — serves several unrelated families as clients and
markets that service. A legitimate record, but a less valuable one: these firms
want to be found, so they are already in every list.

**`advisory_or_wealth_manager`** — excluded. Serving wealthy clients is not the
same as being a family office. An RIA with two hundred high-net-worth clients is
a wealth manager whatever its name says.

**`unconfirmed`** — discovery surfaced it, evidence did not establish it. **Does
not count toward the 50.** This is the correct home for most of the pool.

## Qualifying rules

### SFO-1 — statutory control register (confidence 0.85)

A company's name carries a surname, and a statutory register of controlling
persons names an individual with that same surname.

Currently sourced from the UK Persons with Significant Control register. This is
the strongest evidence available anywhere in the build, because it is not an
inference from naming or a firm's description of itself — it is a legal filing
naming who controls the entity.

Requires the substance test below.

### SFO-2 — the firm or a credible source says so (confidence by source tier)

A cited source states that the firm is a single-family office, with a verbatim
quote located in that source's own page text.

Confidence comes from the source tier, not from the claim:

| Tier | Source | Base confidence |
|---|---|---|
| 1 | The firm's own domain, or a statutory registry | 0.85 |
| 2 | Recognised financial press | 0.70 |
| 3 | Third-party profile database (Preqin, Altss, Crunchbase, Wikipedia, LinkedIn) | 0.50 |
| 4 | Unranked web source | 0.30 |

Independent agreement adds 0.08. A lower-ranked source disagreeing subtracts
0.15. **A source of equal standing disagreeing subtracts 0.25**, because that is
the strongest warning available.

**Qualifying threshold is 0.55.** In practice that means either one tier-1 or
tier-2 source, or at least two agreeing tier-3 sources. A lone profile-database
entry never qualifies a firm on its own.

### MFO-1 — multi-family office (confidence by tier, same scale)

A cited source states the firm serves multiple families, or the quote contains
explicit client-acquisition language.

## Exclusion rules

Any exclusion firing disqualifies the record regardless of other evidence.

- **X-1** — SEC classifies the entity as `operating`, i.e. an operating business
  rather than an investment vehicle.
- **X-2** — the name identifies a bank, insurer, broker, pension, university, or
  public institution.
- **X-3** — a sequentially numbered fund vehicle (`Fund IV`, `Partners X, L.P.`).
  A family office does not raise Fund V.
- **X-4** — a UK entity failing the substance test.

## The substance test

A UK entity passes only if it has filed accounts, those accounts are not
`dormant` or `micro-entity`, and it was incorporated at least two years ago.

This exists because the PSC register proves family *control* and says nothing
about whether there is any capital behind it. Of 138 UK entities with confirmed
family-surname control, **83 failed this test** — 60 had never filed accounts at
all. They are genuinely, statutorily family-controlled companies, and a fund
manager cannot act on a single one of them.

Reporting "138 family-controlled UK family offices" would have been literally
true and commercially worthless. The number that matters is 55.

## What explicitly does not qualify a firm

Structural signals from SEC filings — no adviser CRD despite 13F-scale assets, a
concentrated book, several entities registered at one address — are **discovery
signals only**. They carry zero qualifying weight.

They are good enough to justify spending a search and three page fetches
investigating a firm. They are not good enough to assert what it is. The
distinction is the entire difference between a dataset and a list of plausible
guesses, and it is why 946 firms sit at `unconfirmed` rather than being labelled
on structure alone.

## Verification and sampling

Every qualifying record carries, per high-value cell, the source URL, the source
class, the method by which it was confirmed, and the date observed. Firm-level
classification additionally carries the rule ids that fired and the full set of
source claims — **including claims that lost reconciliation**, so a disagreement
between sources is visible in the record rather than hidden by it.


---

# Stage 2 inclusion standard — the three evidence tiers

The brief requires a defined minimum inclusion standard. This is it, stated so a
reviewer can grade each record against it rather than take a count on trust.

**Every qualifying record must carry all of:** a legal name, a country, **a named
individual**, and at least one of a city or a website — each value released by the
six gates with its own evidence span. A named individual is mandatory, not one of
several optional fields, because the brief's floor is a contact route reaching a
named person and a record without one cannot satisfy it.

**And it must carry affirmative evidence that the firm is a family office**, at one
of three tiers. The tier is visible per record in `exports/records.csv`
(`classification`, `classificationBasis`) and countable from
`exports/records.json`.

### Tier A — statutory control evidence

A statutory control register names an individual whose surname appears as a whole
token in the company name, and the name identifies a family wealth vehicle. The
gate re-runs the rule at validation time (`family_surname_control`), so a label it
cannot reproduce does not release. **This is the strongest tier available and it
is a legal filing about who controls the entity, not an inference.**

### Tier B — the firm's own registered name

The legal name on a statutory register says "family office". A firm's registered
name is its own description of itself, recorded by a regulator. For SEC
registrants this additionally implies a *multi*-family office or adviser, because
Rule 202(a)(11)(G)-1 excludes single family offices from registration.

### Tier C — a registered family wealth vehicle, control not evidenced

The registered name identifies a family wealth vehicle — family investment,
capital, wealth, partners, trust, trustees, assets or ventures — but no control
register names an individual whose surname matches.

**This is the weakest tier and it is included deliberately, with its weakness
stated.** A family-named holding company is not proof of a family office, and
Stage 1 was criticised for exactly that inference. These records are therefore
**never given an `entityClassification`**: they appear in the file as qualifying
and visibly unclassified, so anyone recomputing can separate them in one pass.
Of the 581 qualifying records, **280 carry a tier-A classification and 301 do not** — 103 at tier B and 198 at tier C.

### Excluded outright

- **No family-wealth-vehicle name and no classification.** This removed a bakery,
  a funeral home, a golf club, a rail-supplies company, two acquisition shells and
  several hedge funds — all of which had previously qualified on an address and a
  director alone.
- **Institutions that are not family offices whatever their name says**: insurers,
  banks, family law firms, tax practices, IFAs, consultancies and grantmaking
  foundations.

The vehicle words must sit **adjacent** to "family": `FAMILY LEISURE HOLDINGS` and
`HUGHES (FAMILY BAKERS) HOLDINGS` both contain "family" and "holdings" and neither
is a family wealth vehicle.
