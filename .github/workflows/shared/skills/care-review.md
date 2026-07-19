---
description: >
  Shared import fragment — the CARE code-review mindset. Adapted from ohcnetwork/skills
  `care-review` + `care-diff-review`: reconstruct what the diff does and the requirement it implies
  from the code alone, then flag correctness defects AND — critically — regressions in the OTHER
  usages of any shared surface (component / hook / util / route / data shape) the diff touched,
  including on lines the diff never changed. It supplies the "review beyond the changed lines"
  discipline for the review stage: the diff can silently make unchanged code wrong, and that is
  exactly the class of bug a changed-lines-only review misses.

# No `on:` trigger — shared component, imported via `imports:`. Validated, never compiled to its
# own lock; its body is appended to the importing workflow's prompt.
---

# CARE review mindset — the diff can make UNCHANGED code wrong (check the ripple)

> **Why this exists.** A real change shipped through this stage because review looked only at the
> *changed lines*. The PR made a service request hold *many* diagnostic reports instead of one, but
> three `diagnostic_reports[0]` assumptions on **unchanged** lines of the same file (a completion
> gate, a "View report" nav, an observation-history target) were silently made wrong by that change.
> Reviewing "only the diff" cannot catch this — the bug is in code the diff never touched. **When a
> change alters a shared surface, the risk moves to the other usages of that surface.**

## R1 — Reconstruct the intent from the code first (no commit message)

For the diff as a whole and each distinct logical change, state to yourself, from the **code**:
- **What it does** — the behavior change, in a sentence.
- **Why** — the requirement/problem it most plausibly fulfills.
- **Confidence** — high if the code makes it self-evident; low if you had to guess.

Reason from *this* control/data flow, not a catalog of known bugs. You need the intent to judge
correctness: a defect is where the code **can't fulfill the intent it implies** — and that includes
unchanged code the change has now invalidated.

## R2 — Check EVERY other usage of a shared surface the diff touched (the ripple rule — always)

This is the finding class a changed-lines-only review misses. When the diff changes the **shape,
semantics, or cardinality** of anything shared — a data structure (one → many), a component's
props/contract, a hook's return, a util's behavior, a route's params, an enum/`ValueSet` — the
dangerous bugs are in the **other places that still consume the old shape**:

- **Enumerate the touched surfaces.** From the diff, list what shared thing changed (e.g. "a service
  request now has `diagnostic_reports[]` (many), not one").
- **Find its other usages.** Grep the changed file(s) — and the component/module — for every other
  reference to that surface: `foo[0]`, `[0]?.`, `.find(`, single-item assumptions, a completion/
  enable **gate**, a **nav/print/"view"/history** handler, a header/summary **count**, a `.length`
  check, a default that assumed one. These are usually on lines the diff did **not** change.
- **Ask, at the new cardinality/shape:** does this still hold when there are 2+ (or 0, or the new
  variant)? A `[0]` that was correct for one and is now wrong for many is a **blocking regression**
  even though it is not in the diff. **Always check these before you pass.**

Bound it: this is **not** a whole-file or whole-repo re-review. Expand only to the other usages of
the *specific surfaces the diff changes* — grep those symbols, review those sites, stop there.

## R3 — Then review the changed lines for the usual defect classes

In priority order, on the diff and the ripple set from R2:
1. **Correctness & logic** — wrong conditions, off-by-one, unhandled `null`/`undefined`, bad state
   updates/effects, and **R2 ripple regressions** (a shared surface's other usages now wrong).
2. **Security / PHI** — XSS via `dangerouslySetInnerHTML`, unsafe URLs, leaking patient data, missing
   authz.
3. **Data integrity** — missing/incorrect `zod`, unsafe `any`/assertions on medical data.
4. **React / TanStack Query** — query keys, dep arrays, unstable refs, `mutate`/`query` misuse.
5. **Accessibility (WCAG 2.1 AA)** and **i18n** on the changed surface.
6. **Maintainability** — only genuinely confusing/duplicated code.

Don't comment on anything Prettier/ESLint enforce (formatting, import order).

## R4 — Verdict reflects the ripple, not just the diff

- A finding is **blocking** if it is a correctness, security, or data-integrity defect that must be
  fixed before merge — **including an R2 ripple regression** (a shared surface's other usage made
  wrong by the change), even on an unchanged line. Accessibility/i18n gaps on the changed surface are
  blocking too; pure maintainability nits are not.
- If you changed a shared surface's shape/cardinality and did **not** verify its other usages, you
  have not finished the review — do that before emitting a pass.
- Name each ripple finding precisely so the fixer can act: the file:line, the control/usage, and what
  is wrong at the new shape (expected vs. actual at N>1 / the new variant).
