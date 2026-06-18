---
name: adr-drafting
description: Draft an architecture decision record (ADR) capturing context, decision, and consequences for future-you.
tags: [architecture, scope:starter]
applies_to: [general-coding]
---

# adr-drafting

An ADR is a short document that records a non-obvious architectural
choice so the team (and future-you) understands the reasoning.

A useful ADR has four sections:

1. **Context** — what's the problem and what constraints apply? Anchor
   the reader in the world as it is, not as you wish it were.
2. **Decision** — the specific choice. One sentence is ideal.
3. **Alternatives considered** — what else was on the table and why was
   each rejected? This is where future maintainers find the "why didn't
   they just …" answer.
4. **Consequences** — what becomes easier and harder because of this
   decision? Be honest about the downsides.

Keep ADRs under one page. They're not designs; they're decisions.
Number them sequentially (ADR-001, ADR-002 …) and store them in
`docs/adr/` so they're discoverable.

If the decision is reversed later, write a new ADR that supersedes the
old one — don't edit the old one. The record of the change is itself
useful context.
