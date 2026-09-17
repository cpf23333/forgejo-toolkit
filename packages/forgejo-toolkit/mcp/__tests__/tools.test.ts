import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { http, HttpResponse } from 'msw';
import { ForgejoClient } from '../../src/api/client';
import { ApiError } from '../../src/api/errors-core';
import { buildToolHandlers, truncateLargeStrings, MAX_TOOL_TEXT_LENGTH } from '../tools';
import { startMockServer, stopMockServer, resetMockServer, mockServer } from '../../src/test/mocks/server';
import {
  mockIssues,
  mockIssueDetail,
  mockPullRequests,
  mockPullRequestDetail,
  mockPullRequestCommit,
  mockTimelineComment,
  mockNotifications,
  mockRepository,
} from '../../src/test/mocks/data';

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
