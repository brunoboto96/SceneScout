---
"scenescout": minor
---

Add `scout_verify`: re-test what earlier runs left open, and record what each re-test found.

The report has always carried two kinds of finding and been honest that they are not the same thing — what this run saw, and what some earlier run saw. The second kind was labelled historical and unverified, which is accurate and almost useless: a reader cannot tell a bug fixed three weeks ago from one still costing users money today, and neither can the next run. Closing that by hand meant copying each finding's route and evidence out of the report, re-walking them one at a time, and calling `scout_resolve` on the ones that were gone. One project's history held over three hundred.

`scout_verify` called bare returns the open findings in the order to re-test them — worst route first, grouped so a route is walked once rather than once per finding — each with the evidence that identifies it and the steps that produced it. `scout_verify {ids}` narrows it, and names any that are not open rather than quietly shortening the list.

After re-testing one, `scout_verify {id, verdict, note}` records it: `gone` resolves it, `present` stamps it confirmed so the report dates the confirmation instead of calling it unverified, and `changed` keeps it open and says the behaviour differs. The history index gains a "Re-tested" column, so a reader can see at a glance which of it is still believed.
