import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as crypto from 'crypto';
import * as vscode from 'vscode';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const clientMocks = vi.hoisted(() => ({
  getRepoContents: vi.fn(),
  getFileContentResult: vi.fn(),
  getReadmeEntry: vi.fn(),
  editIssue: vi.fn(),
  replaceIssueLabels: vi.fn(),
  getRepoDetail: vi.fn(),
  getRepoBranches: vi.fn(),
  getRepoTags: vi.fn(),
  getRepoReleases: vi.fn(),
  getPullRequestDetail: vi.fn(),
  getUserIssues: vi.fn(),
  getUserPullRequests: vi.fn(),
  getUserRepositories: vi.fn(),
  mergePullRequest: vi.fn(),
  getCurrentUser: vi.fn(),
  resetIssueTime: vi.fn(),
  deleteIssueTime: vi.fn(),
  downloadActionArtifactToFile: vi.fn(),
  invalidateRepoContentCaches: vi.fn(),
  getPullRequestFiles: vi.fn(),
  getPullRequestFilesFromCompare: vi.fn(),
  getPullRequestCommentsAndTimeline: vi.fn(),
  searchRepoFiles: vi.fn(),
  // The issue dependency / reaction / stopwatch mutations have no success-path
  // test today; they are here so a test can drive their failure reply (see
  // "failure replies echo the action the request carried").
  createIssueDependency: vi.fn(),
  removeIssueDependency: vi.fn(),
  addIssueReaction: vi.fn(),
  removeIssueReaction: vi.fn(),
  addCommentReaction: vi.fn(),
  removeCommentReaction: vi.fn(),
  startIssueStopwatch: vi.fn(),
  stopIssueStopwatch: vi.fn(),
  deleteIssueStopwatch: vi.fn(),
}));

vi.mock('../../api/client', () => ({
  API_REQUEST_TIMEOUT_MS: 30_000,
  invalidateRepoContentCaches: clientMocks.invalidateRepoContentCaches,
  ForgejoClient: vi.fn().mockImplementation(function () {
    return {
      searchMentions: vi.fn().mockRejectedValue(new Error('network down')),
      getCurrentUser: clientMocks.getCurrentUser,
      editIssue: clientMocks.editIssue,
      replaceIssueLabels: clientMocks.replaceIssueLabels,
      getRepoDetail: clientMocks.getRepoDetail,
      getRepoBranches: clientMocks.getRepoBranches,
      getRepoTags: clientMocks.getRepoTags,
      getRepoReleases: clientMocks.getRepoReleases,
      getRepoContents: clientMocks.getRepoContents,
      getFileContentResult: clientMocks.getFileContentResult,
      getReadmeEntry: clientMocks.getReadmeEntry,
      getPullRequestDetail: clientMocks.getPullRequestDetail,
      getUserIssues: clientMocks.getUserIssues,
      getUserPullRequests: clientMocks.getUserPullRequests,
      getUserRepositories: clientMocks.getUserRepositories,
      mergePullRequest: clientMocks.mergePullRequest,
      resetIssueTime: clientMocks.resetIssueTime,
      deleteIssueTime: clientMocks.deleteIssueTime,
      downloadActionArtifactToFile: clientMocks.downloadActionArtifactToFile,
      getPullRequestFiles: clientMocks.getPullRequestFiles,
      getPullRequestFilesFromCompare: clientMocks.getPullRequestFilesFromCompare,
      getPullRequestCommentsAndTimeline: clientMocks.getPullRequestCommentsAndTimeline,
      searchRepoFiles: clientMocks.searchRepoFiles,
      createIssueDependency: clientMocks.createIssueDependency,
      removeIssueDependency: clientMocks.removeIssueDependency,
      addIssueReaction: clientMocks.addIssueReaction,
      removeIssueReaction: clientMocks.removeIssueReaction,
      addCommentReaction: clientMocks.addCommentReaction,
      removeCommentReaction: clientMocks.removeCommentReaction,
      startIssueStopwatch: clientMocks.startIssueStopwatch,
      stopIssueStopwatch: clientMocks.stopIssueStopwatch,
      deleteIssueStopwatch: clientMocks.deleteIssueStopwatch,
    };
  }),
}));

vi.mock('../../worktree/gitOperations', async (importOriginal) => {
  const path = await import('node:path');
  // Keep the real comparison: the PR-worktree source check is exactly what the
  // transport/credential semantics are about, so a test double would prove
  // nothing.
  const actual = await importOriginal<typeof import('../../worktree/gitOperations')>();
  return {
    clearLinkedRepositoryCache: vi.fn(),
    cloneRepository: vi.fn(),
    createWorktreeFromBranch: vi.fn(),
    createWorktreeWithNewBranch: vi.fn(),
    deleteBranch: vi.fn(async () => undefined),
    detectLinkedRepository: vi.fn(),
    detectLinkedRepositories: vi.fn(async () => ({ linked: undefined, all: [], unpublished: [] })),
    discardStalePrWorktree: vi.fn(async () => undefined),
    fetchBranch: vi.fn(),
    fetchPullRequestHead: vi.fn(),
    findLocalRepo: vi.fn(),
    getRefCommitSha: vi.fn(),
    // Default: a directory that exists counts as a complete cache clone, so
    // tests that simulate clones by plain mkdir keep their old meaning; the
    // incomplete-remnant tests override this per case.
    hasUsableOriginRemote: vi.fn(async () => true),
    inspectPrWorktree: vi.fn(),
    isCurrentWorkspaceBaseRepo: vi.fn(),
    isGitRepository: vi.fn(),
    isRevertInProgress: vi.fn(async () => false),
    // Used by the worktree-path containment guard; keep the real semantics.
    isPathInsideFolder: (folderPath: string, filePath: string) => {
      const relative = path.relative(folderPath, filePath);
      return (
        relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)
      );
    },
    listRemotes: vi.fn(async () => []),
    openWorktree: vi.fn(async () => true),
    // The open flow's failure path gates its throwaway-branch cleanup on this
    // pattern; keep the real one so the gate itself is exercised.
    PR_THROWAWAY_BRANCH_PATTERN: actual.PR_THROWAWAY_BRANCH_PATTERN,
    // Used by the worktree create paths to ask before they create a checkout;
    // keep the real semantics (the shared vscode mock's folder state).
    requiresWorkspaceReplacement: actual.requiresWorkspaceReplacement,
    resolveRemoteForRepo: vi.fn(async () => 'origin'),
    revertMergeCommit: vi.fn(),
    sameRepositoryUrl: actual.sameRepositoryUrl,
    sanitizeForPath: vi.fn((value: string) => value),
    removeWorktreeAndPrune: vi.fn(async () => undefined),
  };
});

const proxyMocks = vi.hoisted(() => ({ getProxyFetch: vi.fn() }));
vi.mock('../../api/proxy', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../api/proxy')>();
  // Undefined by default (no proxy installed), so host-side requests fall back
  // to global fetch exactly as before; tests install a proxy fetch to assert it
  // is preferred.
  return { ...actual, getProxyFetch: proxyMocks.getProxyFetch };
});

import {
  AVATAR_CACHE_MAX_BYTES,
  AVATAR_FETCH_MAX_BYTES,
  ForgejoToolkitViewProvider,
  clearResolvedAvatarCache,
  instanceCacheSuffix,
  resolvedAvatarCacheBytesForTest,
  worktreeCloneUrl,
} from '../viewProvider';
import { ForgejoClient } from '../../api/client';
import {
  clearServerVersions,
  getServerVersion,
  MIN_SUPPORTED_VERSION_TEXT,
  setServerVersion,
} from '../../api/serverVersion';
import { logger } from '../../logger';
import {
  clearLinkedRepositoryCache,
  cloneRepository,
  createWorktreeFromBranch,
  createWorktreeWithNewBranch,
  deleteBranch,
  discardStalePrWorktree,
  fetchBranch,
  fetchPullRequestHead,
  findLocalRepo,
  getRefCommitSha,
  hasUsableOriginRemote,
  inspectPrWorktree,
  isCurrentWorkspaceBaseRepo,
  isGitRepository,
  isRevertInProgress,
  listRemotes,
  openWorktree,
  removeWorktreeAndPrune,
  resolveRemoteForRepo,
  revertMergeCommit,
} from '../../worktree/gitOperations';
import { ConfigManager } from '../../config';
import { ReadmeContentProvider } from '../../readmeProvider';
import { ACTIVE_VIEW_CONTEXT_KEY } from '../activeView';
import type { StalePrWorktreeInfo } from '../../worktree/gitOperations';
import { OnboardingWebviewPanel } from '../onboardingPanel';
import { PullReviewCommentPanel } from '../../comments/pullReviewCommentPanel';
import type { ForgejoInstance } from '@cpf23333-forgejo-toolkit/shared/webview/messages';
import { removeTempDirSync } from '../../__tests__/tempDir';

type MessageListener = (message: unknown) => void;

/**
 * The fake context's secret storage as the tests drive it: the same three methods
 * production calls, plus the map behind them so a case can seed a stored credential
 * and read back what an import wrote.
 */
type FakeSecretStore = {
  get: (key: string) => Promise<string | undefined>;
  store: (key: string, value: string) => Promise<void>;
  delete: (key: string) => Promise<void>;
  clear: () => void;
  set: (key: string, value: string) => Map<string, string>;
  /** The stored values themselves, for a synchronous assertion. */
  values: Map<string, string>;
};

function createFakeContext(): {
  subscriptions: Array<{ dispose(): void }>;
  globalState: {
    get: (key: string, fallback?: unknown) => unknown;
    update: (key: string, value: unknown) => Promise<void>;
  };
  secrets: FakeSecretStore;
  globalStorageUri: { fsPath: string };
  extensionUri: { fsPath: string };
} {
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
      // Seeding and resetting are what the AI export/import cases need: they drive
      // a stored credential through the export and check which key an import wrote.
      set: (key: string, value: string) => secretStore.set(key, value),
      clear: () => secretStore.clear(),
      values: secretStore,
    },
    globalStorageUri: { fsPath: '/global-storage' },
    extensionUri: { fsPath: '/ext' },
  };
}

function createFakeView() {
  const posted: unknown[] = [];
  let listener: MessageListener | undefined;
  let disposeListener: (() => void) | undefined;
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
    onDidDispose: (l: () => void) => {
      disposeListener = l;
      return { dispose: vi.fn() };
    },
    onDidChangeVisibility: () => ({ dispose: vi.fn() }),
  };
  return {
    view,
    posted,
    send: (message: unknown) => listener?.(message),
    dispose: () => disposeListener?.(),
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
 * promises (threadpool) need more than a fixed number of ticks, and a tick
 * count that suffices locally still starves on a heavily loaded CI runner
 * (the atomic-export test got no reply within 50 ticks ≈ 90 ms there), so
 * the budget is wall-clock, not ticks.
 */
async function flushUntil(predicate: () => boolean, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate() && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

/**
 * Make the mock editor report an open workspace folder for the duration of one
 * test, and return the restore function. The shared vscode mock has an empty
 * `workspaceFolders`; current-window worktree flows only ask the
 * replace-the-workspace question when a different folder is open.
 *
 * The property is redefined (not assigned) so the restore puts it back to
 * whatever the previous test left, including "absent".
 */
function withWorkspaceFolder(folderPath: string): () => void {
  const workspace = vscode.workspace as unknown as Record<string, unknown>;
  const had = Object.prototype.hasOwnProperty.call(workspace, 'workspaceFolders');
  const previous = workspace.workspaceFolders;
  Object.defineProperty(workspace, 'workspaceFolders', {
    configurable: true,
    value: [{ uri: { fsPath: folderPath, scheme: 'file' } }],
  });
  return () => {
    if (had) {
      Object.defineProperty(workspace, 'workspaceFolders', { configurable: true, value: previous });
    } else {
      delete workspace.workspaceFolders;
    }
  };
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
    clientMocks.getRepoContents.mockReset();
    clientMocks.getFileContentResult.mockReset();
    clientMocks.getReadmeEntry.mockReset();
    clientMocks.editIssue.mockReset();
    clientMocks.replaceIssueLabels.mockReset();
    clientMocks.getRepoDetail.mockReset();
    clientMocks.getRepoBranches.mockReset();
    clientMocks.getRepoTags.mockReset();
    clientMocks.getRepoReleases.mockReset();
    clientMocks.getPullRequestDetail.mockReset();
    clientMocks.getUserIssues.mockReset();
    clientMocks.getUserPullRequests.mockReset();
    clientMocks.getUserRepositories.mockReset();
    clientMocks.mergePullRequest.mockReset();
    clientMocks.getCurrentUser.mockReset().mockResolvedValue({ login: 'user' });
    clientMocks.resetIssueTime.mockReset().mockResolvedValue(undefined);
    clientMocks.deleteIssueTime.mockReset().mockResolvedValue(undefined);
    clientMocks.downloadActionArtifactToFile.mockReset().mockResolvedValue(undefined);
    clientMocks.getPullRequestFiles.mockReset();
    clientMocks.getPullRequestFilesFromCompare.mockReset();
    clientMocks.getPullRequestCommentsAndTimeline.mockReset();
    clientMocks.searchRepoFiles.mockReset();
    clientMocks.createIssueDependency.mockReset().mockRejectedValue(new Error('API down'));
    clientMocks.removeIssueDependency.mockReset().mockRejectedValue(new Error('API down'));
    clientMocks.addIssueReaction.mockReset().mockRejectedValue(new Error('API down'));
    clientMocks.removeIssueReaction.mockReset().mockRejectedValue(new Error('API down'));
    clientMocks.addCommentReaction.mockReset().mockRejectedValue(new Error('API down'));
    clientMocks.removeCommentReaction.mockReset().mockRejectedValue(new Error('API down'));
    clientMocks.startIssueStopwatch.mockReset().mockRejectedValue(new Error('API down'));
    clientMocks.stopIssueStopwatch.mockReset().mockRejectedValue(new Error('API down'));
    clientMocks.deleteIssueStopwatch.mockReset().mockRejectedValue(new Error('API down'));
    clientMocks.invalidateRepoContentCaches.mockReset();
    vi.mocked(fetchBranch).mockReset();
    vi.mocked(createWorktreeWithNewBranch).mockReset();
    vi.mocked(isCurrentWorkspaceBaseRepo).mockReset();
    vi.mocked(cloneRepository).mockReset();
    vi.mocked(getRefCommitSha).mockReset();
    // Default "complete clone" verdict (see the mock above): per-test overrides
    // must not leak into the next test.
    vi.mocked(hasUsableOriginRemote).mockReset().mockResolvedValue(true);
    vi.mocked(removeWorktreeAndPrune).mockReset();
    vi.mocked(openWorktree).mockReset().mockResolvedValue(true);
    vi.mocked(resolveRemoteForRepo).mockReset().mockResolvedValue('origin');
    vi.mocked(clearLinkedRepositoryCache).mockReset();
    vi.mocked(findLocalRepo).mockReset();
    vi.mocked(revertMergeCommit).mockReset();
    vi.mocked(isRevertInProgress).mockReset().mockResolvedValue(false);
    clearServerVersions();
    vi.mocked(vscode.window.showQuickPick).mockReset();
    vi.mocked(vscode.window.showSaveDialog).mockReset();
    // Bare `vi.fn()`s in extension-setup (no default implementation), so
    // mockReset is safe and drops per-test mockResolvedValue leftovers; a
    // leaked showInputBox answer once made the atomic-export test pass only in
    // full-file order.
    vi.mocked(vscode.window.showInputBox).mockReset();
    vi.mocked(vscode.window.showOpenDialog).mockReset();
    // getConfiguration has a default implementation in extension-setup and
    // tests override it with mockReturnValue/mockImplementation, so neither
    // mockReset (wipes the default) nor mockClear (keeps the override) works
    // alone: reset, then restore an equivalent default.
    vi.mocked(vscode.workspace.getConfiguration)
      .mockReset()
      // `inspect` answers which configuration level a value comes from, which the
      // settings page's own surface reads (`docs/design/settings-page.md` §3.5):
      // no level set anything is the state this default models.
      .mockReturnValue({ get: vi.fn(), update: vi.fn(), inspect: vi.fn() } as never);
    vi.mocked(vscode.window.showErrorMessage).mockClear();
    proxyMocks.getProxyFetch.mockReset();
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

  describe('the sidebar view the webview reports', () => {
    /**
     * The view-title refresh items are gated on `forgejoToolkit.activeView`
     * (`contributes.menus`) and only the host can set a context key, so the
     * sidebar's webview — the one side that knows its route — reports it. Every
     * assertion below reads the key's own calls only: the host sets other context
     * keys from git scans that run on their own timers.
     */
    function activeViewContextCalls(): unknown[][] {
      return vi
        .mocked(vscode.commands.executeCommand)
        .mock.calls.filter(([command, key]) => command === 'setContext' && key === ACTIVE_VIEW_CONTEXT_KEY);
    }

    it('publishes the reported view under the context key', async () => {
      vi.mocked(vscode.commands.executeCommand).mockClear();

      fake.send({ command: 'setActiveView', view: 'pullRequestDetail' });
      await flushDispatches();

      expect(activeViewContextCalls()).toEqual([['setContext', ACTIVE_VIEW_CONTEXT_KEY, 'pullRequestDetail']]);
    });

    it('passes the "nothing to refresh" report through as itself', async () => {
      vi.mocked(vscode.commands.executeCommand).mockClear();

      fake.send({ command: 'setActiveView', view: 'none' });
      await flushDispatches();

      // No item tests this value, which is how the dashboard of an installation
      // with no instance keeps the refresh icon away.
      expect(activeViewContextCalls()).toEqual([['setContext', ACTIVE_VIEW_CONTEXT_KEY, 'none']]);
    });

    it('treats a value it does not contribute as no view at all', async () => {
      vi.mocked(vscode.commands.executeCommand).mockClear();

      fake.send({ command: 'setActiveView', view: 'someOtherExtensionsView' });
      await flushDispatches();

      // The webview is untrusted: a forged value must not make an item visible
      // for a page the host cannot name, so it is stored as the absence of a view.
      expect(activeViewContextCalls()).toEqual([['setContext', ACTIVE_VIEW_CONTEXT_KEY, undefined]]);
    });

    it('forgets the view when the webview is gone', async () => {
      fake.send({ command: 'setActiveView', view: 'issueDetail' });
      await flushDispatches();
      vi.mocked(vscode.commands.executeCommand).mockClear();

      fake.dispose();

      // An item left on screen for a webview that no longer exists would refresh
      // nothing at all, so the key goes back to "no view".
      expect(activeViewContextCalls()).toEqual([['setContext', ACTIVE_VIEW_CONTEXT_KEY, undefined]]);
    });

    it('forgets the view when a new webview is resolved', async () => {
      // Showing the sidebar again resolves a fresh webview, and the same happens
      // when instance origins change and the HTML is regenerated: that page boots
      // on its own first route, not on the one the previous page reported.
      fake.send({ command: 'setActiveView', view: 'issueDetail' });
      await flushDispatches();
      vi.mocked(vscode.commands.executeCommand).mockClear();

      provider.resolveWebviewView(fake.view as never, {} as never, {} as never);

      expect(activeViewContextCalls()).toEqual([['setContext', ACTIVE_VIEW_CONTEXT_KEY, undefined]]);
    });
  });

  describe('search truncation and attachment-availability reporting', () => {
    it('names the truncation cause on the search reply', async () => {
      // The two causes need different advice: only a hit match cap can be
      // improved by narrowing the query, while an unreadable tree cannot.
      clientMocks.searchRepoFiles.mockResolvedValue({
        files: [{ path: 'src/index.ts' }],
        truncated: true,
        truncatedBy: 'matches',
      });

      fake.send({
        command: 'searchRepoFiles',
        instanceId: testInstance.id,
        owner: 'owner',
        repo: 'repo',
        ref: 'main',
        query: 'index',
      });
      await flushUntil(() => postedMessages(fake.posted).some((m) => m.command === 'repoFilesSearchResult'));

      const reply = postedMessages(fake.posted).find((m) => m.command === 'repoFilesSearchResult');
      expect(reply).toMatchObject({ truncated: true, truncatedBy: 'matches' });
    });

    it('omits the truncation cause when the search saw the whole tree', async () => {
      clientMocks.searchRepoFiles.mockResolvedValue({ files: [], truncated: false });

      fake.send({
        command: 'searchRepoFiles',
        instanceId: testInstance.id,
        owner: 'owner',
        repo: 'repo',
        ref: 'main',
        query: 'index',
      });
      await flushUntil(() => postedMessages(fake.posted).some((m) => m.command === 'repoFilesSearchResult'));

      const reply = postedMessages(fake.posted).find((m) => m.command === 'repoFilesSearchResult');
      expect(reply?.truncated).toBe(false);
      // A cause on a complete answer would describe a truncation that did not
      // happen, and the webview would promise a narrowing for it.
      expect(reply?.truncatedBy).toBeUndefined();
    });

    it('carries a failed attachments probe on the PR detail reply', async () => {
      clientMocks.getPullRequestDetail.mockResolvedValue({
        title: 'Demo PR',
        assets: undefined,
        attachmentsUnavailable: true,
      });

      fake.send({
        command: 'getPullRequestDetail',
        instanceId: testInstance.id,
        owner: 'owner',
        repo: 'repo',
        index: 2,
      });
      await flushUntil(() => postedMessages(fake.posted).some((m) => m.command === 'pullRequestDetail'));

      const reply = postedMessages(fake.posted).find((m) => m.command === 'pullRequestDetail');
      // Beside `detail`: that is where the webview reads it from, and without it
      // an empty asset list renders as "this PR has no attachments".
      expect(reply?.attachmentsUnavailable).toBe(true);
    });

    it('omits the attachments flag when the probe succeeded', async () => {
      clientMocks.getPullRequestDetail.mockResolvedValue({ title: 'Demo PR', assets: [] });

      fake.send({
        command: 'getPullRequestDetail',
        instanceId: testInstance.id,
        owner: 'owner',
        repo: 'repo',
        index: 2,
      });
      await flushUntil(() => postedMessages(fake.posted).some((m) => m.command === 'pullRequestDetail'));

      const reply = postedMessages(fake.posted).find((m) => m.command === 'pullRequestDetail');
      expect(reply?.attachmentsUnavailable).toBeUndefined();
    });

    it('leaves the per-comment attachments flag on the timeline reply', async () => {
      // The client marks only the comments whose asset lookup failed; the reply
      // passes the list through, so the flag has to survive it.
      clientMocks.getPullRequestCommentsAndTimeline.mockResolvedValue([
        { id: 50, type: 'comment', body: 'See ![log](/attachments/x)', assets: [], attachmentsUnavailable: true },
        { id: 51, type: 'comment', body: 'plain', assets: [] },
      ]);

      fake.send({
        command: 'getPullRequestCommentsAndTimeline',
        instanceId: testInstance.id,
        owner: 'owner',
        repo: 'repo',
        index: 2,
      });
      await flushUntil(() => postedMessages(fake.posted).some((m) => m.command === 'pullRequestCommentsAndTimeline'));

      const reply = postedMessages(fake.posted).find((m) => m.command === 'pullRequestCommentsAndTimeline');
      const comments = reply?.comments as Array<Record<string, unknown>>;
      expect(comments[0]?.attachmentsUnavailable).toBe(true);
      expect(comments[1]?.attachmentsUnavailable).toBeUndefined();
    });
  });

  describe('localized host errors', () => {
    // These replies carry a user-facing message straight into the view, so a
    // hardcoded English literal would stay English under a zh-cn UI. The l10n
    // mock returns the key text unchanged, which is why the assertions check the
    // call (after clearing it) rather than only the replied string.
    it('localizes the rejected saveInstance payload', async () => {
      vi.mocked(vscode.l10n.t).mockClear();
      fake.send({ command: 'saveInstance', url: 42, token: 'tok' });
      await flushDispatches();

      const result = postedMessages(fake.posted).find((m) => m.command === 'saveInstanceResult');
      expect(result).toMatchObject({ success: false, error: 'Invalid input' });
      expect(vi.mocked(vscode.l10n.t)).toHaveBeenCalledWith('Invalid input');
    });

    it('localizes the rejected editInstance payload', async () => {
      vi.mocked(vscode.l10n.t).mockClear();
      fake.send({ command: 'editInstance', id: testInstance.id, url: 'https://forgejo.example.com', token: 7 });
      await flushDispatches();

      const result = postedMessages(fake.posted).find((m) => m.command === 'saveInstanceResult');
      expect(result).toMatchObject({ success: false, error: 'Invalid input' });
      expect(vi.mocked(vscode.l10n.t)).toHaveBeenCalledWith('Invalid input');
    });

    it('localizes the unknown-instance rejection of editInstance', async () => {
      vi.mocked(vscode.l10n.t).mockClear();
      fake.send({
        command: 'editInstance',
        id: 'not-a-configured-instance',
        url: 'https://forgejo.example.com',
        token: 'tok',
      });
      await flushDispatches();

      const result = postedMessages(fake.posted).find((m) => m.command === 'saveInstanceResult');
      expect(result).toMatchObject({ success: false, error: 'Instance not found' });
      expect(vi.mocked(vscode.l10n.t)).toHaveBeenCalledWith('Instance not found');
    });

    it('refuses to save an instance whose URL is not http(s)', async () => {
      vi.mocked(vscode.l10n.t).mockClear();
      const client = vi.mocked(ForgejoClient);
      client.mockClear();

      fake.send({ command: 'saveInstance', url: 'file:///etc/passwd', token: 'tok' });
      await flushDispatches();

      const result = postedMessages(fake.posted).find((m) => m.command === 'saveInstanceResult');
      expect(result).toMatchObject({
        success: false,
        error: 'Enter a valid http(s) URL for the Forgejo instance.',
      });
      expect(vi.mocked(vscode.l10n.t)).toHaveBeenCalledWith('Enter a valid http(s) URL for the Forgejo instance.');
      // Nothing was validated against the (attacker-chosen) URL, let alone
      // stored: the instance list is still just the seeded instance.
      expect(client).not.toHaveBeenCalled();
      expect(config.getInstances().map((instance) => instance.url)).toEqual([testInstance.url]);
    });

    it('refuses to edit an instance into a non-http(s) URL', async () => {
      vi.mocked(vscode.l10n.t).mockClear();
      const client = vi.mocked(ForgejoClient);
      client.mockClear();

      fake.send({ command: 'editInstance', id: testInstance.id, url: 'data:text/html,<b>hi</b>', token: 'tok' });
      await flushDispatches();

      const result = postedMessages(fake.posted).find((m) => m.command === 'saveInstanceResult');
      expect(result).toMatchObject({
        success: false,
        error: 'Enter a valid http(s) URL for the Forgejo instance.',
      });
      expect(client).not.toHaveBeenCalled();
      expect(config.getInstances()[0].url).toBe(testInstance.url);
    });

    it('answers a failed saveInstance with a status-only error, not the response body', async () => {
      // Same rule as testConnection (see connectionFailureMessage): the body of
      // a 409/422 is remote-authored and must not be reflected into the
      // webview, so the reply carries the bare status instead.
      clientMocks.getCurrentUser.mockRejectedValue(
        new Error('Forgejo API error 422: {"message":"server-authored reason"}'),
      );

      fake.send({ command: 'saveInstance', url: 'https://forgejo.example.com', token: 'tok' });
      await flushDispatches();

      const result = postedMessages(fake.posted).find((m) => m.command === 'saveInstanceResult');
      expect(result?.success).toBe(false);
      expect(String(result?.error)).toContain('The instance rejected the request');
      expect(String(result?.error)).not.toContain('server-authored reason');
    });

    it('answers a failed editInstance with a status-only error, not the response body', async () => {
      clientMocks.getCurrentUser.mockRejectedValue(
        new Error('Forgejo API error 409: {"message":"server-authored reason"}'),
      );

      fake.send({ command: 'editInstance', id: testInstance.id, url: 'https://forgejo.example.com', token: 'tok' });
      await flushDispatches();

      const result = postedMessages(fake.posted).find((m) => m.command === 'saveInstanceResult');
      expect(result?.success).toBe(false);
      expect(String(result?.error)).toContain('The instance rejected the request');
      expect(String(result?.error)).not.toContain('server-authored reason');
    });
  });

  describe('repository identity guard', () => {
    // owner/repo are interpolated straight into API paths, so a forged pair
    // must never reach a handler (nor construct an API client).
    const hostilePairs = [
      { owner: 'owner', repo: 'x/../../admin/users' },
      { owner: 'owner', repo: '..' },
      { owner: '..', repo: 'repo' },
      { owner: 'owner', repo: 'repo%2F..' },
      { owner: 'owner', repo: 'repo?state=all' },
      { owner: 42, repo: 'repo' },
    ];

    it.each(hostilePairs)('ignores commands carrying %j', async (pair) => {
      vi.mocked(ForgejoClient).mockClear();
      fake.send({ command: 'deleteIssue', instanceId: testInstance.id, index: 1, ...pair, _requestId: 'req-unsafe' });
      await flushDispatches();

      expect(vi.mocked(ForgejoClient)).not.toHaveBeenCalled();
      // The webview's pending promise is answered so its spinner clears.
      expect(postedMessages(fake.posted)).toContainEqual(
        expect.objectContaining({ command: 'requestError', _requestId: 'req-unsafe' }),
      );
    });

    it('still dispatches a repository-scoped command with ordinary names', async () => {
      clientMocks.getRepoDetail.mockResolvedValue({ repository: { name: 'repo' } });
      fake.send({ command: 'getRepoDetail', instanceId: testInstance.id, owner: 'demo-user', repo: 'demo.repo_1' });
      await flushUntil(() => postedMessages(fake.posted).some((m) => m.command === 'repoDetail'));

      expect(clientMocks.getRepoDetail).toHaveBeenCalledWith('demo-user', 'demo.repo_1');
    });

    it.each([
      { command: 'getRepoContents', result: 'repoContents', extra: { path: '', ref: 'main' } },
      { command: 'getFileHistory', result: 'fileHistory', extra: { path: 'src/index.ts', ref: 'main' } },
    ])('answers a rejected $command through its own reply so the loader clears', async ({ command, result, extra }) => {
      // These loaders carry no `_requestId`, so the requestError fallback
      // cannot answer them: the guard has to use the handler's own contract
      // (a result-shaped reply echoing the fields the loading gate keys on).
      vi.mocked(ForgejoClient).mockClear();
      fake.send({ command, instanceId: testInstance.id, owner: '..', repo: 'repo', ...extra });
      await flushDispatches();

      expect(vi.mocked(ForgejoClient)).not.toHaveBeenCalled();
      expect(postedMessages(fake.posted)).toContainEqual(
        expect.objectContaining({
          command: result,
          instanceId: testInstance.id,
          owner: '..',
          repo: 'repo',
          error: 'The request could not be completed',
        }),
      );
      expect(postedMessages(fake.posted).some((m) => m.command === 'requestError')).toBe(false);
    });

    it.each([
      {
        command: 'createRepoBranch',
        result: 'repoBranchCreated',
        extra: { newBranchName: 'feature', oldRefName: 'main' },
      },
      { command: 'deleteRepoBranch', result: 'repoBranchDeleted', extra: { branch: 'feature' } },
      { command: 'createRepoTag', result: 'repoTagCreated', extra: { tagName: 'v1.0.0', target: 'main' } },
      { command: 'deleteRepoTag', result: 'repoTagDeleted', extra: { tag: 'v1.0.0' } },
    ])('answers a rejected $command through its own reply so RepoRefs clears', async ({ command, result, extra }) => {
      // These carry no `_requestId` either, and the webview's RepoRefs view
      // shows nothing at all unless the guard replies through the mutation's
      // own result contract.
      vi.mocked(ForgejoClient).mockClear();
      fake.send({ command, instanceId: testInstance.id, owner: '..', repo: 'repo', ...extra });
      await flushDispatches();

      expect(vi.mocked(ForgejoClient)).not.toHaveBeenCalled();
      expect(postedMessages(fake.posted)).toContainEqual(
        expect.objectContaining({
          command: result,
          instanceId: testInstance.id,
          owner: '..',
          repo: 'repo',
          error: 'The request could not be completed',
        }),
      );
      expect(postedMessages(fake.posted).some((m) => m.command === 'requestError')).toBe(false);
    });
  });

  describe('path parameter guard', () => {
    // `path`, `user` and `username` end up in API routes of their own. The URL
    // parser resolves dot segments, so a forged value would retarget a
    // repository-scoped command at another same-origin endpoint.
    const hostilePaths = [
      '../admin/users',
      'src/../../user',
      '/etc/passwd',
      'src\\..\\secret',
      'a//b',
      'C:secret',
      'src/\u0000evil',
    ];

    it.each(hostilePaths)('rejects getRepoContents with path %j and answers so the loader clears', async (path) => {
      vi.mocked(ForgejoClient).mockClear();
      fake.send({
        command: 'getRepoContents',
        instanceId: testInstance.id,
        owner: 'owner',
        repo: 'repo',
        path,
        ref: 'main',
      });
      await flushDispatches();

      expect(vi.mocked(ForgejoClient)).not.toHaveBeenCalled();
      expect(clientMocks.getRepoContents).not.toHaveBeenCalled();
      // The file browser sets its loading gate before posting and only a
      // `repoContents` reply clears it; the message carries no `_requestId`, so
      // the dispatch fallback cannot answer it. The reply has to echo the
      // identity the webview keys that gate on, otherwise it is dropped and the
      // spinner stays up.
      const reply = postedMessages(fake.posted).find((m) => m.command === 'repoContents');
      expect(reply).toMatchObject({
        instanceId: testInstance.id,
        owner: 'owner',
        repo: 'repo',
        ref: 'main',
        path,
        error: 'The request could not be completed',
      });
    });

    it.each(['src/why?.ts', 'src/we#ird name.md'])(
      'still lists a directory whose file name contains the legal character %j',
      async (path) => {
        // '?' and '#' are legal in a git file name and the client encodes each
        // segment, so the guard must let them through instead of making the file
        // impossible to open.
        clientMocks.getRepoContents.mockClear();
        clientMocks.getRepoContents.mockResolvedValue([]);
        fake.send({
          command: 'getRepoContents',
          instanceId: testInstance.id,
          owner: 'owner',
          repo: 'repo',
          path,
          ref: 'main',
        });
        await flushUntil(() => clientMocks.getRepoContents.mock.calls.length > 0);

        expect(clientMocks.getRepoContents).toHaveBeenCalledWith('owner', 'repo', path, 'main');
      },
    );

    it('answers a rejected getFileHistory through its own reply so the history loader clears', async () => {
      fake.send({
        command: 'getFileHistory',
        instanceId: testInstance.id,
        owner: 'owner',
        repo: 'repo',
        path: '../etc/passwd',
        ref: 'main',
      });
      await flushDispatches();

      const reply = postedMessages(fake.posted).find((m) => m.command === 'fileHistory');
      expect(reply).toMatchObject({ path: '../etc/passwd', error: 'The request could not be completed' });
    });

    it('reports a rejected openRepoFile instead of dropping the request', async () => {
      fake.send({
        command: 'openRepoFile',
        instanceId: testInstance.id,
        owner: 'owner',
        repo: 'repo',
        path: '/etc/passwd',
        ref: 'main',
      });
      await flushDispatches();

      expect(vscode.window.showErrorMessage).toHaveBeenCalledWith('The request could not be completed');
    });

    it('reports a rejected openRepoFileDiff instead of dropping the request', async () => {
      fake.send({
        command: 'openRepoFileDiff',
        instanceId: testInstance.id,
        owner: 'owner',
        repo: 'repo',
        path: 'src/../../secret',
        baseRef: 'main',
        headRef: 'feature',
      });
      await flushDispatches();

      expect(vscode.window.showErrorMessage).toHaveBeenCalledWith('The request could not be completed');
    });

    it('still lists the repository root and an ordinary path', async () => {
      clientMocks.getRepoContents.mockResolvedValue([]);
      fake.send({
        command: 'getRepoContents',
        instanceId: testInstance.id,
        owner: 'owner',
        repo: 'repo',
        path: '',
        ref: 'main',
      });
      await flushUntil(() => postedMessages(fake.posted).some((m) => m.command === 'repoContents'));
      clientMocks.getRepoContents.mockClear();

      fake.send({
        command: 'getRepoContents',
        instanceId: testInstance.id,
        owner: 'owner',
        repo: 'repo',
        path: 'src/components',
        ref: 'main',
      });
      await flushUntil(() => clientMocks.getRepoContents.mock.calls.length > 0);

      expect(clientMocks.getRepoContents).toHaveBeenCalledWith('owner', 'repo', 'src/components', 'main');
    });

    it.each(['..', '../..', 'admin/user', 'user?x=1'])('ignores a subscription change for user %j', async (user) => {
      vi.mocked(ForgejoClient).mockClear();
      fake.send({
        command: 'changeIssueSubscription',
        instanceId: testInstance.id,
        owner: 'owner',
        repo: 'repo',
        index: 1,
        user,
        subscribe: false,
      });
      await flushDispatches();

      expect(vi.mocked(ForgejoClient)).not.toHaveBeenCalled();
    });

    it.each(['..', '../user/keys', 'user?x=1'])('ignores a user preview for username %j', async (username) => {
      vi.mocked(ForgejoClient).mockClear();
      fake.send({
        command: 'getUserPreview',
        instanceId: testInstance.id,
        username,
        _requestId: 'req-user',
      });
      await flushDispatches();

      expect(vi.mocked(ForgejoClient)).not.toHaveBeenCalled();
    });
  });

  describe('rejected loaders echo the request fields verbatim', () => {
    // The webview keys each loader's spinner on the raw values it sent
    // (`useAppState.ts` builds `${ref}`/`${path}` into the key), so a guard's
    // error reply has to echo them unchanged: normalising a missing `ref` to
    // `''` lands on a different key than the one the loader set and the
    // spinner never clears. `RepoDetail.vue` forwards an unnormalised
    // `detail.repository.default_branch`, which is how a missing `ref` happens.
    function repoContentsKey(message: Record<string, unknown>): string {
      return `${String(message.instanceId)}:${String(message.owner)}/${String(message.repo)}:contents:${String(message.ref)}:${String(message.path)}`;
    }
    function fileHistoryKey(message: Record<string, unknown>): string {
      return `${String(message.instanceId)}:${String(message.owner)}/${String(message.repo)}:file-history:${String(message.path)}:${String(message.ref)}`;
    }

    it.each([
      {
        label: 'an absent ref',
        command: 'getRepoContents',
        result: 'repoContents',
        sent: { owner: 'owner', repo: 'repo', path: '' },
        expected: { owner: 'owner', repo: 'repo', path: '', ref: undefined },
      },
      {
        label: 'an explicitly undefined ref',
        command: 'getRepoContents',
        result: 'repoContents',
        sent: { owner: 'owner', repo: 'repo', path: 'src', ref: undefined },
        expected: { owner: 'owner', repo: 'repo', path: 'src', ref: undefined },
      },
      {
        label: 'an absent ref',
        command: 'getFileHistory',
        result: 'fileHistory',
        sent: { owner: 'owner', repo: 'repo', path: 'src/index.ts' },
        expected: { owner: 'owner', repo: 'repo', path: 'src/index.ts', ref: undefined },
      },
    ])('clears the loader key for $command with $label', async ({ command, result, sent, expected }) => {
      const keyOf = command === 'getRepoContents' ? repoContentsKey : fileHistoryKey;
      fake.send({ command, instanceId: testInstance.id, ...sent });
      await flushDispatches();

      const reply = postedMessages(fake.posted).find((m) => m.command === result);
      expect(reply).toBeDefined();
      expect(reply?.error).toBe('The request could not be completed');
      // Same key the loader built from the values it posted.
      expect(keyOf(reply as Record<string, unknown>)).toBe(
        keyOf({ instanceId: testInstance.id, ...expected } as Record<string, unknown>),
      );
    });
  });

  describe('requestId-less loaders answer a rejected payload', () => {
    // These commands carry no `_requestId`, so the generic dispatch fallback
    // cannot answer them; each handler has to reply through its own result
    // contract or the view's spinner (file search, refs, global search, action
    // runs/jobs) stays up forever.
    it.each([
      {
        label: 'searchRepoFiles with a non-string query',
        command: 'searchRepoFiles',
        result: 'repoFilesSearchResult',
        extra: { owner: 'owner', repo: 'repo', ref: 'main', query: 42 },
      },
      {
        label: 'getRepoRefs with a non-string instance id',
        command: 'getRepoRefs',
        result: 'repoRefs',
        extra: { instanceId: 5, owner: 'owner', repo: 'repo' },
      },
      {
        label: 'globalSearch with an unknown scope',
        command: 'globalSearch',
        result: 'globalSearchResult',
        extra: { scope: 'nope', query: 'x', state: 'all' },
      },
      {
        label: 'getActionRun with a non-number run id',
        command: 'getActionRun',
        result: 'actionRun',
        extra: { owner: 'owner', repo: 'repo', runId: '3' },
      },
      {
        label: 'getActionJobLog with a non-number job id',
        command: 'getActionJobLog',
        result: 'actionJobLog',
        extra: { owner: 'owner', repo: 'repo', jobId: '9' },
      },
    ])('answers $label through $result', async ({ command, result, extra }) => {
      vi.mocked(ForgejoClient).mockClear();
      fake.send({ command, instanceId: testInstance.id, ...extra });
      await flushDispatches();

      expect(vi.mocked(ForgejoClient)).not.toHaveBeenCalled();
      expect(postedMessages(fake.posted)).toContainEqual(
        expect.objectContaining({
          command: result,
          error: 'The request could not be completed',
        }),
      );
      // The generic fallback cannot route a requestId-less reply, so it must
      // not be used here.
      expect(postedMessages(fake.posted).some((m) => m.command === 'requestError')).toBe(false);
    });
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

  it('pushes the supported floor so a view can name it instead of a literal', async () => {
    // The Settings form's "Server version" description names the supported floor
    // as its example. The webview cannot read the host's constant, so the value
    // travels with the state it already receives — one home for the fact, so the
    // example cannot keep showing a number after the floor moves.
    fake.send({ command: 'getInitialState' });
    await flushDispatches();

    const initialState = postedMessages(fake.posted).find((m) => m.command === 'initialState');
    expect(initialState?.minSupportedServerVersion).toBe(MIN_SUPPORTED_VERSION_TEXT);
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

  it('refresh() drops the host-side repository-content caches', async () => {
    // The tree and contents memos live in the API client module, shared by every
    // provider instance, and the webview's refreshData only invalidates its own
    // state: without this call the file tree can keep showing pre-refresh
    // content until the memo's TTL runs out.
    provider.refresh();
    await flushDispatches();
    expect(clientMocks.invalidateRepoContentCaches).toHaveBeenCalledTimes(1);
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

  it.each([
    'not a url',
    'file:///etc/passwd',
    'javascript:alert(1)',
    'ftp://forgejo.example.com',
    '//forgejo.example.com',
    '',
  ])('testConnection rejects the non-http(s) URL %j without any request', async (url) => {
    const client = vi.mocked(ForgejoClient);
    client.mockClear();

    fake.send({ command: 'testConnection', url, token: 'tok', instanceId: testInstance.id });
    await flushDispatches();

    // A webview-chosen target must be a web URL; anything else would let the
    // view point the extension host at an arbitrary URL (SSRF/port scan).
    expect(client).not.toHaveBeenCalled();
    const result = postedMessages(fake.posted).find((m) => m.command === 'testConnectionResult');
    expect(result).toMatchObject({ success: false });
    expect(typeof result?.error).toBe('string');
    expect(result?.error).not.toBe('Invalid input');
  });

  it('testConnection still reaches an arbitrary http(s) instance for the setup wizard', async () => {
    const client = vi.mocked(ForgejoClient);
    client.mockClear();

    fake.send({ command: 'testConnection', url: 'https://other.example.com/base/', token: 'tok' });
    await flushDispatches();

    expect(client).toHaveBeenCalledWith('https://other.example.com/base/', 'tok', expect.anything());
  });

  it('testConnection replies with a status-only message instead of the upstream response body', async () => {
    const secret = 'internal-detail-9f8e';
    clientMocks.getCurrentUser.mockRejectedValue(
      new Error(`Forgejo API error 422: {"message":"${secret}","url":"https://forgejo.example.com/api/v1"}`),
    );

    fake.send({ command: 'testConnection', url: testInstance.url, token: 'tok' });
    await flushDispatches();

    const result = postedMessages(fake.posted).find((m) => m.command === 'testConnectionResult');
    expect(result).toMatchObject({ success: false });
    // Status-only: the body authored by the remote server must not be reflected
    // into the webview (its CSP forbids loading that content).
    expect(result?.error).toContain('422');
    expect(result?.error).not.toContain(secret);
  });

  it('testConnection maps a transport failure to the localized connectivity message', async () => {
    clientMocks.getCurrentUser.mockRejectedValue(new TypeError('fetch failed'));

    fake.send({ command: 'testConnection', url: testInstance.url, token: 'tok' });
    await flushDispatches();

    const result = postedMessages(fake.posted).find((m) => m.command === 'testConnectionResult');
    expect(result).toMatchObject({ success: false });
    expect(result?.error).toBe('Cannot connect to the instance. Check that it is running and that the URL is correct.');
  });

  it('testConnection reports an untrusted certificate as a certificate problem, not a wrong URL', async () => {
    const cause = Object.assign(new Error('self-signed certificate'), { code: 'DEPTH_ZERO_SELF_SIGNED_CERT' });
    clientMocks.getCurrentUser.mockRejectedValue(new TypeError('fetch failed', { cause }));

    fake.send({ command: 'testConnection', url: testInstance.url, token: 'tok' });
    await flushDispatches();

    const result = postedMessages(fake.posted).find((m) => m.command === 'testConnectionResult');
    expect(result).toMatchObject({ success: false });
    expect(result?.error).toContain('certificate');
    expect(result?.error).not.toContain('Cannot connect');
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

  it('editInstance leaves the instance identity intact when nothing changed', async () => {
    // `name` is part of the webview's instance cache identity
    // (useAppState.instanceCacheIdentity). editInstance used to rebuild it from
    // the host alone, so a sub-path instance was renamed by a no-op edit and the
    // view dropped every payload cached for it.
    fake.send({ command: 'saveInstance', url: 'https://forgejo.example.com/git', token: 'tok' });
    await flushDispatches();
    const saved = config.getInstances().find((instance) => instance.name === 'user@forgejo.example.com/git');
    expect(saved).toBeDefined();

    fake.send({ command: 'editInstance', id: saved!.id, url: saved!.url, token: '' });
    await flushDispatches();

    const result = postedMessages(fake.posted).find((m) => m.command === 'saveInstanceResult');
    expect(result).toMatchObject({ success: true });
    const after = config.getInstances().find((instance) => instance.id === saved!.id);
    expect(after?.name).toBe(saved!.name);
    expect(after?.name).toBe('user@forgejo.example.com/git');
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

  /**
   * The declared server version in the Settings form: the host validates it,
   * answers with a readable refusal rather than dropping the input, and stores
   * an accepted value on the instance record — where the feature gates read it.
   */
  describe('the declared server version on the instance form', () => {
    const refusal = `Enter a Forgejo version such as ${MIN_SUPPORTED_VERSION_TEXT}, or leave the field empty to use the automatic version probe.`;

    it('stores a declaration carried by saveInstance, and the gates follow it', async () => {
      fake.send({
        command: 'saveInstance',
        url: 'https://new.example.com/',
        token: 'tok',
        declaredServerVersion: '16.0.2+gitea-1.22.0',
      });
      await flushDispatches();

      const result = postedMessages(fake.posted).find((m) => m.command === 'saveInstanceResult');
      expect(result).toMatchObject({ success: true });
      const stored = config.getInstances().find((entry) => entry.url === 'https://new.example.com');
      expect(stored?.declaredServerVersion).toBe('16.0.2+gitea-1.22.0');
      expect(getServerVersion('https://new.example.com')).toBe('16.0.2+gitea-1.22.0');
    });

    it('refuses an unparseable declaration instead of storing it', async () => {
      fake.send({
        command: 'saveInstance',
        url: 'https://new.example.com/',
        token: 'tok',
        declaredServerVersion: 'devel',
      });
      await flushDispatches();

      const result = postedMessages(fake.posted).find((m) => m.command === 'saveInstanceResult');
      expect(result).toMatchObject({ success: false, error: refusal });
      // Nothing was persisted, and no connection test was even attempted: the
      // input is refused, not silently ignored.
      expect(config.getInstances()).toHaveLength(1);
      expect(config.getInstances()[0]?.url).toBe(testInstance.url);
    });

    it('refuses an unparseable declaration on editInstance too, leaving the record alone', async () => {
      fake.send({
        command: 'editInstance',
        id: testInstance.id,
        url: testInstance.url,
        token: '',
        declaredServerVersion: 16.2,
      });
      await flushDispatches();

      const result = postedMessages(fake.posted).find((m) => m.command === 'saveInstanceResult');
      expect(result).toMatchObject({ success: false, error: refusal });
      expect(config.getInstances()[0]?.declaredServerVersion).toBeUndefined();
    });

    it('clears the declaration when an edit submits an empty field', async () => {
      await config.updateInstance(testInstance.id, { declaredServerVersion: '16.0.2' });
      expect(config.getInstances()[0]?.declaredServerVersion).toBe('16.0.2');

      fake.send({
        command: 'editInstance',
        id: testInstance.id,
        url: testInstance.url,
        token: '',
        declaredServerVersion: '',
      });
      await flushDispatches();

      const result = postedMessages(fake.posted).find((m) => m.command === 'saveInstanceResult');
      expect(result).toMatchObject({ success: true });
      expect(config.getInstances()[0]?.declaredServerVersion).toBeUndefined();
    });

    it('leaves a stored declaration alone when an edit does not carry the field', async () => {
      // An older webview build (a retained bundle, a replayed message) does not
      // know the field; updating the instance through it must not erase a
      // declaration it never saw.
      await config.updateInstance(testInstance.id, { declaredServerVersion: '16.0.2' });

      fake.send({ command: 'editInstance', id: testInstance.id, url: testInstance.url, token: '' });
      await flushDispatches();

      const result = postedMessages(fake.posted).find((m) => m.command === 'saveInstanceResult');
      expect(result).toMatchObject({ success: true });
      expect(config.getInstances()[0]?.declaredServerVersion).toBe('16.0.2');
    });
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
        new Promise((resolve) => {
          finishRevert = () => resolve({ status: 'pushed' });
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

  describe('revertMergeCommit result reporting', () => {
    function sendRevert() {
      fake.send({ command: 'revertMergeCommit', instanceId: testInstance.id, owner: 'owner', repo: 'repo', index: 5 });
    }

    beforeEach(() => {
      clientMocks.getPullRequestDetail.mockResolvedValue({
        merged: true,
        merge_commit_sha: 'abc123',
        base: { ref: 'main' },
      });
      vi.mocked(findLocalRepo).mockResolvedValue('/src/repo');
    });

    it('reports success only after a revert that was pushed', async () => {
      vi.mocked(revertMergeCommit).mockResolvedValue({ status: 'pushed' });

      sendRevert();
      await flushUntil(() => postedMessages(fake.posted).some((m) => m.command === 'revertMergeCommitResult'));

      const reply = postedMessages(fake.posted).find((m) => m.command === 'revertMergeCommitResult');
      expect(reply?.success).toBe(true);
      expect(reply?.error).toBeUndefined();
      expect(reply?.cancelled).toBeUndefined();
    });

    it('reports the failed push reason instead of a success', async () => {
      vi.mocked(revertMergeCommit).mockRejectedValue(
        new Error('Revert could not be pushed and was undone: rejected (non-fast-forward).'),
      );

      sendRevert();
      await flushUntil(() => postedMessages(fake.posted).some((m) => m.command === 'revertMergeCommitResult'));

      const reply = postedMessages(fake.posted).find((m) => m.command === 'revertMergeCommitResult');
      expect(reply).not.toHaveProperty('success');
      expect(reply?.error).toContain('could not be pushed');
    });

    it('tells the user the repository is mid-revert when a failure left it that way', async () => {
      // Nothing local was recorded (the failure happened before the git flow,
      // e.g. in the API call) but the repository is in a revert state left by an
      // earlier attempt: the reply has to name that state, or the user is left
      // with a broken repository and no explanation.
      vi.mocked(revertMergeCommit).mockRejectedValue(new Error('Forgejo request failed'));
      vi.mocked(isRevertInProgress).mockResolvedValue(true);

      sendRevert();
      await flushUntil(() => postedMessages(fake.posted).some((m) => m.command === 'revertMergeCommitResult'));

      const reply = postedMessages(fake.posted).find((m) => m.command === 'revertMergeCommitResult');
      expect(reply?.error).toContain('Forgejo request failed');
      expect(reply?.error).toContain('middle of the revert');
      expect(reply?.error).toContain('git revert --abort');
    });

    it('does not add the mid-revert notice when the failure message already explains it', async () => {
      vi.mocked(revertMergeCommit).mockRejectedValue(
        new Error('Revert failed: conflict. run "git revert --abort" to undo it.'),
      );
      vi.mocked(isRevertInProgress).mockResolvedValue(true);

      sendRevert();
      await flushUntil(() => postedMessages(fake.posted).some((m) => m.command === 'revertMergeCommitResult'));

      const reply = postedMessages(fake.posted).find((m) => m.command === 'revertMergeCommitResult');
      expect(reply?.error).toBe('Revert failed: conflict. run "git revert --abort" to undo it.');
    });
  });

  it('forwards repo contents entries unchanged (a withheld payload is explained on open, not in the listing)', async () => {
    // The webview's file browser renders only name/path/type/size and opens
    // files through openRepoFile → repoFileProvider, which serves the
    // withheld-payload explanation with the entry-type check a listing-level
    // injection could not make (a symlink's empty content is not a withheld
    // payload). An earlier version rewrote `content` here; nothing read it.
    const rawEntries = [
      { name: 'big.bin', path: 'big.bin', type: 'file', size: 12 * 1024 * 1024, content: '' },
      { name: 'link', path: 'link', type: 'symlink', size: 8, target: 'small.txt' },
      { name: 'small.txt', path: 'small.txt', type: 'file', size: 3, content: 'YWJj' },
    ];
    clientMocks.getRepoContents.mockResolvedValueOnce(rawEntries);

    fake.send({
      command: 'getRepoContents',
      instanceId: testInstance.id,
      owner: 'owner',
      repo: 'repo',
      path: '',
      ref: 'main',
    });
    await flushDispatches();

    const reply = postedMessages(fake.posted).find((m) => m.command === 'repoContents');
    expect(reply?.entries).toEqual(rawEntries);
  });

  /**
   * The refs reply feeds the repository browser's branch and tag tabs and the
   * Actions form's ref selector, which offers branches *and* tags. Tags reach
   * the webview only through this reply, so the two lists have to be on it.
   */
  it('answers getRepoRefs with the repository branches and tags', async () => {
    const branches = [{ name: 'main' }, { name: 'release' }];
    const tags = [{ name: 'v0.0.1' }];
    clientMocks.getRepoBranches.mockResolvedValue(branches);
    clientMocks.getRepoTags.mockResolvedValue(tags);
    clientMocks.getRepoReleases.mockResolvedValue([]);

    fake.send({ command: 'getRepoRefs', instanceId: testInstance.id, owner: 'owner', repo: 'repo' });
    await flushUntil(() => postedMessages(fake.posted).some((m) => m.command === 'repoRefs'));

    const reply = postedMessages(fake.posted).find((m) => m.command === 'repoRefs');
    expect(reply).toMatchObject({
      instanceId: testInstance.id,
      owner: 'owner',
      repo: 'repo',
      branches,
      tags,
    });
    expect(reply?.error).toBeUndefined();
  });

  it('re-runs the linked repository detection (debounced) when the instance set changes', async () => {
    // The onboarding panel's save/remove paths never detect on their own; this
    // subscription is what converges them with the sidebar's handlers.
    const listener = vi.mocked(config.onInstancesChanged).mock.calls[0]?.[0] as (() => void) | undefined;
    expect(listener).toBeDefined();
    vi.useFakeTimers();
    try {
      fake.posted.length = 0;
      listener!();
      // Debounced like the active-editor trigger: nothing is scanned yet.
      await vi.advanceTimersByTimeAsync(100);
      expect(postedMessages(fake.posted).some((m) => m.command === 'linkedRepository')).toBe(false);
      await vi.advanceTimersByTimeAsync(300);
      expect(postedMessages(fake.posted).some((m) => m.command === 'linkedRepository')).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  describe('README payload notice', () => {
    function repoDetailReply() {
      return postedMessages(fake.posted).find((m) => m.command === 'repoDetail')?.detail as
        | { readme?: string; readmeSize?: number }
        | undefined;
    }

    function sendRepoDetail() {
      fake.send({ command: 'getRepoDetail', instanceId: testInstance.id, owner: 'owner', repo: 'repo' });
    }

    it('explains a README whose payload the contents API withheld', async () => {
      // `client.getRepoDetail` reports "no README" both for a repository without
      // one and for a README above the contents API payload limit, and carries
      // the withheld payload's size so the dashboard can explain the second case
      // from the detail payload alone.
      clientMocks.getRepoDetail.mockResolvedValue({
        repository: { name: 'repo' },
        readme: undefined,
        readmeSize: 12 * 1024 * 1024,
        branches: [],
        recentCommits: [],
      });

      sendRepoDetail();
      await flushUntil(() => postedMessages(fake.posted).some((m) => m.command === 'repoDetail'));

      expect(repoDetailReply()?.readme).toContain('MiB');
      // The size is already in the detail payload: probing the entry again is
      // what duplicated `/contents/README.md` for every README-less repository.
      expect(clientMocks.getReadmeEntry).not.toHaveBeenCalled();
    });

    it('keeps a README the API returned instead of replacing it with a notice', async () => {
      clientMocks.getRepoDetail.mockResolvedValue({
        repository: { name: 'repo' },
        readme: '# Hello',
        readmeSize: undefined,
        branches: [],
        recentCommits: [],
      });

      sendRepoDetail();
      await flushUntil(() => postedMessages(fake.posted).some((m) => m.command === 'repoDetail'));

      expect(repoDetailReply()?.readme).toBe('# Hello');
      expect(clientMocks.getReadmeEntry).not.toHaveBeenCalled();
    });

    it('stays silent for a repository that has no README', async () => {
      clientMocks.getRepoDetail.mockResolvedValue({
        repository: { name: 'repo' },
        readme: undefined,
        readmeSize: undefined,
        branches: [],
        recentCommits: [],
      });

      sendRepoDetail();
      await flushUntil(() => postedMessages(fake.posted).some((m) => m.command === 'repoDetail'));

      expect(repoDetailReply()?.readme).toBeUndefined();
      expect(clientMocks.getReadmeEntry).not.toHaveBeenCalled();
    });

    it('stays silent for a genuinely empty README', async () => {
      clientMocks.getRepoDetail.mockResolvedValue({
        repository: { name: 'repo' },
        readme: undefined,
        readmeSize: 0,
        branches: [],
        recentCommits: [],
      });

      sendRepoDetail();
      await flushUntil(() => postedMessages(fake.posted).some((m) => m.command === 'repoDetail'));

      // Size 0 is an empty README, not a withheld payload.
      expect(repoDetailReply()?.readme).toBeUndefined();
      expect(clientMocks.getReadmeEntry).not.toHaveBeenCalled();
    });

    it('words the symlinked README notice through the host l10n bundle', async () => {
      // `client.getRepoDetail` answers a symlinked README with its own English
      // sentence (that is what the headless MCP tools show) plus the structured
      // `readmeNotice`. The dashboard is localized, so it must word the sentence
      // itself instead of rendering the English one inside a Chinese UI.
      const englishNotice =
        'README.md is a symlink to docs/real-readme.md, so Forgejo returned no text for it. Open docs/real-readme.md in the Forgejo web UI to read it.';
      clientMocks.getRepoDetail.mockResolvedValue({
        repository: { name: 'repo' },
        readme: englishNotice,
        readmeNotice: { kind: 'symlink', target: 'docs/real-readme.md' },
        branches: [],
        recentCommits: [],
      });

      sendRepoDetail();
      await flushUntil(() => postedMessages(fake.posted).some((m) => m.command === 'repoDetail'));

      expect(repoDetailReply()?.readme).toBe(
        'README.md is a symlink to docs/real-readme.md, so Forgejo has no README text to show. Open docs/real-readme.md in the Forgejo web UI to read it.',
      );
      expect(vscode.l10n.t).toHaveBeenCalledWith(
        'README.md is a symlink to {0}, so Forgejo has no README text to show. Open {0} in the Forgejo web UI to read it.',
        'docs/real-readme.md',
      );
      // The client's English sentence is not what the dashboard shows.
      expect(repoDetailReply()?.readme).not.toBe(englishNotice);
      expect(clientMocks.getReadmeEntry).not.toHaveBeenCalled();
    });

    it('words the submodule README notice through the host l10n bundle', async () => {
      const gitUrl = 'https://forgejo.example.com/demo-user/upstream-lib.git';
      clientMocks.getRepoDetail.mockResolvedValue({
        repository: { name: 'repo' },
        readme: `README.md is a submodule whose own repository is at ${gitUrl}, so this repository holds no README text for it. Open the submodule in the Forgejo web UI to read it there.`,
        readmeNotice: { kind: 'submodule', target: gitUrl },
        branches: [],
        recentCommits: [],
      });

      sendRepoDetail();
      await flushUntil(() => postedMessages(fake.posted).some((m) => m.command === 'repoDetail'));

      expect(vscode.l10n.t).toHaveBeenCalledWith(
        'README.md is a submodule whose own repository is at {0}, so this repository has no README text to show. Open the submodule in the Forgejo web UI to read it there.',
        gitUrl,
      );
      expect(repoDetailReply()?.readme).toBe(
        `README.md is a submodule whose own repository is at ${gitUrl}, so this repository has no README text to show. Open the submodule in the Forgejo web UI to read it there.`,
      );
    });

    it('names the entry kind without inventing a destination the API did not send', async () => {
      clientMocks.getRepoDetail.mockResolvedValue({
        repository: { name: 'repo' },
        readme: 'README.md is a symlink that points elsewhere in the repository, so Forgejo returned no text for it.',
        readmeNotice: { kind: 'symlink' },
        branches: [],
        recentCommits: [],
      });

      sendRepoDetail();
      await flushUntil(() => postedMessages(fake.posted).some((m) => m.command === 'repoDetail'));

      expect(repoDetailReply()?.readme).toBe(
        'README.md is not a regular file in this repository, so Forgejo has no README text to show. Open it in the Forgejo web UI to read it.',
      );
    });

    it('still shows the client sentence for a payload that carries no structured notice', async () => {
      // A hand-built detail (or an older payload shape) has no `readmeNotice`, so
      // the client's own sentence stays visible rather than disappearing.
      const englishNotice = 'README.md is a symlink, and this payload predates readmeNotice.';
      clientMocks.getRepoDetail.mockResolvedValue({
        repository: { name: 'repo' },
        readme: englishNotice,
        branches: [],
        recentCommits: [],
      });

      sendRepoDetail();
      await flushUntil(() => postedMessages(fake.posted).some((m) => m.command === 'repoDetail'));

      expect(repoDetailReply()?.readme).toBe(englishNotice);
    });
  });

  describe('README preview', () => {
    it('keys the virtual document by instance, owner and repo', async () => {
      // Two instances can host the same owner/repo; a URI without the instance
      // id would show whichever README was registered last for both.
      const executeCommand = vi.mocked(vscode.commands.executeCommand);
      executeCommand.mockClear();

      fake.send({
        command: 'previewReadme',
        instanceId: testInstance.id,
        owner: 'owner',
        repo: 'repo',
        content: '# Hello',
      });
      await flushDispatches();

      const call = executeCommand.mock.calls.find(([command]) => command === 'markdown.showPreviewToSide');
      expect(call).toBeDefined();
      expect((call?.[1] as { path?: string } | undefined)?.path).toBe(`${testInstance.id}/owner/repo/README.md`);
    });
  });

  it('marks a cancelled instance export as cancelled rather than failed', async () => {
    // Dismissing the export dialog is not a failure: without the flag the webview
    // stores the reply and Settings reports "Failed to export instances".
    vi.mocked(vscode.window.showWarningMessage).mockResolvedValueOnce(undefined as never);
    fake.send({ command: 'exportInstances', ids: [testInstance.id] });
    await flushUntil(() => postedMessages(fake.posted).some((m) => m.command === 'instancesExported'));

    const reply = postedMessages(fake.posted).find((m) => m.command === 'instancesExported');
    expect(reply).toMatchObject({ success: false, cancelled: true });
  });

  it('marks a dismissed export save dialog as cancelled as well', async () => {
    // The encrypt choice is confirmed, the password typed, and only then is the
    // save dialog dismissed — the last decline path.
    // The prompt asks twice (password + confirmation) before the save dialog;
    // each answer is scoped to its own prompt so no resolved value leaks into
    // later tests through the shared mock (a leaked password answer once made
    // the atomic-rename test below pass only in full-file order).
    vi.mocked(vscode.window.showInputBox)
      .mockResolvedValueOnce('something' as never)
      .mockResolvedValueOnce('something' as never);
    vi.mocked(vscode.window.showSaveDialog).mockResolvedValueOnce(undefined as never);
    fake.send({ command: 'exportInstances', ids: [testInstance.id] });
    await flushUntil(() => postedMessages(fake.posted).some((m) => m.command === 'instancesExported'));

    const reply = postedMessages(fake.posted).find((m) => m.command === 'instancesExported');
    expect(reply).toMatchObject({ success: false, cancelled: true });
  });

  it('keeps the previous export file when the atomic rename fails', async () => {
    // The export writes a `.part` sibling and renames it into place (like the
    // artifact download), so a failed export must leave the previous export
    // file exactly as it was — not truncated.
    const target = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'export-atomic-')), 'export.json');
    fs.writeFileSync(target, 'previous export');
    // Pick "Plain text" explicitly: the shared mock otherwise answers the
    // first button ("Encrypt with password") and the flow cancels at the
    // password prompt, never reaching the write this test is about. Relying
    // on a password mock leaked by an earlier test made this pass only in
    // full-file order.
    vi.mocked(vscode.window.showWarningMessage).mockResolvedValueOnce('Plain text' as never);
    vi.mocked(vscode.window.showSaveDialog).mockResolvedValueOnce({ fsPath: target } as never);
    vi.spyOn(fs.promises, 'rename').mockRejectedValueOnce(new Error('EPERM: operation not permitted'));

    try {
      fake.send({ command: 'exportInstances', ids: [testInstance.id] });
      await flushUntil(() => postedMessages(fake.posted).some((m) => m.command === 'instancesExported'));

      const reply = postedMessages(fake.posted).find((m) => m.command === 'instancesExported');
      expect(reply?.success).toBe(false);
      expect(reply?.error).toContain('EPERM');
      expect(fs.readFileSync(target, 'utf8')).toBe('previous export');
      expect(fs.existsSync(`${target}.part`)).toBe(false);
    } finally {
      vi.restoreAllMocks();
    }
  });

  describe('host-enforced confirmations for destructive commands', () => {
    // The shared vscode mock resolves showWarningMessage with the first action
    // button by default (user accepts); this makes the next dialog decline.
    function declineNextConfirm() {
      vi.mocked(vscode.window.showWarningMessage).mockResolvedValueOnce(undefined as never);
    }

    it('removeInstance aborts without touching the config when the user declines', async () => {
      const removeSpy = vi.spyOn(config, 'removeInstance');
      declineNextConfirm();

      fake.send({ command: 'removeInstance', id: testInstance.id });
      await flushDispatches();

      expect(vscode.window.showWarningMessage).toHaveBeenCalled();
      expect(removeSpy).not.toHaveBeenCalled();
      expect(config.getInstances()).toHaveLength(1);
    });

    it('removeInstance removes the instance when the user confirms', async () => {
      fake.send({ command: 'removeInstance', id: testInstance.id });
      await flushDispatches();

      expect(config.getInstances()).toHaveLength(0);
    });

    const declineCases: Array<{
      command: string;
      result: string;
      message: Record<string, unknown>;
      echo: Record<string, unknown>;
    }> = [
      {
        command: 'deleteIssue',
        result: 'issueDeleted',
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
        command: 'removeIssueDependency',
        result: 'issueDependencyChanged',
        message: { owner: 'owner', repo: 'repo', index: 5, dependencyIndex: 6 },
        echo: { owner: 'owner', repo: 'repo', index: 5, dependencyIndex: 6, action: 'remove' },
      },
      {
        command: 'deleteIssueComment',
        result: 'issueCommentDeleted',
        message: { owner: 'owner', repo: 'repo', commentId: 7 },
        echo: { owner: 'owner', repo: 'repo', commentId: 7 },
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
        command: 'deleteRepoBranch',
        result: 'repoBranchDeleted',
        message: { owner: 'owner', repo: 'repo', branch: 'feature' },
        echo: { owner: 'owner', repo: 'repo', branch: 'feature' },
      },
      {
        command: 'deleteRepoTag',
        result: 'repoTagDeleted',
        message: { owner: 'owner', repo: 'repo', tag: 'v1.0.0' },
        echo: { owner: 'owner', repo: 'repo', tag: 'v1.0.0' },
      },
      {
        command: 'deleteRepoRelease',
        result: 'repoReleaseDeleted',
        message: { owner: 'owner', repo: 'repo', id: 2 },
        echo: { owner: 'owner', repo: 'repo', release: '2' },
      },
      {
        command: 'deleteIssueAttachment',
        result: 'issueAttachmentDeleted',
        message: { owner: 'owner', repo: 'repo', index: 2, attachmentId: 7, _requestId: 'req-issue-att' },
        echo: { owner: 'owner', repo: 'repo', index: 2, attachmentId: 7, _requestId: 'req-issue-att' },
      },
      {
        command: 'deleteIssueCommentAttachment',
        result: 'issueCommentAttachmentDeleted',
        message: { owner: 'owner', repo: 'repo', commentId: 5, attachmentId: 7, _requestId: 'req-comment-att' },
        echo: { owner: 'owner', repo: 'repo', commentId: 5, attachmentId: 7, _requestId: 'req-comment-att' },
      },
      {
        command: 'deleteReleaseAttachment',
        result: 'releaseAttachmentDeleted',
        message: { owner: 'owner', repo: 'repo', id: 3, attachmentId: 7, _requestId: 'req-release-att' },
        echo: { owner: 'owner', repo: 'repo', id: 3, attachmentId: 7, _requestId: 'req-release-att' },
      },
      {
        command: 'deleteIssueStopwatch',
        result: 'issueStopwatchChanged',
        message: { owner: 'owner', repo: 'repo', index: 2 },
        echo: { owner: 'owner', repo: 'repo', index: 2, action: 'delete' },
      },
    ];

    for (const { command, result, message, echo } of declineCases) {
      it(`aborts ${command} without an API call when the user declines`, async () => {
        vi.mocked(ForgejoClient).mockClear();
        declineNextConfirm();

        fake.send({ command, instanceId: testInstance.id, ...message });
        await flushDispatches();

        // The cancel reply clears the webview's loading state without being
        // mistaken for success or failure.
        const reply = postedMessages(fake.posted).find((m) => m.command === result);
        expect(reply).toMatchObject({ instanceId: testInstance.id, ...echo, cancelled: true });
        expect(reply?.error).toBeUndefined();
        expect(vi.mocked(ForgejoClient)).not.toHaveBeenCalled();
      });
    }

    it('createIssueDependency does not prompt for confirmation (not destructive)', async () => {
      vi.mocked(vscode.window.showWarningMessage).mockClear();

      fake.send({
        command: 'createIssueDependency',
        instanceId: testInstance.id,
        owner: 'owner',
        repo: 'repo',
        index: 5,
        dependencyIndex: 6,
      });
      await flushDispatches();

      expect(vscode.window.showWarningMessage).not.toHaveBeenCalled();
    });

    it('removeWorktree aborts without removing anything when the user declines', async () => {
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
      declineNextConfirm();

      // The handler answers a decline with silence on purpose (the webview
      // tracks no pending state for removeWorktree), so there is no reply to
      // wait for; the only observable event is the confirmation prompt itself.
      // Compare against the pre-send call count: the shared mock's call
      // history is not reset between tests.
      const confirmCallsBefore = vi.mocked(vscode.window.showWarningMessage).mock.calls.length;
      fake.send({ command: 'removeWorktree', id: 'w1' });
      await flushUntil(() => vi.mocked(vscode.window.showWarningMessage).mock.calls.length > confirmCallsBefore);

      expect(vi.mocked(removeWorktreeAndPrune)).not.toHaveBeenCalled();
      const messages = postedMessages(fake.posted);
      expect(messages.some((m) => m.command === 'worktreeRemoved')).toBe(false);
      // The record stays so the user can retry.
      const records = context.globalState.get('forgejoToolkit.worktrees') as unknown[];
      expect(records).toHaveLength(1);
    });

    describe('confirmations name their target', () => {
      // Every destructive prompt has to identify the repository (and the
      // instance, when the command is instance-scoped): the same generic
      // "Delete …?" text for every repository lets a mis-click destroy the
      // wrong one.
      function lastConfirmMessage(): string {
        const calls = vi.mocked(vscode.window.showWarningMessage).mock.calls;
        return String(calls[calls.length - 1]?.[0] ?? '');
      }

      it('names the instance and repository for a repository-scoped command', async () => {
        fake.send({
          command: 'deleteRepoBranch',
          instanceId: testInstance.id,
          owner: 'acme',
          repo: 'widgets',
          branch: 'feature',
        });
        await flushDispatches();

        const message = lastConfirmMessage();
        expect(message).toContain('acme/widgets');
        expect(message).toContain(testInstance.name);
        expect(message).toContain('feature');
      });

      it('names the instance and repository for an issue-scoped command', async () => {
        fake.send({ command: 'deleteIssue', instanceId: testInstance.id, owner: 'acme', repo: 'widgets', index: 42 });
        await flushDispatches();

        const message = lastConfirmMessage();
        expect(message).toContain('acme/widgets');
        expect(message).toContain(testInstance.name);
        // The issue number is interpolated (the shared l10n mock appends args).
        expect(message).toContain('42');
      });

      it('names the instance and repository for an action-run command', async () => {
        fake.send({
          command: 'deleteActionRun',
          instanceId: testInstance.id,
          owner: 'acme',
          repo: 'widgets',
          runId: 7,
        });
        await flushDispatches();

        const message = lastConfirmMessage();
        expect(message).toContain('acme/widgets');
        expect(message).toContain(testInstance.name);
      });

      it('names the instance and repository for a worktree removal', async () => {
        // Deleting a worktree drops the local directory and any work it holds,
        // so its prompt has to identify the target like the other destructive
        // confirmations.
        await context.globalState.update('forgejoToolkit.worktrees', [
          {
            id: 'w-named',
            instanceId: testInstance.id,
            owner: 'acme',
            repo: 'widgets',
            prIndex: 3,
            prTitle: 'title',
            headBranch: 'feature',
            headSha: 'abc',
            baseBranch: 'main',
            sourceRepoPath: '/src/repo',
            worktreePath: '/cache/worktrees/w-named',
            createdAt: 0,
          },
        ]);
        declineNextConfirm();

        // A decline gets no reply (see the decline-path test above), so wait
        // for the confirmation prompt itself; comparing against the pre-send
        // count keeps a prompt leaked from an earlier test from satisfying the
        // wait before this flow has even asked.
        const confirmCallsBefore = vi.mocked(vscode.window.showWarningMessage).mock.calls.length;
        fake.send({ command: 'removeWorktree', id: 'w-named' });
        await flushUntil(() => vi.mocked(vscode.window.showWarningMessage).mock.calls.length > confirmCallsBefore);

        const message = lastConfirmMessage();
        expect(message).toContain('acme/widgets');
        expect(message).toContain(testInstance.name);
      });
    });

    it('resetIssueTime asks for confirmation before the API call and cancels cleanly', async () => {
      const client = vi.mocked(ForgejoClient);
      client.mockClear();
      declineNextConfirm();

      fake.send({ command: 'resetIssueTime', instanceId: testInstance.id, owner: 'owner', repo: 'repo', index: 5 });
      await flushDispatches();

      // DELETE .../times drops every tracked-time entry of the issue at once,
      // so it is confirmed host-side exactly like the single-entry delete.
      expect(vscode.window.showWarningMessage).toHaveBeenCalled();
      const reply = postedMessages(fake.posted).find((m) => m.command === 'issueTimeReset');
      expect(reply).toMatchObject({
        instanceId: testInstance.id,
        owner: 'owner',
        repo: 'repo',
        index: 5,
        cancelled: true,
      });
      expect(reply?.error).toBeUndefined();
      expect(clientMocks.resetIssueTime).not.toHaveBeenCalled();
      expect(client).not.toHaveBeenCalled();
    });

    it('resetIssueTime deletes every tracked time entry once confirmed', async () => {
      fake.send({ command: 'resetIssueTime', instanceId: testInstance.id, owner: 'owner', repo: 'repo', index: 5 });
      await flushDispatches();

      expect(clientMocks.resetIssueTime).toHaveBeenCalledWith('owner', 'repo', 5);
      const reply = postedMessages(fake.posted).find((m) => m.command === 'issueTimeReset');
      expect(reply).toMatchObject({ instanceId: testInstance.id, owner: 'owner', repo: 'repo', index: 5 });
      expect(reply?.cancelled).toBeUndefined();
    });
  });

  describe('cold-start linked-repository detection', () => {
    it('clears the pending detection timer on dispose so a disposed host never scans git', async () => {
      vi.useFakeTimers();
      try {
        const localContext = createFakeContext();
        const provider = new ForgejoToolkitViewProvider(
          localContext as never,
          localContext.extensionUri as never,
          new ConfigManager(localContext as never),
          new ReadmeContentProvider(),
        );
        // Assert on this instance rather than on the module mock: providers built
        // by earlier tests leave real 2 s timers behind, and a full-suite run can
        // let one of those fire inside the advance window below.
        const detectSpy = vi.spyOn(
          provider as unknown as { _detectAndSendLinkedRepository: () => Promise<void> },
          '_detectAndSendLinkedRepository',
        );

        // The timer is registered as a context subscription; disposing the
        // provider's subscriptions is what the extension host does on shutdown.
        // (The mocked EventEmitter returns no disposable for the config
        // listener, so only real entries are disposed.)
        const disposables = localContext.subscriptions.filter(
          (entry): entry is { dispose(): void } => Boolean(entry) && typeof entry.dispose === 'function',
        );
        expect(disposables.length).toBeGreaterThan(0);
        for (const disposable of disposables) {
          disposable.dispose();
        }
        await vi.advanceTimersByTimeAsync(10_000);

        expect(detectSpy).not.toHaveBeenCalled();
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe('downloadActionArtifact save path', () => {
    it('reduces a hostile artifact name to its basename for the save dialog', async () => {
      vi.mocked(vscode.window.showSaveDialog).mockResolvedValue({ fsPath: '/tmp/out.zip' } as never);

      fake.send({
        command: 'downloadActionArtifact',
        instanceId: testInstance.id,
        owner: 'owner',
        repo: 'repo',
        artifactId: 3,
        name: '../../../../.ssh/authorized_keys',
      });
      await flushUntil(() => postedMessages(fake.posted).some((m) => m.command === 'actionArtifactDownloaded'));

      // The save dialog must not be pre-filled with an arbitrary path: a single
      // Enter would otherwise write outside the chosen folder.
      expect(vscode.window.showSaveDialog).toHaveBeenCalledWith(
        expect.objectContaining({ defaultUri: expect.objectContaining({ fsPath: 'authorized_keys.zip' }) }),
      );
      expect(clientMocks.downloadActionArtifactToFile).toHaveBeenCalledWith(
        'owner',
        'repo',
        3,
        '/tmp/out.zip',
        expect.anything(),
      );
    });

    it('strips an absolute directory and keeps the zip extension', async () => {
      vi.mocked(vscode.window.showSaveDialog).mockResolvedValue({ fsPath: '/tmp/out.zip' } as never);

      fake.send({
        command: 'downloadActionArtifact',
        instanceId: testInstance.id,
        owner: 'owner',
        repo: 'repo',
        artifactId: 4,
        name: '/etc/cron.d/build.zip',
      });
      await flushUntil(() => postedMessages(fake.posted).some((m) => m.command === 'actionArtifactDownloaded'));

      expect(vscode.window.showSaveDialog).toHaveBeenCalledWith(
        expect.objectContaining({ defaultUri: expect.objectContaining({ fsPath: 'build.zip' }) }),
      );
    });
  });

  it('derives the view title through l10n instead of a hard-coded locale pair', async () => {
    // A user whose forgejoToolkit.locale is zh but whose VS Code display
    // language is en must still get the localized (English) title: the string
    // goes through the l10n bundle rather than a literal zh value.
    fake.send({ command: 'setLocale', locale: 'zh' });
    await flushDispatches();

    expect(fake.view.title).toBe('Dashboard');
  });

  it('answers previewImportInstances with cancelled when the file picker is dismissed', async () => {
    vi.mocked(vscode.window.showOpenDialog).mockResolvedValue(undefined as never);

    fake.send({ command: 'previewImportInstances' });
    await flushDispatches();

    const preview = postedMessages(fake.posted).find((m) => m.command === 'importInstancesPreview');
    expect(preview).toMatchObject({ cancelled: true, instances: [] });
  });

  it('answers instancesImported with cancelled when the file picker is dismissed', async () => {
    vi.mocked(vscode.window.showOpenDialog).mockResolvedValue(undefined as never);

    fake.send({ command: 'importInstances' });
    await flushUntil(() => postedMessages(fake.posted).some((m) => m.command === 'instancesImported'));

    const reply = postedMessages(fake.posted).find((m) => m.command === 'instancesImported');
    // A dismissed picker is not a failure: no error text, so the webview does
    // not show an "import failed" status for a deliberate cancel.
    expect(reply).toMatchObject({ success: false, cancelled: true });
    expect(reply?.error).toBeUndefined();
  });

  describe('import instances preview/confirm', () => {
    function writeExportFile(instances: unknown[]): string {
      const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'import-export-')), 'export.json');
      fs.writeFileSync(file, JSON.stringify({ version: 1, instances }));
      return file;
    }

    function writeEncryptedExportFile(instances: unknown[], password = 'pw'): string {
      const salt = crypto.randomBytes(16);
      const iv = crypto.randomBytes(16);
      const iterations = 1000;
      const key = crypto.pbkdf2Sync(password, salt, iterations, 32, 'sha256');
      const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
      const encrypted = Buffer.concat([cipher.update(JSON.stringify({ instances }), 'utf8'), cipher.final()]);
      const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'import-export-enc-')), 'export.json');
      fs.writeFileSync(
        file,
        JSON.stringify({
          encrypted: true,
          iterations,
          salt: salt.toString('base64'),
          iv: iv.toString('base64'),
          authTag: cipher.getAuthTag().toString('base64'),
          data: encrypted.toString('base64'),
        }),
      );
      return file;
    }

    async function previewExportFile(file: string) {
      vi.mocked(vscode.window.showOpenDialog).mockResolvedValue([vscode.Uri.file(file)] as never);
      fake.send({ command: 'previewImportInstances' });
      await flushUntil(() => postedMessages(fake.posted).some((m) => m.command === 'importInstancesPreview'));
    }

    async function confirmImport(message: unknown) {
      fake.send(message);
      await flushUntil(() => postedMessages(fake.posted).some((m) => m.command === 'instancesImported'));
    }

    it('strips tokens from the preview payload and rehydrates them from the stash on confirm', async () => {
      const file = writeExportFile([
        {
          id: 'imported-1',
          url: 'https://forgejo.example.com',
          token: 'file-token-1',
          name: 'one',
          username: 'user',
          syncApiUrlsToInstanceUrl: true,
        },
        { id: 'imported-2', url: 'https://other.example.com', token: 'file-token-2', name: 'two', username: 'user' },
      ]);
      await previewExportFile(file);

      const preview = postedMessages(fake.posted).find((m) => m.command === 'importInstancesPreview');
      const previewInstances = preview?.instances as Array<Record<string, unknown>>;
      expect(previewInstances).toHaveLength(2);
      // No token value leaves the host in the preview payload — the key is
      // omitted entirely (see stripInstanceTokens).
      expect(previewInstances.every((instance) => !('token' in instance))).toBe(true);
      expect(JSON.stringify(preview)).not.toContain('file-token');

      await confirmImport({ command: 'importInstances', ids: ['imported-1'] });

      const reply = postedMessages(fake.posted).find((m) => m.command === 'instancesImported');
      expect(reply).toMatchObject({ success: true, count: 1 });
      // The stored instance carries the token from the file (host stash),
      // and syncApiUrlsToInstanceUrl survives the round trip.
      const imported = config.getInstances().find((i) => i.id === 'imported-1');
      expect(imported?.token).toBe('file-token-1');
      expect(imported?.syncApiUrlsToInstanceUrl).toBe(true);
      expect(config.getInstances().some((i) => i.id === 'imported-2')).toBe(false);
    });

    it('flags in-file duplicate tokens in the preview conflict flags', async () => {
      const file = writeExportFile([
        { id: 'imported-1', url: 'https://forgejo.example.com', token: 'same-token', name: 'one', username: 'user' },
        { id: 'imported-2', url: 'https://other.example.com', token: 'same-token', name: 'two', username: 'user' },
      ]);
      await previewExportFile(file);

      const preview = postedMessages(fake.posted).find((m) => m.command === 'importInstancesPreview');
      expect(preview?.tokenConflicts).toEqual([true, true]);
    });

    it('ignores webview-supplied instance data (forged tokens) on confirm', async () => {
      const file = writeExportFile([
        { id: 'imported-1', url: 'https://forgejo.example.com', token: 'file-token-1', name: 'one', username: 'user' },
      ]);
      await previewExportFile(file);

      await confirmImport({
        command: 'importInstances',
        ids: ['imported-1'],
        // A compromised webview trying to smuggle its own token in.
        instances: [
          { id: 'imported-1', url: 'https://evil.example.com', token: 'forged-token', name: 'evil', username: 'evil' },
        ],
      });

      const reply = postedMessages(fake.posted).find((m) => m.command === 'instancesImported');
      expect(reply).toMatchObject({ success: true, count: 1 });
      const imported = config.getInstances().find((i) => i.id === 'imported-1');
      expect(imported?.token).toBe('file-token-1');
      expect(imported?.url).toBe('https://forgejo.example.com');
    });

    it('replies with an error when the confirmation has no pending preview', async () => {
      await confirmImport({ command: 'importInstances', ids: ['whatever'] });

      const reply = postedMessages(fake.posted).find((m) => m.command === 'instancesImported');
      expect(reply?.success).toBe(false);
      expect(typeof reply?.error).toBe('string');
      // Nothing was added beyond the seed instance.
      expect(config.getInstances()).toHaveLength(1);
    });

    it('drops the stashed preview on cancelImportInstances', async () => {
      const file = writeExportFile([
        { id: 'imported-1', url: 'https://forgejo.example.com', token: 'file-token-1', name: 'one', username: 'user' },
      ]);
      await previewExportFile(file);

      fake.send({ command: 'cancelImportInstances' });
      await confirmImport({ command: 'importInstances', ids: ['imported-1'] });

      const reply = postedMessages(fake.posted).find((m) => m.command === 'instancesImported');
      expect(reply?.success).toBe(false);
      expect(config.getInstances()).toHaveLength(1);
    });

    it('consumes the stash: a second confirm of the same preview fails', async () => {
      const file = writeExportFile([
        { id: 'imported-1', url: 'https://forgejo.example.com', token: 'file-token-1', name: 'one', username: 'user' },
      ]);
      await previewExportFile(file);
      await confirmImport({ command: 'importInstances', ids: ['imported-1'] });

      fake.posted.length = 0;
      await confirmImport({ command: 'importInstances', ids: ['imported-1'] });

      const reply = postedMessages(fake.posted).find((m) => m.command === 'instancesImported');
      expect(reply?.success).toBe(false);
    });

    it('treats a dismissed password prompt as a cancel instead of an error', async () => {
      const file = writeEncryptedExportFile([
        { id: 'imported-1', url: 'https://forgejo.example.com', token: 'file-token-1', name: 'one', username: 'user' },
      ]);
      vi.mocked(vscode.window.showInputBox).mockResolvedValueOnce(undefined as never);

      await previewExportFile(file);

      const preview = postedMessages(fake.posted).find((m) => m.command === 'importInstancesPreview');
      expect(preview).toMatchObject({ cancelled: true, instances: [] });
      expect(preview?.error).toBeUndefined();
    });

    it('reports and imports around the entries the file could not use', async () => {
      const file = writeExportFile([
        { id: 'imported-1', url: 'https://forgejo.example.com', token: 'file-token-1', name: 'one', username: 'user' },
        { id: 'imported-2', url: 'https://other.example.com', token: 'file-token-2', name: 'two', username: 'user' },
        { id: 'broken' },
        'not-an-object',
        { id: 'imported-3', url: 42, token: 'tok', name: 'three', username: 'user' },
      ]);
      await previewExportFile(file);

      const preview = postedMessages(fake.posted).find((m) => m.command === 'importInstancesPreview');
      expect(preview?.dropped).toBe(3);
      expect(preview?.instances).toHaveLength(2);

      await confirmImport({ command: 'importInstances', ids: ['imported-1', 'imported-2'] });

      const reply = postedMessages(fake.posted).find((m) => m.command === 'instancesImported');
      expect(reply).toMatchObject({ success: true, count: 2 });
      expect(
        config
          .getInstances()
          .filter((i) => i.id.startsWith('imported-'))
          .map((i) => i.id)
          .sort(),
      ).toEqual(['imported-1', 'imported-2']);
    });

    it('omits the dropped count when the file used every entry', async () => {
      const file = writeExportFile([
        { id: 'imported-1', url: 'https://forgejo.example.com', token: 'file-token-1', name: 'one', username: 'user' },
      ]);
      await previewExportFile(file);

      const preview = postedMessages(fake.posted).find((m) => m.command === 'importInstancesPreview');
      // Absent, not a bare 0: the webview treats a missing count as "nothing to
      // warn about", and a hardcoded 0 would also look like a real measurement.
      expect(preview?.dropped).toBeUndefined();
    });

    it('reports a file without valid instances through the localized message', async () => {
      const file = writeExportFile([]);

      await previewExportFile(file);

      const preview = postedMessages(fake.posted).find((m) => m.command === 'importInstancesPreview');
      expect(preview?.cancelled).toBeUndefined();
      expect(typeof preview?.error).toBe('string');
      // Translated through l10n.t, so zh users do not see a raw English literal.
      expect(vi.mocked(vscode.l10n.t)).toHaveBeenCalledWith('No valid instances found in file');
    });

    it('reports an entry whose URL embeds a credential as dropped, not stored', async () => {
      // Node's `fetch` refuses to build a request from a URL with credentials,
      // so storing the entry would produce an instance that fails every call
      // with a message blaming its availability.
      const file = writeExportFile([
        { id: 'ok', url: 'https://forgejo.example.com', token: 't', name: 'ok', username: 'user' },
        { id: 'cred', url: 'https://alice:file-token@forgejo.example.com', token: 't', name: 'c', username: 'user' },
      ]);
      await previewExportFile(file);

      const preview = postedMessages(fake.posted).find((m) => m.command === 'importInstancesPreview');
      expect(preview?.dropped).toBe(1);
      const keptInstances = (preview?.instances ?? []) as Array<Record<string, unknown>>;
      expect(keptInstances.map((i) => i.id)).toEqual(['ok']);
    });

    it('drops the plaintext-token stash when the view is disposed', async () => {
      // The stash holds the picked file's tokens in the clear, kept host-side so
      // they never cross into the webview. The webview that could still confirm
      // the import is gone once the view is disposed, so the tokens must not
      // outlive it — nothing else clears the slot until the next preview.
      const file = writeExportFile([
        { id: 'imported-1', url: 'https://forgejo.example.com', token: 'file-token-1', name: 'one', username: 'user' },
      ]);
      await previewExportFile(file);
      expect(provider.hasPendingImportInstancesForTest()).toBe(true);

      fake.dispose();

      expect(provider.hasPendingImportInstancesForTest()).toBe(false);
      // The tokens are gone with the stash: nothing can rehydrate them any more.
      // (After disposal `_reply` has no view to post to, so the stash itself is
      // the observable state — the confirm path cannot reach the file's tokens.)
    });
  });

  /**
   * The AI endpoint half of export/import, end to end through the provider
   * (`docs/design/ai-model-transport.md` §10).
   *
   * These are the cases that need both halves of the feature in one place: the
   * export writer decides what the file carries, the preview decides what the user
   * is shown and asked, and the confirmation decides what is written. The three
   * §11.4 proofs live here — a lossless non-secret round trip, no credential in a
   * plaintext export, and an import that turns no AI switch on — plus the
   * version-2 payload that has to stay importable.
   */
  describe('AI endpoint export/import', () => {
    /** Synthetic credentials: shaped like real ones and belonging to nothing. */
    const AI_KEY = 'sk-ai-round-trip-export-key-0001';
    const AI_HEADER_VALUE = 'ai-header-value-for-the-round-trip';
    const IMPORTED_AI_KEY = 'sk-ai-round-trip-file-key-0002';
    const IMPORTED_AI_HEADER_VALUE = 'ai-header-value-from-the-file';
    const SYNTHETIC_AI_VALUES = [AI_KEY, AI_HEADER_VALUE, IMPORTED_AI_KEY, IMPORTED_AI_HEADER_VALUE];

    const AI_PROVIDER = {
      id: 'ollama-local',
      name: 'Ollama (this machine)',
      baseUrl: 'http://localhost:11434/v1',
      models: [{ id: 'qwen3:8b', name: 'Qwen3 8B' }],
      auth: 'bearer' as const,
      headers: [{ name: 'api-version', valueSecret: true as const }],
    };

    /** The instance every fixture carries, matching the seeded one. */
    const FILE_INSTANCE = {
      id: testInstance.id,
      url: testInstance.url,
      token: 'file-token-1',
      name: testInstance.name,
      username: testInstance.username,
    };

    /** The settings the mocked `getConfiguration` serves and records. */
    let settings: Record<string, unknown>;
    /** The values the fake context's secret store holds, read by key. */
    let secrets: FakeSecretStore;

    beforeEach(() => {
      settings = {};
      secrets = context.secrets as unknown as FakeSecretStore;
      secrets.clear();
      vi.mocked(vscode.workspace.getConfiguration).mockImplementation(
        () =>
          ({
            get: (key: string, fallback?: unknown) => (key in settings ? settings[key] : fallback),
            update: async (key: string, value: unknown) => {
              settings[key] = value;
            },
          }) as never,
      );
    });

    /** What the secret store holds under one key, read without awaiting. */
    function storedSecret(key: string): string | undefined {
      return secrets.values.get(key);
    }

    /** Everything the extension wrote to its output channel. */
    function loggedText(): string {
      const channel = vi.mocked(vscode.window.createOutputChannel).mock.results.at(-1)?.value as
        | { appendLine: { mock: { calls: Array<[string]> } } }
        | undefined;
      return (channel?.appendLine.mock.calls ?? []).map(([line]) => line).join('\n');
    }

    function writeInstancesFile(sections: Record<string, unknown>): string {
      const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ai-import-')), 'export.json');
      fs.writeFileSync(file, JSON.stringify({ version: 3, instances: [FILE_INSTANCE], ...sections }));
      return file;
    }

    /** A hand-written file that carries the AI section, encrypted like the exporter writes it. */
    function writeEncryptedFile(sections: Record<string, unknown>, password = 'pw'): string {
      const iterations = 1000;
      const salt = crypto.randomBytes(16);
      const iv = crypto.randomBytes(16);
      const key = crypto.pbkdf2Sync(password, salt, iterations, 32, 'sha256');
      const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
      const payload = { version: 3, instances: [FILE_INSTANCE], ...sections };
      const encrypted = Buffer.concat([cipher.update(JSON.stringify(payload), 'utf8'), cipher.final()]);
      const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ai-import-enc-')), 'export.json');
      fs.writeFileSync(
        file,
        JSON.stringify({
          version: 3,
          encrypted: true,
          iterations,
          salt: salt.toString('base64'),
          iv: iv.toString('base64'),
          authTag: cipher.getAuthTag().toString('base64'),
          data: encrypted.toString('base64'),
        }),
      );
      return file;
    }

    /** The `ai` section a version-3 file carries, for the hand-written fixtures. */
    function aiSection(extra: Record<string, unknown> = {}): Record<string, unknown> {
      return {
        providers: [AI_PROVIDER],
        bindings: [{ feature: 'aiPreReview', providerId: 'ollama-local', modelId: 'qwen3:8b' }],
        transport: 'openai-compatible',
        ...extra,
      };
    }

    /** Runs one export through the provider and returns the file it wrote. */
    async function exportToFile(options: { encrypt: boolean } = { encrypt: false }): Promise<string> {
      const target = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ai-export-')), 'export.json');
      // Answer the "how to export" dialog explicitly (the shared mock would answer
      // the first button, i.e. encrypt) and then the save dialog.
      vi.mocked(vscode.window.showWarningMessage).mockResolvedValueOnce(
        (options.encrypt ? 'Encrypt with password' : 'Plain text') as never,
      );
      if (options.encrypt) {
        vi.mocked(vscode.window.showInputBox)
          .mockResolvedValueOnce('pw' as never)
          .mockResolvedValueOnce('pw' as never);
      }
      vi.mocked(vscode.window.showSaveDialog).mockResolvedValueOnce({ fsPath: target } as never);

      fake.send({ command: 'exportInstances' });
      await flushUntil(() => postedMessages(fake.posted).some((m) => m.command === 'instancesExported'));

      const reply = postedMessages(fake.posted).find((m) => m.command === 'instancesExported');
      expect(reply?.success).toBe(true);
      return target;
    }

    /** The decrypted payload of an encrypted export file. */
    function decryptFile(file: string, password = 'pw'): { ai?: Record<string, unknown> } {
      const envelope = JSON.parse(fs.readFileSync(file, 'utf8')) as {
        encrypted: boolean;
        salt: string;
        iv: string;
        authTag: string;
        data: string;
        iterations: number;
      };
      const key = crypto.pbkdf2Sync(password, Buffer.from(envelope.salt, 'base64'), envelope.iterations, 32, 'sha256');
      const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(envelope.iv, 'base64'));
      decipher.setAuthTag(Buffer.from(envelope.authTag, 'base64'));
      const plaintext = Buffer.concat([decipher.update(Buffer.from(envelope.data, 'base64')), decipher.final()]);
      return JSON.parse(plaintext.toString('utf8')) as { ai?: Record<string, unknown> };
    }

    /** Reads one file through the preview and returns the reply's AI section. */
    async function previewAi(file: string, password?: string) {
      if (password !== undefined) {
        vi.mocked(vscode.window.showInputBox).mockResolvedValueOnce(password as never);
      }
      vi.mocked(vscode.window.showOpenDialog).mockResolvedValueOnce([vscode.Uri.file(file)] as never);
      // Start from an empty message log: earlier replies from the same test (an
      // export, an earlier preview) are still in `fake.posted`, and `find` would
      // otherwise return one of those instead of this request's answer.
      fake.posted.length = 0;
      fake.send({ command: 'previewImportInstances' });
      await flushUntil(() => postedMessages(fake.posted).some((m) => m.command === 'importInstancesPreview'));
      return postedMessages(fake.posted).find((m) => m.command === 'importInstancesPreview');
    }

    async function confirm(aiConflicts?: Record<string, string>, instanceId: string = FILE_INSTANCE.id) {
      fake.posted.length = 0;
      fake.send({
        command: 'importInstances',
        ids: [instanceId],
        ...(aiConflicts === undefined ? {} : { aiConflicts }),
      });
      await flushUntil(() => postedMessages(fake.posted).some((m) => m.command === 'instancesImported'));
      return postedMessages(fake.posted).find((m) => m.command === 'instancesImported');
    }

    it('round-trips the non-secret configuration, and carries the credentials when encrypted', async () => {
      settings['aiProviders'] = [AI_PROVIDER];
      settings['aiModelBindings'] = [{ feature: 'aiPreReview', providerId: 'ollama-local', modelId: 'qwen3:8b' }];
      settings['aiTransport'] = 'openai-compatible';
      secrets.set('forgejoToolkit.aiProviderKey.ollama-local', AI_KEY);
      secrets.set('forgejoToolkit.aiProviderHeader.ollama-local.api-version', AI_HEADER_VALUE);

      const exported = await exportToFile({ encrypt: true });
      expect(postedMessages(fake.posted).find((m) => m.command === 'instancesExported')?.aiSecretsIncluded).toBe(true);
      // The encrypted file really does carry the credentials — the half that makes
      // "only the encrypted export has them" a statement about a working feature
      // rather than about one that never wrote them anywhere.
      const exportedPayload = decryptFile(exported);
      expect(exportedPayload.ai?.providers).toEqual([AI_PROVIDER]);
      expect(exportedPayload.ai?.secrets).toEqual({
        keys: { 'ollama-local': AI_KEY },
        headerValues: { 'ollama-local': { 'api-version': AI_HEADER_VALUE } },
      });

      // The file the import reads is written by hand so that it carries the
      // instance this window has configured (what the exporter wrote is asserted
      // above, and in the plaintext case where its content is the point).
      const file = writeEncryptedFile({
        ai: aiSection({
          secrets: {
            keys: { 'ollama-local': IMPORTED_AI_KEY },
            headerValues: { 'ollama-local': { 'api-version': IMPORTED_AI_HEADER_VALUE } },
          },
        }),
      });

      // Back to a window that only has the seed instance: what the import does
      // with the file is now a clean question.
      settings = {};
      secrets.clear();

      const preview = await previewAi(file, 'pw');
      expect(preview?.ai).toMatchObject({
        secretsIncluded: true,
        transport: 'openai-compatible',
        providers: [
          {
            id: 'ollama-local',
            name: 'Ollama (this machine)',
            baseUrl: 'http://localhost:11434/v1',
            auth: 'bearer',
            models: ['qwen3:8b'],
            headers: ['api-version'],
            existing: false,
            insecure: true,
          },
        ],
      });
      // No credential reaches the webview, not even inside the preview payload.
      expect(JSON.stringify(preview)).not.toContain(IMPORTED_AI_KEY);
      expect(JSON.stringify(preview)).not.toContain(IMPORTED_AI_HEADER_VALUE);
      expect(provider.hasPendingImportAiForTest()).toBe(true);

      const reply = await confirm();
      expect(reply).toMatchObject({ success: true, count: 1 });

      // Lossless for the non-secret fields, including the transport value the
      // preview showed without applying it.
      expect(settings['aiProviders']).toEqual([AI_PROVIDER]);
      expect(settings['aiModelBindings']).toEqual([
        { feature: 'aiPreReview', providerId: 'ollama-local', modelId: 'qwen3:8b' },
      ]);
      // The credentials landed in the editor's secret storage, not in settings.
      expect(storedSecret('forgejoToolkit.aiProviderKey.ollama-local')).toBe(IMPORTED_AI_KEY);
      expect(storedSecret('forgejoToolkit.aiProviderHeader.ollama-local.api-version')).toBe(IMPORTED_AI_HEADER_VALUE);
      expect(JSON.stringify(settings)).not.toContain(IMPORTED_AI_KEY);
      expect(JSON.stringify(settings)).not.toContain(IMPORTED_AI_HEADER_VALUE);
      // The stash is consumed, credentials and all.
      expect(provider.hasPendingImportAiForTest()).toBe(false);

      for (const value of SYNTHETIC_AI_VALUES) {
        expect(loggedText(), value).not.toContain(value);
      }
    });

    it('writes no key and no header value into a plaintext export, and says so on import', async () => {
      settings['aiProviders'] = [AI_PROVIDER];
      secrets.set('forgejoToolkit.aiProviderKey.ollama-local', AI_KEY);
      secrets.set('forgejoToolkit.aiProviderHeader.ollama-local.api-version', AI_HEADER_VALUE);

      const file = await exportToFile({ encrypt: false });

      const text = fs.readFileSync(file, 'utf8');
      const payload = JSON.parse(text) as { version: number; ai: Record<string, unknown> };
      expect(payload.version).toBe(3);
      // The non-secret half is there, and the marker that says "a value exists" is
      // kept for the receiver (§10.2).
      expect(payload.ai.providers).toEqual([AI_PROVIDER]);
      expect('secrets' in payload.ai).toBe(false);
      for (const value of [AI_KEY, AI_HEADER_VALUE]) {
        expect(text, value).not.toContain(value);
      }
      // The reply and the log never quote a credential either.
      expect(loggedText()).not.toContain(AI_KEY);
      const exportReply = postedMessages(fake.posted).find((m) => m.command === 'instancesExported');
      expect(exportReply?.aiSecretsIncluded).toBe(false);

      // Importing that very file: a receiving machine that already has a credential
      // for the endpoint keeps it, because a plaintext file neither carries one nor
      // may erase one.
      settings = { aiProviders: [{ ...AI_PROVIDER, name: 'already here' }] };
      secrets.set('forgejoToolkit.aiProviderKey.ollama-local', 'sk-existing-local-key');

      const preview = await previewAi(file);
      expect(preview?.ai).toMatchObject({ secretsIncluded: false });
      const ai = preview?.ai as { providers: Array<Record<string, unknown>> } | undefined;
      const aiProviders = ai?.providers ?? [];
      // The collision is the preview's to resolve, and it is what the user sees.
      expect(aiProviders[0]).toMatchObject({ id: 'ollama-local', existing: true });
      expect(aiProviders[0].unusable).toBeUndefined();

      const reply = await confirm({ 'ollama-local': 'keep' });
      expect(reply).toMatchObject({ success: true, count: 1 });
      expect(storedSecret('forgejoToolkit.aiProviderKey.ollama-local')).toBe('sk-existing-local-key');
    });

    it('does not turn AI on: the import leaves the switches and the transport alone', async () => {
      // The receiving machine has an endpoint of its choosing under the same id,
      // its own transport (the working setup a file must not walk back) and its AI
      // switches off. The file names all of them as enabled.
      settings = {
        aiProviders: [{ ...AI_PROVIDER, name: 'already here', baseUrl: 'https://models.example.com/v1' }],
        aiTransport: 'openai-compatible',
        aiEnabled: false,
        aiPreReview: false,
        aiPreReviewPromptScope: 'ask',
      };
      secrets.clear();
      const file = writeEncryptedFile({
        ai: aiSection({
          transport: 'openai-compatible',
          aiEnabled: true,
          aiPreReview: true,
          aiPreReviewPromptScope: 'full-diff',
        }),
      });

      await previewAi(file, 'pw');
      const reply = await confirm({ 'ollama-local': 'replace' });
      expect(reply).toMatchObject({ success: true, count: 1 });

      // The file's endpoint really was written — otherwise "the switches are off"
      // would prove nothing about the import. The stored entry is replaced by the
      // file's own declaration, name included.
      expect(settings['aiProviders']).toEqual([AI_PROVIDER]);
      expect(settings['aiEnabled']).toBe(false);
      expect(settings['aiPreReview']).toBe(false);
      expect(settings['aiPreReviewPromptScope']).toBe('ask');
      // Not written at all, so the receiving machine's choice survives verbatim.
      expect(settings['aiTransport']).toBe('openai-compatible');
      expect(loggedText()).not.toContain('aiTransport');
    });

    it('never writes the transport or the AI switches, whatever the file carries', async () => {
      // The strictest form of the rule: a file that names all of them, applied by
      // the narrowest path (no collision, so the entry is added as it stands).
      const file = writeInstancesFile({
        ai: aiSection({
          transport: 'openai-compatible',
          aiEnabled: true,
          aiPreReview: true,
          aiPreReviewPromptScope: 'full-diff',
        }),
      });

      const preview = await previewAi(file);
      const previewIds = ((preview?.instances ?? []) as Array<Record<string, unknown>>).map((i) => i.id);
      expect(previewIds).toEqual([FILE_INSTANCE.id]);
      const reply = await confirm({}, FILE_INSTANCE.id);
      expect(reply).toMatchObject({ success: true, count: 1 });

      expect(Object.keys(settings).sort()).toEqual(['aiModelBindings', 'aiProviders']);
      expect(settings['aiEnabled']).toBeUndefined();
      expect(settings['aiPreReview']).toBeUndefined();
      expect(settings['aiPreReviewPromptScope']).toBeUndefined();
      expect(settings['aiTransport']).toBeUndefined();
      // And the AI section really was applied, so the assertion above has a
      // subject: the endpoint and its binding are there.
      expect((settings['aiProviders'] as Array<{ id: string }>).map((entry) => entry.id)).toEqual(['ollama-local']);
    });

    it('pushes the AI endpoint snapshot after an import that carried the AI section', async () => {
      // The page reads the AI surface only on mount and then renders whatever the
      // host pushed last, so an import that writes endpoints or bindings has to
      // re-push it — measured on a live walkthrough: the settings file held the
      // imported endpoint and the binding naming it while the page still showed the
      // pre-import list, policy mirror and binding label until the window reloaded.
      const file = writeInstancesFile({
        ai: aiSection({
          providers: [{ ...AI_PROVIDER, id: 'imported-endpoint', name: 'Imported endpoint' }],
          bindings: [{ feature: 'aiPreReview', providerId: 'imported-endpoint', modelId: 'qwen3:8b' }],
        }),
      });

      await previewAi(file);
      const reply = await confirm({}, FILE_INSTANCE.id);
      expect(reply).toMatchObject({ success: true, count: 1 });
      await flushUntil(() => postedMessages(fake.posted).some((m) => m.command === 'aiProviderSettings'));

      const push = postedMessages(fake.posted).find((m) => m.command === 'aiProviderSettings');
      // The snapshot has to carry what the import wrote, not a fresh empty state:
      // the endpoints and the binding below are the two things the page renders.
      expect(push).toBeDefined();
      const snapshot = push?.snapshot as
        | { providers: Array<Record<string, unknown>>; bindings: Array<Record<string, unknown>> }
        | undefined;
      const provider = snapshot?.providers.find((entry) => entry.id === 'imported-endpoint');
      expect(provider).toMatchObject({ name: 'Imported endpoint', baseUrl: AI_PROVIDER.baseUrl });
      expect(snapshot?.bindings).toEqual([
        { feature: 'aiPreReview', providerId: 'imported-endpoint', modelId: 'qwen3:8b' },
      ]);
      // A push rather than an answer: it carries no request id, exactly like the
      // one a page-initiated write gets.
      expect(push?._requestId).toBeUndefined();
    });

    it('does not push the AI endpoint snapshot for a file that carries no AI section', async () => {
      // A version 2 file has no AI half at all, so the page's snapshot is not
      // stale and a push would only be noise.
      const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ai-import-v2-')), 'export.json');
      fs.writeFileSync(file, JSON.stringify({ version: 2, instances: [FILE_INSTANCE] }));

      await previewAi(file);
      const reply = await confirm({}, FILE_INSTANCE.id);
      expect(reply).toMatchObject({ success: true, count: 1 });

      expect(postedMessages(fake.posted).some((m) => m.command === 'aiProviderSettings')).toBe(false);
    });

    it('still imports a version 2 payload, which carries no AI section', async () => {
      const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ai-import-v2-')), 'export.json');
      fs.writeFileSync(file, JSON.stringify({ version: 2, instances: [FILE_INSTANCE], settings: { debug: false } }));

      const preview = await previewAi(file);

      // Absent, not an empty section: an older file has no AI configuration to
      // show, which is a different statement from "it has none configured".
      expect(preview?.ai).toBeUndefined();
      expect(preview?.instances).toHaveLength(1);
      const reply = await confirm({}, FILE_INSTANCE.id);
      expect(reply).toMatchObject({ success: true, count: 1 });
      expect(settings['aiProviders']).toBeUndefined();
      // Only the instance list was imported: the settings block of a version 2 file
      // is applied through ConfigManager, not through this test's settings mock, so
      // what the assertion pins is that no AI key was written.
      expect(Object.keys(settings)).toEqual([]);
    });

    it('shows an unusable entry in the preview and never writes it', async () => {
      const file = writeInstancesFile({
        ai: aiSection({
          providers: [AI_PROVIDER, { ...AI_PROVIDER, id: 'file-endpoint', baseUrl: 'file:///tmp/v1' }],
        }),
      });

      const preview = await previewAi(file);
      const ai = preview?.ai as { providers: Array<Record<string, unknown>> } | undefined;
      const aiProviders = ai?.providers ?? [];
      expect(aiProviders.map((provider) => provider.id)).toEqual(['ollama-local', 'file-endpoint']);
      expect(aiProviders[1].unusable).toContain('its scheme is "file:"');

      await confirm({}, FILE_INSTANCE.id);
      expect((settings['aiProviders'] as Array<{ id: string }>).map((entry) => entry.id)).toEqual(['ollama-local']);
    });

    it('drops the parsed AI stash on cancel, so a later confirm cannot apply it', async () => {
      const file = writeInstancesFile({ ai: aiSection() });
      await previewAi(file);
      expect(provider.hasPendingImportAiForTest()).toBe(true);

      fake.send({ command: 'cancelImportInstances' });

      expect(provider.hasPendingImportAiForTest()).toBe(false);
      expect(provider.hasPendingImportInstancesForTest()).toBe(false);
    });

    it('drops the parsed AI stash when the view is disposed', async () => {
      const file = writeInstancesFile({ ai: aiSection() });
      await previewAi(file);
      expect(provider.hasPendingImportAiForTest()).toBe(true);

      fake.dispose();

      expect(provider.hasPendingImportAiForTest()).toBe(false);
    });
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
    // The failure reply crosses the worktree manager's real fs promise chain,
    // so a fixed two-tick flush can finish before the reply is posted.
    await flushUntil(() =>
      postedMessages(fake.posted).some((m) => m.command === 'worktreeError' && m.operation === 'remove'),
    );

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

  it('pushes the refreshed worktree list when an instance is removed', async () => {
    // Removing an instance forgets its worktree records (their checkouts stay on
    // disk). The Settings list renders `worktrees`, which only a `worktreesList`
    // reply updates: without one the forgotten rows stay on screen and deleting
    // one reaches the host with no record behind it.
    await context.globalState.update('forgejoToolkit.worktrees', [
      {
        id: 'w-gone',
        instanceId: testInstance.id,
        owner: 'owner',
        repo: 'repo',
        prIndex: 1,
        prTitle: 'title',
        headBranch: 'feature',
        headSha: 'abc1234',
        baseBranch: 'main',
        sourceRepoPath: '/src/repo',
        worktreePath: '/cache/worktrees/w-gone',
        createdAt: 0,
      },
    ]);

    fake.send({ command: 'removeInstance', id: testInstance.id });
    await flushDispatches();

    const lists = postedMessages(fake.posted).filter((m) => m.command === 'worktreesList');
    expect(lists.length).toBeGreaterThan(0);
    expect(lists.at(-1)!.worktrees).toEqual([]);
  });

  it('names the checkouts left on disk when an instance is removed', async () => {
    // The records are forgotten but the checkouts stay (they may hold work). A
    // checkout backed by an ordinary clone is never reclaimed by the lazy sweep,
    // so without naming it the user can no longer find it anywhere.
    await context.globalState.update('forgejoToolkit.worktrees', [
      {
        id: 'w-gone',
        instanceId: testInstance.id,
        owner: 'owner',
        repo: 'repo',
        prIndex: 1,
        prTitle: 'title',
        headBranch: 'feature',
        headSha: 'abc1234',
        baseBranch: 'main',
        sourceRepoPath: '/src/repo',
        worktreePath: '/cache/worktrees/w-gone',
        createdAt: 0,
      },
    ]);
    vi.mocked(vscode.window.showInformationMessage).mockClear();

    fake.send({ command: 'removeInstance', id: testInstance.id });
    await flushDispatches();

    const message = vi.mocked(vscode.window.showInformationMessage).mock.calls.at(-1)?.[0] as string;
    expect(message).toContain('/cache/worktrees/w-gone');
  });

  it('answers a stale worktree row with no record behind it honestly', async () => {
    // A row rendered before its record was dropped (e.g. when its instance was
    // removed) has nothing left to delete. Answering `worktreeRemoved` would tell
    // the user it was deleted while the checkout stays on disk, so the host must
    // report why it did nothing instead.
    const confirmsBefore = vi.mocked(vscode.window.showWarningMessage).mock.calls.length;

    fake.send({ command: 'removeWorktree', id: 'w-stale' });
    await flushDispatches();

    const messages = postedMessages(fake.posted);
    expect(messages.some((m) => m.command === 'worktreeRemoved')).toBe(false);
    const error = messages.find((m) => m.command === 'worktreeError');
    expect(error).toMatchObject({ operation: 'remove' });
    expect(typeof error?.error).toBe('string');
    // Nothing will be deleted, so the destructive prompt must not appear either.
    expect(vi.mocked(vscode.window.showWarningMessage).mock.calls.length).toBe(confirmsBefore);
    expect(vi.mocked(removeWorktreeAndPrune)).not.toHaveBeenCalled();
  });

  describe('stale worktree discard confirmation', () => {
    // The forced removal deletes the checkout and its throwaway branch, so the
    // decision to skip the prompt may only hinge on a *known* absence of local
    // work. An unknown commit count (the PR head sha was never fetched, so
    // `rev-list` cannot resolve the range) is not evidence that nothing would be
    // lost.
    function confirmDiscard(info: StalePrWorktreeInfo, index = 5): Promise<boolean> {
      return (
        provider as unknown as {
          _confirmDiscardStaleWorktree: (info: StalePrWorktreeInfo, index: number) => Promise<boolean>;
        }
      )._confirmDiscardStaleWorktree(info, index);
    }

    it('asks before discarding when the local commit count could not be determined', async () => {
      vi.mocked(vscode.window.showWarningMessage).mockResolvedValueOnce(undefined as never);

      const confirmed = await confirmDiscard({ dirty: false, commitsAhead: undefined });

      // Declined: the caller must not discard the checkout.
      expect(confirmed).toBe(false);
      const message = vi.mocked(vscode.window.showWarningMessage).mock.calls.at(-1)?.[0] as string;
      expect(message).toContain('could not be counted');
      expect(message).toContain('lost');
    });

    it('discards a clean leftover with no local commits without prompting', async () => {
      vi.mocked(vscode.window.showWarningMessage).mockClear();

      const confirmed = await confirmDiscard({ dirty: false, commitsAhead: 0 });

      expect(confirmed).toBe(true);
      expect(vscode.window.showWarningMessage).not.toHaveBeenCalled();
    });
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
      {
        command: 'createRepoBranch',
        result: 'repoBranchCreated',
        message: { owner: 'owner', repo: 'repo', newBranchName: 'feature', oldRefName: 'main' },
        echo: { owner: 'owner', repo: 'repo' },
      },
      {
        command: 'deleteRepoBranch',
        result: 'repoBranchDeleted',
        message: { owner: 'owner', repo: 'repo', branch: 'feature' },
        echo: { owner: 'owner', repo: 'repo' },
      },
      {
        command: 'createRepoTag',
        result: 'repoTagCreated',
        message: { owner: 'owner', repo: 'repo', tagName: 'v1.0.0', target: 'main' },
        echo: { owner: 'owner', repo: 'repo' },
      },
      {
        command: 'deleteRepoTag',
        result: 'repoTagDeleted',
        message: { owner: 'owner', repo: 'repo', tag: 'v1.0.0' },
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

  describe('load/mutation requests carrying no instanceId', () => {
    // A malformed message (instanceId missing or not a string) used to slip
    // past the deleted-instance pre-check, which only fired on a string value;
    // the handler's `_findInstance(undefined)` then missed and returned without
    // replying, and the webview's loading state never cleared.
    it('answers a load request without instanceId through its own result shape', async () => {
      fake.send({ command: 'getRepoDetail', owner: 'owner', repo: 'repo' });
      await flushDispatches();

      const reply = postedMessages(fake.posted).find((m) => m.command === 'repoDetail');
      expect(reply).toMatchObject({
        owner: 'owner',
        repo: 'repo',
        error: 'The request could not be completed',
      });
      // Nothing to echo: the request carried no instanceId, so the reply does
      // not invent one.
      expect(reply?.instanceId).toBeUndefined();
    });

    it('answers a mutation request without instanceId through its own result shape', async () => {
      fake.send({ command: 'deleteIssue', owner: 'owner', repo: 'repo', index: 5 });
      await flushDispatches();

      const reply = postedMessages(fake.posted).find((m) => m.command === 'issueDeleted');
      expect(reply).toMatchObject({
        owner: 'owner',
        repo: 'repo',
        index: 5,
        error: 'The request could not be completed',
      });
      expect(reply?.instanceId).toBeUndefined();
    });

    it('still lets a valid request through to its handler', async () => {
      clientMocks.getRepoDetail.mockResolvedValue({ repository: { name: 'repo' } });
      fake.send({ command: 'getRepoDetail', instanceId: testInstance.id, owner: 'owner', repo: 'repo' });
      await flushUntil(() => postedMessages(fake.posted).some((m) => m.command === 'repoDetail'));

      // The pre-check passed the message on: the handler ran and answered.
      expect(clientMocks.getRepoDetail).toHaveBeenCalledWith('owner', 'repo');
    });
  });

  describe('failure replies echo the action the request carried', () => {
    // The shared contract documents `action` as echoed from the request. The
    // handlers used to hardcode it ('add' for every dependency/reaction
    // failure, 'start' for every failed stopwatch command), so a consumer
    // routing a failure reply would read the wrong operation. No consumer
    // reads the field today; these tests keep the contract honest for the one
    // that starts to.
    const failureCases: Array<{
      command: string;
      result: string;
      message: Record<string, unknown>;
      echo: Record<string, unknown>;
      action: string;
    }> = [
      {
        command: 'createIssueDependency',
        result: 'issueDependencyChanged',
        message: { owner: 'owner', repo: 'repo', index: 5, dependencyIndex: 6 },
        echo: { owner: 'owner', repo: 'repo', index: 5, dependencyIndex: 6, action: 'add' },
        action: 'add',
      },
      {
        command: 'removeIssueDependency',
        result: 'issueDependencyChanged',
        message: { owner: 'owner', repo: 'repo', index: 5, dependencyIndex: 6 },
        echo: { owner: 'owner', repo: 'repo', index: 5, dependencyIndex: 6, action: 'remove' },
        action: 'remove',
      },
      {
        command: 'changeIssueReaction',
        result: 'issueReactionChanged',
        message: { owner: 'owner', repo: 'repo', index: 5, content: '+1', add: true },
        echo: { owner: 'owner', repo: 'repo', index: 5, content: '+1', action: 'add' },
        action: 'add',
      },
      {
        command: 'changeIssueReaction',
        result: 'issueReactionChanged',
        message: { owner: 'owner', repo: 'repo', index: 5, content: '+1', add: false },
        echo: { owner: 'owner', repo: 'repo', index: 5, content: '+1', action: 'remove' },
        action: 'remove',
      },
      {
        command: 'changeCommentReaction',
        result: 'commentReactionChanged',
        message: { owner: 'owner', repo: 'repo', commentId: 7, content: 'heart', add: true },
        echo: { owner: 'owner', repo: 'repo', commentId: 7, content: 'heart', action: 'add' },
        action: 'add',
      },
      {
        command: 'changeCommentReaction',
        result: 'commentReactionChanged',
        message: { owner: 'owner', repo: 'repo', commentId: 7, content: 'heart', add: false },
        echo: { owner: 'owner', repo: 'repo', commentId: 7, content: 'heart', action: 'remove' },
        action: 'remove',
      },
      {
        command: 'startIssueStopwatch',
        result: 'issueStopwatchChanged',
        message: { owner: 'owner', repo: 'repo', index: 5 },
        echo: { owner: 'owner', repo: 'repo', index: 5, action: 'start' },
        action: 'start',
      },
      {
        command: 'stopIssueStopwatch',
        result: 'issueStopwatchChanged',
        message: { owner: 'owner', repo: 'repo', index: 5 },
        echo: { owner: 'owner', repo: 'repo', index: 5, action: 'stop' },
        action: 'stop',
      },
      {
        command: 'deleteIssueStopwatch',
        result: 'issueStopwatchChanged',
        message: { owner: 'owner', repo: 'repo', index: 5 },
        echo: { owner: 'owner', repo: 'repo', index: 5, action: 'delete' },
        action: 'delete',
      },
    ];

    for (const { command, result, message, echo, action } of failureCases) {
      it(`reports action "${action}" on a failed ${command}`, async () => {
        fake.send({ command, instanceId: testInstance.id, ...message });
        await flushDispatches();

        const reply = postedMessages(fake.posted).find((m) => m.command === result);
        expect(reply).toBeDefined();
        expect(typeof reply?.error).toBe('string');
        // The whole reply shape, so the echoed action cannot drift away from the
        // rest of the request echo either.
        expect(reply).toMatchObject({ instanceId: testInstance.id, ...echo });
      });
    }

    it('resets the echoed action to the request, not to the previous reply', async () => {
      // Two requests in flight, opposite actions, both fail: an
      // implementation that remembered the last action instead of reading the
      // request would answer the second with the first one's value.
      fake.send({
        command: 'changeIssueReaction',
        instanceId: testInstance.id,
        owner: 'owner',
        repo: 'repo',
        index: 5,
        content: '+1',
        add: true,
      });
      fake.send({
        command: 'changeIssueReaction',
        instanceId: testInstance.id,
        owner: 'owner',
        repo: 'repo',
        index: 5,
        content: '+1',
        add: false,
      });
      await flushDispatches();

      const replies = postedMessages(fake.posted).filter((m) => m.command === 'issueReactionChanged');
      expect(replies.map((reply) => reply.action)).toEqual(['add', 'remove']);
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

  describe('dashboard list request id echo', () => {
    // The `_requestId` the webview generates: the host must not read it, only echo
    // it. An instance edit keeps the instance id, so the replaced server's reply
    // and the reload's reply for one slot are otherwise identical — the echoed id
    // is what lets the webview attribute each one (see
    // useAppState.instanceListReplyAttribution.test.ts).
    const requestId = 'list-repos-7';

    it('echoes the request id the getRepositories request sent', async () => {
      clientMocks.getUserRepositories.mockResolvedValue({ items: [] });
      fake.send({ command: 'getRepositories', instanceId: testInstance.id, _requestId: requestId });
      await flushDispatches();

      const reply = postedMessages(fake.posted).find((m) => m.command === 'repositories');
      expect(reply).toMatchObject({ instanceId: testInstance.id, _requestId: requestId });
      // The dispatcher's fallback must not also answer a request the handler
      // already answered with the echoed id.
      expect(postedMessages(fake.posted).some((m) => m.command === 'requestError')).toBe(false);
    });

    it('echoes the request id on the getRepositories failure reply', async () => {
      // The failure reply is the one that must not lose the id: without it the
      // webview falls back to the oldest queued record, which is not necessarily
      // the request this failure belongs to.
      clientMocks.getUserRepositories.mockRejectedValue(new Error('API down'));
      fake.send({ command: 'getRepositories', instanceId: testInstance.id, _requestId: requestId });
      await flushDispatches();

      const reply = postedMessages(fake.posted).find((m) => m.command === 'repositories');
      expect(reply).toMatchObject({ _requestId: requestId, error: 'API down' });
    });

    it('echoes the request id each myIssues/myPullRequests request sent', async () => {
      clientMocks.getUserIssues.mockResolvedValue([]);
      clientMocks.getUserPullRequests.mockResolvedValue([]);
      fake.send({ command: 'getMyIssues', instanceId: testInstance.id, state: 'open', _requestId: 'list-issues-3' });
      fake.send({
        command: 'getMyPullRequests',
        instanceId: testInstance.id,
        state: 'open',
        _requestId: 'list-pulls-4',
      });
      await flushDispatches();

      expect(postedMessages(fake.posted).find((m) => m.command === 'myIssues')).toMatchObject({
        _requestId: 'list-issues-3',
      });
      expect(postedMessages(fake.posted).find((m) => m.command === 'myPullRequests')).toMatchObject({
        _requestId: 'list-pulls-4',
      });
    });

    it('echoes the id on the deleted-instance reply so the slot still clears', async () => {
      // The pre-handler guard answers a request whose instance is gone by copying
      // the request fields back (minus `command`), and that has to include the id:
      // otherwise the reply would be attributed by arrival order in the webview.
      fake.send({ command: 'getMyIssues', instanceId: 'gone-instance', _requestId: 'list-issues-gone' });
      await flushDispatches();

      const reply = postedMessages(fake.posted).find((m) => m.command === 'myIssues');
      expect(reply).toMatchObject({ instanceId: 'gone-instance', _requestId: 'list-issues-gone' });
      expect(typeof reply?.error).toBe('string');
    });

    it('omits the id when the request carried none', async () => {
      // A webview payload without a `_requestId` still gets its answer, and the
      // reply must not carry a fabricated id: the webview has no request of that
      // id outstanding and would drop the reply.
      clientMocks.getUserIssues.mockResolvedValue([]);
      fake.send({ command: 'getMyIssues', instanceId: testInstance.id });
      await flushDispatches();

      const reply = postedMessages(fake.posted).find((m) => m.command === 'myIssues');
      expect(reply).toMatchObject({ instanceId: testInstance.id });
      expect(reply?._requestId).toBeUndefined();
    });
  });

  describe('worktree request field validation', () => {
    // The webview is untrusted and these fields end up in `path.join(cacheDir,
    // 'worktrees', ...)`, which the flow later deletes recursively.
    const hostileTargets = [
      { owner: 'owner', repo: 'repo', index: '1/../../../../tmp/pwned' },
      { owner: 'owner', repo: 'x/../../repo', index: 1 },
      { owner: '..', repo: 'repo', index: 1 },
      { owner: 'owner', repo: '..', index: 1 },
      { owner: 'owner', repo: 'repo', index: -1 },
      { owner: 'owner', repo: 'repo', index: 1.5 },
    ];

    it.each(hostileTargets)('ignores openPrWorktree with %j and replies so the spinner clears', async (target) => {
      fake.send({ command: 'openPrWorktree', instanceId: testInstance.id, ...target });
      // The invalid-target reply goes through the same in-flight queue as the
      // real handler, so it is not necessarily posted within two macrotasks.
      await flushUntil(() => postedMessages(fake.posted).some((m) => m.command === 'worktreeError'));

      expect(clientMocks.getPullRequestDetail).not.toHaveBeenCalled();
      expect(vi.mocked(cloneRepository)).not.toHaveBeenCalled();
      expect(vi.mocked(openWorktree)).not.toHaveBeenCalled();
      expect(postedMessages(fake.posted).filter((m) => m.command === 'worktreeOpened')).toHaveLength(0);
      // The PR view sets its spinner before posting and only a worktreeError
      // with operation 'open' clears it; a silent drop would leave it spinning.
      const replies = postedMessages(fake.posted).filter((m) => m.command === 'worktreeError');
      expect(replies).toHaveLength(1);
      expect(replies[0]).toMatchObject({
        error: 'The request could not be completed',
        operation: 'open',
        instanceId: testInstance.id,
      });
    });

    it.each(hostileTargets)('ignores startWorkOnIssue with %j but replies so the spinner clears', async (target) => {
      fake.send({ command: 'startWorkOnIssue', instanceId: testInstance.id, ...target });
      // The invalid-target reply goes through the same in-flight queue as the
      // real handler, so it is not necessarily posted within two macrotasks.
      await flushUntil(() => postedMessages(fake.posted).some((m) => m.command === 'startWorkResult'));

      expect(vi.mocked(fetchBranch)).not.toHaveBeenCalled();
      expect(vi.mocked(createWorktreeWithNewBranch)).not.toHaveBeenCalled();
      expect(vi.mocked(openWorktree)).not.toHaveBeenCalled();
      // The webview started its start-work spinner before posting and only a
      // startWorkResult clears it; a silent drop would leave it spinning.
      const replies = postedMessages(fake.posted).filter((m) => m.command === 'startWorkResult');
      expect(replies).toHaveLength(1);
      expect(replies[0]).toMatchObject({ error: 'The request could not be completed' });
      // The reply echoes the identity fields exactly as they arrived, so it
      // routes to the same loading key the request used
      // (`instanceId:owner/repo:start-work:index`, built by string
      // interpolation of what the webview posted). A substituted value would
      // build a different key and the spinner would never clear.
      expect(replies[0]).toMatchObject({
        instanceId: testInstance.id,
        owner: target.owner,
        repo: target.repo,
        index: target.index,
      });
    });

    it('echoes a non-integer route index the way it arrived so the spinner key matches', async () => {
      // The webview interpolates what it sent into its loading key; the reply
      // must carry the same value, not a coerced 0 (which would leave the
      // spinner running under the key the request actually used).
      fake.send({ command: 'startWorkOnIssue', instanceId: testInstance.id, owner: 'owner', repo: 'repo', index: '1' });
      await flushUntil(() => postedMessages(fake.posted).some((m) => m.command === 'startWorkResult'));

      const replies = postedMessages(fake.posted).filter((m) => m.command === 'startWorkResult');
      expect(replies).toHaveLength(1);
      expect(replies[0]).toMatchObject({ instanceId: testInstance.id, owner: 'owner', repo: 'repo', index: '1' });
      expect(replies[0]?.index).not.toBe(0);
      expect(vi.mocked(createWorktreeWithNewBranch)).not.toHaveBeenCalled();
    });

    it('still accepts an ordinary repository identity', async () => {
      vi.mocked(isCurrentWorkspaceBaseRepo).mockResolvedValue('/src/repo' as never);
      vi.mocked(inspectPrWorktree).mockResolvedValue({ state: 'missing' });
      vi.mocked(fetchPullRequestHead).mockResolvedValue(undefined);
      vi.mocked(getRefCommitSha).mockResolvedValue('abcdef1234567890');
      clientMocks.getPullRequestDetail.mockResolvedValue({
        title: 'Demo PR',
        head: { ref: 'feature', sha: 'abcdef1234567890' },
        base: { ref: 'main' },
      });
      vi.spyOn(config, 'getWorktreeOpenMode').mockReturnValue('newWindow');

      fake.send({ command: 'openPrWorktree', instanceId: testInstance.id, owner: 'owner', repo: 'repo', index: 1 });
      await flushUntil(() => postedMessages(fake.posted).some((m) => m.command === 'worktreeOpened'));

      expect(clientMocks.getPullRequestDetail).toHaveBeenCalledWith('owner', 'repo', 1);
    });
  });

  describe('openPrWorktree bare clone dedup', () => {
    let cacheDir: string;

    beforeEach(() => {
      cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'worktree-cache-dedup-'));
      // Fresh cache directory: the leftover path never exists, so inspection
      // reports it as missing and the flow continues to the clone.
      vi.mocked(inspectPrWorktree).mockReset();
      vi.mocked(inspectPrWorktree).mockResolvedValue({ state: 'missing' });
      vi.mocked(discardStalePrWorktree).mockReset();
      vi.mocked(discardStalePrWorktree).mockResolvedValue(undefined);
    });

    afterEach(() => {
      removeTempDirSync(cacheDir);
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

    /** Answers the source picker with a folder the user selects by hand. */
    function primeLocalFolderPath(remotes: Array<{ name: string; url: string }>) {
      vi.mocked(isCurrentWorkspaceBaseRepo).mockResolvedValue(undefined as never);
      vi.mocked(findLocalRepo).mockResolvedValue(undefined as never);
      vi.spyOn(config, 'getWorktreeOpenMode').mockReturnValue('newWindow');
      vi.spyOn(config, 'getWorktreeCacheDirectory').mockReturnValue(cacheDir);
      clientMocks.getPullRequestDetail.mockResolvedValue({
        title: 'Demo PR',
        head: { ref: 'feature', sha: 'abcdef1234567890' },
        base: { ref: 'main' },
      });
      vi.mocked(vscode.window.showQuickPick).mockImplementation(async (items) => {
        const list = items as unknown as Array<{ value?: string }>;
        return list.find((item) => item.value === 'select') as never;
      });
      vi.mocked(vscode.window.showOpenDialog).mockResolvedValue([{ fsPath: '/picked/repo', scheme: 'file' }] as never);
      vi.mocked(isGitRepository).mockResolvedValue(true);
      vi.mocked(listRemotes).mockResolvedValue(remotes as never);
      vi.mocked(getRefCommitSha).mockResolvedValue('abcdef1234567890');
      vi.mocked(inspectPrWorktree).mockResolvedValue({ state: 'missing' });
    }

    it('accepts a picked folder whose remote is the same repository over another transport', async () => {
      // The source check compares transports, not spellings: `alice@host:o/r.git`
      // names the same repository as the instance's https URL, and credentials in
      // either URL are ignored. The old shared-normalizer comparison rejected it,
      // which the user saw as "Selected repository does not match the PR base
      // repository" for their own checkout.
      primeLocalFolderPath([{ name: 'origin', url: 'alice@forgejo.example.com:owner/repo.git' }]);
      vi.mocked(resolveRemoteForRepo).mockResolvedValue('origin');
      vi.mocked(fetchPullRequestHead).mockResolvedValue(undefined);

      fake.send({ command: 'openPrWorktree', instanceId: testInstance.id, owner: 'owner', repo: 'repo', index: 1 });
      await flushUntil(() => vi.mocked(resolveRemoteForRepo).mock.calls.length > 0);

      const errors = postedMessages(fake.posted)
        .filter((message) => message.command === 'worktreeError')
        .map((message) => String(message.error));
      expect(errors.some((error) => error.includes('does not match'))).toBe(false);
      expect(vi.mocked(resolveRemoteForRepo)).toHaveBeenCalledWith('/picked/repo', testInstance.url, 'owner', 'repo');
    });

    it('refuses a picked folder whose remote belongs to another repository', async () => {
      primeLocalFolderPath([{ name: 'origin', url: 'git@forgejo.example.com:someone/else.git' }]);

      fake.send({ command: 'openPrWorktree', instanceId: testInstance.id, owner: 'owner', repo: 'repo', index: 1 });
      await flushUntil(() => postedMessages(fake.posted).some((m) => m.command === 'worktreeError'));

      const error = postedMessages(fake.posted).find((message) => message.command === 'worktreeError');
      expect(String(error?.error)).toContain('does not match');
      expect(vi.mocked(resolveRemoteForRepo)).not.toHaveBeenCalled();
    });

    it('follows the locale setting when it is changed outside the panel', async () => {
      // The in-panel picker posts `setLocale`; the Settings editor only changes
      // the configuration, so the host has to push the new language to the open
      // view (and refresh its title) itself.
      const listener = vi.mocked(vscode.workspace.onDidChangeConfiguration).mock.calls.at(-1)?.[0] as
        | ((event: { affectsConfiguration(key: string): boolean }) => void)
        | undefined;
      expect(listener).toBeTypeOf('function');
      vi.mocked(vscode.workspace.getConfiguration).mockReturnValue({
        get: (key: string) => (key === 'locale' ? 'zh' : undefined),
        update: vi.fn(),
      } as never);

      listener?.({ affectsConfiguration: (key: string) => key === 'forgejoToolkit.locale' });
      await flushDispatches();

      expect(postedMessages(fake.posted)).toContainEqual(
        expect.objectContaining({ command: 'setLocale', locale: 'zh' }),
      );
    });

    it('ignores unrelated configuration changes', async () => {
      const listener = vi.mocked(vscode.workspace.onDidChangeConfiguration).mock.calls.at(-1)?.[0] as
        | ((event: { affectsConfiguration(key: string): boolean }) => void)
        | undefined;
      const before = postedMessages(fake.posted).length;

      listener?.({ affectsConfiguration: () => false });
      await flushDispatches();

      expect(postedMessages(fake.posted)).toHaveLength(before);
    });

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

    /** The cache path the flow derives for the seeded instance and owner/repo. */
    function cacheRepoPath() {
      return path.join(cacheDir, 'repos', `owner-repo-${instanceCacheSuffix(testInstance)}.git`);
    }

    it('reclaims an incomplete cache clone remnant and re-clones it', async () => {
      // A `git clone` killed mid-transfer leaves a directory without a usable
      // `remote.origin.url`. An existence-only reuse check skips the clone for
      // it forever, and every open then fails at remote resolution instead.
      primeClonePath();
      const remnant = cacheRepoPath();
      await fs.promises.mkdir(remnant, { recursive: true });
      await fs.promises.writeFile(path.join(remnant, 'sentinel'), 'leftover', 'utf8');
      vi.mocked(hasUsableOriginRemote).mockResolvedValue(false);
      vi.mocked(cloneRepository).mockImplementation(async (_url: string, target: string) => {
        await fs.promises.mkdir(target, { recursive: true });
      });

      fake.send({ command: 'openPrWorktree', instanceId: testInstance.id, owner: 'owner', repo: 'repo', index: 1 });
      await flushUntil(() => postedMessages(fake.posted).some((m) => m.command === 'worktreeOpened'));

      // The remnant was deleted (its sentinel is gone) and the path re-cloned.
      expect(vi.mocked(cloneRepository)).toHaveBeenCalledTimes(1);
      await expect(fs.promises.access(path.join(remnant, 'sentinel'))).rejects.toThrow();
    });

    it('leaves an incomplete cache clone alone while another window owns it', async () => {
      // The `<basename>.clone-owner.*` marker says another extension host is
      // cloning into the path right now; deleting its work would break that
      // clone, so the remnant is left in place and the previous "exists means
      // reuse" behavior applies (this attempt fails later at remote resolution,
      // which is transient once the other clone lands).
      primeClonePath();
      const remnant = cacheRepoPath();
      await fs.promises.mkdir(remnant, { recursive: true });
      await fs.promises.writeFile(path.join(remnant, 'sentinel'), 'leftover', 'utf8');
      const markerPath = `${remnant}.clone-owner.1234-abcd`;
      await fs.promises.writeFile(markerPath, '1234-abcd', 'utf8');
      vi.mocked(hasUsableOriginRemote).mockResolvedValue(false);

      fake.send({ command: 'openPrWorktree', instanceId: testInstance.id, owner: 'owner', repo: 'repo', index: 1 });
      await flushUntil(() => postedMessages(fake.posted).some((m) => m.command === 'worktreeOpened'));

      expect(vi.mocked(cloneRepository)).not.toHaveBeenCalled();
      await fs.promises.access(path.join(remnant, 'sentinel'));
      await fs.promises.access(markerPath);
    });

    it('gives the same owner/repo on two instances different worktree directories', async () => {
      primeClonePath();
      vi.mocked(cloneRepository).mockImplementation(async (_url: string, target: string) => {
        await fs.promises.mkdir(target, { recursive: true });
      });
      const otherInstance = {
        id: 'other.example.com-user',
        url: 'https://other.example.com',
        token: 'other-token',
        name: 'user@other.example.com',
        username: 'user',
      };
      await config.addInstance(otherInstance);

      fake.send({ command: 'openPrWorktree', instanceId: testInstance.id, owner: 'owner', repo: 'repo', index: 1 });
      await flushUntil(() => postedMessages(fake.posted).some((m) => m.command === 'worktreeOpened'));
      fake.send({ command: 'openPrWorktree', instanceId: otherInstance.id, owner: 'owner', repo: 'repo', index: 1 });
      await flushUntil(() => postedMessages(fake.posted).filter((m) => m.command === 'worktreeOpened').length === 2);

      // A shared `worktrees/owner-repo-pr-1` would let the second instance open
      // - and the stale-worktree cleanup delete - the first instance's checkout.
      const openedPaths = vi
        .mocked(openWorktree)
        .mock.calls.map((call) => String(call[0]))
        .slice(-2);
      expect(openedPaths).toHaveLength(2);
      expect(openedPaths[0]).not.toBe(openedPaths[1]);
      for (const openedPath of openedPaths) {
        expect(path.dirname(openedPath)).toBe(path.join(cacheDir, 'worktrees'));
      }
      expect(openedPaths[0]).toContain(instanceCacheSuffix(testInstance));
      expect(openedPaths[1]).toContain(instanceCacheSuffix(otherInstance));
    });
  });

  describe('openPrWorktree recorded worktree revalidation', () => {
    let worktreeDir: string;
    let cacheDir: string;

    beforeEach(() => {
      worktreeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'recorded-worktree-'));
      cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'recorded-worktree-cache-'));
      vi.mocked(inspectPrWorktree).mockReset();
      vi.mocked(discardStalePrWorktree).mockReset();
      vi.mocked(discardStalePrWorktree).mockResolvedValue(undefined);
      vi.mocked(fetchPullRequestHead).mockReset();
      vi.mocked(createWorktreeFromBranch).mockReset();
      vi.mocked(deleteBranch).mockClear();
      // Confirmation dialogs are shared across tests in this file; start every
      // case with a clean call history so "no prompt" assertions are sound.
      vi.mocked(vscode.window.showWarningMessage).mockClear();
      vi.spyOn(config, 'getWorktreeOpenMode').mockReturnValue('newWindow');
    });

    afterEach(() => {
      removeTempDirSync(worktreeDir);
      removeTempDirSync(cacheDir);
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
      expect(vi.mocked(inspectPrWorktree)).not.toHaveBeenCalled();
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
      vi.mocked(inspectPrWorktree).mockResolvedValue({
        state: 'stale',
        info: { branch: 'pr-1-oldsha0', dirty: false, commitsAhead: 0 },
      });
      vi.mocked(getRefCommitSha).mockResolvedValue('newsha1234567890');

      fake.send({ command: 'openPrWorktree', instanceId: testInstance.id, owner: 'owner', repo: 'repo', index: 1 });
      await flushUntil(() => postedMessages(fake.posted).some((m) => m.command === 'worktreeOpened'));

      // The recorded directory went through the same stale inspection as a
      // leftover directory, then had its throwaway branch cleaned up.
      expect(vi.mocked(inspectPrWorktree)).toHaveBeenCalledWith(worktreeDir, 'newsha1234567890');
      expect(vi.mocked(discardStalePrWorktree)).toHaveBeenCalledWith('/src/repo', worktreeDir, 'pr-1-oldsha0');
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

    it('deletes the throwaway branch when the checkout creation fails', async () => {
      // The fetch refspec created `pr-1-abcdef1` and the sha check passed; the
      // failed `worktree add` must not leak that branch in the repository.
      clientMocks.getPullRequestDetail.mockResolvedValue({
        title: 'Demo PR',
        head: { ref: 'feature', sha: 'abcdef1234567890' },
        base: { ref: 'main' },
      });
      vi.mocked(isCurrentWorkspaceBaseRepo).mockResolvedValue('/src/repo' as never);
      vi.mocked(inspectPrWorktree).mockResolvedValue({ state: 'missing' });
      vi.mocked(fetchPullRequestHead).mockResolvedValue(undefined);
      vi.mocked(getRefCommitSha).mockResolvedValue('abcdef1234567890');
      vi.mocked(createWorktreeFromBranch).mockRejectedValue(new Error('worktree add failed'));

      fake.send({ command: 'openPrWorktree', instanceId: testInstance.id, owner: 'owner', repo: 'repo', index: 1 });
      await flushUntil(() => postedMessages(fake.posted).some((m) => m.command === 'worktreeError'));

      expect(vi.mocked(deleteBranch)).toHaveBeenCalledWith('/src/repo', 'pr-1-abcdef1');
      // Nothing was recorded: the open failed before a worktree existed.
      expect(context.globalState.get('forgejoToolkit.worktrees')).toBeUndefined();
    });

    it('keeps a branch whose name is not the throwaway pattern when the checkout creation fails', async () => {
      // The delete is gated on the `pr-<n>-<sha7>` pattern so a branch the flow
      // did not create as a throwaway is never touched. A non-hex head sha
      // (unexpected API data) produces a name outside the pattern.
      clientMocks.getPullRequestDetail.mockResolvedValue({
        title: 'Demo PR',
        head: { ref: 'feature', sha: 'zz1234567890ab' },
        base: { ref: 'main' },
      });
      vi.mocked(isCurrentWorkspaceBaseRepo).mockResolvedValue('/src/repo' as never);
      vi.mocked(inspectPrWorktree).mockResolvedValue({ state: 'missing' });
      vi.mocked(fetchPullRequestHead).mockResolvedValue(undefined);
      vi.mocked(getRefCommitSha).mockResolvedValue('zz1234567890ab');
      vi.mocked(createWorktreeFromBranch).mockRejectedValue(new Error('worktree add failed'));

      fake.send({ command: 'openPrWorktree', instanceId: testInstance.id, owner: 'owner', repo: 'repo', index: 1 });
      await flushUntil(() => postedMessages(fake.posted).some((m) => m.command === 'worktreeError'));

      expect(vi.mocked(deleteBranch)).not.toHaveBeenCalled();
    });

    it('creates no branch and records nothing when the user declines replacing the workspace', async () => {
      // Current-window mode: opening the worktree would replace the open
      // folder, so the flow asks *before* it creates anything. The old order
      // created the checkout and its throwaway branch first and only then
      // prompted; declining left both behind with no record, and once the
      // directory was gone the stale registration blocked every retry.
      vi.mocked(isCurrentWorkspaceBaseRepo).mockResolvedValue('/src/repo' as never);
      vi.mocked(inspectPrWorktree).mockResolvedValue({ state: 'missing' });
      clientMocks.getPullRequestDetail.mockResolvedValue({
        title: 'Demo PR',
        head: { ref: 'feature', sha: 'abcdef1234567890' },
        base: { ref: 'main' },
      });
      vi.spyOn(config, 'getWorktreeOpenMode').mockReturnValue('currentWindow');
      vi.mocked(vscode.window.showWarningMessage).mockResolvedValueOnce(undefined as never);
      const restoreFolder = withWorkspaceFolder(path.join(os.tmpdir(), 'some-other-workspace'));
      try {
        fake.send({ command: 'openPrWorktree', instanceId: testInstance.id, owner: 'owner', repo: 'repo', index: 1 });
        await flushUntil(() => postedMessages(fake.posted).some((m) => m.command === 'worktreeCancelled'));

        expect(vscode.window.showWarningMessage).toHaveBeenCalled();
        expect(String(vi.mocked(vscode.window.showWarningMessage).mock.calls.at(-1)?.[0])).toContain(
          'replace the current workspace',
        );
        expect(vi.mocked(fetchPullRequestHead)).not.toHaveBeenCalled();
        expect(vi.mocked(createWorktreeFromBranch)).not.toHaveBeenCalled();
        expect(vi.mocked(openWorktree)).not.toHaveBeenCalled();
        expect(vi.mocked(deleteBranch)).not.toHaveBeenCalled();
        expect(context.globalState.get('forgejoToolkit.worktrees')).toBeUndefined();
      } finally {
        restoreFolder();
      }
    });

    it('keeps a stale worktree holding local work when the user declines the discard', async () => {
      await seedRecordedPrWorktree('old-sha-0000001');
      clientMocks.getPullRequestDetail.mockResolvedValue({
        title: 'Demo PR',
        head: { ref: 'feature', sha: 'newsha1234567890' },
        base: { ref: 'main' },
      });
      vi.mocked(inspectPrWorktree).mockResolvedValue({
        state: 'stale',
        info: { branch: 'pr-1-oldsha0', dirty: true, commitsAhead: 2 },
      });
      vi.mocked(vscode.window.showWarningMessage).mockResolvedValueOnce(undefined as never);

      fake.send({ command: 'openPrWorktree', instanceId: testInstance.id, owner: 'owner', repo: 'repo', index: 1 });
      await flushUntil(() => postedMessages(fake.posted).some((m) => m.command === 'worktreeCancelled'));

      // The prompt must name the work that a forced removal would drop, and
      // declining it must leave both the directory and the branch alone.
      expect(vscode.window.showWarningMessage).toHaveBeenCalled();
      const message = vi.mocked(vscode.window.showWarningMessage).mock.calls.at(-1)?.[0] as string;
      expect(message).toContain('uncommitted changes');
      expect(message).toContain('local commit(s)');
      expect(message).toContain('2');
      expect(vi.mocked(discardStalePrWorktree)).not.toHaveBeenCalled();
      expect(vi.mocked(createWorktreeFromBranch)).not.toHaveBeenCalled();
      expect(vi.mocked(openWorktree)).not.toHaveBeenCalled();
    });

    it('discards a stale worktree without prompting when no local work would be lost', async () => {
      await seedRecordedPrWorktree('old-sha-0000001');
      clientMocks.getPullRequestDetail.mockResolvedValue({
        title: 'Demo PR',
        head: { ref: 'feature', sha: 'newsha1234567890' },
        base: { ref: 'main' },
      });
      vi.mocked(inspectPrWorktree).mockResolvedValue({
        state: 'stale',
        info: { branch: 'pr-1-oldsha0', dirty: false, commitsAhead: 0 },
      });
      vi.mocked(createWorktreeFromBranch).mockResolvedValue(undefined);
      vi.mocked(fetchPullRequestHead).mockResolvedValue(undefined);

      fake.send({ command: 'openPrWorktree', instanceId: testInstance.id, owner: 'owner', repo: 'repo', index: 1 });
      await flushUntil(() => vi.mocked(discardStalePrWorktree).mock.calls.length > 0);

      expect(vi.mocked(discardStalePrWorktree)).toHaveBeenCalledWith('/src/repo', worktreeDir, 'pr-1-oldsha0');
      expect(vscode.window.showWarningMessage).not.toHaveBeenCalled();
    });

    it('keeps an existing current checkout when the open fails instead of discarding it', async () => {
      // The directory is already checked out at the PR head but the extension
      // holds no record for it (a leftover from an earlier run whose record was
      // dropped when its directory was briefly gone). `inspectPrWorktree` returns
      // before it looks at the local work inside and the confirmation asked
      // before this is about *opening*, never about deleting — yet a failed open
      // used to run the create path's rollback here (`git worktree remove
      // --force` + `git branch -D`), silently destroying tracked modifications,
      // untracked and ignored files that this flow never inspected.
      clientMocks.getPullRequestDetail.mockResolvedValue({
        title: 'Demo PR',
        head: { ref: 'feature', sha: 'abc1234567890' },
        base: { ref: 'main' },
      });
      vi.mocked(isCurrentWorkspaceBaseRepo).mockResolvedValue('/src/repo' as never);
      vi.mocked(getRefCommitSha).mockResolvedValue('abc1234567890');
      // The worktree directory this open computes, created on disk so the
      // inspection reports the existing checkout ('current'). No record is
      // seeded, which is what routes the flow past the recorded-reopen shortcut
      // into the branch under test.
      vi.spyOn(config, 'getWorktreeCacheDirectory').mockReturnValue(cacheDir);
      const worktreePath = path.join(
        cacheDir,
        'worktrees',
        `owner-repo-${instanceCacheSuffix(testInstance)}-pr-1-Demo PR`,
      );
      fs.mkdirSync(worktreePath, { recursive: true });
      vi.mocked(inspectPrWorktree).mockResolvedValue({ state: 'current' });
      vi.mocked(openWorktree).mockResolvedValue(false);
      vi.spyOn(config, 'getWorktreeOpenMode').mockReturnValue('newWindow');

      fake.send({ command: 'openPrWorktree', instanceId: testInstance.id, owner: 'owner', repo: 'repo', index: 1 });
      await flushUntil(() => postedMessages(fake.posted).some((m) => m.command === 'worktreeError'));

      // (a) nothing was removed and no branch was deleted.
      expect(vi.mocked(inspectPrWorktree)).toHaveBeenCalledWith(worktreePath, 'abc1234567890');
      expect(vi.mocked(discardStalePrWorktree)).not.toHaveBeenCalled();
      expect(vi.mocked(removeWorktreeAndPrune)).not.toHaveBeenCalled();
      expect(vi.mocked(deleteBranch)).not.toHaveBeenCalled();
      // The failure names the folder and says the checkout was left alone.
      const error = postedMessages(fake.posted).find((m) => m.command === 'worktreeError');
      expect(String(error?.error)).toContain('could not be opened');
      expect(String(error?.error)).toContain(worktreePath);
      expect(String(error?.error)).toContain('left untouched');
      // (b) the checkout is still recorded, so Settings can still remove it.
      const records = context.globalState.get('forgejoToolkit.worktrees') as Array<Record<string, unknown>>;
      expect(records).toHaveLength(1);
      expect(records[0]).toMatchObject({
        id: `${testInstance.id}:owner/repo#pr-1`,
        worktreePath,
        headSha: 'abc1234567890',
      });
      // ... and Settings can still act on it: the remove command finds the
      // record and reaches a removal for its directory — either it completes, or
      // the environment refuses the delete and the record stays for a retry.
      // A record nothing can act on would post neither.
      fake.send({ command: 'removeWorktree', id: `${testInstance.id}:owner/repo#pr-1` });
      await flushUntil(() =>
        postedMessages(fake.posted).some(
          (m) => m.command === 'worktreeRemoved' || (m.command === 'worktreeError' && m.operation === 'remove'),
        ),
      );
      const removeAnswered = postedMessages(fake.posted).some(
        (m) => m.command === 'worktreeRemoved' || (m.command === 'worktreeError' && m.operation === 'remove'),
      );
      expect(removeAnswered).toBe(true);
      if (postedMessages(fake.posted).some((m) => m.command === 'worktreeRemoved')) {
        expect(context.globalState.get('forgejoToolkit.worktrees')).toEqual([]);
      } else {
        expect(context.globalState.get('forgejoToolkit.worktrees')).toHaveLength(1);
      }
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
      vi.mocked(inspectPrWorktree).mockResolvedValue({ state: 'missing' });
      vi.mocked(getRefCommitSha).mockResolvedValue('abc1234567890');

      fake.send({ command: 'openPrWorktree', instanceId: testInstance.id, owner: 'owner', repo: 'repo', index: 5 });
      await flushUntil(() => postedMessages(fake.posted).some((m) => m.command === 'worktreeOpened'));

      // The issue record is invisible to the PR reopen flow: its directory was
      // never opened or revalidated and the record stays untouched.
      expect(vi.mocked(openWorktree)).not.toHaveBeenCalledWith(worktreeDir, true);
      expect(vi.mocked(inspectPrWorktree)).not.toHaveBeenCalledWith(worktreeDir, expect.anything());
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

  /**
   * A fake editor-area webview panel, for the settings tab.
   *
   * `dispose` is only recorded: the tab's own `onDidDispose` handler calls
   * `panel.dispose()`, so a fake that fired its listener from there would recurse.
   * A test that means "the user closed the tab" calls `fireDispose()`.
   */
  function createFakeWebviewPanel() {
    const posted: unknown[] = [];
    let listener: MessageListener | undefined;
    let disposeListener: (() => void) | undefined;
    let stateListener: (() => void) | undefined;
    const panel = {
      visible: true,
      title: '' as string | undefined,
      reveal: vi.fn(),
      dispose: vi.fn(),
      onDidDispose: (l: () => void) => {
        disposeListener = l;
        return { dispose: vi.fn() };
      },
      onDidChangeViewState: (l: () => void) => {
        stateListener = l;
        return { dispose: vi.fn() };
      },
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
    };
    return {
      panel,
      posted,
      send: (message: unknown) => listener?.(message),
      /** What VS Code does when the tab is switched to or away from. */
      changeViewState: () => stateListener?.(),
      /** The user closed the tab. */
      fireDispose: () => disposeListener?.(),
    };
  }

  /**
   * The settings tab (`docs/design/settings-page.md` §9.3).
   *
   * What the page used to be — a route inside the sidebar — is what these pin
   * against: the command opens an **editor-area tab**, opening it again reveals
   * the one already open instead of stacking a second, the sidebar is not
   * touched, a shown-again tab is told to re-read, and a closed tab is gone for
   * good (the next open is a new page).
   */
  describe('the settings tab', () => {
    let tabs: Array<ReturnType<typeof createFakeWebviewPanel>> = [];

    function openTab(instance: ForgejoToolkitViewProvider = provider) {
      const tab = createFakeWebviewPanel();
      tabs.push(tab);
      vi.mocked(vscode.window.createWebviewPanel).mockReturnValue(tab.panel as unknown as vscode.WebviewPanel);
      instance.openSettings();
      return tab;
    }

    afterEach(() => {
      for (const tab of tabs) {
        tab.fireDispose();
      }
      tabs = [];
      vi.mocked(vscode.window.createWebviewPanel).mockReset();
    });

    it('opens an editor-area tab with the host’s own title, and leaves the sidebar alone', () => {
      const tab = openTab();
      const createPanel = vi.mocked(vscode.window.createWebviewPanel);

      expect(createPanel).toHaveBeenCalledTimes(1);
      expect(createPanel.mock.calls[0][0]).toBe('forgejoToolkitSettings');
      // Host-side l10n: the mock returns the message it was given.
      expect(createPanel.mock.calls[0][1]).toBe('Settings');
      // The sidebar is not revealed, focused or messaged: the page is not in it
      // any more, and a settings command must not replace what the user reads.
      expect(fake.view.show).not.toHaveBeenCalled();
      expect(vscode.commands.executeCommand).not.toHaveBeenCalledWith('forgejoToolkitView.focus');
      expect(postedMessages(fake.posted).some((m) => m.command === 'openSettings')).toBe(false);
      expect(tab.posted).toEqual([]);
    });

    it('reveals the open tab instead of stacking a second, and tells it to re-read', () => {
      const first = openTab();
      first.posted.length = 0;

      // The second invocation's fake is deliberately never handed back: the host
      // must not ask for a panel at all, it reveals the one it already has.
      openTab();

      expect(vi.mocked(vscode.window.createWebviewPanel)).toHaveBeenCalledTimes(1);
      expect(first.panel.reveal).toHaveBeenCalledTimes(1);
      // "Shown again" means a fresh reading (`refreshSettings`), not the snapshot
      // the page was holding.
      expect(postedMessages(first.posted).map((m) => m.command)).toContain('refreshSettings');
    });

    it('tells a tab that becomes visible again to re-read, and only then', () => {
      const tab = openTab();
      tab.posted.length = 0;

      tab.panel.visible = false;
      tab.changeViewState();
      expect(tab.posted).toEqual([]);

      tab.panel.visible = true;
      tab.changeViewState();
      expect(postedMessages(tab.posted).map((m) => m.command)).toEqual(['refreshSettings']);
    });

    it('forgets a closed tab, so the next open is a new page', () => {
      const first = openTab();
      first.fireDispose();
      expect(first.panel.dispose).toHaveBeenCalledTimes(1);

      const second = openTab();

      expect(second).not.toBe(first);
      expect(vi.mocked(vscode.window.createWebviewPanel)).toHaveBeenCalledTimes(2);
      // Nothing is carried over: the new document is built again from scratch.
      expect(second.panel.webview.html).toBe(first.panel.webview.html);
    });

    it('answers the tab’s request in the tab, not in the sidebar', async () => {
      const tab = openTab();
      tab.posted.length = 0;
      fake.posted.length = 0;

      tab.send({ command: 'getSettingsSurface', _requestId: 'req-from-tab' });
      await flushDispatches();

      const reply = postedMessages(tab.posted).find((m) => m.command === 'settingsSurface');
      expect(reply, 'the tab is answered').toBeDefined();
      expect(reply?._requestId).toBe('req-from-tab');
      // The sidebar is a different webview with its own page: a reply for the tab
      // that landed there would be a reply the requester never gets.
      expect(postedMessages(fake.posted).some((m) => m.command === 'settingsSurface')).toBe(false);
    });

    it('keeps answering the sidebar’s own requests in the sidebar', async () => {
      const tab = openTab();
      tab.posted.length = 0;
      fake.posted.length = 0;

      fake.send({ command: 'getSettingsSurface', _requestId: 'req-from-sidebar' });
      await flushDispatches();

      expect(postedMessages(fake.posted).some((m) => m.command === 'settingsSurface')).toBe(true);
      expect(tab.posted).toEqual([]);
    });

    it('does not let the tab drain the sidebar’s queued messages', async () => {
      // The queue holds messages for a sidebar whose webview has never been
      // resolved. The tab asks the same `getInitialState` question on every
      // mount, and draining the queue there would post them into a `_view` that
      // does not exist — losing them for good.
      const freshProvider = new ForgejoToolkitViewProvider(
        context as never,
        context.extensionUri as never,
        config,
        new ReadmeContentProvider(),
      );
      freshProvider.openDashboard();
      const tab = openTab(freshProvider);
      tab.send({ command: 'getInitialState' });
      await flushDispatches();

      const sidebar = createFakeView();
      freshProvider.resolveWebviewView(sidebar.view as never, {} as never, {} as never);
      sidebar.send({ command: 'getInitialState' });
      await flushDispatches();

      expect(postedMessages(sidebar.posted).some((m) => m.command === 'openDashboard')).toBe(true);
    });
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
      // This handler chain crosses more awaited boundaries than a fixed pair
      // of ticks covers on a loaded Actions runner (the CI run got no reply
      // within two ticks and the assertion then saw nothing); wait for the
      // actual result message instead.
      await flushUntil(() => postedMessages(fake.posted).some((m) => m.command === 'startWorkResult'));

      const reply = postedMessages(fake.posted).find((m) => m.command === 'startWorkResult');
      expect(reply).toMatchObject({ instanceId: testInstance.id, owner: 'owner', repo: 'repo', index: 5 });
      expect(reply?.error).toBeUndefined();
      expect(reply?.cancelled).toBeUndefined();
      expect(vi.mocked(fetchBranch)).toHaveBeenCalledWith('/src/repo', 'origin', 'main', 'secret-token');
      // The directory name carries the instance discriminator: `worktrees/` is
      // shared by every instance, so the same owner/repo on two instances must
      // not resolve to one directory.
      const expectedDirName = `owner-repo-${instanceCacheSuffix(testInstance)}-issue-5-fix-bug`;
      expect(vi.mocked(createWorktreeWithNewBranch)).toHaveBeenCalledWith(
        '/src/repo',
        expect.stringContaining(expectedDirName),
        'issue-5-fix-bug',
        'FETCH_HEAD',
      );
      expect(vi.mocked(openWorktree)).toHaveBeenCalledWith(
        expect.stringContaining(expectedDirName),
        true,
        expect.any(Function),
        { confirmed: true },
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
      // Same fs.promises.access chain as the startWorkOnIssue success path:
      // a fixed two-tick flush can finish before the reply is posted.
      await flushUntil(() => postedMessages(fake.posted).some((m) => m.command === 'startWorkResult'));

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
      // Same fs.promises.access chain as the startWorkOnIssue success path:
      // a fixed two-tick flush can finish before the reply is posted.
      await flushUntil(() => postedMessages(fake.posted).some((m) => m.command === 'startWorkResult'));

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
      // Same fs.promises.access chain as the startWorkOnIssue success path:
      // a fixed two-tick flush can finish before the reply is posted.
      await flushUntil(() => postedMessages(fake.posted).some((m) => m.command === 'startWorkResult'));

      const reply = postedMessages(fake.posted).find((m) => m.command === 'startWorkResult');
      expect(typeof reply?.error).toBe('string');
      expect(vi.mocked(fetchBranch)).not.toHaveBeenCalled();
      expect(vi.mocked(createWorktreeWithNewBranch)).not.toHaveBeenCalled();
    });

    it('creates no branch, no directory and no record when the user declines replacing the workspace', async () => {
      // Current-window mode: opening the worktree would replace the open
      // folder, so the flow has to ask *before* it creates anything. The old
      // order created the checkout and its issue branch first and only then
      // prompted; declining left both behind with no record, and once the
      // directory was gone (a cache-directory change, disk cleanup) the stale
      // git worktree registration blocked every later attempt with "already
      // checked out at <old path>", recoverable only by `git worktree prune`.
      const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'issue-worktree-decline-'));
      const restoreFolder = withWorkspaceFolder(path.join(os.tmpdir(), 'issue-worktree-other-workspace'));
      try {
        vi.mocked(isCurrentWorkspaceBaseRepo).mockResolvedValue('/src/repo');
        vi.spyOn(config, 'getWorktreeOpenMode').mockReturnValue('currentWindow');
        vi.spyOn(config, 'getWorktreeCacheDirectory').mockReturnValue(cacheDir);
        clientMocks.getRepoDetail.mockResolvedValue({ repository: { default_branch: 'main' } });
        vi.mocked(vscode.window.showWarningMessage).mockResolvedValueOnce(undefined as never);

        fake.send({
          command: 'startWorkOnIssue',
          instanceId: testInstance.id,
          owner: 'owner',
          repo: 'repo',
          index: 5,
          title: 'fix-bug',
        });
        await flushUntil(() => postedMessages(fake.posted).some((m) => m.command === 'startWorkResult'));

        expect(vscode.window.showWarningMessage).toHaveBeenCalled();
        expect(String(vi.mocked(vscode.window.showWarningMessage).mock.calls.at(-1)?.[0])).toContain(
          'replace the current workspace',
        );
        const reply = postedMessages(fake.posted).find((m) => m.command === 'startWorkResult');
        expect(reply).toMatchObject({ cancelled: true });
        expect(reply?.error).toBeUndefined();
        // Nothing was created: no fetch, no checkout, no issue branch.
        expect(vi.mocked(fetchBranch)).not.toHaveBeenCalled();
        expect(vi.mocked(createWorktreeWithNewBranch)).not.toHaveBeenCalled();
        expect(vi.mocked(openWorktree)).not.toHaveBeenCalled();
        expect(context.globalState.get('forgejoToolkit.worktrees')).toBeUndefined();
      } finally {
        restoreFolder();
        removeTempDirSync(cacheDir);
      }
    });

    it('rolls the fresh checkout back and records nothing when the open fails', async () => {
      // The user accepted the replacement and the folder still did not open.
      // Leaving the checkout would recreate the recordless state the confirm-
      // first order exists to avoid, so a checkout this call created is
      // reclaimed; a reopened leftover would be left alone instead.
      const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'issue-worktree-open-fail-'));
      try {
        vi.mocked(isCurrentWorkspaceBaseRepo).mockResolvedValue('/src/repo');
        vi.spyOn(config, 'getWorktreeOpenMode').mockReturnValue('newWindow');
        vi.spyOn(config, 'getWorktreeCacheDirectory').mockReturnValue(cacheDir);
        clientMocks.getRepoDetail.mockResolvedValue({ repository: { default_branch: 'main' } });
        vi.mocked(openWorktree).mockResolvedValue(false);

        fake.send({
          command: 'startWorkOnIssue',
          instanceId: testInstance.id,
          owner: 'owner',
          repo: 'repo',
          index: 5,
          title: 'fix-bug',
        });
        await flushUntil(() => postedMessages(fake.posted).some((m) => m.command === 'startWorkResult'));

        const reply = postedMessages(fake.posted).find((m) => m.command === 'startWorkResult');
        expect(reply).toMatchObject({ cancelled: true });
        expect(reply?.error).toBeUndefined();
        const createdPath = String(vi.mocked(createWorktreeWithNewBranch).mock.calls.at(-1)?.[1]);
        expect(createdPath).toContain('issue-5-fix-bug');
        expect(vi.mocked(removeWorktreeAndPrune)).toHaveBeenCalledWith('/src/repo', createdPath);
        // The user's issue branch is not work that predates the call, but a
        // failed open is still no reason to delete it.
        expect(vi.mocked(deleteBranch)).not.toHaveBeenCalled();
        expect(context.globalState.get('forgejoToolkit.worktrees')).toBeUndefined();
      } finally {
        removeTempDirSync(cacheDir);
      }
    });

    describe('leftover directory reopen', () => {
      let cacheDir: string;
      let worktreePath: string;

      beforeEach(() => {
        cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'issue-worktree-leftover-'));
        worktreePath = path.join(
          cacheDir,
          'worktrees',
          `owner-repo-${instanceCacheSuffix(testInstance)}-issue-5-fix-bug`,
        );
        fs.mkdirSync(worktreePath, { recursive: true });
        // A `.git` entry marks the leftover as a valid worktree (reopened
        // as-is instead of being removed and recreated).
        fs.writeFileSync(path.join(worktreePath, '.git'), 'gitdir: /src/repo/.git/worktrees/issue-5');
        vi.mocked(isCurrentWorkspaceBaseRepo).mockResolvedValue('/src/repo');
        vi.spyOn(config, 'getWorktreeOpenMode').mockReturnValue('newWindow');
        vi.spyOn(config, 'getWorktreeCacheDirectory').mockReturnValue(cacheDir);
      });

      afterEach(() => {
        vi.restoreAllMocks();
        removeTempDirSync(cacheDir);
      });

      function sendStartWork() {
        fake.send({
          command: 'startWorkOnIssue',
          instanceId: testInstance.id,
          owner: 'owner',
          repo: 'repo',
          index: 5,
          title: 'fix-bug',
        });
        return flushUntil(() => postedMessages(fake.posted).some((m) => m.command === 'startWorkResult'));
      }

      function recordedBaseBranch(): unknown {
        const records = context.globalState.get('forgejoToolkit.worktrees') as Array<Record<string, unknown>>;
        return records.find((r) => r.id === `${testInstance.id}:owner/repo#issue-5`)?.baseBranch;
      }

      it('reuses the recorded base branch without an API call when a record exists', async () => {
        await context.globalState.update('forgejoToolkit.worktrees', [
          {
            id: `${testInstance.id}:owner/repo#issue-5`,
            kind: 'issue',
            instanceId: testInstance.id,
            owner: 'owner',
            repo: 'repo',
            prIndex: 5,
            prTitle: 'Issue #5',
            headBranch: 'issue-5-fix-bug',
            headSha: '',
            baseBranch: 'develop',
            sourceRepoPath: '/src/repo',
            worktreePath,
            createdAt: 0,
          },
        ]);

        await sendStartWork();

        const reply = postedMessages(fake.posted).find((m) => m.command === 'startWorkResult');
        expect(reply?.error).toBeUndefined();
        // Offline reopen: the base branch comes from the record, not the API.
        expect(clientMocks.getRepoDetail).not.toHaveBeenCalled();
        expect(vi.mocked(fetchBranch)).not.toHaveBeenCalled();
        expect(vi.mocked(createWorktreeWithNewBranch)).not.toHaveBeenCalled();
        expect(vi.mocked(openWorktree)).toHaveBeenCalledWith(worktreePath, true, expect.any(Function), {
          confirmed: true,
        });
        expect(recordedBaseBranch()).toBe('develop');
      });

      it('resolves the default branch over the API for an unrecorded leftover directory', async () => {
        clientMocks.getRepoDetail.mockResolvedValue({ repository: { default_branch: 'develop' } });

        await sendStartWork();

        const reply = postedMessages(fake.posted).find((m) => m.command === 'startWorkResult');
        expect(reply?.error).toBeUndefined();
        expect(clientMocks.getRepoDetail).toHaveBeenCalledWith('owner', 'repo');
        expect(vi.mocked(fetchBranch)).not.toHaveBeenCalled();
        expect(vi.mocked(createWorktreeWithNewBranch)).not.toHaveBeenCalled();
        expect(recordedBaseBranch()).toBe('develop');
      });

      it('still opens with a main fallback when the default-branch lookup fails', async () => {
        clientMocks.getRepoDetail.mockRejectedValue(new Error('network down'));

        await sendStartWork();

        const reply = postedMessages(fake.posted).find((m) => m.command === 'startWorkResult');
        // The base branch is display-only: a failed lookup must not block the open.
        expect(reply?.error).toBeUndefined();
        expect(vi.mocked(openWorktree)).toHaveBeenCalledWith(worktreePath, true, expect.any(Function), {
          confirmed: true,
        });
        expect(recordedBaseBranch()).toBe('main');
      });

      it('reopens a real leftover worktree without asking to delete anything', async () => {
        // The `.git` marker proves the extension created this directory, so
        // there is nothing to confirm and no prompt may appear — only a
        // markerless directory is ever a deletion candidate.
        clientMocks.getRepoDetail.mockResolvedValue({ repository: { default_branch: 'main' } });
        vi.mocked(vscode.window.showWarningMessage).mockClear();

        await sendStartWork();

        expect(vi.mocked(vscode.window.showWarningMessage)).not.toHaveBeenCalled();
        const reply = postedMessages(fake.posted).find((m) => m.command === 'startWorkResult');
        expect(reply?.error).toBeUndefined();
        expect(vi.mocked(openWorktree)).toHaveBeenCalledWith(worktreePath, true, expect.any(Function), {
          confirmed: true,
        });
        // Reopened as is: neither removed nor recreated.
        expect(fs.existsSync(path.join(worktreePath, '.git'))).toBe(true);
        expect(vi.mocked(createWorktreeWithNewBranch)).not.toHaveBeenCalled();
      });
    });

    describe('markerless leftover directory', () => {
      // The directory the flow computes exists and carries no `.git` entry, so
      // the extension cannot prove it created it: `worktreeCacheDirectory` is
      // user-configurable and may point at a folder that already holds
      // unrelated content (KNOWN_ISSUES). It must never be recursively deleted
      // on sight — the lazy sweep refuses a directory without the
      // `git worktree add` marker and the PR paths ask first — so this path
      // asks too, and refuses the start when the user declines.
      let cacheDir: string;
      let worktreePath: string;

      beforeEach(() => {
        cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'issue-worktree-markerless-'));
        worktreePath = path.join(
          cacheDir,
          'worktrees',
          `owner-repo-${instanceCacheSuffix(testInstance)}-issue-5-fix-bug`,
        );
        fs.mkdirSync(worktreePath, { recursive: true });
        fs.writeFileSync(path.join(worktreePath, 'notes.txt'), 'unrelated work');
        vi.mocked(isCurrentWorkspaceBaseRepo).mockResolvedValue('/src/repo');
        vi.spyOn(config, 'getWorktreeOpenMode').mockReturnValue('newWindow');
        vi.spyOn(config, 'getWorktreeCacheDirectory').mockReturnValue(cacheDir);
        // Call history only; the shared mock's implementation (a modal resolves
        // with its first action label, i.e. Confirm) is what the confirm case
        // below relies on, so it is not reset.
        vi.mocked(vscode.window.showWarningMessage).mockClear();
      });

      afterEach(() => {
        vi.restoreAllMocks();
        removeTempDirSync(cacheDir);
      });

      function sendStartWork() {
        fake.send({
          command: 'startWorkOnIssue',
          instanceId: testInstance.id,
          owner: 'owner',
          repo: 'repo',
          index: 5,
          title: 'fix-bug',
        });
        return flushUntil(() => postedMessages(fake.posted).some((m) => m.command === 'startWorkResult'));
      }

      it('asks before deleting it and preserves it when the user declines', async () => {
        vi.mocked(vscode.window.showWarningMessage).mockResolvedValueOnce(undefined as never);

        await sendStartWork();

        // The prompt names the directory, so the user can see what is at stake.
        const prompt = vi.mocked(vscode.window.showWarningMessage).mock.calls.at(-1)?.[0];
        expect(String(prompt)).toContain(worktreePath);
        const reply = postedMessages(fake.posted).find((m) => m.command === 'startWorkResult');
        expect(typeof reply?.error).toBe('string');
        expect(String(reply?.error)).toContain(worktreePath);
        // Untouched, and nothing was created or recorded.
        expect(fs.readFileSync(path.join(worktreePath, 'notes.txt'), 'utf8')).toBe('unrelated work');
        expect(vi.mocked(fetchBranch)).not.toHaveBeenCalled();
        expect(vi.mocked(createWorktreeWithNewBranch)).not.toHaveBeenCalled();
        expect(vi.mocked(openWorktree)).not.toHaveBeenCalled();
        expect(context.globalState.get('forgejoToolkit.worktrees')).toBeUndefined();
      });

      it('deletes and recreates it only after the user confirms', async () => {
        clientMocks.getRepoDetail.mockResolvedValue({ repository: { default_branch: 'main' } });
        // The Confirm label the host compares against (the l10n mock returns the
        // key itself).
        vi.mocked(vscode.window.showWarningMessage).mockResolvedValueOnce('Confirm' as never);

        await sendStartWork();

        const prompt = vi.mocked(vscode.window.showWarningMessage).mock.calls.at(-1)?.[0];
        expect(String(prompt)).toContain(worktreePath);
        const reply = postedMessages(fake.posted).find((m) => m.command === 'startWorkResult');
        expect(reply?.error).toBeUndefined();
        // The confirmed delete goes through the worktree-aware helper rather
        // than a bare `fs.rm`, so a registration pointing at that directory is
        // cleared too and cannot wedge the next attempt (the helper's own
        // delete is what removes the directory; see the registration test).
        expect(vi.mocked(removeWorktreeAndPrune)).toHaveBeenCalledWith('/src/repo', worktreePath);
        expect(vi.mocked(createWorktreeWithNewBranch)).toHaveBeenCalledWith(
          '/src/repo',
          worktreePath,
          'issue-5-fix-bug',
          'FETCH_HEAD',
        );
      });

      it('clears the registration behind the confirmed delete instead of leaving it behind', async () => {
        // A bare `fs.rm` removed the directory but left `.git/worktrees/<name>`
        // in the source repository. The stale registration then made every later
        // `git worktree add` for that branch fail with "already used by worktree
        // at <deleted path>". The worktree-aware removal runs `git worktree
        // remove --force` and prunes, so the next attempt starts clean.
        clientMocks.getRepoDetail.mockResolvedValue({ repository: { default_branch: 'main' } });
        vi.mocked(vscode.window.showWarningMessage).mockResolvedValueOnce('Confirm' as never);
        vi.mocked(removeWorktreeAndPrune).mockImplementationOnce(async () => {
          // What the real helper guarantees for a directory git no longer sees:
          // the registration is pruned and the directory removed.
          removeTempDirSync(worktreePath);
        });

        await sendStartWork();

        expect(vi.mocked(removeWorktreeAndPrune)).toHaveBeenCalledWith('/src/repo', worktreePath);
        expect(fs.existsSync(worktreePath)).toBe(false);
        expect(vi.mocked(createWorktreeWithNewBranch)).toHaveBeenCalledWith(
          '/src/repo',
          worktreePath,
          'issue-5-fix-bug',
          'FETCH_HEAD',
        );
      });

      it('still attempts the checkout when the confirmed delete fails', async () => {
        // The user answered "delete and create it again": a removal that fails
        // (a file held open on Windows, a directory the process cannot touch)
        // must be reported in the log, not turn the accepted flow into a silent
        // no-op. The retry in createWorktreeWithNewBranch reclaims a
        // registration whose directory is really gone.
        clientMocks.getRepoDetail.mockResolvedValue({ repository: { default_branch: 'main' } });
        vi.mocked(vscode.window.showWarningMessage).mockResolvedValueOnce('Confirm' as never);
        vi.mocked(removeWorktreeAndPrune).mockRejectedValueOnce(new Error('fatal: could not remove worktree'));

        await sendStartWork();

        const reply = postedMessages(fake.posted).find((m) => m.command === 'startWorkResult');
        expect(reply?.error).toBeUndefined();
        expect(vi.mocked(createWorktreeWithNewBranch)).toHaveBeenCalledWith(
          '/src/repo',
          worktreePath,
          'issue-5-fix-bug',
          'FETCH_HEAD',
        );
      });
    });
  });

  describe('notification poll coverage', () => {
    it('sends the ids the poll examined, not only the rows it returned', async () => {
      // The view may only mark a row read when the host says the poll examined
      // it. Deriving coverage from `notifications` cannot express a row the poll
      // looked at and found read (e.g. "mark all as read" from the host toast),
      // so the coverage the poller reports has to reach the view verbatim.
      provider.pushNotifications(testInstance.id, [], [1, 2]);

      const push = postedMessages(fake.posted).find((m) => m.command === 'polledNotifications');
      expect(push).toMatchObject({ instanceId: testInstance.id, notifications: [], coveredIds: [1, 2] });
    });

    it('reveals and queues openNotifications when the sidebar was never opened', async () => {
      // The poller toasts a new notification whether or not the sidebar has ever
      // been resolved, and `_reply` drops the message while `this._view` is
      // undefined — so the toast's "Open" button did nothing at all.
      const fresh = new ForgejoToolkitViewProvider(
        context as never,
        context.extensionUri as never,
        config,
        new ReadmeContentProvider(),
      );
      const freshView = createFakeView();
      vi.mocked(vscode.commands.executeCommand).mockClear();

      fresh.openNotifications();

      expect(vscode.commands.executeCommand).toHaveBeenCalledWith('forgejoToolkitView.focus');

      // The queued message is delivered once the view mounts and asks for state.
      fresh.resolveWebviewView(freshView.view as never, {} as never, {} as never);
      freshView.send({ command: 'getInitialState' });
      await flushDispatches();

      expect(postedMessages(freshView.posted).some((m) => m.command === 'openNotifications')).toBe(true);
    });
  });

  it('reuses the JSON file list fetched as the compare fallback instead of re-fetching it', async () => {
    // The compare call falls back to the JSON list, which is also the source of
    // the addition/deletion counts: fetching the same paged list a second time
    // is one wasted request per PR open.
    clientMocks.getPullRequestFilesFromCompare.mockRejectedValue(new Error('compare unsupported'));
    clientMocks.getPullRequestFiles.mockResolvedValue([
      { filename: 'src/index.ts', status: 'modified', additions: 1, deletions: 2, changes: 3 },
    ]);

    fake.send({
      command: 'getPullRequestFiles',
      instanceId: testInstance.id,
      owner: 'owner',
      repo: 'repo',
      index: 5,
      baseSha: 'a'.repeat(40),
      headSha: 'b'.repeat(40),
    });
    await flushUntil(() => postedMessages(fake.posted).some((m) => m.command === 'pullRequestFiles'));

    expect(clientMocks.getPullRequestFiles).toHaveBeenCalledTimes(1);
    const reply = postedMessages(fake.posted).find((m) => m.command === 'pullRequestFiles');
    expect(reply?.error).toBeUndefined();
    expect((reply?.files as Array<{ additions?: number }> | undefined)?.[0]?.additions).toBe(1);
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

    it('never logs a credential a relative avatar URL inherits from the instance URL', async () => {
      // These lines reach the extension's output channel. A relative avatar_url
      // resolves against the instance URL, so when that URL carries the token as
      // userinfo the resolved absolute URL does too — and the failure path is
      // where the URL is echoed. The token must be redacted there.
      const debugSpy = vi.spyOn(logger, 'debug').mockImplementation(() => undefined);
      const errorSpy = vi.spyOn(logger, 'error').mockImplementation(() => undefined);
      vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('socket hang up')));
      const credentialed = { ...testInstance, url: 'https://secret-token@forgejo.example.com' };

      await (
        provider as unknown as {
          _resolveAvatarUrl: (url: string, instance: ForgejoInstance) => Promise<string>;
        }
      )._resolveAvatarUrl('/avatars/user.png', credentialed);

      const lines = [...debugSpy.mock.calls, ...errorSpy.mock.calls].map((call) => String(call[0]));
      expect(lines.length).toBeGreaterThan(0);
      for (const line of lines) {
        expect(line).not.toContain('secret-token');
      }
      expect(lines.some((line) => line.includes('forgejo.example.com'))).toBe(true);
    });

    it('fetches same-origin avatars through the configured proxy fetch', async () => {
      // An instance reachable only through the proxy would otherwise stall each
      // avatar until its 30 s timeout and then fall back to the raw URL.
      const proxyFetch = stubAvatarFetch();
      proxyMocks.getProxyFetch.mockReturnValue(proxyFetch);
      const globalFetch = vi.fn();
      vi.stubGlobal('fetch', globalFetch);

      const resolved = await resolveAvatar(`${testInstance.url}/avatars/user.png`);

      expect(proxyFetch).toHaveBeenCalledTimes(1);
      expect(globalFetch).not.toHaveBeenCalled();
      expect(resolved).toBe('data:image/png;base64,AQID');
    });

    it('falls back to global fetch when no proxy is configured', async () => {
      const globalFetch = stubAvatarFetch();
      vi.stubGlobal('fetch', globalFetch);

      const resolved = await resolveAvatar(`${testInstance.url}/avatars/user.png`);

      expect(proxyMocks.getProxyFetch).toHaveBeenCalled();
      expect(globalFetch).toHaveBeenCalledTimes(1);
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

    it('counts a cache hit once and keeps serving the resolved data URL', async () => {
      const fetchMock = stubAvatarFetch();
      vi.stubGlobal('fetch', fetchMock);
      const url = `${testInstance.url}/avatars/hit.png`;

      expect(await resolveAvatar(url)).toBe('data:image/png;base64,AQID');
      const bytesAfterFirstFetch = resolvedAvatarCacheBytesForTest();
      expect(bytesAfterFirstFetch).toBeGreaterThan(0);

      // A hit returns the stored promise without fetching or re-counting bytes.
      expect(await resolveAvatar(url)).toBe('data:image/png;base64,AQID');
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(resolvedAvatarCacheBytesForTest()).toBe(bytesAfterFirstFetch);
    });

    it('evicts the least recently used avatar once the byte budget is exceeded', async () => {
      // Each avatar sits just under the fetch cap; four of them exceed the
      // cache's byte budget: the entry cap alone (100) would let them all stay
      // and hold megabytes of base64 text.
      const imageBytes = AVATAR_FETCH_MAX_BYTES - 1024;
      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        statusText: 'OK',
        arrayBuffer: async () => new Uint8Array(imageBytes).buffer,
        headers: { get: () => 'image/png' },
      });
      vi.stubGlobal('fetch', fetchMock);
      const urlAt = (n: number) => `${testInstance.url}/avatars/big-${n}.png`;

      for (let i = 0; i < 4; i++) {
        await resolveAvatar(urlAt(i));
      }

      // The budget holds after the insertions, and the evicted first URL is
      // fetched again while the latest is still a hit.
      expect(resolvedAvatarCacheBytesForTest()).toBeLessThanOrEqual(AVATAR_CACHE_MAX_BYTES);
      await resolveAvatar(urlAt(3));
      expect(fetchMock).toHaveBeenCalledTimes(4);
      await resolveAvatar(urlAt(0));
      expect(fetchMock).toHaveBeenCalledTimes(5);
    });

    it('refuses an avatar whose Content-Length exceeds the fetch cap without reading the body', async () => {
      const arrayBuffer = vi.fn(async () => new Uint8Array([1, 2, 3]).buffer);
      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        statusText: 'OK',
        arrayBuffer,
        headers: {
          get: (name: string) =>
            name.toLowerCase() === 'content-length' ? String(AVATAR_FETCH_MAX_BYTES + 1) : 'image/png',
        },
      });
      vi.stubGlobal('fetch', fetchMock);
      const url = `${testInstance.url}/avatars/declared-too-big.png`;

      // The declared size alone settles it: no body bytes are buffered.
      expect(await resolveAvatar(url)).toBe(url);
      expect(arrayBuffer).not.toHaveBeenCalled();
    });

    it('stops reading a streamed avatar body once it grows past the fetch cap', async () => {
      // No Content-Length: the counted stream read is the only thing standing
      // between the host and an unbounded payload.
      const cancel = vi.fn(async () => undefined);
      const chunks = [new Uint8Array(AVATAR_FETCH_MAX_BYTES), new Uint8Array(1)];
      let index = 0;
      const read = vi.fn(async () =>
        index < chunks.length ? { done: false, value: chunks[index++] } : { done: true, value: undefined },
      );
      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        statusText: 'OK',
        headers: { get: () => null },
        body: { getReader: () => ({ read, cancel }) },
      });
      vi.stubGlobal('fetch', fetchMock);
      const url = `${testInstance.url}/avatars/streamed-too-big.png`;

      expect(await resolveAvatar(url)).toBe(url);
      // The second chunk already crossed the cap; the rest is never read.
      expect(read).toHaveBeenCalledTimes(2);
      expect(cancel).toHaveBeenCalled();
    });

    it('resolves a streamed avatar body under the fetch cap', async () => {
      const chunks = [new Uint8Array([1, 2]), new Uint8Array([3])];
      let index = 0;
      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        statusText: 'OK',
        headers: { get: (name: string) => (name.toLowerCase() === 'content-type' ? 'image/png' : null) },
        body: {
          getReader: () => ({
            read: vi.fn(async () =>
              index < chunks.length ? { done: false, value: chunks[index++] } : { done: true, value: undefined },
            ),
            cancel: vi.fn(async () => undefined),
          }),
        },
      });
      vi.stubGlobal('fetch', fetchMock);

      // The two chunks are concatenated before the base64 encoding.
      expect(await resolveAvatar(`${testInstance.url}/avatars/streamed.png`)).toBe('data:image/png;base64,AQID');
    });
  });

  describe('locale changes outside the sidebar reach every open panel', () => {
    function createFakeWebviewPanel() {
      const posted: unknown[] = [];
      const panel = {
        title: '',
        reveal: vi.fn(),
        dispose: vi.fn(),
        onDidDispose: () => ({ dispose: vi.fn() }),
        webview: {
          html: '',
          cspSource: '',
          asWebviewUri: (uri: unknown) => uri,
          postMessage: (message: unknown) => {
            posted.push(message);
            return Promise.resolve(true);
          },
          onDidReceiveMessage: () => ({ dispose: vi.fn() }),
        },
      };
      return { panel, posted };
    }

    afterEach(() => {
      OnboardingWebviewPanel.currentPanel = undefined;
      PullReviewCommentPanel.currentPanel = undefined;
    });

    it('pushes the new language into an open onboarding panel and review editor', async () => {
      let locale = 'en';
      vi.mocked(vscode.workspace.getConfiguration).mockImplementation(
        () => ({ get: (key: string) => (key === 'locale' ? locale : undefined), update: vi.fn() }) as never,
      );
      const onboarding = createFakeWebviewPanel();
      const review = createFakeWebviewPanel();
      vi.mocked(vscode.window.createWebviewPanel)
        .mockReturnValueOnce(onboarding.panel as never)
        .mockReturnValueOnce(review.panel as never);

      OnboardingWebviewPanel.createOrShow(
        context as never,
        context.extensionUri as never,
        config,
        new ReadmeContentProvider(),
      );
      PullReviewCommentPanel.createOrShow(vscode.Uri.file('/ext') as never, config, {
        instanceId: testInstance.id,
        owner: 'owner',
        repo: 'repo',
        index: 1,
        path: 'src/index.ts',
        position: 1,
        isBase: false,
        lineNumber: 0,
        mode: 'review',
      });

      // The Settings editor changes the configuration without posting anything
      // to a webview; only the host can tell the panels already open about it.
      locale = 'zh';
      const listener = vi.mocked(vscode.workspace.onDidChangeConfiguration).mock.calls.at(-1)?.[0] as
        | ((event: { affectsConfiguration(key: string): boolean }) => void)
        | undefined;
      expect(listener).toBeTypeOf('function');
      listener?.({ affectsConfiguration: (key: string) => key === 'forgejoToolkit.locale' });
      await flushDispatches();

      expect(postedMessages(onboarding.posted)).toContainEqual(
        expect.objectContaining({ command: 'setLocale', locale: 'zh' }),
      );
      expect(postedMessages(review.posted)).toContainEqual(
        expect.objectContaining({ command: 'setLocale', locale: 'zh' }),
      );
    });
  });

  describe('instance URLs that carry credentials', () => {
    /** Prime the "clone to cache" flow for an instance URL injected via config. */
    function primeCredentialCloneFlow(cacheDir: string) {
      vi.mocked(isCurrentWorkspaceBaseRepo).mockResolvedValue(undefined as never);
      vi.mocked(inspectPrWorktree).mockResolvedValue({ state: 'missing' } as never);
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

    it('builds the cache clone URL without the instance userinfo', async () => {
      // The URL goes into `git clone --bare`'s argv and into the clone's
      // `remote.origin.url` (plaintext on disk), and git quotes it back in its
      // own failure message. The stored instance cannot hold such a URL any more
      // (addInstance refuses it), so the credential-bearing form is injected
      // directly: the stripping on this path must not depend on that refusal.
      const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'worktree-cred-clone-'));
      try {
        const url = 'https://alice:secret-token@forgejo.example.com';
        vi.spyOn(config, 'getInstances').mockReturnValue([{ ...testInstance, url }]);
        primeCredentialCloneFlow(cacheDir);
        vi.mocked(cloneRepository).mockImplementation(async (_cloneUrl: string, target: string) => {
          await fs.promises.mkdir(target, { recursive: true });
        });

        fake.send({ command: 'openPrWorktree', instanceId: testInstance.id, owner: 'owner', repo: 'repo', index: 1 });
        // The mocked clone creates the cache repository through a real
        // `fs.promises.mkdir`, and the flow after it (the touch, the lazy sweep,
        // the worktree creation) is asynchronous too. Waiting only for the mock
        // to be *called* left all of that in flight while `finally` removed the
        // directory, which is the EPERM this case failed with when both suites
        // ran side by side; the terminal reply means nothing below is still
        // touching the tree.
        await flushUntil(() => postedMessages(fake.posted).some((m) => m.command === 'worktreeOpened'));

        const cloneUrl = String(vi.mocked(cloneRepository).mock.calls[0][0]);
        expect(cloneUrl).toBe('https://forgejo.example.com/owner/repo.git');
        expect(cloneUrl).not.toContain('secret-token');
        // A masked `alice:***@host` would be persisted as the remote and could
        // never authenticate, so the whole userinfo has to be gone.
        expect(cloneUrl).not.toContain('***');
        expect(cloneUrl).not.toContain('@');
      } finally {
        removeTempDirSync(cacheDir);
      }
    });

    it('never echoes the credential through the clone failure path', async () => {
      // git's own error text is what a failed `git clone --bare` reports, and it
      // quotes the URL it was given. That text is rethrown into the webview
      // error, the toast, and the log, so nothing on this path may put a
      // credential back into the URL it quotes.
      const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'worktree-cred-fail-'));
      try {
        const url = 'https://alice:secret-token@forgejo.example.com';
        vi.spyOn(config, 'getInstances').mockReturnValue([{ ...testInstance, url }]);
        primeCredentialCloneFlow(cacheDir);
        vi.mocked(cloneRepository).mockImplementation(async (cloneUrl: string) => {
          // What git itself does with a credential-bearing URL.
          throw new Error(`unable to access '${cloneUrl}': The requested URL returned error: 403`);
        });

        fake.send({ command: 'openPrWorktree', instanceId: testInstance.id, owner: 'owner', repo: 'repo', index: 1 });
        await flushUntil(() => postedMessages(fake.posted).some((m) => m.command === 'worktreeError'));

        expect(vi.mocked(cloneRepository)).toHaveBeenCalled();
        const cloneUrl = String(vi.mocked(cloneRepository).mock.calls[0][0]);
        const errors = postedMessages(fake.posted)
          .filter((m) => m.command === 'worktreeError')
          .map((m) => String(m.error));
        expect(cloneUrl).not.toContain('secret-token');
        expect(errors.length).toBeGreaterThan(0);
        for (const error of errors) {
          expect(error).not.toContain('secret-token');
          expect(error).not.toContain('***');
        }
      } finally {
        removeTempDirSync(cacheDir);
      }
    });

    it('refuses to store an instance URL that embeds a credential', async () => {
      // The storage boundary is where the URL becomes an instance every request
      // is built from: a userinfo-bearing entry can never be fetched, and the
      // message the user would otherwise get blames the instance's availability.
      fake.send({
        command: 'saveInstance',
        url: 'https://alice:secret-token@forgejo.example.com',
        token: 'secret-token',
      });
      await flushDispatches();

      const reply = postedMessages(fake.posted).find((m) => m.command === 'saveInstanceResult');
      expect(reply?.success).toBe(false);
      expect(String(reply?.error)).toContain('http');
      expect(config.getInstances().map((i) => i.url)).toEqual([testInstance.url]);
    });

    it('refuses to test the connection of a URL that embeds a credential', async () => {
      // Answered before the request: a refused URL must not reach the network,
      // and the user must be told about the URL instead of being told the
      // instance could not be reached.
      fake.send({
        command: 'testConnection',
        url: 'https://alice:secret-token@forgejo.example.com',
        token: 'secret-token',
      });
      await flushDispatches();

      const reply = postedMessages(fake.posted).find((m) => m.command === 'testConnectionResult');
      expect(reply?.success).toBe(false);
    });

    it('refuses the redacted URL the Settings form posts back on an edit', async () => {
      // `toPublicInstance` sends `https://***@host/` to the webview, the form
      // prefills it, and editing anything else posts that mask straight back.
      // Same-origin and http(s), so nothing else here would stop it: the stored
      // credential would be replaced by a URL nothing can authenticate against.
      const updateSpy = vi.spyOn(config, 'updateInstance');
      const instance = { ...testInstance, url: 'https://alice:secret-token@forgejo.example.com' };
      vi.spyOn(config, 'getInstances').mockReturnValue([instance]);

      fake.send({ command: 'editInstance', id: instance.id, url: 'https://***@forgejo.example.com/', token: '' });
      await flushDispatches();

      const reply = postedMessages(fake.posted).find((m) => m.command === 'saveInstanceResult');
      expect(reply?.success).toBe(false);
      expect(updateSpy).not.toHaveBeenCalled();
    });

    it('keeps a same-origin edit of a credential-free instance working', async () => {
      // The guard above must not catch an ordinary edit.
      clientMocks.getCurrentUser.mockResolvedValue({ login: 'user' });

      fake.send({ command: 'editInstance', id: testInstance.id, url: 'https://forgejo.example.com', token: '' });
      await flushDispatches();

      const reply = postedMessages(fake.posted).find((m) => m.command === 'saveInstanceResult');
      expect(reply).toBeDefined();
      expect(reply?.success).toBe(true);
    });

    it('does not mistake a path containing `***` for a redacted userinfo', async () => {
      // Only the userinfo position is a mask; a literal `***` in a path is just
      // part of an instance installed under a sub-path.
      clientMocks.getCurrentUser.mockResolvedValue({ login: 'user' });
      const updateSpy = vi.spyOn(config, 'updateInstance').mockResolvedValue(undefined);

      fake.send({
        command: 'editInstance',
        id: testInstance.id,
        url: 'https://forgejo.example.com/***/git',
        token: '',
      });
      await flushDispatches();

      const reply = postedMessages(fake.posted).find((m) => m.command === 'saveInstanceResult');
      expect(reply?.success).toBe(true);
      expect(updateSpy).toHaveBeenCalled();
    });
  });

  describe('navigating the sidebar', () => {
    it('posts openDashboard after revealing the view', () => {
      // openDashboard() is the two-step the onboarding guide's finish button
      // borrows: revealing the container alone only brings back whatever route
      // the sidebar was last on, which is never the dashboard after a first run.
      fake.posted.length = 0;

      provider.openDashboard();

      expect(postedMessages(fake.posted).some((m) => m.command === 'openDashboard')).toBe(true);
    });
  });

  describe('workflow dispatch inputs', () => {
    const request = {
      command: 'getWorkflowDispatchInputs',
      instanceId: testInstance.id,
      owner: 'owner',
      repo: 'repo',
      workflow: 'release.yml',
      ref: 'main',
    };

    function reply() {
      return postedMessages(fake.posted).find((message) => message.command === 'workflowDispatchInputs');
    }

    it('answers with the inputs the workflow file declares, and where they were read', async () => {
      clientMocks.getFileContentResult.mockResolvedValue({
        kind: 'file',
        text: [
          'on:',
          '  workflow_dispatch:',
          '    inputs:',
          '      tag:',
          '        description: Release tag',
          '        type: string',
          "        default: ''",
          '        required: true',
          '      dry_run:',
          '        type: boolean',
          '        default: true',
        ].join('\n'),
      });

      fake.send(request);
      await flushUntil(() => reply() !== undefined);

      expect(reply()).toMatchObject({
        instanceId: testInstance.id,
        owner: 'owner',
        repo: 'repo',
        // The workflow and the ref are echoed: they are the identity the
        // webview's loading slot is keyed on.
        workflow: 'release.yml',
        ref: 'main',
        path: '.forgejo/workflows/release.yml',
        inputs: [
          {
            name: 'tag',
            type: 'string',
            declaredType: 'string',
            description: 'Release tag',
            default: '',
            required: true,
          },
          { name: 'dry_run', type: 'boolean', declaredType: 'boolean', default: 'true', required: false },
        ],
      });
      expect(reply()?.error).toBeUndefined();
      expect(clientMocks.getFileContentResult).toHaveBeenCalledWith(
        'owner',
        'repo',
        '.forgejo/workflows/release.yml',
        'main',
      );
    });

    it('answers "no-inputs" for a workflow that declares none', async () => {
      clientMocks.getFileContentResult.mockResolvedValue({
        kind: 'file',
        text: 'on:\n  workflow_dispatch:\n',
      });

      fake.send(request);
      await flushUntil(() => reply() !== undefined);

      expect(reply()).toMatchObject({
        workflow: 'release.yml',
        ref: 'main',
        path: '.forgejo/workflows/release.yml',
        reason: 'no-inputs',
      });
      expect(reply()?.inputs).toBeUndefined();
      expect(reply()?.error).toBeUndefined();
    });

    it('answers "unreadable" with the sentence to show when no candidate holds the file', async () => {
      clientMocks.getFileContentResult.mockRejectedValue(new Error('Forgejo API error 404: Not Found'));

      fake.send(request);
      await flushUntil(() => reply() !== undefined);

      expect(reply()).toMatchObject({ workflow: 'release.yml', ref: 'main', reason: 'unreadable' });
      expect(reply()?.error).toBe(
        'No workflow file named "release.yml" was found in .forgejo/workflows, .gitea/workflows, .github/workflows.',
      );
    });

    it('answers a deleted instance rather than leaving the form waiting', async () => {
      fake.send({ ...request, instanceId: 'deleted-instance' });
      await flushDispatches();

      expect(reply()).toMatchObject({
        instanceId: 'deleted-instance',
        owner: 'owner',
        repo: 'repo',
        workflow: 'release.yml',
        ref: 'main',
      });
      expect(typeof reply()?.error).toBe('string');
    });
  });

  describe('worktreeCloneUrl', () => {
    it('strips the userinfo and the trailing slashes of the instance URL', () => {
      expect(worktreeCloneUrl({ url: 'https://alice:secret-token@forgejo.example.com/' }, 'owner', 'repo')).toBe(
        'https://forgejo.example.com/owner/repo.git',
      );
      expect(worktreeCloneUrl({ url: 'https://secret-token@forgejo.example.com' }, 'owner', 'repo')).toBe(
        'https://forgejo.example.com/owner/repo.git',
      );
      expect(worktreeCloneUrl({ url: 'https://forgejo.example.com//' }, 'owner', 'repo')).toBe(
        'https://forgejo.example.com/owner/repo.git',
      );
    });

    it('keeps a sub-path instance URL so the clone lands on the right server path', () => {
      expect(worktreeCloneUrl({ url: 'https://alice:pw@forgejo.example.com/git/' }, 'owner', 'repo')).toBe(
        'https://forgejo.example.com/git/owner/repo.git',
      );
    });
  });

  /**
   * The Settings page's AI pre-review model chooser: the offered models, the
   * value the setting holds, and the value a pick stores.
   *
   * The shared `vscode` mock has no `lm` field at all (AGENTS.md's note on the
   * mock, and the design record's §9.5), so "this editor has no language model
   * API" is the default environment here and a case that needs models installs
   * the field for its own duration.
   */
  describe('AI pre-review chat model settings', () => {
    /** One model as `vscode.lm.selectChatModels()` hands it over. */
    function fakeChatModel(overrides: Record<string, unknown> = {}) {
      return {
        name: 'Fake Model',
        vendor: 'fake',
        family: 'fake',
        id: 'fake-model',
        maxInputTokens: 128_000,
        countTokens: vi.fn(async () => 10),
        sendRequest: vi.fn(),
        ...overrides,
      };
    }

    /**
     * Installs the runtime `vscode.lm` surface for one test and returns the
     * restore. The shared `vscode` mock defines no `lm` at all — and vitest's
     * mock proxy throws on reading a key it never defined — so the field is
     * assigned rather than read, the same way `mcpServerProvider.test.ts`
     * installs its own API surface.
     *
     * Called with no argument it sets the field to `undefined`, which is how a
     * case drives the editor that has no language model API at all.
     */
    function withChatModels(select?: ReturnType<typeof vi.fn>): () => void {
      const vscodeModule = vscode as unknown as { lm?: unknown };
      vscodeModule.lm = select ? { selectChatModels: select } : undefined;
      return () => {
        vscodeModule.lm = undefined;
      };
    }

    /** The configuration read/write pair, with `aiPreReviewModel` seeded. */
    function configuration(configured?: string) {
      const get = vi.fn((key: string) => (key === 'aiPreReviewModel' ? configured : undefined));
      const update = vi.fn(async () => undefined);
      vi.mocked(vscode.workspace.getConfiguration).mockReturnValue({ get, update } as never);
      return { get, update };
    }

    function replyTo(command: string) {
      return postedMessages(fake.posted).find((message) => message.command === command);
    }

    async function requestModels() {
      fake.send({ command: 'getAiPreReviewChatModels', _requestId: 'req-models' });
      await flushUntil(() => replyTo('aiPreReviewChatModels') !== undefined);
      return replyTo('aiPreReviewChatModels');
    }

    it('answers with every offered model, its identity, its budget and the configured value', async () => {
      // Two models sharing one family and differing only by id: the value the
      // setting stores has to keep them apart (`vendor/id`), because a family
      // value would match whichever of the two the editor listed first.
      const first = fakeChatModel({ name: 'First', id: 'first', family: 'shared', maxInputTokens: 64_000 });
      const second = fakeChatModel({ name: 'Second', id: 'second', family: 'shared', maxInputTokens: 200_000 });
      const restore = withChatModels(vi.fn(async () => [first, second]));
      configuration('fake/second');
      try {
        const reply = await requestModels();

        expect(reply).toMatchObject({ configured: 'fake/second', _requestId: 'req-models' });
        expect(reply?.reason).toBeUndefined();
        expect(reply?.models).toEqual([
          {
            name: 'First',
            vendor: 'fake',
            family: 'shared',
            id: 'first',
            maxInputTokens: 64_000,
            value: 'fake/first',
          },
          {
            name: 'Second',
            vendor: 'fake',
            family: 'shared',
            id: 'second',
            maxInputTokens: 200_000,
            value: 'fake/second',
          },
        ]);
      } finally {
        restore();
      }
    });

    it('sends nothing to any provider and reads no pull request to answer', async () => {
      const only = fakeChatModel();
      const restore = withChatModels(vi.fn(async () => [only]));
      configuration();
      try {
        await requestModels();

        // Choosing a model is configuration, not use: with the AI pre-review
        // switch off (the mock's `get` returns undefined for it) the list is
        // still answered, and not one model was asked anything.
        expect(only.sendRequest).not.toHaveBeenCalled();
        expect(only.countTokens).not.toHaveBeenCalled();
        expect(vscode.window.showQuickPick).not.toHaveBeenCalled();
        expect(vi.mocked(ForgejoClient)).not.toHaveBeenCalled();
      } finally {
        restore();
      }
    });

    it('keeps a model that no accepted form can name out of the storable values', async () => {
      // A provider that omits `vendor` leaves nothing the setting can hold, so
      // the option carries no value and a chooser cannot store a value that
      // would match nothing on the next run.
      const nameless = fakeChatModel({ vendor: '', family: 'orphan', id: 'orphan' });
      const restore = withChatModels(vi.fn(async () => [nameless]));
      configuration('');
      try {
        const reply = await requestModels();

        const models = reply?.models as Array<Record<string, unknown>>;
        expect(models).toHaveLength(1);
        expect(models[0].vendor).toBe('');
        expect('value' in models[0]).toBe(false);
      } finally {
        restore();
      }
    });

    it('lists one row per model when the editor offers the same one twice', async () => {
      const model = fakeChatModel();
      const restore = withChatModels(vi.fn(async () => [model, { ...model }]));
      configuration();
      try {
        const reply = await requestModels();

        expect(reply?.models).toHaveLength(1);
      } finally {
        restore();
      }
    });

    it('explains a missing language model API instead of offering an empty list', async () => {
      configuration();
      const restore = withChatModels();
      try {
        const reply = await requestModels();

        expect(reply?.models).toEqual([]);
        expect(String(reply?.reason)).toContain('no language model API');
      } finally {
        restore();
      }
    });

    it('explains a failed listing instead of offering an empty list', async () => {
      const restore = withChatModels(
        vi.fn(async () => {
          throw new Error('provider registry exploded');
        }),
      );
      configuration();
      try {
        const reply = await requestModels();

        expect(reply?.models).toEqual([]);
        expect(String(reply?.reason)).toContain('could not be listed');
        expect(String(reply?.reason)).toContain('provider registry exploded');
      } finally {
        restore();
      }
    });

    it('explains that the editor offers no chat model at all', async () => {
      const restore = withChatModels(vi.fn(async () => []));
      configuration('');
      try {
        const reply = await requestModels();

        expect(reply?.models).toEqual([]);
        expect(String(reply?.reason)).toContain('install and sign in to a chat model provider');
        // A reason, never an empty dropdown with no explanation: the two are
        // indistinguishable in the UI otherwise.
        expect(reply?.configured).toBe('');
      } finally {
        restore();
      }
    });

    it('stores the picked model in the setting at global scope', async () => {
      const { update } = configuration();
      fake.send({ command: 'setAiPreReviewChatModel', value: 'deepseek/deepseek-flash', _requestId: 'req-write' });
      await flushUntil(() => replyTo('aiPreReviewChatModelSaved') !== undefined);

      // The same value the QuickPick writes, at the scope that makes it the
      // choice everywhere: the Settings UI, settings.json and later runs.
      expect(update).toHaveBeenCalledWith(
        'aiPreReviewModel',
        'deepseek/deepseek-flash',
        vscode.ConfigurationTarget.Global,
      );
      expect(replyTo('aiPreReviewChatModelSaved')).toMatchObject({
        value: 'deepseek/deepseek-flash',
        _requestId: 'req-write',
      });
      expect(replyTo('aiPreReviewChatModelSaved')?.error).toBeUndefined();
    });

    it('stores the empty value, which is the setting\'s own "ask each run" default', async () => {
      const { update } = configuration('fake/first');
      fake.send({ command: 'setAiPreReviewChatModel', value: '', _requestId: 'req-clear' });
      await flushUntil(() => replyTo('aiPreReviewChatModelSaved') !== undefined);

      expect(update).toHaveBeenCalledWith('aiPreReviewModel', '', vscode.ConfigurationTarget.Global);
      expect(replyTo('aiPreReviewChatModelSaved')).toMatchObject({ value: '', _requestId: 'req-clear' });
    });

    it('refuses a value that is not a model selector and writes nothing', async () => {
      const { update } = configuration();
      vi.mocked(vscode.l10n.t).mockClear();

      fake.send({ command: 'setAiPreReviewChatModel', value: 'just-a-name', _requestId: 'req-bad' });
      await flushUntil(() => replyTo('aiPreReviewChatModelSaved') !== undefined);

      // The webview is untrusted input and this writes a user setting: a value
      // that would make every run refuse is refused here instead.
      expect(update).not.toHaveBeenCalled();
      const reply = replyTo('aiPreReviewChatModelSaved');
      expect(reply?.error).toBe('The model choice was not stored: it is not a "vendor/family" or "vendor/id" form.');
      expect(vi.mocked(vscode.l10n.t)).toHaveBeenCalledWith(
        'The model choice was not stored: it is not a "vendor/family" or "vendor/id" form.',
      );
    });

    it('reports a failed write instead of claiming the choice was stored', async () => {
      const get = vi.fn(() => undefined);
      const update = vi.fn(async () => {
        throw new Error('read-only configuration');
      });
      vi.mocked(vscode.workspace.getConfiguration).mockReturnValue({ get, update } as never);

      fake.send({ command: 'setAiPreReviewChatModel', value: 'fake/only', _requestId: 'req-fail' });
      await flushUntil(() => replyTo('aiPreReviewChatModelSaved') !== undefined);

      expect(replyTo('aiPreReviewChatModelSaved')).toMatchObject({ value: 'fake/only', _requestId: 'req-fail' });
      expect(String(replyTo('aiPreReviewChatModelSaved')?.error)).toContain('read-only configuration');
    });
  });

  /**
   * The pull request detail page's own entry point for the AI pre-review.
   *
   * The feature used to be offered from a **file's** context menu while the run
   * fetches every changed file and the whole diff, so the entry and the scope did
   * not match; the maintainer's decision was to move the entry to the pull request
   * detail page. The webview therefore posts the coordinates of the pull request
   * whose button was pressed, and this suite is about the host's half of that
   * contract: validate what arrived, then run **the same** flow the
   * `editor/title` button reaches.
   */
  describe('the AI pre-review entry point on the pull request detail page', () => {
    /** The coordinates a pull request detail page posts. */
    const target = { instanceId: testInstance.id, owner: 'owner', repo: 'repo', index: 7 };

    /**
     * The run the extension registers through the provider, as a spy. It is the
     * only thing this dispatch can reach that could call a model or the server,
     * so "not called" is exactly "nothing was sent and nothing was created".
     */
    function installRunner() {
      const runner = vi.fn();
      provider.setAiPreReviewRunner(runner);
      return runner;
    }

    it('runs the flow the editor title button runs, with the coordinates the webview sent', async () => {
      const runner = installRunner();

      fake.send({ command: 'aiPreReviewPullRequest', ...target });
      await flushDispatches();

      // The provider hands over the validated coordinates and nothing else: the
      // model, the prompt scope, the prompt, the confirmation and the drafts all
      // belong to the run, so a modified webview can choose **which** pull request
      // is reviewed and cannot influence what that review sends or writes.
      expect(runner).toHaveBeenCalledTimes(1);
      expect(runner).toHaveBeenCalledWith(target);
      expect(vscode.window.showErrorMessage).not.toHaveBeenCalled();
    });

    it('refuses a malformed or missing coordinate without running anything', async () => {
      const runner = installRunner();

      // Each of these is a shape a modified (or buggy) webview could send. The
      // index rule is `parseForgejoPrUri`'s own — a positive integer, because
      // `Number(...)` alone would accept `'7'` and `true` and "PR 0" names no pull
      // request — and the name segments are the ones `isSafeRepoNameSegment`
      // refuses, because they are interpolated into API paths.
      const malformed: Record<string, unknown>[] = [
        { ...target, index: 0 },
        { ...target, index: 1.5 },
        { ...target, index: '7' },
        { ...target, index: true },
        { ...target, index: undefined },
        { ...target, owner: '' },
        { ...target, owner: '../admin' },
        { ...target, repo: '..' },
        { ...target, instanceId: '' },
        { ...target, instanceId: 7 },
        { owner: 'owner', repo: 'repo', index: 7 },
      ];
      for (const message of malformed) {
        fake.send({ command: 'aiPreReviewPullRequest', ...message });
      }
      await flushDispatches();

      expect(runner).not.toHaveBeenCalled();
      expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
        expect.stringContaining('did not name a valid pull request'),
      );
    });

    it('drops the message instead of throwing when no run has been registered', async () => {
      // A host whose activation only got as far as the view provider has nothing
      // to run; the message is not worth a dialog, but it must not become an
      // unhandled rejection either.
      fake.send({ command: 'aiPreReviewPullRequest', ...target });
      await flushDispatches();

      expect(vscode.window.showErrorMessage).not.toHaveBeenCalled();
    });

    it('advertises the feature switch, so the button is offered only while it is on', async () => {
      const get = vi.fn((key: string) => (key === 'aiPreReview' ? true : undefined));
      vi.mocked(vscode.workspace.getConfiguration).mockReturnValue({ get, update: vi.fn() } as never);

      fake.send({ command: 'getInitialState' });
      await flushDispatches();

      // The webview cannot read extension configuration: the boolean it renders
      // the button from is this one. The switch itself is re-read by the run, so a
      // stale boolean can only hide or show a button.
      const initialState = postedMessages(fake.posted).find((message) => message.command === 'initialState');
      expect(initialState?.aiPreReview).toBe(true);
    });

    it('reports the switch as off when the setting is off', async () => {
      vi.mocked(vscode.workspace.getConfiguration).mockReturnValue({
        get: vi.fn(() => undefined),
        update: vi.fn(),
      } as never);

      fake.send({ command: 'getInitialState' });
      await flushDispatches();

      const initialState = postedMessages(fake.posted).find((message) => message.command === 'initialState');
      expect(initialState?.aiPreReview).toBe(false);
    });

    it('pushes the switch into the webview when it changes outside the sidebar', async () => {
      // The switch can only be changed in VS Code's Settings UI, which this
      // webview never sees. Without the push the button would keep describing the
      // state the page was rendered with.
      let enabled = false;
      vi.mocked(vscode.workspace.getConfiguration).mockImplementation(
        () => ({ get: (key: string) => (key === 'aiPreReview' ? enabled : undefined), update: vi.fn() }) as never,
      );

      enabled = true;
      const listener = vi.mocked(vscode.workspace.onDidChangeConfiguration).mock.calls.at(-1)?.[0] as
        | ((event: { affectsConfiguration(key: string): boolean }) => void)
        | undefined;
      expect(listener).toBeTypeOf('function');
      listener?.({ affectsConfiguration: (key: string) => key === 'forgejoToolkit.aiPreReview' });
      await flushDispatches();

      expect(postedMessages(fake.posted)).toContainEqual(
        expect.objectContaining({ command: 'setAiPreReview', aiPreReview: true }),
      );
    });

    it('pushes the AI endpoint snapshot when one of the endpoint keys changes outside the panel', async () => {
      // A hand edit of any of these in VS Code's own settings editor is invisible
      // to an open settings page, which re-reads the AI surface only on mount (and
      // on a visibility change) — measured on a live walkthrough for the import
      // path, which had the same gap. Each key below is pushed on its own so one
      // forgotten key fails here rather than leaving a stale control on screen.
      const provider = {
        id: 'ollama-local',
        name: 'Ollama (this machine)',
        baseUrl: 'http://localhost:11434/v1',
        models: [{ id: 'qwen3:8b', name: 'Qwen3 8B' }],
        auth: 'bearer',
        headers: [],
      };
      vi.mocked(vscode.workspace.getConfiguration).mockImplementation(
        () =>
          ({
            get: (key: string) => {
              if (key === 'aiProviders') {
                return [provider];
              }
              if (key === 'aiModelBindings') {
                return [{ feature: 'aiPreReview', providerId: 'ollama-local', modelId: 'qwen3:8b' }];
              }
              return undefined;
            },
            update: vi.fn(),
          }) as never,
      );

      const listener = vi.mocked(vscode.workspace.onDidChangeConfiguration).mock.calls.at(-1)?.[0] as
        | ((event: { affectsConfiguration(key: string): boolean }) => void)
        | undefined;
      expect(listener).toBeTypeOf('function');

      const keys = [
        'forgejoToolkit.aiProviders',
        'forgejoToolkit.aiModelBindings',
        'forgejoToolkit.aiDefaultProvider',
        'forgejoToolkit.aiDefaultModel',
        'forgejoToolkit.aiTransport',
        'forgejoToolkit.aiModelRequestTimeoutMs',
      ];
      for (const key of keys) {
        fake.posted.length = 0;
        listener?.({ affectsConfiguration: (candidate: string) => candidate === key });
        await flushUntil(() => postedMessages(fake.posted).some((m) => m.command === 'aiProviderSettings'));

        const push = postedMessages(fake.posted).find((m) => m.command === 'aiProviderSettings');
        expect(push, `${key} should push the endpoint snapshot`).toBeDefined();
        // The snapshot is the host reading the configuration back, not a value
        // derived from the event: the seeded endpoint and binding arrive even
        // though the event only named the key.
        const snapshot = push?.snapshot as
          | {
              providers: Array<Record<string, unknown>>;
              bindings: Array<Record<string, unknown>>;
            }
          | undefined;
        expect(snapshot?.providers.map((entry) => entry.id)).toEqual(['ollama-local']);
        expect(snapshot?.bindings).toEqual([
          { feature: 'aiPreReview', providerId: 'ollama-local', modelId: 'qwen3:8b' },
        ]);
        // A push rather than an answer to a request: no `_requestId`, exactly like
        // the one the page's own writes and the import path send.
        expect(push?._requestId).toBeUndefined();
      }
    });
  });

  /**
   * The create-pull-request form's "generate a description" action, and the one
   * way this dispatch can be answered twice.
   *
   * The run is a whole consent-and-model flow that can take as long as a human
   * takes to answer a modal, and `_dispatchMessage` answers any `_requestId` the
   * handler left unanswered **the moment the handler returns**. Dispatching the
   * run without awaiting it therefore ended the handler with the id still
   * pending, the fallback posted `requestError`, and the run's own
   * `prDescriptionGenerated` — which arrives after it — found no pending entry in
   * the webview and was dropped. Measured five times on 2026-10-05 in the
   * isolated dev host: every press logged `requestError` immediately followed by
   * `prDescriptionGenerated` for the same id, and the user saw only the generic
   * sentence.
   */
  describe("the create-pull-request form's generate-description dispatch", () => {
    /** The coordinates the create form posts for one comparison. */
    const target = {
      instanceId: testInstance.id,
      owner: 'owner',
      repo: 'repo',
      base: 'main',
      head: 'feature',
      title: 'Retry failed requests',
    };

    function replyTo(command: string): Record<string, unknown> | undefined {
      return postedMessages(fake.posted).find((message) => message.command === command);
    }

    it("answers the request with the run's own reply, without a second reply for the same id", async () => {
      let settle: (() => void) | undefined;
      const runner = vi.fn(async () => {
        // Held open on purpose: this is the shape a real run has while the
        // consent modal is on screen, and it is the window the old code answered
        // through the dispatch fallback.
        await new Promise<void>((resolve) => {
          settle = resolve;
        });
        return { kind: 'ok' as const, description: '## What changed\n\nRetries.' };
      });
      provider.setPrDescriptionRunner(runner);

      fake.send({ command: 'generatePrDescription', ...target, _requestId: 'req-draft' });
      await flushUntil(() => runner.mock.calls.length > 0);

      // The run is still waiting. The dispatch fallback must not have answered
      // the id in the meantime: the webview deletes the pending entry on
      // `requestError` and then drops the real answer.
      expect(replyTo('requestError')).toBeUndefined();
      expect(replyTo('prDescriptionGenerated')).toBeUndefined();

      settle?.();
      await flushUntil(() => replyTo('prDescriptionGenerated') !== undefined);

      expect(replyTo('prDescriptionGenerated')).toMatchObject({
        description: '## What changed\n\nRetries.',
        _requestId: 'req-draft',
      });
      // One answer for the id, and it is the run's — not the run's after a
      // generic sentence the form cannot use.
      expect(postedMessages(fake.posted).filter((m) => m.command === 'requestError')).toEqual([]);
      // The validated coordinates and nothing else reach the run: the model, the
      // scope, the consent question and the prompt all stay host-side.
      expect(runner).toHaveBeenCalledWith(target);
    });

    it('still answers a cancelled run with the empty arm rather than an error', async () => {
      // The other half of the same contract: a dismissed consent modal is not a
      // failure, so the form gets '' (leave the body alone) and no sentence.
      const runner = vi.fn(async () => ({ kind: 'cancelled' }) as const);
      provider.setPrDescriptionRunner(runner);

      fake.send({ command: 'generatePrDescription', ...target, _requestId: 'req-draft-cancelled' });
      await flushUntil(() => replyTo('prDescriptionGenerated') !== undefined);

      expect(replyTo('prDescriptionGenerated')).toMatchObject({ description: '', _requestId: 'req-draft-cancelled' });
      expect(replyTo('prDescriptionGenerated')).not.toHaveProperty('error');
      expect(postedMessages(fake.posted).filter((m) => m.command === 'requestError')).toEqual([]);
    });
  });
});
