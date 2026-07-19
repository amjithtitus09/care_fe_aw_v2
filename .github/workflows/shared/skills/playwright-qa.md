---
description: >
  Shared import fragment — the CARE QA mindset. Adapted from ohcnetwork/skills `playwright`
  (requirements-first journey testing) plus the "check the other usages of a shared surface the
  diff touched" rule from ohcnetwork/skills `care-diff-review`. It supplies the *how to think about
  verification* layer for the QA stage: reconstruct the full requirement, enumerate the real user
  journeys (happy + negative + boundary), DRIVE them end-to-end, and assert the OUTCOME the user
  cares about — never a proxy near the diff. The mechanics (selectors, helpers, fixtures) live in
  the care_fe checkout's `tests/PLAYWRIGHT_GUIDE.md`.

# No `on:` trigger — this is a shared component, imported via `imports:`. It is validated but
# never compiled into its own lock file. Its body is appended to the importing workflow's prompt.
---

# CARE QA mindset — verify the requirement and the journey, not a proxy near the diff

> **Why this exists.** Real shipped defects in this pipeline were missed because QA verified an
> *existence proxy* next to the change (e.g. "the report-type dropdown shows 2 options") instead of
> the *user's actual journey* and the *ripple into the surrounding surface*. The bugs lived in code
> the diff never touched (a completion gate and a "view" button both hardcoded to
> `diagnostic_reports[0]`), which the feature silently made wrong. **Most missed bugs come from
> untested requirements, not bad selectors.** This section is how you avoid repeating that.

## R1 — Reconstruct the FULL requirement first (before you drive or assert anything)

From the PR diff and the surrounding source, write down — for yourself — the complete requirement the
change implies, not just the one surface it renders:

- **The journeys.** List every end-to-end path a user takes to exercise the feature, start to finish.
  For a "create/approve N of X" feature that means the **plural** journey: create item 1 → complete/
  finalize/approve it → create item 2 → finalize/approve it → and then *use* each (view/print/open)
  **independently**. The single-item path is necessary but never sufficient.
- **Both paths.** Every happy path has a negative twin — missing/invalid input, permission denied,
  a 4xx/5xx, an already-final/duplicate action. Note the ones in scope.
- **Boundaries & transitions.** 0 → 1 → N, empty → populated, loading → loaded, first → last,
  before-final → after-final. The interesting bugs live at N>1 and at state transitions.
- **States & roles.** Which states the entity moves through, and which roles can reach the surface.

If the diff implies a requirement it doesn't fully implement (e.g. renders N forms but the
completion/approval gate or a "view" action still assumes one), that gap **is** the finding.

## R2 — Check EVERY other usage of a shared surface the diff touched (the ripple rule)

When the change alters how a shared entity is shaped or rendered (here: a service request now has
*many* diagnostic reports instead of one), the risky bugs are usually in the **other, unchanged**
places that still reference it the old way. Before you pass:

- Grep the changed file(s) and their component for every other reference to the same data
  (e.g. `diagnostic_reports[0]`, `[0]?.`, `.find(`, single-item assumptions, a completion/enable
  gate, a nav/print/"view" handler, a header/summary count).
- For each, ask: *does this still hold when there are 2+?* A `[0]` that was correct for one item and
  is now wrong for many is a real defect **even though it is not in the diff** — always check these.
- Drive the journey far enough to actually hit those surfaces (finalize a report, then use the
  "view/print/complete" control) rather than stopping at the entry point.

## R3 — Assert the OUTCOME, never the entry point

The pass gate is the **result the user gets**, not that the control exists.

- A dropdown showing N options, a form rendering, a button being enabled — these are **necessary but
  not sufficient**. They prove the entry point, not that the feature works.
- For "create N": the gate is **N items actually created, finalized, and independently usable**,
  visible together on the destination surface — plus the control state that enforces the rule
  (e.g. each report independently approvable; the SR only completable when *all* are final; the
  "view" opening the *right* report, not always the first).
- **Assert before every screenshot** (you may have no vision model): assert the exact count/state,
  then capture. A screenshot with no preceding assertion can silently show a half-rendered or
  first-only state and you'd never know.

## R4 — Drive it like a senior QA engineer

- **User journeys, not implementation** — assert what the user cares about, not DOM internals.
- **Reuse care_fe's own harness** — helpers/fixtures/page-objects under `tests/**`, the flow patterns
  in existing specs, and `tests/PLAYWRIGHT_GUIDE.md`. Seed preconditions through the real UI (the
  app only reliably shows data the app itself created); never hand-roll selectors a helper covers.
- **Isolation & determinism** — self-contained; deterministic fixture IDs (`getFacilityId/PatientId/
  EncounterId`); `.first()` only after search/filter, never to pick a random row.
- **Both paths, boundaries, transitions** — from R1; don't assume anything is "out of scope" — if a
  path is plausibly in the requirement, exercise it or explicitly call it out as unverified.

## R5 — The verdict must reflect journey + ripple, not just the entry point

- **Pass** only when the full plural journey was driven AND every other usage of the touched surface
  was checked at N>1 AND the outcome (not the entry point) was asserted and screenshotted.
- If you reached the entry point but could **not** drive the full journey (e.g. couldn't finalize the
  second report, or a "view" opened the wrong one), that is a **defect** → `state:rework` with the
  exact journey step and element that failed as the finding — not a pass, and not "needs human"
  unless it is genuinely infra/un-seedable.
- Name the specific broken step so the fixer can act: the route/component, the control, what was
  expected vs. what happened at N>1.

## Form/flow checklist (apply the relevant items to the feature under test)

1. Required-field validation (submit empty → each required field errors, exact text).
2. Happy path — valid data → success (toast + redirect + the new data visible).
3. **The plural/N>1 path** — more than one item created, finalized, and rendered **together**.
4. Field/state combinations and the transitions between them (before-final → after-final).
5. Individual update/approve doesn't corrupt the others (finalizing item 1 must not block item 2).
6. The control that enforces the rule (complete/approve/enable) is correct at N>1, not just N=1.
7. Every "use it" affordance (view/print/open/history) targets the **right** item, not always `[0]`.
8. Duplicate/repeat-submit prevention; permission-denied path.
9. Post-action verification is **mandatory** — assert the outcome, never stop at the click.
