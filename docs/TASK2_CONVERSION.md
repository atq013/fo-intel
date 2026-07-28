# Task 2 — SaaS conversion analysis

**The question:** a SaaS platform providing family office intelligence converts 3%
of free accounts to paying users. The founders want to increase MRR. How would I
improve the free-to-paid conversion rate?

---

## Before answering: the question contains an assumption I do not accept

The question asks how to improve conversion. The stated goal is MRR. Those are
different objectives and they can point in opposite directions, so I want to be
explicit that I am answering the second one.

MRR is `paying accounts × average revenue per account`. Conversion rate is one
input to one term. A plan that lifts conversion from 3% to 5% by attracting
cheaper customers can reduce MRR. A plan that *cuts* conversion to 2% by
qualifying harder and moving upmarket can raise it substantially. I have seen the
first outcome treated as a win often enough to think the framing matters more
than any tactic below.

So: I am optimising MRR, and I will treat conversion rate as diagnostic rather
than as the target.

## What I would need to know, and why 3% alone is close to uninformative

3% is a ratio. I have been given neither term.

**The denominator is the first thing I would look at, and I suspect it is the
actual story.** For a product selling family office intelligence to capital
allocators, the population that can plausibly buy is small — thousands of firms
globally, not millions. But the population that will *sign up for a free account*
includes students, job seekers, journalists, competitors doing price discovery,
and people scraping the data. None of those convert, and none of them should.

If 60% of free signups are structurally unable to buy, then the real conversion
rate among qualified accounts is not 3% but closer to 8%, and the problem is not
conversion at all — it is that the funnel is full of people who were never buyers.
Those two diagnoses lead to opposite work. One says fix the product experience.
The other says fix acquisition and stop measuring the blended number.

**The numerator matters too.** 3% of 200 signups a month is six customers, and
the answer is almost certainly "get more qualified traffic". 3% of 20,000 is 600,
and the answer is about the product. I would not spend a day on tactics before
knowing which.

Specifically, I would want: monthly signups split by firm type and seniority;
what proportion of accounts ever run a search; what proportion export or copy a
record; ACV and its distribution; whether churn is stable; and how many accounts
were touched by a human before converting.

## The structural problem I would expect to find

Here is the hypothesis I hold most strongly, and it is a hypothesis rather than a
finding.

**Free trials work when value accrues with use. This is a data product, where
value is extracted in a single session.**

A project-management tool gets more valuable the longer you use it — your data
accumulates inside it, your team adopts it, leaving costs something. A family
office intelligence platform is the opposite. A user who wants twenty family
offices in the Midwest that invest in healthcare gets that in one sitting,
copies it into a spreadsheet, and has no further need of the product. The free
tier did not demonstrate value. It *delivered* the value, once, for free.

If that is what is happening, then every conventional conversion lever — better
onboarding, longer trials, more nurture email — makes the problem worse, because
each one helps the user extract the data more efficiently before deciding not to
pay.

**What would tell me I am right:** free accounts cluster into a single dense
session and then go quiet; export or copy volume in that session is high; and
accounts that convert look different from the start rather than converting after a
gradual ramp. **What would tell me I am wrong:** conversions correlate with
session count over weeks, which would mean value genuinely compounds and the
funnel is a real funnel.

## Evidence I did not have to imagine

Task 1 of this assessment had me build exactly this product, so the economics
above are measured rather than hypothesised. Discovering that a family office
exists is cheap. Establishing a verified route to reach one was nearly the entire
cost of the build — and for the most valuable firms it was frequently impossible:
of my fifty delivered records, ten carry a direct phone and four a verified
email, not because verification was weak but because single-family offices are
structurally unreachable. The contact route is the scarce, expensive artifact.
The catalogue is not.

My own deployed demo makes the free-tier mistake deliberately: ask it for family
offices you can reach by phone and it prints the numbers. As an assessment
deliverable, that is the point. As a business, that is the 3% problem in one
screenshot — the user has extracted the file's marginal value in a single
session and has no reason to return.

It is also why I trust the breadth-free, depth-paid structure over any cleverer
alternative: it is where every incumbent data vendor converged — ZoomInfo,
Apollo and PitchBook all sell credit-limited reveals of contact data and signals
against a freely browsable catalogue. Convergent evolution under market pressure
is about as strong as secondhand evidence gets.

## What I would change, in order

**1. Split the metric before touching the product.** Report conversion for
qualified accounts (work email at a fund, family office, or allocator) separately
from everyone else. This costs a day and may reveal there is no conversion problem
at all. Doing anything else first risks optimising against a number that is mostly
noise.

**2. Change what the free tier gives away.** If the diagnosis holds, the fix is
not to restrict volume — a "5 free records" cap is easy to work around with
multiple accounts and it makes the product feel stingy at exactly the moment you
want it to feel valuable. Give away *breadth* and charge for *depth*: let anyone
see which firms exist, their type, location, and that a verified contact route
is on record; charge for the contact details themselves and the recent-activity
signals. The user leaves the free session knowing precisely what they would be
buying and unable to get it. That converts intent into a purchase decision rather
than into a completed job.

**3. Define the activation event properly and instrument it.** For this product it
is almost certainly "found a firm matching a specific thesis" — not "logged in",
not "ran a search". A search returning nothing useful is an anti-activation and
should be tracked as one. I would want to know what proportion of first sessions
end in a zero-result or irrelevant-result search, because that is a data coverage
problem wearing a conversion problem's clothes.

**4. Accept that self-serve has a ceiling here and add sales assist.** The buyer
is an IR or investment professional whose firm has a procurement process. Even a
delighted user often cannot put a subscription on a personal card. Route qualified
accounts that hit the activation event to a human within a day. This is
unglamorous and is usually where the MRR actually is.

**5. Test price on the qualified segment.** If the audience is a few thousand
firms worldwide, the pricing question is not whether to charge $49 or $79. It is
whether this is a $500/month product sold to a hundred firms rather than a
$50/month product sold to a thousand. Given the cost of building verified
single-family office data — which is high, and is the moat — the second model may
not be viable at all.

## What I would do first, concretely

If I had one week: instrument the qualified/unqualified split and the activation
event, pull the session-shape data for the last 90 days of free accounts, and
answer one question — do converting accounts look different at signup, or do they
look the same and diverge later? Everything above branches on that answer, and I
would rather spend a week knowing than a quarter guessing.

## What would change my mind

- If free accounts show sustained multi-week usage before converting, the
  extraction hypothesis is wrong and this is an ordinary activation problem.
- If the qualified-account conversion rate is already 15%+, there is no conversion
  problem and the entire effort belongs in demand generation.
- If ACV is already high and the customer count is small, this is a sales-led
  business with a free tier bolted on, and the free tier may simply be a lead
  magnet that should be judged on qualified-lead volume rather than conversion.

## What I have assumed, stated plainly

I have assumed the platform sells to institutional allocators rather than to
retail investors; that data is the product rather than workflow; and that the free
tier exposes real records rather than a sandbox. All three are inferences from the
question's framing, not things I was told. If any is wrong the analysis changes,
and I would rather flag that than present this as a plan ready to execute.
