// Fires a GitHub Actions `workflow_dispatch` event via the REST API — the
// only way an on-demand admin command can make something happen that needs
// a real GitHub Actions runner (currently just fortnite-jam-tracks-tracker's
// shop refresh, which needs the `canvas` native module bot-hosting.net's
// script policy blocks — see that feature's command.js and the root
// README's "Daily jobs" section).
//
// Fire-and-forget by design: this only asks GitHub to start the run and
// confirms GitHub accepted the request — it does not wait for the run to
// finish or report back the run's own success/failure, since a workflow
// run habitually takes a minute or two (spin up a runner, apt-get, npm
// install) and there's no cheap way to watch it complete without polling.

import { config } from "./config.js";

const API_BASE = "https://api.github.com";

export async function dispatchWorkflow(workflowFile, ref = "main") {
  if (!config.githubToken || !config.githubRepo) {
    throw new Error("Not configured. Set GITHUB_ACTIONS_TOKEN + GITHUB_REPO in .env");
  }

  const res = await fetch(
    `${API_BASE}/repos/${config.githubRepo}/actions/workflows/${workflowFile}/dispatches`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.githubToken}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ ref }),
    }
  );

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`GitHub workflow dispatch failed: ${res.status} ${res.statusText}${body ? ` — ${body}` : ""}`);
  }
}
