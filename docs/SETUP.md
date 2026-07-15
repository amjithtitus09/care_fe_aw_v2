# Setup — wiring the v2 agentic pipeline

Everything below is one-time configuration. The pipeline itself (see [PIPELINE.md](./PIPELINE.md))
is already built and compiled; this just turns it on.

## 1. Merge to the default branch

Workflows only trigger from the repo's **default branch** (`repository_dispatch`,
`pull_request_target`, and label events all use the default-branch copy). Merge the v2 PR into
`develop` before anything will run.

## 2. Secrets (Settings → Secrets and variables → Actions)

| Secret | Required | What it is |
|--------|----------|------------|
| `COPILOT_GITHUB_TOKEN` | **Yes** | The model-engine token gh-aw uses to call Copilot. Must be a **fine-grained PAT** (`github_pat_...`) from a Copilot-licensed account — OAuth/classic tokens are rejected. Without it, no agentic stage runs. See the detailed note below. |
| `GH_AW_AGENT_TOKEN` | **Yes** | A fine-grained **PAT** that makes every `state:*` label write cascade past GitHub's recursion guard to the next stage, and attributes writes to a write-access user. Also reusable as the Jira→GitHub dispatch token (step 4). |
| `JIRA_BASE_URL` | Optional | e.g. `https://your-org.atlassian.net` — for status reports on the linked issue. |
| `JIRA_EMAIL` | Optional | The Jira account email for the API token. |
| `JIRA_API_TOKEN` | Optional | A Jira API token. |

Without the `JIRA_*` trio the pipeline still runs end to end — it just skips the Jira comments.

### `COPILOT_GITHUB_TOKEN` — what it is and how to create it

This is the **model-inference** token (separate from the repo-write PAT below). The agentic stages
use it to call the Copilot API (`api.githubcopilot.com`); it is *not* exposed to the model and does
*not* need repo write.

- **Must be a fine-grained PAT** (`github_pat_...`). The Copilot engine **rejects OAuth tokens**
  (`gho_...`, e.g. from `gh auth token`) and classic tokens — the activation step fails with
  *"OAuth tokens are not supported for GitHub Copilot"* if you use one.
- **Access required:** the PAT's account must have an **active GitHub Copilot subscription/seat**
  (Individual/Pro, Business, or Enterprise). That entitlement is the access being consumed. On a
  personal repo, use a Copilot-licensed personal account (e.g. `amjithtitus09`).
- **Create it** at <https://github.com/settings/personal-access-tokens/new>:
  - **Resource owner:** the Copilot-licensed account.
  - **Repository access:** *Public repositories (read-only)* is sufficient — Copilot access is
    account-based, not repo-based, so no repo write/select is needed.
  - **Permissions:** none beyond the default **Metadata: read**.
  - Generate, copy the `github_pat_...` value, and paste it into the `COPILOT_GITHUB_TOKEN` secret.
- **Alternative:** if this repo lived under an org with **centralized Copilot billing**, you could
  drop this secret and set `permissions.copilot-requests: write` instead. That is not available for
  a personal-account repo, so use the fine-grained PAT here.

### `GH_AW_AGENT_TOKEN` PAT scopes

Create a **fine-grained PAT** (Settings → Developer settings → Fine-grained tokens), scoped to
`amjithtitus09/care_fe_aw_v2`, with:

- **Contents:** Read and write
- **Pull requests:** Read and write
- **Issues:** Read and write

The token owner must have write access to the repo. (A classic PAT with `repo` scope also works.)

## 3. Repo settings

- **Actions:** enabled.
- **Workflow permissions:** the default `GITHUB_TOKEN` only needs **read** — all writes go through
  the PAT.
- **Labels:** already seeded. Re-run if needed:
  ```bash
  ./scripts/seed-state-labels.sh amjithtitus09/care_fe_aw_v2
  ```

## 4. Jira → GitHub trigger

`jira-pr-author` listens on `repository_dispatch` (type `jira-task`) — the **same mechanism v1
used** against `.../care_fe/dispatches`, with the **same** `client_payload` fields. So the
existing Jira Automation rule is already compatible.

**Recommended: duplicate v1's existing rule and repoint the URL.**

- In the "Send web request" action, change only the URL:
  - from `https://api.github.com/repos/amjithtitus09/care_fe/dispatches`
  - to   `https://api.github.com/repos/amjithtitus09/care_fe_aw_v2/dispatches`
- Keep its trigger condition and body verbatim:
  - Method: `POST`
  - Headers: `Authorization: Bearer <PAT>` · `Accept: application/vnd.github+json`
  - Body:
    ```json
    {
      "event_type": "jira-task",
      "client_payload": {
        "issue_key": "{{issue.key}}",
        "summary": "{{issue.summary}}",
        "description": "{{issue.description}}"
      }
    }
    ```
- **Gotcha:** the PAT that rule uses must have **Contents: write on `care_fe_aw_v2`**. A
  fine-grained PAT scoped only to `care_fe` will 403/404 on the new repo. Reuse the
  `GH_AW_AGENT_TOKEN` PAT, or add `care_fe_aw_v2` to the existing token's repo scope.

If you are starting a brand-new rule instead of duplicating, pick a trigger condition — e.g. *issue
assigned to a service account*, *transitioned to a status*, or *labelled* — and use the same action.

## 5. Smoke-test without Jira

After steps 1–3, fire the dispatch by hand to exercise the whole pipeline:

```bash
./scripts/dispatch-test.sh ENG-999 "Show unit display text in questionnaire responses" \
  "When a response has a unit, render its display text instead of the raw code."
```

Then watch <https://github.com/amjithtitus09/care_fe_aw_v2/actions>: a draft PR opens with
`jira-agent`, CI runs, `enroll` adds `state:review`, and the PR advances review → qa → ready.

## 6. Go-live order

1. Merge the v2 PR → `develop`.
2. Add secrets (step 2).
3. Run `scripts/dispatch-test.sh` and confirm a PR opens and advances.
4. Duplicate + repoint the Jira rule (step 4).
5. Move a real ticket through the trigger and watch it flow to `state:ready`.

## Cost note

Authoring, review, and rework run on `claude-opus-4.8`; QA runs on `claude-sonnet-4.5` (a
non-premium tier) because a long QA run on opus exhausted the premium-request budget in v1 and
403'd mid-run. Keep an eye on premium-request / AI-credit usage.
