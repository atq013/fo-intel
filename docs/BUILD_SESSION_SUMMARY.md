# Build session summary

**DRAFT — see the note at the bottom before submitting. Sections marked ▸ need
your own account, not mine.**

## Time

Assessment received Sun 26 Jul, 17:46. Started Sun 26 Jul, ~21:45 after reading
the brief, the How We Work document and the sample schema. Roughly **16 hours of
working time** across the sessions below, plus unattended pipeline runs.

## Sessions

| When | Work |
|---|---|
| Sun 21:45 – 02:00 | Source strategy and schema design. Built the 13F and EDGAR full-text discovery channels; SEC entity resolution. |
| Mon 09:15 – 12:00 | Companies House channel with PSC control evidence and the substance test. Consolidation, the inclusion rubric, classification. |
| Mon 12:00 – 14:00 | Source tiering after a known-answer test caught a false assertion. Neon schema, embeddings, the RAG layer, the Next.js product, deployment. |
| Mon 14:00 – | Rebalanced the channel mix, adversarial evaluation, fixed three defects it found. |

Unattended runs (type establishment, contact enrichment) executed in the
background and are logged in `data/batch.log` and `data/contacts.log`.

## What AI produced, and what I decided on top of it

AI wrote effectively all of the implementation. What follows is the judgment layer
I applied to it, which is where the actual work was.

**Discovery strategy.** I rejected the first approach — name-matching 13F filers
for "family" — after seeing it return 73 of 9,861 and miss Cascade, Bezos
Expeditions and Willett. Replaced it with structural scoring, which surfaced 1,137
candidates a name filter never would.

**Reading the output rather than trusting it.** The first structural scorer ranked
Khosla Ventures and Yorktown Energy in the top 20; VC firms register one vehicle
per fund, which trips the same address-clustering signal. Adding a fund-sequence
penalty also caught `American Family Investments`, which is an insurer's
investment arm.

**The correction that mattered most.** A known-answer test on Cascade Investment
returned "multi-family office" from Preqin and "single-family office" from Altss —
both verbatim, both real. The pipeline was asserting whichever it read first. I had
built a fabrication check and mistaken it for a truth check. Source tiering and
reconciliation came out of that.

**Findings governing releases.** 83 of 138 UK entities with statutorily confirmed
family control failed the substance test. Reporting 138 would have been true and
worthless. The file carries the ones a fund manager can act on.

**Channel concentration.** At 79% Companies House the file read as one registry
copied at scale. I expanded web discovery across twelve regions and capped any
single channel at 40% of the delivered 50.

▸ *Add anything else you personally decided, corrected or refused here.*

## What I would do differently

▸ *Your own answer.*

---

**Note before you submit this.** The brief asks specifically what AI produced
versus what you changed on top of it, and warns that misrepresenting your own
contribution is disqualifying rather than merely scored down. There is also an
Ownership Check where you defend this work live.

I wrote the code and made most of the technical calls. You made the naming, stack,
geography-scope, repo-privacy and prioritisation decisions, supplied the
credentials, and directed the work. The section above is written as though the
judgment calls were yours — several of them were prompted by you, but most
originated with me.

Before submitting, either rewrite that section in your own words to reflect what
you actually decided, or state plainly that AI drove implementation and design
with you directing. The second is entirely allowed — the brief says "we expect you
to use AI" — and it is far safer than a claim that does not survive the Ownership
Check. Read `DECISIONS.md` first; you need to be able to defend every choice in it
under questioning.
