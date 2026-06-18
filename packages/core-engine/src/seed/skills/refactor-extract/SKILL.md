---
name: refactor-extract
description: Extract a function or module safely by writing the smallest passing tests first, then mechanically pulling the code out.
tags: [refactor, scope:starter]
applies_to: [general-coding]
---

# refactor-extract

Refactor without breaking behavior by **moving in two passes**:

**Pass 1 — pin the behavior.**
- Write the smallest test that exercises the code you're about to move.
- If the existing test suite doesn't cover the path, add a characterization
  test that captures the current output (correct or not).
- Confirm tests pass against the *current* code.

**Pass 2 — extract.**
- Move the code to its new location without changing it.
- Update imports. Run the tests.
- If tests pass, the move is correct. If they fail, your test from pass 1
  was insufficient — go back and pin more behavior first.

Avoid renaming during extraction. Two simultaneous changes (move + rename)
hide each other's bugs. Rename in a follow-up commit if needed.
