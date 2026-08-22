import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
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
import { ForgejoClient } from '../client';
import { startMockServer, stopMockServer, resetMockServer, mockServer } from '../../test/mocks/server';
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
    expect(repos).toHaveLength(2);
    expect(repos[0].full_name).toBe(mockRepository.full_name);
    expect(repos[1].full_name).toBe(mockRepository2.full_name);
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

  it('searches repositories', async () => {
    const client = createClient();
    const repos = await client.searchRepositories('demo');
    expect(repos).toHaveLength(2);
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
    expect(releases).toEqual([]);
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

  it('fetches pull request detail', async () => {
    const client = createClient();
    const pr = await client.getPullRequestDetail('demo-user', 'demo-repo', 2);
    expect(pr.number).toBe(mockPullRequestDetail.number);
    expect(pr.title).toBe(mockPullRequestDetail.title);
    expect(pr.mergeable).toBe(true);
  });

  it('fetches action runs', async () => {
    const client = createClient();
    const runs = await client.listActionRuns('demo-user', 'demo-repo');
    expect(runs.workflow_runs).toEqual([]);
    expect(runs.total_count).toBe(0);
  });

  it('renders markdown', async () => {
    const client = createClient();
    const html = await client.renderMarkdown('hello **world**', 'markdown');
    expect(html).toContain('<p>hello <strong>world</strong></p>');
  });

  it('rewrites API URLs when server origin differs from configured origin', async () => {
    const client = new ForgejoClient('https://configured.example.com', 'mock-token', undefined, true);
    const user = await client.getCurrentUser();
    expect(user.avatar_url).toBe('https://configured.example.com/avatars/1');
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

    it('cancels an action run', async () => {
      const client = createClient();
      await expect(client.cancelActionRun('demo-user', 'demo-repo', 42)).resolves.toBeUndefined();
    });

    it('downloads an action artifact', async () => {
      const client = createClient();
      const data = await client.downloadActionArtifact('demo-user', 'demo-repo', 7);
      expect(data).toBeInstanceOf(Uint8Array);
      expect(data.length).toBe(3);
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
      const files = await client.searchRepoFiles('demo-user', 'demo-repo', 'main', 'index');
      expect(files.length).toBeGreaterThan(0);
      expect(files[0].path).toContain('index');
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
      const result = await client.searchMentions('demo-user', 'demo-repo', 'demo', 'all');
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

    it('fetches pull request files from compare', async () => {
      const client = createClient();
      const files = await client.getPullRequestFilesFromCompare('demo-user', 'demo-repo', 'base', 'head');
      expect(files.length).toBeGreaterThan(0);
    });

    it('fetches pull request comments and timeline', async () => {
      const client = createClient();
      const comments = await client.getPullRequestCommentsAndTimeline('demo-user', 'demo-repo', 2);
      expect(comments).toHaveLength(1);
      expect(comments[0].id).toBe(mockTimelineComment.id);
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
      const comment = await client.addPullReviewComment('demo-user', 'demo-repo', 2, 100, {
        path: 'src/index.ts',
        body: 'Nitpick',
      } as unknown as CreatePullReviewComment);
      expect(comment.body).toBe('Nitpick');
    });

    it('submits a pull review', async () => {
      const client = createClient();
      const review = await client.submitPullReview('demo-user', 'demo-repo', 2, 100, 'APPROVED');
      expect(review.id).toBe(mockPullReview.id);
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
  });
});
