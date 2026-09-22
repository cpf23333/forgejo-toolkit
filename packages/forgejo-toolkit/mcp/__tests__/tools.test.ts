import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { http, HttpResponse } from 'msw';
import { ForgejoClient } from '../../src/api/client';
import { ApiError } from '../../src/api/errors-core';
import {
  buildToolHandlers,
  isSafePathSegment,
  isSafeRepoPath,
  truncateLargeStrings,
  MAX_TOOL_TEXT_LENGTH,
} from '../tools';
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

  it('list_action_runs returns the workflow run list', async () => {
    const handlers = createHandlers();
    const runs = (await handlers.list_action_runs({ owner: 'demo-user', repo: 'demo-repo' })) as {
      total_count?: number;
      workflow_runs: { id?: number }[];
    };
    expect(runs.total_count).toBe(1);
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

  it('get_pr_diff returns the unified diff text', async () => {
    const handlers = createHandlers();
    const diff = await handlers.get_pr_diff({ owner: 'demo-user', repo: 'demo-repo', index: 2 });
    expect(diff).toContain('diff --git a/src/index.ts');
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
    const releases = (await handlers.list_releases({ owner: 'demo-user', repo: 'demo-repo' })) as unknown[];
    expect(releases).toHaveLength(0);
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
