---
name: test-scaffolding
description: Stand up a test that locks in current behavior fast so further changes don't silently regress.
tags: [testing, scope:starter]
applies_to: [general-coding]
---

# test-scaffolding

Before changing a function with no tests:

1. Capture the function's current behavior at a representative input —
   *not* what the spec says it should do, what it *does*.
2. Write the smallest test that asserts that captured output.
3. Run the test against the unchanged code. It must pass.

Now the test is a **safety net**: any change that breaks current behavior
will turn the test red, surfacing the regression immediately.

For pure functions, a single input/output pair is often enough.
For functions with side effects, capture the side-effect surface as
separate assertions (mock the I/O, assert the calls).

Don't strive for full coverage in this step. Coverage is a follow-up;
the goal here is a tripwire so the next change isn't blind.
