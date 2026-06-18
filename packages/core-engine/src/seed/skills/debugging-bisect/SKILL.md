---
name: debugging-bisect
description: Localize a regression by bisecting recent commits or feature flags instead of reading code top-down.
tags: [debugging, scope:starter]
applies_to: [general-coding]
---

# debugging-bisect

When a regression appears after a stretch of changes, narrow the change set
by **bisection** rather than top-down reading.

Steps:
1. Identify the latest commit that you believe is broken.
2. Identify the latest commit you believe was working.
3. `git bisect start <bad> <good>` — let git pick the midpoint.
4. Reproduce the regression at the midpoint. Mark `git bisect good` or
   `git bisect bad`.
5. Repeat until git names the offending commit.

For feature flags, the equivalent is to A/B-toggle the flag at the same
midpoint commit and observe which branch reproduces.

Why this beats reading the diff top-down: bisection makes the search
**logarithmic** in the number of changes, and the answer is a specific
commit — not a hypothesis.
