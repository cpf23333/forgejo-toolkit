import { http, HttpResponse } from 'msw';
import {
  mockUser,
  mockRepository,
  mockRepository2,
  mockRepositoryFail,
  mockNotifications,
  mockIssues,
  mockIssueDetail,
  mockPullRequests,
  mockPullRequestDetail,
  mockRootContents,
  mockSrcContents,
  mockReadmeContent,
  mockIndexTsContent,
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

// Tracks a pending pull review created via POST pulls/:index/reviews so that
// review chaining (create pending → add comments → submit/delete) behaves
// like a real server across requests.
let pendingReview: Record<string, unknown> | undefined;
// Reviews submitted in this session stay visible to subsequent list calls, so
// merge-blocker checks can observe approvals after a submit.
let submittedReviews: Record<string, unknown>[] = [];
// Flipped by POST pulls/:index/merge so the detail and list endpoints reflect
// the merged state, like a real server.
let prMerged = false;

// Title/body/state edits made through PATCH issues/:index and pulls/:index
// persist for the rest of the session, so subsequent detail and list GETs
// reflect them like a real server.
let issueEdits: { title?: string; body?: string; state?: string } | undefined;
let pullEdits: { title?: string; body?: string; state?: string } | undefined;

// Restores every piece of mutable session state above. resetMockServer()
// calls this so each test starts from a clean slate.
export function resetMockState(): void {
  pendingReview = undefined;
  submittedReviews = [];
  prMerged = false;
  issueEdits = undefined;
  pullEdits = undefined;
}

// Slices a list response the way the real API does: `page`/`limit` query
// params select a window, and pages past the end return an empty array.
// Without an explicit `limit` the whole list is treated as a single page.
function paginate<T>(request: Request, items: T[]): T[] {
  const url = new URL(request.url);
  const page = Math.max(1, Number(url.searchParams.get('page')) || 1);
  const limit = Number(url.searchParams.get('limit')) || items.length || 1;
  const start = (page - 1) * limit;
  return items.slice(start, start + limit);
}

export const handlers = [
  http.get('https://*/api/v1/user', () => json(mockUser)),

  // Server version probe (feature gates); a modern version keeps every
  // feature enabled in the mock environment.
  http.get('https://*/api/v1/version', () => json({ version: '1.21.5' })),

  http.get('https://*/api/v1/user/repos', ({ request }) =>
    json(paginate(request, [mockRepository, mockRepository2, mockRepositoryFail])),
  ),

  http.get('https://*/api/v1/user/stopwatches', () => json([])),

  http.get('https://*/api/v1/notifications', ({ request }) => {
    const url = new URL(request.url);
    // Forgejo uses collectionFormat: multi — array params arrive as repeated keys.
    const statusTypes = url.searchParams.getAll('status-types');
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
    const data = [mockRepository, mockRepository2, mockRepositoryFail].filter((repo) =>
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
    return json(paginate(request, data));
  }),

  http.get('https://*/api/v1/users/search', () => json({ ok: true, data: [mockUser], total_count: 1 })),

  http.get('https://*/api/v1/users/:username', () => json(mockUser)),

  http.get('https://*/api/v1/repos/:owner/:repo', ({ params }) =>
    json(
      params.repo === mockRepository2.name
        ? mockRepository2
        : params.repo === mockRepositoryFail.name
          ? mockRepositoryFail
          : mockRepository,
    ),
  ),

  http.get('https://*/api/v1/repos/:owner/:repo/issues', ({ request }) => {
    const url = new URL(request.url);
    const state = url.searchParams.get('state') ?? 'open';
    const type = url.searchParams.get('type');
    const q = url.searchParams.get('q')?.toLowerCase();
    // `type=pulls` lists pull requests instead of issues, like the real API.
    let data: { title?: string; body?: string; state?: string; number?: number }[] =
      type === 'pulls' ? [...mockPullRequests] : [...mockIssues];
    data = data.map((item) =>
      type === 'pulls'
        ? item.number === mockPullRequestDetail.number
          ? { ...item, ...pullEdits }
          : item
        : item.number === mockIssueDetail.number
          ? { ...item, ...issueEdits }
          : item,
    );
    data = data.filter((item) => state === 'all' || item.state === state);
    if (q) {
      // The real API matches the query against title and body, case-insensitively.
      data = data.filter((item) => item.title?.toLowerCase().includes(q) || item.body?.toLowerCase().includes(q));
    }
    return json(paginate(request, data));
  }),

  http.get('https://*/api/v1/repos/:owner/:repo/issues/:index', () => json({ ...mockIssueDetail, ...issueEdits })),

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
    issueEdits = {
      title: body.title !== undefined ? String(body.title) : (issueEdits?.title ?? mockIssueDetail.title),
      body: body.body !== undefined ? String(body.body) : (issueEdits?.body ?? mockIssueDetail.body),
      state: body.state !== undefined ? String(body.state) : (issueEdits?.state ?? mockIssueDetail.state),
    };
    return json({ ...mockIssueDetail, ...issueEdits });
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
    let list = mockPullRequests.map((pr) =>
      pr.number === mockPullRequestDetail.number ? { ...pr, ...pullEdits } : pr,
    );
    if (prMerged) {
      list = list.map((pr) => (pr.number === mockPullRequestDetail.number ? { ...pr, state: 'closed' } : pr));
    }
    const data = list.filter((pr) => state === 'all' || pr.state === state);
    return json(paginate(request, data));
  }),

  http.get(
    'https://*/api/v1/repos/:owner/:repo/pulls/:index.diff',
    () => new HttpResponse(mockPullRequestDiff, { status: 200, headers: { 'Content-Type': 'text/plain' } }),
  ),

  http.get('https://*/api/v1/repos/:owner/:repo/pulls/:index', () =>
    json(
      prMerged
        ? { ...mockPullRequestDetail, ...pullEdits, state: 'closed', merged: true, merged_at: '2026-09-03T15:00:00Z' }
        : { ...mockPullRequestDetail, ...pullEdits },
    ),
  ),

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
    pullEdits = {
      title: body.title !== undefined ? String(body.title) : (pullEdits?.title ?? mockPullRequestDetail.title),
      body: body.body !== undefined ? String(body.body) : (pullEdits?.body ?? mockPullRequestDetail.body),
      state: body.state !== undefined ? String(body.state) : (pullEdits?.state ?? mockPullRequestDetail.state),
    };
    return json({ ...mockPullRequestDetail, ...pullEdits });
  }),

  http.get('https://*/api/v1/repos/:owner/:repo/pulls/:index/files', ({ request, params }) => {
    // Walkthrough failure switch: broken-repo always fails the changed-files
    // fetch, so the UI error state can be told apart from an empty file list.
    if (params.repo === mockRepositoryFail.name) {
      return json({ message: 'Mock failure: broken-repo cannot load changed files' }, 500);
    }
    return json(
      paginate(request, [{ filename: 'src/index.ts', status: 'modified', additions: 10, deletions: 2, changes: 12 }]),
    );
  }),

  http.get('https://*/api/v1/repos/:owner/:repo/compare/:basehead', () =>
    json({
      total_commits: 1,
      commits: [mockPullRequestCommit],
      files: [{ filename: 'src/index.ts', status: 'modified' }],
    }),
  ),

  http.get('https://*/api/v1/repos/:owner/:repo/issues/:index/timeline', ({ request }) =>
    json(paginate(request, [mockTimelineComment])),
  ),

  http.get('https://*/api/v1/repos/:owner/:repo/pulls/:index/commits', ({ request }) =>
    json(paginate(request, [mockPullRequestCommit])),
  ),

  http.post('https://*/api/v1/repos/:owner/:repo/pulls/:index/merge', () => {
    prMerged = true;
    return new HttpResponse(null, { status: 200 });
  }),

  http.get('https://*/api/v1/repos/:owner/:repo/pulls/:index/reviews', ({ request }) =>
    json(paginate(request, [mockPullReview, ...submittedReviews, ...(pendingReview ? [pendingReview] : [])])),
  ),

  http.get('https://*/api/v1/repos/:owner/:repo/pulls/:index/reviews/:id/comments', ({ request }) =>
    json(paginate(request, [mockPullReviewComment])),
  ),

  http.post('https://*/api/v1/repos/:owner/:repo/pulls/:index/reviews', async ({ request }) => {
    const body = (await request.json()) as { event?: string; body?: string; comments?: unknown[] };
    const review = {
      ...mockPullReview,
      state: body.event ?? mockPullReview.state,
      body: body.body ?? mockPullReview.body,
      comments: body.comments ?? [mockPullReviewComment],
    };
    // Keep the created pending review visible to subsequent list calls so the
    // "start review → add more comments → submit" flow can chain. Reviews
    // created directly with a final event are recorded as submitted.
    if (review.state === 'PENDING') {
      pendingReview = review;
    } else if (body.event) {
      submittedReviews.push({ ...review, official: true });
    }
    return json(review);
  }),

  http.post('https://*/api/v1/repos/:owner/:repo/pulls/:index/reviews/:id/comments', async ({ request, params }) => {
    // The real API only accepts comments on a pending review.
    if (!pendingReview || String(pendingReview.id) !== String(params.id)) {
      return json({ message: 'review is not pending' }, 422);
    }
    const body = (await request.json()) as Record<string, unknown>;
    return json({ ...mockPullReviewComment, body: String(body.body ?? mockPullReviewComment.body) });
  }),

  http.post('https://*/api/v1/repos/:owner/:repo/pulls/:index/reviews/:id', async ({ request, params }) => {
    // The real API only submits a pending review.
    if (!pendingReview || String(pendingReview.id) !== String(params.id)) {
      return json({ message: 'review is not pending' }, 422);
    }
    const body = (await request.json()) as { event?: string; body?: string };
    pendingReview = undefined;
    const submitted = {
      ...mockPullReview,
      state: body.event ?? mockPullReview.state,
      body: body.body ?? mockPullReview.body,
      official: true,
    };
    submittedReviews.push(submitted);
    return json(submitted);
  }),

  http.delete('https://*/api/v1/repos/:owner/:repo/pulls/:index/reviews/:id', () => {
    pendingReview = undefined;
    return new HttpResponse(null, { status: 204 });
  }),

  http.delete(
    'https://*/api/v1/repos/:owner/:repo/pulls/:index/reviews/:id/comments/:comment',
    () => new HttpResponse(null, { status: 204 }),
  ),

  http.get('https://*/api/v1/repos/:owner/:repo/contents', () => json(mockRootContents)),

  http.get('https://*/api/v1/repos/:owner/:repo/contents/src', () => json(mockSrcContents)),

  http.get('https://*/api/v1/repos/:owner/:repo/contents/README.md', () => json(mockReadmeContent)),

  http.get('https://*/api/v1/repos/:owner/:repo/contents/src/index.ts', () => json(mockIndexTsContent)),

  // Catch-all for paths without a dedicated fixture: return placeholder
  // content instead of 404 so walkthroughs can open any file (diff editor old/
  // new versions, repo browser). The requested `ref` is echoed into the
  // content so different branches stay visually distinguishable.
  http.get('https://*/api/v1/repos/:owner/:repo/contents/*', ({ request }) => {
    const url = new URL(request.url);
    const ref = url.searchParams.get('ref');
    const filepath = decodeURIComponent(url.pathname.split('/contents/')[1] ?? '');
    const name = filepath.split('/').pop() ?? filepath;
    const text = `// Mock content for ${filepath}\n// ref: ${ref ?? 'default branch'}\n`;
    return json({
      name,
      path: filepath,
      type: 'file',
      sha: `mock-sha-${filepath}`,
      size: text.length,
      content: btoa(text),
      encoding: 'base64',
    });
  }),

  http.get('https://*/api/v1/repos/:owner/:repo/branches', ({ request }) =>
    json(
      paginate(request, [
        { name: 'main', commit: { sha: 'abc123' }, protected: true },
        { name: 'dev', commit: { sha: 'def456' }, protected: false },
      ]),
    ),
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
      apply_to_admins: true,
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

  http.get('https://*/api/v1/repos/:owner/:repo/tags', ({ request }) => json(paginate(request, [{ name: 'v1.0.0' }]))),

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

  http.get('https://*/api/v1/repos/:owner/:repo/labels', ({ request }) => json(paginate(request, [mockLabel]))),

  http.get('https://*/api/v1/repos/:owner/:repo/assignees', () => json(mockAssignees)),

  http.get('https://*/api/v1/repos/:owner/:repo/milestones', ({ request }) => json(paginate(request, [mockMilestone]))),

  http.post('https://*/api/v1/markdown', async ({ request }) => {
    const body = (await request.json()) as Record<string, unknown>;
    const text = String(body.Text ?? '');
    const html = text.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>').replace(/__(.+?)__/g, '<strong>$1</strong>');
    return new HttpResponse(`<p>${html}</p>`, {
      status: 200,
      headers: { 'Content-Type': 'text/html' },
    });
  }),

  http.get('https://*/api/v1/repos/:owner/:repo/actions/runs', () =>
    json({ total_count: 1, workflow_runs: [mockActionRun] }),
  ),

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
