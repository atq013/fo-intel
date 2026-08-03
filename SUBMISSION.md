# Stage 1 submission — Muhammad Attique Ur Rehman

> **This is the Stage 1 index, kept as history.** The current submission is Stage 2 —
> see [`docs/ACCEPTANCE_M3.md`](docs/ACCEPTANCE_M3.md) for the requirement-to-evidence
> matrix and the deliverable index. Counts below are Stage 1's 50 records and are
> not the current dataset.

## Deliverables

| Required | Where |
|---|---|
| Dataset, 50 validated records | `data/fo-dataset.csv` (also `.json` with full provenance) |
| Methodology summary | `docs/METHODOLOGY.md` |
| Three full validation chains | `docs/VALIDATION_CHAINS.md` |
| Working repository | this repo, public |
| Live customer-facing URL | https://fo-intel-web.vercel.app |
| RAG documentation note | `docs/RAG_NOTES.md` |
| Task 2, SaaS conversion analysis | `docs/TASK2_CONVERSION.md` |
| Build session summary | `docs/BUILD_SESSION_SUMMARY.md` |

Supporting: `docs/INCLUSION_RUBRIC.md` (what qualifies a firm and why),
`DECISIONS.md` (running log of choices and corrections), `data/audit-rejected.json`
(values our own validation rejected), `data/held-back.json` (qualifying records not
delivered, with reasons), `data/rag-eval.json` (adversarial evaluation results).

## The dataset

50 firms, each qualifying on affirmative evidence of what it is rather than on the
absence of evidence that it is not. Every figure below is generated from the
delivered file by `packages/pipeline/src/emit/stats.ts` — run it to reproduce them.

| | of 50 |
|---|---|
| Single-family offices | 49 |
| Multi-family offices | 1 |
| Named principal | 47 |
| Two or more named principals | 20 |
| Statutory control basis recorded | 20 |
| Registered street address | 25 |
| Dated activity signals | 25 |
| Background description | 32 |
| Confirmed website | 14 |
| Corporate LinkedIn | 12 |
| Principal LinkedIn | 12 |
| Direct phone number | 10 |
| Verified email | 4 |

**Primary discovery channel:** Companies House 40%, conference programmes 30%,
news 18%, SEC 13F 6%, SEC 13D/G 6%. No channel exceeds 40%, which is the cap.

**Country:** United Kingdom 22, United States 12, Singapore 2, and one each from
India, Kuwait, Hong Kong, Japan and Saudi Arabia. 9 records have no country
established — a blank rather than a guess.

The qualifying pool was 90. The delivered 50 were selected under a 40%
per-channel cap so the file could not read as one registry copied at scale; the
other 40 are in `held-back.json` with the reason recorded.

**That cap has a cost worth stating.** Companies House records are the most
complete ones — they carry the registered addresses, the statutory control
evidence and the appointment signals. Capping that channel traded per-record
completeness for source diversity: across the full qualifying pool 60 of 90
records have a street address, but in the delivered 50 it is 25.

I judged the sourcing rule to be the binding constraint. The brief states that a
file discovered mostly through one source does not advance *regardless of how well
each record is verified*, so a more complete file drawn mainly from one registry
would score worse than a slightly thinner one drawn from five sources.

## Three things worth reading first

**The dataset is 50 of 1,509 candidates.** Structural signals from SEC filings —
no adviser CRD despite 13F-scale assets, entity clustering, concentrated books —
were treated as reasons to investigate a firm and never as evidence of what it is.
946 firms sit at `unconfirmed` because nothing affirmatively established them.

**Verifying that a quote exists is not verifying that it is true.** A known-answer
test on Cascade Investment returned "multi-family office" from one source and
"single-family office" from another, both verbatim and both genuinely on their
pages. The pipeline was asserting whichever it read first. Source tiering and
reconciliation came out of that correction, and it is documented in full.

**The grounding control is measured, not asserted.** 15 adversarial cases, two
thirds of which the system is supposed to refuse: 14 correct, 0% false negative
rate, 0% false positive rate. It catches true-but-unsupported claims — asked who runs Duquesne, the model
drafted "Stanley Druckenmiller", which is true in the world and unsupported by the
record, and the independent auditor rejected it.

## Honest limitations

- **Contact coverage is 10 of 50 for direct phone lines and 4 for email.** This is
  the market, not the method: single-family offices have no reason to be
  reachable. Tested rather than assumed — the obvious domains often resolve but
  serve nothing (`francisfamilyoffice.com` returns a 114-byte parked page,
  `kopp.com` accepts no HTTPS connection). What 47 of 50 records do carry is a
  named principal, 32 a background description, and 25 a registered postal
  address, which is a slower contact route rather than no contact route.
  Documented in `METHODOLOGY.md`.
- **No AUM, sector, or thesis data.** No free statutory source publishes it. Those
  cells are blank throughout rather than inferred, and the deployed system refuses
  questions about them explicitly.
- **No IRS 990-PF channel.** Expected to be the strongest route and abandoned after
  testing showed the API returns nonprofits *about* family offices and exposes no
  officer names.
