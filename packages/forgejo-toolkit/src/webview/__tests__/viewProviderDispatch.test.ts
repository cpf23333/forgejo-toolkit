import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as vscode from 'vscode';

const clientMocks = vi.hoisted(() => ({
  editIssue: vi.fn(),
  replaceIssueLabels: vi.fn(),
  getRepoDetail: vi.fn(),
}));

vi.mock('../../api/client', () => ({
  ForgejoClient: vi.fn().mockImplementation(function () {
    return {
      searchMentions: vi.fn().mockRejectedValue(new Error('network down')),
      getCurrentUser: vi.fn().mockResolvedValue({ login: 'user' }),
      editIssue: clientMocks.editIssue,
      replaceIssueLabels: clientMocks.replaceIssueLabels,
      getRepoDetail: clientMocks.getRepoDetail,
    };
  }),
}));

vi.mock('../../worktree/gitOperations', () => ({
  cloneRepository: vi.fn(),
  createWorktreeFromBranch: vi.fn(),
  createWorktreeWithNewBranch: vi.fn(),
  detectLinkedRepository: vi.fn(),
  fetchBranch: vi.fn(),
  fetchPullRequestHead: vi.fn(),
  findLocalRepo: vi.fn(),
  getRemoteUrl: vi.fn(),
  isCurrentWorkspaceBaseRepo: vi.fn(),
  isGitRepository: vi.fn(),
  openWorktree: vi.fn(async () => true),
  revertMergeCommit: vi.fn(),
  sanitizeForPath: vi.fn((value: string) => value),
  validatePrWorktree: vi.fn(),
  removeWorktreeAndPrune: vi.fn(),
}));

import { ForgejoToolkitViewProvider } from '../viewProvider';
import { ForgejoClient } from '../../api/client';
import {
  createWorktreeWithNewBranch,
  fetchBranch,
  isCurrentWorkspaceBaseRepo,
  openWorktree,
  removeWorktreeAndPrune,
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
    vi.mocked(fetchBranch).mockReset();
    vi.mocked(createWorktreeWithNewBranch).mockReset();
    vi.mocked(isCurrentWorkspaceBaseRepo).mockReset();
    vi.mocked(openWorktree).mockReset().mockResolvedValue(true);
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
      sourceRepoPath: '/src/repo',
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
      expect(vi.mocked(openWorktree)).toHaveBeenCalledWith(expect.stringContaining('owner-repo-issue-5-fix-bug'), true);
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
  });
});
