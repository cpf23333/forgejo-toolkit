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
  mockDocsContents,
  mockContentFilePaths,
  mockContentFileTexts,
  mockContentListings,
  mockPlaceholderFileText,
  mockReadmeContent,
  mockIndexTsContent,
  mockActionRuns,
  mockActionRunJob,
  mockActionArtifact,
  mockDispatchWorkflowRun,
  mockDispatchedActionRun,
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

// Entries removed through the delete endpoints disappear from later GETs. The
// fixtures are static, so without this a confirmed delete and a cancelled one
// looked identical in the dev host: the row came back on the next fetch.
let trackedTimes: (typeof mockTrackedTime)[] = [mockTrackedTime];
let dependencies: typeof mockDependencies = [...mockDependencies];
let commentAttachments: (typeof mockCommentAttachment)[] = [mockCommentAttachment];
// The release list serves the fixture release, so the release edit dialog (and
// the attachment delete it contains) is reachable in a walkthrough. Without it
// the refs view showed "no releases" and that confirmation had nothing to click.
let releases: (typeof mockRelease)[] = [mockRelease];

// Restores every piece of mutable session state above. resetMockServer()
// calls this so each test starts from a clean slate.
export function resetMockState(): void {
  pendingReview = undefined;
  submittedReviews = [];
  prMerged = false;
  issueEdits = undefined;
  pullEdits = undefined;
  trackedTimes = [mockTrackedTime];
  dependencies = [...mockDependencies];
  commentAttachments = [mockCommentAttachment];
  releases = [mockRelease];
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

/**
 * Version the mocked `/api/v1/version` reports. Tests that assert the probed
 * version import this constant instead of hardcoding a literal, so bumping the
 * mock server version cannot leave stale assertions behind.
 */
export const MOCK_SERVER_VERSION = '16.0.5';

/**
 * A repository with no commits. Every contents path answers an empty list for it
 * (see the handlers below), which is what makes "empty directory" and "empty
 * repository" indistinguishable from the response alone.
 */
export const MOCK_EMPTY_REPO = 'empty-repo';

/**
 * Comment bodies the mocked issue indexer matches, keyed by issue/PR number,
 * plus a keyword that appears *only* in one of them. Forgejo's issue indexer
 * searches `title`, `content` and `comments` (see the bleve mapping in
 * `modules/indexer/issues`), so a keyword that appears only in a comment is a
 * real match; a mock that matched the title and body alone described a server
 * that does not exist, and hid a listing bug where the client re-filtered the
 * server's rows and dropped comment-only matches.
 */
export const MOCK_COMMENT_ONLY_KEYWORD = 'regression';

const mockCommentBodies: Record<number, string[]> = {
  1: ['Regression in the login form: a valid 2FA code is rejected.'],
  2: ['Regression in the dark mode toggle: it resets on reload.'],
};

/** Whether the mocked server's issue indexer would match `item` for `query`. */
function issueMatchesKeyword(item: { title?: string; body?: string; number?: number }, query: string): boolean {
  const needle = query.toLowerCase();
  const fields = [item.title, item.body, ...(mockCommentBodies[item.number ?? -1] ?? [])];
  return fields.some((field) => typeof field === 'string' && field.toLowerCase().includes(needle));
}

export const handlers = [
  http.get('https://*/api/v1/user', () => json(mockUser)),

  // Server version probe (feature gates); a modern version keeps every
  // feature enabled in the mock environment.
  http.get('https://*/api/v1/version', () => json({ version: MOCK_SERVER_VERSION })),

  http.get('https://*/api/v1/user/repos', ({ request }) =>
    json(paginate(request, [mockRepository, mockRepository2, mockRepositoryFail])),
  ),

  // Publish flow: creating a repository echoes the requested name back with
  // the clone URL the publish command needs to add the remote.
  http.post('https://*/api/v1/user/repos', async ({ request }) => {
    const body = (await request.json()) as { name?: string; private?: boolean };
    const name = body.name ?? 'new-repo';
    return json(
      {
        ...mockRepository,
        name,
        full_name: `demo-user/${name}`,
        html_url: `https://forgejo.example.com/demo-user/${name}`,
        clone_url: `https://forgejo.example.com/demo-user/${name}.git`,
        private: Boolean(body.private),
      },
      201,
    );
  }),

  http.get('https://*/api/v1/user/stopwatches', () => json([])),

  http.get('https://*/api/v1/notifications', ({ request }) => {
    const url = new URL(request.url);
    // Forgejo uses collectionFormat: multi — array params arrive as repeated keys.
    const statusTypes = url.searchParams.getAll('status-types');
    const subjectTypes = url.searchParams.getAll('subject-type');
    let result = mockNotifications;
    if (statusTypes.length > 0 && !statusTypes.includes('all')) {
      result = result.filter((notification) => {
        if (statusTypes.includes('unread') && notification.unread) return true;
        if (statusTypes.includes('pinned') && notification.pinned) return true;
        if (statusTypes.includes('read') && !notification.unread) return true;
        return false;
      });
    }
    if (subjectTypes.length > 0) {
      // The filter is spelled in the API's own values: `issue`, `pull`,
      // `repository` map onto the subject's `Issue`, `Pull`, `Repository`.
      const wanted = subjectTypes.map((type) => type.toLowerCase());
      result = result.filter((notification) => {
        const subject = notification.subject?.type?.toLowerCase();
        if (!subject) return false;
        if (wanted.includes(subject)) return true;
        // `pull` is the API's value; accept the spelling some clients send.
        return subject === 'pull' && wanted.includes('pullrequest');
      });
    }
    const before = url.searchParams.get('before');
    if (before) {
      // `before` is the page cursor and the server's comparison is inclusive:
      // `UpdatedBeforeUnix` builds a `Lte` condition, so a thread updated at
      // exactly that instant comes back in the next page too. A strict `<` here
      // described a server that does not exist and left the documented repeat
      // (and the skip it forces on the caller) untested.
      result = result.filter((notification) => (notification.updated_at ?? '') <= before);
    }
    // Newest first, then one page: the webview pages with `before` set to the
    // oldest entry it holds and stops when a page comes back short.
    const ordered = [...result].sort((a, b) => (b.updated_at ?? '').localeCompare(a.updated_at ?? ''));
    const requestedLimit = Number(url.searchParams.get('limit'));
    const limit = Number.isFinite(requestedLimit) && requestedLimit > 0 ? requestedLimit : ordered.length;
    return json(ordered.slice(0, limit));
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
    const q = url.searchParams.get('q');
    let data: typeof mockIssues | typeof mockPullRequests = [...mockIssues];
    if (type === 'pulls') {
      data = [...mockPullRequests];
    }
    data = data.filter((item) => state === 'all' || item.state === state);
    if (q) {
      // The same indexer as the repository listing below: title, body and
      // comments. The instance-wide listing takes `q` too (see
      // ForgejoClient.getUserIssues).
      data = data.filter((item) => issueMatchesKeyword(item, q));
    }
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
      // The real API runs the keyword through its issue indexer, which matches
      // the title, the body and the comments (not the author).
      data = data.filter((item) => issueMatchesKeyword(item, q));
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

  // Paginated like every other list endpoint: the client pages with `page` and
  // `limit`, so a handler that answered the whole list on page 1 would make the
  // client's "short page means the end" rule depend on the fixture's size.
  http.get('https://*/api/v1/repos/:owner/:repo/issues/:index/times', ({ request }) =>
    json(paginate(request, trackedTimes)),
  ),

  http.post('https://*/api/v1/repos/:owner/:repo/issues/:index/times', async ({ request }) => {
    const body = (await request.json()) as { time?: number; created?: string };
    const created = {
      ...mockTrackedTime,
      // A real server assigns the next id, stamps the entry and stores it; a
      // response that was not stored made "add time" and a cancelled add look
      // identical on the next read.
      id: trackedTimes.reduce((max, entry) => Math.max(max, entry.id ?? 0), 0) + 1,
      time: body.time ?? mockTrackedTime.time,
      created: body.created ?? new Date().toISOString(),
    };
    trackedTimes = [...trackedTimes, created];
    return json(created);
  }),

  http.delete('https://*/api/v1/repos/:owner/:repo/issues/:index/times', () => {
    // `issueResetTime` deletes every tracked time of the calling user; the mock
    // has a single user, so the whole list goes.
    trackedTimes = [];
    return new HttpResponse(null, { status: 204 });
  }),

  http.delete('https://*/api/v1/repos/:owner/:repo/issues/:index/times/:id', ({ params }) => {
    trackedTimes = trackedTimes.filter((entry) => String(entry.id) !== String(params.id));
    return new HttpResponse(null, { status: 204 });
  }),

  http.get('https://*/api/v1/repos/:owner/:repo/issues/:index/dependencies', () => json(dependencies)),

  http.post('https://*/api/v1/repos/:owner/:repo/issues/:index/dependencies', () => json({})),

  http.delete('https://*/api/v1/repos/:owner/:repo/issues/:index/dependencies/:id', ({ params }) => {
    dependencies = dependencies.filter((entry) => String(entry.id) !== String(params.id));
    return new HttpResponse(null, { status: 204 });
  }),

  http.delete(
    'https://*/api/v1/repos/:owner/:repo/issues/:index/dependencies',
    () => new HttpResponse(null, { status: 204 }),
  ),

  http.get('https://*/api/v1/repos/:owner/:repo/issues/:index/reactions', ({ request }) => {
    const page = Number(new URL(request.url).searchParams.get('page') ?? '1');
    return json(page > 1 ? [] : [mockReaction]);
  }),

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

  // An empty repository. Forgejo's `GetContentsOrList` answers an empty list for
  // *every* contents path once `repo.IsEmpty` is set — for the root, for a
  // directory that does not exist, and for a path that names a file — so the
  // response alone cannot say whether the caller asked for an empty directory or
  // hit a repository with no commits. The handlers below therefore precede the
  // fixture tree's: a specific path must not answer a listing in this repository.
  http.get(`https://*/api/v1/repos/:owner/${MOCK_EMPTY_REPO}/contents`, () => json([])),

  http.get(`https://*/api/v1/repos/:owner/${MOCK_EMPTY_REPO}/contents/*`, () => json([])),

  http.get('https://*/api/v1/repos/:owner/:repo/contents', () => json(mockRootContents)),

  http.get('https://*/api/v1/repos/:owner/:repo/contents/src', () => json(mockSrcContents)),

  http.get('https://*/api/v1/repos/:owner/:repo/contents/docs', () => json(mockDocsContents)),

  http.get('https://*/api/v1/repos/:owner/:repo/contents/README.md', () => json(mockReadmeContent)),

  http.get('https://*/api/v1/repos/:owner/:repo/contents/src/index.ts', () => json(mockIndexTsContent)),

  // Paths that are not regular files. Forgejo fills `content` only for
  // `type: 'file'`: a symlink answers with `target` and a `size` equal to the
  // link target's length, a submodule with `submodule_git_url` and size 0, and a
  // file above the instance's contents payload limit with its real size and no
  // `content`. Each is a different answer, and the MCP `get_file_content` tool
  // must not turn the first two into a withheld-payload notice or an empty
  // string (see mcp/__tests__/tools.test.ts).
  http.get('https://*/api/v1/repos/:owner/:repo/contents/docs/link.md', () =>
    json({
      name: 'link.md',
      path: 'docs/link.md',
      type: 'symlink',
      sha: 'link-sha',
      size: 'README.md'.length,
      target: 'README.md',
    }),
  ),

  http.get('https://*/api/v1/repos/:owner/:repo/contents/vendor/lib', () =>
    json({
      name: 'lib',
      path: 'vendor/lib',
      type: 'submodule',
      sha: 'lib-submodule-sha',
      size: 0,
      submodule_git_url: 'https://forgejo.example.com/demo-user/upstream-lib.git',
    }),
  ),

  http.get('https://*/api/v1/repos/:owner/:repo/contents/huge.bin', () =>
    json({
      name: 'huge.bin',
      path: 'huge.bin',
      type: 'file',
      sha: 'huge-sha',
      // Above the 10 MiB default `[api] DEFAULT_MAX_BLOB_SIZE`: the entry
      // describes the file without carrying its payload.
      size: 12 * 1024 * 1024,
    }),
  ),

  // Every other path in the fixture tree (see data/contents.ts). A directory
  // answers its listing, a file answers its body — a stored payload when the
  // fixture has one, otherwise a generated placeholder that echoes the requested
  // `ref`, so the diff editor's old/new halves stay distinguishable. A path
  // outside the tree is a 404, like the real API: the old catch-all invented a
  // file for *any* path, which hid 404s (and the directory guard, since `src`
  // answered a file instead of its children).
  http.get('https://*/api/v1/repos/:owner/:repo/contents/*', ({ request }) => {
    const url = new URL(request.url);
    const ref = url.searchParams.get('ref');
    const filepath = decodeURIComponent(url.pathname.split('/contents/')[1] ?? '');

    const listing = mockContentListings[filepath];
    if (listing) {
      return json(listing);
    }

    if (!mockContentFilePaths.includes(filepath)) {
      return json({ message: 'not found' }, 404);
    }

    const name = filepath.split('/').pop() ?? filepath;
    const text = mockContentFileTexts[filepath] ?? mockPlaceholderFileText(filepath, ref ?? undefined);
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

  // `structs.BranchProtection` names the branch `branch_name` (there is no
  // `name`, and no `protected` flag on this endpoint); the merge status reads
  // the approval and status-check requirements from here.
  http.get('https://*/api/v1/repos/:owner/:repo/branch_protections/:name', () =>
    json({
      branch_name: 'main',
      required_approvals: 1,
      enable_status_check: true,
      status_check_contexts: ['ci/build'],
      apply_to_admins: true,
    }),
  ),

  // The combined status a merge-blocker check reads: it always names the commit
  // it describes (the client asks for the PR head's sha) and counts the statuses
  // it returns.
  http.get('https://*/api/v1/repos/:owner/:repo/commits/:ref/status', ({ params }) =>
    json({
      sha: params.ref,
      state: 'success',
      total_count: 1,
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

  http.get('https://*/api/v1/repos/:owner/:repo/releases', ({ request }) => json(paginate(request, releases))),

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

  http.delete('https://*/api/v1/repos/:owner/:repo/releases/:id/assets/:attachment_id', ({ params }) => {
    releases = releases.map((release) =>
      String(release.id) === String(params.id)
        ? { ...release, assets: release.assets?.filter((asset) => String(asset.id) !== String(params.attachment_id)) }
        : release,
    );
    return new HttpResponse(null, { status: 204 });
  }),

  http.delete('https://*/api/v1/repos/:owner/:repo/releases/:id', ({ params }) => {
    releases = releases.filter((release) => String(release.id) !== String(params.id));
    return new HttpResponse(null, { status: 204 });
  }),

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

  http.get('https://*/api/v1/repos/:owner/:repo/actions/runs', ({ request }) => {
    // Paginated with an exact total, like the real endpoint: the webview uses
    // `total_count` to decide whether "Load more" is offered and the page's row
    // count to detect the last page.
    const url = new URL(request.url);
    const page = Math.max(1, Number(url.searchParams.get('page')) || 1);
    const limit = Number(url.searchParams.get('limit')) || 30;
    return json({
      total_count: mockActionRuns.length,
      workflow_runs: mockActionRuns.slice((page - 1) * limit, page * limit),
    });
  }),

  // The run the caller asked for, from the runs the fixtures declare (the list
  // plus the run a dispatch mints, which the view opens immediately): answering
  // every id with run 42 made a walkthrough of run #2 show run #1's title and
  // URLs. An id no fixture declares is a 404, like the API's.
  http.get('https://*/api/v1/repos/:owner/:repo/actions/runs/:run_id', ({ params }) => {
    const requestedId = Number(params.run_id);
    const run = [...mockActionRuns, mockDispatchedActionRun].find((candidate) => candidate.id === requestedId);
    return run ? json(run) : json({ message: 'not found' }, 404);
  }),

  // A bare array: `structs.ActionRunJobList` is an array, not an envelope (the
  // generated client only tolerates `{ jobs }` for older servers). The job's
  // `run_id` follows the run that was asked for, so the fixture stays one run.
  http.get('https://*/api/v1/repos/:owner/:repo/actions/runs/:run_id/jobs', ({ params }) =>
    json([{ ...mockActionRunJob, run_id: Number(params.run_id) }]),
  ),

  http.get('https://*/api/v1/repos/:owner/:repo/actions/runs/:run_id/artifacts', ({ request, params }) => {
    const page = Number(new URL(request.url).searchParams.get('page') ?? '1');
    // Also a bare array (`structs.ActionArtifactList`), with `run_id` following
    // the requested run like the jobs above.
    return json(page > 1 ? [] : [{ ...mockActionArtifact, run_id: Number(params.run_id) }]);
  }),

  http.get(
    'https://*/api/v1/repos/:owner/:repo/actions/jobs/:job_id/logs',
    () => new HttpResponse('build log output', { status: 200, headers: { 'Content-Type': 'text/plain' } }),
  ),

  http.post('https://*/api/v1/repos/:owner/:repo/actions/workflows/:workflowfilename/dispatches', () =>
    json(mockDispatchWorkflowRun),
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

  http.delete('https://*/api/v1/repos/:owner/:repo/issues/comments/:id/assets/:attachment_id', ({ params }) => {
    commentAttachments = commentAttachments.filter((entry) => String(entry.id) !== String(params.attachment_id));
    return new HttpResponse(null, { status: 204 });
  }),

  http.post('https://*/api/v1/repos/:owner/:repo/issues/comments/:id/assets', () => json(mockCommentAttachment)),

  http.get('https://*/api/v1/repos/:owner/:repo/issues/comments/:id/assets', () => json(commentAttachments)),
];
