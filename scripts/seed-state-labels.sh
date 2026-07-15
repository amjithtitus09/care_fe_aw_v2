#!/usr/bin/env bash
#
# Seed the labels for the v2 Jira -> mergeable-PR agentic pipeline.
#
# The pipeline is a SINGLE linear state machine. Exactly one `state:*` label is
# active on an enrolled PR at any time; each stage workflow consumes its trigger
# label and adds exactly the next one (`add-labels: { max: 1 }` + a `remove-labels`
# of the whole set on every transition).
#
#   jira-agent        enrollment marker (added by jira-pr-author; enroll reacts to it)
#   state:review      needs review  -> pr-review runs (code + CI)
#   state:qa          review passed -> pr-qa runs (seed + screenshot)
#   state:rework      a failure was found -> pr-rework runs (fix + push)
#   state:ready       TERMINAL — verified, awaiting human merge (merge is always human)
#   state:human       TERMINAL — escalated; a human must take over
#
# Linear transitions:
#   (enroll)      --> state:review
#   state:review  --> state:qa      (pass)   | state:rework (fail)
#   state:qa      --> state:ready   (pass)   | state:rework (defect) | state:human (infra/unseedable)
#   state:rework  --> state:review  (fixed)  | state:human (rework cap reached)
#
# Usage (idempotent — safe to re-run; `--force` updates colour/description in place):
#   ./.github/scripts/seed-state-labels.sh                # current repo (gh-detected)
#   ./.github/scripts/seed-state-labels.sh owner/repo     # explicit repo
#
# Requires the GitHub CLI (`gh`) authenticated with `repo` scope.
set -euo pipefail

REPO="${1:-}"
if [[ -z "${REPO}" ]]; then
  REPO="$(gh repo view --json nameWithOwner --jq .nameWithOwner)"
fi

echo "Seeding v2 pipeline labels on ${REPO} ..."

seed() {
  local name="$1" color="$2" desc="$3"
  # `--force` makes this create-or-update, so the script is idempotent.
  gh label create "${name}" --repo "${REPO}" --color "${color}" --description "${desc}" --force
}

seed "jira-agent"    "5319E7" "Agentic pipeline: enrolled Jira-authored PR"
seed "state:review"  "1D76DB" "Pipeline: needs review (code + CI)"
seed "state:qa"      "FBCA04" "Pipeline: review passed — needs seeded visual QA"
seed "state:rework"  "D93F0B" "Pipeline: a defect was found — automated rework queued"
seed "state:ready"   "0E8A16" "Pipeline: verified — ready to merge (human merges)"
seed "state:human"   "B60205" "Pipeline: escalated — needs a human"

echo "Done. Pipeline labels on ${REPO}:"
gh label list --repo "${REPO}" --search "state:" 2>/dev/null || true
gh label list --repo "${REPO}" --search "jira-agent" 2>/dev/null || true
