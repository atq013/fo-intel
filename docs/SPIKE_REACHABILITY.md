# Phase 0 · Reachability feasibility spike — results

Run 30 Jul, ~1h45 of a 2h budget. Method fixed in `STAGE2_SPEC.md` §15 D1 before
collection. No channel's method was adjusted after seeing its result.

**Question:** can ≥200 of 500 records carry a contact route that demonstrably
reaches a named individual, using public sources?

---

## Measured results

| Channel | Attempted | Person identified | Route found | Ownership evidenced | **Passes gate 5** | Cost/qualified |
|---|---|---|---|---|---|---|
| SEC 13F signatory | 9,874 census | 9,874 | 9,874 | 6,940 | **6,582** | 0 calls (local) |
| SEC signatory ∩ confirmed FO | 6 | 6 | 3 | 3 | **3 (50%)** | 0 calls |
| Firm leadership page | 26 | 13 (mostly junk) | 6 | 0 | **0 (0%)** | 20 calls, no yield |
| Verified principal profile | 50 | 47 | 12 | 10 | **10 (20%)** | ~2 calls |
| SEC ADV Schedule A | 3 filings | 3 | **0** | 0 | **0 (0%)** | ~1MB PDF each, slow |
| Conference / speaker page | not measured | — | — | — | — | budget exhausted |

### Channel notes

**SEC 13F signatory — high precision, structurally limited reach.**
My stated prior was that these numbers would be firm switchboards and fail
ownership. That was wrong. Of 9,874 unique firm+person routes, 6,940 adjudicate to
an individual. Exclusions are principled and deterministic:

- 2,901 numbers filed by more than one filer → administrator lines (one number
  covers 18 JPMorgan entities)
- 20 signatories that are not natural persons
- 13 numbers shared by two signatories at the same filer

The channel is sound. Its limit is **reach**, not ownership: it can only ever cover
US 13F filers. Coverage on the delivered 50 splits absolutely —

| Origin | Firms | With a route |
|---|---|---|
| SEC-derived | 6 | **3 (50%)** |
| UK registry | 20 | **0** |
| Web-derived | 24 | **0** |

A UK company or a Gulf family office cannot appear in a US filing census. That is
not a gap effort closes.

**Title mix is a second constraint.** Across all surviving routes: 27%
decision-makers, **45% back-office** (compliance, controller, counsel), 28% other.
Spec D2 requires a "named human decision-maker". A General Counsel is a named human
who can be reached; calling them a decision-maker would be the label inflation
Correction 4 warns against.

**Firm leadership page — measured zero, and the probe itself was defective.**
Two firms initially scored PASS. Both are false positives: the extracted "people"
were *"Community Appointing"* and *"Initial Contact"*, page furniture caught by a
regex matching capitalised pairs near title words. The routes found were `info@`,
`contactus@`, and `hi@tracxn.com` — an aggregator's own address on a page about the
firm.

Corrected yield: **0 of 26**. Person identification partially works (Michael Larson
at Cascade is genuinely correct); binding a route *to* that person does not. For
this population the pages either do not exist or do not publish person-level
routes.

**SEC ADV Schedule A — strong for identity, zero for contact, and the finding is
structural rather than statistical.**

Schedule A lists direct owners and executive officers with named individuals,
titles, ownership codes, and a control-person flag:

```
FULL LEGAL NAME | DE/FE/I | Title or Status | Date Acquired | Ownership | Control | CRD
ADELL, STEPHEN, DECATUR |   I   |   PRINCIPAL   |   01/1995   |    B     |    Y    | 2115641
```

**There is no contact column.** Across the filings retrieved: 0 person-level email
addresses. The only phone numbers present are the firm's Item 1 contact details.
This is not a sampling result — the form has no field for individual contact data,
so no amount of scale changes it.

Gate 5 yield: **0**.

The channel is nonetheless valuable for a *different* requirement. A Schedule A
principal carries an ownership code and a control-person flag, which is a far
stronger basis for spec D2's "named human decision-maker" than a 13F signature
block where 45% of signatories are compliance and back-office staff. It is an
identity channel, not a reachability one, and should be used as such.

**Verified principal profile — the surprise, and the best cost/yield ratio.**
Stage 1 shipped 12 profiles across 50 records. A deterministic slug check — does
the profile URL encode the named person's name — passes 10 and rejects 2.

Those 2 rejections are **exactly the wrong-person links the Stage 1 feedback
identified**: `David Blitzer → jonas-cohon`, `Rodger Riney →
bobby-w-sandage-jr-phd-69087211`. A check costing microseconds catches, before
release, the defect a human reviewer found after submission.

**Yield: 10/50 = 20%, at ~2 API calls each.**

---

## Projections at 500 records

| Channel | Projected | Confidence | Basis |
|---|---|---|---|
| SEC signatory | **~60** | **medium** | 50% coverage of SEC-derived FOs; Stage 1 structural scoring found ~1,173 candidates converting at ~10% → ~120 SEC family offices available |
| Verified profile | **~100** | **low–medium** | 20% of 50 extrapolated; unproven at scale and the population shifts as the file grows |
| Leadership page | **~0–15** | **low** | measured 0; a corrected extractor might recover some, unquantified |
| ADV Schedule A | **0** | **high** | structural: the form has no individual contact field |
| Conference page | unknown | — | not measured |
| **Total, measured channels** | **~160** | | **against a requirement of 200** |

ADV measured at zero does not lower the total — it was never counted in it. What it
removes is the possibility that an unmeasured statutory channel closes the gap.

### Why the SEC projection has a ceiling

To reach 200 from this channel alone at 50% coverage, ~400 of the 500 would have to
be US 13F-filing family offices. The floor estimate — filers whose own name
contains "family" *and* carry an individual-owned route — is **55**. That
understates (Cascade, Bezos Expeditions and Bayshore do not say "family"), but
Stage 1's conversion rate puts the realistic pool near 120, not 400.

---

## Engineering cost per qualified record

| Channel | API calls | Wall time | Notes |
|---|---|---|---|
| SEC signatory | 0 | ~70ms for the whole census | one quarterly file, already on disk |
| Verified profile | ~2 | ~4s | one search, one slug check |
| Leadership page | ~20 | ~16s | and yielded nothing on this sample |

The cheapest channels are the productive ones. That is unusual and worth
exploiting: SEC signatory work is effectively free and profile verification is two
calls.

---

## Recommendation on channel mix

**Do not chase leadership pages.** 20 calls for zero qualified routes on a
representative sample. If a corrected extractor is built later it is a bonus, not
a plan.

**Weight the climb toward US SEC-visible family offices** — but knowingly, and with
the cost stated. Stage 1's Companies House channel produced 0% reachability; every
UK registry record added is a record that cannot count toward the 200. That is a
direct trade against the source diversity Stage 1 was corrected *for*, and it
cannot be resolved by being clever. It has to be chosen.

**Treat verified profiles as a first-class channel, not enrichment.** Best
cost/yield ratio measured, and the verification is deterministic rather than
probabilistic.

**Use ADV Schedule A for identity, never for reachability.** Measured at zero
routes, structurally. Its ownership codes and control-person flags are the best
available basis for the decision-maker requirement in D2.

---

## Is ≥200 achievable?

**Marginal, and not demonstrated.**

Measured channels project **~160**. That is not a failure — the two unmeasured
channels could close the gap, and the profile projection is the weakest number in
the table precisely because it is the one with most headroom.

What the evidence does **not** support is a confident claim that 200 is reachable.
Anyone asserting that today would be asserting it from two extrapolations, one of
which rests on a 50-record sample.

### The open question this creates

A LinkedIn profile is the largest projected contributor, and whether it counts is a
judgment call the brief does not settle. It says a route counts only if it reaches
the named individual, and explicitly excludes shared inboxes, contact forms,
switchboards, and pattern-generated addresses. A verified personal profile is none
of those and is a genuine route to a specific person — but it is weaker than a
direct line, and a reviewer could reasonably read it either way.

**If verified profiles count, the projection is ~160 with a credible path to 200.
If they do not, the projection is ~60 and the target is not reachable from the
channels measured.**

That is the decision the spike surfaces, and it is not mine to make.

---

## D1 — FROZEN

Measured 30 Jul. No further channel search. Decision recorded with its assumptions
so it can be audited against the artifacts.

### Decision

**Channel mix for the climb to 500:**

| Channel | Role | Counts toward 200? |
|---|---|---|
| SEC 13F signatory | primary reachability | yes — individual-owned phone |
| Verified principal profile | primary reachability | yes — see assumption A1 |
| SEC ADV Schedule A | identity and decision-maker evidence | no |
| Companies House | identity, control evidence, breadth | no |
| Web / conference / news | discovery and function evidence | no |
| Firm leadership page | not pursued | — |

### Assumptions, stated explicitly

**A1 · A verified personal profile counts as a contact route.** The brief requires
a route that reaches the named individual and excludes shared inboxes, contact
forms, switchboards, and pattern-generated addresses. A profile whose URL encodes
the named person is none of those. This is the assumption the reachability number
most depends on, and a reviewer could reasonably disagree. **The dataset will
report reachability with and without profiles so the number survives either
reading.**

**A2 · Verification is deterministic, not probabilistic.** A profile counts only
when its URL slug encodes the named person's name. On the Stage 1 sample this
rejected exactly the two wrong-person links the feedback identified.

**A3 · The 20% profile yield holds at scale.** Weakest assumption in the set,
extrapolated from 50 records. It will be re-measured continuously during the climb
and the projection corrected in the submission rather than restated.

**A4 · A 13F signatory phone reaches that signatory.** Supported: the number is
filed beside their name in a document they signed, and appears against no other
filer or person. Not proof it rings on their desk, and recorded as such.

**A5 · Weighting toward SEC-visible firms costs source diversity.** Accepted
knowingly. Companies House produced 0% reachability in the measured sample; every
UK record added cannot count toward the 200. The submission states this trade
rather than presenting the mix as unconstrained discovery.

### Position on the 200

**Marginal. ~160 projected from measured channels under A1; ~60 without it.**

Not claimed as achievable. The climb proceeds under this mix, reachability is
recomputed from the file at every checkpoint, and if the final number is short it
is reported as measured with this evidence attached — not adjusted to fit the
requirement.
