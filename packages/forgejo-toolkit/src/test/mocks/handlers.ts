import { http, HttpResponse } from 'msw';
import {
  mockUser,
  mockRepository,
  mockRepository2,
  mockNotifications,
  mockIssues,
  mockIssueDetail,
  mockPullRequests,
  mockPullRequestDetail,
  mockRootContents,
  mockSrcContents,
  mockReadmeContent,
  mockActionRun,
  mockActionRunJob,
  mockActionArtifact,
  mockDispatchWorkflowRun,
  mockBranch,
  mockTag,
  mockRelease,
  mockReleaseAttachment,
  mockLabel,
  mockAssignees,
  mockMilestone,
  mockReaction,
  mockTrackedTime,
  mockWatchInfo,
  mockDependencies,
  mockIssueAttachment,
  mockCommentAttachment,
  mockPullReview,
  mockPullReviewComment,
  mockPullRequestCommit,
  mockPullRequestDiff,
  mockTimelineComment,
  mockHistoryCommit,
} from './data';

function json(data: unknown, status = 200) {
  return HttpResponse.json(data as Parameters<typeof HttpResponse.json>[0], { status });
}

export const handlers = [
  http.get('https://*/api/v1/user', () => json(mockUser)),

  http.get('https://*/api/v1/user/repos', () => json([mockRepository, mockRepository2])),

  http.get('https://*/api/v1/user/stopwatches', () => json([])),

  http.get('https://*/api/v1/notifications', ({ request }) => {
    const url = new URL(request.url);
    const rawStatusTypes = url.searchParams.getAll('status-types');
    const statusTypes = rawStatusTypes.flatMap((value) => value.split(','));
    let result = mockNotifications;
    if (statusTypes.length > 0 && !statusTypes.includes('all')) {
      result = result.filter((notification) => {
        if (statusTypes.includes('unread') && notification.unread) return true;
        if (statusTypes.includes('pinned') && notification.pinned) return true;
        if (statusTypes.includes('read') && !notification.unread) return true;
        return false;
      });
    }
    return json(result);
  }),

  http.patch('https://*/api/v1/notifications', () => json([])),

  http.put('https://*/api/v1/notifications', () => json([])),

  http.patch('https://*/api/v1/notifications/threads/:id', () => json({})),

  http.get('https://*/api/v1/repos/search', ({ request }) => {
    const url = new URL(request.url);
    const query = url.searchParams.get('q') ?? '';
    const data = [mockRepository, mockRepository2].filter((repo) =>
      repo.full_name.toLowerCase().includes(query.toLowerCase()),
    );
    return json({ ok: true, data, total_count: data.length });
  }),

  http.get('https://*/api/v1/repos/issues/search', ({ request }) => {
    const url = new URL(request.url);
    const type = url.searchParams.get('type');
    const state = url.searchParams.get('state') ?? 'open';
    let data: typeof mockIssues | typeof mockPullRequests = [...mockIssues];
    if (type === 'pulls') {
      data = [...mockPullRequests];
    }
    data = data.filter((item) => state === 'all' || item.state === state);
    return json(data);
  }),

  http.get('https://*/api/v1/users/search', () => json({ ok: true, data: [mockUser], total_count: 1 })),

  http.get('https://*/api/v1/users/:username', () => json(mockUser)),

  http.get('https://*/api/v1/repos/:owner/:repo', () => json(mockRepository)),

  http.get('https://*/api/v1/repos/:owner/:repo/issues', ({ request }) => {
    const url = new URL(request.url);
    const state = url.searchParams.get('state') ?? 'open';
    const data = mockIssues.filter((issue) => state === 'all' || issue.state === state);
    return json(data);
  }),

  http.get('https://*/api/v1/repos/:owner/:repo/issues/:index', () => json(mockIssueDetail)),

  http.post('https://*/api/v1/repos/:owner/:repo/issues', async ({ request }) => {
    const body = (await request.json()) as Record<string, unknown>;
    return json(
      {
        ...mockIssueDetail,
        title: String(body.title ?? mockIssueDetail.title),
        body: String(body.body ?? mockIssueDetail.body),
      },
      201,
    );
  }),

  http.patch('https://*/api/v1/repos/:owner/:repo/issues/:index', async ({ request }) => {
    const body = (await request.json()) as Record<string, unknown>;
    return json({
      ...mockIssueDetail,
      title: String(body.title ?? mockIssueDetail.title),
      body: String(body.body ?? mockIssueDetail.body),
      state: String(body.state ?? mockIssueDetail.state),
    });
  }),

  http.delete('https://*/api/v1/repos/:owner/:repo/issues/:index', () => new HttpResponse(null, { status: 204 })),

  http.put('https://*/api/v1/repos/:owner/:repo/issues/:index/labels', async ({ request }) => {
    const body = (await request.json()) as { labels?: number[] };
    return json(
      (body.labels ?? []).map((id) => ({
        ...mockLabel,
        id,
      })),
    );
  }),

  http.get('https://*/api/v1/repos/:owner/:repo/issues/:index/subscriptions/check', () => json(mockWatchInfo)),

  http.put('https://*/api/v1/repos/:owner/:repo/issues/:index/subscriptions/:user', () => json({})),

  http.delete(
    'https://*/api/v1/repos/:owner/:repo/issues/:index/subscriptions/:user',
    () => new HttpResponse(null, { status: 204 }),
  ),

  http.post('https://*/api/v1/repos/:owner/:repo/issues/:index/stopwatch/start', () => json({})),

  http.post('https://*/api/v1/repos/:owner/:repo/issues/:index/stopwatch/stop', () => json({})),

  http.delete(
    'https://*/api/v1/repos/:owner/:repo/issues/:index/stopwatch/delete',
    () => new HttpResponse(null, { status: 204 }),
  ),

  http.get('https://*/api/v1/repos/:owner/:repo/issues/:index/times', () => json([mockTrackedTime])),

  http.post('https://*/api/v1/repos/:owner/:repo/issues/:index/times', async ({ request }) => {
    const body = (await request.json()) as { time?: number };
    return json({ ...mockTrackedTime, time: body.time ?? mockTrackedTime.time });
  }),

  http.delete('https://*/api/v1/repos/:owner/:repo/issues/:index/times', () => new HttpResponse(null, { status: 204 })),

  http.delete(
    'https://*/api/v1/repos/:owner/:repo/issues/:index/times/:id',
    () => new HttpResponse(null, { status: 204 }),
  ),

  http.get('https://*/api/v1/repos/:owner/:repo/issues/:index/dependencies', () => json(mockDependencies)),

  http.post('https://*/api/v1/repos/:owner/:repo/issues/:index/dependencies', () => json({})),

  http.delete(
    'https://*/api/v1/repos/:owner/:repo/issues/:index/dependencies',
    () => new HttpResponse(null, { status: 204 }),
  ),

  http.get('https://*/api/v1/repos/:owner/:repo/issues/:index/reactions', () => json([mockReaction])),

  http.post('https://*/api/v1/repos/:owner/:repo/issues/:index/reactions', async ({ request }) => {
    const body = (await request.json()) as { content?: string };
    return json({ ...mockReaction, content: body.content ?? mockReaction.content });
  }),

  http.delete(
    'https://*/api/v1/repos/:owner/:repo/issues/:index/reactions',
    () => new HttpResponse(null, { status: 204 }),
  ),

  http.get('https://*/api/v1/repos/:owner/:repo/issues/comments/:id/reactions', () => json([mockReaction])),

  http.post('https://*/api/v1/repos/:owner/:repo/issues/comments/:id/reactions', async ({ request }) => {
    const body = (await request.json()) as { content?: string };
    return json({ ...mockReaction, content: body.content ?? mockReaction.content });
  }),

  http.delete(
    'https://*/api/v1/repos/:owner/:repo/issues/comments/:id/reactions',
    () => new HttpResponse(null, { status: 204 }),
  ),

  http.post('https://*/api/v1/repos/:owner/:repo/issues/:index/assets', () => json(mockIssueAttachment)),

  http.delete(
    'https://*/api/v1/repos/:owner/:repo/issues/:index/assets/:attachment_id',
    () => new HttpResponse(null, { status: 204 }),
  ),

  http.get('https://*/api/v1/repos/:owner/:repo/pulls', ({ request }) => {
    const url = new URL(request.url);
    const state = url.searchParams.get('state') ?? 'open';
    const data = mockPullRequests.filter((pr) => state === 'all' || pr.state === state);
    return json(data);
  }),

  http.get(
    'https://*/api/v1/repos/:owner/:repo/pulls/:index.diff',
    () => new HttpResponse(mockPullRequestDiff, { status: 200, headers: { 'Content-Type': 'text/plain' } }),
  ),

  http.get('https://*/api/v1/repos/:owner/:repo/pulls/:index', () => json(mockPullRequestDetail)),

  http.post('https://*/api/v1/repos/:owner/:repo/pulls', async ({ request }) => {
    const body = (await request.json()) as Record<string, unknown>;
    return json(
      {
        ...mockPullRequestDetail,
        title: String(body.title ?? mockPullRequestDetail.title),
        body: String(body.body ?? mockPullRequestDetail.body),
      },
      201,
    );
  }),

  http.patch('https://*/api/v1/repos/:owner/:repo/pulls/:index', async ({ request }) => {
    const body = (await request.json()) as Record<string, unknown>;
    return json({
      ...mockPullRequestDetail,
      title: String(body.title ?? mockPullRequestDetail.title),
      body: String(body.body ?? mockPullRequestDetail.body),
      state: String(body.state ?? mockPullRequestDetail.state),
    });
  }),

  http.get('https://*/api/v1/repos/:owner/:repo/pulls/:index/files', () =>
    json([{ filename: 'src/index.ts', status: 'modified', additions: 10, deletions: 2, changes: 12 }]),
  ),

  http.get('https://*/api/v1/repos/:owner/:repo/compare/:basehead', () =>
    json({
      total_commits: 1,
      commits: [mockPullRequestCommit],
      files: [{ filename: 'src/index.ts', status: 'modified' }],
    }),
  ),

  http.get('https://*/api/v1/repos/:owner/:repo/issues/:index/timeline', () => json([mockTimelineComment])),

  http.get('https://*/api/v1/repos/:owner/:repo/pulls/:index/commits', () => json([mockPullRequestCommit])),

  http.post('https://*/api/v1/repos/:owner/:repo/pulls/:index/merge', () => new HttpResponse(null, { status: 200 })),

  http.get('https://*/api/v1/repos/:owner/:repo/pulls/:index/reviews', () => json([mockPullReview])),

  http.get('https://*/api/v1/repos/:owner/:repo/pulls/:index/reviews/:id/comments', () =>
    json([mockPullReviewComment]),
  ),

  http.post('https://*/api/v1/repos/:owner/:repo/pulls/:index/reviews', async ({ request }) => {
    const body = (await request.json()) as { event?: string; body?: string; comments?: unknown[] };
    return json({
      ...mockPullReview,
      state: body.event ?? mockPullReview.state,
      body: body.body ?? mockPullReview.body,
      comments: body.comments ?? [mockPullReviewComment],
    });
  }),

  http.post('https://*/api/v1/repos/:owner/:repo/pulls/:index/reviews/:id/comments', async ({ request }) => {
    const body = (await request.json()) as Record<string, unknown>;
    return json({ ...mockPullReviewComment, body: String(body.body ?? mockPullReviewComment.body) });
  }),

  http.post('https://*/api/v1/repos/:owner/:repo/pulls/:index/reviews/:id', async ({ request }) => {
    const body = (await request.json()) as { event?: string; body?: string };
    return json({
      ...mockPullReview,
      state: body.event ?? mockPullReview.state,
      body: body.body ?? mockPullReview.body,
    });
  }),

  http.delete(
    'https://*/api/v1/repos/:owner/:repo/pulls/:index/reviews/:id',
    () => new HttpResponse(null, { status: 204 }),
  ),

  http.delete(
    'https://*/api/v1/repos/:owner/:repo/pulls/:index/reviews/:id/comments/:comment',
    () => new HttpResponse(null, { status: 204 }),
  ),

  http.get('https://*/api/v1/repos/:owner/:repo/contents', () => json(mockRootContents)),

  http.get('https://*/api/v1/repos/:owner/:repo/contents/src', () => json(mockSrcContents)),

  http.get('https://*/api/v1/repos/:owner/:repo/contents/README.md', () => json(mockReadmeContent)),

  http.get('https://*/api/v1/repos/:owner/:repo/contents/:filepath', () => json({ message: 'Not Found' }, 404)),

  http.get('https://*/api/v1/repos/:owner/:repo/branches', () =>
    json([
      { name: 'main', commit: { sha: 'abc123' }, protected: true },
      { name: 'dev', commit: { sha: 'def456' }, protected: false },
    ]),
  ),

  http.post('https://*/api/v1/repos/:owner/:repo/branches', async ({ request }) => {
    const body = (await request.json()) as { branch_name?: string };
    return json({ ...mockBranch, name: body.branch_name ?? mockBranch.name }, 201);
  }),

  http.delete('https://*/api/v1/repos/:owner/:repo/branches/:branch', () => new HttpResponse(null, { status: 204 })),

  http.get('https://*/api/v1/repos/:owner/:repo/branch_protections/:name', () =>
    json({
      name: 'main',
      protected: true,
      required_approvals: 1,
      enable_status_check: true,
      status_check_contexts: ['ci/build'],
      apply_to_admins: false,
    }),
  ),

  http.get('https://*/api/v1/repos/:owner/:repo/commits/:ref/status', () =>
    json({
      state: 'success',
      statuses: [
        {
          id: 1,
          context: 'ci/build',
          description: 'Build passed',
          status: 'success',
          target_url: 'https://forgejo.example.com/demo-user/demo-repo/actions/runs/1',
          created_at: '2026-08-17T09:00:00Z',
          updated_at: '2026-08-17T09:10:00Z',
        },
      ],
    }),
  ),

  http.get('https://*/api/v1/repos/:owner/:repo/tags', () => json([{ name: 'v1.0.0' }])),

  http.post('https://*/api/v1/repos/:owner/:repo/tags', async ({ request }) => {
    const body = (await request.json()) as { tag_name?: string };
    return json({ ...mockTag, name: body.tag_name ?? mockTag.name }, 201);
  }),

  http.delete('https://*/api/v1/repos/:owner/:repo/tags/:tag', () => new HttpResponse(null, { status: 204 })),

  http.get('https://*/api/v1/repos/:owner/:repo/releases', () => json([])),

  http.post('https://*/api/v1/repos/:owner/:repo/releases', async ({ request }) => {
    const body = (await request.json()) as { tag_name?: string; name?: string };
    return json(
      { ...mockRelease, tag_name: body.tag_name ?? mockRelease.tag_name, name: body.name ?? mockRelease.name },
      201,
    );
  }),

  http.patch('https://*/api/v1/repos/:owner/:repo/releases/:id', async ({ request }) => {
    const body = (await request.json()) as { name?: string };
    return json({ ...mockRelease, name: body.name ?? mockRelease.name });
  }),

  http.post('https://*/api/v1/repos/:owner/:repo/releases/:id/assets', () => json(mockReleaseAttachment)),

  http.delete(
    'https://*/api/v1/repos/:owner/:repo/releases/:id/assets/:attachment_id',
    () => new HttpResponse(null, { status: 204 }),
  ),

  http.delete('https://*/api/v1/repos/:owner/:repo/releases/:id', () => new HttpResponse(null, { status: 204 })),

  http.get('https://*/api/v1/repos/:owner/:repo/commits', ({ request }) => {
    const url = new URL(request.url);
    const path = url.searchParams.get('path');
    if (path) {
      return json([mockHistoryCommit]);
    }
    return json([
      {
        sha: 'abc123',
        commit: {
          message: 'Initial commit',
          author: { name: 'Demo User', date: '2026-08-01T00:00:00Z' },
        },
        html_url: 'https://forgejo.example.com/demo-user/demo-repo/commit/abc123',
      },
    ]);
  }),

  http.get('https://*/api/v1/repos/:owner/:repo/git/trees/:sha', ({ request }) => {
    const url = new URL(request.url);
    const recursive = url.searchParams.get('recursive');
    if (recursive) {
      return json({
        sha: 'tree-sha',
        tree: [
          { path: 'src/index.ts', type: 'blob' },
          { path: 'src/utils.ts', type: 'blob' },
          { path: 'README.md', type: 'blob' },
        ],
        truncated: false,
      });
    }
    return json({ sha: 'tree-sha', tree: [], truncated: false });
  }),

  http.get('https://*/api/v1/repos/:owner/:repo/labels', () => json([mockLabel])),

  http.get('https://*/api/v1/repos/:owner/:repo/assignees', () => json(mockAssignees)),

  http.get('https://*/api/v1/repos/:owner/:repo/milestones', () => json([mockMilestone])),

  http.post('https://*/api/v1/markdown', async ({ request }) => {
    const body = (await request.json()) as Record<string, unknown>;
    const text = String(body.Text ?? '');
    const html = text.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>').replace(/__(.+?)__/g, '<strong>$1</strong>');
    return new HttpResponse(`<p>${html}</p>`, {
      status: 200,
      headers: { 'Content-Type': 'text/html' },
    });
  }),

  http.get('https://*/api/v1/repos/:owner/:repo/actions/runs', () => json({ total_count: 0, workflow_runs: [] })),

  http.get('https://*/api/v1/repos/:owner/:repo/actions/runs/:run_id', () => json(mockActionRun)),

  http.get('https://*/api/v1/repos/:owner/:repo/actions/runs/:run_id/jobs', () => json({ jobs: [mockActionRunJob] })),

  http.get('https://*/api/v1/repos/:owner/:repo/actions/runs/:run_id/artifacts', () =>
    json({ artifacts: [mockActionArtifact] }),
  ),

  http.get(
    'https://*/api/v1/repos/:owner/:repo/actions/jobs/:job_id/logs',
    () => new HttpResponse('build log output', { status: 200, headers: { 'Content-Type': 'text/plain' } }),
  ),

  http.post(
    'https://*/api/v1/repos/:owner/:repo/actions/workflows/:workflowfilename/dispatches',
    async ({ request }) => {
      const body = (await request.json()) as { ref?: string };
      return json({ ...mockDispatchWorkflowRun, head_branch: body.ref ?? 'main' });
    },
  ),

  http.post(
    'https://*/api/v1/repos/:owner/:repo/actions/runs/:run_id/cancel',
    () => new HttpResponse(null, { status: 204 }),
  ),

  http.get(
    'https://*/api/v1/repos/:owner/:repo/actions/artifacts/:artifact_id/zip',
    () =>
      new HttpResponse(new Uint8Array([1, 2, 3]).buffer, {
        status: 200,
        headers: { 'Content-Type': 'application/zip' },
      }),
  ),

  http.delete(
    'https://*/api/v1/repos/:owner/:repo/actions/runs/:run_id',
    () => new HttpResponse(null, { status: 204 }),
  ),

  http.post('https://*/api/v1/repos/:owner/:repo/issues/:index/comments', async ({ request }) => {
    const body = (await request.json()) as { body?: string };
    return json({ ...mockTimelineComment, body: body.body ?? mockTimelineComment.body }, 201);
  }),

  http.patch('https://*/api/v1/repos/:owner/:repo/issues/comments/:id', async ({ request }) => {
    const body = (await request.json()) as { body?: string };
    return json({ ...mockTimelineComment, body: body.body ?? mockTimelineComment.body });
  }),

  http.delete('https://*/api/v1/repos/:owner/:repo/issues/comments/:id', () => new HttpResponse(null, { status: 204 })),

  http.delete(
    'https://*/api/v1/repos/:owner/:repo/issues/comments/:id/assets/:attachment_id',
    () => new HttpResponse(null, { status: 204 }),
  ),

  http.post('https://*/api/v1/repos/:owner/:repo/issues/comments/:id/assets', () => json(mockCommentAttachment)),

  http.get('https://*/api/v1/repos/:owner/:repo/issues/comments/:id/assets', () => json([mockCommentAttachment])),
];
