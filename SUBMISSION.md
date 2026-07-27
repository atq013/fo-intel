# Stage 1 submission — Attique Ur Rehman

## Deliverables

| Required | Where |
|---|---|
| Dataset, 50 validated records | `data/fo-dataset.csv` (also `.json` with full provenance) |
| Methodology summary | `docs/METHODOLOGY.md` |
| Three full validation chains | `docs/VALIDATION_CHAINS.md` |
| Working repository | this repo, shared with optimize@falconscaling.com |
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
| Single-family offices | 48 |
| Multi-family offices | 2 |
| Named principal | 45 |
| Two or more named principals | 23 |
| Statutory control basis recorded | 23 |
| Registered street address | 28 |
| Dated activity signals | 28 |
| Direct phone number, from a statutory filing | 6 |
| Confirmed website | 1 |
| Verified email | 0 |

Primary discovery channel: Companies House 46%, conference programmes 20%, news
18%, SEC 13F 6%, SEC 13D/G 6%, job postings 4%. Country: United Kingdom 23,
United States 8, Kuwait 1, not established 18.

The qualifying pool was 82. The delivered 50 were selected under a 40% per-channel
cap so the file could not read as one registry copied at scale; the other 32 are in
`held-back.json` with the reason.

**That cap has a cost worth stating.** Companies House records are the most
complete ones — they carry the addresses, the statutory control evidence and the
appointment signals. Capping them traded per-record completeness for source
diversity. Before the cap, 60 of 82 records had a street address; after it, 28 of
50. I judged the sourcing rule to be the binding constraint, since the brief says a
file discovered mostly through one source does not advance regardless of how well
each record is verified.

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
rate. It catches true-but-unsupported claims — asked who runs Duquesne, the model
drafted "Stanley Druckenmiller", which is true in the world and unsupported by the
record, and the independent auditor rejected it.

## Honest limitations

- **Contact coverage is 6 of 50 for direct phone lines and 0 for email.** This is
  the market, not the method: single-family offices have no reason to be
  reachable. Tested rather than assumed — the obvious domains often resolve but
  serve nothing (`francisfamilyoffice.com` returns a 114-byte parked page,
  `kopp.com` accepts no HTTPS connection). What 45 of 50 records do carry is a
  named principal, and 28 a registered postal address, which is a slower contact
  route rather than no contact route. Documented in `METHODOLOGY.md`.
- **No AUM, sector, or thesis data.** No free statutory source publishes it. Those
  cells are blank throughout rather than inferred, and the deployed system refuses
  questions about them explicitly.
- **No IRS 990-PF channel.** Expected to be the strongest route and abandoned after
  testing showed the API returns nonprofits *about* family offices and exposes no
  officer names.
