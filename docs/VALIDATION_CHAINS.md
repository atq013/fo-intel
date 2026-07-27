# Validation chains

Three records, traced end to end: how the firm was found, how it was enriched,
what was validated and how, what confidence resulted, and the exact sources.

I picked these three because they exercise different evidence routes — one US
regulatory, one US regulatory with unusually explicit self-description, one UK
statutory register — and because two of them show the pipeline *refusing* to
assert something.

---

## 1 — Duquesne Family Office LLC

**Final classification:** `single_family_office`, confidence **0.93**, rule SFO-2.

### Discovery

Surfaced independently by **two** channels, which is why its confidence carries a
corroboration bonus:

| Channel | How |
|---|---|
| `sec_13f` | Appears in the Q3 2025 Form 13F quarterly dataset. Scored on structural signals — no adviser CRD despite 13F-scale assets, concentrated book. |
| `sec_13dg` | Appears in EDGAR full-text search for `"family office"` across SC 13D/13G filings. |

Neither channel classified it. **Structural signals carry zero qualifying weight**
— they justified investigating the firm and nothing more.

### Extraction

CIK `0001536411` resolved against `https://data.sec.gov/submissions/CIK0001536411.json`,
which returned the authoritative record: legal name, `entityType: other` (not an
operating company), registered address, phone, and full filing history.

### Enrichment

- **Address** `40 WEST 57TH STREET, 25TH FLOOR, New York, NY 10019` — from the SEC registration record.
- **Phone** `212-830-6500` — published by the entity in its own SEC registration. This is regulatory-grade contact data, not scraped.
- **Principal** Sue Meng, General Counsel — from the 13F signature block.
- **10 dated signals** from filing history, each linked to its EDGAR document.

### Validation

Three sources were read **independently** and each produced its own claim:

| Source | Tier | Claim | Quote located in that page? |
|---|---|---|---|
| `sec.gov/Archives/edgar/.../primary_doc.xml` | 1 (statutory) | single_family_office | yes |
| `linkedin.com/company/duquesne-family-office-llc` | 3 (profile database) | single_family_office | yes |
| — | — | — | — |

Reconciliation took the tier-1 source and added +0.08 for independent
corroboration: **0.85 → 0.93**.

An earlier run of this record is the reason the quote-informativeness check
exists. The extractor returned `"DUQUESNE FAMILY OFFICE LLC"` as its supporting
quote — verbatim, present in the page, and establishing nothing. A name is not
evidence. The check now requires the span to contain type-bearing language and to
survive removal of the firm's own name.

### Confidence assessment

0.93 is near the ceiling. A statutory filing in which the entity describes itself,
corroborated by an independent profile. The residual uncertainty is that SEC
filings do not have a "family office" field — the classification rests on the
filing's prose, not on a checkbox.

**Sources:** `https://data.sec.gov/submissions/CIK0001536411.json` ·
`https://www.sec.gov/Archives/edgar/data/1536411/000153641124000007/xslForm13F_X02/primary_doc.xml`

---

## 2 — PITON CAPITAL PARTNERS LLC

**Final classification:** `single_family_office`, confidence **0.85**, rule SFO-2.

This is the cleanest evidence in the dataset, and it demonstrates why full-text
search over filings beats any list.

### Discovery

`sec_13dg` only — EDGAR full-text search across SC 13D/13G. It does **not** appear
in the 13F census, so a 13F-only approach would have missed it entirely.

### Extraction and validation

The Schedule 13G/A filing contains this sentence, which the pipeline located
verbatim in the filed document:

> "The Reporting Person is a pooled investment vehicle formed for the benefit of a
> single family and cer[tain related persons]"

A firm stating in a statutory filing that it exists for the benefit of a single
family is the strongest self-description available short of a register entry.
Tier 1, no dissent, 0.85.

### Enrichment

- **Address** `C/O KOKINO LLC, 201 TRESSER BOULEVARD, 3RD FLOOR, STAMFORD, CT 06901`
- **Phone** `(405) 936-6220` — from the SEC registration record.
- **10 dated signals**, most recently an active 5%+ stake disclosure.

### What is honestly missing

**No named principal.** The 13G signature block did not yield one, and I did not
find one I could evidence. The cell is blank with the reason recorded rather than
filled with a plausible guess from the "C/O KOKINO LLC" line — Kokino is the
administering entity, and naming one of its people as Piton's principal would be
an inference presented as a fact.

**Sources:** `https://www.sec.gov/Archives/edgar/data/1023364/000110465920016295/tv537940_sc13ga.htm`

---

## 3 — FRANCIS FAMILY OFFICE LIMITED

**Final classification:** `single_family_office`, confidence **0.85**, rule **SFO-1**.

Different route entirely: no web source was consulted or needed.

### Discovery

`companies_house`. Found by advanced search filtering on SIC code `64209`
(holding companies) combined with the name fragment `family office` — not by
scraping a list of family offices, which is why the file contains firms no list
carries.

### Extraction

Company `12706913`. Three endpoints:
`/company/12706913`, `/officers`, `/persons-with-significant-control`.

### Validation — the surname-match test

The company name contains the token `francis`. The statutory PSC register names
**Mr Benjamin David Francis** as a person with significant control. Name and
controller share a surname, so the entity is controlled by that family.

This is affirmative evidence of *single*-family control from a legal filing —
not an inference from the words "family office" in the name, which would prove
nothing.

The PSC entry also records the nature of that control, and it ships in the record
verbatim:

> ownership of shares 75 to 100 percent; voting rights 75 to 100 percent; right to
> appoint and remove directors

### The substance test, which this record passed and 83 others failed

The PSC register proves who controls a company. It says nothing about whether
there is any capital behind it. Francis Family Office filed
`total-exemption-full` accounts to 2025-07-31 with five active officers, so it
passed.

Of 138 UK entities with confirmed family-surname control, **83 failed this test** —
60 had never filed accounts at all, 14 file as micro-entities, 4 as dormant.
Every one is genuinely family-controlled and not one is actionable. They are in
`data/audit-rejected.json`, not in the dataset.

### Enrichment

- **Address** `Gshq Blythe Valley Park, Solihull, B90 8AB`
- **Three named principals**: Benjamin David Francis (PSC), Joseph John Francis (Director), Steven John Francis (Director)
- **Three dated key-hire signals** from director appointment dates on the register

Benjamin Francis initially appeared **twice** — once as `Mr Benjamin David
Francis` from the PSC register, once as `FRANCIS, Benjamin David` from the officer
list. The two registers format names differently, so exact-string deduplication
missed it. Names are now compared as sorted token sets with honorifics stripped.

### What is honestly missing

**No phone, no email, no website.** Domain guessing and search both failed. This is
not a gap in the pipeline so much as the defining property of the category: a
single-family office serving one family has no reason to be reachable. The record
says so explicitly rather than leaving the user to wonder, and directs them to the
registered address.

**Sources:** `https://find-and-update.company-information.service.gov.uk/company/12706913`

---

## What these three show together

The two rules operate at different strengths. **SFO-1** (statutory control
register) reaches firms with no web presence at all but is UK-only. **SFO-2**
(self-description in a filing or credible source) reaches anywhere but depends on
the firm having said something quotable.

Both produce records with an address and named people. Only the SEC route reliably
produces a phone number — which is the finding, not the failure: the firms that
are hardest to reach are exactly the ones the brief identifies as most valuable.
