# Attempt 2 — after the three structural fixes

Run 31 Jul 2026 17:55 UTC against https://fo-intel-web.vercel.app/api/agent,
commit `473d9e8`. Prompts identical to attempt-1; Goal 2 verbatim from the brief.
Nothing edited after execution.

| goal | attempt 1 | attempt 2 |
|---|---|---|
| 1 · multi-step commercial search | PASS | **PASS** |
| 2 · uncertain data (verbatim) | **FAIL** — relevance presented as 99.93% confidence | **PASS** |
| 3 · paid-tier | PARTIAL — empty result read as "nothing withheld", internals leaked | **PARTIAL** — internals fixed, unsupported claim remains |

## What the fixes changed

**Goal 2** now says: *"Confidence in their fit is low due to missing mandate,
sector, allocation, cheque size, or LP data."* Attempt 1 said 0.9993. Confidence
is now tied to the absence of the specific evidence the question needs, and the
proxy shortlist is offered only after stating what was unavailable.

**Goal 3** — `check_evidence` rejected both invented fields (`contactRoute`,
`validationGates`) with `validationError: true` instead of returning an empty
success. The `0 rows and 0 data` phrasing is gone.

## What is still wrong

**Goal 3 repeats the unsupported claim.** Both `check_evidence` calls failed
validation and returned *"This result says NOTHING about whether values were
withheld"*, and the agent still wrote *"The validation gates did not refuse to
publish any information about BOSTON FAMILY OFFICE LLC."* The statement is true —
the firm holds 9 released and 0 quarantined claims — but it was not established
by any call the agent made. Tool-level fail-closed worked; the composer drawing
a conclusion the tool explicitly disclaimed did not.
