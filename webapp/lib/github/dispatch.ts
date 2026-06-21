/**
 * GitHub repository_dispatch helper for the in-app Discovery feature.
 *
 * The webapp enqueues a pipeline_runs row, then fires a repository_dispatch
 * event with type "discover". A GitHub Actions workflow listens for that event
 * and runs the lead pipeline orchestrator (tools/run_pipeline.py), which updates
 * the run row by id as it goes.
 *
 * Runs in a Node route handler (needs network + raw env, not Edge).
 */

export type DiscoveryDispatchPayload = {
  run_id: string;
  country: string;
  target: number;
};

export type TriggerResult =
  | { ok: true }
  | { ok: false; error: 'github_not_configured' | 'trigger_failed'; detail?: string };

/**
 * Fires a repository_dispatch "discover" event so the CI worker picks up the run.
 *
 * Reads env GITHUB_OWNER, GITHUB_REPO, GITHUB_DISPATCH_TOKEN. If any are missing,
 * returns { ok:false, error:'github_not_configured' } without making a request.
 *
 * GitHub returns 204 No Content on success. Any other status (or a network
 * failure) returns { ok:false, error:'trigger_failed', detail }.
 */
export async function triggerDiscoveryRun(
  payload: DiscoveryDispatchPayload
): Promise<TriggerResult> {
  const owner = process.env.GITHUB_OWNER;
  const repo = process.env.GITHUB_REPO;
  const token = process.env.GITHUB_DISPATCH_TOKEN;

  if (!owner || !repo || !token) {
    return { ok: false, error: 'github_not_configured' };
  }

  const url = `https://api.github.com/repos/${owner}/${repo}/dispatches`;

  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        event_type: 'discover',
        client_payload: payload,
      }),
    });
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e);
    return { ok: false, error: 'trigger_failed', detail: detail.slice(0, 200) };
  }

  if (res.status === 204) {
    return { ok: true };
  }

  let text = '';
  try {
    text = await res.text();
  } catch {
    // ignore body read failures — status alone is enough to report.
  }
  return {
    ok: false,
    error: 'trigger_failed',
    detail: `${res.status} ${text.slice(0, 200)}`,
  };
}
