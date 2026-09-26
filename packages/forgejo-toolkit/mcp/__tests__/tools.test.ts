import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import { http, HttpResponse } from 'msw';
import { ForgejoClient, LIST_ITEM_LIMIT, MAX_SEARCH_RESULTS } from '../../src/api/client';
import { ApiError, toApiError } from '../../src/api/errors-core';
import {
  buildToolHandlers,
  CI_TAIL_LINE_COUNT,
  extractCiErrorContext,
  extractCiLogTail,
  isCiErrorLine,
  isFailedActionJob,
  listTruncationNote,
  logWasTruncatedByClient,
  PR_REVIEW_MAX_COMMENT_LENGTH,
  PR_REVIEW_MAX_COMMENTS,
  PR_REVIEW_MAX_DIFF_FILES,
  registerTools,
  repoSearchTruncationNote,
  isSafePathSegment,
  isSafeRepoPath,
  summarizeCiJobLog,
  truncateLargeStrings,
  MAX_TOOL_TEXT_LENGTH,
} from '../tools';
import { startMockServer, stopMockServer, resetMockServer, mockServer } from '../../src/test/mocks/server';
import { MOCK_COMMENT_ONLY_KEYWORD } from '../../src/test/mocks/handlers';
import {
  mockIssues,
  mockIssueDetail,
  mockPullRequests,
  mockPullRequestDetail,
  mockPullRequestCommit,
  mockTimelineComment,
  mockNotifications,
  mockRepository,
  mockUser,
  mockActionRun,
  mockActionRunJob,
  mockActionArtifact,
  mockPullReview,
  mockPullReviewComment,
  mockLabel,
  mockMilestone,
  mockHistoryCommit,
} from '../../src/test/mocks/data';

/**
 * The list cap `get_repo` inherits from `getRepoDetail` (`{ limit: 10 }`).
 * Asserted instead of a hand-written 10 so the fixture and the client cannot
 * drift apart.
 */
const GET_REPO_LIST_CAP = 10;

/** The `get_ci_failure_summary` result shape, for typed assertions in tests. */
interface CiSummaryResult {
  runId: number;
  jobCount: number;
  failedJobCount: number;
  passedJobCount: number;
  failures: {
    id?: number;
    name?: string;
    status?: string;
    extractionNote?: string;
    log?: {
      logCharacters: number;
      truncatedByClient: boolean;
      logLines: number;
      errorContext: string;
      errorMatchCount: number;
      errorContextTruncated: boolean;
      tail: string;
      tailLines: number;
      tailTruncated: boolean;
    };
  }[];
  passedJobs?: { id?: number; name?: string; status?: string }[];
}

/** The `get_pr_review_brief` result shape, for typed assertions in tests. */
interface PrReviewBriefResult {
  pullRequest: {
    number?: number;
    title?: string;
    state?: string;
    draft?: boolean;
    merged?: boolean;
    author?: string;
    baseBranch?: string;
    headBranch?: string;
    mergeable?: boolean;
    mergeBlockers?: { type?: string }[];
    protectionUnknown?: boolean;
  };
  diffStats: {
    fileCount?: number;
    additions?: number;
    deletions?: number;
    files?: { path?: string; status?: string; additions?: number; deletions?: number }[];
    listedFileCount?: number;
    truncated?: boolean;
    truncatedBy?: 'list-cap' | 'row-limit' | 'budget' | 'server-partial';
  };
  reviewStatus: {
    reviewers: { reviewer?: string; state?: string; reviewedAt?: string; reviewId?: number; stale?: boolean }[];
    summary: string;
    approvals: number;
    changesRequested: number;
    awaiting: number;
    truncated: boolean;
  };
  unresolvedComments: {
    total: number;
    returned: number;
    comments: {
      id?: number;
      reviewId?: number;
      path?: string;
      line?: number;
      side?: 'new' | 'old';
      author?: string;
      createdAt?: string;
      body?: string;
      bodyTruncated?: boolean;
    }[];
    truncated: boolean;
    truncatedBy?: 'count' | 'budget';
    unreadableReviewCount: number;
  };
}

describe('MCP tool handlers with MSW', () => {
  beforeAll(() => {
    startMockServer();
  });

  afterAll(() => {
    stopMockServer();
  });

  afterEach(() => {
    resetMockServer();
  });

  function createHandlers() {
    return buildToolHandlers(new ForgejoClient('https://forgejo.example.com', 'mock-token'));
  }

  /**
   * Registers the tools against a stub MCP server and the given client, and
   * hands back a caller for one registered tool. Tests pair this with the stubbed
   * client below (no HTTP) or with a real `ForgejoClient` (driven through the
   * mock HTTP server, as in the `get_file_content` tests).
   */
  function registerWith(client: unknown) {
    const registered = new Map<
      string,
      (args: unknown, extra?: unknown) => Promise<{ isError?: boolean; content: { text: string }[] }>
    >();
    const server = {
      registerTool: (name: string, _config: unknown, handler: never) => {
        registered.set(name, handler);
      },
    } as never;
    registerTools(server, client as never);

    const call = (name: string, args: unknown) => registered.get(name)?.(args);
    return { call };
  }

  /**
   * Registers the tools against a stub MCP server and a fully stubbed client, so
   * a test can drive the tool layer (notes, error rendering) without HTTP.
   *
   * The MCP SDK's presence in this file changes how MSW applies handlers
   * registered with `use()` after the server started listening, so the tool
   * layer is exercised over stubs here and the real request paths are covered by
   * the client and error suites.
   */
  function registerWithStubClient(methods: Record<string, (...args: never[]) => Promise<unknown>>) {
    const calls: { name: string; args: unknown[] }[] = [];
    const client = new Proxy(methods, {
      get: (target, property: string) => {
        if (property in target) {
          return (...args: unknown[]) => {
            calls.push({ name: property, args });
            return (target[property] as (...args: unknown[]) => Promise<unknown>)(...args);
          };
        }
        if (property === 'withSignal') {
          return () => client;
        }
        throw new Error(`stub client has no method ${property}`);
      },
    });
    const { call } = registerWith(client);
    return { call, calls };
  }

  /** The `get_pr_review_brief` result as the registered tool returns it. */
  function parseBrief(result: { isError?: boolean; content: { text: string }[] } | undefined): PrReviewBriefResult {
    return JSON.parse(result?.content[0].text ?? 'null') as PrReviewBriefResult;
  }

  it('list_issues lists repository issues when owner and repo are given', async () => {
    const handlers = createHandlers();
    const issues = (await handlers.list_issues({ owner: 'demo-user', repo: 'demo-repo' })) as typeof mockIssues;
    expect(issues).toHaveLength(mockIssues.length);
    expect(issues[0].title).toBe(mockIssues[0].title);
  });

  it('list_issues falls back to the user issue list without owner/repo', async () => {
    const handlers = createHandlers();
    const issues = (await handlers.list_issues({})) as typeof mockIssues;
    expect(issues).toHaveLength(mockIssues.length);
    expect(issues[0].title).toBe(mockIssues[0].title);
  });

  it('list_issues passes the keyword filter through for repository listings', async () => {
    const handlers = createHandlers();
    const matches = (await handlers.list_issues({
      owner: 'demo-user',
      repo: 'demo-repo',
      query: 'login',
    })) as typeof mockIssues;
    expect(matches).toHaveLength(1);
    const misses = (await handlers.list_issues({
      owner: 'demo-user',
      repo: 'demo-repo',
      query: 'no-such-keyword',
    })) as typeof mockIssues;
    expect(misses).toHaveLength(0);
  });

  it('list_issues keeps a match the server found only in a comment', async () => {
    // Forgejo's indexer matches the issue title, body and comments (see the
    // bleve mapping in modules/indexer/issues). The handler used to re-filter
    // the rows the server returned against the title, body and author only, so
    // an issue whose match lived in a comment was dropped — and the only note
    // about a cut answer fires at the LIST_ITEM_LIMIT cap, so nothing said a
    // match had gone missing.
    const handlers = createHandlers();
    const keyword = MOCK_COMMENT_ONLY_KEYWORD;
    // The fixture is only a comment-only match if the keyword is nowhere else.
    expect(`${mockIssues[0].title} ${mockIssues[0].body}`.toLowerCase()).not.toContain(keyword);

    const matches = (await handlers.list_issues({
      owner: 'demo-user',
      repo: 'demo-repo',
      query: keyword,
    })) as typeof mockIssues;

    expect(matches.map((issue) => issue.number)).toContain(mockIssues[0].number);
  });

  it('list_pull_requests keeps a comment-only match on the instance-wide listing', async () => {
    // The instance-wide branch has no client-side filter left either: the
    // keyword goes to the server, so the same comment match survives there.
    const handlers = createHandlers();
    const keyword = MOCK_COMMENT_ONLY_KEYWORD;
    expect(`${mockPullRequests[0].title} ${mockPullRequests[0].body}`.toLowerCase()).not.toContain(keyword);

    const matches = (await handlers.list_pull_requests({ query: keyword })) as typeof mockPullRequests;

    expect(matches.map((pull) => pull.number)).toContain(mockPullRequests[0].number);
  });

  it('get_issue returns the issue detail with its comments', async () => {
    const handlers = createHandlers();
    const result = (await handlers.get_issue({ owner: 'demo-user', repo: 'demo-repo', index: 1 })) as {
      issue: typeof mockIssueDetail;
      comments: unknown[];
    };
    expect(result.issue.number).toBe(mockIssueDetail.number);
    expect(result.issue.title).toBe(mockIssueDetail.title);
    expect(result.comments).toHaveLength(1);
  });

  it('list_pull_requests lists repository pull requests', async () => {
    const handlers = createHandlers();
    const pulls = (await handlers.list_pull_requests({
      owner: 'demo-user',
      repo: 'demo-repo',
    })) as typeof mockPullRequests;
    expect(pulls).toHaveLength(mockPullRequests.length);
    expect(pulls[0].title).toBe(mockPullRequests[0].title);
  });

  it('list_pull_requests falls back to the user pull request list without owner/repo', async () => {
    const handlers = createHandlers();
    const pulls = (await handlers.list_pull_requests({})) as typeof mockPullRequests;
    expect(pulls).toHaveLength(mockPullRequests.length);
    expect(pulls[0].title).toBe(mockPullRequests[0].title);
  });

  it('list_issues applies the keyword filter to the instance-wide listing too', async () => {
    // Without owner/repo the handler answers the user-wide listing, and a
    // caller that passes `query` is asking for a filtered answer: dropping the
    // argument returned every issue as if the filter had been applied.
    const handlers = createHandlers();
    const matches = (await handlers.list_issues({ query: 'login' })) as typeof mockIssues;
    expect(matches).toHaveLength(1);
    expect(matches[0].title).toBe(mockIssues[0].title);

    const misses = (await handlers.list_issues({ query: 'no-such-keyword' })) as typeof mockIssues;
    expect(misses).toHaveLength(0);
  });

  it('list_pull_requests applies the keyword filter to the instance-wide listing too', async () => {
    const handlers = createHandlers();
    const matches = (await handlers.list_pull_requests({ query: 'dark' })) as typeof mockPullRequests;
    expect(matches).toHaveLength(1);
    expect(matches[0].title).toBe(mockPullRequests[0].title);

    const misses = (await handlers.list_pull_requests({ query: 'no-such-keyword' })) as typeof mockPullRequests;
    expect(misses).toHaveLength(0);
  });

  it('get_pull_request returns the detail with files and commits', async () => {
    const handlers = createHandlers();
    const result = (await handlers.get_pull_request({ owner: 'demo-user', repo: 'demo-repo', index: 2 })) as {
      pullRequest: typeof mockPullRequestDetail;
      files: { filename?: string }[];
      commits: { sha?: string }[];
    };
    expect(result.pullRequest.number).toBe(mockPullRequestDetail.number);
    expect(result.pullRequest.title).toBe(mockPullRequestDetail.title);
    expect(result.files).toHaveLength(1);
    expect(result.files[0].filename).toBe('src/index.ts');
    expect(result.commits[0].sha).toBe(mockPullRequestCommit.sha);
  });

  it('get_pr_timeline returns the comment timeline', async () => {
    const handlers = createHandlers();
    const timeline = (await handlers.get_pr_timeline({ owner: 'demo-user', repo: 'demo-repo', index: 2 })) as {
      body?: string;
    }[];
    expect(timeline).toHaveLength(1);
    expect(timeline[0].body).toBe(mockTimelineComment.body);
  });

  it('get_pr_review_brief packs the pull request, its diff stats, reviews and unresolved comments', async () => {
    // The whole point of the tool: the four reads a review used to make by hand
    // come back as one pre-sized payload. The mock server answers each with the
    // shared fixtures, so every section can be checked against them.
    const handlers = createHandlers();
    const brief = (await handlers.get_pr_review_brief({
      owner: 'demo-user',
      repo: 'demo-repo',
      index: 2,
    })) as PrReviewBriefResult;

    expect(brief.pullRequest.title).toBe(mockPullRequestDetail.title);
    expect(brief.pullRequest.state).toBe('open');
    expect(brief.pullRequest.author).toBe(mockUser.login);
    expect(brief.pullRequest.baseBranch).toBe(mockPullRequestDetail.base?.ref);
    expect(brief.pullRequest.headBranch).toBe(mockPullRequestDetail.head?.ref);
    // The mocked base branch requires one approval and the only review is a
    // COMMENT, so the missing approval is the blocker the brief must carry.
    expect(brief.pullRequest.mergeBlockers?.map((blocker) => blocker.type)).toContain('required_approvals');

    expect(brief.diffStats).toMatchObject({
      fileCount: mockPullRequestDetail.changed_files,
      additions: mockPullRequestDetail.additions,
      deletions: mockPullRequestDetail.deletions,
      listedFileCount: 1,
      truncated: false,
    });
    expect(brief.diffStats.files?.[0]).toMatchObject({ path: 'src/index.ts', additions: 10, deletions: 2 });

    expect(brief.reviewStatus.summary).toBe('awaiting_review');
    expect(brief.reviewStatus.reviewers).toEqual([
      {
        reviewer: mockUser.login,
        state: mockPullReview.state,
        reviewedAt: mockPullReview.submitted_at,
        reviewId: mockPullReview.id,
      },
    ]);

    expect(brief.unresolvedComments.total).toBe(1);
    expect(brief.unresolvedComments.returned).toBe(1);
    expect(brief.unresolvedComments.unreadableReviewCount).toBe(0);
    expect(brief.unresolvedComments.comments[0]).toMatchObject({
      id: mockPullReviewComment.id,
      reviewId: mockPullReviewComment.pull_request_review_id,
      path: mockPullReviewComment.path,
      line: mockPullReviewComment.position,
      side: 'new',
      author: mockUser.login,
      body: mockPullReviewComment.body,
    });
  });

  it('get_pr_review_brief skips the changed-files request when includeDiffStats is false', async () => {
    const { call, calls } = registerWithStubClient({
      getPullRequestDetail: async () => ({
        number: 2,
        changed_files: 3,
        additions: 30,
        deletions: 4,
        user: { login: 'alice' },
      }),
      getPullRequestFiles: async () => [{ filename: 'src/index.ts', additions: 30, deletions: 4 }],
      listPullReviews: async () => [],
      getPullReviewComments: async () => [],
    });

    const brief = parseBrief(
      await call('get_pr_review_brief', { owner: 'demo-user', repo: 'demo-repo', index: 2, includeDiffStats: false }),
    );

    expect(calls.map((entry) => entry.name)).not.toContain('getPullRequestFiles');
    // The totals come from the pull request record, so they survive the skipped
    // request; only the per-file table is absent.
    expect(brief.diffStats).toEqual({ fileCount: 3, additions: 30, deletions: 4 });
    expect(brief.diffStats.files).toBeUndefined();
  });

  it("get_pr_review_brief keeps only each reviewer's latest conclusion", async () => {
    const { call } = registerWithStubClient({
      getPullRequestDetail: async () => ({ number: 2, title: 'Add dark mode', state: 'open' }),
      getPullRequestFiles: async () => [],
      listPullReviews: async () => [
        { id: 1, user: { login: 'alice' }, state: 'REQUEST_CHANGES', submitted_at: '2026-08-01T09:00:00Z' },
        { id: 2, user: { login: 'bob' }, state: 'COMMENT', submitted_at: '2026-08-02T09:00:00Z' },
        { id: 3, user: { login: 'alice' }, state: 'APPROVED', submitted_at: '2026-08-03T09:00:00Z' },
        {
          id: 4,
          user: { login: 'carol' },
          state: 'CHANGES_REQUESTED',
          submitted_at: '2026-08-04T09:00:00Z',
          stale: true,
        },
      ],
      getPullReviewComments: async () => [],
    });

    const brief = parseBrief(await call('get_pr_review_brief', { owner: 'demo-user', repo: 'demo-repo', index: 2 }));

    // Alice appears once, with the approval that came after her change request,
    // and the entries follow the order of their latest review.
    expect(
      brief.reviewStatus.reviewers.map((reviewer) => [reviewer.reviewer, reviewer.state, reviewer.reviewId]),
    ).toEqual([
      ['bob', 'COMMENT', 2],
      ['alice', 'APPROVED', 3],
      ['carol', 'CHANGES_REQUESTED', 4],
    ]);
    // Carol's review is stale, so it does not decide the summary: with no current
    // change request and one approval, the aggregate says approved — and her
    // stale flag stays on her entry so the reader can see why.
    expect(brief.reviewStatus.summary).toBe('approved');
    expect(brief.reviewStatus.approvals).toBe(1);
    expect(brief.reviewStatus.changesRequested).toBe(0);
    expect(brief.reviewStatus.awaiting).toBe(1);
    expect(brief.reviewStatus.reviewers[2].stale).toBe(true);
  });

  it('get_pr_review_brief reports a change request that still stands', async () => {
    const { call } = registerWithStubClient({
      getPullRequestDetail: async () => ({ number: 2 }),
      getPullRequestFiles: async () => [],
      listPullReviews: async () => [
        { id: 1, user: { login: 'alice' }, state: 'APPROVED' },
        // Forgejo's own spelling; `CHANGES_REQUESTED` (GitHub's) is recognised too.
        { id: 2, user: { login: 'bob' }, state: 'REQUEST_CHANGES' },
      ],
      getPullReviewComments: async () => [],
    });

    const brief = parseBrief(await call('get_pr_review_brief', { owner: 'demo-user', repo: 'demo-repo', index: 2 }));

    expect(brief.reviewStatus.summary).toBe('changes_requested');
    expect(brief.reviewStatus.changesRequested).toBe(1);
  });

  it('get_pr_review_brief marks a diff table it had to cut', async () => {
    const files = Array.from({ length: PR_REVIEW_MAX_DIFF_FILES + 3 }, (_, index) => ({
      filename: `src/file-${index}.ts`,
      status: 'modified',
      additions: 1,
      deletions: 1,
    }));
    const { call } = registerWithStubClient({
      getPullRequestDetail: async () => ({
        number: 2,
        changed_files: files.length,
        additions: files.length,
        deletions: files.length,
      }),
      getPullRequestFiles: async () => files,
      listPullReviews: async () => [],
      getPullReviewComments: async () => [],
    });

    const brief = parseBrief(await call('get_pr_review_brief', { owner: 'demo-user', repo: 'demo-repo', index: 2 }));

    expect(brief.diffStats.files).toHaveLength(PR_REVIEW_MAX_DIFF_FILES);
    expect(brief.diffStats.listedFileCount).toBe(PR_REVIEW_MAX_DIFF_FILES);
    expect(brief.diffStats.truncated).toBe(true);
    expect(brief.diffStats.truncatedBy).toBe('row-limit');
    // The totals come from the pull request record, so the cut table still
    // reports the real size of the change.
    expect(brief.diffStats.fileCount).toBe(files.length);
    expect(brief.diffStats.additions).toBe(files.length);
  });

  it('get_pr_review_brief reports the client list cap on the changed-file list', async () => {
    // The client pages changed files up to the shared cap, so a list that reaches
    // it may be missing files the tool never saw: that cut has to outrank the
    // tool's own row budget.
    const files = Array.from({ length: LIST_ITEM_LIMIT }, (_, index) => ({
      filename: `f${index}.ts`,
      status: 'modified',
      additions: 1,
      deletions: 0,
    }));
    const { call } = registerWithStubClient({
      getPullRequestDetail: async () => ({ number: 2, changed_files: files.length }),
      getPullRequestFiles: async () => files,
      listPullReviews: async () => [],
      getPullReviewComments: async () => [],
    });

    const brief = parseBrief(await call('get_pr_review_brief', { owner: 'demo-user', repo: 'demo-repo', index: 2 }));

    expect(brief.diffStats.truncated).toBe(true);
    expect(brief.diffStats.truncatedBy).toBe('list-cap');
  });

  it('get_pr_review_brief flags it when the server returns fewer files than the pull request record claims', async () => {
    // Forgejo 16 answers the files endpoint of a merged pull request whose
    // head branch is gone with a partial diff and no indication: 1 row where
    // changed_files says 16. No cap on this side fired, so without the flag
    // the table would read as the whole change.
    const { call } = registerWithStubClient({
      getPullRequestDetail: async () => ({ number: 2, changed_files: 16, additions: 183, deletions: 456 }),
      getPullRequestFiles: async () => [{ filename: 'README.md', additions: 142, deletions: 16 }],
      listPullReviews: async () => [],
      getPullReviewComments: async () => [],
    });

    const brief = parseBrief(await call('get_pr_review_brief', { owner: 'demo-user', repo: 'demo-repo', index: 2 }));

    expect(brief.diffStats.truncated).toBe(true);
    expect(brief.diffStats.truncatedBy).toBe('server-partial');
    expect(brief.diffStats.listedFileCount).toBe(1);
    expect(brief.diffStats.fileCount).toBe(16);
  });

  it('get_pr_review_brief caps the unresolved comment list by count and keeps the newest', async () => {
    const comments = Array.from({ length: PR_REVIEW_MAX_COMMENTS + 2 }, (_, index) => ({
      id: index + 1,
      path: 'src/index.ts',
      position: 2,
      body: `remark ${index + 1}`,
      user: { login: 'alice' },
    }));
    const { call } = registerWithStubClient({
      getPullRequestDetail: async () => ({ number: 2 }),
      getPullRequestFiles: async () => [],
      listPullReviews: async () => [{ id: 1, user: { login: 'alice' }, state: 'COMMENT' }],
      getPullReviewComments: async () => comments,
    });

    const brief = parseBrief(await call('get_pr_review_brief', { owner: 'demo-user', repo: 'demo-repo', index: 2 }));

    expect(brief.unresolvedComments.total).toBe(PR_REVIEW_MAX_COMMENTS + 2);
    expect(brief.unresolvedComments.returned).toBe(PR_REVIEW_MAX_COMMENTS);
    expect(brief.unresolvedComments.truncated).toBe(true);
    expect(brief.unresolvedComments.truncatedBy).toBe('count');
    // The oldest remarks are the ones most likely to have been answered already.
    expect(brief.unresolvedComments.comments.map((comment) => comment.body)).not.toContain('remark 1');
    expect(brief.unresolvedComments.comments.at(-1)?.body).toBe(`remark ${PR_REVIEW_MAX_COMMENTS + 2}`);
  });

  it('get_pr_review_brief cuts the unresolved comments to the shared character budget', async () => {
    const comments = Array.from({ length: 40 }, (_, index) => ({
      id: index + 1,
      path: 'src/index.ts',
      position: 2,
      body: 'x'.repeat(PR_REVIEW_MAX_COMMENT_LENGTH + 100),
      user: { login: 'alice' },
    }));
    const { call } = registerWithStubClient({
      getPullRequestDetail: async () => ({ number: 2 }),
      getPullRequestFiles: async () => [],
      listPullReviews: async () => [{ id: 1, user: { login: 'alice' }, state: 'COMMENT' }],
      getPullReviewComments: async () => comments,
    });

    const brief = parseBrief(await call('get_pr_review_brief', { owner: 'demo-user', repo: 'demo-repo', index: 2 }));

    expect(brief.unresolvedComments.total).toBe(40);
    expect(brief.unresolvedComments.truncated).toBe(true);
    expect(brief.unresolvedComments.truncatedBy).toBe('budget');
    // The count cap was not the binding one, and each kept body is itself cut to
    // the per-comment cap with the cut announced in the body.
    expect(brief.unresolvedComments.returned).toBeLessThan(PR_REVIEW_MAX_COMMENTS);
    expect(brief.unresolvedComments.comments[0].bodyTruncated).toBe(true);
    expect(brief.unresolvedComments.comments[0].body).toContain('(truncated: 100 more characters)');
  });

  it('leaves a resolved conversation out, replies included, and bodyless anchors too', async () => {
    // Forgejo sets `resolver` only on the first comment of a conversation, so a
    // reply inside a resolved thread carries none: filtering per comment would
    // report it as unresolved.
    const { call } = registerWithStubClient({
      getPullRequestDetail: async () => ({ number: 2 }),
      getPullRequestFiles: async () => [],
      listPullReviews: async () => [{ id: 1, user: { login: 'alice' }, state: 'COMMENT' }],
      getPullReviewComments: async () => [
        {
          id: 1,
          path: 'src/a.ts',
          position: 3,
          body: 'please rename this',
          user: { login: 'alice' },
          resolver: { login: 'bob' },
        },
        { id: 2, path: 'src/a.ts', position: 3, body: 'done in the next push', user: { login: 'alice' } },
        { id: 3, path: 'src/b.ts', position: 4, body: 'still open', user: { login: 'alice' } },
        { id: 4, path: 'src/b.ts', position: 5, body: '', user: { login: 'alice' } },
      ],
    });

    const brief = parseBrief(await call('get_pr_review_brief', { owner: 'demo-user', repo: 'demo-repo', index: 2 }));

    expect(brief.unresolvedComments.total).toBe(1);
    expect(brief.unresolvedComments.comments.map((comment) => comment.body)).toEqual(['still open']);
  });

  it('get_pr_review_brief fails when the pull request number does not exist', async () => {
    // A wrong index is a 404 from the pulls endpoint, not an empty brief: the
    // tool result has to be an error, with the client's own not-found sentence.
    mockServer.use(
      http.get('https://*/api/v1/repos/:owner/:repo/pulls/:index', () =>
        HttpResponse.json({ message: 'not found' }, { status: 404 }),
      ),
    );
    const { call } = registerWith(new ForgejoClient('https://forgejo.example.com', 'mock-token'));
    const result = await call('get_pr_review_brief', { owner: 'demo-user', repo: 'demo-repo', index: 999 });

    expect(result?.isError).toBe(true);
    expect(result?.content[0].text ?? '').toContain('Not found');
    expect(result?.content[0].text ?? '').toContain('demo-user/demo-repo');
  });

  it('list_notifications defaults to unread and pinned notifications', async () => {
    const handlers = createHandlers();
    const notifications = (await handlers.list_notifications({})) as typeof mockNotifications;
    const expected = mockNotifications.filter((n) => n.unread || n.pinned);
    expect(notifications).toHaveLength(expected.length);
    expect(notifications.map((n) => n.id)).toEqual(expected.map((n) => n.id));
  });

  it('list_notifications honors the status filter', async () => {
    const handlers = createHandlers();
    const notifications = (await handlers.list_notifications({ statusTypes: ['read'] })) as typeof mockNotifications;
    expect(notifications).toHaveLength(1);
    expect(notifications[0].unread).toBe(false);
  });

  it('list_notifications pages with the before cursor, as the webview does', async () => {
    // The client passes `before` through as the API's page cursor (only threads
    // updated before that instant), and the cursor a caller has to send is the
    // `updated_at` of the oldest row of the previous page — the same value the
    // webview pages with.
    const handlers = createHandlers();
    const firstPage = (await handlers.list_notifications({
      statusTypes: ['unread', 'pinned', 'read'],
      limit: 1,
    })) as typeof mockNotifications;
    expect(firstPage.map((notification) => notification.id)).toEqual([101]);

    const secondPage = (await handlers.list_notifications({
      statusTypes: ['unread', 'pinned', 'read'],
      limit: 10,
      before: firstPage[0].updated_at,
    })) as typeof mockNotifications;

    // 101 is outside the cursor's window now: the page after it holds 102 and 103.
    expect(secondPage.map((notification) => notification.id)).toEqual([102, 103]);
  });

  it('forwards the notification cursor to the client instead of dropping it', async () => {
    // The schema now carries the cursor; the handler must hand it to
    // `getNotifications`, whose fourth parameter is `before`.
    const { call, calls } = registerWithStubClient({ getNotifications: async () => ({ items: [] }) });
    await call('list_notifications', { limit: 5, before: '2026-08-17T10:00:00Z' });

    expect(calls).toEqual([
      { name: 'getNotifications', args: [['unread', 'pinned'], undefined, 5, '2026-08-17T10:00:00Z'] },
    ]);
  });

  it('get_repo returns the repository detail', async () => {
    const handlers = createHandlers();
    const detail = (await handlers.get_repo({ owner: 'demo-user', repo: 'demo-repo' })) as {
      repository: typeof mockRepository;
      empty: boolean;
    };
    expect(detail.repository.full_name).toBe(mockRepository.full_name);
    expect(detail.empty).toBe(false);
  });

  it('search finds issues, pull requests, and repositories', async () => {
    const handlers = createHandlers();
    const issues = (await handlers.search({ query: 'login', type: 'issues' })) as typeof mockIssues;
    expect(issues[0].title).toBe(mockIssues[0].title);
    const pulls = (await handlers.search({ query: 'dark', type: 'pull_requests' })) as typeof mockPullRequests;
    expect(pulls[0].title).toBe(mockPullRequests[0].title);
    const repos = (await handlers.search({ query: 'another', type: 'repositories' })) as (typeof mockRepository)[];
    expect(repos).toHaveLength(1);
    expect(repos[0].full_name).toBe('demo-user/another-repo');
  });

  it('propagates API failures as ApiError', async () => {
    mockServer.use(
      http.get('https://*/api/v1/repos/:owner/:repo/issues', () =>
        HttpResponse.json({ message: 'boom' }, { status: 500 }),
      ),
    );
    const handlers = createHandlers();
    const rejection = await handlers
      .list_issues({ owner: 'demo-user', repo: 'demo-repo' })
      .catch((error: unknown) => error);
    expect(rejection).toBeInstanceOf(ApiError);
    expect((rejection as ApiError).status).toBe(500);
  });

  it('list_action_runs returns the workflow run list', async () => {
    const handlers = createHandlers();
    const runs = (await handlers.list_action_runs({ owner: 'demo-user', repo: 'demo-repo' })) as {
      total_count?: number;
      workflow_runs: { id?: number }[];
    };
    expect(runs.total_count).toBe(35);
    expect(runs.workflow_runs[0].id).toBe(mockActionRun.id);
  });

  it('get_action_run_jobs returns the jobs of a run', async () => {
    const handlers = createHandlers();
    const jobs = (await handlers.get_action_run_jobs({
      owner: 'demo-user',
      repo: 'demo-repo',
      runId: 42,
    })) as (typeof mockActionRunJob)[];
    expect(jobs).toHaveLength(1);
    expect(jobs[0].name).toBe(mockActionRunJob.name);
  });

  it('get_action_job_log returns the raw log text', async () => {
    const handlers = createHandlers();
    const log = await handlers.get_action_job_log({ owner: 'demo-user', repo: 'demo-repo', jobId: 101 });
    expect(log).toBe('build log output');
  });

  /**
   * The summary result as `get_ci_failure_summary` returns it, so the assertions
   * below can read the fields without re-declaring the shape at every call.
   */
  function parseCiSummary(result: { content: { text: string }[] } | undefined): CiSummaryResult {
    return JSON.parse(result?.content[0].text ?? 'null') as CiSummaryResult;
  }

  /** A failed build log whose error sits near the end, where a failing step prints. */
  function failedBuildLog(): string {
    const progress = Array.from({ length: 120 }, (_, i) => `step ${i + 1}: compiling module ${i + 1}`);
    return [
      ...progress,
      'make: *** [Makefile:12: all] Error 2',
      'error: build failed with exit code 1',
      'runner: job finished',
    ].join('\n');
  }

  it('get_ci_failure_summary extracts the error lines and the log tail of a failed job', async () => {
    const log = failedBuildLog();
    const { call, calls } = registerWithStubClient({
      getActionRunJobs: async () => [{ id: 7, name: 'build', status: 'failure' }],
      getActionJobLog: async () => log,
    });

    const summary = parseCiSummary(
      await call('get_ci_failure_summary', { owner: 'demo-user', repo: 'demo-repo', runId: 42 }),
    );

    expect(calls.map((entry) => entry.name)).toEqual(['getActionRunJobs', 'getActionJobLog']);
    expect(calls[1].args).toEqual(['demo-user', 'demo-repo', 7]);
    expect(summary.failedJobCount).toBe(1);
    expect(summary.failures[0].log?.errorContext).toContain('error: build failed with exit code 1');
    // The tail keeps the end of the log — exactly the part the raw log tool's
    // head-keeping ~10 KB budget loses.
    expect(summary.failures[0].log?.tail).toContain('runner: job finished');
    expect(summary.failures[0].log?.tail).not.toContain('step 1: compiling');
    expect(summary.failures[0].log?.tailTruncated).toBe(true);
    expect(summary.failures[0].log?.truncatedByClient).toBe(false);
    expect(summary.failures[0].log?.logCharacters).toBe(log.length);
  });

  it('get_ci_failure_summary reports no failures when every job passed', async () => {
    // The shared fixture's single job is a success, so the real client reaches
    // the handler through MSW and the tool must answer "nothing failed" without
    // reading any log.
    const handlers = createHandlers();
    const summary = (await handlers.get_ci_failure_summary({
      owner: 'demo-user',
      repo: 'demo-repo',
      runId: 42,
    })) as CiSummaryResult;

    expect(summary.failedJobCount).toBe(0);
    expect(summary.failures).toEqual([]);
    expect(summary.passedJobCount).toBe(1);
    expect(summary.passedJobs).toBeUndefined();
  });

  it('get_ci_failure_summary lists passed jobs only when asked, and never reads their logs', async () => {
    const { call, calls } = registerWithStubClient({
      getActionRunJobs: async () => [
        { id: 7, name: 'build', status: 'failure' },
        { id: 8, name: 'lint', status: 'success' },
      ],
      getActionJobLog: async () => 'error: failed with exit code 1',
    });

    const withoutPassed = parseCiSummary(
      await call('get_ci_failure_summary', { owner: 'demo-user', repo: 'demo-repo', runId: 42 }),
    );
    expect(withoutPassed.passedJobCount).toBe(1);
    expect(withoutPassed.passedJobs).toBeUndefined();

    const withPassed = parseCiSummary(
      await call('get_ci_failure_summary', {
        owner: 'demo-user',
        repo: 'demo-repo',
        runId: 42,
        includePassedJobs: true,
      }),
    );
    // Name and status only: no log is extracted for a job that passed.
    expect(withPassed.passedJobs).toEqual([{ id: 8, name: 'lint', status: 'success' }]);
    expect(withPassed.passedJobs?.[0]).not.toHaveProperty('log');
    expect(calls.filter((entry) => entry.name === 'getActionJobLog').map((entry) => entry.args[2])).toEqual([7, 7]);
  });

  it('get_ci_failure_summary keeps one unreadable log from discarding the others', async () => {
    const { call } = registerWithStubClient({
      getActionRunJobs: async () => [
        { id: 7, name: 'build', status: 'failure' },
        { id: 8, name: 'test', status: 'error' },
      ],
      getActionJobLog: async (...args: unknown[]) => {
        if (args[2] === 7) {
          throw new Error('Forgejo API error 404: Not Found');
        }
        return 'error: tests failed with exit code 1';
      },
    });

    const summary = parseCiSummary(
      await call('get_ci_failure_summary', { owner: 'demo-user', repo: 'demo-repo', runId: 42 }),
    );

    expect(summary.failedJobCount).toBe(2);
    expect(summary.failures[0].log).toBeUndefined();
    expect(summary.failures[0].extractionNote).toContain('log unavailable');
    expect(summary.failures[1].log?.errorContext).toContain('tests failed');
  });

  it('does not report a cancelled log read as an unreadable log', async () => {
    // A cancellation is not a per-job failure: absorbing it would let a
    // cancelled tool call come back as a successful partial summary.
    const abortError = new Error('This operation was aborted');
    abortError.name = 'AbortError';
    const { call } = registerWithStubClient({
      getActionRunJobs: async () => [{ id: 7, name: 'build', status: 'failure' }],
      getActionJobLog: async () => {
        throw abortError;
      },
    });

    const result = await call('get_ci_failure_summary', { owner: 'demo-user', repo: 'demo-repo', runId: 42 });

    expect(result?.isError).toBe(true);
    expect(result?.content[0].text ?? '').not.toContain('log unavailable');
  });

  it('get_action_run_artifacts returns the artifacts of a run', async () => {
    const handlers = createHandlers();
    const artifacts = (await handlers.get_action_run_artifacts({
      owner: 'demo-user',
      repo: 'demo-repo',
      runId: 42,
    })) as (typeof mockActionArtifact)[];
    expect(artifacts).toHaveLength(1);
    expect(artifacts[0].name).toBe(mockActionArtifact.name);
  });

  it('get_file_content decodes the file content', async () => {
    const handlers = createHandlers();
    const content = await handlers.get_file_content({
      owner: 'demo-user',
      repo: 'demo-repo',
      path: 'src/index.ts',
      ref: 'main',
    });
    expect(content).toContain('export function greet');
  });

  it('get_file_content without a ref reads the default branch', async () => {
    const handlers = createHandlers();
    const content = await handlers.get_file_content({ owner: 'demo-user', repo: 'demo-repo', path: 'docs/any.md' });
    // The catch-all mock echoes the requested ref; no ref means default branch.
    expect(content).toContain('ref: default branch');
  });

  it('list_repo_contents lists the root and a subdirectory', async () => {
    const handlers = createHandlers();
    const root = (await handlers.list_repo_contents({ owner: 'demo-user', repo: 'demo-repo' })) as {
      name?: string;
    }[];
    expect(root.map((entry) => entry.name)).toEqual(['README.md', 'src', 'package.json']);
    const src = (await handlers.list_repo_contents({ owner: 'demo-user', repo: 'demo-repo', path: 'src' })) as {
      path?: string;
    }[];
    expect(src.map((entry) => entry.path)).toEqual(['src/index.ts', 'src/utils']);
  });

  it('list_branches returns the repository branches', async () => {
    const handlers = createHandlers();
    const branches = (await handlers.list_branches({ owner: 'demo-user', repo: 'demo-repo' })) as {
      name?: string;
    }[];
    expect(branches.map((branch) => branch.name)).toEqual(['main', 'dev']);
  });

  it('list_tags returns the repository tags', async () => {
    const handlers = createHandlers();
    const tags = (await handlers.list_tags({ owner: 'demo-user', repo: 'demo-repo' })) as { name?: string }[];
    expect(tags.map((tag) => tag.name)).toEqual(['v1.0.0']);
  });

  it('list_commits returns the latest branch commits', async () => {
    const handlers = createHandlers();
    const commits = (await handlers.list_commits({ owner: 'demo-user', repo: 'demo-repo', branch: 'main' })) as {
      sha?: string;
    }[];
    expect(commits).toHaveLength(1);
    expect(commits[0].sha).toBe('abc123');
  });

  it('get_file_history returns the commits that touched a file', async () => {
    const handlers = createHandlers();
    const commits = (await handlers.get_file_history({
      owner: 'demo-user',
      repo: 'demo-repo',
      path: 'README.md',
      ref: 'main',
    })) as { sha?: string }[];
    expect(commits).toHaveLength(1);
    expect(commits[0].sha).toBe(mockHistoryCommit.sha);
  });

  it('search_repo_files matches paths by keyword', async () => {
    const handlers = createHandlers();
    const result = (await handlers.search_repo_files({
      owner: 'demo-user',
      repo: 'demo-repo',
      query: 'index',
      ref: 'main',
    })) as { files: { path?: string }[]; truncated: boolean };
    expect(result.files.map((file) => file.path)).toEqual(['src/index.ts']);
    expect(result.truncated).toBe(false);
  });

  it('search_repo_files without a ref resolves the default branch', async () => {
    const handlers = createHandlers();
    const result = (await handlers.search_repo_files({
      owner: 'demo-user',
      repo: 'demo-repo',
      query: 'utils',
    })) as { files: { path?: string }[] };
    expect(result.files.map((file) => file.path)).toEqual(['src/utils.ts']);
  });

  it('list_repo_contents lists a directory without claiming the payloads are withheld', async () => {
    // The list endpoint never sends `content` for any entry (upstream calls
    // GetContents with forList=true), so a listing must not be annotated as if
    // every file's payload had been withheld.
    const handlers = createHandlers();

    const entries = (await handlers.list_repo_contents({ owner: 'demo-user', repo: 'demo-repo' })) as {
      name?: string;
      contentNotice?: string;
    }[];

    expect(entries.length).toBeGreaterThan(0);
    expect(entries.every((entry) => entry.contentNotice === undefined)).toBe(true);
  });

  it('refuses a half-specified repository scope instead of answering a wider question', async () => {
    const handlers = createHandlers();

    // The handler throws before returning a promise; the tool layer's try/catch
    // turns that into an error result, so it must not reach the client at all.
    expect(() => handlers.list_issues({ owner: 'demo-user' })).toThrow(/provided together/);
    expect(() => handlers.list_pull_requests({ repo: 'demo-repo' })).toThrow(/provided together/);
  });

  it('get_pr_diff returns the unified diff text', async () => {
    const handlers = createHandlers();
    const diff = await handlers.get_pr_diff({ owner: 'demo-user', repo: 'demo-repo', index: 2 });
    expect(diff).toContain('diff --git a/src/index.ts');
  });

  it('get_file_content reports a directory path as an error, not as file content', async () => {
    // The client reports which kind of entry it found; the tool layer throws for
    // every kind that is not file content, and callTool sets isError only for a
    // throw.
    const handlers = createHandlers();
    await expect(handlers.get_file_content({ owner: 'demo-user', repo: 'demo-repo', path: 'src' })).rejects.toThrow(
      /is a directory/,
    );
  });

  it('get_file_content still returns real file content', async () => {
    const handlers = createHandlers();
    const content = (await handlers.get_file_content({
      owner: 'demo-user',
      repo: 'demo-repo',
      path: 'package.json',
    })) as string;

    expect(content.length).toBeGreaterThan(0);
    expect(content).not.toContain('is a directory');
  });

  it('answers a real file with its content and no error', async () => {
    const { call } = registerWith(new ForgejoClient('https://forgejo.example.com', 'mock-token'));
    const result = await call('get_file_content', { owner: 'demo-user', repo: 'demo-repo', path: 'package.json' });

    expect(result?.isError).toBeFalsy();
    expect(result?.content[0].text ?? '').toContain('demo-repo');
  });

  it('answers a directory path with isError instead of a successful notice', async () => {
    // The MCP-facing signalling, driven through the real client and the mock HTTP
    // server: a directory read is an error, so an agent caller does not have to
    // read prose to notice that it did not receive file content.
    const { call } = registerWith(new ForgejoClient('https://forgejo.example.com', 'mock-token'));
    const result = await call('get_file_content', { owner: 'demo-user', repo: 'demo-repo', path: 'src' });

    expect(result?.isError).toBe(true);
    expect(result?.content[0].text ?? '').toContain('is a directory');
    expect(result?.content[0].text ?? '').toContain('list_repo_contents');
  });

  it('does not treat quoted notice prose in a file as a non-file answer', async () => {
    // The tool decides on the kind the client reports, never on the text: a file
    // that documents the directory notice is still file content.
    const { call } = registerWithStubClient({
      getFileContentResult: async () => ({
        kind: 'file',
        text: 'The tool answers "other.md is a directory, not a file: use list_repo_contents to list its entries." for a directory.\n',
      }),
    });
    const result = await call('get_file_content', { owner: 'demo-user', repo: 'demo-repo', path: 'notes.md' });

    expect(result?.isError).toBeFalsy();
    expect(result?.content[0].text ?? '').toContain('for a directory');
  });

  it('answers a symlink with its target as an error, not as a withheld payload', async () => {
    // Forgejo answers a symlink with its `target` and a `size` equal to the link
    // target's length, and no `content`. The size-only reading reported that as
    // "above the instance's contents API payload limit" — a cause the server
    // never gave — and passed it back as successful content.
    const { call } = registerWith(new ForgejoClient('https://forgejo.example.com', 'mock-token'));
    const result = await call('get_file_content', { owner: 'demo-user', repo: 'demo-repo', path: 'docs/link.md' });
    const text = result?.content[0].text ?? '';

    expect(result?.isError).toBe(true);
    expect(text).toContain('symlink');
    expect(text).toContain('README.md');
    expect(text).not.toContain('payload limit');
  });

  it('answers a submodule with its git URL as an error, not as an empty file', async () => {
    // Forgejo answers a submodule with `submodule_git_url` and size 0 and no
    // `content`; the size-only reading returned an empty string, which reads as
    // "this file is empty".
    const { call } = registerWith(new ForgejoClient('https://forgejo.example.com', 'mock-token'));
    const result = await call('get_file_content', { owner: 'demo-user', repo: 'demo-repo', path: 'vendor/lib' });
    const text = result?.content[0].text ?? '';

    expect(result?.isError).toBe(true);
    expect(text).toContain('submodule');
    expect(text).toContain('upstream-lib.git');
    expect(text).not.toBe('');
  });

  it('leaves the withheld-payload notice a successful result', async () => {
    // A file above the instance's contents API payload limit is an accepted
    // limitation, not a caller error (see KNOWN_ISSUES.md): the notice names the
    // size and points at the browser, so it is passed through without isError.
    // The non-file entries above are errors; this one is not.
    const notice =
      "Forgejo did not return this file's content: at 12884902 bytes it is above the instance's contents API payload limit. Read it in the browser instead.";
    const { call } = registerWithStubClient({
      getFileContentResult: async () => ({ kind: 'withheld', text: notice }),
    });
    const result = await call('get_file_content', { owner: 'demo-user', repo: 'demo-repo', path: 'huge.bin' });

    expect(result?.isError).toBeFalsy();
    expect(result?.content[0].text ?? '').toContain('payload limit');
    expect(result?.content[0].text ?? '').toContain('12884902');
  });

  it('answers a withheld payload through the real client with its size and no error', async () => {
    // End to end: the mock's `huge.bin` entry carries the real size and no
    // content, exactly what Forgejo sends above `DEFAULT_MAX_BLOB_SIZE`.
    const { call } = registerWith(new ForgejoClient('https://forgejo.example.com', 'mock-token'));
    const result = await call('get_file_content', { owner: 'demo-user', repo: 'demo-repo', path: 'huge.bin' });
    const text = result?.content[0].text ?? '';

    expect(result?.isError).toBeFalsy();
    expect(text).toContain('payload limit');
    expect(text).toContain(String(12 * 1024 * 1024));
  });

  it('get_pull_review_comments returns inline comments with path and position', async () => {
    const handlers = createHandlers();
    const comments = (await handlers.get_pull_review_comments({
      owner: 'demo-user',
      repo: 'demo-repo',
      index: 2,
      reviewId: 100,
    })) as (typeof mockPullReviewComment)[];
    expect(comments).toHaveLength(1);
    expect(comments[0].path).toBe(mockPullReviewComment.path);
    expect(comments[0].position).toBe(mockPullReviewComment.position);
  });

  it('list_pull_reviews returns the review conclusions', async () => {
    const handlers = createHandlers();
    const reviews = (await handlers.list_pull_reviews({
      owner: 'demo-user',
      repo: 'demo-repo',
      index: 2,
    })) as (typeof mockPullReview)[];
    expect(reviews).toHaveLength(1);
    expect(reviews[0].id).toBe(mockPullReview.id);
    expect(reviews[0].state).toBe(mockPullReview.state);
  });

  it('whoami returns the authenticated user', async () => {
    const handlers = createHandlers();
    const user = (await handlers.whoami()) as typeof mockUser;
    expect(user.login).toBe(mockUser.login);
  });

  it('list_releases returns the repository releases', async () => {
    const handlers = createHandlers();
    const releases = (await handlers.list_releases({ owner: 'demo-user', repo: 'demo-repo' })) as {
      tag_name?: string;
    }[];
    expect(releases).toHaveLength(1);
    expect(releases[0].tag_name).toBe('v2.0.0');
  });

  it('list_labels returns the repository labels', async () => {
    const handlers = createHandlers();
    const labels = (await handlers.list_labels({ owner: 'demo-user', repo: 'demo-repo' })) as (typeof mockLabel)[];
    expect(labels).toHaveLength(1);
    expect(labels[0].name).toBe(mockLabel.name);
  });

  it('list_milestones returns the repository milestones', async () => {
    const handlers = createHandlers();
    const milestones = (await handlers.list_milestones({
      owner: 'demo-user',
      repo: 'demo-repo',
    })) as (typeof mockMilestone)[];
    expect(milestones).toHaveLength(1);
    expect(milestones[0].title).toBe(mockMilestone.title);
  });

  it('list_my_repos returns the authenticated user repositories', async () => {
    const handlers = createHandlers();
    const repos = (await handlers.list_my_repos()) as (typeof mockRepository)[];
    expect(repos).toHaveLength(3);
    expect(repos[0].full_name).toBe(mockRepository.full_name);
  });

  it('get_repo says a branch and commit list the client cut is capped', async () => {
    // getRepoDetail asks for one row beyond REPO_DETAIL_LIST_LIMIT and reports
    // the cut through `branchesTruncated`/`recentCommitsTruncated`. The tool is
    // classified as unpaged, so without a note a caller reads the 10 returned
    // rows as the complete list and concludes that the branch it wanted does not
    // exist.
    const branches = Array.from({ length: GET_REPO_LIST_CAP }, (_, i) => ({ name: `branch-${i}` }));
    const commits = Array.from({ length: GET_REPO_LIST_CAP }, (_, i) => ({ sha: `sha-${i}` }));
    const { call } = registerWithStubClient({
      getRepoDetail: async () => ({
        repository: {},
        empty: false,
        branches,
        recentCommits: commits,
        branchesTruncated: true,
        recentCommitsTruncated: true,
      }),
    });

    const result = await call('get_repo', { owner: 'demo-user', repo: 'demo-repo' });
    const text = result?.content[0].text ?? '';

    expect(text).toContain('capped');
    expect(text).toContain('branches');
    expect(text).toContain('recentCommits');
    expect(text).toContain('list_branches');
  });

  it('get_repo does not call an exactly-full list capped when nothing was cut', async () => {
    // Exactly REPO_DETAIL_LIST_LIMIT rows with the truncation flag unset is a
    // complete list: comparing the length against the cap called it incomplete.
    const branches = Array.from({ length: GET_REPO_LIST_CAP }, (_, i) => ({ name: `branch-${i}` }));
    const commits = Array.from({ length: GET_REPO_LIST_CAP }, (_, i) => ({ sha: `sha-${i}` }));
    const { call } = registerWithStubClient({
      getRepoDetail: async () => ({
        repository: {},
        empty: false,
        branches,
        recentCommits: commits,
        branchesTruncated: false,
        recentCommitsTruncated: false,
      }),
    });

    const result = await call('get_repo', { owner: 'demo-user', repo: 'demo-repo' });

    expect(result?.content[0].text).not.toContain('capped');
  });

  it('get_repo does not claim a cap when the lists are shorter than it', async () => {
    const { call } = registerWithStubClient({
      getRepoDetail: async () => ({
        repository: {},
        empty: false,
        branches: ['main', 'dev'],
        recentCommits: [{}],
      }),
    });
    const result = await call('get_repo', { owner: 'demo-user', repo: 'demo-repo' });

    expect(result?.content[0].text).not.toContain('capped');
  });

  it('search_repo_files says the match list was capped at the 200-match limit', async () => {
    // `truncated` is true both when the tree could not be read completely and
    // when the match list hit MAX_SEARCH_RESULTS; only the second is
    // recoverable by narrowing the query, so the note must say so. Which cause
    // applied is the client's report, not the array length: `files` is already
    // sliced to the cap by the time the tool sees it.
    const files = Array.from({ length: MAX_SEARCH_RESULTS }, (_, i) => ({ path: `match-${i}.ts` }));
    const { call, calls } = registerWithStubClient({
      getRepoDefaultBranch: async () => 'main',
      searchRepoFiles: async () => ({ files, truncated: true, truncatedBy: 'matches' }),
    });

    const result = await call('search_repo_files', { owner: 'demo-user', repo: 'demo-repo', query: 'match' });
    const text = result?.content[0].text ?? '';

    // `ref` is resolved by the client when the caller omits it, so the stub is
    // called with the default branch the tool asked for.
    expect(calls.map((entry) => entry.name)).toEqual(['getRepoDefaultBranch', 'searchRepoFiles']);
    expect(text).toContain(`capped at ${MAX_SEARCH_RESULTS}`);
    expect(text).toContain('narrower query');
  });

  it('search_repo_files says the tree was incomplete when it could not be read fully', async () => {
    // The other cause of the same `truncated` flag: narrowing the query cannot
    // recover matches that were never read, so the note must not promise it.
    const { call } = registerWithStubClient({
      getRepoDefaultBranch: async () => 'main',
      searchRepoFiles: async () => ({ files: [{ path: 'src/index.ts' }], truncated: true, truncatedBy: 'tree' }),
    });

    const result = await call('search_repo_files', { owner: 'demo-user', repo: 'demo-repo', query: 'index' });
    const text = result?.content[0].text ?? '';

    expect(text).toContain('incomplete');
    expect(text).not.toContain('capped at');
    expect(text).not.toContain('narrower query');
  });

  it('search_repo_files stays silent when nothing was truncated', async () => {
    const { call } = registerWithStubClient({
      getRepoDefaultBranch: async () => 'main',
      searchRepoFiles: async () => ({ files: [{ path: 'src/index.ts' }], truncated: false }),
    });
    const result = await call('search_repo_files', { owner: 'demo-user', repo: 'demo-repo', query: 'index' });

    expect(result?.content[0].text ?? '').not.toContain('capped at');
  });

  it('names the owner and repository of a 404 on the repository', async () => {
    // One message covered every 404 (bad owner/repo, bad path, real scope
    // problem), so the caller could not tell what to change. The client
    // attaches the resource it asked for; this is the rendering the tool shows.
    const { call } = registerWithStubClient({
      getRepoDetail: async () => {
        throw toApiError(new Error('Forgejo API error 404: Not Found ({"message":"not found"})'), {
          resource: 'repository',
          owner: 'demo-user',
          repo: 'demo-repo',
        });
      },
    });

    const result = await call('get_repo', { owner: 'demo-user', repo: 'demo-repo' });
    const text = result?.content[0].text ?? '';

    expect(result?.isError).toBe(true);
    expect(text).toContain('Not found');
    expect(text).toContain('demo-user/demo-repo');
    expect(text).toContain('Check the owner and repo');
    expect(text).not.toContain('mock-token');
  });

  it('names the resource kind of a 404 on a repository-scoped object', async () => {
    const { call } = registerWithStubClient({
      getFileContentResult: async () => {
        throw toApiError(new Error('Forgejo API error 404: Not Found ({"message":"not found"})'), {
          resource: 'file or directory',
          owner: 'demo-user',
          repo: 'demo-repo',
        });
      },
    });

    const result = await call('get_file_content', {
      owner: 'demo-user',
      repo: 'demo-repo',
      path: 'missing.md',
    });
    const text = result?.content[0].text ?? '';

    expect(text).toContain('demo-user/demo-repo');
    expect(text).toMatch(/file or directory/);
  });
});

describe('truncateLargeStrings', () => {
  it('keeps short strings untouched', () => {
    expect(truncateLargeStrings({ body: 'short' })).toEqual({ body: 'short' });
  });

  it('truncates oversized strings with a marker', () => {
    const long = 'x'.repeat(MAX_TOOL_TEXT_LENGTH + 500);
    const result = truncateLargeStrings({ body: long });
    expect(result.body.length).toBeLessThan(long.length);
    expect(result.body.startsWith('x'.repeat(MAX_TOOL_TEXT_LENGTH))).toBe(true);
    expect(result.body).toContain('truncated');
  });

  it('walks nested objects and arrays', () => {
    const long = 'y'.repeat(MAX_TOOL_TEXT_LENGTH + 1);
    const result = truncateLargeStrings({ items: [{ body: long, other: 1 }], ok: 'fine' });
    expect(result.items[0].body).toContain('truncated');
    expect(result.items[0].other).toBe(1);
    expect(result.ok).toBe('fine');
  });

  it('passes non-string scalars through', () => {
    expect(truncateLargeStrings(42)).toBe(42);
    expect(truncateLargeStrings(null)).toBe(null);
    expect(truncateLargeStrings(undefined)).toBe(undefined);
  });
});

describe('CI failure extraction', () => {
  it('recognizes failure statuses and ignores the others', () => {
    expect(isFailedActionJob({ status: 'failure' })).toBe(true);
    expect(isFailedActionJob({ status: 'error' })).toBe(true);
    // A GitHub-compatible payload may report the outcome as `conclusion`.
    expect(isFailedActionJob({ conclusion: 'failure' })).toBe(true);
    for (const job of [{ status: 'success' }, { status: 'cancelled' }, { status: 'skipped' }, {}]) {
      expect(isFailedActionJob(job), JSON.stringify(job)).toBe(false);
    }
  });

  it('matches error lines without flagging benign error wording', () => {
    for (const line of [
      'error: cannot find module',
      'FAIL src/index.test.ts',
      'panic: runtime error: index out of range',
      'fatal: not a git repository',
      'AssertionError: expected 1 to equal 2',
      'Process completed with exit code 1',
      '##[error]Process completed with exit code 2',
    ]) {
      expect(isCiErrorLine(line), line).toBe(true);
    }
    for (const line of [
      'compiled with 0 errors',
      'no failures detected',
      'error-free build',
      'errors: 0 warnings: 3',
      'step 4: all tests passed',
    ]) {
      expect(isCiErrorLine(line), line).toBe(false);
    }
  });

  it('keeps context around the matches nearest the end of the log', () => {
    const log = [
      'line 1',
      'error: early noise',
      'line 3',
      'line 4',
      ...Array.from({ length: 30 }, (_, i) => `progress ${i}`),
      'error: the real failure',
      'line after',
    ].join('\n');

    const result = extractCiErrorContext(log, 4096);

    expect(result.matchCount).toBe(2);
    expect(result.truncated).toBe(false);
    expect(result.text).toContain('error: early noise');
    expect(result.text).toContain('line 3');
    expect(result.text).toContain('error: the real failure');
    expect(result.text).toContain('line after');
  });

  it('drops the oldest matches when a log repeats an error word', () => {
    const log = Array.from({ length: 50 }, (_, i) => `error ${i}`).join('\n');

    const result = extractCiErrorContext(log, 4096);

    expect(result.matchCount).toBe(50);
    expect(result.truncated).toBe(true);
    expect(result.text).toContain('50: error 49');
    expect(result.text).not.toContain('1: error 0');
  });

  it('shortens the error context to the budget instead of losing the match', () => {
    const log = [`error: the failure ${'z'.repeat(80)}`, ...Array.from({ length: 40 }, (_, i) => `context ${i}`)].join(
      '\n',
    );

    const result = extractCiErrorContext(log, 60);

    expect(result.truncated).toBe(true);
    expect(result.text).toContain('error: the failure');
    expect(result.text.length).toBeLessThanOrEqual(60);
  });

  it('keeps the end of a log tail and marks the line cut', () => {
    const log = Array.from({ length: 150 }, (_, i) => `line ${i + 1}`).join('\n');

    const result = extractCiLogTail(log, 4096);

    expect(result.lineCount).toBe(CI_TAIL_LINE_COUNT);
    expect(result.truncated).toBe(true);
    expect(result.text).toContain('150: line 150');
    expect(result.text.startsWith('51: line 51')).toBe(true);
  });

  it('shortens the tail from the front when the slice is smaller than the line count', () => {
    const log = Array.from({ length: 100 }, (_, i) => `line ${i + 1} ${'x'.repeat(50)}`).join('\n');

    const result = extractCiLogTail(log, 500);

    expect(result.lineCount).toBeLessThan(CI_TAIL_LINE_COUNT);
    expect(result.truncated).toBe(true);
    expect(result.text).toContain('line 100');
    // The kept part is the end of the log, not its start.
    expect(Number(result.text.split('\n')[0].split(':')[0])).toBeGreaterThan(1);
  });

  it('flags the client cap without needing a 10 MB fixture', () => {
    // The cap is injectable precisely so this test does not have to build one.
    expect(logWasTruncatedByClient('x'.repeat(100), 99)).toBe(true);
    expect(logWasTruncatedByClient('x'.repeat(99), 99)).toBe(false);
    expect(logWasTruncatedByClient('short')).toBe(false);
  });

  it('marks a log the client had already cut before the tool saw it', () => {
    // A tiny cap stands in for the client's 10 MB cap: this is the cut that can
    // hide the failure entirely, because it removes the tail rather than the
    // head, so it has to reach the agent as prose and not only as a flag.
    const summary = summarizeCiJobLog('x'.repeat(100), 1024, 99);

    expect(summary.truncatedByClient).toBe(true);
    expect(summary.truncationNote).toContain('not the end of the real log');
    expect(summary.truncationNote).toContain('web UI');
  });

  it('leaves the truncation marker unset when the whole log was read', () => {
    const summary = summarizeCiJobLog('build ok', 1024, 99);

    expect(summary.truncatedByClient).toBe(false);
    expect(summary.truncationNote).toBeUndefined();
  });

  it('sizes both slices of a job summary to the shared budget', () => {
    const log = ['error: boom', ...Array.from({ length: 300 }, (_, i) => `line ${i}`)].join('\n');

    const summary = summarizeCiJobLog(log, 1024);

    expect(summary.logCharacters).toBe(log.length);
    expect(summary.logLines).toBe(301);
    expect(summary.truncatedByClient).toBe(false);
    expect(summary.errorContext).toContain('error: boom');
    expect(summary.errorMatchCount).toBe(1);
    expect(summary.tail).toContain('line 299');
    expect(summary.tailTruncated).toBe(true);
    // The slices the handler hands out match the split `summarizeCiJobLog`
    // applies: tail 60%, error lines 40% of the shared budget.
    expect(summary.tail.length).toBeLessThanOrEqual(Math.floor(1024 * 0.6));
    expect(summary.errorContext.length).toBeLessThanOrEqual(Math.floor(1024 * 0.4));
  });
});

describe('tool input path validation', () => {
  it('accepts ordinary owner and repository names', () => {
    expect(isSafePathSegment('demo-user')).toBe(true);
    expect(isSafePathSegment('cpf23333')).toBe(true);
    expect(isSafePathSegment('repo.name_1')).toBe(true);
    expect(isSafePathSegment('组织')).toBe(true);
  });

  it('rejects values that would leave the intended endpoint', () => {
    // The generated client interpolates these raw into `/repos/${owner}/${repo}/…`,
    // and the URL parser resolves dot segments and splits on '?'/'#'.
    for (const value of [
      'x/../../admin/users',
      '..',
      '.',
      'repo#',
      'repo?state=all',
      're%2Fpo',
      '',
      ' repo',
      'repo ',
    ]) {
      expect(isSafePathSegment(value), value).toBe(false);
    }
  });

  it('rejects control characters and backslashes', () => {
    expect(isSafePathSegment('repo\\name')).toBe(false);
    expect(isSafePathSegment('repo\nname')).toBe(false);
    expect(isSafePathSegment('repo\u0000name')).toBe(false);
  });

  it('accepts repository-relative file paths', () => {
    expect(isSafeRepoPath('src/index.ts')).toBe(true);
    expect(isSafeRepoPath('docs/a b/说明.md')).toBe(true);
  });

  it('rejects file paths with traversal or empty segments', () => {
    for (const value of ['../../etc/passwd', 'src/../../x', 'src//index.ts', './src', 'src/./x', 'src\\index.ts']) {
      expect(isSafeRepoPath(value), value).toBe(false);
    }
  });

  it('only allows the empty path where the caller opts in', () => {
    expect(isSafeRepoPath('')).toBe(false);
    expect(isSafeRepoPath('', { allowEmpty: true })).toBe(true);
  });
});

describe('registerTools cancellation', () => {
  it('scopes the client to the signal of the tool call', async () => {
    // A cancelled tool call must abort its HTTP requests, so the dispatch has to
    // hand the SDK's signal to the client it builds the handlers with.
    const scoped = { getCurrentUser: async () => ({ login: 'demo-user' }) } as never;
    const withSignal = vi.fn(() => scoped);
    const client = { withSignal } as never;
    const registered = new Map<string, (args: unknown, extra?: { signal?: AbortSignal }) => Promise<unknown>>();
    const server = {
      registerTool: (name: string, _config: unknown, handler: never) => {
        registered.set(name, handler);
      },
    } as never;

    registerTools(server, client);
    const controller = new AbortController();
    await registered.get('whoami')?.(undefined, { signal: controller.signal });

    expect(withSignal).toHaveBeenCalledWith(controller.signal);
  });

  it('keeps the shared handlers when the call carries no signal', async () => {
    const scoped = {} as never;
    const withSignal = vi.fn(() => scoped);
    const client = { withSignal } as never;
    const registered = new Map<string, (args: unknown, extra?: { signal?: AbortSignal }) => Promise<unknown>>();
    const server = {
      registerTool: (name: string, _config: unknown, handler: never) => {
        registered.set(name, handler);
      },
    } as never;

    registerTools(server, client);
    await registered
      .get('whoami')?.(undefined, {})
      .catch(() => undefined);

    expect(withSignal).not.toHaveBeenCalled();
  });
});

describe('list truncation reporting', () => {
  it('names a list that hit the item cap and stays silent otherwise', () => {
    // Every paged client method stops at LIST_ITEM_LIMIT; the note is what tells a
    // caller that more rows exist.
    expect(
      listTruncationNote(
        Array.from({ length: LIST_ITEM_LIMIT }, () => ({})),
        ['the result'],
        { canNarrow: true },
      ),
    ).toContain('truncated at ' + LIST_ITEM_LIMIT);
    expect(
      listTruncationNote(
        Array.from({ length: LIST_ITEM_LIMIT - 1 }, () => ({})),
        ['the result'],
        { canNarrow: true },
      ),
    ).toBe('');
    expect(listTruncationNote({ items: [] }, ['the result'], { canNarrow: true })).toBe('');
  });

  it('tells a caller without any narrowing option that the rest is unreachable', () => {
    // list_branches/list_tags/list_releases/list_labels/list_milestones/
    // list_my_repos/list_pull_reviews have no filter and no paging, so "narrow
    // the query" is advice they cannot act on: the note must say the result is
    // incomplete and point at the surfaces that can show the rest.
    const note = listTruncationNote(
      Array.from({ length: LIST_ITEM_LIMIT }, () => ({})),
      ['the result'],
      { canNarrow: false },
    );

    expect(note).toContain('incomplete');
    expect(note).toContain(String(LIST_ITEM_LIMIT));
    expect(note).toContain('web UI');
    expect(note).not.toContain('narrow the query');
  });

  it('also reports a capped list wrapped in a tool result object', () => {
    // get_issue returns { issue, comments } and get_pull_request returns
    // { pullRequest, files, commits }: a capped list inside one of those used to
    // go unannounced.
    const note = listTruncationNote(
      {
        issue: { number: 1 },
        comments: Array.from({ length: LIST_ITEM_LIMIT }, () => ({})),
        files: [{ path: 'a' }],
      },
      ['comments'],
      { canNarrow: true },
    );

    expect(note).toContain('truncated at ' + LIST_ITEM_LIMIT);
    expect(note).toContain('comments');
    expect(note).not.toContain('files');
  });

  it('does not report a complete list from a method that does not page', () => {
    // list_repo_contents reads a whole directory in one request, so a directory
    // holding exactly LIST_ITEM_LIMIT entries is complete; only the lists a
    // client method pages may be announced as cut off.
    const complete = Array.from({ length: LIST_ITEM_LIMIT }, (_, i) => ({ name: `file-${i}` }));
    expect(listTruncationNote(complete, [], { canNarrow: false })).toBe('');
    expect(listTruncationNote({ files: complete }, [], { canNarrow: false })).toBe('');
    expect(listTruncationNote({ files: complete }, ['files'], { canNarrow: false })).toContain(
      'truncated at ' + LIST_ITEM_LIMIT,
    );
  });

  it('appends the note to a tool result that hit the cap', async () => {
    const capped = Array.from({ length: LIST_ITEM_LIMIT }, (_, i) => ({ id: i + 1, title: 'issue' }));
    const client = { getRepoIssues: async () => ({ items: capped }) } as never;
    const registered = new Map<string, (args: unknown, extra?: unknown) => Promise<{ content: { text: string }[] }>>();
    const server = {
      registerTool: (name: string, _config: unknown, handler: never) => {
        registered.set(name, handler);
      },
    } as never;

    registerTools(server, client);
    const result = await registered.get('list_issues')?.({ owner: 'demo-user', repo: 'demo-repo' });

    expect(result?.content[0].text).toContain('truncated at ' + LIST_ITEM_LIMIT);
  });

  it('keeps a complete unpaginated directory listing out of the truncation note', async () => {
    // The contents API answers in a single request and the client never pages
    // it, so a full directory of LIST_ITEM_LIMIT entries is not cut off and must
    // not be reported as if more rows existed.
    const complete = Array.from({ length: LIST_ITEM_LIMIT }, (_, i) => ({ name: `file-${i}.txt`, type: 'file' }));
    const client = { getRepoContents: async () => complete } as never;
    const registered = new Map<string, (args: unknown, extra?: unknown) => Promise<{ content: { text: string }[] }>>();
    const server = {
      registerTool: (name: string, _config: unknown, handler: never) => {
        registered.set(name, handler);
      },
    } as never;

    registerTools(server, client);
    const result = await registered.get('list_repo_contents')?.({ owner: 'demo-user', repo: 'demo-repo' });

    expect(result?.content[0].text).toContain('file-0.txt');
    expect(result?.content[0].text).not.toContain('truncated at');
  });

  it('does not tell a filterless listing to narrow a query it does not have', async () => {
    // list_branches takes owner/repo only: the capped list is genuinely
    // incomplete, and advice about narrowing would be unusable.
    const capped = Array.from({ length: LIST_ITEM_LIMIT }, (_, i) => ({ name: `branch-${i}` }));
    const client = { getRepoBranches: async () => capped } as never;
    const registered = new Map<string, (args: unknown, extra?: unknown) => Promise<{ content: { text: string }[] }>>();
    const server = {
      registerTool: (name: string, _config: unknown, handler: never) => {
        registered.set(name, handler);
      },
    } as never;

    registerTools(server, client);
    const result = await registered.get('list_branches')?.({ owner: 'demo-user', repo: 'demo-repo' });
    const text = result?.content[0].text ?? '';

    expect(text).toContain('incomplete');
    expect(text).not.toContain('narrow the query');
  });

  it('keeps the narrowing advice for a listing that does have filters', async () => {
    const capped = Array.from({ length: LIST_ITEM_LIMIT }, (_, i) => ({ id: i + 1, title: 'issue' }));
    const client = { getRepoIssues: async () => ({ items: capped }) } as never;
    const registered = new Map<string, (args: unknown, extra?: unknown) => Promise<{ content: { text: string }[] }>>();
    const server = {
      registerTool: (name: string, _config: unknown, handler: never) => {
        registered.set(name, handler);
      },
    } as never;

    registerTools(server, client);
    const result = await registered.get('list_issues')?.({ owner: 'demo-user', repo: 'demo-repo' });

    expect(result?.content[0].text).toContain('narrow the query');
  });

  it('does not tell a single-record tool to narrow a query it cannot send', async () => {
    // get_pull_request takes owner/repo/number: its capped `files`/`commits`
    // lists are genuinely incomplete, and there is no filter or page to pass, so
    // advising the caller to narrow would be advice it cannot act on.
    const cappedFiles = Array.from({ length: LIST_ITEM_LIMIT }, (_, i) => ({ filename: `file-${i}` }));
    const client = {
      getPullRequestDetail: async () => ({ number: 1 }),
      getPullRequestFiles: async () => cappedFiles,
      getPullRequestCommits: async () => [],
    } as never;
    const registered = new Map<string, (args: unknown, extra?: unknown) => Promise<{ content: { text: string }[] }>>();
    const server = {
      registerTool: (name: string, _config: unknown, handler: never) => {
        registered.set(name, handler);
      },
    } as never;

    registerTools(server, client);
    const result = await registered.get('get_pull_request')?.({
      owner: 'demo-user',
      repo: 'demo-repo',
      index: 1,
    });
    const text = result?.content[0].text ?? '';

    expect(text).toContain('incomplete');
    expect(text).toContain(String(LIST_ITEM_LIMIT));
    expect(text).not.toContain('narrow the query');
  });

  it('reports the real get_file_history list cap as incompleteness, never as narrowing advice', async () => {
    // The client pages up to the shared cap and the schema's `ref` selects the
    // revision to walk from, not a narrower slice of the history: there is no
    // filter or page for the caller to pass. The tool is therefore in
    // PAGED_LISTS but not in NARROWABLE_TOOLS, which is observable in two ways:
    // a capped reply gets the incompleteness wording (this test), and the
    // narrowable tools that really can refetch keep the query advice (the test
    // above).
    const capped = Array.from({ length: LIST_ITEM_LIMIT }, (_, i) => ({ sha: `sha-${i}` }));
    const client = { getFileHistory: async () => capped } as never;
    const registered = new Map<string, (args: unknown, extra?: unknown) => Promise<{ content: { text: string }[] }>>();
    const server = {
      registerTool: (name: string, _config: unknown, handler: never) => {
        registered.set(name, handler);
      },
    } as never;

    registerTools(server, client);
    const result = await registered.get('get_file_history')?.({
      owner: 'demo-user',
      repo: 'demo-repo',
      path: 'README.md',
    });
    const text = result?.content[0].text ?? '';

    // A 500-row list cap is a list truncation, not the 64 KB output budget: the
    // note names the cap the client actually applies and says the answer is
    // incomplete, with no advice the caller cannot act on.
    expect(text).toContain('incomplete');
    expect(text).toContain(String(LIST_ITEM_LIMIT));
    expect(text).not.toContain('narrow the query');
  });

  it('stays silent on a get_file_history result below the cap', async () => {
    // The note must follow the list length, not the tool: a short history is
    // complete and must not be announced as cut off.
    const short = Array.from({ length: LIST_ITEM_LIMIT - 1 }, (_, i) => ({ sha: `sha-${i}` }));
    const client = { getFileHistory: async () => short } as never;
    const registered = new Map<string, (args: unknown, extra?: unknown) => Promise<{ content: { text: string }[] }>>();
    const server = {
      registerTool: (name: string, _config: unknown, handler: never) => {
        registered.set(name, handler);
      },
    } as never;

    registerTools(server, client);
    const result = await registered.get('get_file_history')?.({
      owner: 'demo-user',
      repo: 'demo-repo',
      path: 'README.md',
    });

    expect(result?.content[0].text).not.toContain('truncated at');
  });

  it('blames the match cap only when the match list reached it', async () => {
    // The client slices `files` to MAX_SEARCH_RESULTS before returning, so a
    // capped list holds exactly that many rows and the array length alone cannot
    // say whether the cap or an unreadable tree cut the answer short.
    const capped = Array.from({ length: MAX_SEARCH_RESULTS }, (_, i) => ({ path: `src/file-${i}.ts` }));
    const client = {
      getRepoDefaultBranch: async () => 'main',
      searchRepoFiles: async () => ({ files: capped, truncated: true, truncatedBy: 'matches' }),
    } as never;
    const registered = new Map<string, (args: unknown, extra?: unknown) => Promise<{ content: { text: string }[] }>>();
    const server = {
      registerTool: (name: string, _config: unknown, handler: never) => {
        registered.set(name, handler);
      },
    } as never;

    registerTools(server, client);
    const result = await registered.get('search_repo_files')?.({
      owner: 'demo-user',
      repo: 'demo-repo',
      query: 'file',
    });
    const text = result?.content[0].text ?? '';

    expect(text).toContain('matches capped');
    expect(text).toContain('narrower query');
  });

  it('reports an unreadable tree instead of blaming the match cap', async () => {
    // A truncated tree that happens to produce exactly MAX_SEARCH_RESULTS matches
    // was cut by the tree read, not by the cap: "a narrower query would return
    // the rest" would be a promise this search cannot keep.
    const matches = Array.from({ length: MAX_SEARCH_RESULTS }, (_, i) => ({ path: `src/file-${i}.ts` }));
    const client = {
      getRepoDefaultBranch: async () => 'main',
      searchRepoFiles: async () => ({ files: matches, truncated: true, truncatedBy: 'tree' }),
    } as never;
    const registered = new Map<string, (args: unknown, extra?: unknown) => Promise<{ content: { text: string }[] }>>();
    const server = {
      registerTool: (name: string, _config: unknown, handler: never) => {
        registered.set(name, handler);
      },
    } as never;

    registerTools(server, client);
    const result = await registered.get('search_repo_files')?.({
      owner: 'demo-user',
      repo: 'demo-repo',
      query: 'file',
    });
    const text = result?.content[0].text ?? '';

    expect(text).toContain('tree could not be read');
    expect(text).not.toContain('narrower query');
  });

  it('follows the reported cause, not the array length', () => {
    // A short list from an unreadable tree, and a full cap from a complete one:
    // both are the same shape as far as `files.length` is concerned.
    const short = { files: [{ path: 'src/a.ts' }], truncated: true, truncatedBy: 'tree' };
    const full = {
      files: Array.from({ length: MAX_SEARCH_RESULTS }, (_, i) => ({ path: `src/${i}.ts` })),
      truncated: true,
      truncatedBy: 'matches',
    };

    expect(repoSearchTruncationNote(short)).toContain('tree could not be read');
    expect(repoSearchTruncationNote(short)).not.toContain('narrower query');
    expect(repoSearchTruncationNote(full)).toContain('matches capped');
    // Without the signal the note cannot claim the cap caused the cut.
    expect(repoSearchTruncationNote({ files: full.files, truncated: true })).toContain('tree could not be read');
  });
});

describe('tool descriptions and schemas', () => {
  interface ToolConfig {
    description?: string;
    inputSchema?: Record<string, { description?: string }>;
  }

  /**
   * Registers the tools against a stub server that keeps each tool's config, so
   * a test can read what the model is told. Registering touches no client
   * method, so an empty client suffices.
   */
  function captureConfigs(): Map<string, ToolConfig> {
    const configs = new Map<string, ToolConfig>();
    const server = {
      registerTool: (name: string, config: ToolConfig, _handler: never) => {
        configs.set(name, config);
      },
    } as never;
    registerTools(server, {} as never);
    return configs;
  }

  it('names the real list cap in the get_file_history description', () => {
    // The description said "(up to 50)" while the client pages to the shared
    // cap, so a caller that reached the cap could only conclude the 64 KB output
    // budget had cut the answer: the list cap went unnamed.
    const description = captureConfigs().get('get_file_history')?.description ?? '';

    expect(description).toContain(String(LIST_ITEM_LIMIT));
    expect(description).toContain('incomplete');
    expect(description).not.toContain('up to 50');
  });

  it('tells the caller how a directory, symlink, submodule and withheld payload are answered', () => {
    // None of the four answers is file content, and a description that only
    // promised content left the caller to guess what it had received.
    const description = captureConfigs().get('get_file_content')?.description ?? '';

    expect(description).toContain('list_repo_contents');
    expect(description).toMatch(/reported as an error/);
    expect(description).toContain('symlink');
    expect(description).toContain('submodule');
    expect(description).toMatch(/payload limit/);
    // The withheld notice is not an error, and the description must not imply it
    // is: that answer is a successful result.
    expect(description).toMatch(/successful notice/);
  });

  it('describes the keyword filter the server actually applies', () => {
    // The field description promised "title, body, or author" while Forgejo's
    // indexer matches the title, body and comments — and the author match never
    // happened, because nothing filtered by author.
    const config = captureConfigs().get('list_issues');
    const query = config?.inputSchema?.query?.description ?? '';

    expect(query).toContain('comments');
    expect(query).toContain('not the author');
    expect(config?.description).toContain('comments');
    expect(config?.description).toMatch(/does not match the author/);
    // The rows are not re-filtered client-side, so no description claims a
    // second, narrower filter over what the server returned.
    expect(config?.description).not.toContain('returned rows');

    const pulls = captureConfigs().get('list_pull_requests');
    expect(pulls?.inputSchema?.query?.description ?? '').toContain('comments');
    expect(pulls?.description ?? '').toContain('comments');
  });

  it('tells the caller that a notification page repeats its boundary row', () => {
    // Forgejo filters with `updated_unix <= before`, so the oldest row of the
    // previous page comes back: the recipe that says "pass the oldest row's
    // updated_at" cannot be followed literally without a duplicate.
    const config = captureConfigs().get('list_notifications');

    expect(config?.description).toContain('boundary notification');
    expect(config?.description).toContain('skip');
    expect(config?.inputSchema?.before?.description ?? '').toContain('skip');
  });

  it('tells the caller that get_pull_request carries the issue API assets', () => {
    // The handler merges the issues API's `assets` array in, and reports a
    // failed attachments read with `attachmentsUnavailable`; a description that
    // promised only the pull request left both undocumented.
    const description = captureConfigs().get('get_pull_request')?.description ?? '';

    expect(description).toContain('assets');
    expect(description).toContain('attachmentsUnavailable');
  });

  it('names the truncation flags carried by the get_repo result', () => {
    // The note is built from the client's own report of the cut, so the caller
    // has to be told where that report lives.
    const description = captureConfigs().get('get_repo')?.description ?? '';

    expect(description).toContain('branchesTruncated');
    expect(description).toContain('recentCommitsTruncated');
  });

  it('says which search types the state filter applies to', () => {
    // `state` sits in the schema for all three types, but only the issues and
    // pull request branches read it: `searchRepositories` has no state concept.
    // A raw Zod shape cannot make a field conditional on another field's value,
    // so the qualification belongs in the description and in the field's own
    // description.
    const config = captureConfigs().get('search');

    expect(config?.description).toMatch(/state filter applies to type "issues" and "pull_requests"/);
    expect(config?.description).toContain('repositories have no state');
    expect(config?.inputSchema?.state?.description ?? '').toContain('repositories have no state');
  });

  it('documents how to obtain the list_notifications page cursor', () => {
    // The tool returns one caller-sized page and the client takes a `before`
    // cursor; without both in the interface a caller whose page filled up had no
    // way to see the rest and no sign that more rows existed.
    const config = captureConfigs().get('list_notifications');

    expect(config?.description).toContain('next page');
    expect(config?.description).toContain('updated_at');
    expect(config?.inputSchema?.before?.description ?? '').toContain('updated_at');
  });

  it('tells the caller how the failure summary differs from the raw log tool', () => {
    // The two tools overlap in name and subject, so the description has to say
    // which one to reach for: the summary returns the tail where the failure
    // prints, while get_action_job_log keeps the head of one raw log.
    const config = captureConfigs().get('get_ci_failure_summary');

    expect(config?.description).toContain('get_action_job_log');
    expect(config?.description).toContain('tail');
    expect(config?.description).toContain('truncatedByClient');
    expect(config?.inputSchema?.includePassedJobs?.description ?? '').toContain('Default: false');
  });

  it('tells the caller how the review brief divides work with the detail tools', () => {
    // The brief overlaps get_pull_request, get_pr_diff and get_pr_timeline, so
    // the description has to say what it leaves out and which tool to reach for
    // each omission — otherwise an agent can read a brief without a diff as a
    // complete review input.
    const config = captureConfigs().get('get_pr_review_brief');

    expect(config?.description).toContain('get_pr_diff');
    expect(config?.description).toContain('get_pr_timeline');
    expect(config?.description).toContain('get_pull_request');
    expect(config?.description).toMatch(/never the diff text/);
    // Every cut the result can carry is named, so the caller can act on it.
    expect(config?.description).toContain('truncatedBy');
    expect(config?.description).toContain('unreadableReviewCount');
    expect(config?.inputSchema?.includeDiffStats?.description ?? '').toContain('default: true');
  });
});
