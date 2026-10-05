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
import {
  ForgejoClient,
  clearDetectedServerOrigins,
  clearRepoContentsCache,
  clearTreeCache,
  LIST_ITEM_LIMIT,
  MAX_SEARCH_RESULTS,
  REPO_CONTENTS_CACHE_MAX_BYTES,
  REPO_DETAIL_LIST_LIMIT,
  repoContentsCacheBytesForTest,
  setDefaultRequestDispatcher,
  treeCacheSizeForTest,
} from '../client';
import { isListTruncatedWithTotal } from '@cpf23333-forgejo-toolkit/shared/limits';
import { ApiError } from '../errors';
import { clearServerVersions, setDeclaredServerVersionResolver, setServerVersion } from '../serverVersion';
import { SERVER_VERSION_CACHE_TTL_MS, setServerVersionCacheStorage } from '../serverVersionCache';
import { makeMemoryVersionCacheStore, type MemoryVersionCacheStore } from './serverVersionCacheTestHelpers';
import { removeTempDir } from '../../__tests__/tempDir';
import type { Logger } from '../../logger';
import { startMockServer, stopMockServer, resetMockServer, mockServer } from '../../test/mocks/server';
import { MOCK_EMPTY_REPO, MOCK_SERVER_VERSION } from '../../test/mocks/handlers';
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
  mockReadmeContent,
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
    // The git-tree cache, the origin detection memo and the repo-contents memo
    // are shared across client instances; tests must not observe each other's
    // entries.
    clearTreeCache();
    clearDetectedServerOrigins();
    clearRepoContentsCache();
  });

  beforeEach(() => {
    // The shared probe cache's storage and slot are module state shared with
    // every other suite in this worker. Detach it for the whole file (the store
    // is pinned in the other suites' code, not by a setting) and reset the slot,
    // so the on-demand gate tests count their own requests and nobody else's.
    setServerVersionCacheStorage(undefined);
    clearServerVersions();
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

  describe('Authorization header', () => {
    function captureAuthorization(): () => string | null {
      let seen: string | null = null;
      mockServer.use(
        http.get('https://*/api/v1/user', ({ request }) => {
          seen = request.headers.get('authorization');
          return HttpResponse.json(mockUser);
        }),
      );
      return () => seen;
    }

    it('sends the token as the Authorization header', async () => {
      const seen = captureAuthorization();
      await createClient().getCurrentUser();
      expect(seen()).toBe('token mock-token');
    });

    it('sends no Authorization header when the token is empty (anonymous access)', async () => {
      // `Authorization: token ` with an empty credential makes some servers
      // reject the request outright instead of treating it as anonymous.
      const seen = captureAuthorization();
      await new ForgejoClient('https://forgejo.example.com', '').getCurrentUser();
      expect(seen()).toBeNull();
    });

    it('sends no Authorization header when the token is only whitespace', async () => {
      const seen = captureAuthorization();
      await new ForgejoClient('https://forgejo.example.com', '   ').getCurrentUser();
      expect(seen()).toBeNull();
    });
  });

  it('fetches user stopwatches', async () => {
    const client = createClient();
    const stopwatches = await client.getUserStopWatches();
    expect(stopwatches).toEqual([]);
  });

  it('fetches user repositories', async () => {
    const client = createClient();
    const repos = await client.getUserRepositories();
    expect(repos.items).toHaveLength(3);
    expect(repos.items[0].full_name).toBe(mockRepository.full_name);
    expect(repos.items[1].full_name).toBe(mockRepository2.full_name);
    expect(repos.items[2].full_name).toBe(mockRepositoryFail.full_name);
  });

  it('reports no total for user repositories when the server omits X-Total-Count', async () => {
    const client = createClient();
    const repos = await client.getUserRepositories();
    // The mock handlers send no total header, which is the old-server shape:
    // the caller must see "unknown" and fall back to the length heuristic.
    expect(repos.totalCount).toBeUndefined();
  });

  it('parses the X-Total-Count header of a list page', async () => {
    const client = createClient();
    mockServer.use(
      http.get('https://*/api/v1/user/repos', () =>
        HttpResponse.json([mockRepository], { headers: { 'X-Total-Count': '42' } }),
      ),
    );
    const repos = await client.getUserRepositories();
    expect(repos.items).toHaveLength(1);
    expect(repos.totalCount).toBe(42);
  });

  it('treats a non-numeric X-Total-Count header as no total', async () => {
    const client = createClient();
    mockServer.use(
      http.get('https://*/api/v1/user/repos', () =>
        HttpResponse.json([mockRepository], { headers: { 'X-Total-Count': 'many' } }),
      ),
    );
    const repos = await client.getUserRepositories();
    expect(repos.items).toHaveLength(1);
    expect(repos.totalCount).toBeUndefined();
  });

  it('treats a non-array list page body as an empty page', async () => {
    const client = createClient();
    // The shared request client answers a 204 (or an empty 200 body) with `{}`
    // rather than an array; a list page read must not spread that into a throw.
    mockServer.use(http.get('https://*/api/v1/user/repos', () => new HttpResponse(null, { status: 204 })));
    const repos = await client.getUserRepositories();
    expect(repos.items).toEqual([]);
    expect(repos.totalCount).toBeUndefined();
  });

  it('reads a 500-item list as complete when the total agrees, truncated when it does not', async () => {
    const client = createClient();
    const total = 500;
    mockServer.use(
      http.get('https://*/api/v1/repos/:owner/:repo/issues', ({ request }) => {
        const page = Number(new URL(request.url).searchParams.get('page') ?? '1');
        const start = (page - 1) * 50;
        return HttpResponse.json(
          Array.from({ length: Math.max(0, Math.min(50, total - start)) }, (_, i) => ({
            ...mockIssues[0],
            id: start + i + 1,
            number: start + i + 1,
          })),
          { headers: { 'X-Total-Count': String(total) } },
        );
      }),
    );
    const issues = await client.getRepoIssues('demo-user', 'demo-repo', 'open');
    // The core regression point: exactly LIST_ITEM_LIMIT rows whose total says
    // the list is whole must not read as truncated anymore.
    expect(issues.items).toHaveLength(500);
    expect(issues.totalCount).toBe(500);
    expect(isListTruncatedWithTotal(issues.items, issues.totalCount)).toBe(false);

    mockServer.use(
      http.get('https://*/api/v1/repos/:owner/:repo/issues', ({ request }) => {
        const page = Number(new URL(request.url).searchParams.get('page') ?? '1');
        const start = (page - 1) * 50;
        // The server holds 600 but the cap cuts the read at 500: the total now
        // proves the truncation the length alone could only suspect.
        return HttpResponse.json(
          Array.from({ length: Math.max(0, Math.min(50, 600 - start)) }, (_, i) => ({
            ...mockIssues[0],
            id: start + i + 1,
            number: start + i + 1,
          })),
          { headers: { 'X-Total-Count': '600' } },
        );
      }),
    );
    const truncated = await client.getRepoIssues('demo-user', 'demo-repo', 'open');
    expect(truncated.items).toHaveLength(500);
    expect(truncated.totalCount).toBe(600);
    expect(isListTruncatedWithTotal(truncated.items, truncated.totalCount)).toBe(true);
  });

  it('reports the rows an overshooting read returned alongside the server total', async () => {
    const client = createClient();
    // A server that clamps the page size (MAX_RESPONSE_ITEMS) makes the cap check
    // exit in the middle of a page: the read ends at 510 rows, not 500, so a cap
    // number alone would misdescribe what came back. The total is what still lets
    // a caller say exactly how much of the list it holds.
    const total = 800;
    mockServer.use(
      http.get('https://*/api/v1/repos/:owner/:repo/issues', ({ request }) => {
        const page = Number(new URL(request.url).searchParams.get('page') ?? '1');
        const start = (page - 1) * 30;
        return HttpResponse.json(
          Array.from({ length: Math.max(0, Math.min(30, total - start)) }, (_, i) => ({
            ...mockIssues[0],
            id: start + i + 1,
            number: start + i + 1,
          })),
          { headers: { 'X-Total-Count': String(total) } },
        );
      }),
    );

    const issues = await client.getRepoIssues('demo-user', 'demo-repo', 'open');

    expect(issues.items).toHaveLength(510);
    expect(issues.totalCount).toBe(800);
    expect(isListTruncatedWithTotal(issues.items, issues.totalCount)).toBe(true);
  });

  describe('total-aware list reads', () => {
    /**
     * Answers one list endpoint with `rows` and the given `X-Total-Count`,
     * paging the same way the server does (a full page of 50 followed by the
     * rest), and counts the requests so a test can tell that reading the total
     * did not add one.
     */
    function mockListPage(
      path: string,
      rows: () => unknown[],
      total: string | undefined,
      wrap?: (rows: unknown[]) => unknown,
    ): { requests: () => number } {
      let requests = 0;
      mockServer.use(
        http.get(`https://*/api/v1${path}`, ({ request }) => {
          requests += 1;
          const page = Number(new URL(request.url).searchParams.get('page') ?? '1');
          const all = rows();
          const start = (page - 1) * 50;
          const slice = all.slice(start, start + 50);
          return HttpResponse.json((wrap ? wrap(slice) : slice) as never, {
            headers: total === undefined ? {} : { 'X-Total-Count': total },
          });
        }),
      );
      return { requests: () => requests };
    }

    /**
     * The pairs to pin: each total-aware method with the array method it wraps.
     * The wrappers are what every existing caller (the webview's dispatch and
     * the review-comment controller) still uses, so they must keep answering the
     * rows themselves — the contract this table checks on every list.
     */
    const listReads: {
      label: string;
      path: string;
      row: unknown;
      wrap?: (rows: unknown[]) => unknown;
      withTotal: (client: ForgejoClient) => Promise<{ items: unknown[]; totalCount?: number }>;
      rowsOnly: (client: ForgejoClient) => Promise<unknown[]>;
    }[] = [
      {
        label: 'branches',
        path: '/repos/:owner/:repo/branches',
        row: { name: 'main' },
        withTotal: (client) => client.getRepoBranchesWithTotal('demo-user', 'demo-repo'),
        rowsOnly: (client) => client.getRepoBranches('demo-user', 'demo-repo'),
      },
      {
        label: 'tags',
        path: '/repos/:owner/:repo/tags',
        row: { name: 'v1.0.0' },
        withTotal: (client) => client.getRepoTagsWithTotal('demo-user', 'demo-repo'),
        rowsOnly: (client) => client.getRepoTags('demo-user', 'demo-repo'),
      },
      {
        label: 'releases',
        path: '/repos/:owner/:repo/releases',
        row: { name: 'v1.0.0' },
        withTotal: (client) => client.getRepoReleasesWithTotal('demo-user', 'demo-repo'),
        rowsOnly: (client) => client.getRepoReleases('demo-user', 'demo-repo'),
      },
      {
        label: 'labels',
        path: '/repos/:owner/:repo/labels',
        row: { name: 'bug' },
        withTotal: (client) => client.getRepoLabelsWithTotal('demo-user', 'demo-repo'),
        rowsOnly: (client) => client.getRepoLabels('demo-user', 'demo-repo'),
      },
      {
        label: 'milestones',
        path: '/repos/:owner/:repo/milestones',
        row: { title: 'v1.0' },
        withTotal: (client) => client.getRepoMilestonesWithTotal('demo-user', 'demo-repo'),
        rowsOnly: (client) => client.getRepoMilestones('demo-user', 'demo-repo'),
      },
      {
        label: 'pull request files',
        path: '/repos/:owner/:repo/pulls/:index/files',
        row: { filename: 'src/index.ts', status: 'modified' },
        withTotal: (client) => client.getPullRequestFilesWithTotal('demo-user', 'demo-repo', 2),
        rowsOnly: (client) => client.getPullRequestFiles('demo-user', 'demo-repo', 2),
      },
      {
        label: 'pull request commits',
        path: '/repos/:owner/:repo/pulls/:index/commits',
        row: { sha: 'abc123' },
        withTotal: (client) => client.getPullRequestCommitsWithTotal('demo-user', 'demo-repo', 2),
        rowsOnly: (client) => client.getPullRequestCommits('demo-user', 'demo-repo', 2),
      },
      {
        label: 'timeline',
        path: '/repos/:owner/:repo/issues/:index/timeline',
        row: { id: 1, body: 'looks good' },
        withTotal: (client) => client.getPullRequestCommentsAndTimelineWithTotal('demo-user', 'demo-repo', 2),
        rowsOnly: (client) => client.getPullRequestCommentsAndTimeline('demo-user', 'demo-repo', 2),
      },
      {
        label: 'pull request reviews',
        path: '/repos/:owner/:repo/pulls/:index/reviews',
        row: { id: 1, state: 'APPROVED' },
        withTotal: (client) => client.listPullReviewsWithTotal('demo-user', 'demo-repo', 2),
        rowsOnly: (client) => client.listPullReviews('demo-user', 'demo-repo', 2),
      },
      {
        label: 'file history',
        path: '/repos/:owner/:repo/commits',
        row: { sha: 'abc123', commit: { message: 'fix', author: { name: 'a', date: '2024-01-01' } } },
        withTotal: (client) => client.getFileHistoryWithTotal('demo-user', 'demo-repo', 'README.md', 'main'),
        rowsOnly: (client) => client.getFileHistory('demo-user', 'demo-repo', 'README.md', 'main'),
      },
      {
        label: 'action run artifacts',
        path: '/repos/:owner/:repo/actions/runs/:runId/artifacts',
        row: { id: 1, name: 'logs' },
        // The artifacts endpoint wraps its rows in `{ artifacts }` instead of
        // answering a bare array; the client's extractor handles that, so the
        // mock answers the same wrapped shape the server does.
        wrap: (rows) => ({ artifacts: rows }),
        withTotal: (client) => client.getActionRunArtifactsWithTotal('demo-user', 'demo-repo', 42),
        rowsOnly: (client) => client.getActionRunArtifacts('demo-user', 'demo-repo', 42),
      },
    ];

    it('surfaces the server total for every paged list method', async () => {
      for (const read of listReads) {
        resetMockServer();
        mockListPage(read.path, () => [read.row, { ...(read.row as Record<string, unknown>), id: 2 }], '7', read.wrap);
        const client = createClient();

        const page = await read.withTotal(client);

        expect(page.items, read.label).toHaveLength(2);
        // The total is what was dropped before: without it a list at the cap is
        // only "possibly" cut off, and a complete one is misreported.
        expect(page.totalCount, read.label).toBe(7);
      }
    });

    it('keeps every array-returning wrapper answering the same rows', async () => {
      for (const read of listReads) {
        resetMockServer();
        mockListPage(read.path, () => [read.row, { ...(read.row as Record<string, unknown>), id: 2 }], '2', read.wrap);
        const client = createClient();

        const rows = await read.rowsOnly(client);
        const page = await read.withTotal(client);

        expect(rows, read.label).toEqual(page.items);
        expect(rows, read.label).toHaveLength(2);
      }
    });

    it('reads an exactly-at-cap list as complete when the server total agrees', async () => {
      // The regression this closes at the client boundary: the method used to
      // hand out only the rows, so a caller could not tell 500 of 500 from 500
      // of 600. `totalCount` now carries that answer for every capped list.
      const client = createClient();
      const { requests } = mockListPage(
        '/repos/:owner/:repo/branches',
        () => Array.from({ length: LIST_ITEM_LIMIT }, (_, i) => ({ name: `branch-${i}` })),
        String(LIST_ITEM_LIMIT),
      );

      const branches = await client.getRepoBranchesWithTotal('demo-user', 'demo-repo');

      expect(branches.items).toHaveLength(LIST_ITEM_LIMIT);
      expect(branches.totalCount).toBe(LIST_ITEM_LIMIT);
      expect(isListTruncatedWithTotal(branches.items, branches.totalCount)).toBe(false);
      // Ten full pages reach the item cap, which ends the read; reading the
      // header costs no extra request.
      expect(requests()).toBe(10);
    });

    it('reports the total of a genuinely cut list', async () => {
      const client = createClient();
      mockListPage('/repos/:owner/:repo/tags', () => Array.from({ length: 600 }, (_, i) => ({ name: `v${i}` })), '600');

      const tags = await client.getRepoTagsWithTotal('demo-user', 'demo-repo');

      expect(tags.items).toHaveLength(LIST_ITEM_LIMIT);
      expect(tags.totalCount).toBe(600);
      expect(isListTruncatedWithTotal(tags.items, tags.totalCount)).toBe(true);
    });

    it('reports the rows of an overshooting read alongside the total', async () => {
      // A server that clamps the page size makes the read stop mid-page (510
      // rows for a 500-row cap), so the length alone misdescribes what came back;
      // the total still says exactly how much of the list is missing.
      const client = createClient();
      let requests = 0;
      mockServer.use(
        http.get('https://*/api/v1/repos/:owner/:repo/labels', ({ request }) => {
          requests += 1;
          const page = Number(new URL(request.url).searchParams.get('page') ?? '1');
          const start = (page - 1) * 30;
          return HttpResponse.json(
            Array.from({ length: Math.max(0, Math.min(30, 800 - start)) }, (_, i) => ({ name: `label-${start + i}` })),
            { headers: { 'X-Total-Count': '800' } },
          );
        }),
      );

      const labels = await client.getRepoLabelsWithTotal('demo-user', 'demo-repo');

      expect(labels.items).toHaveLength(510);
      expect(labels.totalCount).toBe(800);
      expect(requests).toBeGreaterThan(0);
      expect(isListTruncatedWithTotal(labels.items, labels.totalCount)).toBe(true);
    });
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
    expect(repos.items).toHaveLength(70);
    expect(repos.items[69].full_name).toBe('demo-user/repo-70');
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
    expect(repos.items).toHaveLength(50);
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
    // No keyword passed means no keyword sent: the request shape the dashboard
    // has always used is unchanged.
    expect(captured[0].get('q')).toBeNull();
    expect(captured[1].get('q')).toBeNull();
  });

  it('passes the instance-wide keyword to the server instead of filtering rows', async () => {
    // The MCP list tools used to pass `q` to the repository endpoint and then
    // re-filter the rows locally; the instance-wide fallback dropped the keyword
    // server-side and filtered locally. Both now ask the server, whose indexer
    // also matches comments — the local filter did not, so it discarded matches
    // the server had made.
    const client = createClient();
    const captured: URLSearchParams[] = [];
    mockServer.use(
      http.get('https://*/api/v1/repos/issues/search', ({ request }) => {
        captured.push(new URL(request.url).searchParams);
        return HttpResponse.json([]);
      }),
    );

    await client.getUserIssues('open', 'login');
    await client.getUserPullRequests('open', 'login');

    expect(captured).toHaveLength(2);
    expect(captured[0].get('q')).toBe('login');
    expect(captured[1].get('q')).toBe('login');
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
    // The search endpoint applies `q` server-side, so only the matching fixture
    // row comes back (the fixture list holds a non-matching one on purpose).
    expect(issues.map((issue) => issue.number)).toEqual([mockIssues[0].number]);
    expect(issues[0].title).toBe(mockIssues[0].title);
  });

  it('searches pull requests', async () => {
    const client = createClient();
    const pulls = await client.searchPullRequests('dark', 'open');
    expect(Array.isArray(pulls)).toBe(true);
    expect(pulls.map((pull) => pull.number)).toEqual([mockPullRequests[0].number]);
    expect(pulls[0].title).toBe(mockPullRequests[0].title);
  });

  it('fetches notifications', async () => {
    const client = createClient();
    const notifications = await client.getNotifications();
    const unreadNotifications = mockNotifications.filter((n) => n.unread);
    expect(notifications.items).toHaveLength(unreadNotifications.length);
    expect(notifications.items[0].subject?.title).toBe(unreadNotifications[0].subject?.title);
    // The mock notifications endpoint sends no X-Total-Count, the old-server shape.
    expect(notifications.totalCount).toBeUndefined();
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

  it('fetches the README entry with its text and size', async () => {
    const client = createClient();
    const entry = await client.getReadmeEntry('demo-user', 'demo-repo');
    expect(entry?.content).toContain('Demo Repository');
    expect(entry?.size).toBe(mockReadmeContent.size);
  });

  it('reads the README at an explicit ref', async () => {
    const client = createClient();
    const refs: Array<string | null> = [];
    mockServer.use(
      http.get('https://*/api/v1/repos/:owner/:repo/contents/README.md', ({ request }) => {
        refs.push(new URL(request.url).searchParams.get('ref'));
        return HttpResponse.json(mockReadmeContent);
      }),
    );

    await client.getReadme('demo-user', 'demo-repo', 'v2');
    await client.getReadmeEntry('demo-user', 'demo-repo', 'v2');

    expect(refs).toEqual(['v2', 'v2']);
  });

  it('reports a genuinely absent README as undefined', async () => {
    const client = createClient();
    mockServer.use(
      http.get('https://*/api/v1/repos/:owner/:repo/contents/README.md', () => new HttpResponse(null, { status: 404 })),
    );

    await expect(client.getReadmeEntry('demo-user', 'demo-repo')).resolves.toBeUndefined();
    // The legacy accessor keeps its old answer for the same reason.
    await expect(client.getReadme('demo-user', 'demo-repo')).resolves.toBeUndefined();
  });

  it('reports the size of a README whose payload Forgejo withheld', async () => {
    const client = createClient();
    // Forgejo omits the payload above [api] DEFAULT_MAX_BLOB_SIZE (10 MiB by
    // default) and answers with the real size and no content.
    const withheldSize = 11 * 1024 * 1024;
    mockServer.use(
      http.get('https://*/api/v1/repos/:owner/:repo/contents/README.md', () =>
        HttpResponse.json({ ...mockReadmeContent, content: undefined, size: withheldSize }),
      ),
    );

    const entry = await client.getReadmeEntry('demo-user', 'demo-repo');
    // The size is the only signal that tells this apart from "no README".
    expect(entry?.size).toBe(withheldSize);
    expect(entry?.content).toBeUndefined();
    // getReadme still answers "no text" — the notice is the host's job — but it
    // must not invent empty content either.
    await expect(client.getReadme('demo-user', 'demo-repo')).resolves.toBeUndefined();
  });

  it('fetches repository detail', async () => {
    const client = createClient();
    const detail = await client.getRepoDetail('demo-user', 'demo-repo');
    expect(detail.repository.full_name).toBe(mockRepository.full_name);
    expect(detail.empty).toBe(false);
    expect(detail.readme).toContain('Demo Repository');
    expect(detail.branches).toContain('main');
    expect(detail.recentCommits).toHaveLength(1);
  });

  it('caps the branches and commits of a repository detail', async () => {
    // The detail is a dashboard payload, not a full listing: it asks for
    // REPO_DETAIL_LIST_LIMIT rows. The MCP `get_repo` tool reports that cap, so
    // the constant and the request must not drift apart.
    const client = createClient();
    mockServer.use(
      http.get('https://*/api/v1/repos/:owner/:repo/branches', ({ request }) =>
        HttpResponse.json(
          Array.from({ length: 50 }, (_, i) => ({ name: `branch-${i}` })).slice(
            0,
            Number(new URL(request.url).searchParams.get('limit') ?? '50'),
          ),
        ),
      ),
    );

    const detail = await client.getRepoDetail('demo-user', 'demo-repo');

    expect(detail.branches).toHaveLength(REPO_DETAIL_LIST_LIMIT);
    // 50 branches exist and only 10 are returned, so the cut is real.
    expect(detail.branchesTruncated).toBe(true);
  });

  it('reports an exactly-full branch and commit list as complete, not capped', async () => {
    // `getRepoDetail` asks for one row beyond the cap, so the extra row's
    // presence — not the returned length — is what proves a cut. Comparing
    // lengths told a caller with exactly REPO_DETAIL_LIST_LIMIT branches that
    // the list was incomplete.
    const client = createClient();
    const branches = Array.from({ length: REPO_DETAIL_LIST_LIMIT }, (_, i) => ({ name: `branch-${i}` }));
    const commits = Array.from({ length: REPO_DETAIL_LIST_LIMIT }, (_, i) => ({ sha: `sha-${i}` }));
    mockServer.use(
      http.get('https://*/api/v1/repos/:owner/:repo/branches', ({ request }) =>
        HttpResponse.json(branches.slice(0, Number(new URL(request.url).searchParams.get('limit') ?? '10'))),
      ),
      http.get('https://*/api/v1/repos/:owner/:repo/commits', ({ request }) =>
        HttpResponse.json(commits.slice(0, Number(new URL(request.url).searchParams.get('limit') ?? '10'))),
      ),
    );

    const detail = await client.getRepoDetail('demo-user', 'demo-repo');

    expect(detail.branches).toHaveLength(REPO_DETAIL_LIST_LIMIT);
    expect(detail.recentCommits).toHaveLength(REPO_DETAIL_LIST_LIMIT);
    expect(detail.branchesTruncated).toBe(false);
    expect(detail.recentCommitsTruncated).toBe(false);
  });

  describe('getRepoDetail README entry', () => {
    /**
     * Answers `/contents/README.md` with `body` and counts how many times the
     * request arrives. Opening one repository detail must issue it exactly once:
     * the withheld-payload notice used to cost a second probe on every
     * README-less repository.
     */
    function countReadmeRequests(body: () => Response | Promise<Response>): () => number {
      let requests = 0;
      mockServer.use(
        http.get('https://*/api/v1/repos/:owner/:repo/contents/README.md', async () => {
          requests += 1;
          return await body();
        }),
      );
      return () => requests;
    }

    it('carries the text of a normal README and no withheld-payload size', async () => {
      const client = createClient();
      const requests = countReadmeRequests(() => HttpResponse.json(mockReadmeContent));

      const detail = await client.getRepoDetail('demo-user', 'demo-repo');

      expect(detail.readme).toContain('Demo Repository');
      // Size is the notice's input, so a README that arrived must not set it.
      expect(detail.readmeSize).toBeUndefined();
      // A regular file is not one of the non-file kinds, so the structured
      // notice stays unset and a localized caller keeps its own sentence.
      expect(detail.readmeNotice).toBeUndefined();
      expect(requests()).toBe(1);
    });

    it('reports the size of a withheld README and fetches its entry only once', async () => {
      const client = createClient();
      // Forgejo omits the payload above [api] DEFAULT_MAX_BLOB_SIZE (10 MiB by
      // default) and answers with the real size and no content.
      const withheldSize = 11 * 1024 * 1024;
      const requests = countReadmeRequests(() =>
        HttpResponse.json({ ...mockReadmeContent, content: undefined, size: withheldSize }),
      );

      const detail = await client.getRepoDetail('demo-user', 'demo-repo');

      expect(detail.readme).toBeUndefined();
      // The size is the only signal that tells this apart from "no README".
      expect(detail.readmeSize).toBe(withheldSize);
      // A withheld payload is still a regular file: no non-file kind to report.
      expect(detail.readmeNotice).toBeUndefined();
      expect(requests()).toBe(1);
    });

    it('leaves the withheld-payload size unset for a repository without a README', async () => {
      const client = createClient();
      const requests = countReadmeRequests(() => new HttpResponse(null, { status: 404 }));

      const detail = await client.getRepoDetail('demo-user', 'demo-repo');

      expect(detail.readme).toBeUndefined();
      // No README at all has nothing to explain, and the detail load must not
      // ask for it a second time to find that out.
      expect(detail.readmeSize).toBeUndefined();
      expect(detail.readmeNotice).toBeUndefined();
      expect(requests()).toBe(1);
    });

    it('leaves the withheld-payload size unset for a genuinely empty README', async () => {
      const client = createClient();
      const requests = countReadmeRequests(() =>
        HttpResponse.json({ ...mockReadmeContent, content: undefined, size: 0 }),
      );

      const detail = await client.getRepoDetail('demo-user', 'demo-repo');

      expect(detail.readme).toBeUndefined();
      // Size 0 is an empty README, not a withheld payload.
      expect(detail.readmeSize).toBeUndefined();
      expect(requests()).toBe(1);
    });

    it('describes a symlinked README instead of reporting its link target as a withheld payload', async () => {
      // Forgejo answers a symlink with `target` and a `size` equal to the
      // *target's* length. Copying that size marked the README as withheld above
      // the instance's payload limit — a cause the server never gave, next to a
      // nonsense size ("0.0 MiB" for a one-character target).
      const client = createClient();
      const target = 'docs/real-readme.md';
      const requests = countReadmeRequests(() =>
        HttpResponse.json({
          name: 'README.md',
          path: 'README.md',
          type: 'symlink',
          sha: 'link-sha',
          size: target.length,
          target,
        }),
      );

      const detail = await client.getRepoDetail('demo-user', 'demo-repo');

      // The README is not missing: it is a symlink, and the detail says so.
      expect(detail.readme).toContain('symlink');
      expect(detail.readme).toContain(target);
      // The link target's length must never be presented as a payload size.
      expect(detail.readmeSize).toBeUndefined();
      expect(detail.readme).not.toContain('MiB');
      // The sentence stays (the headless MCP tools have no translator), and the
      // structured form beside it is what the localized dashboard words itself.
      expect(detail.readmeNotice).toEqual({ kind: 'symlink', target });
      expect(requests()).toBe(1);
    });

    it('describes a submodule README instead of claiming nothing was returned', async () => {
      const client = createClient();
      const gitUrl = 'https://forgejo.example.com/demo-user/upstream-lib.git';
      const requests = countReadmeRequests(() =>
        HttpResponse.json({
          name: 'README.md',
          path: 'README.md',
          type: 'submodule',
          sha: 'submodule-sha',
          size: 0,
          submodule_git_url: gitUrl,
        }),
      );

      const detail = await client.getRepoDetail('demo-user', 'demo-repo');

      expect(detail.readme).toContain('submodule');
      expect(detail.readme).toContain(gitUrl);
      // A submodule entry carries no payload at all: nothing was withheld.
      expect(detail.readmeSize).toBeUndefined();
      // Same split as the symlink: the English sentence plus its structured form.
      expect(detail.readmeNotice).toEqual({ kind: 'submodule', target: gitUrl });
      expect(requests()).toBe(1);
    });

    it('reports the kind of a non-file README whose destination the API did not name', async () => {
      // Forgejo normally sends `target` for a symlink and `submodule_git_url`
      // for a submodule, but a sentence must not invent a destination it was not
      // given: the kind is still reported, with no target.
      const client = createClient();
      const requests = countReadmeRequests(() =>
        HttpResponse.json({ name: 'README.md', path: 'README.md', type: 'symlink', sha: 'link-sha', size: 0 }),
      );

      const detail = await client.getRepoDetail('demo-user', 'demo-repo');

      expect(detail.readmeNotice).toEqual({ kind: 'symlink', target: undefined });
      // The English fallback sentence still names what the entry is.
      expect(detail.readme).toContain('symlink');
      expect(detail.readmeSize).toBeUndefined();
      expect(requests()).toBe(1);
    });

    it('exposes the same structured notice from getReadmeEntry', async () => {
      // `getRepoDetail` is one reader of the entry; a caller that probes the
      // README itself gets the same kind/target pair, which is what keeps the two
      // paths from drifting.
      const client = createClient();
      mockServer.use(
        http.get('https://*/api/v1/repos/:owner/:repo/contents/README.md', () =>
          HttpResponse.json({
            name: 'README.md',
            path: 'README.md',
            type: 'submodule',
            size: 0,
            submodule_git_url: 'https://forgejo.example.com/lib.git',
          }),
        ),
      );

      const entry = await client.getReadmeEntry('demo-user', 'demo-repo');

      expect(entry?.noticeKind).toBe('submodule');
      expect(entry?.noticeTarget).toBe('https://forgejo.example.com/lib.git');
      expect(entry?.notice).toContain('submodule');
    });

    it('claims nothing for a README entry of a kind that has no payload', async () => {
      // Any other non-file kind: no text to show, but also no size to blame on
      // the instance's payload limit.
      const client = createClient();
      const requests = countReadmeRequests(() =>
        HttpResponse.json({ name: 'README.md', path: 'README.md', type: 'dir', sha: 'dir-sha', size: 4096 }),
      );

      const detail = await client.getRepoDetail('demo-user', 'demo-repo');

      expect(detail.readme).toBeUndefined();
      expect(detail.readmeSize).toBeUndefined();
      expect(requests()).toBe(1);
    });
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

  describe('repo contents memo', () => {
    // Opening one repository file makes VS Code call stat and then readFile, and
    // the provider builds a fresh ForgejoClient for each, so without a shared
    // memo the same blob is downloaded twice per open.
    function countContentRequests(): () => number {
      let requests = 0;
      const answer = () => {
        requests += 1;
        // The contents API echoes the file for a file path and the children for
        // a directory path; one element serves both callers here.
        return HttpResponse.json([{ ...mockReadmeContent, path: 'README.md' }]);
      };
      mockServer.use(
        http.get('https://*/api/v1/repos/:owner/:repo/contents', answer),
        http.get('https://*/api/v1/repos/:owner/:repo/contents/*', answer),
      );
      return () => requests;
    }

    it('serves the second read of the same file from memory', async () => {
      const requests = countContentRequests();
      // Two clients, as the provider creates one per message.
      await new ForgejoClient('https://forgejo.example.com', 'mock-token').getRepoContents(
        'demo-user',
        'demo-repo',
        'README.md',
        'main',
      );
      const entries = await new ForgejoClient('https://forgejo.example.com', 'mock-token').getRepoContents(
        'demo-user',
        'demo-repo',
        'README.md',
        'main',
      );

      expect(requests()).toBe(1);
      expect(entries[0].path).toBe('README.md');
    });

    it('does not answer one file with another file or another ref', async () => {
      const requests = countContentRequests();
      const client = new ForgejoClient('https://forgejo.example.com', 'mock-token');
      await client.getRepoContents('demo-user', 'demo-repo', 'README.md', 'main');
      await client.getRepoContents('demo-user', 'demo-repo', 'README.md', 'feature');
      await client.getRepoContents('demo-user', 'demo-repo', 'src/index.ts', 'main');

      expect(requests()).toBe(3);
    });

    it('does not alias a request to another whose path and ref contain the separator', async () => {
      // `|` is legal in a file name and in a git ref name, so joining the key
      // parts with `|` made (path `a|b`, ref `main`) and (path `a`, ref
      // `b|main`) one key — the second request was answered with the first
      // file's bytes.
      const requests = countContentRequests();
      const client = new ForgejoClient('https://forgejo.example.com', 'mock-token');
      await client.getRepoContents('demo-user', 'demo-repo', 'a|b', 'main');
      await client.getRepoContents('demo-user', 'demo-repo', 'a', 'b|main');

      expect(requests()).toBe(2);
    });

    it('does not share a result with a client that carries an abort signal', async () => {
      // An MCP tool call's result belongs to that call only; the shared memo
      // must neither answer it nor be populated from a call that may be aborted.
      const controller = new AbortController();
      const requests = countContentRequests();
      await new ForgejoClient('https://forgejo.example.com', 'mock-token')
        .withSignal(controller.signal)
        .getRepoContents('demo-user', 'demo-repo', 'README.md', 'main');
      await new ForgejoClient('https://forgejo.example.com', 'mock-token').getRepoContents(
        'demo-user',
        'demo-repo',
        'README.md',
        'main',
      );

      expect(requests()).toBe(2);
    });

    it('never answers one account with the file bytes fetched for another account', async () => {
      // Two accounts on the same origin see different content for the same path
      // (a private repository, a fork, a differently-scoped token). The memo is
      // shared across client instances, so its key has to separate accounts the
      // same way the git-tree cache does.
      let requests = 0;
      mockServer.use(
        http.get('https://*/api/v1/repos/:owner/:repo/contents/*', ({ request }) => {
          requests += 1;
          const account = request.headers.get('authorization') === 'token alice-token' ? 'alice' : 'bob';
          const content = Buffer.from(`bytes for ${account}`).toString('base64');
          return HttpResponse.json([{ ...mockReadmeContent, path: 'README.md', content }]);
        }),
      );

      const alice = await new ForgejoClient('https://forgejo.example.com', 'alice-token').getRepoContents(
        'demo-user',
        'demo-repo',
        'README.md',
        'main',
      );
      const bob = await new ForgejoClient('https://forgejo.example.com', 'bob-token').getRepoContents(
        'demo-user',
        'demo-repo',
        'README.md',
        'main',
      );

      // Both accounts were served by the server, and Bob's bytes are Bob's.
      expect(requests).toBe(2);
      expect(alice[0].content).toBe(Buffer.from('bytes for alice').toString('base64'));
      expect(bob[0].content).toBe(Buffer.from('bytes for bob').toString('base64'));
    });

    it('evicts by total bytes, not only by entry count', async () => {
      // The contents API answers with base64 bodies, so 64 entries can hold
      // hundreds of megabytes. The memo must give up its oldest entries once the
      // byte budget is spent, even though the count cap is nowhere near.
      let requests = 0;
      // Each answer is a quarter of the budget, so the fifth must push the first
      // out; the entry count cap (64) is never reached.
      const body = Buffer.alloc(Math.floor(REPO_CONTENTS_CACHE_MAX_BYTES / 4), 97).toString('base64');
      mockServer.use(
        http.get('https://*/api/v1/repos/:owner/:repo/contents/*', ({ request }) => {
          requests += 1;
          return HttpResponse.json([
            { ...mockReadmeContent, path: new URL(request.url).pathname.split('/contents/')[1], content: body },
          ]);
        }),
      );
      const client = new ForgejoClient('https://forgejo.example.com', 'mock-token');

      for (let index = 0; index < 5; index += 1) {
        await client.getRepoContents('demo-user', 'demo-repo', `file-${index}.md`, 'main');
      }
      expect(requests).toBe(5);
      expect(repoContentsCacheBytesForTest()).toBeLessThanOrEqual(REPO_CONTENTS_CACHE_MAX_BYTES);

      // The first entry was evicted for bytes; the fourth is still there.
      await client.getRepoContents('demo-user', 'demo-repo', 'file-0.md', 'main');
      expect(requests).toBe(6);
      await client.getRepoContents('demo-user', 'demo-repo', 'file-4.md', 'main');
      expect(requests).toBe(6);
    });

    it('never caches a single listing larger than the whole budget', async () => {
      // One oversized listing used to be stored anyway: it evicted every other
      // entry and still left the running total over the budget, so the next
      // insert evicted again and the bound never held.
      let requests = 0;
      const smallBody = Buffer.from('small file bytes').toString('base64');
      const hugeBody = Buffer.alloc(REPO_CONTENTS_CACHE_MAX_BYTES + 1024, 97).toString('base64');
      mockServer.use(
        http.get('https://*/api/v1/repos/:owner/:repo/contents/*', ({ request }) => {
          requests += 1;
          const requested = new URL(request.url).pathname.split('/contents/')[1];
          const content = requested === 'huge.md' ? hugeBody : smallBody;
          return HttpResponse.json([{ ...mockReadmeContent, path: requested, content }]);
        }),
      );
      const client = new ForgejoClient('https://forgejo.example.com', 'mock-token');

      await client.getRepoContents('demo-user', 'demo-repo', 'small.md', 'main');
      const bytesAfterSmall = repoContentsCacheBytesForTest();
      expect(bytesAfterSmall).toBeGreaterThan(0);

      await client.getRepoContents('demo-user', 'demo-repo', 'huge.md', 'main');

      // The oversized listing is answered but not retained...
      expect(repoContentsCacheBytesForTest()).toBe(bytesAfterSmall);
      expect(repoContentsCacheBytesForTest()).toBeLessThanOrEqual(REPO_CONTENTS_CACHE_MAX_BYTES);
      await client.getRepoContents('demo-user', 'demo-repo', 'huge.md', 'main');
      expect(requests).toBe(3);

      // ...and the entry that was already cached survived it.
      await client.getRepoContents('demo-user', 'demo-repo', 'small.md', 'main');
      expect(requests).toBe(3);
    });

    it('forgets the byte total when the memo is cleared', async () => {
      // The running total is what the budget is checked against, so a clear that
      // leaves it behind would shrink the budget for the next session.
      mockServer.use(
        http.get('https://*/api/v1/repos/:owner/:repo/contents/*', () =>
          HttpResponse.json([{ ...mockReadmeContent, path: 'README.md' }]),
        ),
      );
      await new ForgejoClient('https://forgejo.example.com', 'mock-token').getRepoContents(
        'demo-user',
        'demo-repo',
        'README.md',
        'main',
      );
      expect(repoContentsCacheBytesForTest()).toBeGreaterThan(0);

      clearRepoContentsCache();

      expect(repoContentsCacheBytesForTest()).toBe(0);
    });
  });

  it('fetches file content', async () => {
    const client = createClient();
    const content = await client.getFileContent('demo-user', 'demo-repo', 'README.md', 'main');
    expect(content).toContain('Demo Repository');
  });

  it('classifies a connection failure through an installed proxy as a proxy problem', async () => {
    // The injected fetch stands in for the ProxyAgent's undici fetch: a request
    // that never reaches the instance fails the same way whether the instance or
    // the proxy is unreachable, and only the installed dispatcher tells them
    // apart. Without one the classifier has no proxy signal, which the
    // errors-core suite covers directly.
    const cause = Object.assign(new Error('connect ECONNREFUSED proxy.example.com:3128'), {
      code: 'ECONNREFUSED',
    });
    const client = new ForgejoClient('https://forgejo.example.com', 'mock-token', undefined, undefined, {
      dispatcher: {},
      fetch: (() => Promise.reject(new TypeError('fetch failed', { cause }))) as never,
    });

    const error = await client
      .getCurrentUser()
      .then(() => undefined)
      .catch((failure: unknown) => failure as ApiError);

    expect(error?.kind).toBe('proxy');
    expect(error?.userMessage).toContain('proxy');
  });

  it('classifies a connection failure as a proxy problem when the proxy came from the module-level install', async () => {
    // The extension installs the configured proxy once through
    // setDefaultRequestDispatcher, not per client: no client it constructs ever
    // passes the `dispatcher` option. Reading only the per-client field left
    // every sidebar/panel error saying "Cannot connect to the instance" for a
    // refused proxy, so the module-level dispatcher has to count too.
    const cause = Object.assign(new Error('connect ECONNREFUSED proxy.example.com:3128'), {
      code: 'ECONNREFUSED',
    });
    const proxyFetch = (() => Promise.reject(new TypeError('fetch failed', { cause }))) as never;
    setDefaultRequestDispatcher({}, proxyFetch);
    try {
      const client = new ForgejoClient('https://forgejo.example.com', 'mock-token');

      const error = await client
        .getCurrentUser()
        .then(() => undefined)
        .catch((failure: unknown) => failure as ApiError);

      expect(error?.kind).toBe('proxy');
      expect(error?.userMessage).toContain('proxy');
      expect(error?.userMessage).not.toContain('Cannot connect to the instance');
    } finally {
      setDefaultRequestDispatcher(undefined, undefined);
    }
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
    expect(issues.items).toHaveLength(mockIssues.length);
    expect(issues.items[0].title).toBe(mockIssues[0].title);
  });

  it('fetches repository pull requests', async () => {
    const client = createClient();
    const pulls = await client.getRepoPullRequests('demo-user', 'demo-repo', 'open');
    expect(pulls.items).toHaveLength(mockPullRequests.length);
    expect(pulls.items[0].title).toBe(mockPullRequests[0].title);
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
    expect(issues.items).toHaveLength(total);
    expect(issues.items[total - 1].number).toBe(total);
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
    expect(pulls.items).toHaveLength(total);
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
    expect(issues.items).toEqual([]);
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
    expect(pulls.items).toEqual([]);
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
      expect(matches.items).toHaveLength(1);
      const misses = await client.getRepoIssues('demo-user', 'demo-repo', 'all', 'no-such-keyword');
      expect(misses.items).toEqual([]);
    });

    it('returns pull requests from the issues endpoint when type=pulls', async () => {
      const client = createClient();
      // getRepoPullRequests with a query goes through the issues endpoint with type=pulls.
      const pulls = await client.getRepoPullRequests('demo-user', 'demo-repo', 'all', 'dark mode');
      expect(pulls.items).toHaveLength(1);
      expect(pulls.items[0].title).toBe(mockPullRequests[0].title);
    });

    it('reflects issue edits in subsequent detail and list fetches', async () => {
      const client = createClient();
      await client.editIssue('demo-user', 'demo-repo', 1, { state: 'closed' } as unknown as EditIssueOption);
      const detail = await client.getIssueDetail('demo-user', 'demo-repo', 1);
      expect(detail.state).toBe('closed');
      // The edited row moved state; the fixture's other row stayed open, so the
      // open list holds it and no longer the edited one.
      const open = await client.getRepoIssues('demo-user', 'demo-repo', 'open');
      expect(open.items.map((issue) => issue.number)).not.toContain(1);
      const closed = await client.getRepoIssues('demo-user', 'demo-repo', 'closed');
      expect(closed.items.map((issue) => issue.number)).toEqual([1]);
    });

    it('reflects pull request edits in subsequent detail and list fetches', async () => {
      const client = createClient();
      await client.editPullRequest('demo-user', 'demo-repo', 2, {
        title: 'Renamed PR',
      } as unknown as EditPullRequestOption);
      const detail = await client.getPullRequestDetail('demo-user', 'demo-repo', 2);
      expect(detail.title).toBe('Renamed PR');
      const pulls = await client.getRepoPullRequests('demo-user', 'demo-repo', 'open');
      expect(pulls.items[0].title).toBe('Renamed PR');
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

  it('does not report a required-status-checks blocker when the probe failed', async () => {
    const client = createClient();
    // The combined-status read is best-effort; a 5xx leaves the required check's
    // state unknown. The branch protection still requires checks, and Forgejo
    // reports `mergeable: false` while checks are unresolved.
    mockServer.use(
      http.get('https://*/api/v1/repos/:owner/:repo/pulls/:index', () =>
        HttpResponse.json({ ...mockPullRequestDetail, mergeable: false }),
      ),
      http.get(
        'https://*/api/v1/repos/:owner/:repo/commits/:ref/status',
        () => new HttpResponse(null, { status: 503 }),
      ),
    );

    const pr = await client.getPullRequestDetail('demo-user', 'demo-repo', 2);

    // Unknown is not failed: the webview renders a missing state as `-` and
    // disables merging for every blocker, so this would claim the checks failed
    // because of a transient failure.
    expect(pr.statusChecks).toBeUndefined();
    expect(pr.mergeBlockers?.some((blocker) => blocker.type === 'required_status_checks')).toBe(false);
    // Nor is it a conflict: `mergeable: false` alongside unresolved checks must
    // not be re-read as one.
    expect(pr.mergeBlockers?.some((blocker) => blocker.type === 'conflicts')).toBe(false);
  });

  it('does not report a required-approvals blocker when the review list probe failed', async () => {
    const client = createClient();
    // The default fixtures read branch protection as an admin
    // (required_approvals: 1) and list a single COMMENTED review, i.e. a real
    // count of 0 approvals. A failed review-list probe is not that: the webview
    // disables merging for every blocker, so counting an unknown as 0 would tell
    // the user an approved PR is not approved.
    mockServer.use(
      http.get(
        'https://*/api/v1/repos/:owner/:repo/pulls/:index/reviews',
        () => new HttpResponse(null, { status: 503 }),
      ),
    );

    const pr = await client.getPullRequestDetail('demo-user', 'demo-repo', 2);

    expect(pr.mergeBlockers?.some((blocker) => blocker.type === 'required_approvals')).toBe(false);
  });

  it('keeps the required-approvals blocker for a real count of zero approvals', async () => {
    const client = createClient();

    // Same request shape as the test above, only the review list differs: the
    // known "no approvals yet" answer must keep blocking.
    const pr = await client.getPullRequestDetail('demo-user', 'demo-repo', 2);

    expect(pr.mergeBlockers?.some((blocker) => blocker.type === 'required_approvals')).toBe(true);
  });

  it('keeps the status blocker for a known non-success state', async () => {
    const client = createClient();
    mockServer.use(
      http.get('https://*/api/v1/repos/:owner/:repo/commits/:ref/status', ({ params }) =>
        HttpResponse.json({ sha: params.ref, state: 'pending', total_count: 0, statuses: [] }),
      ),
    );

    const pr = await client.getPullRequestDetail('demo-user', 'demo-repo', 2);

    const blocker = pr.mergeBlockers?.find((entry) => entry.type === 'required_status_checks');
    expect(blocker?.statusState).toBe('pending');
  });

  it('does not fabricate a status blocker when the pull request has no head sha', async () => {
    const client = createClient();
    const statusRequests: string[] = [];
    mockServer.use(
      http.get('https://*/api/v1/repos/:owner/:repo/pulls/:index', () =>
        HttpResponse.json({ ...mockPullRequestDetail, head: { ref: 'feature' } }),
      ),
      http.get('https://*/api/v1/repos/:owner/:repo/commits/:ref/status', ({ request }) => {
        statusRequests.push(request.url);
        return HttpResponse.json({ state: 'success' });
      }),
    );

    const pr = await client.getPullRequestDetail('demo-user', 'demo-repo', 2);

    // No sha means no probe was issued at all, so the state cannot have been
    // read as failed.
    expect(statusRequests).toEqual([]);
    expect(pr.mergeBlockers?.some((blocker) => blocker.type === 'required_status_checks')).toBe(false);
  });

  it('marks the pull request attachments as unavailable when the issues probe failed', async () => {
    const client = createClient();
    // `assets` only exists on the issues endpoint; when that best-effort probe
    // fails the detail arrives with no list at all.
    mockServer.use(
      http.get('https://*/api/v1/repos/:owner/:repo/issues/:index', () => new HttpResponse(null, { status: 503 })),
    );

    const pr = await client.getPullRequestDetail('demo-user', 'demo-repo', 2);

    expect(pr.assets).toBeUndefined();
    // An empty section would read as "this PR has no attachments".
    expect(pr.attachmentsUnavailable).toBe(true);
  });

  it('does not mark the pull request attachments as unavailable when the probe succeeded', async () => {
    const client = createClient();

    const pr = await client.getPullRequestDetail('demo-user', 'demo-repo', 2);

    expect(pr.attachmentsUnavailable).toBeUndefined();
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

  it('does not report a conflicts blocker when the branch protection is unknown', async () => {
    const client = createClient();
    // The endpoint is admin-only, so a non-admin's protection rules are unknown,
    // and Forgejo reports `mergeable: false` whenever it did not compute
    // mergeability — including while a protected branch's checks are unresolved.
    // Reading that false as a conflict would disable Merge for a PR whose real
    // state is merely unknown.
    mockServer.use(
      http.get('https://*/api/v1/repos/:owner/:repo', () =>
        HttpResponse.json({ ...mockRepository, permissions: { admin: false, push: true, pull: true } }),
      ),
      http.get('https://*/api/v1/repos/:owner/:repo/pulls/:index', () =>
        HttpResponse.json({ ...mockPullRequestDetail, mergeable: false }),
      ),
    );

    const pr = await client.getPullRequestDetail('demo-user', 'demo-repo', 2);

    expect(pr.protectionUnknown).toBe(true);
    expect(pr.mergeBlockers?.some((blocker) => blocker.type === 'conflicts')).toBe(false);
  });

  it('still reports a conflicts blocker when the branch protection read is a known answer', async () => {
    const client = createClient();
    // An admin whose branch has no protection rules (404) has a *known* state,
    // so a `mergeable: false` there really is a conflict and must keep blocking.
    mockServer.use(
      http.get(
        'https://*/api/v1/repos/:owner/:repo/branch_protections/:name',
        () => new HttpResponse(null, { status: 404 }),
      ),
      http.get('https://*/api/v1/repos/:owner/:repo/pulls/:index', () =>
        HttpResponse.json({ ...mockPullRequestDetail, mergeable: false }),
      ),
    );

    const pr = await client.getPullRequestDetail('demo-user', 'demo-repo', 2);

    expect(pr.protectionUnknown).toBe(false);
    expect(pr.mergeBlockers?.some((blocker) => blocker.type === 'conflicts')).toBe(true);
  });

  it('does not report a conflicts blocker for a mergeable pull request', async () => {
    const client = createClient();

    // The unchanged known case: `mergeable: true` never produced a conflict.
    const pr = await client.getPullRequestDetail('demo-user', 'demo-repo', 2);

    expect(pr.mergeable).toBe(true);
    expect(pr.mergeBlockers?.some((blocker) => blocker.type === 'conflicts')).toBe(false);
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
        // The gate is awaited now (it re-probes on demand), so it rejects
        // rather than throwing synchronously.
        await expect(client.listActionRuns('demo-user', 'demo-repo')).rejects.toThrow(/requires Forgejo .* or newer/);
      } finally {
        clearServerVersions();
      }
    });

    /**
     * The on-demand half of the gate (decision C of the multi-window lease
     * follow-up): the shared cache's TTL turns an old record into "unknown", and
     * unknown passes — so a gated call is the one place that renews the record.
     * These tests drive the real client against the mock server and count the
     * `/api/v1/version` requests that actually reached it.
     */
    describe('the version gate re-probes on demand', () => {
      let store: MemoryVersionCacheStore;

      // The gate's probe goes through the shared single-flight coordination, so
      // the route taken depends on the slot. Each test gets a clean one.
      beforeEach(() => {
        store = makeMemoryVersionCacheStore();
        setServerVersionCacheStorage(store.storage);
        clearServerVersions();
      });

      afterEach(() => {
        setServerVersionCacheStorage(undefined);
      });

      /** Counts `/api/v1/version` requests without disturbing the other mocks. */
      function countVersionProbes(): () => number {
        let probes = 0;
        mockServer.use(
          http.get('https://*/api/v1/version', () => {
            probes += 1;
            return HttpResponse.json({ version: '1.18.0' });
          }),
        );
        return () => probes;
      }

      it('probes once for an unknown version, then refuses the gated call', async () => {
        const probes = countVersionProbes();
        const client = createClient();

        await expect(client.listActionRuns('demo-user', 'demo-repo')).rejects.toThrow(/requires Forgejo .* or newer/);

        expect(probes()).toBe(1);
      });

      it('probes once for an expired version, then refuses the gated call', async () => {
        // The TTL is what makes the cache safe, and the price of it is exactly
        // this: a long session's first gated call renews the record.
        store.seed({
          'https://forgejo.example.com': {
            version: '1.18.0',
            writtenAt: Date.now() - SERVER_VERSION_CACHE_TTL_MS - 1,
          },
        });
        const probes = countVersionProbes();
        const client = createClient();

        await expect(client.listActionRuns('demo-user', 'demo-repo')).rejects.toThrow(/requires Forgejo .* or newer/);

        expect(probes()).toBe(1);
      });

      it('probes once between two gated calls in the same turn', async () => {
        // The gate's own single-flight: a dashboard read fans out over several
        // Actions endpoints, and each used to be a separate request.
        const probes = countVersionProbes();
        const client = createClient();

        const results = await Promise.allSettled([
          client.listActionRuns('demo-user', 'demo-repo'),
          client.getActionRun('demo-user', 'demo-repo', 1),
        ]);

        expect(results.every((result) => result.status === 'rejected')).toBe(true);
        expect(probes()).toBe(1);
      });

      it('does not probe while a fresh version is recorded', async () => {
        setServerVersion('https://forgejo.example.com', '17.0.0');
        const probes = countVersionProbes();
        const client = createClient();

        await expect(client.listActionRuns('demo-user', 'demo-repo')).resolves.toBeDefined();

        expect(probes()).toBe(0);
      });

      it('uses a declared version without probing, and refuses when it is below the floor', async () => {
        // The escape hatch reaches the gate: the instance record says what the
        // server runs, so no request to `/api/v1/version` is made — which is the
        // point when a reverse proxy blocks that endpoint.
        setDeclaredServerVersionResolver(() => '17.0.0');
        const probes = countVersionProbes();
        const client = createClient();

        await expect(client.listActionRuns('demo-user', 'demo-repo')).resolves.toBeDefined();
        expect(probes()).toBe(0);

        // A declaration below the Actions floor refuses the call, and says the
        // declaration — not the server — is why.
        setDeclaredServerVersionResolver(() => '1.18.0');
        const second = createClient();
        await expect(second.listActionRuns('demo-user', 'demo-repo')).rejects.toThrow(/you declared version 1\.18\.0/);
        expect(probes()).toBe(0);
      });

      it('surfaces the server’s own failure when a declaration is too high', async () => {
        // The other direction of a wrong declaration: it opens the gate, the
        // request goes out, and an instance that really has no Actions API
        // answers 404. That must come through as the ordinary request error —
        // never a hang, and never a crash of the gate itself.
        setDeclaredServerVersionResolver(() => '17.0.0');
        mockServer.use(
          http.get('https://*/api/v1/repos/:owner/:repo/actions/runs', () => new HttpResponse(null, { status: 404 })),
        );
        const client = createClient();

        await expect(client.listActionRuns('demo-user', 'demo-repo')).rejects.toThrow();
      });

      it('fails open when the on-demand probe fails', async () => {
        mockServer.use(http.get('https://*/api/v1/version', () => new HttpResponse(null, { status: 500 })));
        const client = createClient();

        // Unknown after the failed probe, so the gate allows and the real
        // Actions request is the only thing that can fail.
        await expect(client.listActionRuns('demo-user', 'demo-repo')).resolves.toBeDefined();
      });
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
        await removeTempDir(dir);
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
        await removeTempDir(dir);
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
        await removeTempDir(dir);
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

    it('pages the file history past the first 50 commits', async () => {
      // A single `limit: 50` request presented the newest 50 commits as the
      // whole history of a busier file; the endpoint takes page/limit, so the
      // history is paged like every other capped list.
      const client = createClient();
      const requestedPages: number[] = [];
      mockServer.use(
        http.get('https://*/api/v1/repos/:owner/:repo/commits', ({ request }) => {
          const url = new URL(request.url);
          if (!url.searchParams.get('path')) {
            return HttpResponse.json([]);
          }
          const page = Number(url.searchParams.get('page')) || 1;
          requestedPages.push(page);
          if (page > 2) {
            return HttpResponse.json([]);
          }
          return HttpResponse.json(
            Array.from({ length: 50 }, (_, index) => ({
              ...mockHistoryCommit,
              sha: `page-${page}-commit-${index}`,
            })),
          );
        }),
      );

      const commits = await client.getFileHistory('demo-user', 'demo-repo', 'README.md', 'main');

      expect(requestedPages).toEqual([1, 2, 3]);
      expect(commits).toHaveLength(100);
      expect(commits[99].sha).toBe('page-2-commit-49');
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

    it('does not alias two tree requests whose repository and ref contain the separator', async () => {
      // Same separator problem as the contents memo: the old key joined
      // `owner/repo` and the ref, so a repository name carrying the separator
      // could collide with a ref that carries it.
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
      const client = createClient();
      await client.searchRepoFiles('demo-user', 'demo-repo@main', 'v2', 'index');
      await client.searchRepoFiles('demo-user', 'demo-repo', 'main@v2', 'index');

      expect(treeRequests).toBe(2);
    });
  });

  describe('sub-path deployments on one host', () => {
    // Two instances can share a host under different sub-paths (`/a`, `/b`) and
    // even share a token; they are different servers, so an origin-keyed cache
    // would let one answer the other with the wrong repository data.
    const subPathClients = () => ({
      clientA: new ForgejoClient('https://forgejo.example.com/a', 'shared-token'),
      // The trailing slash exercises the key normalization: both spellings of
      // one deployment must share their entries.
      clientA2: new ForgejoClient('https://forgejo.example.com/a/', 'shared-token'),
      clientB: new ForgejoClient('https://forgejo.example.com/b', 'shared-token'),
    });

    it('does not share the git tree cache between two sub-path deployments', async () => {
      mockServer.use(
        http.get('https://forgejo.example.com/a/api/v1/repos/:owner/:repo/git/trees/:sha', () =>
          HttpResponse.json({ tree: [{ path: 'a-only.ts', type: 'blob', sha: 'sha-a', size: 1 }], truncated: false }),
        ),
        http.get('https://forgejo.example.com/b/api/v1/repos/:owner/:repo/git/trees/:sha', () =>
          HttpResponse.json({ tree: [{ path: 'b-only.ts', type: 'blob', sha: 'sha-b', size: 1 }], truncated: false }),
        ),
      );
      const { clientA, clientA2, clientB } = subPathClients();

      const filesA = (await clientA.searchRepoFiles('demo-user', 'demo-repo', 'main', 'only')).files.map(
        (entry) => entry.path,
      );
      const filesB = (await clientB.searchRepoFiles('demo-user', 'demo-repo', 'main', 'only')).files.map(
        (entry) => entry.path,
      );
      // The two spellings of deployment /a share their cached tree.
      const filesA2 = (await clientA2.searchRepoFiles('demo-user', 'demo-repo', 'main', 'only')).files.map(
        (entry) => entry.path,
      );

      expect(filesA).toEqual(['a-only.ts']);
      expect(filesB).toEqual(['b-only.ts']);
      expect(filesA2).toEqual(['a-only.ts']);
    });

    it('does not share the repo contents memo between two sub-path deployments', async () => {
      const entryFor = (marker: string) => ({
        name: 'file.txt',
        path: 'file.txt',
        type: 'file',
        content: Buffer.from(marker).toString('base64'),
      });
      mockServer.use(
        http.get('https://forgejo.example.com/a/api/v1/repos/:owner/:repo/contents/:path', () =>
          HttpResponse.json(entryFor('from-a')),
        ),
        http.get('https://forgejo.example.com/b/api/v1/repos/:owner/:repo/contents/:path', () =>
          HttpResponse.json(entryFor('from-b')),
        ),
      );
      const { clientA, clientB } = subPathClients();

      const contentsA = await clientA.getRepoContents('demo-user', 'demo-repo', 'file.txt');
      const contentsB = await clientB.getRepoContents('demo-user', 'demo-repo', 'file.txt');

      expect(Buffer.from(contentsA[0].content ?? '', 'base64').toString()).toBe('from-a');
      expect(Buffer.from(contentsB[0].content ?? '', 'base64').toString()).toBe('from-b');
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

    it('logs a failed mention lookup instead of swallowing it silently', async () => {
      // The suggestions are best-effort (a failed lookup must not break the
      // composer), but a silently dropped failure made a systematically broken
      // endpoint undiagnosable — `_probe` logs for the same reason.
      mockServer.use(http.get('https://*/api/v1/users/search', () => new HttpResponse(null, { status: 500 })));
      const logger = { isDebugEnabled: () => true, debug: vi.fn(), info: vi.fn(), error: vi.fn() };
      const client = new ForgejoClient('https://forgejo.example.com', 'mock-token', logger);

      const result = await client.searchMentions('demo-user', 'demo-repo', 'login', 'user');

      expect(result.users).toEqual([]);
      expect(logger.debug).toHaveBeenCalledWith(expect.stringContaining('searchMentions users'));
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

    it('costs one request per page for a large repository list', async () => {
      // Evidence for the list-size work: a 500-issue repository is ten round trips
      // (PAGE_SIZE 50) and the client stops at LIST_ITEM_LIMIT instead of silently
      // paging forever. The cap is what the UI now reports as a truncation.
      const PAGE = 50;
      const TOTAL = 500;
      const requestedPages: string[] = [];
      mockServer.use(
        http.get('https://*/api/v1/repos/:owner/:repo/issues', ({ request }) => {
          const page = Number(new URL(request.url).searchParams.get('page') ?? '1');
          requestedPages.push(String(page));
          const start = (page - 1) * PAGE;
          return HttpResponse.json(
            Array.from({ length: Math.min(PAGE, TOTAL - start) }, (_, i) => ({
              id: start + i + 1,
              number: start + i + 1,
              title: 'issue ' + (start + i + 1),
            })),
          );
        }),
      );

      const started = performance.now();
      const issues = await createClient().getRepoIssues('demo-user', 'demo-repo', 'open');
      const elapsed = performance.now() - started;

      expect(issues.items).toHaveLength(TOTAL);
      expect(requestedPages).toHaveLength(TOTAL / PAGE);
      // Informational: the assertion above is the evidence, this is the cost.
      expect(elapsed).toBeGreaterThanOrEqual(0);
    });

    it('answers a branch lookup from the first page instead of paging the whole list', async () => {
      // The create-PR status bar only asks "is there a PR for this branch?", and
      // the row is on page 1: the pre-fix read cost ten requests for the 500-row
      // list (PAGE_SIZE 50). This mock ignores the `head` filter — an instance
      // older than the filter answers exactly this way — so the saving measured
      // here is the early stop alone.
      const PAGE = 50;
      const TOTAL = 500;
      const requestedPages: string[] = [];
      mockServer.use(
        http.get('https://*/api/v1/repos/:owner/:repo/pulls', ({ request }) => {
          const page = Number(new URL(request.url).searchParams.get('page') ?? '1');
          requestedPages.push(String(page));
          const start = (page - 1) * PAGE;
          return HttpResponse.json(
            Array.from({ length: Math.min(PAGE, TOTAL - start) }, (_, i) => ({
              id: start + i + 1,
              number: start + i + 1,
              head: { ref: start + i + 1 === 3 ? 'feature' : `other-${start + i + 1}` },
            })),
          );
        }),
      );

      const pulls = await createClient().getRepoPullRequests('demo-user', 'demo-repo', 'open', undefined, {
        head: 'feature',
        stopWhen: (pr) => pr.head?.ref === 'feature',
      });

      expect(pulls.items.some((pr) => pr.head?.ref === 'feature')).toBe(true);
      expect(requestedPages).toEqual(['1']);
    });

    it('still finds the branch on a later page and stops at the page that holds it', async () => {
      const PAGE = 50;
      const TOTAL = 500;
      const BRANCH_PR = 101; // page 3
      const requestedPages: string[] = [];
      mockServer.use(
        http.get('https://*/api/v1/repos/:owner/:repo/pulls', ({ request }) => {
          const page = Number(new URL(request.url).searchParams.get('page') ?? '1');
          requestedPages.push(String(page));
          const start = (page - 1) * PAGE;
          return HttpResponse.json(
            Array.from({ length: Math.min(PAGE, TOTAL - start) }, (_, i) => ({
              id: start + i + 1,
              number: start + i + 1,
              head: { ref: start + i + 1 === BRANCH_PR ? 'feature' : `other-${start + i + 1}` },
            })),
          );
        }),
      );

      const pulls = await createClient().getRepoPullRequests('demo-user', 'demo-repo', 'open', undefined, {
        head: 'feature',
        stopWhen: (pr) => pr.head?.ref === 'feature',
      });

      // The branch's row arrives with page 3 (rows 101-150), so the read stops
      // there rather than walking the remaining seven pages.
      expect(pulls.items.find((pr) => pr.head?.ref === 'feature')?.number).toBe(BRANCH_PR);
      expect(pulls.items).toHaveLength(150);
      expect(requestedPages).toEqual(['1', '2', '3']);
    });

    it('still reads to the cap when no row matches, so an absent PR is not silently trusted', async () => {
      // No match means the read cannot stop early: it ends at the shared cap
      // exactly as it did before, and the caller sees the full 500 rows (ten
      // requests) it needs to report a possible miss rather than "no PR".
      const PAGE = 50;
      const TOTAL = 500;
      const requestedPages: string[] = [];
      mockServer.use(
        http.get('https://*/api/v1/repos/:owner/:repo/pulls', ({ request }) => {
          const page = Number(new URL(request.url).searchParams.get('page') ?? '1');
          requestedPages.push(String(page));
          const start = (page - 1) * PAGE;
          return HttpResponse.json(
            Array.from({ length: Math.min(PAGE, TOTAL - start) }, (_, i) => ({
              id: start + i + 1,
              number: start + i + 1,
              head: { ref: `other-${start + i + 1}` },
            })),
          );
        }),
      );

      const pulls = await createClient().getRepoPullRequests('demo-user', 'demo-repo', 'open', undefined, {
        head: 'feature',
        stopWhen: (pr) => pr.head?.ref === 'feature',
      });

      expect(pulls.items).toHaveLength(TOTAL);
      expect(requestedPages).toHaveLength(TOTAL / PAGE);
    });

    it('does not hand a null pull request row to the stop predicate', async () => {
      // Forgejo appends null when it cannot load a row's related tables, and every
      // consumer dereferences the row: the predicate must see the same defined
      // rows the returned list carries, or a broken row aborts the lookup.
      const seen: unknown[] = [];
      mockServer.use(
        http.get('https://*/api/v1/repos/:owner/:repo/pulls', () =>
          HttpResponse.json([null, { id: 2, number: 2, head: { ref: 'feature' } }]),
        ),
      );

      const pulls = await createClient().getRepoPullRequests('demo-user', 'demo-repo', 'open', undefined, {
        head: 'feature',
        stopWhen: (pr) => {
          seen.push(pr);
          return pr.head?.ref === 'feature';
        },
      });

      expect(seen).toHaveLength(1);
      expect(pulls.items).toHaveLength(1);
      expect(pulls.items[0]?.number).toBe(2);
    });

    it('narrows the read with the endpoint own head filter', async () => {
      // The pinned swagger gives repoListPullRequests a `head` parameter, which
      // Forgejo compares to pull_request.head_branch exactly; a server that
      // implements it answers the branch's rows on one page. A server that does
      // not ignores the parameter, which is why the paging above stays.
      const requestedHeads: Array<string | null> = [];
      mockServer.use(
        http.get('https://*/api/v1/repos/:owner/:repo/pulls', ({ request }) => {
          const head = new URL(request.url).searchParams.get('head');
          requestedHeads.push(head);
          return HttpResponse.json(
            head === 'feature'
              ? [{ id: 7, number: 7, head: { ref: 'feature', repo: { full_name: 'demo-user/demo-repo' } } }]
              : [],
          );
        }),
      );

      const pulls = await createClient().getRepoPullRequests('demo-user', 'demo-repo', 'open', undefined, {
        head: 'feature',
        stopWhen: (pr) => pr.head?.ref === 'feature',
      });

      expect(requestedHeads).toEqual(['feature']);
      expect(pulls.items).toHaveLength(1);
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
      expect(pulls.items).toHaveLength(1);
      expect(pulls.items[0]?.id).toBe(1);
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
      // The numeric id is what the delete endpoint takes; dropping it left the
      // webview unable to remove an attachment it had just uploaded.
      expect(attachment.id).toBe(mockIssueAttachment.id);
    });

    it('leaves the download URL unset instead of inventing /attachments/undefined when the uuid is missing', async () => {
      // The fallback URL is built from the uuid; without one the old code
      // produced a working-looking link that only 404s when opened.
      mockServer.use(
        http.post('https://*/api/v1/repos/:owner/:repo/issues/:index/assets', () =>
          HttpResponse.json({ id: 21, name: 'screenshot.png' }),
        ),
      );
      const client = createClient();

      const attachment = await client.createIssueAttachment(
        'demo-user',
        'demo-repo',
        1,
        new Uint8Array([1, 2, 3]),
        'screenshot.png',
      );

      expect(attachment.browser_download_url).toBeUndefined();
    });

    it('builds the fallback download URL without a double slash for an instance URL with a trailing slash', async () => {
      mockServer.use(
        http.post('https://*/api/v1/repos/:owner/:repo/issues/:index/assets', () =>
          HttpResponse.json({ id: 21, uuid: 'attach-uuid', name: 'screenshot.png' }),
        ),
      );
      const client = new ForgejoClient('https://forgejo.example.com/', 'mock-token');

      const attachment = await client.createIssueAttachment(
        'demo-user',
        'demo-repo',
        1,
        new Uint8Array([1, 2, 3]),
        'screenshot.png',
      );

      expect(attachment.browser_download_url).toBe('https://forgejo.example.com/attachments/attach-uuid');
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

    it('asks /compare for the merge-base range from both halves of a comparison', async () => {
      // `base...head` is the range a pull request shows; `base..head` also lists
      // every commit the base branch gained since the fork point. The two halves of
      // one comparison (the commits and the changed files) have to agree about it,
      // and the range is rendered in one place so they cannot disagree — measured
      // on the URL the mock server received, because an assembler can drop one of
      // the three dots silently.
      const client = createClient();
      const asked: string[] = [];
      mockServer.use(
        http.get('https://*/api/v1/repos/:owner/:repo/compare/:basehead', ({ request }) => {
          asked.push(new URL(request.url).pathname);
          return HttpResponse.json({ total_commits: 0, commits: [], files: [] });
        }),
      );

      await client.getCompareCommits('demo-user', 'demo-repo', 'base', 'head');
      await client.getPullRequestFilesFromCompare('demo-user', 'demo-repo', 'base', 'head');

      expect(asked).toEqual([
        '/api/v1/repos/demo-user/demo-repo/compare/base...head',
        '/api/v1/repos/demo-user/demo-repo/compare/base...head',
      ]);
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

    it('bounds the attachment fetches of a large comment list', async () => {
      // One request per attachment-linking comment, and the comment list can
      // reach the list cap. An unbounded Promise.all fired them all at once at
      // a self-hosted instance; the batch must stay capped instead.
      const client = createClient();
      const commentCount = 24;
      let inFlight = 0;
      let peak = 0;
      let assetRequests = 0;
      mockServer.use(
        http.get('https://*/api/v1/repos/:owner/:repo/issues/:index/timeline', ({ request }) => {
          const page = Number(new URL(request.url).searchParams.get('page')) || 1;
          return HttpResponse.json(
            page > 1
              ? []
              : Array.from({ length: commentCount }, (_, index) => ({
                  ...mockTimelineComment,
                  id: 1000 + index,
                  body: `See ![log](/attachments/123e4567-e89b-42d3-a456-42661417400${index % 10})`,
                })),
          );
        }),
        http.get('https://*/api/v1/repos/:owner/:repo/issues/comments/:id/assets', async () => {
          assetRequests += 1;
          inFlight += 1;
          peak = Math.max(peak, inFlight);
          await new Promise((resolve) => setTimeout(resolve, 5));
          inFlight -= 1;
          return HttpResponse.json([mockCommentAttachment]);
        }),
      );

      const comments = await client.getPullRequestCommentsAndTimeline('demo-user', 'demo-repo', 2);

      expect(comments).toHaveLength(commentCount);
      expect(assetRequests).toBe(commentCount);
      expect(peak).toBeGreaterThan(1);
      expect(peak).toBeLessThanOrEqual(4);
    });

    it('marks a failed attachment lookup instead of reporting no attachments', async () => {
      // Rendering the failure as an empty list told the user their attachment
      // was gone; the flag lets the view say the list could not be loaded.
      const client = createClient();
      mockServer.use(
        http.get('https://*/api/v1/repos/:owner/:repo/issues/:index/timeline', ({ request }) => {
          const page = Number(new URL(request.url).searchParams.get('page')) || 1;
          return HttpResponse.json(
            page > 1
              ? []
              : [{ ...mockTimelineComment, body: 'See ![log](/attachments/123e4567-e89b-42d3-a456-426614174000)' }],
          );
        }),
        http.get('https://*/api/v1/repos/:owner/:repo/issues/comments/:id/assets', () =>
          HttpResponse.json({ message: 'server exploded' }, { status: 500 }),
        ),
      );

      const comments = await client.getPullRequestCommentsAndTimeline('demo-user', 'demo-repo', 2);

      expect(comments).toHaveLength(1);
      expect((comments[0] as { assets?: unknown[] }).assets).toEqual([]);
      expect((comments[0] as { attachmentsUnavailable?: boolean }).attachmentsUnavailable).toBe(true);
    });

    it('does not mark a comment whose attachment list is simply empty', async () => {
      const client = createClient();
      mockServer.use(
        http.get('https://*/api/v1/repos/:owner/:repo/issues/:index/timeline', ({ request }) => {
          const page = Number(new URL(request.url).searchParams.get('page')) || 1;
          return HttpResponse.json(
            page > 1
              ? []
              : [{ ...mockTimelineComment, body: 'See ![log](/attachments/123e4567-e89b-42d3-a456-426614174000)' }],
          );
        }),
        http.get('https://*/api/v1/repos/:owner/:repo/issues/comments/:id/assets', () => HttpResponse.json([])),
      );

      const comments = await client.getPullRequestCommentsAndTimeline('demo-user', 'demo-repo', 2);

      expect((comments[0] as { assets?: unknown[] }).assets).toEqual([]);
      expect((comments[0] as { attachmentsUnavailable?: boolean }).attachmentsUnavailable).toBeUndefined();
    });

    it('fetches pull request commits', async () => {
      const client = createClient();
      const commits = await client.getPullRequestCommits('demo-user', 'demo-repo', 2);
      expect(commits).toHaveLength(1);
      expect(commits[0].sha).toBe(mockPullRequestCommit.sha);
    });

    it('merges a pull request', async () => {
      const client = createClient();
      await expect(client.mergePullRequest('demo-user', 'demo-repo', 2, 'merge')).resolves.toBeUndefined();
    });

    it('drops the cached git tree and contents memo when a pull request is merged', async () => {
      // The merge moves the base branch, so a tree or file body read before it
      // is stale the moment it succeeds; the shared memos have no way to know
      // which ref changed, so the merge path clears them.
      const client = createClient();
      let treeRequests = 0;
      let contentRequests = 0;
      mockServer.use(
        http.get('https://*/api/v1/repos/:owner/:repo/git/trees/:sha', () => {
          treeRequests += 1;
          return HttpResponse.json({
            sha: 'tree-sha',
            tree: [{ path: 'pre-merge.ts', type: 'blob' }],
            truncated: false,
          });
        }),
        http.get('https://*/api/v1/repos/:owner/:repo/contents/*', () => {
          contentRequests += 1;
          return HttpResponse.json([{ ...mockReadmeContent, path: 'README.md' }]);
        }),
      );

      await client.searchRepoFiles('demo-user', 'demo-repo', 'main', 'pre-merge');
      await client.getRepoContents('demo-user', 'demo-repo', 'README.md', 'main');
      expect(treeRequests).toBe(1);
      expect(contentRequests).toBe(1);

      await client.mergePullRequest('demo-user', 'demo-repo', 2, 'merge');

      await client.searchRepoFiles('demo-user', 'demo-repo', 'main', 'pre-merge');
      await client.getRepoContents('demo-user', 'demo-repo', 'README.md', 'main');
      expect(treeRequests).toBe(2);
      expect(contentRequests).toBe(2);
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
    it('treats a non-array page answer (a 204 the shared client surfaces as {}) as an empty page', async () => {
      // The shared request client answers 204/205/304 with `{}` rather than an
      // array; spreading that into the accumulator would throw, so a non-array
      // page is treated as the end of the list.
      mockServer.use(
        http.get('https://*/api/v1/repos/:owner/:repo/branches', () => new HttpResponse(null, { status: 204 })),
      );
      const client = createClient();

      await expect(client.getRepoBranches('demo-user', 'demo-repo')).resolves.toEqual([]);
    });

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

  describe('Contents entries that are not regular files', () => {
    /**
     * Forgejo fills `content` only for a regular file. A symlink answers with
     * `target` and a `size` equal to the *target's* length; a submodule answers
     * with `submodule_git_url` and size 0. Deciding on `content`/`size` alone
     * produced a withheld-payload notice for the symlink (a cause the server
     * never gave) and an empty string for the submodule ("this file is empty").
     */
    function answerWith(entry: Record<string, unknown>): void {
      mockServer.use(http.get('https://*/api/v1/repos/:owner/:repo/contents/:path', () => HttpResponse.json(entry)));
    }

    it('says a symlink is a symlink and names its target, not a payload limit', async () => {
      answerWith({
        name: 'link.md',
        path: 'link.md',
        type: 'symlink',
        size: 'README.md'.length,
        target: 'README.md',
      });
      const client = createClient();

      const result = await client.getFileContentResult('demo-user', 'demo-repo', 'link.md');

      expect(result.kind).toBe('symlink');
      expect(result.text).toContain('link.md is a symlink');
      expect(result.text).toContain('README.md');
      expect(result.text).not.toContain('payload limit');
    });

    it('says a submodule is a submodule and names its git URL, not an empty file', async () => {
      answerWith({
        name: 'lib',
        path: 'lib',
        type: 'submodule',
        size: 0,
        submodule_git_url: 'https://forgejo.example.com/demo-user/upstream-lib.git',
      });
      const client = createClient();

      const result = await client.getFileContentResult('demo-user', 'demo-repo', 'lib');

      expect(result.kind).toBe('submodule');
      expect(result.text).toContain('lib is a submodule');
      expect(result.text).toContain('upstream-lib.git');
      expect(result.text).not.toBe('');
    });

    it('keeps content the server did send, whatever the entry type says', async () => {
      // Forgejo never populates `content` for a symlink or a submodule, so
      // content that arrived is file content and must not be replaced by a
      // notice about the declared type.
      answerWith({ name: 'file.txt', path: 'file.txt', type: 'submodule', content: btoa('hello'), encoding: 'base64' });
      const client = createClient();

      await expect(client.getFileContentResult('demo-user', 'demo-repo', 'file.txt')).resolves.toEqual({
        kind: 'file',
        text: 'hello',
      });
    });
  });

  describe('Files whose payload the instance withholds', () => {
    it('explains the withheld payload instead of reporting an empty file', async () => {
      // The contents API answers with the real size and no `content` above
      // `[api] DEFAULT_MAX_BLOB_SIZE`; an empty string read as an empty file.
      mockServer.use(
        http.get('https://*/api/v1/repos/:owner/:repo/contents/:path', () =>
          HttpResponse.json({ name: 'huge.bin', path: 'huge.bin', type: 'file', size: 12 * 1024 * 1024 }),
        ),
      );
      const client = createClient();

      const result = await client.getFileContentResult('demo-user', 'demo-repo', 'huge.bin');

      expect(result.kind).toBe('withheld');
      expect(result.text).toContain('did not return this file');
      expect(result.text).toContain(String(12 * 1024 * 1024));
      // The string contract is unchanged for callers that only display it.
      await expect(client.getFileContent('demo-user', 'demo-repo', 'huge.bin')).resolves.toBe(result.text);
    });

    it('still returns an empty string for a genuinely empty file', async () => {
      mockServer.use(
        http.get('https://*/api/v1/repos/:owner/:repo/contents/:path', () =>
          HttpResponse.json({ name: 'empty.txt', path: 'empty.txt', type: 'file', size: 0, content: '' }),
        ),
      );
      const client = createClient();

      await expect(client.getFileContent('demo-user', 'demo-repo', 'empty.txt')).resolves.toBe('');
    });

    it('says a directory is a directory instead of reporting an empty file', async () => {
      // The contents endpoint answers a directory with its children, which the
      // content field cannot describe; an empty string would read as "empty file".
      mockServer.use(
        http.get('https://*/api/v1/repos/:owner/:repo/contents/:path', () =>
          HttpResponse.json([{ name: 'inner', path: 'dir/inner', type: 'file', size: 5 }]),
        ),
      );
      const client = createClient();

      await expect(client.getFileContent('demo-user', 'demo-repo', 'dir')).resolves.toContain('is a directory');
    });

    it('does not call an empty listing a directory, and says what is unknown instead', async () => {
      // Forgejo's `GetContentsOrList` answers an empty list for *every* path once
      // `repo.IsEmpty` is set, and an empty directory answers exactly the same
      // way: the response does not say which one the caller hit, so neither may
      // the notice. Claiming "a directory" named a cause the server never gave.
      const client = createClient();

      const result = await client.getFileContentResult('demo-user', MOCK_EMPTY_REPO, 'README.md');

      expect(result.kind).toBe('empty-listing');
      expect(result.text).not.toContain('is a directory');
      expect(result.text).toContain('list_repo_contents');
      expect(result.text).toMatch(/empty directory or an empty repository/);
    });

    it('still calls a populated listing a directory', async () => {
      // The other half of the inference: an answer that really did list entries
      // is a directory, and the honest sentence must not have replaced it.
      const client = createClient();

      const result = await client.getFileContentResult('demo-user', 'demo-repo', 'src');

      expect(result.kind).toBe('directory');
      expect(result.text).toContain('is a directory');
    });

    it('refuses a path that would escape the contents route', async () => {
      const client = createClient();

      await expect(client.getFileContent('demo-user', 'demo-repo', '../user/keys')).rejects.toThrow(
        /Unsafe path segment/,
      );
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
        // The message interpolates the cap actually in force — here the small
        // test value, not the 2 GB default.
        await expect(
          client.downloadActionArtifactToFile('demo-user', 'demo-repo', 1, target, undefined, 4),
        ).rejects.toThrow(/exceeds the 4 bytes size limit/);
        // The oversized download must not leave a file behind.
        await expect(fs.promises.access(target)).rejects.toThrow();
        await expect(fs.promises.access(`${target}.part`)).rejects.toThrow();
      } finally {
        await removeTempDir(dir);
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

    it('caps the match list and reports the cap as truncation', async () => {
      // The second cause of `truncated`: the tree was read completely but more
      // paths match than the search returns. The MCP tool tells the caller a
      // narrower query recovers the rest, which is only true for this cause.
      const client = createClient();
      mockServer.use(
        http.get('https://*/api/v1/repos/:owner/:repo/git/trees/:sha', () =>
          HttpResponse.json({
            sha: 'tree-sha',
            tree: Array.from({ length: MAX_SEARCH_RESULTS + 20 }, (_, i) => ({
              path: `match-${i}.ts`,
              type: 'blob',
              sha: `sha-${i}`,
            })),
            truncated: false,
          }),
        ),
      );

      const result = await client.searchRepoFiles('demo-user', 'demo-repo', 'main', 'match');

      expect(result.files).toHaveLength(MAX_SEARCH_RESULTS);
      expect(result.truncated).toBe(true);
      // The tree was read completely, so the cap is the only cause to name.
      expect(result.truncatedBy).toBe('matches');
    });

    it('names the unreadable tree when the match list also hit its cap', async () => {
      // Both causes at once: the tree read ends truncated and more paths match
      // than MAX_SEARCH_RESULTS. Naming `'matches'` would promise that a
      // narrower query returns the rest, which cannot be true when the matches
      // were never all read, so the tree is the cause to report.
      const client = createClient();
      let requests = 0;
      mockServer.use(
        http.get('https://*/api/v1/repos/:owner/:repo/git/trees/:sha', ({ request }) => {
          requests += 1;
          const page = Number(new URL(request.url).searchParams.get('page') ?? '1');
          // Each page is unique (so the duplicate-page guard never fires), full
          // of matches and still claims more: the paging bound is what ends the
          // read, and every one of the 50 pages contributes matches.
          return HttpResponse.json({
            sha: 'tree-sha',
            tree: Array.from({ length: MAX_SEARCH_RESULTS + 20 }, (_, i) => ({
              path: `match-${page}-${i}.ts`,
              type: 'blob',
              sha: `sha-${page}-${i}`,
            })),
            truncated: true,
          });
        }),
      );

      const result = await client.searchRepoFiles('demo-user', 'demo-repo', 'main', 'match');

      expect(result.files).toHaveLength(MAX_SEARCH_RESULTS);
      expect(result.truncated).toBe(true);
      expect(result.truncatedBy).toBe('tree');
      // The paging bound, not the server, ended the read.
      expect(requests).toBe(50);
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

    it('caches a truncated tree so its pages are fetched once', async () => {
      // Every page but the last is marked truncated, so a >MAX_TREE_PAGES-entry
      // repository re-issued the whole paging loop — up to 50 sequential
      // requests — for each debounced search query.
      const client = createClient();
      let requests = 0;
      mockServer.use(
        http.get('https://*/api/v1/repos/:owner/:repo/git/trees/:sha', ({ request }) => {
          requests += 1;
          const page = Number(new URL(request.url).searchParams.get('page') ?? '1');
          return HttpResponse.json({
            sha: 'tree-sha',
            tree: [{ path: `file-${page}.ts`, type: 'blob', sha: `sha-${page}` }],
            truncated: true,
          });
        }),
      );

      const first = await client.searchRepoFiles('demo-user', 'demo-repo', 'main', 'file-');
      expect(first.truncated).toBe(true);
      expect(requests).toBe(50);

      const second = await client.searchRepoFiles('demo-user', 'demo-repo', 'main', 'file-1');
      // Served from the cache: no second paging loop.
      expect(requests).toBe(50);
      expect(second.files.some((file) => file.path === 'file-1.ts')).toBe(true);
      // The cache still reports the tree as incomplete, so a search over it is
      // never presented as exhaustive.
      expect(second.truncated).toBe(true);
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
      // A complete answer names no cause: a `truncatedBy` on an untruncated
      // result would describe a cut that never happened.
      expect(result.truncatedBy).toBeUndefined();
    });
  });

  describe('git tree cache expiry', () => {
    it('purges expired trees when a new one is inserted', async () => {
      // Expiry used to be checked only on a hit, so up to MAX_TREE_CACHE_ENTRIES
      // dead trees — each one a repository's whole blob-path array — stayed
      // reachable until a count-based eviction happened to pick them.
      const client = createClient();
      let requests = 0;
      mockServer.use(
        http.get('https://*/api/v1/repos/:owner/:repo/git/trees/:sha', () => {
          requests += 1;
          return HttpResponse.json({
            sha: 'tree-sha',
            tree: [{ path: 'a.ts', type: 'blob', sha: 'blob-sha' }],
            truncated: false,
          });
        }),
      );

      const start = Date.now();
      const clock = vi.spyOn(Date, 'now');
      try {
        clock.mockReturnValue(start);
        await client.searchRepoFiles('demo-user', 'demo-repo', 'main', 'a');
        await client.searchRepoFiles('demo-user', 'demo-repo', 'dev', 'a');
        expect(treeCacheSizeForTest()).toBe(2);

        // Both entries are now past their 60 s TTL.
        clock.mockReturnValue(start + 60_001);
        await client.searchRepoFiles('demo-user', 'demo-repo', 'feature', 'a');

        // Only the tree just read is held: the two expired ones were purged
        // rather than left to be evicted by count later.
        expect(treeCacheSizeForTest()).toBe(1);

        // The fresh entry survived the purge: a second search over it is served
        // from memory instead of re-reading the tree.
        const requestsAfterFetch = requests;
        await client.searchRepoFiles('demo-user', 'demo-repo', 'feature', 'a');
        expect(requests).toBe(requestsAfterFetch);
      } finally {
        clock.mockRestore();
      }
    });
  });

  describe('Debug logging', () => {
    function createDebugClient(messages: string[], url = 'https://forgejo.example.com'): ForgejoClient {
      const logger = {
        isDebugEnabled: () => true,
        debug: (message: string) => messages.push(message),
        info: () => undefined,
        error: () => undefined,
      } as unknown as Logger;
      return new ForgejoClient(url, 'mock-token', logger);
    }

    it('never logs the credentials of a token-bearing instance URL', async () => {
      // The instance URL is what every request URL is built from, so a token
      // stored in its userinfo would otherwise be printed in both the request
      // line and the failure line — into the output channel and, for the MCP
      // server, into its stderr. `fetch` itself refuses to build a request from
      // a credential-bearing URL, so the success line is exercised against one
      // that accepts it; only the logged URL may differ from the request URL.
      const messages: string[] = [];
      const client = createDebugClient(messages, 'https://alice:super-secret-token@forgejo.example.com');
      const originalFetch = globalThis.fetch;
      globalThis.fetch = (() =>
        Promise.resolve(
          new Response(JSON.stringify(mockUser), { status: 200, headers: { 'Content-Type': 'application/json' } }),
        )) as typeof globalThis.fetch;
      try {
        await client.getCurrentUser();
      } finally {
        globalThis.fetch = originalFetch;
      }

      const requestLine = messages.find((m) => m.startsWith('Request: '));
      expect(requestLine).toBeDefined();
      expect(messages.join('\n')).not.toContain('super-secret-token');
      expect(requestLine).toContain('forgejo.example.com');
    });

    it('never logs the credentials of a token-bearing instance URL when the request fails', async () => {
      mockServer.use(http.get('https://*/api/v1/user', () => new HttpResponse(null, { status: 500 })));
      const messages: string[] = [];
      const client = createDebugClient(messages, 'https://super-secret-token@forgejo.example.com');

      await expect(client.getCurrentUser()).rejects.toThrow();

      const failureLine = messages.find((m) => m.startsWith('Request failed after'));
      expect(failureLine).toBeDefined();
      expect(messages.join('\n')).not.toContain('super-secret-token');
      expect(failureLine).toContain('forgejo.example.com');
    });

    it('redacts credentials echoed by a failed probe detail', async () => {
      // `_probe` logs the caught `ApiError.message` verbatim, and a detail that
      // never reached a handler can quote the request URL — `fetch` refuses a
      // credential-bearing URL and names the whole URL in its TypeError.
      const messages: string[] = [];
      const client = createDebugClient(messages);
      mockServer.use(
        http.get('https://*/api/v1/repos/:owner/:repo', () =>
          HttpResponse.json(
            {
              message:
                'Request cannot be constructed from a URL that includes credentials: ' +
                'https://alice:super-secret-token@forgejo.example.com/api/v1/repos/demo-user/demo-repo',
            },
            { status: 503 },
          ),
        ),
      );

      await client.probeRepository('demo-user', 'demo-repo');

      const probeLine = messages.find((m) => m.startsWith('[probe] probeRepository'));
      expect(probeLine).toBeDefined();
      expect(probeLine).not.toContain('super-secret-token');
      expect(probeLine).toContain('forgejo.example.com');
      expect(probeLine).toContain('/api/v1/repos/demo-user/demo-repo');
    });

    it('redacts credentials in the branch-protection failure detail', async () => {
      const messages: string[] = [];
      const client = createDebugClient(messages);
      mockServer.use(
        http.get('https://*/api/v1/repos/:owner/:repo/branch_protections/:name', () =>
          HttpResponse.json(
            {
              message:
                'upstream refused https://alice:super-secret-token@forgejo.example.com' +
                '/api/v1/repos/demo-user/demo-repo/branch_protections/main',
            },
            { status: 500 },
          ),
        ),
      );

      // The default fixtures report admin permissions, so the protection read is
      // attempted and its 500 lands in the debug line.
      const pr = await client.getPullRequestDetail('demo-user', 'demo-repo', 2);

      expect(pr.protectionUnknown).toBe(true);
      const protectionLine = messages.find((m) => m.startsWith('[branchProtection] unreadable'));
      expect(protectionLine).toBeDefined();
      expect(protectionLine).not.toContain('super-secret-token');
      expect(protectionLine).toContain('branch_protections/main');
    });

    it('redacts credentials in the comment-attachment failure detail', async () => {
      const messages: string[] = [];
      const client = createDebugClient(messages);
      mockServer.use(
        http.get('https://*/api/v1/repos/:owner/:repo/issues/comments/:id/assets', () =>
          HttpResponse.json(
            {
              message:
                'Request cannot be constructed from a URL that includes credentials: ' +
                'https://alice:super-secret-token@forgejo.example.com/api/v1/repos/demo-user/demo-repo/issues/comments/50/assets',
            },
            { status: 503 },
          ),
        ),
      );

      // The fixture comment body references an attachment, so the per-comment
      // asset lookup runs and its failure goes through the catch under test.
      await client.getPullRequestCommentsAndTimeline('demo-user', 'demo-repo', 1);

      const assetLine = messages.find((m) => m.startsWith('[probe] comment assets for #50'));
      expect(assetLine).toBeDefined();
      expect(assetLine).not.toContain('super-secret-token');
      expect(assetLine).toContain('/api/v1/repos/demo-user/demo-repo/issues/comments/50/assets');
    });

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

    it('logs how many requests a paged read cost', async () => {
      const messages: string[] = [];
      const client = createDebugClient(messages);
      // The per-request timeout bounds one page, not the whole paged read, so
      // the request count is the only visible measure of that read's cost.
      // Clamp pages to 30 items: 70 repos then take three requests.
      const total = 70;
      mockServer.use(
        http.get('https://*/api/v1/user/repos', ({ request }) => {
          const page = Number(new URL(request.url).searchParams.get('page') ?? '1');
          const start = (page - 1) * 30;
          return HttpResponse.json(
            Array.from({ length: Math.max(0, Math.min(30, total - start)) }, (_, i) => ({
              ...mockRepository,
              id: start + i + 1,
              full_name: `demo-user/repo-${start + i + 1}`,
            })),
          );
        }),
      );

      await client.getUserRepositories();

      const pageLog = messages.find((m) => m.startsWith('[pages] repositories:'));
      expect(pageLog).toBeDefined();
      expect(pageLog).toContain('3 request(s)');
      expect(pageLog).toContain('70 item(s)');
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

    it('re-arms the 401 toast when the token is rotated on the same instance URL', async () => {
      mockAuthFailure(401, { message: 'unauthorized' });

      // The URL carries no credential — the token lives in SecretStorage — so
      // the URL alone cannot tell the first rejected token from the next one.
      // The client passes a fingerprint of the token it actually sent, or the
      // user who just pasted a new (still bad) token reads the 401 as silence
      // for the rest of the session.
      const withToken = (token: string) =>
        expect(new ForgejoClient('https://auth-rotate.example.com', token).getCurrentUser()).rejects.toThrow();

      await withToken('first-bad-token');
      await withToken('first-bad-token');
      expect(vscode.window.showErrorMessage).toHaveBeenCalledTimes(1);

      await withToken('second-bad-token');
      expect(vscode.window.showErrorMessage).toHaveBeenCalledTimes(2);
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

  describe('response URL rewriting cost', () => {
    // The client is rebuilt per message, so the scan/copy used to run on every
    // response and a large list paid 85-150 ms even when it held no URL at all.
    type Internals = {
      _rewriteResponseData<T>(data: T): T;
    };

    function largeList(count: number): Array<Record<string, unknown>> {
      return Array.from({ length: count }, (_, index) => ({
        id: index + 1,
        name: `repo-${index}`,
        description: `plain text ${index}`,
        private: index % 2 === 0,
      }));
    }

    it('returns a payload with nothing to rewrite as the very object it arrived as', () => {
      // The user object carries only an external avatar URL. Detection finds a
      // non-configured origin, but no value on it is rewriteable — avatar_url is
      // skipped on purpose — so the payload must not be rebuilt. Identity, not
      // equality, is what proves the deep copy was skipped.
      const client = new ForgejoClient('https://configured.example.com', 'mock-token');
      const internals = client as unknown as Internals;
      const payload = {
        login: 'demo-user',
        avatar_url: 'https://avatar.example.com/demo-user.png',
        created: '2024-01-01T00:00:00Z',
        counts: { followers: 3, following: 1 },
      };

      const result = internals._rewriteResponseData(payload);

      expect(result).toBe(payload);
      // The same payload plus one URL on the API origin is still rebuilt — the
      // fast path must not become "never rewrite".
      const withUrl = { ...payload, html_url: 'https://api-host.example.net/demo-user' };
      const rewritten = internals._rewriteResponseData(withUrl);
      expect(rewritten).not.toBe(withUrl);
      expect(rewritten.html_url).toBe('https://configured.example.com/demo-user');
    });

    it('does not copy a 500-item list that carries no URL on another origin', () => {
      // The list has ids, names and descriptions but not one URL, so the rewrite
      // has nothing to do on any of the 500 items.
      const client = new ForgejoClient('https://configured.example.com', 'mock-token');
      const internals = client as unknown as Internals;
      const payload = largeList(500);

      expect(internals._rewriteResponseData(payload)).toBe(payload);
    });

    it('serves a large list of external avatar URLs without touching it', async () => {
      // A symmetric payload — the same shape on both sides of the memo — so the
      // response object itself is observable through the public API.
      const payload = {
        login: 'demo-user',
        avatar_url: 'https://avatar.example.com/demo-user.png',
        counts: { followers: 3, following: 1 },
      };
      mockServer.use(http.get('https://*/api/v1/user', () => HttpResponse.json(payload)));

      const user = await new ForgejoClient('https://configured.example.com', 'mock-token').getCurrentUser();

      expect(user.avatar_url).toBe('https://avatar.example.com/demo-user.png');
      expect(user.login).toBe('demo-user');
    });

    it('serves a 500-item list whose URLs are all on the configured instance unchanged', async () => {
      // The fast path must not skip a payload that does need rewriting, and it
      // must not depend on the list being small.
      const payload = Array.from({ length: 500 }, (_, index) => ({
        id: index + 1,
        name: `repo-${index}`,
        html_url: `https://configured.example.com/demo-user/repo-${index}`,
      }));
      mockServer.use(http.get('https://*/api/v1/user/repos', () => HttpResponse.json(payload)));

      const repositories = await new ForgejoClient(
        'https://configured.example.com',
        'mock-token',
      ).getUserRepositories();

      expect(repositories.items).toHaveLength(500);
      expect(repositories.items[0].html_url).toBe('https://configured.example.com/demo-user/repo-0');
      expect(repositories.items[499].html_url).toBe('https://configured.example.com/demo-user/repo-499');
    });

    it('still deep-copies and rewrites a payload whose URLs point at the API origin', () => {
      // Semantics must not change: an API-provided URL has to point at the
      // configured instance, and that requires building new objects.
      const client = new ForgejoClient('https://configured.example.com', 'mock-token');
      const payload = { html_url: 'https://api-host.example.net/demo-user/demo-repo' };

      const result = (client as unknown as Internals)._rewriteResponseData(payload);

      expect(result).not.toBe(payload);
      expect(result.html_url).toBe('https://configured.example.com/demo-user/demo-repo');
    });

    it('rewrites every URL of a large list without skipping entries', () => {
      const client = new ForgejoClient('https://configured.example.com', 'mock-token');
      const payload = Array.from({ length: 500 }, (_, index) => ({
        id: index + 1,
        html_url: `https://api-host.example.net/demo-user/repo-${index}`,
      }));

      const result = (client as unknown as Internals)._rewriteResponseData(payload);

      expect(result).toHaveLength(500);
      expect(result[0].html_url).toBe('https://configured.example.com/demo-user/repo-0');
      expect(result[499].html_url).toBe('https://configured.example.com/demo-user/repo-499');
    });

    it('rewrites a list served by a real API host after the same shape was seen URL-free', () => {
      // The shape memo must not turn a later URL-bearing response into a
      // skipped rewrite: only the payload that was proven URL-free is skipped,
      // and this one has a different shape.
      const client = new ForgejoClient('https://configured.example.com', 'mock-token');
      const internals = client as unknown as Internals;
      const withoutUrls = largeList(2);
      expect(internals._rewriteResponseData(withoutUrls)).toBe(withoutUrls);

      const withUrls = [
        { id: 1, name: 'repo-0', html_url: 'https://api-host.example.net/demo-user/repo-0' },
        { id: 2, name: 'repo-1', html_url: 'https://api-host.example.net/demo-user/repo-1' },
      ];
      const result = internals._rewriteResponseData(withUrls);

      expect(result[0].html_url).toBe('https://configured.example.com/demo-user/repo-0');
      expect(result[1].html_url).toBe('https://configured.example.com/demo-user/repo-1');
    });

    it('does not skip a same-shaped payload when only the values change to carry URLs', () => {
      // The fingerprint is structural, so the memo verdict may only ever be
      // recorded for a URL-free payload — and URL-ness is part of the
      // fingerprint, so the second response below (identical keys, identical
      // types, but `html_url` now holds a URL on the detected origin) must not
      // hit the verdict the first one recorded.
      const client = new ForgejoClient('https://configured.example.com', 'mock-token');
      const internals = client as unknown as Internals;
      const urlFree = [
        { id: 1, name: 'repo-0', html_url: '' },
        { id: 2, name: 'repo-1', html_url: '' },
      ];
      expect(internals._rewriteResponseData(urlFree)).toBe(urlFree);

      const withUrls = [
        { id: 1, name: 'repo-0', html_url: 'https://api-host.example.net/demo-user/repo-0' },
        { id: 2, name: 'repo-1', html_url: 'https://api-host.example.net/demo-user/repo-1' },
      ];
      const result = internals._rewriteResponseData(withUrls);

      expect(result).not.toBe(withUrls);
      expect(result[0].html_url).toBe('https://configured.example.com/demo-user/repo-0');
      expect(result[1].html_url).toBe('https://configured.example.com/demo-user/repo-1');
    });

    it('rewrites an avatar URL that sits on the detected server origin', () => {
      // Avatars are excluded from origin *detection* (an external avatar host
      // must not win the vote), but an avatar served by the instance itself
      // sits on the detected origin. The webview proxies avatars only when
      // they are same-origin with the configured URL, so leaving this one
      // alone renders a broken image for an instance the webview cannot reach.
      const client = new ForgejoClient('https://configured.example.com', 'mock-token');
      const internals = client as unknown as Internals;
      const payload = {
        html_url: 'https://api-host.example.net/demo-user/demo-repo',
        owner: { login: 'demo-user', avatar_url: 'https://api-host.example.net/avatars/demo-user.png' },
      };

      const result = internals._rewriteResponseData(payload);

      expect(result.html_url).toBe('https://configured.example.com/demo-user/demo-repo');
      expect(result.owner.avatar_url).toBe('https://configured.example.com/avatars/demo-user.png');
    });

    it('rewrites the payload when only an avatar URL points at the detected origin', () => {
      // Once the origin is known from an earlier payload, a payload whose only
      // detected-origin URL is an avatar still needs the rewrite pass; the
      // avatar exclusion belongs to detection, not to the rewrite trigger.
      const client = new ForgejoClient('https://configured.example.com', 'mock-token');
      const internals = client as unknown as Internals;
      internals._rewriteResponseData({ html_url: 'https://api-host.example.net/demo-user/demo-repo' });

      const payload = { login: 'demo-user', avatar_url: 'https://api-host.example.net/avatars/demo-user.png' };
      const result = internals._rewriteResponseData(payload);

      expect(result.avatar_url).toBe('https://configured.example.com/avatars/demo-user.png');
    });

    it('leaves an avatar or website URL on an external host alone', () => {
      const client = new ForgejoClient('https://configured.example.com', 'mock-token');
      const payload = {
        html_url: 'https://api-host.example.net/demo-user/demo-repo',
        owner: { avatar_url: 'https://avatar.example.com/a.png', website: 'https://home.example.net' },
      };

      const result = (client as unknown as Internals)._rewriteResponseData(payload);

      expect(result.owner.avatar_url).toBe('https://avatar.example.com/a.png');
      expect(result.owner.website).toBe('https://home.example.net');
      expect(result.html_url).toBe('https://configured.example.com/demo-user/demo-repo');
    });
  });
});
