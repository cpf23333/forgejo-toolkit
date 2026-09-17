import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as vscode from 'vscode';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const clientMocks = vi.hoisted(() => ({
  editIssue: vi.fn(),
  replaceIssueLabels: vi.fn(),
  getRepoDetail: vi.fn(),
  getPullRequestDetail: vi.fn(),
  getUserIssues: vi.fn(),
  getUserPullRequests: vi.fn(),
  mergePullRequest: vi.fn(),
}));

vi.mock('../../api/client', () => ({
  API_REQUEST_TIMEOUT_MS: 30_000,
  ForgejoClient: vi.fn().mockImplementation(function () {
    return {
      searchMentions: vi.fn().mockRejectedValue(new Error('network down')),
      getCurrentUser: vi.fn().mockResolvedValue({ login: 'user' }),
      editIssue: clientMocks.editIssue,
      replaceIssueLabels: clientMocks.replaceIssueLabels,
      getRepoDetail: clientMocks.getRepoDetail,
      getPullRequestDetail: clientMocks.getPullRequestDetail,
      getUserIssues: clientMocks.getUserIssues,
      getUserPullRequests: clientMocks.getUserPullRequests,
      mergePullRequest: clientMocks.mergePullRequest,
    };
  }),
}));

vi.mock('../../worktree/gitOperations', () => ({
  clearLinkedRepositoryCache: vi.fn(),
  cloneRepository: vi.fn(),
  createWorktreeFromBranch: vi.fn(),
  createWorktreeWithNewBranch: vi.fn(),
  deleteBranch: vi.fn(async () => undefined),
  detectLinkedRepository: vi.fn(),
  detectLinkedRepositories: vi.fn(async () => ({ linked: undefined, all: [], unpublished: [] })),
  fetchBranch: vi.fn(),
  fetchPullRequestHead: vi.fn(),
  findLocalRepo: vi.fn(),
  getRefCommitSha: vi.fn(),
  isCurrentWorkspaceBaseRepo: vi.fn(),
  isGitRepository: vi.fn(),
  listRemotes: vi.fn(async () => []),
  openWorktree: vi.fn(async () => true),
  resolveRemoteForRepo: vi.fn(async () => 'origin'),
  revertMergeCommit: vi.fn(),
  sanitizeForPath: vi.fn((value: string) => value),
  validatePrWorktree: vi.fn(),
  removeWorktreeAndPrune: vi.fn(),
}));

import { ForgejoToolkitViewProvider, clearResolvedAvatarCache } from '../viewProvider';
import { ForgejoClient } from '../../api/client';
import { clearServerVersions, getServerVersion, setServerVersion } from '../../api/serverVersion';
import {
  clearLinkedRepositoryCache,
  cloneRepository,
  createWorktreeFromBranch,
  createWorktreeWithNewBranch,
  deleteBranch,
  fetchBranch,
  fetchPullRequestHead,
  findLocalRepo,
  getRefCommitSha,
  isCurrentWorkspaceBaseRepo,
  openWorktree,
  removeWorktreeAndPrune,
  resolveRemoteForRepo,
  revertMergeCommit,
  validatePrWorktree,
} from '../../worktree/gitOperations';
import { ConfigManager } from '../../config';
import { ReadmeContentProvider } from '../../readmeProvider';
import type { ForgejoInstance } from '@cpf23333-forgejo-toolkit/shared/webview/messages';

type MessageListener = (message: unknown) => void;

function createFakeContext() {
  const store = new Map<string, unknown>();
  const secretStore = new Map<string, string>();
  return {
    subscriptions: [] as Array<{ dispose(): void }>,
    globalState: {
      get: (key: string, fallback?: unknown) => store.get(key) ?? fallback,
      update: async (key: string, value: unknown) => {
        store.set(key, value);
      },
    },
    secrets: {
      get: async (key: string) => secretStore.get(key),
      store: async (key: string, value: string) => {
        secretStore.set(key, value);
      },
      delete: async (key: string) => {
        secretStore.delete(key);
      },
    },
    globalStorageUri: { fsPath: '/global-storage' },
    extensionUri: { fsPath: '/ext' },
  };
}

function createFakeView() {
  const posted: unknown[] = [];
  let listener: MessageListener | undefined;
  const view = {
    visible: true,
    title: undefined as string | undefined,
    show: vi.fn(),
    webview: {
      options: undefined as unknown,
      html: '',
      cspSource: '',
      postMessage: (message: unknown) => {
        posted.push(message);
        return Promise.resolve(true);
      },
      onDidReceiveMessage: (l: MessageListener) => {
        listener = l;
        return { dispose: vi.fn() };
      },
      asWebviewUri: (uri: unknown) => uri,
    },
    onDidDispose: () => ({ dispose: vi.fn() }),
    onDidChangeVisibility: () => ({ dispose: vi.fn() }),
  };
  return {
    view,
    posted,
    send: (message: unknown) => listener?.(message),
  };
}

function postedMessages(posted: unknown[]): Array<Record<string, unknown>> {
  return posted as Array<Record<string, unknown>>;
}

async function flushDispatches() {
  // Dispatch is fire-and-forget; let the handler promise chain settle.
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
}

/**
 * Flush macrotasks until the predicate holds. Flows that cross real `fs`
 * promises (threadpool) need more than a fixed number of ticks.
 */
async function flushUntil(predicate: () => boolean, attempts = 50) {
  for (let i = 0; i < attempts && !predicate(); i++) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

const testInstance: ForgejoInstance = {
  id: 'forgejo.example.com-user',
  url: 'https://forgejo.example.com',
  token: 'secret-token',
  name: 'user@forgejo.example.com',
  username: 'user',
};

describe('ForgejoToolkitViewProvider message dispatch', () => {
  let context: ReturnType<typeof createFakeContext>;
  let config: ConfigManager;
  let provider: ForgejoToolkitViewProvider;
  let fake: ReturnType<typeof createFakeView>;

  beforeEach(async () => {
    clientMocks.editIssue.mockReset();
    clientMocks.replaceIssueLabels.mockReset();
    clientMocks.getRepoDetail.mockReset();
    clientMocks.getPullRequestDetail.mockReset();
    clientMocks.getUserIssues.mockReset();
    clientMocks.getUserPullRequests.mockReset();
    clientMocks.mergePullRequest.mockReset();
    vi.mocked(fetchBranch).mockReset();
    vi.mocked(createWorktreeWithNewBranch).mockReset();
    vi.mocked(isCurrentWorkspaceBaseRepo).mockReset();
    vi.mocked(cloneRepository).mockReset();
    vi.mocked(getRefCommitSha).mockReset();
    vi.mocked(removeWorktreeAndPrune).mockReset();
    vi.mocked(openWorktree).mockReset().mockResolvedValue(true);
    vi.mocked(resolveRemoteForRepo).mockReset().mockResolvedValue('origin');
    vi.mocked(clearLinkedRepositoryCache).mockReset();
    vi.mocked(findLocalRepo).mockReset();
    vi.mocked(revertMergeCommit).mockReset();
    clearServerVersions();
    vi.mocked(vscode.window.showQuickPick).mockReset();
    context = createFakeContext();
    config = new ConfigManager(context as never);
    provider = new ForgejoToolkitViewProvider(
      context as never,
      context.extensionUri as never,
      config,
      new ReadmeContentProvider(),
    );
    fake = createFakeView();
    provider.resolveWebviewView(fake.view as never, {} as never, {} as never);
    await config.addInstance(testInstance);
  });

  it('replies with requestError when a request handler returns early without answering', async () => {
    fake.send({
      command: 'createIssue',
      instanceId: 'unknown-instance',
      owner: 'owner',
      repo: 'repo',
      data: { title: 'hello' },
      _requestId: 'req-early-return',
    });
    await flushDispatches();
    const messages = postedMessages(fake.posted);
    const fallback = messages.find((m) => m.command === 'requestError');
    expect(fallback).toBeDefined();
    expect(fallback?._requestId).toBe('req-early-return');
    expect(typeof fallback?.error).toBe('string');
    // The specific reply was never sent.
    expect(messages.some((m) => m.command === 'issueCreated')).toBe(false);
  });

  it('replies with requestError when a request handler throws', async () => {
    vi.spyOn(config, 'getInstances').mockImplementation(() => {
      throw new Error('storage exploded');
    });
    fake.send({
      command: 'getUserPreview',
      instanceId: testInstance.id,
      username: 'user',
      _requestId: 'req-throw',
    });
    await flushDispatches();
    const fallback = postedMessages(fake.posted).find((m) => m.command === 'requestError');
    expect(fallback).toBeDefined();
    expect(fallback?._requestId).toBe('req-throw');
  });

  it('does not send a fallback reply when the handler answered the request', async () => {
    // The mocked client rejects, so the handler replies with an error payload
    // carrying the request id — no generic fallback may follow.
    fake.send({
      command: 'searchMentions',
      instanceId: testInstance.id,
      owner: 'owner',
      repo: 'repo',
      query: 'foo',
      type: 'all',
      _requestId: 'req-answered',
    });
    await flushDispatches();
    const messages = postedMessages(fake.posted);
    const answer = messages.find((m) => m.command === 'mentionSearchResult');
    expect(answer).toBeDefined();
    expect(answer?._requestId).toBe('req-answered');
    expect(typeof answer?.error).toBe('string');
    expect(messages.some((m) => m.command === 'requestError')).toBe(false);
  });

  it('ignores malformed messages without throwing', async () => {
    fake.send(undefined);
    fake.send('not-an-object');
    fake.send({ noCommand: true });
    await flushDispatches();
    expect(fake.posted).toHaveLength(0);
  });

  it('does not turn handler errors of plain messages into unhandled rejections', async () => {
    vi.spyOn(config, 'removeInstance').mockRejectedValue(new Error('update failed'));
    // removeInstance carries no _requestId: the error is logged, no reply sent.
    fake.send({ command: 'removeInstance', id: testInstance.id });
    await flushDispatches();
    expect(postedMessages(fake.posted).some((m) => m.command === 'requestError')).toBe(false);
  });

  it('strips access tokens from the initialState payload', async () => {
    fake.send({ command: 'getInitialState' });
    await flushDispatches();
    const initialState = postedMessages(fake.posted).find((m) => m.command === 'initialState');
    expect(initialState).toBeDefined();
    const instances = initialState?.instances as Array<Record<string, unknown>>;
    expect(instances).toHaveLength(1);
    expect(instances[0].id).toBe(testInstance.id);
    expect('token' in instances[0]).toBe(false);
  });

  it('strips access tokens from instances updates', async () => {
    provider.refresh();
    await flushDispatches();
    const update = postedMessages(fake.posted).find((m) => m.command === 'instances');
    expect(update).toBeDefined();
    const instances = update?.data as Array<Record<string, unknown>>;
    expect(instances).toHaveLength(1);
    expect('token' in instances[0]).toBe(false);
  });

  it('refresh() also tells the webview to invalidate its data caches', async () => {
    provider.refresh();
    await flushDispatches();
    const messages = postedMessages(fake.posted);
    expect(messages.some((m) => m.command === 'instances')).toBe(true);
    expect(messages.some((m) => m.command === 'refreshData')).toBe(true);
  });

  it('allows http(s) openExternal and blocks other schemes', async () => {
    const openExternal = vscode.env.openExternal as ReturnType<typeof vi.fn>;
    openExternal.mockClear();

    fake.send({ command: 'openExternal', url: 'https://forgejo.example.com/owner/repo' });
    await flushDispatches();
    expect(openExternal).toHaveBeenCalledTimes(1);
    expect((openExternal.mock.calls[0][0] as { scheme: string }).scheme).toBe('https');

    fake.send({ command: 'openExternal', url: 'file:///etc/passwd' });
    fake.send({ command: 'openExternal', url: 'javascript:alert(1)' });
    await flushDispatches();
    expect(openExternal).toHaveBeenCalledTimes(1);
  });

  it('opens recorded worktree paths and blocks unknown ones', async () => {
    const worktree = {
      id: 'w1',
      instanceId: testInstance.id,
      owner: 'owner',
      repo: 'repo',
      prIndex: 1,
      prTitle: 'title',
      headBranch: 'feature',
      headSha: 'abc',
      baseBranch: 'main',
      sourceRepoPath: '/src/repo',
      worktreePath: '/cache/worktrees/w1',
      createdAt: 0,
    };
    await context.globalState.update('forgejoToolkit.worktrees', [worktree]);
    const openExternal = vscode.env.openExternal as ReturnType<typeof vi.fn>;
    openExternal.mockClear();

    fake.send({ command: 'openWorktreePath', path: '/cache/worktrees/w1' });
    fake.send({ command: 'openWorktreePath', path: '/etc' });
    await flushDispatches();
    expect(openExternal).toHaveBeenCalledTimes(1);
  });

  it('testConnection falls back to the stored token when the edit form sends an empty token', async () => {
    const client = vi.mocked(ForgejoClient);
    client.mockClear();

    fake.send({ command: 'testConnection', url: testInstance.url, token: '', instanceId: testInstance.id });
    await flushDispatches();

    expect(client).toHaveBeenCalledWith(testInstance.url, 'secret-token', expect.anything());
    const result = postedMessages(fake.posted).find((m) => m.command === 'testConnectionResult');
    expect(result).toMatchObject({ success: true, username: 'user' });
  });

  it('testConnection uses the given token as-is when one is provided', async () => {
    const client = vi.mocked(ForgejoClient);
    client.mockClear();

    fake.send({ command: 'testConnection', url: testInstance.url, token: 'fresh-token', instanceId: testInstance.id });
    await flushDispatches();

    expect(client).toHaveBeenCalledWith(testInstance.url, 'fresh-token', expect.anything());
  });

  it('testConnection falls back to the stored token for another URL on the same origin', async () => {
    const client = vi.mocked(ForgejoClient);
    client.mockClear();

    fake.send({
      command: 'testConnection',
      url: `${testInstance.url}/subpath`,
      token: '',
      instanceId: testInstance.id,
    });
    await flushDispatches();

    expect(client).toHaveBeenCalledWith(`${testInstance.url}/subpath`, 'secret-token', expect.anything());
  });

  it('testConnection does not send the stored token to a different origin', async () => {
    const client = vi.mocked(ForgejoClient);
    client.mockClear();

    fake.send({
      command: 'testConnection',
      url: 'https://evil.example.com',
      token: '',
      instanceId: testInstance.id,
    });
    await flushDispatches();

    // No fallback: the connection is tested anonymously, so the stored token
    // can never leak to a webview-chosen host.
    expect(client).toHaveBeenCalledWith('https://evil.example.com', '', expect.anything());
  });

  it('testConnection treats an unparseable URL as a different origin', async () => {
    const client = vi.mocked(ForgejoClient);
    client.mockClear();

    fake.send({ command: 'testConnection', url: 'not a url', token: '', instanceId: testInstance.id });
    await flushDispatches();

    expect(client).toHaveBeenCalledWith('not a url', '', expect.anything());
  });

  it('editInstance keeps the stored token when the URL stays on the same origin', async () => {
    const client = vi.mocked(ForgejoClient);
    client.mockClear();

    fake.send({ command: 'editInstance', id: testInstance.id, url: `${testInstance.url}/`, token: '' });
    await flushDispatches();

    expect(client).toHaveBeenCalledWith(`${testInstance.url}/`, 'secret-token', expect.anything());
    const result = postedMessages(fake.posted).find((m) => m.command === 'saveInstanceResult');
    expect(result).toMatchObject({ success: true });
  });

  it('editInstance rejects a URL change to a different origin without a new token', async () => {
    const client = vi.mocked(ForgejoClient);
    client.mockClear();

    fake.send({ command: 'editInstance', id: testInstance.id, url: 'https://other.example.com', token: '' });
    await flushDispatches();

    // No validation request at all — the stored token must not be sent to the
    // new host, and the persisted instance keeps its original URL.
    expect(client).not.toHaveBeenCalled();
    const result = postedMessages(fake.posted).find((m) => m.command === 'saveInstanceResult');
    expect(result?.success).toBe(false);
    expect(typeof result?.error).toBe('string');
    expect(config.getInstances()[0].url).toBe(testInstance.url);
  });

  it('editInstance allows a URL change to a different origin when a new token is provided', async () => {
    const client = vi.mocked(ForgejoClient);
    client.mockClear();

    fake.send({ command: 'editInstance', id: testInstance.id, url: 'https://other.example.com', token: 'new-token' });
    await flushDispatches();

    expect(client).toHaveBeenCalledWith('https://other.example.com', 'new-token', expect.anything());
    const result = postedMessages(fake.posted).find((m) => m.command === 'saveInstanceResult');
    expect(result).toMatchObject({ success: true });
  });

  it('saveInstance clears the cached server version and linked-repository scan', async () => {
    // A stale version recorded before a server upgrade must not keep gating
    // the Actions API after the instance is saved again.
    setServerVersion('https://new.example.com', '1.18.0');

    fake.send({ command: 'saveInstance', url: 'https://new.example.com/', token: 'tok' });
    await flushDispatches();

    const result = postedMessages(fake.posted).find((m) => m.command === 'saveInstanceResult');
    expect(result).toMatchObject({ success: true });
    expect(getServerVersion('https://new.example.com')).toBeUndefined();
    expect(vi.mocked(clearLinkedRepositoryCache)).toHaveBeenCalled();
  });

  it('editInstance clears the cached server version for both the old and new URL', async () => {
    setServerVersion(testInstance.url, '1.18.0');
    setServerVersion('https://other.example.com', '1.18.0');

    fake.send({ command: 'editInstance', id: testInstance.id, url: 'https://other.example.com', token: 'new-token' });
    await flushDispatches();

    const result = postedMessages(fake.posted).find((m) => m.command === 'saveInstanceResult');
    expect(result).toMatchObject({ success: true });
    expect(getServerVersion(testInstance.url)).toBeUndefined();
    expect(getServerVersion('https://other.example.com')).toBeUndefined();
    expect(vi.mocked(clearLinkedRepositoryCache)).toHaveBeenCalled();
  });

  it('dedupes a double-submitted mergePullRequest for the same PR', async () => {
    let finishMerge!: () => void;
    clientMocks.mergePullRequest.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          finishMerge = resolve;
        }),
    );

    const message = {
      command: 'mergePullRequest',
      instanceId: testInstance.id,
      owner: 'owner',
      repo: 'repo',
      index: 5,
      strategy: 'merge',
    };
    fake.send(message);
    fake.send(message);
    await flushUntil(() => clientMocks.mergePullRequest.mock.calls.length > 0);
    finishMerge();
    await flushUntil(() => postedMessages(fake.posted).some((m) => m.command === 'pullRequestMerged'));

    // The second click reuses the in-flight merge instead of issuing the API
    // call twice; the single coordinate-keyed reply clears both spinners.
    expect(clientMocks.mergePullRequest).toHaveBeenCalledTimes(1);
    expect(postedMessages(fake.posted).filter((m) => m.command === 'pullRequestMerged')).toHaveLength(1);
  });

  it('dedupes a double-submitted revertMergeCommit for the same PR', async () => {
    clientMocks.getPullRequestDetail.mockResolvedValue({
      merged: true,
      merge_commit_sha: 'abc123',
      base: { ref: 'main' },
    });
    vi.mocked(findLocalRepo).mockResolvedValue('/src/repo');
    let finishRevert!: () => void;
    vi.mocked(revertMergeCommit).mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          finishRevert = resolve;
        }),
    );

    const message = {
      command: 'revertMergeCommit',
      instanceId: testInstance.id,
      owner: 'owner',
      repo: 'repo',
      index: 5,
    };
    fake.send(message);
    fake.send(message);
    await flushUntil(() => vi.mocked(revertMergeCommit).mock.calls.length > 0);
    finishRevert();
    await flushUntil(() => postedMessages(fake.posted).some((m) => m.command === 'revertMergeCommitResult'));

    expect(vi.mocked(revertMergeCommit)).toHaveBeenCalledTimes(1);
    expect(postedMessages(fake.posted).filter((m) => m.command === 'revertMergeCommitResult')).toHaveLength(1);
  });

  it('answers previewImportInstances with cancelled when the file picker is dismissed', async () => {
    vi.mocked(vscode.window.showOpenDialog).mockResolvedValue(undefined as never);

    fake.send({ command: 'previewImportInstances' });
    await flushDispatches();

    const preview = postedMessages(fake.posted).find((m) => m.command === 'importInstancesPreview');
    expect(preview).toMatchObject({ cancelled: true, instances: [] });
  });

  it('rejects an importInstances message whose entries are all invalid', async () => {
    fake.send({
      command: 'importInstances',
      instances: [{ id: 'broken' }, 'not-an-object', null],
    });
    await flushDispatches();

    const reply = postedMessages(fake.posted).find((m) => m.command === 'instancesImported');
    expect(reply).toBeDefined();
    expect(reply?.success).toBe(false);
    expect(typeof reply?.error).toBe('string');
    // Nothing was added beyond the seed instance.
    expect(config.getInstances()).toHaveLength(1);
  });

  it('imports only the valid entries and keeps syncApiUrlsToInstanceUrl', async () => {
    fake.send({
      command: 'importInstances',
      instances: [
        {
          id: 'imported-1',
          url: 'https://forgejo.example.com',
          token: 'tok',
          name: 'imported',
          username: 'user',
          syncApiUrlsToInstanceUrl: true,
        },
        { id: 'broken' },
      ],
    });
    await flushDispatches();

    const reply = postedMessages(fake.posted).find((m) => m.command === 'instancesImported');
    expect(reply).toMatchObject({ success: true, count: 1 });
    const imported = config.getInstances().find((i) => i.id === 'imported-1');
    expect(imported?.syncApiUrlsToInstanceUrl).toBe(true);
  });

  it('replies worktreeError with the PR identity when removal fails, keeping the record', async () => {
    const worktree = {
      id: 'w1',
      instanceId: testInstance.id,
      owner: 'owner',
      repo: 'repo',
      prIndex: 1,
      prTitle: 'title',
      headBranch: 'feature',
      headSha: 'abc',
      baseBranch: 'main',
      sourceRepoPath: process.cwd(),
      worktreePath: '/cache/worktrees/w1',
      createdAt: 0,
    };
    await context.globalState.update('forgejoToolkit.worktrees', [worktree]);
    vi.mocked(removeWorktreeAndPrune).mockRejectedValue(new Error('fatal: removal failed'));

    fake.send({ command: 'removeWorktree', id: 'w1' });
    await flushDispatches();

    const messages = postedMessages(fake.posted);
    const error = messages.find((m) => m.command === 'worktreeError');
    expect(error).toMatchObject({
      error: 'fatal: removal failed',
      operation: 'remove',
      instanceId: testInstance.id,
      owner: 'owner',
      repo: 'repo',
      index: 1,
    });
    // No toast from the manager and no removal confirmation: the record stays.
    expect(vscode.window.showErrorMessage).not.toHaveBeenCalled();
    expect(messages.some((m) => m.command === 'worktreeRemoved')).toBe(false);
    const list = messages.find((m) => m.command === 'worktreesList');
    expect(list).toBeDefined();
    expect((list!.worktrees as unknown[]).length).toBe(1);
  });

  it('dedupes a double-submitted removeWorktree for the same worktree', async () => {
    const worktree = {
      id: 'w1',
      instanceId: testInstance.id,
      owner: 'owner',
      repo: 'repo',
      prIndex: 1,
      prTitle: 'title',
      headBranch: 'feature',
      headSha: 'abc1234',
      baseBranch: 'main',
      sourceRepoPath: process.cwd(),
      worktreePath: '/cache/worktrees/w1',
      createdAt: 0,
    };
    await context.globalState.update('forgejoToolkit.worktrees', [worktree]);
    let finishGit!: () => void;
    vi.mocked(removeWorktreeAndPrune).mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          finishGit = resolve;
        }),
    );

    fake.send({ command: 'removeWorktree', id: 'w1' });
    fake.send({ command: 'removeWorktree', id: 'w1' });
    await flushUntil(() => vi.mocked(removeWorktreeAndPrune).mock.calls.length > 0);
    finishGit();
    await flushUntil(() => postedMessages(fake.posted).some((m) => m.command === 'worktreeRemoved'));

    // The second message reuses the in-flight removal instead of running the
    // git steps against the same path again.
    expect(vi.mocked(removeWorktreeAndPrune)).toHaveBeenCalledTimes(1);
    expect(postedMessages(fake.posted).filter((m) => m.command === 'worktreeRemoved')).toHaveLength(1);
  });

  describe('mutation requests targeting a deleted instance', () => {
    const cases: Array<{
      command: string;
      result: string;
      message: Record<string, unknown>;
      echo: Record<string, unknown>;
    }> = [
      {
        command: 'editIssue',
        result: 'issueUpdated',
        message: { owner: 'owner', repo: 'repo', index: 5, data: { title: 'x' } },
        echo: { owner: 'owner', repo: 'repo', index: 5 },
      },
      {
        command: 'deleteIssue',
        result: 'issueDeleted',
        message: { owner: 'owner', repo: 'repo', index: 5 },
        echo: { owner: 'owner', repo: 'repo', index: 5 },
      },
      {
        command: 'editPullRequest',
        result: 'pullRequestUpdated',
        message: { owner: 'owner', repo: 'repo', index: 5, data: { title: 'x' } },
        echo: { owner: 'owner', repo: 'repo', index: 5 },
      },
      {
        command: 'mergePullRequest',
        result: 'pullRequestMerged',
        message: { owner: 'owner', repo: 'repo', index: 5, strategy: 'merge' },
        echo: { owner: 'owner', repo: 'repo', index: 5 },
      },
      {
        command: 'revertMergeCommit',
        result: 'revertMergeCommitResult',
        message: { owner: 'owner', repo: 'repo', index: 5 },
        echo: { owner: 'owner', repo: 'repo', index: 5 },
      },
      {
        command: 'editIssueComment',
        result: 'issueCommentEdited',
        message: { owner: 'owner', repo: 'repo', commentId: 7, body: 'x' },
        echo: { owner: 'owner', repo: 'repo', commentId: 7 },
      },
      {
        command: 'deleteIssueComment',
        result: 'issueCommentDeleted',
        message: { owner: 'owner', repo: 'repo', commentId: 7 },
        echo: { owner: 'owner', repo: 'repo', commentId: 7 },
      },
      {
        command: 'changeIssueSubscription',
        result: 'issueSubscriptionChanged',
        message: { owner: 'owner', repo: 'repo', index: 5, user: 'user', subscribe: true },
        echo: { owner: 'owner', repo: 'repo', index: 5 },
      },
      {
        command: 'changeIssueReaction',
        result: 'issueReactionChanged',
        message: { owner: 'owner', repo: 'repo', index: 5, content: '+1', add: true },
        echo: { owner: 'owner', repo: 'repo', index: 5, content: '+1' },
      },
      {
        command: 'changeCommentReaction',
        result: 'commentReactionChanged',
        message: { owner: 'owner', repo: 'repo', commentId: 7, content: '+1', add: true },
        echo: { owner: 'owner', repo: 'repo', commentId: 7, content: '+1' },
      },
      {
        command: 'startIssueStopwatch',
        result: 'issueStopwatchChanged',
        message: { owner: 'owner', repo: 'repo', index: 5 },
        echo: { owner: 'owner', repo: 'repo', index: 5 },
      },
      {
        command: 'stopIssueStopwatch',
        result: 'issueStopwatchChanged',
        message: { owner: 'owner', repo: 'repo', index: 5 },
        echo: { owner: 'owner', repo: 'repo', index: 5 },
      },
      {
        command: 'deleteIssueStopwatch',
        result: 'issueStopwatchChanged',
        message: { owner: 'owner', repo: 'repo', index: 5 },
        echo: { owner: 'owner', repo: 'repo', index: 5 },
      },
      {
        command: 'addIssueTime',
        result: 'issueTimeAdded',
        message: { owner: 'owner', repo: 'repo', index: 5, time: 60 },
        echo: { owner: 'owner', repo: 'repo', index: 5 },
      },
      {
        command: 'resetIssueTime',
        result: 'issueTimeReset',
        message: { owner: 'owner', repo: 'repo', index: 5 },
        echo: { owner: 'owner', repo: 'repo', index: 5 },
      },
      {
        command: 'deleteIssueTime',
        result: 'issueTimeDeleted',
        message: { owner: 'owner', repo: 'repo', index: 5, id: 9 },
        echo: { owner: 'owner', repo: 'repo', index: 5, id: 9 },
      },
      {
        command: 'createIssueDependency',
        result: 'issueDependencyChanged',
        message: { owner: 'owner', repo: 'repo', index: 5, dependencyIndex: 6 },
        echo: { owner: 'owner', repo: 'repo', index: 5, dependencyIndex: 6 },
      },
      {
        command: 'removeIssueDependency',
        result: 'issueDependencyChanged',
        message: { owner: 'owner', repo: 'repo', index: 5, dependencyIndex: 6 },
        echo: { owner: 'owner', repo: 'repo', index: 5, dependencyIndex: 6 },
      },
      {
        command: 'dispatchWorkflow',
        result: 'actionRunDispatched',
        message: { owner: 'owner', repo: 'repo', workflowfilename: 'ci.yml', ref: 'main' },
        echo: { owner: 'owner', repo: 'repo', workflowfilename: 'ci.yml' },
      },
      {
        command: 'cancelActionRun',
        result: 'actionRunCancelled',
        message: { owner: 'owner', repo: 'repo', runId: 3 },
        echo: { owner: 'owner', repo: 'repo', runId: 3 },
      },
      {
        command: 'deleteActionRun',
        result: 'actionRunDeleted',
        message: { owner: 'owner', repo: 'repo', runId: 3 },
        echo: { owner: 'owner', repo: 'repo', runId: 3 },
      },
      {
        command: 'downloadActionArtifact',
        result: 'actionArtifactDownloaded',
        message: { owner: 'owner', repo: 'repo', artifactId: 4, name: 'logs' },
        echo: { owner: 'owner', repo: 'repo', artifactId: 4 },
      },
      {
        command: 'editRepoRelease',
        result: 'repoReleaseEdited',
        message: { owner: 'owner', repo: 'repo', id: 2, data: { name: 'v2' } },
        echo: { owner: 'owner', repo: 'repo' },
      },
      {
        command: 'deleteRepoRelease',
        result: 'repoReleaseDeleted',
        message: { owner: 'owner', repo: 'repo', id: 2 },
        echo: { owner: 'owner', repo: 'repo' },
      },
    ];

    for (const { command, result, message, echo } of cases) {
      it(`replies ${result} with an error for ${command}`, async () => {
        fake.send({ command, instanceId: 'unknown-instance', ...message });
        await flushDispatches();

        const reply = postedMessages(fake.posted).find((m) => m.command === result);
        expect(reply).toBeDefined();
        expect(typeof reply?.error).toBe('string');
        expect(reply).toMatchObject({ instanceId: 'unknown-instance', ...echo });
      });
    }

    it('echoes stateToggle/dueDateUpdate routing flags for editIssue', async () => {
      fake.send({
        command: 'editIssue',
        instanceId: 'unknown-instance',
        owner: 'owner',
        repo: 'repo',
        index: 5,
        data: { state: 'closed', state_toggle: true },
      });
      await flushDispatches();

      const reply = postedMessages(fake.posted).find((m) => m.command === 'issueUpdated');
      expect(reply).toBeDefined();
      expect(reply?.stateToggle).toBe(true);
      expect(reply?.dueDateUpdate).toBeUndefined();
      expect(typeof reply?.error).toBe('string');
    });

    it('echoes stateToggle/dueDateUpdate routing flags for editPullRequest', async () => {
      fake.send({
        command: 'editPullRequest',
        instanceId: 'unknown-instance',
        owner: 'owner',
        repo: 'repo',
        index: 5,
        data: { due_date: null, due_date_update: true },
      });
      await flushDispatches();

      const reply = postedMessages(fake.posted).find((m) => m.command === 'pullRequestUpdated');
      expect(reply).toBeDefined();
      expect(reply?.dueDateUpdate).toBe(true);
      expect(reply?.stateToggle).toBeUndefined();
      expect(typeof reply?.error).toBe('string');
    });
  });

  describe('getMyIssues/getMyPullRequests state echo', () => {
    it('echoes the requested state on myIssues replies', async () => {
      clientMocks.getUserIssues.mockResolvedValue([]);
      fake.send({ command: 'getMyIssues', instanceId: testInstance.id, state: 'closed' });
      await flushDispatches();

      expect(clientMocks.getUserIssues).toHaveBeenCalledWith('closed');
      const reply = postedMessages(fake.posted).find((m) => m.command === 'myIssues');
      expect(reply).toMatchObject({ instanceId: testInstance.id, state: 'closed' });
    });

    it('defaults the echoed state to open when the request omits it', async () => {
      clientMocks.getUserIssues.mockResolvedValue([]);
      fake.send({ command: 'getMyIssues', instanceId: testInstance.id });
      await flushDispatches();

      const reply = postedMessages(fake.posted).find((m) => m.command === 'myIssues');
      expect(reply).toMatchObject({ instanceId: testInstance.id, state: 'open' });
    });

    it('echoes the requested state on myIssues error replies', async () => {
      clientMocks.getUserIssues.mockRejectedValue(new Error('API down'));
      fake.send({ command: 'getMyIssues', instanceId: testInstance.id, state: 'closed' });
      await flushDispatches();

      const reply = postedMessages(fake.posted).find((m) => m.command === 'myIssues');
      expect(reply).toMatchObject({ instanceId: testInstance.id, state: 'closed', error: 'API down' });
    });

    it('echoes the requested state on myPullRequests replies', async () => {
      clientMocks.getUserPullRequests.mockResolvedValue([]);
      fake.send({ command: 'getMyPullRequests', instanceId: testInstance.id, state: 'closed' });
      await flushDispatches();

      expect(clientMocks.getUserPullRequests).toHaveBeenCalledWith('closed');
      const reply = postedMessages(fake.posted).find((m) => m.command === 'myPullRequests');
      expect(reply).toMatchObject({ instanceId: testInstance.id, state: 'closed' });
    });
  });

  describe('openPrWorktree bare clone dedup', () => {
    let cacheDir: string;

    beforeEach(() => {
      cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'worktree-cache-dedup-'));
    });

    afterEach(() => {
      fs.rmSync(cacheDir, { recursive: true, force: true });
    });

    function primeClonePath() {
      // No workspace repo and no local clone: both opens land on the
      // "Clone to cache directory" picker answer.
      vi.mocked(isCurrentWorkspaceBaseRepo).mockResolvedValue(undefined as never);
      vi.spyOn(config, 'getWorktreeOpenMode').mockReturnValue('newWindow');
      vi.spyOn(config, 'getWorktreeCacheDirectory').mockReturnValue(cacheDir);
      clientMocks.getPullRequestDetail.mockResolvedValue({
        title: 'Demo PR',
        head: { ref: 'feature', sha: 'abcdef1234567890' },
        base: { ref: 'main' },
      });
      vi.mocked(vscode.window.showQuickPick).mockImplementation(async (items) => {
        const list = items as unknown as Array<{ value?: string }>;
        return list.find((item) => item.value === 'clone') as never;
      });
      vi.mocked(getRefCommitSha).mockResolvedValue('abcdef1234567890');
    }

    it('runs a single bare clone when two PRs of the same repository are opened concurrently', async () => {
      primeClonePath();
      let finishClone!: () => void;
      vi.mocked(cloneRepository).mockImplementation(
        () =>
          new Promise<void>((resolve) => {
            finishClone = resolve;
          }),
      );

      fake.send({ command: 'openPrWorktree', instanceId: testInstance.id, owner: 'owner', repo: 'repo', index: 1 });
      fake.send({ command: 'openPrWorktree', instanceId: testInstance.id, owner: 'owner', repo: 'repo', index: 2 });
      await flushUntil(() => vi.mocked(cloneRepository).mock.calls.length > 0);
      finishClone();
      await flushUntil(() => postedMessages(fake.posted).filter((m) => m.command === 'worktreeOpened').length === 2);

      // The second open waited on the first clone's promise instead of running
      // `git clone --bare` into the same cache path again.
      expect(vi.mocked(cloneRepository)).toHaveBeenCalledTimes(1);
      expect(postedMessages(fake.posted).filter((m) => m.command === 'worktreeOpened')).toHaveLength(2);
    });

    it('reuses the cache path without a second clone once the first clone finished', async () => {
      primeClonePath();
      vi.mocked(cloneRepository).mockImplementation(async (_url: string, target: string) => {
        await fs.promises.mkdir(target, { recursive: true });
      });

      fake.send({ command: 'openPrWorktree', instanceId: testInstance.id, owner: 'owner', repo: 'repo', index: 1 });
      await flushUntil(() => postedMessages(fake.posted).some((m) => m.command === 'worktreeOpened'));
      fake.send({ command: 'openPrWorktree', instanceId: testInstance.id, owner: 'owner', repo: 'repo', index: 2 });
      await flushUntil(() => postedMessages(fake.posted).filter((m) => m.command === 'worktreeOpened').length === 2);

      // Sequential opens: the second sees the completed clone on disk (the
      // picker offered "Open cached bare repository") and never clones again.
      expect(vi.mocked(cloneRepository)).toHaveBeenCalledTimes(1);
      expect(postedMessages(fake.posted).filter((m) => m.command === 'worktreeOpened')).toHaveLength(2);
    });
  });

  describe('openPrWorktree recorded worktree revalidation', () => {
    let worktreeDir: string;

    beforeEach(() => {
      worktreeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'recorded-worktree-'));
      vi.mocked(validatePrWorktree).mockReset();
      vi.mocked(fetchPullRequestHead).mockReset();
      vi.mocked(createWorktreeFromBranch).mockReset();
      vi.mocked(deleteBranch).mockClear();
      vi.spyOn(config, 'getWorktreeOpenMode').mockReturnValue('newWindow');
    });

    afterEach(() => {
      fs.rmSync(worktreeDir, { recursive: true, force: true });
    });

    function seedRecordedPrWorktree(headSha: string) {
      const worktree = {
        id: `${testInstance.id}:owner/repo#pr-1`,
        instanceId: testInstance.id,
        owner: 'owner',
        repo: 'repo',
        prIndex: 1,
        prTitle: 'Demo PR',
        headBranch: 'feature',
        headSha,
        baseBranch: 'main',
        sourceRepoPath: '/src/repo',
        worktreePath: worktreeDir,
        createdAt: 0,
      };
      return context.globalState.update('forgejoToolkit.worktrees', [worktree]);
    }

    it('reopens a recorded worktree directly when the PR head is unchanged', async () => {
      await seedRecordedPrWorktree('abc1234567890');
      clientMocks.getPullRequestDetail.mockResolvedValue({
        title: 'Demo PR',
        head: { ref: 'feature', sha: 'abc1234567890' },
        base: { ref: 'main' },
      });

      fake.send({ command: 'openPrWorktree', instanceId: testInstance.id, owner: 'owner', repo: 'repo', index: 1 });
      await flushUntil(() => postedMessages(fake.posted).some((m) => m.command === 'worktreeOpened'));

      const opened = postedMessages(fake.posted).find((m) => m.command === 'worktreeOpened');
      expect(opened).toMatchObject({ existed: true });
      expect(vi.mocked(openWorktree)).toHaveBeenCalledWith(worktreeDir, true);
      // No rebuild: the head sha matched the record, so nothing was fetched or recreated.
      expect(clientMocks.getPullRequestDetail).toHaveBeenCalledTimes(1);
      expect(vi.mocked(validatePrWorktree)).not.toHaveBeenCalled();
      expect(vi.mocked(fetchPullRequestHead)).not.toHaveBeenCalled();
      expect(vi.mocked(createWorktreeFromBranch)).not.toHaveBeenCalled();
    });

    it('rebuilds a recorded worktree when the PR head changed', async () => {
      await seedRecordedPrWorktree('old-sha-0000001');
      clientMocks.getPullRequestDetail.mockResolvedValue({
        title: 'Demo PR',
        head: { ref: 'feature', sha: 'newsha1234567890' },
        base: { ref: 'main' },
      });
      vi.mocked(isCurrentWorkspaceBaseRepo).mockResolvedValue('/src/repo' as never);
      vi.mocked(validatePrWorktree).mockResolvedValue('stale');
      vi.mocked(getRefCommitSha).mockResolvedValue('newsha1234567890');

      fake.send({ command: 'openPrWorktree', instanceId: testInstance.id, owner: 'owner', repo: 'repo', index: 1 });
      await flushUntil(() => postedMessages(fake.posted).some((m) => m.command === 'worktreeOpened'));

      // The recorded directory went through the same stale validation as a
      // leftover directory (which removes it and its throwaway branch).
      expect(vi.mocked(validatePrWorktree)).toHaveBeenCalledWith('/src/repo', worktreeDir, 'newsha1234567890');
      // The rebuild fetched the new head onto a new throwaway branch.
      expect(vi.mocked(fetchPullRequestHead)).toHaveBeenCalledWith(
        '/src/repo',
        'origin',
        1,
        'pr-1-newsha1',
        'secret-token',
      );
      expect(vi.mocked(createWorktreeFromBranch)).toHaveBeenCalled();
      const opened = postedMessages(fake.posted).find((m) => m.command === 'worktreeOpened');
      expect(opened).toMatchObject({ existed: false });
      // The PR detail fetched for the revalidation is reused for the rebuild.
      expect(clientMocks.getPullRequestDetail).toHaveBeenCalledTimes(1);
      // The record now tracks the new head.
      const records = context.globalState.get('forgejoToolkit.worktrees') as Array<Record<string, unknown>>;
      expect(records).toHaveLength(1);
      expect(records[0].headSha).toBe('newsha1234567890');
    });

    it('reports an error instead of opening when the current head cannot be fetched', async () => {
      await seedRecordedPrWorktree('abc1234567890');
      clientMocks.getPullRequestDetail.mockRejectedValue(new Error('network down'));

      fake.send({ command: 'openPrWorktree', instanceId: testInstance.id, owner: 'owner', repo: 'repo', index: 1 });
      await flushUntil(() => postedMessages(fake.posted).some((m) => m.command === 'worktreeError'));

      const error = postedMessages(fake.posted).find((m) => m.command === 'worktreeError');
      expect(error).toMatchObject({
        error: 'network down',
        operation: 'open',
        instanceId: testInstance.id,
        owner: 'owner',
        repo: 'repo',
        index: 1,
      });
      expect(vi.mocked(openWorktree)).not.toHaveBeenCalled();
    });

    it('does not revalidate issue worktrees', async () => {
      const issueWorktree = {
        id: `${testInstance.id}:owner/repo#issue-5`,
        kind: 'issue',
        instanceId: testInstance.id,
        owner: 'owner',
        repo: 'repo',
        prIndex: 5,
        prTitle: 'Issue #5',
        headBranch: 'issue-5-fix-bug',
        headSha: '',
        baseBranch: 'main',
        sourceRepoPath: '/src/repo',
        worktreePath: worktreeDir,
        createdAt: 0,
      };
      await context.globalState.update('forgejoToolkit.worktrees', [issueWorktree]);
      clientMocks.getPullRequestDetail.mockResolvedValue({
        title: 'Demo PR',
        head: { ref: 'feature', sha: 'abc1234567890' },
        base: { ref: 'main' },
      });
      vi.mocked(isCurrentWorkspaceBaseRepo).mockResolvedValue('/src/repo' as never);
      vi.mocked(validatePrWorktree).mockResolvedValue('missing');
      vi.mocked(getRefCommitSha).mockResolvedValue('abc1234567890');

      fake.send({ command: 'openPrWorktree', instanceId: testInstance.id, owner: 'owner', repo: 'repo', index: 5 });
      await flushUntil(() => postedMessages(fake.posted).some((m) => m.command === 'worktreeOpened'));

      // The issue record is invisible to the PR reopen flow: its directory was
      // never opened or revalidated and the record stays untouched.
      expect(vi.mocked(openWorktree)).not.toHaveBeenCalledWith(worktreeDir, true);
      expect(vi.mocked(validatePrWorktree)).not.toHaveBeenCalledWith('/src/repo', worktreeDir, expect.anything());
      const records = context.globalState.get('forgejoToolkit.worktrees') as Array<Record<string, unknown>>;
      const issueRecord = records.find((r) => r.id === issueWorktree.id);
      expect(issueRecord).toMatchObject({ kind: 'issue', headBranch: 'issue-5-fix-bug' });
    });
  });

  it('opens a renamed file diff with the old path on the base side', async () => {
    fake.send({
      command: 'openPullRequestDiff',
      instanceId: testInstance.id,
      owner: 'owner',
      repo: 'repo',
      index: 2,
      filename: 'src/new-name.ts',
      status: 'renamed',
      previousFilename: 'src/old-name.ts',
      baseSha: 'base1',
      headSha: 'head1',
    });
    await flushDispatches();

    const diffCall = vi.mocked(vscode.commands.executeCommand).mock.calls.find((call) => call[0] === 'vscode.diff');
    expect(diffCall).toBeDefined();
    expect((diffCall![1] as { path: string }).path).toContain('src/old-name.ts');
    expect((diffCall![2] as { path: string }).path).toContain('src/new-name.ts');
  });

  it('opens selected diffs with the old base path for renamed files', async () => {
    fake.send({
      command: 'openSelectedPullRequestDiffs',
      instanceId: testInstance.id,
      owner: 'owner',
      repo: 'repo',
      index: 2,
      files: [
        { filename: 'src/new-name.ts', status: 'renamed', previous_filename: 'src/old-name.ts' },
        { filename: 'src/touched.ts', status: 'modified' },
      ],
      baseSha: 'base1',
      headSha: 'head1',
    });
    await flushDispatches();

    const changesCall = vi
      .mocked(vscode.commands.executeCommand)
      .mock.calls.find((call) => call[0] === 'vscode.changes');
    expect(changesCall).toBeDefined();
    const resources = changesCall?.[2] as Array<Array<{ path: string } | undefined>>;
    // Renamed: [headUri, baseUri, headUri] with base under the old path.
    expect(resources[0][1]?.path).toContain('src/old-name.ts');
    expect(resources[0][0]?.path).toContain('src/new-name.ts');
    // Untouched files keep the same path on both sides.
    expect(resources[1][1]?.path).toContain('src/touched.ts');
  });

  it('strips state_toggle before the API call and echoes stateToggle on success', async () => {
    clientMocks.editIssue.mockResolvedValue({ number: 5, title: 'demo' });
    fake.send({
      command: 'editIssue',
      instanceId: testInstance.id,
      owner: 'owner',
      repo: 'repo',
      index: 5,
      data: { state: 'closed', state_toggle: true },
    });
    await flushDispatches();

    expect(clientMocks.editIssue).toHaveBeenCalledWith('owner', 'repo', 5, { state: 'closed' });
    const reply = postedMessages(fake.posted).find((m) => m.command === 'issueUpdated');
    expect(reply).toBeDefined();
    expect(reply?.stateToggle).toBe(true);
    expect(reply?.error).toBeUndefined();
  });

  it('echoes stateToggle on editIssue failure so the webview routes the error to the toggle button', async () => {
    clientMocks.editIssue.mockRejectedValue(new Error('API down'));
    fake.send({
      command: 'editIssue',
      instanceId: testInstance.id,
      owner: 'owner',
      repo: 'repo',
      index: 5,
      data: { state: 'closed', state_toggle: true },
    });
    await flushDispatches();

    const reply = postedMessages(fake.posted).find((m) => m.command === 'issueUpdated');
    expect(reply).toBeDefined();
    expect(reply?.stateToggle).toBe(true);
    expect(reply?.error).toBe('API down');
  });

  it('pushNotificationError replies with polledNotifications carrying the error', async () => {
    provider.pushNotificationError(testInstance.id, 'instance unreachable');
    await flushDispatches();

    const reply = postedMessages(fake.posted).find((m) => m.command === 'polledNotifications');
    expect(reply).toBeDefined();
    expect(reply?.instanceId).toBe(testInstance.id);
    expect(reply?.error).toBe('instance unreachable');
    expect(reply?.notifications).toBeUndefined();
  });

  it('openSettings reveals the resolved view and posts the openSettings message', async () => {
    provider.openSettings();

    expect(fake.view.show).toHaveBeenCalledWith(false);
    expect(postedMessages(fake.posted).some((m) => m.command === 'openSettings')).toBe(true);
  });

  it('openSettings focuses the view id when the view has never been resolved', async () => {
    const freshProvider = new ForgejoToolkitViewProvider(
      context as never,
      context.extensionUri as never,
      config,
      new ReadmeContentProvider(),
    );
    const executeCommand = vi.mocked(vscode.commands.executeCommand);
    executeCommand.mockClear();

    freshProvider.openSettings();

    expect(executeCommand).toHaveBeenCalledWith('forgejoToolkitView.focus');
  });

  describe('startWorkOnIssue', () => {
    it('creates a worktree on a new issue branch from the default branch tip', async () => {
      vi.mocked(isCurrentWorkspaceBaseRepo).mockResolvedValue('/src/repo');
      vi.spyOn(config, 'getWorktreeOpenMode').mockReturnValue('newWindow');
      clientMocks.getRepoDetail.mockResolvedValue({ repository: { default_branch: 'main' } });

      fake.send({
        command: 'startWorkOnIssue',
        instanceId: testInstance.id,
        owner: 'owner',
        repo: 'repo',
        index: 5,
        title: 'fix-bug',
      });
      await flushDispatches();

      const reply = postedMessages(fake.posted).find((m) => m.command === 'startWorkResult');
      expect(reply).toMatchObject({ instanceId: testInstance.id, owner: 'owner', repo: 'repo', index: 5 });
      expect(reply?.error).toBeUndefined();
      expect(reply?.cancelled).toBeUndefined();
      expect(vi.mocked(fetchBranch)).toHaveBeenCalledWith('/src/repo', 'origin', 'main', 'secret-token');
      expect(vi.mocked(createWorktreeWithNewBranch)).toHaveBeenCalledWith(
        '/src/repo',
        expect.stringContaining('owner-repo-issue-5-fix-bug'),
        'issue-5-fix-bug',
        'FETCH_HEAD',
      );
      expect(vi.mocked(openWorktree)).toHaveBeenCalledWith(
        expect.stringContaining('owner-repo-issue-5-fix-bug'),
        true,
        expect.any(Function),
      );
    });

    it('replies startWorkResult with an error when the instance is unknown', async () => {
      fake.send({
        command: 'startWorkOnIssue',
        instanceId: 'unknown-instance',
        owner: 'owner',
        repo: 'repo',
        index: 5,
      });
      await flushDispatches();

      const reply = postedMessages(fake.posted).find((m) => m.command === 'startWorkResult');
      expect(reply).toBeDefined();
      expect(typeof reply?.error).toBe('string');
      expect(vi.mocked(fetchBranch)).not.toHaveBeenCalled();
      expect(vi.mocked(createWorktreeWithNewBranch)).not.toHaveBeenCalled();
    });

    it('replies startWorkResult with an error when fetching the default branch fails', async () => {
      vi.mocked(isCurrentWorkspaceBaseRepo).mockResolvedValue('/src/repo');
      vi.spyOn(config, 'getWorktreeOpenMode').mockReturnValue('currentWindow');
      clientMocks.getRepoDetail.mockResolvedValue({ repository: { default_branch: 'main' } });
      vi.mocked(fetchBranch).mockRejectedValue(new Error('fatal: could not fetch'));

      fake.send({
        command: 'startWorkOnIssue',
        instanceId: testInstance.id,
        owner: 'owner',
        repo: 'repo',
        index: 5,
        title: 'fix-bug',
      });
      await flushDispatches();

      const reply = postedMessages(fake.posted).find((m) => m.command === 'startWorkResult');
      expect(reply?.error).toBe('fatal: could not fetch');
      expect(vi.mocked(createWorktreeWithNewBranch)).not.toHaveBeenCalled();
      expect(vi.mocked(openWorktree)).not.toHaveBeenCalled();
    });

    it('fetches through the remote resolved for the repo, not a hardcoded origin', async () => {
      vi.mocked(isCurrentWorkspaceBaseRepo).mockResolvedValue('/src/repo');
      vi.mocked(resolveRemoteForRepo).mockResolvedValue('upstream');
      vi.spyOn(config, 'getWorktreeOpenMode').mockReturnValue('newWindow');
      clientMocks.getRepoDetail.mockResolvedValue({ repository: { default_branch: 'main' } });

      fake.send({
        command: 'startWorkOnIssue',
        instanceId: testInstance.id,
        owner: 'owner',
        repo: 'repo',
        index: 5,
        title: 'fix-bug',
      });
      await flushDispatches();

      const reply = postedMessages(fake.posted).find((m) => m.command === 'startWorkResult');
      expect(reply?.error).toBeUndefined();
      expect(vi.mocked(resolveRemoteForRepo)).toHaveBeenCalledWith('/src/repo', testInstance.url, 'owner', 'repo');
      expect(vi.mocked(fetchBranch)).toHaveBeenCalledWith('/src/repo', 'upstream', 'main', 'secret-token');
    });

    it('replies startWorkResult with an error when no remote matches the repo', async () => {
      vi.mocked(isCurrentWorkspaceBaseRepo).mockResolvedValue('/src/repo');
      vi.mocked(resolveRemoteForRepo).mockResolvedValue(undefined);
      vi.spyOn(config, 'getWorktreeOpenMode').mockReturnValue('newWindow');
      clientMocks.getRepoDetail.mockResolvedValue({ repository: { default_branch: 'main' } });

      fake.send({
        command: 'startWorkOnIssue',
        instanceId: testInstance.id,
        owner: 'owner',
        repo: 'repo',
        index: 5,
        title: 'fix-bug',
      });
      await flushDispatches();

      const reply = postedMessages(fake.posted).find((m) => m.command === 'startWorkResult');
      expect(typeof reply?.error).toBe('string');
      expect(vi.mocked(fetchBranch)).not.toHaveBeenCalled();
      expect(vi.mocked(createWorktreeWithNewBranch)).not.toHaveBeenCalled();
    });
  });

  describe('_resolveAvatarUrl', () => {
    const resolveAvatar = (url: string) =>
      (
        provider as unknown as {
          _resolveAvatarUrl: (url: string, instance: ForgejoInstance) => Promise<string>;
        }
      )._resolveAvatarUrl(url, testInstance);

    afterEach(() => {
      vi.unstubAllGlobals();
      vi.useRealTimers();
      clearResolvedAvatarCache();
    });

    function stubAvatarFetch(status = 200) {
      return vi.fn().mockResolvedValue({
        ok: status >= 200 && status < 300,
        status,
        statusText: status === 200 ? 'OK' : 'Error',
        arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer,
        headers: { get: () => 'image/png' },
      });
    }

    it('proxies same-origin avatar URLs through the host with the instance token', async () => {
      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        statusText: 'OK',
        arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer,
        headers: { get: () => 'image/png' },
      });
      vi.stubGlobal('fetch', fetchMock);

      const resolved = await resolveAvatar(`${testInstance.url}/avatars/user.png`);

      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [target, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(target).toBe(`${testInstance.url}/avatars/user.png`);
      expect((init.headers as Record<string, string>).Authorization).toBe('token secret-token');
      expect(resolved).toBe('data:image/png;base64,AQID');
    });

    it('returns third-party avatar URLs unchanged without fetching them', async () => {
      const fetchMock = vi.fn();
      vi.stubGlobal('fetch', fetchMock);
      const url = 'https://gravatar.example.com/avatar/abc';

      expect(await resolveAvatar(url)).toBe(url);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('does not let the host fetch intranet targets planted in avatar_url', async () => {
      const fetchMock = vi.fn();
      vi.stubGlobal('fetch', fetchMock);
      const url = 'http://internal.example.com/avatar.png';

      expect(await resolveAvatar(url)).toBe(url);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('passes data: URLs through unchanged', async () => {
      const fetchMock = vi.fn();
      vi.stubGlobal('fetch', fetchMock);
      const url = 'data:image/png;base64,AAAA';

      expect(await resolveAvatar(url)).toBe(url);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('fetches a repeated same-origin URL only once per session', async () => {
      const fetchMock = stubAvatarFetch();
      vi.stubGlobal('fetch', fetchMock);
      const url = `${testInstance.url}/avatars/repeated.png`;

      expect(await resolveAvatar(url)).toBe('data:image/png;base64,AQID');
      expect(await resolveAvatar(url)).toBe('data:image/png;base64,AQID');
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('shares one fetch between concurrent resolutions of the same URL', async () => {
      const fetchMock = stubAvatarFetch();
      vi.stubGlobal('fetch', fetchMock);
      const url = `${testInstance.url}/avatars/concurrent.png`;

      const [a, b] = await Promise.all([resolveAvatar(url), resolveAvatar(url)]);
      expect(a).toBe('data:image/png;base64,AQID');
      expect(b).toBe('data:image/png;base64,AQID');
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('dedupes avatar URLs within a single _resolveCommitAvatars call', async () => {
      const fetchMock = stubAvatarFetch();
      vi.stubGlobal('fetch', fetchMock);
      const shared = `${testInstance.url}/avatars/shared.png`;
      const other = `${testInstance.url}/avatars/other.png`;
      const commit = (sha: string, avatar: string) => ({
        sha,
        commit: {},
        author: { avatar_url: avatar },
        committer: { avatar_url: avatar },
        html_url: `${testInstance.url}/owner/repo/commit/${sha}`,
      });
      const detail = {
        repository: {},
        branches: ['main'],
        recentCommits: [commit('a'.repeat(40), shared), commit('b'.repeat(40), shared), commit('c'.repeat(40), other)],
      };

      const resolved = await (
        provider as unknown as {
          _resolveCommitAvatars: (d: typeof detail, i: ForgejoInstance) => Promise<typeof detail>;
        }
      )._resolveCommitAvatars(detail, testInstance);

      // Two unique URLs across 3 commits x (author + committer) = 2 fetches.
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(resolved.recentCommits[0].author?.avatar_url).toBe('data:image/png;base64,AQID');
      expect(resolved.recentCommits[1].committer?.avatar_url).toBe('data:image/png;base64,AQID');
      expect(resolved.recentCommits[2].author?.avatar_url).toBe('data:image/png;base64,AQID');
    });

    it('evicts the least recently used avatar once the cache exceeds 100 entries', async () => {
      const fetchMock = stubAvatarFetch();
      vi.stubGlobal('fetch', fetchMock);
      const urlAt = (n: number) => `${testInstance.url}/avatars/evict-${n}.png`;

      for (let i = 0; i < 100; i++) {
        await resolveAvatar(urlAt(i));
      }
      expect(fetchMock).toHaveBeenCalledTimes(100);

      // Refresh urlAt(0) so it is no longer the oldest entry.
      await resolveAvatar(urlAt(0));
      expect(fetchMock).toHaveBeenCalledTimes(100);

      // The 101st unique URL evicts urlAt(1), the new oldest.
      await resolveAvatar(urlAt(100));
      expect(fetchMock).toHaveBeenCalledTimes(101);

      await resolveAvatar(urlAt(0));
      expect(fetchMock).toHaveBeenCalledTimes(101);
      await resolveAvatar(urlAt(1));
      expect(fetchMock).toHaveBeenCalledTimes(102);
    });

    it('caches failures briefly and retries after the TTL', async () => {
      const fetchMock = stubAvatarFetch(401);
      vi.stubGlobal('fetch', fetchMock);
      const url = `${testInstance.url}/avatars/private.png`;

      // Failure falls back to the original URL and is cached: no refetch yet.
      expect(await resolveAvatar(url)).toBe(url);
      expect(await resolveAvatar(url)).toBe(url);
      expect(fetchMock).toHaveBeenCalledTimes(1);

      // Past the failure TTL (e.g. after a token rotation) the URL is retried.
      vi.useFakeTimers();
      vi.advanceTimersByTime(61_000);
      expect(await resolveAvatar(url)).toBe(url);
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });
  });
});
