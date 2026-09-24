// Talks to the GitHub Actions REST API: firing a `workflow_dispatch` event
// (the only way an on-demand admin command can make something happen that
// needs a real GitHub Actions runner — currently fortnite-jam-tracks-
// tracker's shop refresh, which needs the `canvas` native module
// bot-hosting.net's script policy blocks; see that feature's command.js and
// the root README's "Daily jobs" section) and enabling/disabling workflows
// (the routine on/off switch for the Fortnite tracker — see
// features/settings/routines.js).
//
// dispatchWorkflow is fire-and-forget by design: it only asks GitHub to
// start the run and confirms GitHub accepted the request — it does not wait
// for the run to finish, since a run habitually takes a minute or two
// (spin up a runner, apt-get, npm install) and there's no cheap way to
// watch it complete without polling.

import { config } from "./config.js";

const API_BASE = "https://api.github.com";

async function githubRequest(method, path, { body, action }) {
  if (!config.githubToken || !config.githubRepo) {
    throw new Error("Not configured. Set GITHUB_ACTIONS_TOKEN + GITHUB_REPO in .env");
  }

  const res = await fetch(`${API_BASE}/repos/${config.githubRepo}/actions/workflows/${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${config.githubToken}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`GitHub ${action} failed: ${res.status} ${res.statusText}${detail ? ` — ${detail}` : ""}`);
  }
}

export function dispatchWorkflow(workflowFile, ref = "main") {
  return githubRequest("POST", `${workflowFile}/dispatches`, { body: { ref }, action: "workflow dispatch" });
}

// A disabled workflow stops running on its schedule (and can't be
// dispatched) until it's enabled again.
export function setWorkflowEnabled(workflowFile, enabled) {
  return githubRequest("PUT", `${workflowFile}/${enabled ? "enable" : "disable"}`, {
    action: `workflow ${enabled ? "enable" : "disable"}`,
  });
}
