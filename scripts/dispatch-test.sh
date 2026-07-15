#!/usr/bin/env bash
#
# Fire a `repository_dispatch` (event_type: jira-task) by hand, exactly like the Jira Automation
# rule does — so you can smoke-test the whole v2 pipeline WITHOUT Jira wired up yet.
#
# It POSTs the same payload jira-pr-author.md reads (issue_key / summary / description), which
# opens a draft PR labelled `jira-agent` -> enroll -> state:review -> state:qa -> state:ready.
#
# Prereqs:
#   * The workflows are on the repo's DEFAULT branch (merge PR #1 to develop first).
#   * Repo secrets configured: COPILOT_GITHUB_TOKEN and GH_AW_AGENT_TOKEN (see docs/SETUP.md).
#   * `gh` authenticated (or GH_TOKEN exported) with a token that can dispatch to the repo
#     (Contents: write). `jq` installed.
#
# Usage:
#   ./scripts/dispatch-test.sh <ISSUE_KEY> "<summary>" ["<description>"]
#   REPO=amjithtitus09/care_fe_aw_v2 ./scripts/dispatch-test.sh ENG-999 "Add a tooltip to X"
#
# Example:
#   ./scripts/dispatch-test.sh ENG-999 "Show unit display text in questionnaire responses" \
#     "When a response has a unit, render its display text instead of the raw code."
set -euo pipefail

KEY="${1:-}"
SUMMARY="${2:-}"
DESC="${3:-}"

if [[ -z "$KEY" || -z "$SUMMARY" ]]; then
  echo "usage: $0 <ISSUE_KEY> \"<summary>\" [\"<description>\"]" >&2
  exit 2
fi
if ! printf '%s' "$KEY" | grep -Eq '^[A-Za-z][A-Za-z0-9]+-[0-9]+$'; then
  echo "error: ISSUE_KEY '$KEY' must look like ENG-395" >&2
  exit 2
fi

REPO="${REPO:-$(gh repo view --json nameWithOwner --jq .nameWithOwner 2>/dev/null || echo amjithtitus09/care_fe_aw_v2)}"

payload="$(jq -n --arg k "$KEY" --arg s "$SUMMARY" --arg d "$DESC" \
  '{event_type: "jira-task", client_payload: {issue_key: $k, summary: $s, description: $d}}')"

echo "Dispatching jira-task for $KEY to $REPO ..."
printf '%s' "$payload" | gh api -X POST "repos/${REPO}/dispatches" --input - \
  && echo "OK — dispatched. Watch: https://github.com/${REPO}/actions" \
  || { echo "dispatch failed — check the token has Contents:write on ${REPO} and workflows are on the default branch." >&2; exit 1; }
