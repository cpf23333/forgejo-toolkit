import { describe, it, expect, beforeAll, afterAll, afterEach, beforeEach, vi } from 'vitest';
import * as vscode from 'vscode';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { http, HttpResponse } from 'msw';
import type {
  CreateBranchRepoOption,
  CreateIssueOption,
  CreatePullRequestOption,
  CreatePullReviewComment,
  CreateReleaseOption,
  CreateTagOption,
  EditIssueOption,
  EditPullRequestOption,
  EditReleaseOption,
} from '@cpf23333-forgejo-toolkit/api';
import { ForgejoClient, clearTreeCache } from '../client';
import { ApiError } from '../errors';
import { clearServerVersions, setServerVersion } from '../serverVersion';
import type { Logger } from '../../logger';
import { startMockServer, stopMockServer, resetMockServer, mockServer } from '../../test/mocks/server';
import { MOCK_SERVER_VERSION } from '../../test/mocks/handlers';
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
  mockActionRun,
  mockActionRunJob,
  mockActionArtifact,
  mockReleaseAttachment,
  mockLabel,
  mockMilestone,
  mockReaction,
  mockTrackedTime,
  mockWatchInfo,
  mockPullReview,
  mockPullReviewComment,
  mockPullRequestCommit,
  mockPullRequestDiff,
  mockTimelineComment,
  mockHistoryCommit,
  mockCommentAttachment,
  mockIssueAttachment,
} from '../../test/mocks/data';

describe('ForgejoClient with MSW', () => {
  beforeAll(() => {
    startMockServer();
  });

  afterAll(() => {
    stopMockServer();
  });

  afterEach(() => {
    resetMockServer();
    // The git-tree cache is shared across client instances; tests must not
    // observe each other's cached trees.
    clearTreeCache();
  });

  function createClient(): ForgejoClient {
    return new ForgejoClient('https://forgejo.example.com', 'mock-token');
  }

  it('fetches current user', async () => {
    const client = createClient();
    const user = await client.getCurrentUser();
    expect(user.login).toBe(mockUser.login);
    expect(user.email).toBe(mockUser.email);
  });

  it('fetches user stopwatches', async () => {
    const client = createClient();
    const stopwatches = await client.getUserStopWatches();
    expect(stopwatches).toEqual([]);
  });

  it('fetches user repositories', async () => {
    const client = createClient();
    const repos = await client.getUserRepositories();
    expect(repos).toHaveLength(3);
    expect(repos[0].full_name).toBe(mockRepository.full_name);
    expect(repos[1].full_name).toBe(mockRepository2.full_name);
    expect(repos[2].full_name).toBe(mockRepositoryFail.full_name);
  });

  it('paginates past a server that silently clamps the page size', async () => {
    const client = createClient();
    // Simulate MAX_RESPONSE_ITEMS=30: every page returns at most 30 items no
    // matter what limit was requested. 70 repos must still all be fetched.
    const total = 70;
    mockServer.use(
      http.get('https://*/api/v1/user/repos', ({ request }) => {
        const url = new URL(request.url);
        const page = Number(url.searchParams.get('page') ?? '1');
        const start = (page - 1) * 30;
        const items = Array.from({ length: Math.max(0, Math.min(30, total - start)) }, (_, i) => ({
          ...mockRepository,
          id: start + i + 1,
          full_name: `demo-user/repo-${start + i + 1}`,
        }));
        return HttpResponse.json(items);
      }),
    );
    const repos = await client.getUserRepositories();
    expect(repos).toHaveLength(70);
    expect(repos[69].full_name).toBe('demo-user/repo-70');
  });

  it('stops paginating when the server keeps returning the first page', async () => {
    const client = createClient();
    let requests = 0;
    mockServer.use(
      http.get('https://*/api/v1/user/repos', () => {
        requests += 1;
        // The server ignores the page param and always answers with the same
        // full page; without the duplicate-page guard the client would
        // accumulate copies up to the MAX_ITEMS cap.
        return HttpResponse.json(
          Array.from({ length: 50 }, (_, i) => ({
            ...mockRepository,
            id: i + 1,
            full_name: `demo-user/repo-${i + 1}`,
          })),
        );
      }),
    );
    const repos = await client.getUserRepositories();
    expect(repos).toHaveLength(50);
    expect(requests).toBe(2);
  });

  it('creates a user repository', async () => {
    const client = createClient();
    let receivedBody: Record<string, unknown> | undefined;
    mockServer.use(
      http.post('https://*/api/v1/user/repos', async ({ request }) => {
        receivedBody = (await request.json()) as Record<string, unknown>;
        return HttpResponse.json(
          {
            ...mockRepository,
            name: String(receivedBody.name ?? mockRepository.name),
            private: Boolean(receivedBody.private),
          },
          { status: 201 },
        );
      }),
    );
    const repo = await client.createUserRepo({ name: 'new-repo', private: true, auto_init: false });
    expect(receivedBody).toEqual({ name: 'new-repo', private: true, auto_init: false });
    expect(repo.name).toBe('new-repo');
    expect(repo.private).toBe(true);
  });

  it('surfaces API errors when creating a user repository', async () => {
    const client = createClient();
    mockServer.use(
      http.post('https://*/api/v1/user/repos', () =>
        HttpResponse.json({ message: 'The repository with the same name already exists.' }, { status: 409 }),
      ),
    );
    await expect(client.createUserRepo({ name: 'demo-repo' })).rejects.toThrow('Forgejo API error 409');
  });

  it('wraps HTTP failures in a structured ApiError', async () => {
    const client = createClient();
    mockServer.use(
      http.post('https://*/api/v1/user/repos', () =>
        HttpResponse.json({ message: 'The repository with the same name already exists.' }, { status: 409 }),
      ),
    );
    const rejection = await client.createUserRepo({ name: 'demo-repo' }).catch((error: unknown) => error);
    expect(rejection).toBeInstanceOf(ApiError);
    const apiError = rejection as ApiError;
    expect(apiError.kind).toBe('http');
    expect(apiError.status).toBe(409);
    // The raw message is preserved for logs/pattern matching; the localized
    // rendering keeps the server's reason.
    expect(apiError.rawMessage).toContain('Forgejo API error 409');
    expect(apiError.userMessage).toContain('The repository with the same name already exists.');
  });

  it('fetches user issues', async () => {
    const client = createClient();
    const issues = await client.getUserIssues('open');
    expect(Array.isArray(issues)).toBe(true);
    expect(issues).toHaveLength(mockIssues.length);
    expect(issues[0].title).toBe(mockIssues[0].title);
  });

  it('fetches user pull requests', async () => {
    const client = createClient();
    const pulls = await client.getUserPullRequests('open');
    expect(Array.isArray(pulls)).toBe(true);
    expect(pulls).toHaveLength(mockPullRequests.length);
    expect(pulls[0].title).toBe(mockPullRequests[0].title);
  });

  it('scopes the user issue/PR search to the authenticated user', async () => {
    const client = createClient();
    // The shared mock handler ignores the user-scoping params, so capture the
    // query string with an override. Empty pages keep the request count at 1.
    const captured: URLSearchParams[] = [];
    mockServer.use(
      http.get('https://*/api/v1/repos/issues/search', ({ request }) => {
        captured.push(new URL(request.url).searchParams);
        return HttpResponse.json([]);
      }),
    );

    await client.getUserIssues('open');
    await client.getUserPullRequests('all');

    expect(captured).toHaveLength(2);
    // Without these four flags /repos/issues/search returns every issue in
    // every visible repository (default is false for all of them).
    for (const params of captured) {
      expect(params.get('created')).toBe('true');
      expect(params.get('assigned')).toBe('true');
      expect(params.get('mentioned')).toBe('true');
      expect(params.get('review_requested')).toBe('true');
    }
    expect(captured[0].get('type')).toBe('issues');
    expect(captured[0].get('state')).toBe('open');
    expect(captured[1].get('type')).toBe('pulls');
    expect(captured[1].get('state')).toBe('all');
  });

  it('searches repositories', async () => {
    const client = createClient();
    const repos = await client.searchRepositories('demo');
    expect(repos).toHaveLength(3);
    expect(repos[0].full_name).toBe(mockRepository.full_name);
  });

  it('searches issues', async () => {
    const client = createClient();
    const issues = await client.searchIssues('bug', 'open');
    expect(Array.isArray(issues)).toBe(true);
    expect(issues).toHaveLength(mockIssues.length);
    expect(issues[0].title).toBe(mockIssues[0].title);
  });

  it('searches pull requests', async () => {
    const client = createClient();
    const pulls = await client.searchPullRequests('dark', 'open');
    expect(Array.isArray(pulls)).toBe(true);
    expect(pulls).toHaveLength(mockPullRequests.length);
    expect(pulls[0].title).toBe(mockPullRequests[0].title);
  });

  it('fetches notifications', async () => {
    const client = createClient();
    const notifications = await client.getNotifications();
    const unreadNotifications = mockNotifications.filter((n) => n.unread);
    expect(notifications).toHaveLength(unreadNotifications.length);
    expect(notifications[0].subject?.title).toBe(unreadNotifications[0].subject?.title);
  });

  it('marks a notification as read', async () => {
    const client = createClient();
    await expect(client.markNotificationRead(101)).resolves.toBeUndefined();
  });

  it('marks all notifications as read', async () => {
    const client = createClient();
    await expect(client.markAllNotificationsRead()).resolves.toBeUndefined();
  });

  it('fetches README content', async () => {
    const client = createClient();
    const readme = await client.getReadme('demo-user', 'demo-repo');
    expect(readme).toContain('Demo Repository');
  });

  it('fetches repository detail', async () => {
    const client = createClient();
    const detail = await client.getRepoDetail('demo-user', 'demo-repo');
    expect(detail.repository.full_name).toBe(mockRepository.full_name);
    expect(detail.empty).toBe(false);
    expect(detail.branches).toContain('main');
    expect(detail.recentCommits).toHaveLength(1);
  });

  it('fetches branch commits', async () => {
    const client = createClient();
    const commits = await client.getRepoBranchCommits('demo-user', 'demo-repo', 'main');
    expect(commits).toHaveLength(1);
    expect(commits[0].sha).toBe('abc123');
  });

  it('fetches repository contents', async () => {
    const client = createClient();
    const contents = await client.getRepoContents('demo-user', 'demo-repo', '');
    expect(contents).toHaveLength(mockRootContents.length);
    expect(contents[0].name).toBe(mockRootContents[0].name);
  });

  it('fetches nested repository contents', async () => {
    const client = createClient();
    const contents = await client.getRepoContents('demo-user', 'demo-repo', 'src');
    expect(contents).toHaveLength(2);
    expect(contents[0].name).toBe('index.ts');
  });

  it('fetches file content', async () => {
    const client = createClient();
    const content = await client.getFileContent('demo-user', 'demo-repo', 'README.md', 'main');
    expect(content).toContain('Demo Repository');
  });

  it('serves placeholder content for paths without a fixture, echoing the requested ref', async () => {
    const client = createClient();
    const content = await client.getFileContent('demo-user', 'demo-repo', 'docs/guide.md', 'dev');
    expect(content).toContain('docs/guide.md');
    expect(content).toContain('ref: dev');
  });

  it('fetches repository branches', async () => {
    const client = createClient();
    const branches = await client.getRepoBranches('demo-user', 'demo-repo');
    expect(branches).toHaveLength(2);
    expect(branches[0].name).toBe('main');
  });

  it('fetches repository tags', async () => {
    const client = createClient();
    const tags = await client.getRepoTags('demo-user', 'demo-repo');
    expect(tags).toHaveLength(1);
    expect(tags[0].name).toBe('v1.0.0');
  });

  it('fetches repository releases', async () => {
    const client = createClient();
    const releases = await client.getRepoReleases('demo-user', 'demo-repo');
    expect(releases).toHaveLength(1);
    expect(releases[0].tag_name).toBe('v2.0.0');
    // The release carries an attachment so the delete flow is walkthrough-able.
    expect(releases[0].assets).toHaveLength(1);
  });

  it('fetches repository issues', async () => {
    const client = createClient();
    const issues = await client.getRepoIssues('demo-user', 'demo-repo', 'open');
    expect(issues).toHaveLength(mockIssues.length);
    expect(issues[0].title).toBe(mockIssues[0].title);
  });

  it('fetches repository pull requests', async () => {
    const client = createClient();
    const pulls = await client.getRepoPullRequests('demo-user', 'demo-repo', 'open');
    expect(pulls).toHaveLength(mockPullRequests.length);
    expect(pulls[0].title).toBe(mockPullRequests[0].title);
  });

  it('paginates repository issues past the server default page size', async () => {
    const client = createClient();
    const requestedPages: number[] = [];
    const total = 120;
    mockServer.use(
      http.get('https://*/api/v1/repos/:owner/:repo/issues', ({ request }) => {
        const url = new URL(request.url);
        const page = Number(url.searchParams.get('page') ?? '1');
        requestedPages.push(page);
        const start = (page - 1) * 50;
        const items = Array.from({ length: Math.max(0, Math.min(50, total - start)) }, (_, i) => ({
          ...mockIssues[0],
          id: start + i + 1,
          number: start + i + 1,
        }));
        return HttpResponse.json(items);
      }),
    );
    const issues = await client.getRepoIssues('demo-user', 'demo-repo', 'open');
    expect(issues).toHaveLength(total);
    expect(issues[total - 1].number).toBe(total);
    expect(requestedPages).toEqual([1, 2, 3]);
  });

  it('paginates repository pull requests past the server default page size', async () => {
    const client = createClient();
    const requestedPages: number[] = [];
    const total = 60;
    mockServer.use(
      http.get('https://*/api/v1/repos/:owner/:repo/pulls', ({ request }) => {
        const url = new URL(request.url);
        const page = Number(url.searchParams.get('page') ?? '1');
        requestedPages.push(page);
        const start = (page - 1) * 50;
        const items = Array.from({ length: Math.max(0, Math.min(50, total - start)) }, (_, i) => ({
          ...mockPullRequests[0],
          id: start + i + 1,
          number: start + i + 1,
        }));
        return HttpResponse.json(items);
      }),
    );
    const pulls = await client.getRepoPullRequests('demo-user', 'demo-repo', 'open');
    expect(pulls).toHaveLength(total);
    expect(requestedPages).toEqual([1, 2]);
  });

  it('passes the trimmed search query to the repository issues endpoint', async () => {
    const client = createClient();
    let receivedQuery: string | null = null;
    let receivedType: string | null = null;
    mockServer.use(
      http.get('https://*/api/v1/repos/:owner/:repo/issues', ({ request }) => {
        const url = new URL(request.url);
        receivedQuery = url.searchParams.get('q');
        receivedType = url.searchParams.get('type');
        return HttpResponse.json([]);
      }),
    );
    const issues = await client.getRepoIssues('demo-user', 'demo-repo', 'open', '  bug  ');
    expect(issues).toEqual([]);
    expect(receivedQuery).toBe('bug');
    expect(receivedType).toBe('issues');
  });

  it('omits the search query when it is empty', async () => {
    const client = createClient();
    let receivedQuery: string | null = null;
    mockServer.use(
      http.get('https://*/api/v1/repos/:owner/:repo/issues', ({ request }) => {
        receivedQuery = new URL(request.url).searchParams.get('q');
        return HttpResponse.json([]);
      }),
    );
    await client.getRepoIssues('demo-user', 'demo-repo', 'open', '   ');
    expect(receivedQuery).toBeNull();
  });

  it('searches repository pull requests via the issues endpoint', async () => {
    const client = createClient();
    let receivedQuery: string | null = null;
    let receivedType: string | null = null;
    mockServer.use(
      http.get('https://*/api/v1/repos/:owner/:repo/issues', ({ request }) => {
        const url = new URL(request.url);
        receivedQuery = url.searchParams.get('q');
        receivedType = url.searchParams.get('type');
        return HttpResponse.json([]);
      }),
    );
    const pulls = await client.getRepoPullRequests('demo-user', 'demo-repo', 'open', 'dark mode');
    expect(pulls).toEqual([]);
    expect(receivedQuery).toBe('dark mode');
    expect(receivedType).toBe('pulls');
  });

  it('fetches issue detail', async () => {
    const client = createClient();
    const issue = await client.getIssueDetail('demo-user', 'demo-repo', 1);
    expect(issue.number).toBe(mockIssueDetail.number);
    expect(issue.title).toBe(mockIssueDetail.title);
  });

  describe('mock server fidelity', () => {
    it('filters repository issues by the q query', async () => {
      const client = createClient();
      // 'login' appears in mockIssue's title and body.
      const matches = await client.getRepoIssues('demo-user', 'demo-repo', 'all', 'login');
      expect(matches).toHaveLength(1);
      const misses = await client.getRepoIssues('demo-user', 'demo-repo', 'all', 'no-such-keyword');
      expect(misses).toEqual([]);
    });

    it('returns pull requests from the issues endpoint when type=pulls', async () => {
      const client = createClient();
      // getRepoPullRequests with a query goes through the issues endpoint with type=pulls.
      const pulls = await client.getRepoPullRequests('demo-user', 'demo-repo', 'all', 'dark mode');
      expect(pulls).toHaveLength(1);
      expect(pulls[0].title).toBe(mockPullRequests[0].title);
    });

    it('reflects issue edits in subsequent detail and list fetches', async () => {
      const client = createClient();
      await client.editIssue('demo-user', 'demo-repo', 1, { state: 'closed' } as unknown as EditIssueOption);
      const detail = await client.getIssueDetail('demo-user', 'demo-repo', 1);
      expect(detail.state).toBe('closed');
      expect(await client.getRepoIssues('demo-user', 'demo-repo', 'open')).toHaveLength(0);
      expect(await client.getRepoIssues('demo-user', 'demo-repo', 'closed')).toHaveLength(1);
    });

    it('reflects pull request edits in subsequent detail and list fetches', async () => {
      const client = createClient();
      await client.editPullRequest('demo-user', 'demo-repo', 2, {
        title: 'Renamed PR',
      } as unknown as EditPullRequestOption);
      const detail = await client.getPullRequestDetail('demo-user', 'demo-repo', 2);
      expect(detail.title).toBe('Renamed PR');
      const pulls = await client.getRepoPullRequests('demo-user', 'demo-repo', 'open');
      expect(pulls[0].title).toBe('Renamed PR');
    });

    it('resolves the repository detail for the requested repo', async () => {
      const client = createClient();
      const detail = await client.getRepoDetail('demo-user', 'another-repo');
      expect(detail.repository.full_name).toBe(mockRepository2.full_name);
    });
  });

  it('fetches pull request detail', async () => {
    const client = createClient();
    const pr = await client.getPullRequestDetail('demo-user', 'demo-repo', 2);
    expect(pr.number).toBe(mockPullRequestDetail.number);
    expect(pr.title).toBe(mockPullRequestDetail.title);
    expect(pr.mergeable).toBe(true);
  });

  it('clears the required-approvals merge blocker once an official approval exists', async () => {
    const client = createClient();
    // Default mocks: only a COMMENTED review, so the approval requirement is unmet.
    let pr = await client.getPullRequestDetail('demo-user', 'demo-repo', 2);
    expect(pr.mergeBlockers?.some((blocker) => blocker.type === 'no_permission')).toBe(false);
    expect(pr.mergeBlockers?.some((blocker) => blocker.type === 'required_approvals')).toBe(true);

    // With an official APPROVED review the requirement is satisfied.
    mockServer.use(
      http.get('https://*/api/v1/repos/:owner/:repo/pulls/:index/reviews', () =>
        HttpResponse.json([{ ...mockPullReview, state: 'APPROVED', official: true }]),
      ),
    );
    pr = await client.getPullRequestDetail('demo-user', 'demo-repo', 2);
    expect(pr.mergeBlockers?.some((blocker) => blocker.type === 'required_approvals')).toBe(false);
  });

  it('does not report a no_permission blocker when the permissions are unknown', async () => {
    const client = createClient();
    // The best-effort repo enrichment probe fails (offline / 5xx / timeout).
    mockServer.use(http.get('https://*/api/v1/repos/:owner/:repo', () => new HttpResponse(null, { status: 503 })));

    const pr = await client.getPullRequestDetail('demo-user', 'demo-repo', 2);

    // Unknown permissions must not be mistaken for "denied": the webview
    // disables merging for any blocker, so a transient failure would tell the
    // user they may not merge.
    expect(pr.repoPermissions).toBeUndefined();
    expect(pr.mergeBlockers?.some((blocker) => blocker.type === 'no_permission')).toBe(false);
  });

  it('reports branch protection as unknown for a non-admin instead of assuming none', async () => {
    const client = createClient();
    const protectionRequests: string[] = [];
    mockServer.use(
      http.get('https://*/api/v1/repos/:owner/:repo', () =>
        HttpResponse.json({ ...mockRepository, permissions: { admin: false, push: true, pull: true } }),
      ),
      http.get('https://*/api/v1/repos/:owner/:repo/branch_protections/:name', ({ request }) => {
        protectionRequests.push(request.url);
        return new HttpResponse(null, { status: 403 });
      }),
    );

    const pr = await client.getPullRequestDetail('demo-user', 'demo-repo', 2);

    // The endpoint is admin-only: asking would only ever 403, and treating that
    // as "no rules" hides the approval/status requirements from the user.
    expect(protectionRequests).toEqual([]);
    expect(pr.protectionUnknown).toBe(true);
    expect(pr.mergeBlockers?.some((blocker) => blocker.type === 'required_approvals')).toBe(false);
    expect(pr.mergeBlockers?.some((blocker) => blocker.type === 'no_permission')).toBe(false);
  });

  it('treats a missing branch protection as a known answer for an admin', async () => {
    const client = createClient();
    mockServer.use(
      http.get(
        'https://*/api/v1/repos/:owner/:repo/branch_protections/:name',
        () => new HttpResponse(null, { status: 404 }),
      ),
    );

    const pr = await client.getPullRequestDetail('demo-user', 'demo-repo', 2);

    // 404 means the branch has no protection rules; that is not "unknown".
    expect(pr.protectionUnknown).toBe(false);
  });

  it('reports branch protection as unknown when the admin request fails', async () => {
    const client = createClient();
    mockServer.use(
      http.get(
        'https://*/api/v1/repos/:owner/:repo/branch_protections/:name',
        () => new HttpResponse(null, { status: 500 }),
      ),
    );

    const pr = await client.getPullRequestDetail('demo-user', 'demo-repo', 2);

    expect(pr.protectionUnknown).toBe(true);
    expect(pr.mergeBlockers?.some((blocker) => blocker.type === 'required_approvals')).toBe(false);
  });

  it('fetches action runs', async () => {
    const client = createClient();
    const runs = await client.listActionRuns('demo-user', 'demo-repo');
    // The fixture holds more runs than one page, so the first page is full and
    // the total tells the view another page exists.
    expect(runs.workflow_runs).toHaveLength(30);
    expect(runs.workflow_runs?.[0]?.id).toBe(mockActionRun.id);
    expect(runs.total_count).toBe(35);
  });

  it('renders markdown', async () => {
    const client = createClient();
    const html = await client.renderMarkdown('hello **world**', 'markdown');
    expect(html).toContain('<p>hello <strong>world</strong></p>');
  });

  it('rewrites API URLs when server origin differs from configured origin', async () => {
    const client = new ForgejoClient('https://configured.example.com', 'mock-token', undefined, true);
    const detail = await client.getRepoDetail('demo-user', 'demo-repo');
    // Detection ignores avatar_url (external avatar hosts would dominate the
    // count); the repository html_url carries the real server origin.
    expect(detail.repository.html_url).toBe('https://configured.example.com/demo-user/demo-repo');
  });

  describe('Actions', () => {
    it('fetches an action run', async () => {
      const client = createClient();
      const run = await client.getActionRun('demo-user', 'demo-repo', 42);
      expect(run.id).toBe(mockActionRun.id);
    });

    it('fetches action run jobs', async () => {
      const client = createClient();
      const jobs = await client.getActionRunJobs('demo-user', 'demo-repo', 42);
      expect(jobs).toHaveLength(1);
      expect(jobs[0].id).toBe(mockActionRunJob.id);
    });

    it('fetches action run artifacts', async () => {
      const client = createClient();
      const artifacts = await client.getActionRunArtifacts('demo-user', 'demo-repo', 42);
      expect(artifacts).toHaveLength(1);
      expect(artifacts[0].id).toBe(mockActionArtifact.id);
    });

    it('fetches action job log', async () => {
      const client = createClient();
      const log = await client.getActionJobLog('demo-user', 'demo-repo', 101);
      expect(log).toContain('build log output');
    });

    it('dispatches a workflow', async () => {
      const client = createClient();
      const result = await client.dispatchWorkflow('demo-user', 'demo-repo', 'ci.yml', 'main');
      expect(result).toBeDefined();
      expect(result?.id).toBeDefined();
    });

    it('returns undefined when dispatch is answered 204 (no return_run_info support)', async () => {
      const client = createClient();
      mockServer.use(
        http.post(
          'https://*/api/v1/repos/:owner/:repo/actions/workflows/:workflowfilename/dispatches',
          () => new HttpResponse(null, { status: 204 }),
        ),
      );
      const result = await client.dispatchWorkflow('demo-user', 'demo-repo', 'ci.yml', 'main');
      expect(result).toBeUndefined();
    });

    it('cancels an action run', async () => {
      const client = createClient();
      await expect(client.cancelActionRun('demo-user', 'demo-repo', 42)).resolves.toBeUndefined();
    });

    it('fetches the server version', async () => {
      const client = createClient();
      await expect(client.getServerVersion()).resolves.toBe(MOCK_SERVER_VERSION);
    });

    it('rejects Actions calls with a clear message on servers older than 1.19', async () => {
      setServerVersion('https://forgejo.example.com', '1.18.0');
      try {
        const client = createClient();
        // listActionRuns is not async, so the gate throws synchronously.
        expect(() => client.listActionRuns('demo-user', 'demo-repo')).toThrow(/requires Forgejo .* or newer/);
      } finally {
        clearServerVersions();
      }
    });

    it('streams an action artifact to disk', async () => {
      const client = createClient();
      const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'artifact-test-'));
      try {
        const target = path.join(dir, 'artifact.zip');
        const chunks: number[] = [];
        const written = await client.downloadActionArtifactToFile('demo-user', 'demo-repo', 7, target, (bytes) =>
          chunks.push(bytes),
        );
        expect(written).toBe(3);
        expect(await fs.promises.readFile(target)).toEqual(Buffer.from([1, 2, 3]));
        // No partial file is left behind after a successful rename.
        await expect(fs.promises.access(`${target}.part`)).rejects.toThrow();
        // The progress callback fired at least once with a cumulative count.
        expect(chunks.length).toBeGreaterThan(0);
        expect(chunks[chunks.length - 1]).toBe(3);
      } finally {
        await fs.promises.rm(dir, { recursive: true, force: true });
      }
    });

    it('reassembles a chunked artifact body in order', async () => {
      const client = createClient();
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array([1, 2]));
          controller.enqueue(new Uint8Array([3, 4, 5]));
          controller.enqueue(new Uint8Array([6]));
          controller.close();
        },
      });
      mockServer.use(
        http.get(
          'https://*/api/v1/repos/:owner/:repo/actions/artifacts/:artifact_id/zip',
          () => new HttpResponse(stream, { status: 200, headers: { 'Content-Type': 'application/zip' } }),
        ),
      );
      const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'artifact-test-'));
      try {
        const target = path.join(dir, 'chunked.zip');
        const written = await client.downloadActionArtifactToFile('demo-user', 'demo-repo', 7, target);
        expect(written).toBe(6);
        expect(await fs.promises.readFile(target)).toEqual(Buffer.from([1, 2, 3, 4, 5, 6]));
      } finally {
        await fs.promises.rm(dir, { recursive: true, force: true });
      }
    });

    it('removes the partial file when the artifact download fails', async () => {
      const client = createClient();
      mockServer.use(
        http.get(
          'https://*/api/v1/repos/:owner/:repo/actions/artifacts/:artifact_id/zip',
          () => new HttpResponse(null, { status: 404 }),
        ),
      );
      const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'artifact-test-'));
      try {
        const target = path.join(dir, 'missing.zip');
        await expect(client.downloadActionArtifactToFile('demo-user', 'demo-repo', 7, target)).rejects.toThrow();
        await expect(fs.promises.access(target)).rejects.toThrow();
        await expect(fs.promises.access(`${target}.part`)).rejects.toThrow();
      } finally {
        await fs.promises.rm(dir, { recursive: true, force: true });
      }
    });

    it('deletes an action run', async () => {
      const client = createClient();
      await expect(client.deleteActionRun('demo-user', 'demo-repo', 42)).resolves.toBeUndefined();
    });
  });

  describe('File history and search', () => {
    it('fetches file history', async () => {
      const client = createClient();
      const commits = await client.getFileHistory('demo-user', 'demo-repo', 'README.md', 'main');
      expect(commits).toHaveLength(1);
      expect(commits[0].sha).toBe(mockHistoryCommit.sha);
    });

    it('searches repository files', async () => {
      const client = createClient();
      const { files, truncated } = await client.searchRepoFiles('demo-user', 'demo-repo', 'main', 'index');
      expect(files.length).toBeGreaterThan(0);
      expect(files[0].path).toContain('index');
      expect(truncated).toBe(false);
    });

    it('caches the git tree across searches on the same ref', async () => {
      const client = createClient();
      let treeRequests = 0;
      mockServer.use(
        http.get('https://*/api/v1/repos/:owner/:repo/git/trees/:sha', () => {
          treeRequests += 1;
          return HttpResponse.json({
            sha: 'tree-sha',
            tree: [
              { path: 'src/index.ts', type: 'blob' },
              { path: 'src/utils.ts', type: 'blob' },
              { path: 'README.md', type: 'blob' },
            ],
            truncated: false,
          });
        }),
      );
      const indexFiles = await client.searchRepoFiles('demo-user', 'demo-repo', 'main', 'index');
      const utilsFiles = await client.searchRepoFiles('demo-user', 'demo-repo', 'main', 'utils');
      expect(indexFiles.files.map((f) => f.path)).toEqual(['src/index.ts']);
      expect(utilsFiles.files.map((f) => f.path)).toEqual(['src/utils.ts']);
      expect(treeRequests).toBe(1);
    });

    it('shares the git tree cache across client instances of the same account', async () => {
      let treeRequests = 0;
      mockServer.use(
        http.get('https://*/api/v1/repos/:owner/:repo/git/trees/:sha', () => {
          treeRequests += 1;
          return HttpResponse.json({
            sha: 'tree-sha',
            tree: [{ path: 'src/index.ts', type: 'blob' }],
            truncated: false,
          });
        }),
      );
      // The view provider constructs a client per message; the second client
      // must hit the shared cache instead of refetching the whole tree.
      const first = await createClient().searchRepoFiles('demo-user', 'demo-repo', 'main', 'index');
      const second = await createClient().searchRepoFiles('demo-user', 'demo-repo', 'main', 'index');
      expect(first.files.map((f) => f.path)).toEqual(['src/index.ts']);
      expect(second.files.map((f) => f.path)).toEqual(['src/index.ts']);
      expect(treeRequests).toBe(1);
    });

    it('does not share the tree cache between different tokens on the same origin', async () => {
      let treeRequests = 0;
      mockServer.use(
        http.get('https://*/api/v1/repos/:owner/:repo/git/trees/:sha', () => {
          treeRequests += 1;
          return HttpResponse.json({
            sha: 'tree-sha',
            tree: [{ path: 'src/index.ts', type: 'blob' }],
            truncated: false,
          });
        }),
      );
      await createClient().searchRepoFiles('demo-user', 'demo-repo', 'main', 'index');
      await new ForgejoClient('https://forgejo.example.com', 'other-token').searchRepoFiles(
        'demo-user',
        'demo-repo',
        'main',
        'index',
      );
      expect(treeRequests).toBe(2);
    });
  });

  describe('Branch, tag, and release CRUD', () => {
    it('creates a branch', async () => {
      const client = createClient();
      const branch = await client.createBranch('demo-user', 'demo-repo', {
        branch_name: 'feature/new-stuff',
      } as unknown as CreateBranchRepoOption);
      expect(branch.name).toBe('feature/new-stuff');
    });

    it('deletes a branch', async () => {
      const client = createClient();
      await expect(client.deleteBranch('demo-user', 'demo-repo', 'feature-new-stuff')).resolves.toEqual({});
    });

    it('creates a tag', async () => {
      const client = createClient();
      const tag = await client.createTag('demo-user', 'demo-repo', {
        tag_name: 'v2.0.0',
      } as unknown as CreateTagOption);
      expect(tag.name).toBe('v2.0.0');
    });

    it('deletes a tag', async () => {
      const client = createClient();
      await expect(client.deleteTag('demo-user', 'demo-repo', 'v2.0.0')).resolves.toEqual({});
    });

    it('creates a release', async () => {
      const client = createClient();
      const release = await client.createRelease('demo-user', 'demo-repo', {
        tag_name: 'v2.0.0',
        name: 'Version 2.0.0',
      } as unknown as CreateReleaseOption);
      expect(release.tag_name).toBe('v2.0.0');
      expect(release.name).toBe('Version 2.0.0');
    });

    it('edits a release', async () => {
      const client = createClient();
      const release = await client.editRelease('demo-user', 'demo-repo', 5, {
        name: 'Updated release',
      } as unknown as EditReleaseOption);
      expect(release.name).toBe('Updated release');
    });

    it('creates a release attachment', async () => {
      const client = createClient();
      const attachment = await client.createReleaseAttachment(
        'demo-user',
        'demo-repo',
        5,
        new Uint8Array([1, 2, 3]),
        'release-notes.md',
      );
      expect(attachment.uuid).toBe(mockReleaseAttachment.uuid);
    });

    it('deletes a release attachment', async () => {
      const client = createClient();
      await expect(client.deleteReleaseAttachment('demo-user', 'demo-repo', 5, 10)).resolves.toEqual({});
    });

    it('deletes a release', async () => {
      const client = createClient();
      await expect(client.deleteRelease('demo-user', 'demo-repo', 5)).resolves.toEqual({});
    });
  });

  describe('Issue detail helpers', () => {
    it('fetches repository labels', async () => {
      const client = createClient();
      const labels = await client.getRepoLabels('demo-user', 'demo-repo');
      expect(labels).toHaveLength(1);
      expect(labels[0].name).toBe(mockLabel.name);
    });

    it('fetches repository assignees', async () => {
      const client = createClient();
      const assignees = await client.getRepoAssignees('demo-user', 'demo-repo');
      expect(assignees).toContain(mockUser.login);
    });

    it('fetches repository milestones', async () => {
      const client = createClient();
      const milestones = await client.getRepoMilestones('demo-user', 'demo-repo');
      expect(milestones).toHaveLength(1);
      expect(milestones[0].title).toBe(mockMilestone.title);
    });

    it('searches mentions', async () => {
      const client = createClient();
      // 'login' matches mockIssue's title/body; the mock filters q like the real API.
      const result = await client.searchMentions('demo-user', 'demo-repo', 'login', 'all');
      expect(result.users.length).toBeGreaterThan(0);
      expect(result.issues.length).toBeGreaterThan(0);
    });

    it('fetches user preview', async () => {
      const client = createClient();
      const user = await client.getUserPreview('demo-user');
      expect(user?.login).toBe(mockUser.login);
    });

    it('fetches issue preview', async () => {
      const client = createClient();
      const issue = await client.getIssuePreview('demo-user', 'demo-repo', 1);
      expect(issue?.number).toBe(mockIssueDetail.number);
    });
  });

  describe('Issue operations', () => {
    it('creates an issue', async () => {
      const client = createClient();
      const issue = await client.createIssue('demo-user', 'demo-repo', {
        title: 'New issue',
        body: 'Issue body',
      } as unknown as CreateIssueOption);
      expect(issue.title).toBe('New issue');
      expect(issue.body).toBe('Issue body');
    });

    it('edits an issue', async () => {
      const client = createClient();
      const issue = await client.editIssue('demo-user', 'demo-repo', 1, {
        title: 'Updated issue',
      } as unknown as EditIssueOption);
      expect(issue.title).toBe('Updated issue');
    });

    it('deletes an issue', async () => {
      const client = createClient();
      await expect(client.deleteIssue('demo-user', 'demo-repo', 1)).resolves.toBeDefined();
    });

    it('replaces issue labels', async () => {
      const client = createClient();
      const labels = await client.replaceIssueLabels('demo-user', 'demo-repo', 1, [1, 2]);
      expect(labels).toHaveLength(2);
    });

    it('checks issue subscription', async () => {
      const client = createClient();
      const info = await client.checkIssueSubscription('demo-user', 'demo-repo', 1);
      expect(info.subscribed).toBe(mockWatchInfo.subscribed);
    });

    it('adds an issue subscription', async () => {
      const client = createClient();
      await expect(client.addIssueSubscription('demo-user', 'demo-repo', 1, 'other-user')).resolves.toBeDefined();
    });

    it('deletes an issue subscription', async () => {
      const client = createClient();
      await expect(client.deleteIssueSubscription('demo-user', 'demo-repo', 1, 'other-user')).resolves.toBeDefined();
    });

    it('starts an issue stopwatch', async () => {
      const client = createClient();
      await expect(client.startIssueStopwatch('demo-user', 'demo-repo', 1)).resolves.toBeDefined();
    });

    it('stops an issue stopwatch', async () => {
      const client = createClient();
      await expect(client.stopIssueStopwatch('demo-user', 'demo-repo', 1)).resolves.toBeDefined();
    });

    it('deletes an issue stopwatch', async () => {
      const client = createClient();
      await expect(client.deleteIssueStopwatch('demo-user', 'demo-repo', 1)).resolves.toBeDefined();
    });

    it('lists issue tracked times', async () => {
      const client = createClient();
      const times = await client.listIssueTrackedTimes('demo-user', 'demo-repo', 1);
      expect(times).toHaveLength(1);
      expect(times[0].id).toBe(mockTrackedTime.id);
    });

    it('adds issue time', async () => {
      const client = createClient();
      const time = await client.addIssueTime('demo-user', 'demo-repo', 1, 3600);
      expect(time.time).toBe(3600);
    });

    it('resets issue time', async () => {
      const client = createClient();
      await expect(client.resetIssueTime('demo-user', 'demo-repo', 1)).resolves.toBeDefined();
    });

    it('deletes issue time', async () => {
      const client = createClient();
      await expect(client.deleteIssueTime('demo-user', 'demo-repo', 1, 1)).resolves.toBeDefined();
    });

    it('lists issue dependencies', async () => {
      const client = createClient();
      const dependencies = await client.listIssueDependencies('demo-user', 'demo-repo', 1);
      expect(dependencies).toHaveLength(1);
    });

    it('pages through issue dependencies instead of taking one 30-row page', async () => {
      // The server pages this list (default 30, cap 50) and sends no total count, so
      // a client that passed no page/limit silently truncated issues with many blockers.
      const firstPage = Array.from({ length: 50 }, (_, i) => ({ id: i + 1, number: i + 1, title: `dep ${i + 1}` }));
      const secondPage = [{ id: 51, number: 51, title: 'dep 51' }];
      const requestedPages: string[] = [];
      mockServer.use(
        http.get('https://*/api/v1/repos/:owner/:repo/issues/:index/dependencies', ({ request }) => {
          const page = new URL(request.url).searchParams.get('page') ?? '1';
          requestedPages.push(page);
          return HttpResponse.json(page === '1' ? firstPage : secondPage);
        }),
      );
      const dependencies = await createClient().listIssueDependencies('demo-user', 'demo-repo', 1);
      expect(dependencies).toHaveLength(51);
      expect(requestedPages).toEqual(['1', '2']);
    });

    it('drops null entries from the pull request list', async () => {
      // `convert.ToAPIPullRequest` returns nil when a related row fails to load and
      // the handler appends it as-is; consumers dereference `pr.head`.
      mockServer.use(
        http.get('https://*/api/v1/repos/:owner/:repo/pulls', () =>
          HttpResponse.json([
            null,
            { id: 1, number: 1, title: 'a pull request', head: { ref: 'feature' }, base: { ref: 'main' } },
          ]),
        ),
      );
      const pulls = await createClient().getRepoPullRequests('demo-user', 'demo-repo');
      expect(pulls).toHaveLength(1);
      expect(pulls[0]?.id).toBe(1);
    });

    it('keeps paging the timeline when a page is filtered down to nothing', async () => {
      // The server drops code comments *after* taking the page, so an empty page is
      // not necessarily the end of the timeline.
      const requestedPages: string[] = [];
      mockServer.use(
        http.get('https://*/api/v1/repos/:owner/:repo/issues/:index/timeline', ({ request }) => {
          const page = new URL(request.url).searchParams.get('page') ?? '1';
          requestedPages.push(page);
          return HttpResponse.json(
            page === '1' ? [] : [{ id: 7, type: 'comment', body: 'still here', created_at: '2026-01-01T00:00:00Z' }],
          );
        }),
      );
      const comments = await createClient().getPullRequestCommentsAndTimeline('demo-user', 'demo-repo', 1);
      expect(comments).toHaveLength(1);
      // The filtered-out first page must not end the timeline: paging continues
      // (the following probe repeats what the page-2 duplicate guard needs).
      expect(requestedPages[0]).toBe('1');
      expect(requestedPages[1]).toBe('2');
      expect(requestedPages.length).toBeGreaterThan(1);
    });
    it('creates an issue dependency', async () => {
      const client = createClient();
      await expect(client.createIssueDependency('demo-user', 'demo-repo', 1, 2)).resolves.toBeDefined();
    });

    it('removes an issue dependency', async () => {
      const client = createClient();
      await expect(client.removeIssueDependency('demo-user', 'demo-repo', 1, 2)).resolves.toBeDefined();
    });

    it('fetches issue reactions', async () => {
      const client = createClient();
      const reactions = await client.getIssueReactions('demo-user', 'demo-repo', 1);
      expect(reactions).toHaveLength(1);
      expect(reactions[0].content).toBe(mockReaction.content);
    });

    it('adds an issue reaction', async () => {
      const client = createClient();
      const reaction = await client.addIssueReaction('demo-user', 'demo-repo', 1, 'rocket');
      expect(reaction.content).toBe('rocket');
    });

    it('removes an issue reaction', async () => {
      const client = createClient();
      await expect(client.removeIssueReaction('demo-user', 'demo-repo', 1, 'rocket')).resolves.toBeDefined();
    });

    it('fetches comment reactions', async () => {
      const client = createClient();
      const reactions = await client.getCommentReactions('demo-user', 'demo-repo', 50);
      expect(reactions).toHaveLength(1);
    });

    it('adds a comment reaction', async () => {
      const client = createClient();
      const reaction = await client.addCommentReaction('demo-user', 'demo-repo', 50, 'rocket');
      expect(reaction.content).toBe('rocket');
    });

    it('removes a comment reaction', async () => {
      const client = createClient();
      await expect(client.removeCommentReaction('demo-user', 'demo-repo', 50, 'rocket')).resolves.toBeDefined();
    });

    it('creates an issue attachment', async () => {
      const client = createClient();
      const attachment = await client.createIssueAttachment(
        'demo-user',
        'demo-repo',
        1,
        new Uint8Array([1, 2, 3]),
        'screenshot.png',
      );
      expect(attachment.uuid).toBeDefined();
    });

    it('deletes an issue attachment', async () => {
      const client = createClient();
      await expect(client.deleteIssueAttachment('demo-user', 'demo-repo', 1, 20)).resolves.toEqual({});
    });
  });

  describe('Pull request operations', () => {
    it('creates a pull request', async () => {
      const client = createClient();
      const pr = await client.createPullRequest('demo-user', 'demo-repo', {
        title: 'New PR',
        body: 'PR body',
        head: 'feature',
        base: 'main',
      } as unknown as CreatePullRequestOption);
      expect(pr.title).toBe('New PR');
    });

    it('edits a pull request', async () => {
      const client = createClient();
      const pr = await client.editPullRequest('demo-user', 'demo-repo', 2, {
        title: 'Updated PR',
      } as unknown as EditPullRequestOption);
      expect(pr.title).toBe('Updated PR');
    });

    it('fetches pull request files', async () => {
      const client = createClient();
      const files = await client.getPullRequestFiles('demo-user', 'demo-repo', 2);
      expect(files.length).toBeGreaterThan(0);
      expect(files[0].filename).toBeDefined();
    });

    it('fails the changed-files fetch for broken-repo (walkthrough failure switch)', async () => {
      const client = createClient();
      await expect(client.getPullRequestFiles('demo-user', mockRepositoryFail.name, 2)).rejects.toThrow(/500/);
    });

    it('normalizes the deleted file status to removed', async () => {
      const client = createClient();
      mockServer.use(
        http.get('https://*/api/v1/repos/:owner/:repo/pulls/:index/files', ({ request }) => {
          const page = Number(new URL(request.url).searchParams.get('page')) || 1;
          return HttpResponse.json(
            page > 1
              ? []
              : [
                  { filename: 'gone.ts', status: 'deleted' },
                  { filename: 'kept.ts', status: 'modified' },
                ],
          );
        }),
      );
      const files = await client.getPullRequestFiles('demo-user', 'demo-repo', 2);
      expect(files.map((file) => file.status)).toEqual(['removed', 'modified']);
    });

    it('fetches pull request files from compare', async () => {
      const client = createClient();
      const files = await client.getPullRequestFilesFromCompare('demo-user', 'demo-repo', 'base', 'head');
      expect(files.length).toBeGreaterThan(0);
    });

    it('does not fabricate previous_filename for compare-based renames', async () => {
      const client = createClient();
      // The real /compare endpoint has no previous_filename field and reports
      // a rename as an unrelated removed+added pair; even if a server sent the
      // field, the client must not pass it through as if it were linked.
      mockServer.use(
        http.get('https://*/api/v1/repos/:owner/:repo/compare/:basehead', () =>
          HttpResponse.json({
            total_commits: 1,
            commits: [mockPullRequestCommit],
            files: [
              { filename: 'src/old-name.ts', status: 'removed' },
              { filename: 'src/new-name.ts', status: 'added', previous_filename: 'src/old-name.ts' },
            ],
          }),
        ),
      );
      const files = await client.getPullRequestFilesFromCompare('demo-user', 'demo-repo', 'base', 'head');
      expect(files.map((file) => [file.filename, file.status])).toEqual([
        ['src/old-name.ts', 'removed'],
        ['src/new-name.ts', 'added'],
      ]);
      expect(files.every((file) => file.previous_filename === undefined)).toBe(true);
    });

    it('keeps previous_filename from the pull-request files endpoint', async () => {
      const client = createClient();
      // /pulls/{index}/files does return previous_filename; only the compare
      // path is unable to supply it.
      mockServer.use(
        http.get('https://*/api/v1/repos/:owner/:repo/pulls/:index/files', ({ request }) => {
          const page = Number(new URL(request.url).searchParams.get('page')) || 1;
          return HttpResponse.json(
            page > 1 ? [] : [{ filename: 'src/new-name.ts', status: 'renamed', previous_filename: 'src/old-name.ts' }],
          );
        }),
      );
      const files = await client.getPullRequestFiles('demo-user', 'demo-repo', 2);
      expect(files[0].status).toBe('renamed');
      expect(files[0].previous_filename).toBe('src/old-name.ts');
    });

    it('merges per-commit statuses across the compare range', async () => {
      const client = createClient();
      mockServer.use(
        http.get('https://*/api/v1/repos/:owner/:repo/compare/:basehead', () =>
          HttpResponse.json({
            total_commits: 2,
            commits: [mockPullRequestCommit],
            files: [
              { filename: 'added-then-modified.ts', status: 'added' },
              { filename: 'added-then-modified.ts', status: 'modified' },
              { filename: 'added-then-removed.ts', status: 'added' },
              { filename: 'added-then-removed.ts', status: 'removed' },
              { filename: 'removed-then-added.ts', status: 'removed' },
              { filename: 'removed-then-added.ts', status: 'added' },
              { filename: 'modified-then-removed.ts', status: 'modified' },
              { filename: 'modified-then-removed.ts', status: 'removed' },
              { filename: 'renamed-then-removed.ts', status: 'renamed', previous_filename: 'old-name.ts' },
              { filename: 'renamed-then-removed.ts', status: 'removed' },
            ],
          }),
        ),
      );
      const files = await client.getPullRequestFilesFromCompare('demo-user', 'demo-repo', 'base', 'head');
      const statuses = new Map(files.map((file) => [file.filename, file.status]));
      // Added then modified: still a new file; the base side has nothing to fetch.
      expect(statuses.get('added-then-modified.ts')).toBe('added');
      // Added then removed: nets to no change at all.
      expect(statuses.has('added-then-removed.ts')).toBe(false);
      // Removed then re-added: changed content of a file existing at both ends.
      expect(statuses.get('removed-then-added.ts')).toBe('modified');
      // Modified/renamed then removed: the file is gone at the head of the
      // range, so the head side must not be fetched.
      expect(statuses.get('modified-then-removed.ts')).toBe('removed');
      expect(statuses.get('renamed-then-removed.ts')).toBe('removed');
    });

    it('fetches pull request comments and timeline', async () => {
      const client = createClient();
      const comments = await client.getPullRequestCommentsAndTimeline('demo-user', 'demo-repo', 2);
      expect(comments).toHaveLength(1);
      expect(comments[0].id).toBe(mockTimelineComment.id);
    });

    it('skips attachment requests for comments without attachment references', async () => {
      const client = createClient();
      let assetRequests = 0;
      mockServer.use(
        // The shared fixture comment does reference an attachment (so the dev
        // host can walk through that flow), so stub one without a reference.
        http.get('https://*/api/v1/repos/:owner/:repo/issues/:index/timeline', () =>
          HttpResponse.json([{ ...mockTimelineComment, body: 'No attachment here' }]),
        ),
        http.get('https://*/api/v1/repos/:owner/:repo/issues/comments/:id/assets', () => {
          assetRequests += 1;
          return HttpResponse.json([mockCommentAttachment]);
        }),
      );
      const comments = await client.getPullRequestCommentsAndTimeline('demo-user', 'demo-repo', 2);
      expect(comments).toHaveLength(1);
      expect((comments[0] as { assets?: unknown[] }).assets).toEqual([]);
      expect(assetRequests).toBe(0);
    });

    it('fetches attachments once for a comment referencing an attachment', async () => {
      const client = createClient();
      let assetRequests = 0;
      mockServer.use(
        http.get('https://*/api/v1/repos/:owner/:repo/issues/:index/timeline', ({ request }) => {
          const page = Number(new URL(request.url).searchParams.get('page')) || 1;
          return HttpResponse.json(
            page > 1
              ? []
              : [
                  {
                    ...mockTimelineComment,
                    body: 'See ![log](/attachments/123e4567-e89b-42d3-a456-426614174000)',
                  },
                ],
          );
        }),
        http.get('https://*/api/v1/repos/:owner/:repo/issues/comments/:id/assets', () => {
          assetRequests += 1;
          return HttpResponse.json([mockCommentAttachment]);
        }),
      );
      const comments = await client.getPullRequestCommentsAndTimeline('demo-user', 'demo-repo', 2);
      expect(comments).toHaveLength(1);
      const assets = (comments[0] as { assets?: { uuid?: string }[] }).assets;
      expect(assets).toHaveLength(1);
      expect(assets?.[0].uuid).toBe(mockCommentAttachment.uuid);
      expect(assetRequests).toBe(1);
    });

    it('fetches pull request commits', async () => {
      const client = createClient();
      const commits = await client.getPullRequestCommits('demo-user', 'demo-repo', 2);
      expect(commits).toHaveLength(1);
      expect(commits[0].sha).toBe(mockPullRequestCommit.sha);
    });

    it('merges a pull request', async () => {
      const client = createClient();
      await expect(client.mergePullRequest('demo-user', 'demo-repo', 2, 'merge')).resolves.toEqual({});
    });

    it('fetches pull request diff', async () => {
      const client = createClient();
      const diff = await client.getPullRequestDiff('demo-user', 'demo-repo', 2);
      expect(diff).toBe(mockPullRequestDiff);
    });

    it('lists pull reviews', async () => {
      const client = createClient();
      const reviews = await client.listPullReviews('demo-user', 'demo-repo', 2);
      expect(reviews).toHaveLength(1);
      expect(reviews[0].id).toBe(mockPullReview.id);
    });

    it('fetches pull review comments', async () => {
      const client = createClient();
      const comments = await client.getPullReviewComments('demo-user', 'demo-repo', 2, 100);
      expect(comments).toHaveLength(1);
      expect(comments[0].id).toBe(mockPullReviewComment.id);
    });

    it('creates a pull review with comment', async () => {
      const client = createClient();
      const review = await client.createPullReviewWithComment('demo-user', 'demo-repo', 2, {
        path: 'src/index.ts',
        body: 'Looks good',
      } as unknown as CreatePullReviewComment);
      expect(review.id).toBe(mockPullReview.id);
    });

    it('creates a pending pull review', async () => {
      const client = createClient();
      const review = await client.createPendingPullReview('demo-user', 'demo-repo', 2, {
        path: 'src/index.ts',
        body: 'Nitpick',
      } as unknown as CreatePullReviewComment);
      expect(review.id).toBe(mockPullReview.id);
    });

    it('adds a pull review comment', async () => {
      const client = createClient();
      await client.createPendingPullReview('demo-user', 'demo-repo', 2, {
        path: 'src/index.ts',
        body: 'Nitpick',
      } as unknown as CreatePullReviewComment);
      const comment = await client.addPullReviewComment('demo-user', 'demo-repo', 2, 100, {
        path: 'src/index.ts',
        body: 'Nitpick',
      } as unknown as CreatePullReviewComment);
      expect(comment.body).toBe('Nitpick');
    });

    it('rejects adding a comment to a non-pending review', async () => {
      const client = createClient();
      await expect(
        client.addPullReviewComment('demo-user', 'demo-repo', 2, 100, {
          path: 'src/index.ts',
          body: 'Nitpick',
        } as unknown as CreatePullReviewComment),
      ).rejects.toThrow();
    });

    it('submits a pull review', async () => {
      const client = createClient();
      await client.createPendingPullReview('demo-user', 'demo-repo', 2, {
        path: 'src/index.ts',
        body: 'Nitpick',
      } as unknown as CreatePullReviewComment);
      const review = await client.submitPullReview('demo-user', 'demo-repo', 2, 100, 'APPROVED');
      expect(review.id).toBe(mockPullReview.id);
    });

    it('rejects submitting a non-pending review', async () => {
      const client = createClient();
      await expect(client.submitPullReview('demo-user', 'demo-repo', 2, 100, 'APPROVED')).rejects.toThrow();
    });

    it('deletes a pull review', async () => {
      const client = createClient();
      await expect(client.deletePullReview('demo-user', 'demo-repo', 2, 100)).resolves.toBeUndefined();
    });

    it('deletes a pull review comment', async () => {
      const client = createClient();
      await expect(client.deletePullReviewComment('demo-user', 'demo-repo', 2, 100, 200)).resolves.toBeUndefined();
    });
  });

  describe('Comments and attachments', () => {
    it('creates an issue comment', async () => {
      const client = createClient();
      const comment = await client.createIssueComment('demo-user', 'demo-repo', 1, 'Thanks');
      expect(comment.body).toBe('Thanks');
    });

    it('edits an issue comment', async () => {
      const client = createClient();
      const comment = await client.editIssueComment('demo-user', 'demo-repo', 50, 'Updated');
      expect(comment.body).toBe('Updated');
    });

    it('deletes an issue comment', async () => {
      const client = createClient();
      await expect(client.deleteIssueComment('demo-user', 'demo-repo', 50)).resolves.toEqual({});
    });

    it('deletes an issue comment attachment', async () => {
      const client = createClient();
      await expect(client.deleteIssueCommentAttachment('demo-user', 'demo-repo', 50, 21)).resolves.toEqual({});
    });

    it('creates an issue comment attachment', async () => {
      const client = createClient();
      const attachment = await client.createIssueCommentAttachment(
        'demo-user',
        'demo-repo',
        50,
        new Uint8Array([1, 2, 3]),
        'log.txt',
      );
      expect(attachment.uuid).toBeDefined();
    });

    it('uploads only the view bytes when the file is a Uint8Array subarray', async () => {
      const client = createClient();
      let uploadedSize = -1;
      mockServer.use(
        http.post('https://*/api/v1/repos/:owner/:repo/issues/:index/assets', async ({ request }) => {
          const form = await request.formData();
          uploadedSize = (form.get('attachment') as File).size;
          return HttpResponse.json(mockIssueAttachment);
        }),
      );
      const backing = new Uint8Array([9, 9, 1, 2, 3, 9, 9]);
      const view = backing.subarray(2, 5);
      await client.createIssueAttachment('demo-user', 'demo-repo', 1, view, 'screenshot.png');
      expect(uploadedSize).toBe(3);
    });
  });

  describe('Pagination', () => {
    it('fetches all branch pages until a short page is returned', async () => {
      const client = createClient();
      const requestedPages: number[] = [];
      const requestedLimits: number[] = [];
      mockServer.use(
        http.get('https://*/api/v1/repos/:owner/:repo/branches', ({ request }) => {
          const url = new URL(request.url);
          const page = Number(url.searchParams.get('page') ?? '1');
          requestedPages.push(page);
          requestedLimits.push(Number(url.searchParams.get('limit') ?? '0'));
          const offset = (page - 1) * 50;
          const count = page === 1 ? 50 : 20;
          return HttpResponse.json(Array.from({ length: count }, (_, i) => ({ name: `branch-${offset + i}` })));
        }),
      );
      const branches = await client.getRepoBranches('demo-user', 'demo-repo');
      expect(branches).toHaveLength(70);
      expect(branches[69].name).toBe('branch-69');
      expect(requestedPages).toEqual([1, 2]);
      // Page size stays within Forgejo's default MAX_RESPONSE_ITEMS (50).
      expect(requestedLimits).toEqual([50, 50]);
    });

    it('fetches all pages of pull request commits', async () => {
      const client = createClient();
      mockServer.use(
        http.get('https://*/api/v1/repos/:owner/:repo/pulls/:index/commits', ({ request }) => {
          const page = Number(new URL(request.url).searchParams.get('page') ?? '1');
          const count = page === 1 ? 50 : 1;
          const offset = (page - 1) * 50;
          return HttpResponse.json(Array.from({ length: count }, (_, i) => ({ sha: `sha-${offset + i}` })));
        }),
      );
      const commits = await client.getPullRequestCommits('demo-user', 'demo-repo', 2);
      expect(commits).toHaveLength(51);
    });
  });

  describe('Path parameter encoding', () => {
    it('encodes slashes and hashes in branch names', async () => {
      const client = createClient();
      let requestedUrl = '';
      mockServer.use(
        http.delete('https://*/api/v1/repos/:owner/:repo/branches/:branch', ({ request }) => {
          requestedUrl = request.url;
          return new HttpResponse(null, { status: 204 });
        }),
      );
      await client.deleteBranch('demo-user', 'demo-repo', 'feature/x#1');
      expect(requestedUrl).toContain('branches/feature%2Fx%231');
    });

    it('encodes slashes in tag names', async () => {
      const client = createClient();
      let requestedUrl = '';
      mockServer.use(
        http.delete('https://*/api/v1/repos/:owner/:repo/tags/:tag', ({ request }) => {
          requestedUrl = request.url;
          return new HttpResponse(null, { status: 204 });
        }),
      );
      await client.deleteTag('demo-user', 'demo-repo', 'release/1.0');
      expect(requestedUrl).toContain('tags/release%2F1.0');
    });

    it('encodes file paths segment by segment, keeping separators', async () => {
      const client = createClient();
      let requestedUrl = '';
      mockServer.use(
        http.get('https://*/api/v1/repos/:owner/:repo/contents/*', ({ request }) => {
          requestedUrl = request.url;
          return HttpResponse.json({ content: 'aGVsbG8=' });
        }),
      );
      const content = await client.getFileContent('demo-user', 'demo-repo', 'dir/a#b?.txt', 'main');
      expect(content).toBe('hello');
      expect(requestedUrl).toContain('contents/dir/a%23b%3F.txt');
    });
  });

  describe('Raw payload limits', () => {
    it('truncates action job logs larger than 10 MB', async () => {
      const client = createClient();
      const bigLog = 'x'.repeat(10 * 1024 * 1024 + 100);
      mockServer.use(
        http.get(
          'https://*/api/v1/repos/:owner/:repo/actions/jobs/:job_id/logs',
          () => new HttpResponse(bigLog, { status: 200, headers: { 'Content-Type': 'text/plain' } }),
        ),
      );
      const log = await client.getActionJobLog('demo-user', 'demo-repo', 1);
      expect(log.length).toBeLessThan(bigLog.length);
      expect(log).toContain('(truncated: log exceeds the 10 MB limit)');
    });

    it('rejects artifact streams that exceed the defensive size cap', async () => {
      const client = createClient();
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]));
          controller.close();
        },
      });
      mockServer.use(
        http.get(
          'https://*/api/v1/repos/:owner/:repo/actions/artifacts/:artifact_id/zip',
          () => new HttpResponse(stream, { status: 200 }),
        ),
      );
      const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'artifact-test-'));
      try {
        const target = path.join(dir, 'huge.zip');
        await expect(
          client.downloadActionArtifactToFile('demo-user', 'demo-repo', 1, target, undefined, 4),
        ).rejects.toThrow(/exceeds the 2 GB size limit/);
        // The oversized download must not leave a file behind.
        await expect(fs.promises.access(target)).rejects.toThrow();
        await expect(fs.promises.access(`${target}.part`)).rejects.toThrow();
      } finally {
        await fs.promises.rm(dir, { recursive: true, force: true });
      }
    });
  });

  describe('Git tree pagination guard', () => {
    it('stops when the server keeps returning the same truncated page', async () => {
      const client = createClient();
      let requests = 0;
      mockServer.use(
        http.get('https://*/api/v1/repos/:owner/:repo/git/trees/:sha', () => {
          requests += 1;
          return HttpResponse.json({
            sha: 'tree-sha',
            tree: [{ path: 'a.ts', type: 'blob', sha: 'same-sha' }],
            truncated: true,
          });
        }),
      );
      const result = await client.searchRepoFiles('demo-user', 'demo-repo', 'main', 'a.ts');
      expect(result.files).toHaveLength(1);
      // The server kept claiming truncation without advancing: the reader stops
      // and reports that the tree may be incomplete rather than looping.
      expect(result.truncated).toBe(true);
      expect(requests).toBe(2);
    });

    it('reports truncation when the paging bound is reached', async () => {
      const client = createClient();
      let requests = 0;
      mockServer.use(
        http.get('https://*/api/v1/repos/:owner/:repo/git/trees/:sha', ({ request }) => {
          requests += 1;
          const page = Number(new URL(request.url).searchParams.get('page') ?? '1');
          // Every page is full and claims more entries until the reader gives
          // up at MAX_TREE_PAGES: the results cannot be complete.
          return HttpResponse.json({
            sha: 'tree-sha',
            tree: [{ path: `file-${page}.ts`, type: 'blob', sha: `sha-${page}` }],
            truncated: true,
          });
        }),
      );

      const result = await client.searchRepoFiles('demo-user', 'demo-repo', 'main', '.ts');

      expect(result.truncated).toBe(true);
      expect(result.files).toHaveLength(requests);
      // The bound, not the server, ends the loop.
      expect(requests).toBe(50);
    });

    it('follows pagination until the tree is no longer truncated', async () => {
      const client = createClient();
      mockServer.use(
        http.get('https://*/api/v1/repos/:owner/:repo/git/trees/:sha', ({ request }) => {
          const page = Number(new URL(request.url).searchParams.get('page') ?? '1');
          if (page === 1) {
            return HttpResponse.json({
              sha: 'tree-sha',
              tree: [{ path: 'first.ts', type: 'blob', sha: 'sha-1' }],
              truncated: true,
            });
          }
          return HttpResponse.json({
            sha: 'tree-sha',
            tree: [{ path: 'second.ts', type: 'blob', sha: 'sha-2' }],
            truncated: false,
          });
        }),
      );
      const result = await client.searchRepoFiles('demo-user', 'demo-repo', 'main', '.ts');
      expect(result.files.map((f) => f.path).sort()).toEqual(['first.ts', 'second.ts']);
      expect(result.truncated).toBe(false);
    });
  });

  describe('Debug logging', () => {
    function createDebugClient(messages: string[]): ForgejoClient {
      const logger = {
        isDebugEnabled: () => true,
        debug: (message: string) => messages.push(message),
        info: () => undefined,
        error: () => undefined,
      } as unknown as Logger;
      return new ForgejoClient('https://forgejo.example.com', 'mock-token', logger);
    }

    it('does not log raw bodies of text responses', async () => {
      const messages: string[] = [];
      const client = createDebugClient(messages);
      await client.getActionJobLog('demo-user', 'demo-repo', 1);
      expect(messages.some((m) => m.includes('build log output'))).toBe(false);
      expect(messages.some((m) => m.includes('<text> (not logged)'))).toBe(true);
    });

    it('still logs JSON response bodies', async () => {
      const messages: string[] = [];
      const client = createDebugClient(messages);
      await client.getCurrentUser();
      expect(messages.some((m) => m.startsWith('Response body:') && m.includes(mockUser.login))).toBe(true);
    });
  });

  describe('detected server origin', () => {
    function detect(client: ForgejoClient, data: unknown): string | undefined {
      return (client as unknown as { _detectServerOrigin(data: unknown): string | undefined })._detectServerOrigin(
        data,
      );
    }

    it('ignores avatar_url values so an external avatar host is not mistaken for the server origin', () => {
      const client = new ForgejoClient('https://forgejo.internal.example.com', 'mock-token');
      // Every embedded user carries an avatar on the external avatar host,
      // which would otherwise outnumber the real server origin's URLs.
      const data = {
        html_url: 'https://forgejo.public.example.com/demo-user/demo-repo',
        user: { login: 'a', avatar_url: 'https://avatar.example.com/a.png' },
        assignees: [
          { login: 'b', avatar_url: 'https://avatar.example.com/b.png' },
          { login: 'c', avatar_url: 'https://avatar.example.com/c.png' },
        ],
      };
      expect(detect(client, data)).toBe('https://forgejo.public.example.com');
    });

    it('ignores website and original_url so external hosts are not mistaken for the server origin', () => {
      const client = new ForgejoClient('https://forgejo.internal.example.com', 'mock-token');
      // External homepage/mirror-source fields outnumber the real server URLs;
      // if they were counted, the external host would win and its links would
      // be rewritten into broken instance URLs.
      const data = {
        html_url: 'https://forgejo.public.example.com/demo-user/demo-repo',
        clone_url: 'https://forgejo.public.example.com/demo-user/demo-repo.git',
        website: 'https://external.example.net/home',
        original_url: 'https://external.example.net/mirror-source.git',
        owner: { login: 'a', website: 'https://external.example.net/user' },
      };
      expect(detect(client, data)).toBe('https://forgejo.public.example.com');
    });
  });

  describe('auth error fix guidance', () => {
    beforeEach(() => {
      vi.mocked(vscode.window.showErrorMessage)
        .mockReset()
        .mockResolvedValue(undefined as never);
      vi.mocked(vscode.env.openExternal).mockClear();
      vi.mocked(vscode.commands.executeCommand).mockClear();
    });

    function mockAuthFailure(status: number, body: Record<string, unknown>) {
      mockServer.use(http.get('https://*/api/v1/user', () => HttpResponse.json(body, { status })));
    }

    it('shows token fix guidance with action buttons on 401', async () => {
      mockAuthFailure(401, { message: 'unauthorized' });
      const client = new ForgejoClient('https://auth-expired.example.com', 'bad-token');

      await expect(client.getCurrentUser()).rejects.toThrow(ApiError);

      expect(vscode.window.showErrorMessage).toHaveBeenCalledTimes(1);
      const [message, ...buttons] = vi.mocked(vscode.window.showErrorMessage).mock.calls[0];
      expect(String(message)).toContain('Invalid or expired credentials');
      expect(buttons).toContain('Open Token Settings');
      expect(buttons).toContain('Open Settings');
    });

    it('dedupes the 401 toast per instance per session', async () => {
      mockAuthFailure(401, { message: 'unauthorized' });
      const client = new ForgejoClient('https://auth-dedupe.example.com', 'bad-token');

      await expect(client.getCurrentUser()).rejects.toThrow();
      await expect(client.getCurrentUser()).rejects.toThrow();

      expect(vscode.window.showErrorMessage).toHaveBeenCalledTimes(1);
    });

    it('opens the instance token settings page from the toast button', async () => {
      mockAuthFailure(401, { message: 'unauthorized' });
      vi.mocked(vscode.window.showErrorMessage).mockResolvedValue('Open Token Settings' as never);
      const client = new ForgejoClient('https://auth-action.example.com', 'bad-token');

      await expect(client.getCurrentUser()).rejects.toThrow();
      // The button handler runs in a .then callback; let it settle.
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(vscode.env.openExternal).toHaveBeenCalledTimes(1);
      const uri = vi.mocked(vscode.env.openExternal).mock.calls[0][0] as { fsPath: string };
      expect(uri.fsPath).toBe('https://auth-action.example.com/user/settings/applications');
    });

    it('opens the extension settings view from the toast button', async () => {
      mockAuthFailure(401, { message: 'unauthorized' });
      vi.mocked(vscode.window.showErrorMessage).mockResolvedValue('Open Settings' as never);
      const client = new ForgejoClient('https://auth-settings.example.com', 'bad-token');

      await expect(client.getCurrentUser()).rejects.toThrow();
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(vscode.commands.executeCommand).toHaveBeenCalledWith('forgejoToolkit.openSettings');
    });

    it('surfaces the required scope named in the 403 body', async () => {
      mockAuthFailure(403, { message: 'token does not have at least one of required scope(s): [write:issue]' });
      const client = new ForgejoClient('https://auth-scope.example.com', 'narrow-token');

      await expect(client.getCurrentUser()).rejects.toThrow(ApiError);

      expect(vscode.window.showErrorMessage).toHaveBeenCalledTimes(1);
      const [message, ...buttons] = vi.mocked(vscode.window.showErrorMessage).mock.calls[0];
      expect(String(message)).toContain('lacks the required scope');
      expect(String(message)).toContain('write:issue');
      expect(buttons).toContain('Open Token Settings');
      expect(buttons).toContain('Open Settings');
    });

    it('does not toast for non-scope 403 errors', async () => {
      mockAuthFailure(403, { message: 'you are not allowed to see this' });
      const client = new ForgejoClient('https://auth-other403.example.com', 'token');

      await expect(client.getCurrentUser()).rejects.toThrow();

      expect(vscode.window.showErrorMessage).not.toHaveBeenCalled();
    });
  });
});
