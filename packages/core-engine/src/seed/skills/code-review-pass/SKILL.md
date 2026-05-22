---
name: code-review-pass
description: Conduct a structured code review pass focused on correctness, surface area, and test coverage.
tags: [review, scope:starter]
applies_to: [general-coding]
---

# code-review-pass

A starter checklist for reviewing a code change. Apply in order — the
first failure usually surfaces the biggest issue.

1. **Goal alignment**: does the change accomplish what the description
   says? Hidden scope creep often reveals itself here.
2. **Failure modes**: trace every new code path. Where can it throw?
   What happens on retry? Is the contract idempotent if it claims to be?
3. **Surface area**: is anything *new* exported that wasn't before? New
   types in public APIs deserve scrutiny — they're hard to remove later.
4. **Tests**: does the change come with tests? If a bug fix lands without
   a regression test, the bug can return.
5. **Error handling**: are errors propagated with enough context that the
   caller can diagnose? Swallowed errors are a future incident.
6. **Performance**: did this introduce an N+1 query, a sync loop in a hot
   path, or an unbounded retry?

Skip the cosmetic stuff (whitespace, naming preferences) unless it
genuinely impedes readability — leave that to formatter/lint configs.
