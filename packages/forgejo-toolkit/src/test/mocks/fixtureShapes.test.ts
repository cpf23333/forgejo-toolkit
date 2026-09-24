import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { mockDispatchWorkflowRun, mockNotifications } from './data';
import { resetMockServer, startMockServer, stopMockServer } from './server';

// The API's own response shapes, asserted on the raw mock responses (not
// through the client, which tolerates a few legacy spellings). A fixture that
// answers something the server cannot send makes a green suite meaningless for a
// real instance, which is what this file is here to prevent.
const api = 'https://forgejo.example.com/api/v1';
const repo = `${api}/repos/demo-user/demo-repo`;

async function getJson(path: string): Promise<unknown> {
  const response = await fetch(path);
  expect(response.ok).toBe(true);
  return response.json();
}

describe('Mock fixture shapes', () => {
  beforeAll(() => {
    startMockServer();
  });

  afterAll(() => {
    stopMockServer();
  });

  afterEach(() => {
    resetMockServer();
  });

  it('pages notifications with the limit and before cursor the view sends', async () => {
    const firstPage = (await getJson(`${api}/notifications?limit=1`)) as {
      id?: number;
      updated_at?: string;
    }[];
    expect(firstPage).toHaveLength(1);
    expect(firstPage[0].id).toBe(mockNotifications[0].id);

    const nextPage = (await getJson(`${api}/notifications?limit=10&before=${firstPage[0].updated_at}`)) as {
      id?: number;
    }[];
    expect(nextPage.map((notification) => notification.id)).toEqual(
      mockNotifications.slice(1).map((notification) => notification.id),
    );
  });

  it('filters notifications by the API subject type', async () => {
    const pulls = (await getJson(`${api}/notifications?subject-type=pull`)) as { subject?: { type?: string } }[];
    expect(pulls).toHaveLength(1);
    // `Pull` (not `PullRequest`) is what `structs.NotifySubjectType` sends.
    expect(pulls[0].subject?.type).toBe('Pull');
  });

  it('stamps and stores a tracked time the way the issue endpoint does', async () => {
    const before = (await getJson(`${repo}/issues/1/times?page=1&limit=50`)) as { id?: number }[];
    expect(before).toHaveLength(1);

    const created = (await (
      await fetch(`${repo}/issues/1/times`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ time: 120 }),
      })
    ).json()) as { id?: number; time?: number; created?: string };
    expect(created.time).toBe(120);
    expect(created.id).not.toBe(before[0].id);
    expect(created.created).toBeDefined();

    const after = (await getJson(`${repo}/issues/1/times?page=1&limit=1`)) as { id?: number }[];
    expect(after).toHaveLength(1);

    // `issueResetTime` removes every entry of the calling user.
    expect((await fetch(`${repo}/issues/1/times`, { method: 'DELETE' })).status).toBe(204);
    expect(await getJson(`${repo}/issues/1/times?page=1&limit=50`)).toEqual([]);
  });

  it('answers action jobs and artifacts as the bare arrays the API sends', async () => {
    const jobs = await getJson(`${repo}/actions/runs/42/jobs`);
    expect(Array.isArray(jobs)).toBe(true);
    expect((jobs as { run_id?: number }[])[0].run_id).toBe(42);

    const artifacts = await getJson(`${repo}/actions/runs/42/artifacts`);
    expect(Array.isArray(artifacts)).toBe(true);
    expect((artifacts as { run_id?: number }[])[0].run_id).toBe(42);
  });

  it('serves the run a dispatch mints and 404s an id no fixture declares', async () => {
    const dispatched = (await getJson(`${repo}/actions/runs/${mockDispatchWorkflowRun.id}`)) as { id?: number };
    expect(dispatched.id).toBe(mockDispatchWorkflowRun.id);

    const unknown = await fetch(`${repo}/actions/runs/999999`);
    expect(unknown.status).toBe(404);
  });

  it('reports a run with the field names and timestamp shape of the API', async () => {
    const run = (await getJson(`${repo}/actions/runs/42`)) as Record<string, unknown>;
    expect(run.prettyref).toBe('main');
    expect(run.created).toBeDefined();
    expect(run.updated).toBeDefined();
    // `duration` is a Go time.Duration, i.e. nanoseconds.
    expect(run.duration).toBe(595_000_000_000);
    for (const field of ['head_branch', 'url', 'created_at', 'updated_at']) {
      expect(run).not.toHaveProperty(field);
    }
  });

  it('leaves the computed merge status out of the pull request payload', async () => {
    const pr = (await getJson(`${repo}/pulls/2`)) as Record<string, unknown>;
    for (const field of ['mergeBlockers', 'statusChecks', 'repoPermissions', 'assets']) {
      expect(pr).not.toHaveProperty(field);
    }
    // The inputs the client computes them from are served as the API sends them.
    const protection = (await getJson(`${repo}/branch_protections/main`)) as Record<string, unknown>;
    expect(protection.branch_name).toBe('main');
    expect(protection).not.toHaveProperty('name');
    expect(protection).not.toHaveProperty('protected');

    const status = (await getJson(`${repo}/commits/def456/status`)) as Record<string, unknown>;
    expect(status.sha).toBe('def456');
    expect(status.total_count).toBe(1);
  });
});
