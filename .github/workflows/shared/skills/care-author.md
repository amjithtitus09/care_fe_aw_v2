---
description: >
  Shared import fragment — the CARE authoring discipline for changes that touch a shared surface.
  Adapted from ohcnetwork/skills `care-diff-review` ("check the other usages of a shared
  component/hook/util/route the diff touched"), applied PROACTIVELY: when you change the shape,
  cardinality, or contract of anything shared, find and update EVERY usage of it — not just add the
  new rendering/path. It supplies the "don't leave a ripple behind" discipline for the author stage:
  the usages you forget to update are exactly the bugs review and QA will bounce the PR on, so
  handling them here is the cheapest place to get it right.

# No `on:` trigger — shared component, imported via `imports:`. Validated, never compiled to its own
# lock; its body is appended to the importing workflow's prompt.
---

# CARE authoring discipline — when you change a shared surface, update ALL its usages

> **Why this exists.** A change that made a service request hold *many* diagnostic reports instead of
> one added the new per-report rendering but left three `diagnostic_reports[0]` usages (a completion
> gate, a "View report" nav, an observation-history target) untouched — so they silently did the wrong
> thing at the new cardinality. Review and QA later bounced the PR on exactly those. **The bug was not
> the new code; it was the OLD code the change forgot to update.** Catch it here — it's the cheapest
> place — by treating "what else consumes the thing I'm changing?" as part of implementing, not an
> afterthought.

## A1 — Before you implement: enumerate what you're changing the shape of

Identify every **shared surface** your task changes the shape / cardinality / contract of:
- a **data structure** (one → many, a field added/renamed, a nullable made non-null or vice-versa),
- a **component**'s props/contract, a **hook**'s return, a **util**'s behavior/signature,
- a **route**'s params, an **enum / ValueSet / status** set.

For each, **grep the codebase for every usage** (start with the file and its module, then widen to
importers of the symbol): `foo[0]`, `[0]?.`, `.find(`, `.length`, single-item assumptions, a
completion/enable **gate**, a **nav / print / "view" / history** handler, a header/summary **count**,
a default that assumed the old shape. Write down that usage list — it is your change's real scope.

## A2 — While you implement: update EVERY usage, not just the new path

It is not enough to render/handle the new shape in one place. For **each** usage from A1, make it
correct at the new shape:
- one → many: a gate must aggregate across **all** items (e.g. *every* code's report is `final`), not
  read index `[0]`; a "view"/"open"/"history" affordance must target the **right** item (per-item, or
  a picker), never always the first; a count/summary must reflect the real number.
- a renamed/reshaped field: update every read and write, and the types.
- Keep it surgical — update the usages of the surface you changed; do **not** refactor unrelated code.

If a usage genuinely should stay single-item (e.g. a legitimately single-valued path), that is fine —
but it must be a **decision you verified**, not a `[0]` you forgot.

## A3 — Before opening the PR: self-review your own diff for the ripple

Read your diff back with one question: **"what did I change the shape of, and did I update every
consumer of it?"** Concretely, for each shared surface you touched, grep it again in your final code
and confirm no remaining usage still assumes the old shape. A leftover `[0]`/single-item assumption on
a surface you made plural **is a defect you are shipping** — fix it now. This is the exact ripple the
review and QA stages will check; clearing it here means the PR passes them the first time instead of
looping through rework.
