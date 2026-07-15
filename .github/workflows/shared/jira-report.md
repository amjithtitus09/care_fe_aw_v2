---
description: >
  Shared import fragment that lets an agentic workflow report status back to the
  JIRA issue linked to a pull request. The agent calls the `jira_report` tool;
  the actual JIRA REST calls (add comment, transition status, upload a screenshot
  attachment) run in a separate, non-agent job that holds the JIRA credentials,
  so the AI engine never sees the token. The JIRA issue key is extracted from the
  PR title or branch name (e.g. `ENG-395`). If a report fails, a best-effort
  "automation failed — needs human" comment is posted to JIRA.

# No `on:` trigger — this is a shared component, imported via `imports:`. It is
# validated but never compiled into its own lock file.

safe-outputs:
  jobs:
    jira_report:
      description: >
        Report the result of an automated PR step back to the linked JIRA issue.
        Use this once you have finished your review / QA / fix and have a concise
        human-readable summary to share with the JIRA ticket. The JIRA issue key
        is auto-derived from the PR title or branch when `issue_key` is omitted.
      runs-on: ubuntu-latest
      permissions:
        contents: read
      output: "Reported status to the linked JIRA issue (if configured)."
      inputs:
        comment:
          description: "Markdown/plain-text summary to post as a comment on the JIRA issue."
          required: true
        status:
          description: >
            Short status keyword for this update, e.g. review-complete,
            changes-requested, qa-passed, qa-failed, fix-pushed, needs-human.
          required: false
        transition:
          description: >
            Optional target JIRA workflow status to transition the issue to
            (e.g. 'In Review', 'In Progress', 'Done'). Leave empty to skip.
          required: false
        issue_key:
          description: "Optional explicit JIRA key (e.g. ENG-395). If omitted, derived from PR title/branch."
          required: false
        screenshot_url:
          description: "Optional URL of a screenshot (e.g. an upload-asset URL) to attach to the issue."
          required: false
      steps:
        - name: Report to JIRA
          uses: actions/github-script@v8
          env:
            JIRA_BASE_URL: ${{ secrets.JIRA_BASE_URL }}
            JIRA_EMAIL: ${{ secrets.JIRA_EMAIL }}
            JIRA_API_TOKEN: ${{ secrets.JIRA_API_TOKEN }}
            PR_TITLE: ${{ github.event.pull_request.title || github.event.issue.title }}
            PR_BRANCH: ${{ github.event.pull_request.head.ref || github.head_ref || github.event.workflow_run.head_branch }}
            PR_NUMBER: ${{ github.event.pull_request.number || github.event.issue.number }}
            PR_URL: ${{ github.event.pull_request.html_url }}
          with:
            script: |
              const fs = require("fs");

              const baseUrl = (process.env.JIRA_BASE_URL || "").replace(/\/+$/, "");
              const email = process.env.JIRA_EMAIL || "";
              const token = process.env.JIRA_API_TOKEN || "";
              const staged = process.env.GH_AW_SAFE_OUTPUTS_STAGED === "true";

              // --- Read the agent's requested reports ---------------------------------
              const outputFile = process.env.GH_AW_AGENT_OUTPUT;
              if (!outputFile || !fs.existsSync(outputFile)) {
                core.info("No agent output found; nothing to report to JIRA.");
                return;
              }
              let items = [];
              try {
                const parsed = JSON.parse(fs.readFileSync(outputFile, "utf8"));
                items = (parsed.items || []).filter((i) => i.type === "jira_report");
              } catch (e) {
                core.warning(`Could not parse agent output: ${e.message}`);
                return;
              }
              if (items.length === 0) {
                core.info("No jira_report items requested by the agent.");
                return;
              }

              // --- Derive the JIRA issue key (regex over PR title / branch) -----------
              // JIRA keys are canonically uppercase, but branch names are often
              // lowercase (e.g. `eng-395-fix`). Match case-insensitively and
              // normalize so reporting still works off a lowercase branch.
              const KEY_RE = /\b([A-Za-z][A-Za-z0-9]+-\d+)\b/;
              function deriveKey(item) {
                if (item.issue_key && KEY_RE.test(item.issue_key)) {
                  return item.issue_key.match(KEY_RE)[1].toUpperCase();
                }
                for (const src of [process.env.PR_TITLE, process.env.PR_BRANCH]) {
                  const m = (src || "").match(KEY_RE);
                  if (m) return m[1].toUpperCase();
                }
                return null;
              }

              if (!baseUrl || !email || !token) {
                core.warning(
                  "JIRA secrets (JIRA_BASE_URL / JIRA_EMAIL / JIRA_API_TOKEN) are not " +
                    "configured. Skipping JIRA reporting — add the secrets to enable it.",
                );
                return;
              }

              const authHeader =
                "Basic " + Buffer.from(`${email}:${token}`).toString("base64");

              function adf(text) {
                return {
                  type: "doc",
                  version: 1,
                  content: String(text)
                    .split("\n")
                    .map((line) => ({
                      type: "paragraph",
                      content: line ? [{ type: "text", text: line }] : [],
                    })),
                };
              }

              async function jira(method, path, body, extraHeaders) {
                const res = await fetch(`${baseUrl}${path}`, {
                  method,
                  headers: {
                    Authorization: authHeader,
                    Accept: "application/json",
                    ...(body && !extraHeaders ? { "Content-Type": "application/json" } : {}),
                    ...(extraHeaders || {}),
                  },
                  body: body
                    ? extraHeaders
                      ? body
                      : JSON.stringify(body)
                    : undefined,
                });
                return res;
              }

              async function addComment(key, text) {
                const res = await jira("POST", `/rest/api/3/issue/${key}/comment`, {
                  body: adf(text),
                });
                if (!res.ok) {
                  throw new Error(`comment failed (${res.status}): ${await res.text()}`);
                }
                core.info(`Added comment to ${key}.`);
              }

              async function transitionIssue(key, targetName) {
                if (!targetName) return;
                const listRes = await jira("GET", `/rest/api/3/issue/${key}/transitions`);
                if (!listRes.ok) {
                  throw new Error(
                    `list transitions failed (${listRes.status}): ${await listRes.text()}`,
                  );
                }
                const { transitions = [] } = await listRes.json();
                const match = transitions.find(
                  (t) =>
                    t.name.toLowerCase() === targetName.toLowerCase() ||
                    (t.to && t.to.name.toLowerCase() === targetName.toLowerCase()),
                );
                if (!match) {
                  core.warning(
                    `No JIRA transition matching "${targetName}" for ${key}. ` +
                      `Available: ${transitions.map((t) => t.name).join(", ")}`,
                  );
                  return;
                }
                const res = await jira("POST", `/rest/api/3/issue/${key}/transitions`, {
                  transition: { id: match.id },
                });
                if (!res.ok) {
                  throw new Error(`transition failed (${res.status}): ${await res.text()}`);
                }
                core.info(`Transitioned ${key} -> ${match.name}.`);
              }

              async function attachScreenshot(key, url) {
                if (!url) return;
                const imgRes = await fetch(url);
                if (!imgRes.ok) {
                  core.warning(`Could not download screenshot ${url} (${imgRes.status}).`);
                  return;
                }
                const blob = await imgRes.blob();
                const form = new FormData();
                const name = url.split("/").pop() || "screenshot.png";
                form.append("file", blob, name);
                const res = await jira(
                  "POST",
                  `/rest/api/3/issue/${key}/attachments`,
                  form,
                  { "X-Atlassian-Token": "no-check" },
                );
                if (!res.ok) {
                  core.warning(
                    `Attachment upload failed (${res.status}): ${await res.text()}`,
                  );
                  return;
                }
                core.info(`Attached screenshot to ${key}.`);
              }

              // --- Process each requested report -------------------------------------
              for (const item of items) {
                const key = deriveKey(item);
                if (!key) {
                  core.warning(
                    "Could not derive a JIRA issue key from the PR title or branch; " +
                      "skipping this report.",
                  );
                  continue;
                }
                const header = item.status ? `**[${item.status}]** ` : "";
                const footer = process.env.PR_URL
                  ? `\n\n_via automated PR pipeline: ${process.env.PR_URL}_`
                  : "";
                const body = `${header}${item.comment}${footer}`;

                if (staged) {
                  await core.summary
                    .addHeading(`Staged JIRA report for ${key}`, 3)
                    .addRaw(`Transition: ${item.transition || "(none)"}\n\n`)
                    .addCodeBlock(body, "markdown")
                    .write();
                  continue;
                }

                await addComment(key, body);
                await transitionIssue(key, item.transition);
                await attachScreenshot(key, item.screenshot_url);
              }

        # Catch-all: if the JIRA reporting step above failed, signal that the
        # automation needs human attention directly on the JIRA issue.
        - name: Signal needs-human on failure
          if: failure()
          uses: actions/github-script@v8
          env:
            JIRA_BASE_URL: ${{ secrets.JIRA_BASE_URL }}
            JIRA_EMAIL: ${{ secrets.JIRA_EMAIL }}
            JIRA_API_TOKEN: ${{ secrets.JIRA_API_TOKEN }}
            PR_TITLE: ${{ github.event.pull_request.title || github.event.issue.title }}
            PR_BRANCH: ${{ github.event.pull_request.head.ref || github.head_ref || github.event.workflow_run.head_branch }}
            PR_URL: ${{ github.event.pull_request.html_url }}
          with:
            script: |
              const baseUrl = (process.env.JIRA_BASE_URL || "").replace(/\/+$/, "");
              const email = process.env.JIRA_EMAIL || "";
              const token = process.env.JIRA_API_TOKEN || "";
              if (!baseUrl || !email || !token) {
                core.warning("JIRA secrets not configured; cannot post needs-human signal.");
                return;
              }
              const KEY_RE = /\b([A-Za-z][A-Za-z0-9]+-\d+)\b/;
              let key = null;
              for (const src of [process.env.PR_TITLE, process.env.PR_BRANCH]) {
                const m = (src || "").match(KEY_RE);
                if (m) { key = m[1].toUpperCase(); break; }
              }
              if (!key) {
                core.warning("No JIRA key derivable; cannot post needs-human signal.");
                return;
              }
              const authHeader =
                "Basic " + Buffer.from(`${email}:${token}`).toString("base64");
              const text =
                "🤖 Automation failed — needs human. The automated PR pipeline could " +
                "not complete its JIRA update." +
                (process.env.PR_URL ? ` See ${process.env.PR_URL}` : "");
              const res = await fetch(`${baseUrl}/rest/api/3/issue/${key}/comment`, {
                method: "POST",
                headers: {
                  Authorization: authHeader,
                  Accept: "application/json",
                  "Content-Type": "application/json",
                },
                body: JSON.stringify({
                  body: {
                    type: "doc",
                    version: 1,
                    content: [
                      { type: "paragraph", content: [{ type: "text", text }] },
                    ],
                  },
                }),
              });
              if (!res.ok) {
                core.warning(`needs-human comment failed (${res.status}): ${await res.text()}`);
              }
---

## Reporting status back to JIRA

This workflow is linked to a JIRA issue through the pull request. When you have
finished your task and have a concise, human-readable result to share, call the
**`jira_report`** tool exactly once with:

- `comment` (required): a short markdown summary of what you did and the outcome.
- `status` (optional): one of `review-complete`, `changes-requested`,
  `qa-passed`, `qa-failed`, `fix-pushed`, or `needs-human`.
- `transition` (optional): a target JIRA status to move the ticket to, only if
  you are confident it should change (e.g. `In Review`).
- `screenshot_url` (optional): a URL returned by `upload-asset` to attach as
  evidence.
- `issue_key` (optional): only set this if you can see an explicit key; otherwise
  it is derived automatically from the PR title or branch.

Do not put any secrets or tokens in the `comment`. The JIRA credentials are held
by a separate job — you never see or handle them.
