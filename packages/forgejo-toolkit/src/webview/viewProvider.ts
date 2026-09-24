import * as vscode from 'vscode';
import { instanceIdFor } from '../instanceIdentity';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { logger } from '../logger';
import { ForgejoClient, API_REQUEST_TIMEOUT_MS, invalidateRepoContentCaches } from '../api/client';
import type { ForgejoChangedFile } from '../api/types';
import { ConfigManager } from '../config';
import type { ExportSettings, ForgejoInstance } from '@cpf23333-forgejo-toolkit/shared/webview/messages';
import { toPublicInstance } from '@cpf23333-forgejo-toolkit/shared/webview/messages';
import { getWebviewContent, toInstanceOrigins } from './content';
import type { ReadmeContentProvider } from '../readmeProvider';
import { openReadmePreview } from '../readmeProvider';
import { buildRepoFileUri } from '../repoFileProvider';
import { WorktreeManager, WorktreeInfo, validateCacheDirectory } from '../worktree/worktreeManager';
import { InFlightTasks } from '../worktree/inFlightTasks';
import {
  clearLinkedRepositoryCache,
  cloneRepository,
  createWorktreeFromBranch,
  createWorktreeWithNewBranch,
  deleteBranch,
  detectLinkedRepositories,
  discardStalePrWorktree,
  fetchBranch,
  fetchPullRequestHead,
  findLocalRepo,
  getRefCommitSha,
  inspectPrWorktree,
  isCurrentWorkspaceBaseRepo,
  isGitRepository,
  isPathInsideFolder,
  isRevertInProgress,
  listRemotes,
  openWorktree,
  resolveRemoteForRepo,
  revertMergeCommit,
  sameRepositoryUrl,
  sanitizeForPath,
} from '../worktree/gitOperations';
import type { StalePrWorktreeInfo } from '../worktree/gitOperations';
import type { HostToWebviewMessage } from '@cpf23333-forgejo-toolkit/shared/webview/messages';
import {
  computeImportTokenConflicts,
  ImportCancelledError,
  readExportDataFromUri,
  stripInstanceTokens,
} from './instanceImport';
import { userFacingErrorMessage } from '../api/errors';
import { getProxyFetch } from '../api/proxy';
import { missingPayloadNotice } from '../prFileSystemProvider';
import { probeServerVersion } from '../api/versionProbe';
import { clearServerVersion } from '../api/serverVersion';
import { resolveAttachmentImages } from '../utils/resolveAttachmentImages';
import { writeFileAtomically } from '../utils/atomicWrite';
import { resolveLocale } from '../utils/resolveLocale';
import { isSafeRepoIdentity, isSafeRepoNameSegment, isSafeRepoPath } from './repoIdentity';
import { connectionFailureMessage, isHttpUrl } from './connectionTest';
import { OnboardingWebviewPanel } from './onboardingPanel';
import { PullReviewCommentPanel } from '../comments/pullReviewCommentPanel';

/**
 * Load-type webview requests whose handlers reply with a result message the
 * requesting view waits on (spinner → data/error). When the targeted instance
 * was deleted, the handler used to bail out silently on `_findInstance` and
 * the keep-alive view spun forever; the guard in `_handleMessage` answers
 * these requests with an error reply instead. Request/response messages
 * (carrying `_requestId`) are already covered by the `_dispatchMessage`
 * fallback, so they are not listed here.
 */
const LOAD_RESULT_COMMANDS: Record<string, string> = {
  getRepositories: 'repositories',
  getMyIssues: 'myIssues',
  getMyPullRequests: 'myPullRequests',
  globalSearch: 'globalSearchResult',
  getNotifications: 'notifications',
  getRepoDetail: 'repoDetail',
  getRepoBranchCommits: 'repoBranchCommits',
  getIssueDetail: 'issueDetail',
  checkIssueSubscription: 'issueSubscriptionChecked',
  getUserStopwatches: 'userStopwatches',
  getIssueTrackedTimes: 'issueTrackedTimes',
  getIssueDependencies: 'issueDependencies',
  getIssueReactions: 'issueReactions',
  getCommentReactions: 'commentReactions',
  getPullRequestDetail: 'pullRequestDetail',
  getPullRequestFiles: 'pullRequestFiles',
  getPullRequestCommentsAndTimeline: 'pullRequestCommentsAndTimeline',
  getPullRequestCommits: 'pullRequestCommits',
  getRepoIssues: 'repoIssues',
  getRepoLabels: 'repoLabels',
  getRepoAssignees: 'repoAssignees',
  getRepoMilestones: 'repoMilestones',
  getRepoPullRequests: 'repoPullRequests',
  getActionRuns: 'actionRuns',
  getActionRun: 'actionRun',
  getActionRunJobs: 'actionRunJobs',
  getActionRunArtifacts: 'actionRunArtifacts',
  getActionJobLog: 'actionJobLog',
  getRepoContents: 'repoContents',
  searchRepoFiles: 'repoFilesSearchResult',
  getFileHistory: 'fileHistory',
  getRepoRefs: 'repoRefs',
};

/**
 * Mutation-type webview requests whose handlers reply with a result message
 * the requesting control waits on (button spinner → success/error). They share
 * the deleted-instance pre-check with LOAD_RESULT_COMMANDS: without an error
 * reply the control's loading state would never clear. The pre-check replies
 * echo the request fields back (minus `command`), which is exactly how the
 * webview routes the result to its loading key.
 */
const MUTATION_RESULT_COMMANDS: Record<string, string> = {
  editIssue: 'issueUpdated',
  deleteIssue: 'issueDeleted',
  editPullRequest: 'pullRequestUpdated',
  mergePullRequest: 'pullRequestMerged',
  revertMergeCommit: 'revertMergeCommitResult',
  editIssueComment: 'issueCommentEdited',
  deleteIssueComment: 'issueCommentDeleted',
  changeIssueSubscription: 'issueSubscriptionChanged',
  changeIssueReaction: 'issueReactionChanged',
  changeCommentReaction: 'commentReactionChanged',
  startIssueStopwatch: 'issueStopwatchChanged',
  stopIssueStopwatch: 'issueStopwatchChanged',
  deleteIssueStopwatch: 'issueStopwatchChanged',
  addIssueTime: 'issueTimeAdded',
  resetIssueTime: 'issueTimeReset',
  deleteIssueTime: 'issueTimeDeleted',
  createIssueDependency: 'issueDependencyChanged',
  removeIssueDependency: 'issueDependencyChanged',
  dispatchWorkflow: 'actionRunDispatched',
  cancelActionRun: 'actionRunCancelled',
  deleteActionRun: 'actionRunDeleted',
  downloadActionArtifact: 'actionArtifactDownloaded',
  editRepoRelease: 'repoReleaseEdited',
  deleteRepoRelease: 'repoReleaseDeleted',
  createRepoBranch: 'repoBranchCreated',
  deleteRepoBranch: 'repoBranchDeleted',
  createRepoTag: 'repoTagCreated',
  deleteRepoTag: 'repoTagDeleted',
};

/**
 * Origin equality with URL-parse failures treated as "different": callers use
 * this to gate sending the stored token, so an unparseable target must fail
 * closed.
 */
function isSameOrigin(a: string, b: string): boolean {
  try {
    return new URL(a).origin === new URL(b).origin;
  } catch {
    return false;
  }
}

/**
 * Display label for a merge strategy, matching the webview's strategy picker.
 */
function mergeStrategyLabel(strategy: 'merge' | 'rebase' | 'squash'): string {
  switch (strategy) {
    case 'squash':
      return vscode.l10n.t('Squash and merge');
    case 'rebase':
      return vscode.l10n.t('Rebase and merge');
    default:
      return vscode.l10n.t('Create a merge commit');
  }
}

/**
 * Destructive confirmations must name their target: the repository a command
 * acts on is carried by the webview message and every dialog otherwise reads
 * the same generic "Delete this …?" text, so a mis-click can destroy the wrong
 * repository's branch, worktree, or issue. Kept together so a new destructive
 * command reuses the wording instead of inventing another generic prompt.
 */
function confirmInstanceScope(instance: Pick<ForgejoInstance, 'name'>, owner: string, repo: string): string {
  return `${instance.name} (${owner}/${repo})`;
}

/**
 * Validate the repository identity carried by a webview worktree message
 * before it is used. The webview is untrusted and these fields end up in both
 * the API URL and `path.join(cacheDir, 'worktrees', ...)`; `path.join`
 * normalises `..`, so an unvalidated `index` or `repo` could point the later
 * `fs.rm(..., { recursive: true })` / `git worktree add` outside the cache.
 */
function parseWorktreeTarget(message: {
  instanceId?: unknown;
  owner?: unknown;
  repo?: unknown;
  index?: unknown;
}): { instanceId: string; owner: string; repo: string; index: number } | undefined {
  const { instanceId, owner, repo, index } = message;
  if (typeof instanceId !== 'string' || instanceId.length === 0) {
    return undefined;
  }
  if (!isSafeRepoNameSegment(owner) || !isSafeRepoNameSegment(repo)) {
    return undefined;
  }
  if (typeof index !== 'number' || !Number.isInteger(index) || index <= 0) {
    return undefined;
  }
  return { instanceId, owner, repo, index };
}

/**
 * Short, filesystem-safe discriminator for the shared bare-clone cache paths.
 * Derived from the instance id + URL so the same `owner/repo` slug on two
 * instances cannot share one clone; the raw host is not used because it may
 * contain characters that are invalid in a path segment.
 */
export function instanceCacheSuffix(instance: { id: string; url: string }): string {
  return crypto.createHash('sha256').update(`${instance.id}|${instance.url}`).digest('hex').slice(0, 8);
}

/**
 * Defense in depth for every worktree path derived from a request: the caller
 * later deletes that directory recursively (`fs.rm(..., { recursive: true })`
 * or `git worktree remove --force`), so a path that escapes the worktree cache
 * must never be used, whatever produced it.
 */
function assertInsideWorktreeCache(worktreesDir: string, worktreePath: string): void {
  if (!isPathInsideFolder(worktreesDir, worktreePath)) {
    throw new Error(`Refusing a worktree path outside the worktree cache: ${worktreePath}`);
  }
}

/**
 * Session-level cache of proxied avatar fetches (same-origin URLs only; other
 * URLs are returned unchanged and never reach the cache). Forgejo avatar URLs
 * embed a content hash, so a resolved data URL never expires. Failures are
 * cached briefly — not indefinitely — so a transient error or a 401 from a
 * since-rotated token is retried instead of poisoning the session. The key is
 * the absolute URL alone: same-origin content is identical for every instance
 * on that origin, and the failure TTL covers the token-rotation edge.
 *
 * Values are promises so concurrent resolutions of the same URL share one
 * fetch. Bounded with simple LRU eviction: data URLs are large (base64), so
 * an unbounded Map would grow with every avatar ever viewed. Entries hold no
 * sensitive data (public avatar images keyed by URL), and a removed or edited
 * instance's entries simply stop being hit and age out, so instance changes
 * need no explicit cache invalidation.
 */
const MAX_RESOLVED_AVATARS = 100;
const AVATAR_FAILURE_TTL_MS = 60_000;

interface ResolvedAvatarEntry {
  promise: Promise<string | null>;
  /** Failures expire (set once the promise settles); successes never do. */
  expiresAt: number;
}

const resolvedAvatarCache = new Map<string, ResolvedAvatarEntry>();

function getCachedAvatar(url: string): Promise<string | null> | undefined {
  const entry = resolvedAvatarCache.get(url);
  if (!entry) {
    return undefined;
  }
  if (entry.expiresAt <= Date.now()) {
    resolvedAvatarCache.delete(url);
    return undefined;
  }
  // Refresh recency: re-insert so frequently used avatars are evicted last.
  resolvedAvatarCache.delete(url);
  resolvedAvatarCache.set(url, entry);
  return entry.promise;
}

function cacheResolvedAvatar(url: string, promise: Promise<string | null>): void {
  if (!resolvedAvatarCache.has(url) && resolvedAvatarCache.size >= MAX_RESOLVED_AVATARS) {
    // Map iteration order is insertion order: the first key is the oldest.
    const oldest = resolvedAvatarCache.keys().next().value;
    if (oldest !== undefined) {
      resolvedAvatarCache.delete(oldest);
    }
  }
  const entry: ResolvedAvatarEntry = { promise, expiresAt: Number.POSITIVE_INFINITY };
  void promise.then((dataUrl) => {
    if (dataUrl === null) {
      entry.expiresAt = Date.now() + AVATAR_FAILURE_TTL_MS;
    }
  });
  resolvedAvatarCache.set(url, entry);
}

/** Clear the session-level avatar cache. Exported for tests. */
export function clearResolvedAvatarCache(): void {
  resolvedAvatarCache.clear();
}

export class ForgejoToolkitViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'forgejoToolkitView';

  /** Cap for the pre-mount message queue (see `_postOrQueue`). */
  private static readonly MAX_PENDING_MESSAGES = 50;

  /** Invoked after a pull request is created, merged, or closed through the webview. */
  public onPullRequestsChanged: (() => void) | undefined;

  private _view?: vscode.WebviewView;
  private _pendingMessages: HostToWebviewMessage[] = [];
  /** Request ids currently being handled; a reply removes the id (see `_reply`). */
  private readonly _unansweredRequests = new Set<string>();
  private readonly _worktreeManager: WorktreeManager;
  /** Guards against concurrent openPrWorktree runs for the same PR (double-click). */
  private readonly _worktreeInFlight = new InFlightTasks();
  /** Guards against concurrent merge/revert mutations for the same PR (double-click). */
  private readonly _prMutationInFlight = new InFlightTasks();
  /**
   * Dedupes concurrent bare clones into the same cache path: two PRs of the
   * same repository opened at once would otherwise race `git clone --bare`
   * into one directory (the later clone fails).
   */
  private readonly _bareCloneInFlight = new InFlightTasks();
  /**
   * Full instance entries (tokens included) from the latest import preview,
   * kept host-side so token values never cross into the webview. Single slot:
   * a new preview overwrites it, and a confirmed or cancelled import clears
   * it. The `importInstances` confirmation rehydrates selected entries by id.
   */
  private _pendingImportInstances: ForgejoInstance[] | undefined;

  constructor(
    private readonly _context: vscode.ExtensionContext,
    private readonly _extensionUri: vscode.Uri,
    private readonly _config: ConfigManager,
    private readonly _readmeProvider: ReadmeContentProvider,
    worktreeManager?: WorktreeManager,
  ) {
    this._worktreeManager =
      worktreeManager ??
      new WorktreeManager(
        _context,
        () => this._config.getWorktreeCacheDirectory(),
        () => this._config.getDefaultWorktreeCacheDirectory(),
      );

    this._context.subscriptions.push(
      this._config.onInstancesChanged(() => {
        this._sendInstances();
        this._refreshWebviewInstanceOrigins();
      }),
    );
    this._context.subscriptions.push(
      vscode.workspace.onDidChangeWorkspaceFolders(() => this._detectAndSendLinkedRepository()),
      // In multi-repository workspaces the linked repository follows the
      // active editor; re-resolve when it changes (debounced).
      vscode.window.onDidChangeActiveTextEditor(() => this._scheduleLinkedRepositoryDetect()),
      // `forgejoToolkit.locale` can also be changed from the Settings editor,
      // while the in-panel picker posts `setLocale` itself. Without this the open
      // view keeps the language it was rendered with and the title never follows
      // the setting.
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (!event.affectsConfiguration('forgejoToolkit.locale')) {
          return;
        }
        const configured = vscode.workspace.getConfiguration('forgejoToolkit').get<'en' | 'zh' | undefined>('locale');
        const locale = resolveLocale(configured);
        this._reply('setLocale', { locale });
        this._updateViewTitle(locale);
        // The sidebar is not the only webview that renders in this language: an
        // open onboarding wizard or review-comment editor keeps the language it
        // was created with unless the host pushes the change into it too.
        OnboardingWebviewPanel.notifyLocaleChanged(locale);
        PullReviewCommentPanel.notifyLocaleChanged(locale);
      }),
      {
        dispose: () => {
          // Both timers run a git scan and a `setContext` on a disposed host if
          // they are left pending; the cold-start one fires 2 s after
          // activation, which is well within a short-lived or reloaded session.
          clearTimeout(this._linkedRepoDetectTimer);
          clearTimeout(this._initialDetectTimer);
        },
      },
    );

    // Cold-start detection: the user may never open a file or the sidebar,
    // but the SCM publish button (forgejoToolkit.hasUnpublishedRepo) must
    // still appear. Delayed so activation stays fast; unref'd so tests are
    // not held open. Failures are swallowed inside
    // _detectAndSendLinkedRepository, so this never becomes an unhandled
    // rejection.
    this._initialDetectTimer = setTimeout(() => {
      void this._detectAndSendLinkedRepository();
    }, 2000);
    this._initialDetectTimer.unref?.();
  }

  public resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken,
  ) {
    this._view = webviewView;

    // Codicons ship inside the webview bundle (imported in webview/src/main.ts
    // with the font inlined), so there is nothing to resolve from node_modules
    // here — which would also fail in a packaged install where node_modules is
    // excluded.
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this._extensionUri, 'out', 'webview')],
    };

    webviewView.webview.html = this._renderWebviewHtml(webviewView.webview);

    webviewView.onDidDispose(() => {
      if (this._view === webviewView) {
        this._view = undefined;
      }
    });

    webviewView.webview.onDidReceiveMessage(
      (message) => {
        void this._dispatchMessage(message);
      },
      undefined,
      [],
    );

    webviewView.onDidChangeVisibility(() => {
      if (webviewView.visible) {
        this._sendInstances();
        this._detectAndSendLinkedRepository();
      }
    });
  }

  /**
   * Serialized instance-origin set baked into the last generated HTML. The
   * CSP img-src allowlists instance origins, so the HTML must be regenerated
   * when that set changes.
   */
  private _webviewInstanceOriginsKey: string | undefined;

  private _renderWebviewHtml(webview: vscode.Webview): string {
    const instanceUrls = this._config.getInstances().map((i) => i.url);
    this._webviewInstanceOriginsKey = JSON.stringify(toInstanceOrigins(instanceUrls).sort());
    return getWebviewContent(webview, this._extensionUri.fsPath, { instanceUrls });
  }

  /**
   * The HTML — and with it the CSP instance-origin allowlist — is generated
   * once at resolve time; an instance added afterwards would have its direct
   * images blocked until a reload. Regenerate when the origin set changes.
   * Reloading loses transient webview state, which is acceptable: instance
   * changes are rare and the webview re-requests its initial state. There is
   * no loop: resetting html does not fire another instances change.
   */
  private _refreshWebviewInstanceOrigins(): void {
    if (!this._view) {
      return;
    }
    const key = JSON.stringify(toInstanceOrigins(this._config.getInstances().map((i) => i.url)).sort());
    if (key !== this._webviewInstanceOriginsKey) {
      this._view.webview.html = this._renderWebviewHtml(this._view.webview);
    }
  }

  /**
   * Fallback dispatch wrapper for webview messages. Many handlers bail out
   * early (unknown instance, invalid payload) without sending a reply; for
   * request/response messages (carrying `_requestId`) that leaves the webview
   * promise pending forever. This wrapper tracks whether a reply with the
   * same `_requestId` was sent (see `_reply`) and emits a generic
   * `requestError` reply when the handler finished — or threw — without one.
   */
  private async _dispatchMessage(message: any): Promise<void> {
    if (!message || typeof message !== 'object' || typeof message.command !== 'string') {
      logger.error('Ignoring malformed message from webview');
      return;
    }
    // Repository identity from the webview is interpolated verbatim into API
    // paths (`/repos/${owner}/${repo}/…`), where the URL parser resolves dot
    // segments and splits on `?`/`#`: an unvalidated value turns a
    // repository-scoped command into an arbitrary same-origin request. Every
    // command carrying this pair is rejected here, before any handler runs.
    if (!isSafeRepoIdentity(message.owner, message.repo)) {
      logger.error(
        `Ignoring webview message "${message.command}" with an unsafe owner/repo identity: ${String(message.owner)}/${String(message.repo)}`,
      );
      // startWorkOnIssue is a plain (requestId-less) message whose result is
      // routed by the coordinates it carries, and the webview sets its
      // start-work spinner before posting. Answering it with `requestError`
      // (which it cannot route) or not at all would leave that spinner running
      // forever, so it gets the same startWorkResult shape as the handler's
      // invalid-payload path.
      if (message.command === 'startWorkOnIssue') {
        this._reply('startWorkResult', {
          instanceId: message.instanceId,
          owner: message.owner,
          repo: message.repo,
          index: message.index,
          error: vscode.l10n.t('The request could not be completed'),
        });
        return;
      }
      // openPrWorktree is the same kind of plain (requestId-less) message, and
      // the PR view spins until a worktreeOpened/worktreeCancelled/
      // worktreeError reply arrives. The identity fields are echoed when they
      // are strings so the reply routes to the view that asked (the webview
      // builds that key from whatever it sent).
      if (message.command === 'openPrWorktree') {
        this._reply('worktreeError', {
          error: vscode.l10n.t('The request could not be completed'),
          operation: 'open',
          instanceId: typeof message.instanceId === 'string' ? message.instanceId : undefined,
          owner: typeof message.owner === 'string' ? message.owner : undefined,
          repo: typeof message.repo === 'string' ? message.repo : undefined,
          index: typeof message.index === 'number' ? message.index : undefined,
        });
        return;
      }
      const requestId = typeof message._requestId === 'string' ? (message._requestId as string) : undefined;
      if (requestId) {
        this._reply('requestError', {
          _requestId: requestId,
          error: vscode.l10n.t('The request could not be completed'),
        });
        return;
      }
      // RequestId-less loaders (getRepoContents, getFileHistory, …) set their
      // spinner before posting and clear it only on their own result message, so
      // returning silently leaves it spinning forever. Reject through the same
      // reply contract as the handler's invalid-payload path.
      const resultCommand = LOAD_RESULT_COMMANDS[message.command] ?? MUTATION_RESULT_COMMANDS[message.command];
      if (resultCommand) {
        this._replyResultShapedError(message, resultCommand, vscode.l10n.t('The request could not be completed'));
      }
      return;
    }
    const requestId = typeof message._requestId === 'string' ? (message._requestId as string) : undefined;
    if (requestId) {
      this._unansweredRequests.add(requestId);
    }
    try {
      await this._handleMessage(message);
    } catch (error) {
      const err = userFacingErrorMessage(error);
      logger.error(`Error handling webview message "${message.command}": ${err}`);
    } finally {
      if (requestId && this._unansweredRequests.has(requestId)) {
        this._unansweredRequests.delete(requestId);
        logger.error(`Handler for "${message.command}" ended without replying to request ${requestId}`);
        this._reply('requestError', {
          _requestId: requestId,
          error: vscode.l10n.t('The request could not be completed'),
        });
      }
    }
  }

  /**
   * Answers a requestId-less, result-shaped webview message with an error reply
   * that echoes the request fields (minus `command`) — which is how the webview
   * routes the result to its loading key. Used when a request is rejected before
   * any handler runs (a deleted instance, a forged owner/repo), where returning
   * silently would leave the view spinning forever.
   */
  private _replyResultShapedError(message: any, resultCommand: string, error: string): void {
    const { command: _command, ...rest } = message as Record<string, unknown>;
    // editIssue/editPullRequest route close/reopen toggles and inline due-date
    // saves to their own loading keys via these flags, which the handlers derive
    // from `data` on the normal path.
    const editData = rest.data as { state_toggle?: unknown; due_date_update?: unknown } | undefined;
    const routingFlags =
      message.command === 'editIssue' || message.command === 'editPullRequest'
        ? {
            ...(editData?.state_toggle ? { stateToggle: true } : {}),
            ...(editData?.due_date_update ? { dueDateUpdate: true } : {}),
          }
        : {};
    (this._reply as (command: string, data: Record<string, unknown>) => void)(resultCommand, {
      ...rest,
      ...routingFlags,
      error,
    });
  }

  private async _handleMessage(message: any): Promise<void> {
    logger.debug(`Received message from webview: ${message.command}`);
    // Instance was deleted while a keep-alive view still targets it: answer
    // load and mutation requests with an error reply so the view shows the
    // error instead of spinning forever (the handlers themselves bail out
    // silently). The reply echoes the request fields, which is how the
    // webview routes it to the right loading key.
    const resultCommand = LOAD_RESULT_COMMANDS[message.command] ?? MUTATION_RESULT_COMMANDS[message.command];
    if (resultCommand && typeof message.instanceId === 'string' && !this._findInstance(message.instanceId)) {
      logger.error(`${message.command} failed: instance not found: ${message.instanceId}`);
      this._replyResultShapedError(
        message,
        resultCommand,
        vscode.l10n.t('The Forgejo instance is no longer configured'),
      );
      return;
    }
    switch (message.command) {
      case 'getInitialState': {
        const configured = vscode.workspace.getConfiguration('forgejoToolkit').get<'en' | 'zh' | undefined>('locale');
        const locale: 'en' | 'zh' = resolveLocale(configured);
        const debug = vscode.workspace.getConfiguration('forgejoToolkit').get<boolean>('debug', false);
        const directory = this._config.getWorktreeCacheDirectory() ?? '';
        const defaultDirectory = this._config.getDefaultWorktreeCacheDirectory();
        this._updateViewTitle(locale);
        this._reply('initialState', {
          instances: this._config.getInstances().map(toPublicInstance),
          locale,
          debug,
          worktrees: this._worktreeManager.getWorktrees(),
          worktreeOpenMode: this._config.getWorktreeOpenMode(),
          worktreeCacheDirectory: directory,
          worktreeCacheDirectoryDefault: defaultDirectory,
        });
        this._detectAndSendLinkedRepository();
        if (this._pendingMessages.length > 0) {
          const pending = this._pendingMessages.splice(0);
          for (const message of pending) {
            this._view?.webview.postMessage(message);
          }
        }
        return;
      }
      case 'getLinkedRepository': {
        this._detectAndSendLinkedRepository();
        return;
      }

      case 'testConnection': {
        const { url, token, instanceId } = message;
        if (typeof url !== 'string' || typeof token !== 'string') {
          this._reply('testConnectionResult', {
            success: false,
            error: vscode.l10n.t('Enter a valid http(s) URL for the Forgejo instance.'),
          });
          return;
        }
        // See isHttpUrl: the target is chosen by the webview, so only web URLs
        // may be reached. The setup wizard stays free to test any instance.
        if (!isHttpUrl(url)) {
          logger.error(`testConnection rejected a non-http(s) URL`);
          this._reply('testConnectionResult', {
            success: false,
            error: vscode.l10n.t('Enter a valid http(s) URL for the Forgejo instance.'),
          });
          return;
        }
        // When editing an instance the token field is left empty to keep the
        // stored token (tokens are never sent to the webview); fall back to it
        // so testing the connection of a private instance does not fail. The
        // fallback is restricted to the instance's own origin — otherwise a
        // compromised webview could exfiltrate the token to any URL.
        let effectiveToken = token;
        if (!effectiveToken && typeof instanceId === 'string') {
          const instance = this._findInstance(instanceId);
          if (instance && isSameOrigin(url, instance.url)) {
            effectiveToken = instance.token;
          }
        }
        try {
          const client = new ForgejoClient(url, effectiveToken, logger);
          const user = await client.getCurrentUser();
          // Refresh the cached server version used by the feature gates.
          void probeServerVersion(url, effectiveToken, logger);
          this._reply('testConnectionResult', { success: true, username: user.login });
        } catch (error) {
          const err = userFacingErrorMessage(error);
          logger.error(`testConnection failed: ${err}`);
          // Transport/HTTP failures reply with a status-only message: the raw
          // response body is authored by the remote server and must not be
          // reflected into the webview (see connectionFailureMessage).
          this._reply('testConnectionResult', { success: false, error: connectionFailureMessage(error) });
        }
        return;
      }
      case 'saveInstance': {
        const { url, token, syncApiUrlsToInstanceUrl } = message;
        if (typeof url !== 'string' || typeof token !== 'string') {
          this._reply('saveInstanceResult', { success: false, error: 'Invalid input' });
          return;
        }
        try {
          const client = new ForgejoClient(url, token, logger);
          const user = await client.getCurrentUser();

          const normalizedUrl = url.replace(/\/$/, '');
          const parsedInstanceUrl = new URL(normalizedUrl);
          const instanceHost = parsedInstanceUrl.host;
          const instance: ForgejoInstance = {
            id: instanceIdFor(normalizedUrl, user.login),
            url: normalizedUrl,
            token,
            name: `${user.login}@${instanceHost}${parsedInstanceUrl.pathname.replace(/\/+$/, '')}`,
            username: user.login,
            syncApiUrlsToInstanceUrl,
          };

          await this._config.addInstance(instance);
          // Drop stale per-URL caches before re-probing/re-detecting: the
          // server version may predate an upgrade (Actions gate) and the
          // linked-repository scan may hold a negative entry from before the
          // instance was configured.
          clearServerVersion(normalizedUrl);
          clearLinkedRepositoryCache();
          void probeServerVersion(normalizedUrl, token, logger, syncApiUrlsToInstanceUrl);
          this._sendInstances();
          this._detectAndSendLinkedRepository();
          this._reply('saveInstanceResult', { success: true });
          vscode.window.showInformationMessage(vscode.l10n.t('Connected to Forgejo as {0}', user.login));
        } catch (error) {
          const err = userFacingErrorMessage(error);
          logger.error(`saveInstance failed: ${err}`);
          this._reply('saveInstanceResult', { success: false, error: err });
        }
        return;
      }
      case 'editInstance': {
        const { id, url, token, syncApiUrlsToInstanceUrl } = message;
        if (typeof id !== 'string' || typeof url !== 'string' || typeof token !== 'string') {
          this._reply('saveInstanceResult', { success: false, error: 'Invalid input' });
          return;
        }
        try {
          const existing = this._findInstance(id);
          if (!existing) {
            this._reply('saveInstanceResult', { success: false, error: 'Instance not found' });
            return;
          }
          // The webview never receives stored tokens; an empty token field
          // means "keep the current token", so validate with the stored one.
          // A URL change to a different origin must not be validated — let
          // alone persisted — with the stored token: that would hand the
          // token to a third-party host chosen by the webview.
          if (!token && !isSameOrigin(url, existing.url)) {
            this._reply('saveInstanceResult', {
              success: false,
              error: vscode.l10n.t('Changing the instance URL requires entering the access token again'),
            });
            return;
          }
          const effectiveToken = token || existing.token;
          const client = new ForgejoClient(url, effectiveToken, logger);
          const user = await client.getCurrentUser();

          const normalizedUrl = url.replace(/\/$/, '');
          await this._config.updateInstance(id, {
            url: normalizedUrl,
            token,
            name: `${user.login}@${new URL(normalizedUrl).host}`,
            username: user.login,
            syncApiUrlsToInstanceUrl,
          });
          // Drop stale per-URL caches (old and new URL) before re-probing:
          // the cached server version never expires on its own, so an
          // upgraded server would otherwise stay behind the Actions gate.
          clearServerVersion(normalizedUrl);
          clearServerVersion(existing.url);
          clearLinkedRepositoryCache();
          void probeServerVersion(normalizedUrl, effectiveToken, logger, syncApiUrlsToInstanceUrl);
          this._sendInstances();
          this._detectAndSendLinkedRepository();
          this._reply('saveInstanceResult', { success: true });
          vscode.window.showInformationMessage(vscode.l10n.t('Updated Forgejo instance for {0}', user.login));
        } catch (error) {
          const err = userFacingErrorMessage(error);
          logger.error(`editInstance failed: ${err}`);
          this._reply('saveInstanceResult', { success: false, error: err });
        }
        return;
      }
      case 'removeInstance': {
        const { id } = message;
        if (typeof id !== 'string') {
          return;
        }
        const instance = this._findInstance(id);
        if (!instance) {
          return;
        }
        // The webview tracks no pending state for this command, so a declined
        // confirmation needs no reply: the instance list simply stays as is.
        if (!(await this._confirmDestructive(vscode.l10n.t('Remove instance "{0}"?', instance.name)))) {
          return;
        }
        const removedWorktrees = await this._config.removeInstance(id);
        if (removedWorktrees > 0) {
          // The checkouts are still on disk (they may hold uncommitted work);
          // say so instead of letting the user believe they were deleted.
          void vscode.window.showInformationMessage(
            vscode.l10n.t(
              'Removed instance {0} along with its {1} worktree record(s).',
              instance.name,
              removedWorktrees,
            ),
          );
        }
        this._sendInstances();
        this._detectAndSendLinkedRepository();
        return;
      }
      case 'exportInstances': {
        const ids = Array.isArray((message as { ids?: unknown[] }).ids)
          ? ((message as { ids?: string[] }).ids as string[])
          : undefined;
        await this._exportInstances(ids);
        return;
      }
      case 'copyInstancesToClipboard': {
        const ids = Array.isArray((message as { ids?: unknown[] }).ids)
          ? ((message as { ids?: string[] }).ids as string[])
          : undefined;
        await this._copyInstancesToClipboard(ids);
        return;
      }
      case 'previewImportInstances': {
        await this._previewImportInstances();
        return;
      }
      case 'importInstances': {
        const rawIds = (message as { ids?: unknown }).ids;
        const settings = (message as { settings?: ExportSettings }).settings;
        if (Array.isArray(rawIds)) {
          // Preview confirmation: rehydrate the selected entries from the
          // host-side stash. Instance data sent by the webview (tokens in
          // particular) is untrusted and ignored entirely.
          const pending = this._pendingImportInstances;
          this._pendingImportInstances = undefined;
          if (!pending) {
            this._reply('instancesImported', {
              success: false,
              error: vscode.l10n.t('The import preview is no longer available; please pick the file again'),
            });
            return;
          }
          const wanted = new Set(rawIds.filter((id): id is string => typeof id === 'string'));
          const selected = pending.filter((instance) => wanted.has(instance.id));
          if (selected.length === 0) {
            this._reply('instancesImported', {
              success: false,
              error: vscode.l10n.t('No valid instances found in the import data'),
            });
            return;
          }
          await this._importInstances(selected, settings);
          return;
        }
        await this._importInstances(undefined, settings);
        return;
      }
      case 'cancelImportInstances': {
        this._pendingImportInstances = undefined;
        return;
      }
      case 'setLocale': {
        const newLocale = message.locale;
        if (typeof newLocale === 'string' && (newLocale === 'en' || newLocale === 'zh')) {
          await vscode.workspace.getConfiguration('forgejoToolkit').update('locale', newLocale, true);
          this._reply('setLocale', { locale: newLocale });
          this._updateViewTitle(newLocale);
        }
        return;
      }
      case 'setDebug': {
        const debug = message.debug;
        if (typeof debug === 'boolean') {
          await vscode.workspace.getConfiguration('forgejoToolkit').update('debug', debug, true);
        }
        return;
      }
      case 'openExternal': {
        const url = message.url;
        if (typeof url !== 'string') {
          return;
        }
        const uri = vscode.Uri.parse(url);
        // The webview is untrusted input: only open web URLs. Local paths
        // (e.g. worktree directories) go through the validated
        // openWorktreePath message instead.
        if (uri.scheme !== 'http' && uri.scheme !== 'https') {
          logger.error(`Blocked openExternal with disallowed scheme "${uri.scheme}": ${url}`);
          return;
        }
        try {
          await vscode.env.openExternal(uri);
        } catch (error) {
          const err = userFacingErrorMessage(error);
          logger.error(`openExternal failed for ${url}: ${err}`);
        }
        return;
      }
      case 'openWorktreePath': {
        const worktreePath = message.path;
        if (typeof worktreePath !== 'string') {
          return;
        }
        // Only paths of recorded worktrees may be opened; the webview
        // cannot probe arbitrary local paths this way.
        const known = this._worktreeManager.getWorktrees().some((w) => w.worktreePath === worktreePath);
        if (!known) {
          logger.error(`Blocked openWorktreePath for unknown worktree path: ${worktreePath}`);
          return;
        }
        try {
          await vscode.env.openExternal(vscode.Uri.file(worktreePath));
        } catch (error) {
          const err = userFacingErrorMessage(error);
          logger.error(`openWorktreePath failed for ${worktreePath}: ${err}`);
        }
        return;
      }
      case 'getRepositories': {
        const instance = this._findInstance(message.instanceId);
        if (!instance) {
          return;
        }
        try {
          const client = new ForgejoClient(instance.url, instance.token, logger, instance.syncApiUrlsToInstanceUrl);
          const repos = await client.getUserRepositories();
          logger.info(`getRepositories returned ${repos.length} repos for ${instance.name}`);
          this._reply('repositories', { instanceId: instance.id, repositories: repos });
        } catch (error) {
          const err = userFacingErrorMessage(error);
          logger.error(`getRepositories failed for ${instance.name}: ${err}`);
          this._reply('repositories', { instanceId: message.instanceId, error: err });
        }
        return;
      }
      case 'getMyIssues': {
        const instance = this._findInstance(message.instanceId);
        if (!instance) {
          return;
        }
        // Echo the requested state so the webview can route the reply to the
        // right state-scoped slot even when several states load concurrently.
        const state = typeof message.state === 'string' ? message.state : 'open';
        try {
          const client = new ForgejoClient(instance.url, instance.token, logger, instance.syncApiUrlsToInstanceUrl);
          const issues = await client.getUserIssues(state);
          this._reply('myIssues', { instanceId: instance.id, state, issues });
        } catch (error) {
          const err = userFacingErrorMessage(error);
          logger.error(`getMyIssues failed for ${instance.name}: ${err}`);
          this._reply('myIssues', { instanceId: message.instanceId, state, error: err });
        }
        return;
      }
      case 'getMyPullRequests': {
        const instance = this._findInstance(message.instanceId);
        if (!instance) {
          return;
        }
        const state = typeof message.state === 'string' ? message.state : 'open';
        try {
          const client = new ForgejoClient(instance.url, instance.token, logger, instance.syncApiUrlsToInstanceUrl);
          const pulls = await client.getUserPullRequests(state);
          this._reply('myPullRequests', { instanceId: instance.id, state, pullRequests: pulls });
        } catch (error) {
          const err = userFacingErrorMessage(error);
          logger.error(`getMyPullRequests failed for ${instance.name}: ${err}`);
          this._reply('myPullRequests', { instanceId: message.instanceId, state, error: err });
        }
        return;
      }
      case 'globalSearch': {
        const instance = this._findInstance(message.instanceId);
        if (!instance) {
          return;
        }
        const { scope: rawScope, query, state: searchState, limit } = message;
        if (
          typeof rawScope !== 'string' ||
          typeof query !== 'string' ||
          typeof searchState !== 'string' ||
          !['all', 'repositories', 'issues', 'pullRequests'].includes(rawScope)
        ) {
          // The search view only clears its loading gate on a
          // `globalSearchResult` reply and this message carries no
          // `_requestId`, so the dispatch fallback cannot answer it.
          this._replyResultShapedError(
            message,
            'globalSearchResult',
            vscode.l10n.t('The request could not be completed'),
          );
          return;
        }
        const scope = rawScope as 'all' | 'repositories' | 'issues' | 'pullRequests';
        const state = ['open', 'closed', 'all'].includes(searchState) ? searchState : 'all';
        try {
          const client = new ForgejoClient(instance.url, instance.token, logger, instance.syncApiUrlsToInstanceUrl);
          const [repositories, issues, pullRequests] = await Promise.all([
            scope === 'all' || scope === 'repositories'
              ? client.searchRepositories(query, limit ?? 20)
              : Promise.resolve(undefined),
            scope === 'all' || scope === 'issues'
              ? client.searchIssues(query, state, limit ?? 20)
              : Promise.resolve(undefined),
            scope === 'all' || scope === 'pullRequests'
              ? client.searchPullRequests(query, state, limit ?? 20)
              : Promise.resolve(undefined),
          ]);
          logger.info(
            `globalSearch [${scope}] "${query}" (${state}) for ${instance.name}: repos=${repositories?.length ?? 0}, issues=${issues?.length ?? 0}, pulls=${pullRequests?.length ?? 0}`,
          );
          this._reply('globalSearchResult', {
            instanceId: instance.id,
            scope,
            query,
            state,
            repositories,
            issues,
            pullRequests,
          });
        } catch (error) {
          const err = userFacingErrorMessage(error);
          logger.error(`globalSearch failed for ${instance.name}: ${err}`);
          this._reply('globalSearchResult', {
            instanceId: message.instanceId,
            scope,
            query,
            state,
            error: err,
          });
        }
        return;
      }
      case 'getNotifications': {
        const instance = this._findInstance(message.instanceId);
        if (!instance) {
          return;
        }
        const { statusTypes, subjectType, limit, before } = message;
        try {
          const client = new ForgejoClient(instance.url, instance.token, logger, instance.syncApiUrlsToInstanceUrl);
          const cursor = typeof before === 'string' && before ? before : undefined;
          const notifications = await client.getNotifications(
            Array.isArray(statusTypes) ? statusTypes : undefined,
            Array.isArray(subjectType)
              ? (subjectType.filter((t): t is 'issue' | 'pull' | 'repository' =>
                  ['issue', 'pull', 'repository'].includes(t as string),
                ) as ('issue' | 'pull' | 'repository')[])
              : undefined,
            typeof limit === 'number' ? limit : 50,
            cursor,
          );
          logger.info(
            `getNotifications returned ${notifications.length} items for ${instance.name}${cursor ? ` before ${cursor}` : ''}`,
          );
          this._reply('notifications', {
            instanceId: instance.id,
            notifications,
            ...(cursor ? { before: cursor } : {}),
          });
        } catch (error) {
          const err = userFacingErrorMessage(error);
          logger.error(`getNotifications failed for ${instance.name}: ${err}`);
          this._reply('notifications', { instanceId: message.instanceId, error: err });
        }
        return;
      }
      case 'markNotificationRead': {
        const instance = this._findInstance(message.instanceId);
        if (!instance) {
          return;
        }
        const { id } = message;
        if (typeof id !== 'number') {
          return;
        }
        try {
          const client = new ForgejoClient(instance.url, instance.token, logger, instance.syncApiUrlsToInstanceUrl);
          await client.markNotificationRead(id);
          this._reply('notificationMarkedRead', { instanceId: instance.id, id });
        } catch (error) {
          const err = userFacingErrorMessage(error);
          logger.error(`markNotificationRead failed for ${instance.name}/${id}: ${err}`);
          this._reply('notificationMarkedRead', { instanceId: message.instanceId, id, error: err });
        }
        return;
      }
      case 'markAllNotificationsRead': {
        const instance = this._findInstance(message.instanceId);
        if (!instance) {
          return;
        }
        try {
          const client = new ForgejoClient(instance.url, instance.token, logger, instance.syncApiUrlsToInstanceUrl);
          await client.markAllNotificationsRead();
          this._reply('allNotificationsMarkedRead', { instanceId: instance.id });
        } catch (error) {
          const err = userFacingErrorMessage(error);
          logger.error(`markAllNotificationsRead failed for ${instance.name}: ${err}`);
          this._reply('allNotificationsMarkedRead', { instanceId: message.instanceId, error: err });
        }
        return;
      }
      case 'getRepoDetail': {
        const instance = this._findInstance(message.instanceId);
        if (!instance) {
          return;
        }
        const { owner, repo } = message;
        if (typeof owner !== 'string' || typeof repo !== 'string') {
          return;
        }
        try {
          const client = new ForgejoClient(instance.url, instance.token, logger, instance.syncApiUrlsToInstanceUrl);
          const detail = await client.getRepoDetail(owner, repo);
          // `readme` is undefined both for a repository without a README and for
          // one whose README the contents API withheld; `detail.readmeSize` is
          // set only in the second case (and only for a non-empty payload), so
          // the notice needs no second `/contents/README.md` probe. The dashboard
          // would otherwise show neither a README nor an explanation.
          const readme =
            detail.readme ?? (detail.readmeSize !== undefined ? missingPayloadNotice(detail.readmeSize) : undefined);
          const detailWithResolvedAvatars = await this._resolveCommitAvatars({ ...detail, readme }, instance);
          this._reply('repoDetail', {
            instanceId: instance.id,
            owner,
            repo,
            detail: detailWithResolvedAvatars,
          });
        } catch (error) {
          const err = userFacingErrorMessage(error);
          logger.error(`getRepoDetail failed for ${instance.name}/${owner}/${repo}: ${err}`);
          this._reply('repoDetail', { instanceId: message.instanceId, owner, repo, error: err });
        }
        return;
      }
      case 'getRepoBranchCommits': {
        const instance = this._findInstance(message.instanceId);
        if (!instance) {
          return;
        }
        const { owner, repo, branch } = message;
        if (typeof owner !== 'string' || typeof repo !== 'string' || typeof branch !== 'string') {
          return;
        }
        try {
          const client = new ForgejoClient(instance.url, instance.token, logger, instance.syncApiUrlsToInstanceUrl);
          const commits = await client.getRepoBranchCommits(owner, repo, branch);
          const commitsWithResolvedAvatars = await this._resolveCommitAvatars(
            {
              repository: {},
              branches: [],
              recentCommits: commits,
            },
            instance,
          );
          this._reply('repoBranchCommits', {
            instanceId: instance.id,
            owner,
            repo,
            branch,
            commits: commitsWithResolvedAvatars.recentCommits,
          });
        } catch (error) {
          const err = userFacingErrorMessage(error);
          logger.error(`getRepoBranchCommits failed for ${instance.name}/${owner}/${repo}/${branch}: ${err}`);
          this._reply('repoBranchCommits', {
            instanceId: message.instanceId,
            owner,
            repo,
            branch,
            error: err,
          });
        }
        return;
      }
      case 'getIssueDetail': {
        const instance = this._findInstance(message.instanceId);
        if (!instance) {
          return;
        }
        const { owner, repo, index } = message;
        if (typeof owner !== 'string' || typeof repo !== 'string' || typeof index !== 'number') {
          return;
        }
        try {
          const client = new ForgejoClient(instance.url, instance.token, logger, instance.syncApiUrlsToInstanceUrl);
          const detail = await client.getIssueDetail(owner, repo, index);
          this._reply('issueDetail', {
            instanceId: instance.id,
            owner,
            repo,
            index,
            detail,
          });
        } catch (error) {
          const err = userFacingErrorMessage(error);
          logger.error(`getIssueDetail failed for ${instance.name}/${owner}/${repo}#${index}: ${err}`);
          this._reply('issueDetail', {
            instanceId: message.instanceId,
            owner,
            repo,
            index,
            error: err,
          });
        }
        return;
      }
      case 'createIssue': {
        const instance = this._findInstance(message.instanceId);
        if (!instance) {
          return;
        }
        const { owner, repo, data } = message;
        if (typeof owner !== 'string' || typeof repo !== 'string' || !data || typeof data.title !== 'string') {
          return;
        }
        try {
          const client = new ForgejoClient(instance.url, instance.token, logger, instance.syncApiUrlsToInstanceUrl);
          const item = await client.createIssue(owner, repo, data);
          this._reply('issueCreated', {
            instanceId: instance.id,
            owner,
            repo,
            index: (item as { number?: number }).number ?? 0,
            item,
            _requestId: message._requestId,
          });
        } catch (error) {
          const err = userFacingErrorMessage(error);
          logger.error(`createIssue failed for ${instance.name}/${owner}/${repo}: ${err}`);
          this._reply('issueCreated', {
            instanceId: message.instanceId,
            owner,
            repo,
            index: 0,
            error: err,
            _requestId: message._requestId,
          });
        }
        return;
      }
      case 'editIssue': {
        const instance = this._findInstance(message.instanceId);
        if (!instance) {
          return;
        }
        const { owner, repo, index, data } = message;
        if (typeof owner !== 'string' || typeof repo !== 'string' || typeof index !== 'number' || !data) {
          return;
        }
        try {
          const client = new ForgejoClient(instance.url, instance.token, logger, instance.syncApiUrlsToInstanceUrl);
          const {
            labels,
            state_toggle: stateToggle,
            due_date_update: dueDateUpdate,
            ...issueData
          } = data as {
            title?: string;
            body?: string;
            state?: string;
            labels?: number[];
            assignees?: string[];
            milestone?: number;
            due_date?: string;
            unset_due_date?: boolean;
            state_toggle?: boolean;
            due_date_update?: boolean;
          };
          const item = await client.editIssue(owner, repo, index, issueData);
          if (Array.isArray(labels)) {
            await client.replaceIssueLabels(owner, repo, index, labels);
          }
          this._reply('issueUpdated', {
            instanceId: instance.id,
            owner,
            repo,
            index,
            item,
            ...(stateToggle ? { stateToggle: true } : {}),
            ...(dueDateUpdate ? { dueDateUpdate: true } : {}),
          });
        } catch (error) {
          const err = userFacingErrorMessage(error);
          logger.error(`editIssue failed for ${instance.name}/${owner}/${repo}#${index}: ${err}`);
          this._reply('issueUpdated', {
            instanceId: message.instanceId,
            owner,
            repo,
            index,
            error: err,
            ...((data as { state_toggle?: boolean }).state_toggle ? { stateToggle: true } : {}),
            ...((data as { due_date_update?: boolean }).due_date_update ? { dueDateUpdate: true } : {}),
          });
        }
        return;
      }
      case 'deleteIssue': {
        const instance = this._findInstance(message.instanceId);
        if (!instance) {
          return;
        }
        const { owner, repo, index } = message;
        if (typeof owner !== 'string' || typeof repo !== 'string' || typeof index !== 'number') {
          return;
        }
        // Explicit cancel reply (like the import preview): the webview's
        // loading state for this command would never clear otherwise.
        if (
          !(await this._confirmDestructive(
            vscode.l10n.t(
              'Delete issue #{0} in {1}? This cannot be undone.',
              index,
              confirmInstanceScope(instance, owner, repo),
            ),
          ))
        ) {
          this._reply('issueDeleted', { instanceId: instance.id, owner, repo, index, cancelled: true });
          return;
        }
        try {
          const client = new ForgejoClient(instance.url, instance.token, logger, instance.syncApiUrlsToInstanceUrl);
          await client.deleteIssue(owner, repo, index);
          this._reply('issueDeleted', {
            instanceId: instance.id,
            owner,
            repo,
            index,
          });
        } catch (error) {
          const err = userFacingErrorMessage(error);
          logger.error(`deleteIssue failed for ${instance.name}/${owner}/${repo}#${index}: ${err}`);
          this._reply('issueDeleted', { instanceId: message.instanceId, owner, repo, index, error: err });
        }
        return;
      }
      case 'checkIssueSubscription': {
        const instance = this._findInstance(message.instanceId);
        if (!instance) {
          return;
        }
        const { owner, repo, index } = message;
        if (typeof owner !== 'string' || typeof repo !== 'string' || typeof index !== 'number') {
          return;
        }
        try {
          const client = new ForgejoClient(instance.url, instance.token, logger, instance.syncApiUrlsToInstanceUrl);
          const info = await client.checkIssueSubscription(owner, repo, index);
          this._reply('issueSubscriptionChecked', {
            instanceId: instance.id,
            owner,
            repo,
            index,
            subscribed: info.subscribed,
          });
        } catch (error) {
          const err = userFacingErrorMessage(error);
          logger.error(`checkIssueSubscription failed for ${instance.name}/${owner}/${repo}#${index}: ${err}`);
          this._reply('issueSubscriptionChecked', {
            instanceId: message.instanceId,
            owner,
            repo,
            index,
            error: err,
          });
        }
        return;
      }
      case 'changeIssueSubscription': {
        const instance = this._findInstance(message.instanceId);
        if (!instance) {
          return;
        }
        const { owner, repo, index, user, subscribe } = message;
        if (
          typeof owner !== 'string' ||
          typeof repo !== 'string' ||
          typeof index !== 'number' ||
          // `user` becomes the last path segment of a subscription route; a value
          // like `../..` would retarget a prompt-free unsubscribe at another API
          // path, so it is held to the same rule as a repository name.
          !isSafeRepoNameSegment(user)
        ) {
          return;
        }
        try {
          const client = new ForgejoClient(instance.url, instance.token, logger, instance.syncApiUrlsToInstanceUrl);
          if (subscribe) {
            await client.addIssueSubscription(owner, repo, index, user);
          } else {
            await client.deleteIssueSubscription(owner, repo, index, user);
          }
          this._reply('issueSubscriptionChanged', {
            instanceId: instance.id,
            owner,
            repo,
            index,
            subscribed: subscribe,
          });
        } catch (error) {
          const err = userFacingErrorMessage(error);
          logger.error(`changeIssueSubscription failed for ${instance.name}/${owner}/${repo}#${index}: ${err}`);
          this._reply('issueSubscriptionChanged', {
            instanceId: message.instanceId,
            owner,
            repo,
            index,
            error: err,
          });
        }
        return;
      }
      case 'startIssueStopwatch':
      case 'stopIssueStopwatch':
      case 'deleteIssueStopwatch': {
        const instance = this._findInstance(message.instanceId);
        if (!instance) {
          return;
        }
        const { owner, repo, index } = message;
        if (typeof owner !== 'string' || typeof repo !== 'string' || typeof index !== 'number') {
          return;
        }
        // Confirmed before the client is built: a declined confirmation must not
        // even construct a request. Start/stop are not destructive, so only the
        // delete action prompts.
        if (message.command === 'deleteIssueStopwatch') {
          if (
            !(await this._confirmDestructive(
              vscode.l10n.t(
                'Discard the running timer for issue #{0} in {1}?',
                index,
                confirmInstanceScope(instance, owner, repo),
              ),
            ))
          ) {
            // Answer with `cancelled` so the webview clears its pending state
            // without treating the decline as a failure.
            this._reply('issueStopwatchChanged', {
              instanceId: instance.id,
              owner,
              repo,
              index,
              action: 'delete',
              cancelled: true,
            });
            return;
          }
        }
        try {
          const client = new ForgejoClient(instance.url, instance.token, logger, instance.syncApiUrlsToInstanceUrl);
          let action: 'start' | 'stop' | 'delete';
          if (message.command === 'startIssueStopwatch') {
            action = 'start';
            await client.startIssueStopwatch(owner, repo, index);
          } else if (message.command === 'stopIssueStopwatch') {
            action = 'stop';
            await client.stopIssueStopwatch(owner, repo, index);
          } else {
            action = 'delete';
            await client.deleteIssueStopwatch(owner, repo, index);
          }
          this._reply('issueStopwatchChanged', {
            instanceId: instance.id,
            owner,
            repo,
            index,
            action,
          });
        } catch (error) {
          const err = userFacingErrorMessage(error);
          logger.error(`${message.command} failed for ${instance.name}/${owner}/${repo}#${index}: ${err}`);
          this._reply('issueStopwatchChanged', {
            instanceId: message.instanceId,
            owner,
            repo,
            index,
            action: 'start',
            error: err,
          });
        }
        return;
      }
      case 'getUserStopwatches': {
        const instance = this._findInstance(message.instanceId);
        if (!instance) {
          return;
        }
        try {
          const client = new ForgejoClient(instance.url, instance.token, logger, instance.syncApiUrlsToInstanceUrl);
          const stopwatches = await client.getUserStopWatches();
          this._reply('userStopwatches', {
            instanceId: instance.id,
            stopwatches,
          });
        } catch (error) {
          const err = userFacingErrorMessage(error);
          logger.error(`getUserStopWatches failed for ${instance.name}: ${err}`);
          this._reply('userStopwatches', {
            instanceId: message.instanceId,
            error: err,
          });
        }
        return;
      }
      case 'getIssueTrackedTimes': {
        const instance = this._findInstance(message.instanceId);
        if (!instance) {
          return;
        }
        const { owner, repo, index } = message;
        if (typeof owner !== 'string' || typeof repo !== 'string' || typeof index !== 'number') {
          return;
        }
        try {
          const client = new ForgejoClient(instance.url, instance.token, logger, instance.syncApiUrlsToInstanceUrl);
          const times = await client.listIssueTrackedTimes(owner, repo, index);
          this._reply('issueTrackedTimes', {
            instanceId: instance.id,
            owner,
            repo,
            index,
            times,
          });
        } catch (error) {
          const err = userFacingErrorMessage(error);
          logger.error(`getIssueTrackedTimes failed for ${instance.name}/${owner}/${repo}#${index}: ${err}`);
          this._reply('issueTrackedTimes', {
            instanceId: message.instanceId,
            owner,
            repo,
            index,
            error: err,
          });
        }
        return;
      }
      case 'addIssueTime': {
        const instance = this._findInstance(message.instanceId);
        if (!instance) {
          return;
        }
        const { owner, repo, index, time } = message;
        if (
          typeof owner !== 'string' ||
          typeof repo !== 'string' ||
          typeof index !== 'number' ||
          typeof time !== 'number'
        ) {
          return;
        }
        try {
          const client = new ForgejoClient(instance.url, instance.token, logger, instance.syncApiUrlsToInstanceUrl);
          const trackedTime = await client.addIssueTime(owner, repo, index, time);
          this._reply('issueTimeAdded', {
            instanceId: instance.id,
            owner,
            repo,
            index,
            time: trackedTime,
          });
        } catch (error) {
          const err = userFacingErrorMessage(error);
          logger.error(`addIssueTime failed for ${instance.name}/${owner}/${repo}#${index}: ${err}`);
          this._reply('issueTimeAdded', {
            instanceId: message.instanceId,
            owner,
            repo,
            index,
            error: err,
          });
        }
        return;
      }
      case 'resetIssueTime': {
        const instance = this._findInstance(message.instanceId);
        if (!instance) {
          return;
        }
        const { owner, repo, index } = message;
        if (typeof owner !== 'string' || typeof repo !== 'string' || typeof index !== 'number') {
          return;
        }
        // The same host-enforced confirmation as the single-entry
        // deleteIssueTime below: DELETE .../times drops every tracked-time
        // entry of the issue at once, which is strictly more destructive than
        // the confirmed single-entry delete. The webview must not add its own
        // prompt (that would double-prompt).
        if (
          !(await this._confirmDestructive(
            vscode.l10n.t(
              'Delete all tracked time entries for issue #{0} in {1}? This cannot be undone.',
              index,
              confirmInstanceScope(instance, owner, repo),
            ),
          ))
        ) {
          this._reply('issueTimeReset', { instanceId: instance.id, owner, repo, index, cancelled: true });
          return;
        }
        try {
          const client = new ForgejoClient(instance.url, instance.token, logger, instance.syncApiUrlsToInstanceUrl);
          await client.resetIssueTime(owner, repo, index);
          this._reply('issueTimeReset', {
            instanceId: instance.id,
            owner,
            repo,
            index,
          });
        } catch (error) {
          const err = userFacingErrorMessage(error);
          logger.error(`resetIssueTime failed for ${instance.name}/${owner}/${repo}#${index}: ${err}`);
          this._reply('issueTimeReset', {
            instanceId: message.instanceId,
            owner,
            repo,
            index,
            error: err,
          });
        }
        return;
      }
      case 'deleteIssueTime': {
        const instance = this._findInstance(message.instanceId);
        if (!instance) {
          return;
        }
        const { owner, repo, index, id } = message;
        if (
          typeof owner !== 'string' ||
          typeof repo !== 'string' ||
          typeof index !== 'number' ||
          typeof id !== 'number'
        ) {
          return;
        }
        if (
          !(await this._confirmDestructive(
            vscode.l10n.t('Delete this tracked time entry in {0}?', confirmInstanceScope(instance, owner, repo)),
          ))
        ) {
          this._reply('issueTimeDeleted', { instanceId: instance.id, owner, repo, index, id, cancelled: true });
          return;
        }
        try {
          const client = new ForgejoClient(instance.url, instance.token, logger, instance.syncApiUrlsToInstanceUrl);
          await client.deleteIssueTime(owner, repo, index, id);
          this._reply('issueTimeDeleted', {
            instanceId: instance.id,
            owner,
            repo,
            index,
            id,
          });
        } catch (error) {
          const err = userFacingErrorMessage(error);
          logger.error(`deleteIssueTime failed for ${instance.name}/${owner}/${repo}#${index}: ${err}`);
          this._reply('issueTimeDeleted', {
            instanceId: message.instanceId,
            owner,
            repo,
            index,
            id,
            error: err,
          });
        }
        return;
      }
      case 'getIssueDependencies': {
        const instance = this._findInstance(message.instanceId);
        if (!instance) {
          return;
        }
        const { owner, repo, index } = message;
        if (typeof owner !== 'string' || typeof repo !== 'string' || typeof index !== 'number') {
          return;
        }
        try {
          const client = new ForgejoClient(instance.url, instance.token, logger, instance.syncApiUrlsToInstanceUrl);
          const dependencies = await client.listIssueDependencies(owner, repo, index);
          this._reply('issueDependencies', {
            instanceId: instance.id,
            owner,
            repo,
            index,
            dependencies,
          });
        } catch (error) {
          const err = userFacingErrorMessage(error);
          logger.error(`getIssueDependencies failed for ${instance.name}/${owner}/${repo}#${index}: ${err}`);
          this._reply('issueDependencies', {
            instanceId: message.instanceId,
            owner,
            repo,
            index,
            error: err,
          });
        }
        return;
      }
      case 'createIssueDependency':
      case 'removeIssueDependency': {
        const instance = this._findInstance(message.instanceId);
        if (!instance) {
          return;
        }
        const { owner, repo, index, dependencyIndex } = message;
        if (
          typeof owner !== 'string' ||
          typeof repo !== 'string' ||
          typeof index !== 'number' ||
          typeof dependencyIndex !== 'number'
        ) {
          return;
        }
        // Only removal is destructive; creation needs no confirmation.
        if (
          message.command === 'removeIssueDependency' &&
          !(await this._confirmDestructive(
            vscode.l10n.t(
              'Remove the dependency on #{0} for issue #{1} in {2}?',
              dependencyIndex,
              index,
              confirmInstanceScope(instance, owner, repo),
            ),
          ))
        ) {
          this._reply('issueDependencyChanged', {
            instanceId: instance.id,
            owner,
            repo,
            index,
            dependencyIndex,
            action: 'remove',
            cancelled: true,
          });
          return;
        }
        try {
          const client = new ForgejoClient(instance.url, instance.token, logger, instance.syncApiUrlsToInstanceUrl);
          const action = message.command === 'createIssueDependency' ? ('add' as const) : ('remove' as const);
          if (message.command === 'createIssueDependency') {
            await client.createIssueDependency(owner, repo, index, dependencyIndex);
          } else {
            await client.removeIssueDependency(owner, repo, index, dependencyIndex);
          }
          this._reply('issueDependencyChanged', {
            instanceId: instance.id,
            owner,
            repo,
            index,
            dependencyIndex,
            action,
          });
        } catch (error) {
          const err = userFacingErrorMessage(error);
          logger.error(`${message.command} failed for ${instance.name}/${owner}/${repo}#${index}: ${err}`);
          this._reply('issueDependencyChanged', {
            instanceId: message.instanceId,
            owner,
            repo,
            index,
            dependencyIndex,
            action: 'add',
            error: err,
          });
        }
        return;
      }
      case 'getIssueReactions': {
        const instance = this._findInstance(message.instanceId);
        if (!instance) {
          return;
        }
        const { owner, repo, index } = message;
        if (typeof owner !== 'string' || typeof repo !== 'string' || typeof index !== 'number') {
          return;
        }
        try {
          const client = new ForgejoClient(instance.url, instance.token, logger, instance.syncApiUrlsToInstanceUrl);
          const reactions = await client.getIssueReactions(owner, repo, index);
          this._reply('issueReactions', {
            instanceId: instance.id,
            owner,
            repo,
            index,
            reactions,
          });
        } catch (error) {
          const err = userFacingErrorMessage(error);
          logger.error(`getIssueReactions failed for ${instance.name}/${owner}/${repo}#${index}: ${err}`);
          this._reply('issueReactions', {
            instanceId: message.instanceId,
            owner,
            repo,
            index,
            error: err,
          });
        }
        return;
      }
      case 'changeIssueReaction': {
        const instance = this._findInstance(message.instanceId);
        if (!instance) {
          return;
        }
        const { owner, repo, index, content, add } = message;
        if (
          typeof owner !== 'string' ||
          typeof repo !== 'string' ||
          typeof index !== 'number' ||
          typeof content !== 'string'
        ) {
          return;
        }
        try {
          const client = new ForgejoClient(instance.url, instance.token, logger, instance.syncApiUrlsToInstanceUrl);
          if (add) {
            await client.addIssueReaction(owner, repo, index, content);
          } else {
            await client.removeIssueReaction(owner, repo, index, content);
          }
          this._reply('issueReactionChanged', {
            instanceId: instance.id,
            owner,
            repo,
            index,
            content,
            action: add ? 'add' : 'remove',
          });
        } catch (error) {
          const err = userFacingErrorMessage(error);
          logger.error(`changeIssueReaction failed for ${instance.name}/${owner}/${repo}#${index}: ${err}`);
          this._reply('issueReactionChanged', {
            instanceId: message.instanceId,
            owner,
            repo,
            index,
            content,
            action: 'add',
            error: err,
          });
        }
        return;
      }
      case 'getCommentReactions': {
        const instance = this._findInstance(message.instanceId);
        if (!instance) {
          return;
        }
        const { owner, repo, commentId } = message;
        if (typeof owner !== 'string' || typeof repo !== 'string' || typeof commentId !== 'number') {
          return;
        }
        try {
          const client = new ForgejoClient(instance.url, instance.token, logger, instance.syncApiUrlsToInstanceUrl);
          const reactions = await client.getCommentReactions(owner, repo, commentId);
          this._reply('commentReactions', {
            instanceId: instance.id,
            owner,
            repo,
            commentId,
            reactions,
          });
        } catch (error) {
          const err = userFacingErrorMessage(error);
          logger.error(
            `getCommentReactions failed for ${instance.name}/${owner}/${repo}/comments/${commentId}: ${err}`,
          );
          this._reply('commentReactions', {
            instanceId: message.instanceId,
            owner,
            repo,
            commentId,
            error: err,
          });
        }
        return;
      }
      case 'changeCommentReaction': {
        const instance = this._findInstance(message.instanceId);
        if (!instance) {
          return;
        }
        const { owner, repo, commentId, content, add } = message;
        if (
          typeof owner !== 'string' ||
          typeof repo !== 'string' ||
          typeof commentId !== 'number' ||
          typeof content !== 'string'
        ) {
          return;
        }
        try {
          const client = new ForgejoClient(instance.url, instance.token, logger, instance.syncApiUrlsToInstanceUrl);
          if (add) {
            await client.addCommentReaction(owner, repo, commentId, content);
          } else {
            await client.removeCommentReaction(owner, repo, commentId, content);
          }
          this._reply('commentReactionChanged', {
            instanceId: instance.id,
            owner,
            repo,
            commentId,
            content,
            action: add ? 'add' : 'remove',
          });
        } catch (error) {
          const err = userFacingErrorMessage(error);
          logger.error(
            `changeCommentReaction failed for ${instance.name}/${owner}/${repo}/comments/${commentId}: ${err}`,
          );
          this._reply('commentReactionChanged', {
            instanceId: message.instanceId,
            owner,
            repo,
            commentId,
            content,
            action: 'add',
            error: err,
          });
        }
        return;
      }
      case 'createIssueComment': {
        const instance = this._findInstance(message.instanceId);
        if (!instance) {
          return;
        }
        const { owner, repo, index, body } = message;
        if (
          typeof owner !== 'string' ||
          typeof repo !== 'string' ||
          typeof index !== 'number' ||
          typeof body !== 'string'
        ) {
          return;
        }
        try {
          const client = new ForgejoClient(instance.url, instance.token, logger, instance.syncApiUrlsToInstanceUrl);
          const comment = await client.createIssueComment(owner, repo, index, body);
          this._reply('issueCommentCreated', {
            instanceId: instance.id,
            owner,
            repo,
            index,
            comment,
            _requestId: message._requestId,
          });
        } catch (error) {
          const err = userFacingErrorMessage(error);
          logger.error(`createIssueComment failed for ${instance.name}/${owner}/${repo}#${index}: ${err}`);
          this._reply('issueCommentCreated', {
            instanceId: message.instanceId,
            owner,
            repo,
            index,
            error: err,
            _requestId: message._requestId,
          });
        }
        return;
      }
      case 'createIssueCommentAttachment': {
        const instance = this._findInstance(message.instanceId);
        if (!instance) {
          return;
        }
        const { owner, repo, index, commentId, name, data } = message;
        if (
          typeof owner !== 'string' ||
          typeof repo !== 'string' ||
          typeof index !== 'number' ||
          typeof commentId !== 'number' ||
          typeof name !== 'string' ||
          !Array.isArray(data)
        ) {
          return;
        }
        try {
          const client = new ForgejoClient(instance.url, instance.token, logger, instance.syncApiUrlsToInstanceUrl);
          const attachment = await client.createIssueCommentAttachment(
            owner,
            repo,
            commentId,
            new Uint8Array(data),
            name,
          );
          this._reply('issueCommentAttachmentCreated', {
            instanceId: instance.id,
            owner,
            repo,
            index,
            commentId,
            id: attachment.id,
            uuid: attachment.uuid,
            name: attachment.name,
            size: attachment.size,
            browser_download_url: attachment.browser_download_url,
            _requestId: message._requestId,
          });
        } catch (error) {
          const err = userFacingErrorMessage(error);
          logger.error(
            `createIssueCommentAttachment failed for ${instance.name}/${owner}/${repo}/comments/${commentId}: ${err}`,
          );
          this._reply('issueCommentAttachmentCreated', {
            instanceId: message.instanceId,
            owner,
            repo,
            index,
            commentId,
            error: err,
            _requestId: message._requestId,
          });
        }
        return;
      }
      case 'editIssueComment': {
        const instance = this._findInstance(message.instanceId);
        if (!instance) {
          return;
        }
        const { owner, repo, commentId, body } = message;
        if (
          typeof owner !== 'string' ||
          typeof repo !== 'string' ||
          typeof commentId !== 'number' ||
          typeof body !== 'string'
        ) {
          return;
        }
        try {
          const client = new ForgejoClient(instance.url, instance.token, logger, instance.syncApiUrlsToInstanceUrl);
          const comment = await client.editIssueComment(owner, repo, commentId, body);
          this._reply('issueCommentEdited', {
            instanceId: instance.id,
            owner,
            repo,
            commentId,
            comment,
          });
        } catch (error) {
          const err = userFacingErrorMessage(error);
          logger.error(`editIssueComment failed for ${instance.name}/${owner}/${repo}/comments/${commentId}: ${err}`);
          this._reply('issueCommentEdited', {
            instanceId: message.instanceId,
            owner,
            repo,
            commentId,
            error: err,
          });
        }
        return;
      }
      case 'deleteIssueComment': {
        const instance = this._findInstance(message.instanceId);
        if (!instance) {
          return;
        }
        const { owner, repo, commentId } = message;
        if (typeof owner !== 'string' || typeof repo !== 'string' || typeof commentId !== 'number') {
          return;
        }
        if (
          !(await this._confirmDestructive(
            vscode.l10n.t('Delete comment #{0} in {1}?', commentId, confirmInstanceScope(instance, owner, repo)),
          ))
        ) {
          this._reply('issueCommentDeleted', { instanceId: instance.id, owner, repo, commentId, cancelled: true });
          return;
        }
        try {
          const client = new ForgejoClient(instance.url, instance.token, logger, instance.syncApiUrlsToInstanceUrl);
          await client.deleteIssueComment(owner, repo, commentId);
          this._reply('issueCommentDeleted', {
            instanceId: instance.id,
            owner,
            repo,
            commentId,
          });
        } catch (error) {
          const err = userFacingErrorMessage(error);
          logger.error(`deleteIssueComment failed for ${instance.name}/${owner}/${repo}/comments/${commentId}: ${err}`);
          this._reply('issueCommentDeleted', {
            instanceId: message.instanceId,
            owner,
            repo,
            commentId,
            error: err,
          });
        }
        return;
      }
      case 'deleteIssueCommentAttachment': {
        const instance = this._findInstance(message.instanceId);
        if (!instance) {
          return;
        }
        const { owner, repo, commentId, attachmentId } = message;
        if (
          typeof owner !== 'string' ||
          typeof repo !== 'string' ||
          typeof commentId !== 'number' ||
          typeof attachmentId !== 'number'
        ) {
          return;
        }
        if (
          !(await this._confirmDestructive(
            vscode.l10n.t(
              'Delete attachment #{0} of comment #{1} in {2}?',
              attachmentId,
              commentId,
              confirmInstanceScope(instance, owner, repo),
            ),
          ))
        ) {
          this._reply('issueCommentAttachmentDeleted', {
            instanceId: instance.id,
            owner,
            repo,
            commentId,
            attachmentId,
            cancelled: true,
            _requestId: message._requestId,
          });
          return;
        }
        try {
          const client = new ForgejoClient(instance.url, instance.token, logger, instance.syncApiUrlsToInstanceUrl);
          await client.deleteIssueCommentAttachment(owner, repo, commentId, attachmentId);
          this._reply('issueCommentAttachmentDeleted', {
            instanceId: instance.id,
            owner,
            repo,
            commentId,
            attachmentId,
            _requestId: message._requestId,
          });
        } catch (error) {
          const err = userFacingErrorMessage(error);
          logger.error(
            `deleteIssueCommentAttachment failed for ${instance.name}/${owner}/${repo}/comments/${commentId}/assets/${attachmentId}: ${err}`,
          );
          this._reply('issueCommentAttachmentDeleted', {
            instanceId: message.instanceId,
            owner,
            repo,
            commentId,
            attachmentId,
            error: err,
            _requestId: message._requestId,
          });
        }
        return;
      }
      case 'mergePullRequest': {
        const instance = this._findInstance(message.instanceId);
        if (!instance) {
          return;
        }
        const { owner, repo, index, strategy } = message;
        if (
          typeof owner !== 'string' ||
          typeof repo !== 'string' ||
          typeof index !== 'number' ||
          !['merge', 'rebase', 'squash'].includes(strategy)
        ) {
          return;
        }
        // Double-click/double-submit guard: a rapid second merge for the same
        // PR reuses the in-flight run instead of issuing the merge API call
        // twice (the second call would fail or merge twice). The reused run
        // replies only once, but the reply is keyed by PR coordinates, which
        // is exactly the webview's loading key, so the late trigger's spinner
        // clears with it.
        await this._prMutationInFlight.run(`merge:${instance.id}:${owner}/${repo}#${index}`, async () => {
          // The confirmation lives inside the guard: a second click landing
          // while the dialog is open reuses this run, so the user is never
          // prompted — nor merged — twice.
          if (
            !(await this._confirmDestructive(
              vscode.l10n.t(
                'Merge pull request #{0} in {1} using "{2}"? This cannot be undone.',
                index,
                confirmInstanceScope(instance, owner, repo),
                mergeStrategyLabel(strategy as 'merge' | 'rebase' | 'squash'),
              ),
            ))
          ) {
            this._reply('pullRequestMerged', { instanceId: instance.id, owner, repo, index, cancelled: true });
            return;
          }
          try {
            const client = new ForgejoClient(instance.url, instance.token, logger, instance.syncApiUrlsToInstanceUrl);
            await client.mergePullRequest(owner, repo, index, strategy);
            this._reply('pullRequestMerged', {
              instanceId: instance.id,
              owner,
              repo,
              index,
            });
            this.onPullRequestsChanged?.();
          } catch (error) {
            const err = userFacingErrorMessage(error);
            logger.error(`mergePullRequest failed for ${instance.name}/${owner}/${repo}#${index}: ${err}`);
            this._reply('pullRequestMerged', {
              instanceId: message.instanceId,
              owner,
              repo,
              index,
              error: err,
            });
          }
        });
        return;
      }
      case 'revertMergeCommit': {
        const instance = this._findInstance(message.instanceId);
        if (!instance) {
          return;
        }
        const { owner, repo, index } = message;
        if (typeof owner !== 'string' || typeof repo !== 'string' || typeof index !== 'number') {
          return;
        }
        // Same double-click guard as mergePullRequest (see above): the `revert:`
        // prefix keeps it a separate in-flight entry so a revert racing a merge
        // of the same PR is not silently dropped.
        await this._prMutationInFlight.run(`revert:${instance.id}:${owner}/${repo}#${index}`, async () => {
          if (
            !(await this._confirmDestructive(
              vscode.l10n.t(
                'Revert the merge commit of pull request #{0} in {1}? This will create a new commit on the base branch.',
                index,
                confirmInstanceScope(instance, owner, repo),
              ),
            ))
          ) {
            this._reply('revertMergeCommitResult', { instanceId: instance.id, owner, repo, index, cancelled: true });
            return;
          }
          try {
            const client = new ForgejoClient(instance.url, instance.token, logger, instance.syncApiUrlsToInstanceUrl);
            const pr = await client.getPullRequestDetail(owner, repo, index);
            if (!pr.merged) {
              throw new Error(vscode.l10n.t('Pull request {0}/{1}#{2} is not merged', owner, repo, index));
            }
            if (!pr.merge_commit_sha) {
              throw new Error(
                vscode.l10n.t('Pull request {0}/{1}#{2} does not have a recorded merge commit', owner, repo, index),
              );
            }
            const localRepo = await findLocalRepo(instance.url, owner, repo);
            if (!localRepo) {
              throw new Error(vscode.l10n.t('No local repository found for {0}/{1}', owner, repo));
            }
            await revertMergeCommit(localRepo, pr.merge_commit_sha, pr.base?.ref, instance.token, instance.url, {
              owner,
              repo,
            });
            this._reply('revertMergeCommitResult', {
              instanceId: instance.id,
              owner,
              repo,
              index,
              success: true,
            });
          } catch (error) {
            const err = userFacingErrorMessage(error);
            logger.error(`revertMergeCommit failed for ${instance.name}/${owner}/${repo}#${index}: ${err}`);
            // `revertMergeCommit` reports the state it left behind in its own
            // message (the local revert is undone on failure). This only covers
            // a failure that happened outside its cleanup — e.g. the API call or
            // the local-repository lookup failing after a manual `git revert`
            // left the repository mid-revert — so the user is never told a
            // success for a revert that never happened, nor left wondering why
            // the repository is in a revert state.
            const localRepo = await findLocalRepo(instance.url, owner, repo).catch(() => undefined);
            const midRevert =
              localRepo !== undefined &&
              (await isRevertInProgress(localRepo).catch(() => false)) &&
              !err.includes('git revert --abort');
            this._reply('revertMergeCommitResult', {
              instanceId: message.instanceId,
              owner,
              repo,
              index,
              error: midRevert
                ? vscode.l10n.t(
                    '{0}. The repository is still in the middle of the revert, so nothing was reverted or pushed; run "git revert --abort" in the local repository to undo it.',
                    err,
                  )
                : err,
            });
          }
        });
        return;
      }
      case 'createIssueAttachment': {
        const instance = this._findInstance(message.instanceId);
        if (!instance) {
          return;
        }
        const { owner, repo, index, name, data } = message;
        if (
          typeof owner !== 'string' ||
          typeof repo !== 'string' ||
          typeof index !== 'number' ||
          typeof name !== 'string' ||
          !Array.isArray(data)
        ) {
          return;
        }
        try {
          const client = new ForgejoClient(instance.url, instance.token, logger, instance.syncApiUrlsToInstanceUrl);
          const attachment = await client.createIssueAttachment(owner, repo, index, new Uint8Array(data), name);
          this._reply('issueAttachmentCreated', {
            instanceId: instance.id,
            owner,
            repo,
            index,
            // The numeric id is what the delete command needs; without it an
            // attachment uploaded into the editor could not be removed again.
            id: attachment.id,
            uuid: attachment.uuid,
            name: attachment.name,
            size: attachment.size,
            browser_download_url: attachment.browser_download_url,
            _requestId: message._requestId,
          });
        } catch (error) {
          const err = userFacingErrorMessage(error);
          logger.error(`createIssueAttachment failed for ${instance.name}/${owner}/${repo}#${index}: ${err}`);
          this._reply('issueAttachmentCreated', {
            instanceId: message.instanceId,
            owner,
            repo,
            index,
            error: err,
            _requestId: message._requestId,
          });
        }
        return;
      }
      case 'deleteIssueAttachment': {
        const instance = this._findInstance(message.instanceId);
        if (!instance) {
          return;
        }
        const { owner, repo, index, attachmentId } = message;
        if (
          typeof owner !== 'string' ||
          typeof repo !== 'string' ||
          typeof index !== 'number' ||
          typeof attachmentId !== 'number'
        ) {
          return;
        }
        if (
          !(await this._confirmDestructive(
            vscode.l10n.t(
              'Delete attachment #{0} of issue #{1} in {2}?',
              attachmentId,
              index,
              confirmInstanceScope(instance, owner, repo),
            ),
          ))
        ) {
          this._reply('issueAttachmentDeleted', {
            instanceId: instance.id,
            owner,
            repo,
            index,
            attachmentId,
            cancelled: true,
            _requestId: message._requestId,
          });
          return;
        }
        try {
          const client = new ForgejoClient(instance.url, instance.token, logger, instance.syncApiUrlsToInstanceUrl);
          await client.deleteIssueAttachment(owner, repo, index, attachmentId);
          this._reply('issueAttachmentDeleted', {
            instanceId: instance.id,
            owner,
            repo,
            index,
            attachmentId,
            _requestId: message._requestId,
          });
        } catch (error) {
          const err = userFacingErrorMessage(error);
          logger.error(`deleteIssueAttachment failed for ${instance.name}/${owner}/${repo}#${index}: ${err}`);
          this._reply('issueAttachmentDeleted', {
            instanceId: message.instanceId,
            owner,
            repo,
            index,
            attachmentId,
            error: err,
            _requestId: message._requestId,
          });
        }
        return;
      }
      case 'getPullRequestDetail': {
        const instance = this._findInstance(message.instanceId);
        if (!instance) {
          return;
        }
        const { owner, repo, index } = message;
        if (typeof owner !== 'string' || typeof repo !== 'string' || typeof index !== 'number') {
          return;
        }
        try {
          const client = new ForgejoClient(instance.url, instance.token, logger, instance.syncApiUrlsToInstanceUrl);
          const detail = await client.getPullRequestDetail(owner, repo, index);
          this._reply('pullRequestDetail', {
            instanceId: instance.id,
            owner,
            repo,
            index,
            detail,
          });
        } catch (error) {
          const err = userFacingErrorMessage(error);
          logger.error(`getPullRequestDetail failed for ${instance.name}/${owner}/${repo}#${index}: ${err}`);
          this._reply('pullRequestDetail', {
            instanceId: message.instanceId,
            owner,
            repo,
            index,
            error: err,
          });
        }
        return;
      }
      case 'createPullRequest': {
        const instance = this._findInstance(message.instanceId);
        if (!instance) {
          return;
        }
        const { owner, repo, data } = message;
        if (typeof owner !== 'string' || typeof repo !== 'string' || !data || typeof data.title !== 'string') {
          return;
        }
        try {
          const client = new ForgejoClient(instance.url, instance.token, logger, instance.syncApiUrlsToInstanceUrl);
          const item = await client.createPullRequest(owner, repo, data);
          this._reply('pullRequestCreated', {
            instanceId: instance.id,
            owner,
            repo,
            index: (item as { number?: number }).number ?? 0,
            item,
            _requestId: message._requestId,
          });
          this.onPullRequestsChanged?.();
        } catch (error) {
          const err = userFacingErrorMessage(error);
          logger.error(`createPullRequest failed for ${instance.name}/${owner}/${repo}: ${err}`);
          this._reply('pullRequestCreated', {
            instanceId: message.instanceId,
            owner,
            repo,
            index: 0,
            error: err,
            _requestId: message._requestId,
          });
        }
        return;
      }
      case 'editPullRequest': {
        const instance = this._findInstance(message.instanceId);
        if (!instance) {
          return;
        }
        const { owner, repo, index, data } = message;
        if (typeof owner !== 'string' || typeof repo !== 'string' || typeof index !== 'number' || !data) {
          return;
        }
        try {
          const client = new ForgejoClient(instance.url, instance.token, logger, instance.syncApiUrlsToInstanceUrl);
          const { state_toggle: stateToggle, due_date_update: dueDateUpdate, ...prData } = data;
          const item = await client.editPullRequest(owner, repo, index, prData);
          this._reply('pullRequestUpdated', {
            instanceId: instance.id,
            owner,
            repo,
            index,
            item,
            ...(stateToggle ? { stateToggle: true } : {}),
            ...(dueDateUpdate ? { dueDateUpdate: true } : {}),
          });
          // Closing (or reopening) a PR changes the status bar's open-PR lookup.
          if (data.state) {
            this.onPullRequestsChanged?.();
          }
        } catch (error) {
          const err = userFacingErrorMessage(error);
          logger.error(`editPullRequest failed for ${instance.name}/${owner}/${repo}#${index}: ${err}`);
          this._reply('pullRequestUpdated', {
            instanceId: message.instanceId,
            owner,
            repo,
            index,
            error: err,
            ...(data.state_toggle ? { stateToggle: true } : {}),
            ...(data.due_date_update ? { dueDateUpdate: true } : {}),
          });
        }
        return;
      }
      case 'getPullRequestFiles': {
        const instance = this._findInstance(message.instanceId);
        if (!instance) {
          return;
        }
        const { owner, repo, index, baseSha, headSha } = message;
        if (typeof owner !== 'string' || typeof repo !== 'string' || typeof index !== 'number') {
          return;
        }
        try {
          const client = new ForgejoClient(instance.url, instance.token, logger, instance.syncApiUrlsToInstanceUrl);
          let files: ForgejoChangedFile[];
          if (typeof baseSha === 'string' && typeof headSha === 'string') {
            try {
              files = await client.getPullRequestFilesFromCompare(owner, repo, baseSha, headSha);
              logger.info(
                `getPullRequestFilesFromCompare returned ${files.length} files for ${instance.name}/${owner}/${repo}#${index}`,
              );
            } catch (compareError) {
              const compareErr = compareError instanceof Error ? compareError.message : String(compareError);
              logger.info(
                `Falling back to JSON file list for ${instance.name}/${owner}/${repo}#${index}: ${compareErr}`,
              );
              files = await client.getPullRequestFiles(owner, repo, index);
            }
          } else {
            files = await client.getPullRequestFiles(owner, repo, index);
          }

          // Supplement additions/deletions counts from the JSON endpoint.
          try {
            const jsonFiles = await client.getPullRequestFiles(owner, repo, index);
            const countMap = new Map(jsonFiles.map((f) => [f.filename, f]));
            files = files.map((file) => {
              const counts = countMap.get(file.filename);
              if (!counts) {
                return file;
              }
              return {
                ...file,
                additions: counts.additions ?? file.additions,
                deletions: counts.deletions ?? file.deletions,
                changes: counts.changes ?? (counts.additions ?? 0) + (counts.deletions ?? 0),
              };
            });
          } catch (error) {
            // counts are optional
            logger.debug(
              `getPullRequestFiles count supplement failed for ${owner}/${repo}#${index}: ${userFacingErrorMessage(error)}`,
            );
          }

          logger.info(
            `getPullRequestFiles returned ${files.length} files for ${instance.name}/${owner}/${repo}#${index}: ${JSON.stringify(files.map((f) => ({ filename: f.filename, status: f.status, additions: f.additions, deletions: f.deletions })))}`,
          );
          this._reply('pullRequestFiles', {
            instanceId: instance.id,
            owner,
            repo,
            index,
            baseSha,
            headSha,
            files,
          });
        } catch (error) {
          const err = userFacingErrorMessage(error);
          logger.error(`getPullRequestFiles failed for ${instance.name}/${owner}/${repo}#${index}: ${err}`);
          this._reply('pullRequestFiles', {
            instanceId: message.instanceId,
            owner,
            repo,
            index,
            baseSha,
            headSha,
            error: err,
          });
        }
        return;
      }
      case 'getPullRequestCommentsAndTimeline': {
        const instance = this._findInstance(message.instanceId);
        if (!instance) {
          return;
        }
        const { owner, repo, index } = message;
        if (typeof owner !== 'string' || typeof repo !== 'string' || typeof index !== 'number') {
          return;
        }
        try {
          const client = new ForgejoClient(instance.url, instance.token, logger, instance.syncApiUrlsToInstanceUrl);
          const comments = await client.getPullRequestCommentsAndTimeline(owner, repo, index);
          this._reply('pullRequestCommentsAndTimeline', {
            instanceId: instance.id,
            owner,
            repo,
            index,
            comments,
          });
        } catch (error) {
          const err = userFacingErrorMessage(error);
          logger.error(
            `getPullRequestCommentsAndTimeline failed for ${instance.name}/${owner}/${repo}#${index}: ${err}`,
          );
          this._reply('pullRequestCommentsAndTimeline', {
            instanceId: message.instanceId,
            owner,
            repo,
            index,
            error: err,
          });
        }
        return;
      }
      case 'getPullRequestCommits': {
        const instance = this._findInstance(message.instanceId);
        if (!instance) {
          return;
        }
        const { owner, repo, index } = message;
        if (typeof owner !== 'string' || typeof repo !== 'string' || typeof index !== 'number') {
          return;
        }
        try {
          const client = new ForgejoClient(instance.url, instance.token, logger, instance.syncApiUrlsToInstanceUrl);
          const commits = await client.getPullRequestCommits(owner, repo, index);
          this._reply('pullRequestCommits', {
            instanceId: instance.id,
            owner,
            repo,
            index,
            commits,
          });
        } catch (error) {
          const err = userFacingErrorMessage(error);
          logger.error(`getPullRequestCommits failed for ${instance.name}/${owner}/${repo}#${index}: ${err}`);
          this._reply('pullRequestCommits', {
            instanceId: message.instanceId,
            owner,
            repo,
            index,
            error: err,
          });
        }
        return;
      }
      case 'openPullRequestDiff': {
        const { instanceId, owner, repo, index, filename, status, previousFilename, baseSha, headSha } = message;
        if (
          typeof instanceId !== 'string' ||
          typeof owner !== 'string' ||
          typeof repo !== 'string' ||
          typeof index !== 'number' ||
          typeof filename !== 'string' ||
          typeof status !== 'string' ||
          typeof baseSha !== 'string' ||
          typeof headSha !== 'string'
        ) {
          return;
        }
        try {
          // A renamed file only exists under its old path at the base ref.
          const basePath = status === 'renamed' && previousFilename ? previousFilename : filename;
          const baseUri = this._buildDiffUri(instanceId, owner, repo, index, baseSha, basePath, true, status);
          const headUri = this._buildDiffUri(instanceId, owner, repo, index, headSha, filename, false, status);
          const title = `${filename} (#${index})`;
          await vscode.commands.executeCommand('vscode.diff', baseUri, headUri, title);
          if (status === 'added') {
            vscode.window.showInformationMessage(
              vscode.l10n.t('This file was added in the pull request: {0}', filename),
            );
          } else if (status === 'removed') {
            vscode.window.showInformationMessage(
              vscode.l10n.t('This file was removed in the pull request: {0}', filename),
            );
          }
        } catch (error) {
          const err = userFacingErrorMessage(error);
          logger.error(`openPullRequestDiff failed for ${owner}/${repo}#${index} ${filename}: ${err}`);
          vscode.window.showErrorMessage(vscode.l10n.t('Unable to open diff: {0}', err));
        }
        return;
      }
      case 'openSelectedPullRequestDiffs': {
        const { instanceId, owner, repo, index, files, baseSha, headSha } = message;
        if (
          typeof instanceId !== 'string' ||
          typeof owner !== 'string' ||
          typeof repo !== 'string' ||
          typeof index !== 'number' ||
          !Array.isArray(files) ||
          typeof baseSha !== 'string' ||
          typeof headSha !== 'string'
        ) {
          return;
        }
        try {
          const resourceList = files.map((file) => {
            const filename = typeof file === 'string' ? file : file.filename;
            const status = typeof file === 'string' ? 'modified' : file.status;
            // A renamed file only exists under its old path at the base ref.
            const previousFilename = typeof file === 'string' ? undefined : file.previous_filename;
            const basePath = status === 'renamed' && previousFilename ? previousFilename : filename;
            const baseUri = this._buildDiffUri(instanceId, owner, repo, index, baseSha, basePath, true, status);
            const headUri = this._buildDiffUri(instanceId, owner, repo, index, headSha, filename, false, status);
            if (status === 'added') {
              return [headUri, undefined, headUri];
            }
            if (status === 'removed') {
              return [baseUri, baseUri, undefined];
            }
            return [headUri, baseUri, headUri];
          });
          const title = `${owner}/${repo}#${index}`;
          await vscode.commands.executeCommand('vscode.changes', title, resourceList);
          const addedCount = files.filter((file) =>
            typeof file === 'string' ? false : file.status === 'added',
          ).length;
          const removedCount = files.filter((file) =>
            typeof file === 'string' ? false : file.status === 'removed',
          ).length;
          if (addedCount > 0 && removedCount > 0) {
            vscode.window.showInformationMessage(
              vscode.l10n.t('Opening {0} added and {1} removed files from the pull request', addedCount, removedCount),
            );
          } else if (addedCount > 0) {
            vscode.window.showInformationMessage(
              vscode.l10n.t('Opening {0} added files from the pull request', addedCount),
            );
          } else if (removedCount > 0) {
            vscode.window.showInformationMessage(
              vscode.l10n.t('Opening {0} removed files from the pull request', removedCount),
            );
          }
        } catch (error) {
          const err = userFacingErrorMessage(error);
          logger.error(`openSelectedPullRequestDiffs failed for ${owner}/${repo}#${index}: ${err}`);
          vscode.window.showErrorMessage(vscode.l10n.t('Unable to open selected diffs: {0}', err));
        }
        return;
      }
      case 'getRepoIssues': {
        const instance = this._findInstance(message.instanceId);
        if (!instance) {
          return;
        }
        const { owner, repo } = message;
        if (typeof owner !== 'string' || typeof repo !== 'string') {
          return;
        }
        try {
          const client = new ForgejoClient(instance.url, instance.token, logger, instance.syncApiUrlsToInstanceUrl);
          const issues = await client.getRepoIssues(owner, repo, message.state ?? 'open', message.query);
          this._reply('repoIssues', {
            instanceId: instance.id,
            owner,
            repo,
            state: message.state ?? 'open',
            query: message.query,
            issues,
          });
        } catch (error) {
          const err = userFacingErrorMessage(error);
          logger.error(`getRepoIssues failed for ${instance.name}/${owner}/${repo}: ${err}`);
          this._reply('repoIssues', {
            instanceId: message.instanceId,
            owner,
            repo,
            state: message.state ?? 'open',
            query: message.query,
            error: err,
          });
        }
        return;
      }
      case 'getRepoLabels': {
        const instance = this._findInstance(message.instanceId);
        if (!instance) {
          return;
        }
        const { owner, repo } = message;
        if (typeof owner !== 'string' || typeof repo !== 'string') {
          return;
        }
        try {
          const client = new ForgejoClient(instance.url, instance.token, logger, instance.syncApiUrlsToInstanceUrl);
          const labels = await client.getRepoLabels(owner, repo);
          this._reply('repoLabels', { instanceId: instance.id, owner, repo, labels });
        } catch (error) {
          const err = userFacingErrorMessage(error);
          logger.error(`getRepoLabels failed for ${instance.name}/${owner}/${repo}: ${err}`);
          this._reply('repoLabels', { instanceId: message.instanceId, owner, repo, error: err });
        }
        return;
      }
      case 'getRepoAssignees': {
        const instance = this._findInstance(message.instanceId);
        if (!instance) {
          return;
        }
        const { owner, repo } = message;
        if (typeof owner !== 'string' || typeof repo !== 'string') {
          return;
        }
        try {
          const client = new ForgejoClient(instance.url, instance.token, logger, instance.syncApiUrlsToInstanceUrl);
          const assignees = await client.getRepoAssignees(owner, repo);
          this._reply('repoAssignees', { instanceId: instance.id, owner, repo, assignees });
        } catch (error) {
          const err = userFacingErrorMessage(error);
          logger.error(`getRepoAssignees failed for ${instance.name}/${owner}/${repo}: ${err}`);
          this._reply('repoAssignees', { instanceId: message.instanceId, owner, repo, error: err });
        }
        return;
      }
      case 'getRepoMilestones': {
        const instance = this._findInstance(message.instanceId);
        if (!instance) {
          return;
        }
        const { owner, repo } = message;
        if (typeof owner !== 'string' || typeof repo !== 'string') {
          return;
        }
        try {
          const client = new ForgejoClient(instance.url, instance.token, logger, instance.syncApiUrlsToInstanceUrl);
          const milestones = await client.getRepoMilestones(owner, repo);
          this._reply('repoMilestones', { instanceId: instance.id, owner, repo, milestones });
        } catch (error) {
          const err = userFacingErrorMessage(error);
          logger.error(`getRepoMilestones failed for ${instance.name}/${owner}/${repo}: ${err}`);
          this._reply('repoMilestones', { instanceId: message.instanceId, owner, repo, error: err });
        }
        return;
      }
      case 'searchMentions': {
        const instance = this._findInstance(message.instanceId);
        if (!instance) {
          return;
        }
        const { owner, repo, query, type, _requestId } = message;
        if (
          typeof owner !== 'string' ||
          typeof repo !== 'string' ||
          typeof query !== 'string' ||
          typeof _requestId !== 'string'
        ) {
          return;
        }
        try {
          const client = new ForgejoClient(instance.url, instance.token, logger, instance.syncApiUrlsToInstanceUrl);
          const result = await client.searchMentions(owner, repo, query, type as 'user' | 'issue' | 'all');
          this._reply('mentionSearchResult', { _requestId, users: result.users, issues: result.issues });
        } catch (error) {
          const err = userFacingErrorMessage(error);
          logger.error(`searchMentions failed for ${instance.name}/${owner}/${repo}: ${err}`);
          this._reply('mentionSearchResult', { _requestId, error: err });
        }
        return;
      }
      case 'getUserPreview': {
        const instance = this._findInstance(message.instanceId);
        if (!instance) {
          return;
        }
        const { username, _requestId } = message;
        // `username` is interpolated into `/users/${username}`: without this the
        // host would issue an arbitrary authenticated GET for a forged value and
        // hand the body back to the webview.
        if (!isSafeRepoNameSegment(username) || typeof _requestId !== 'string') {
          return;
        }
        try {
          const client = new ForgejoClient(instance.url, instance.token, logger, instance.syncApiUrlsToInstanceUrl);
          const user = await client.getUserPreview(username);
          this._reply('userPreviewResult', { _requestId, user });
        } catch (error) {
          const err = userFacingErrorMessage(error);
          logger.error(`getUserPreview failed for ${instance.name}/${username}: ${err}`);
          this._reply('userPreviewResult', { _requestId, error: err });
        }
        return;
      }
      case 'getIssuePreview': {
        const instance = this._findInstance(message.instanceId);
        if (!instance) {
          return;
        }
        const { owner, repo, index, _requestId } = message;
        if (
          typeof owner !== 'string' ||
          typeof repo !== 'string' ||
          typeof index !== 'number' ||
          typeof _requestId !== 'string'
        ) {
          return;
        }
        try {
          const client = new ForgejoClient(instance.url, instance.token, logger, instance.syncApiUrlsToInstanceUrl);
          const issue = await client.getIssuePreview(owner, repo, index);
          this._reply('issuePreviewResult', { _requestId, issue });
        } catch (error) {
          const err = userFacingErrorMessage(error);
          logger.error(`getIssuePreview failed for ${instance.name}/${owner}/${repo}/${index}: ${err}`);
          this._reply('issuePreviewResult', { _requestId, error: err });
        }
        return;
      }
      case 'getRepoPullRequests': {
        const instance = this._findInstance(message.instanceId);
        if (!instance) {
          return;
        }
        const { owner, repo } = message;
        if (typeof owner !== 'string' || typeof repo !== 'string') {
          return;
        }
        try {
          const client = new ForgejoClient(instance.url, instance.token, logger, instance.syncApiUrlsToInstanceUrl);
          const pullRequests = await client.getRepoPullRequests(owner, repo, message.state ?? 'open', message.query);
          this._reply('repoPullRequests', {
            instanceId: instance.id,
            owner,
            repo,
            state: message.state ?? 'open',
            query: message.query,
            pullRequests,
          });
        } catch (error) {
          const err = userFacingErrorMessage(error);
          logger.error(`getRepoPullRequests failed for ${instance.name}/${owner}/${repo}: ${err}`);
          this._reply('repoPullRequests', {
            instanceId: message.instanceId,
            owner,
            repo,
            state: message.state ?? 'open',
            query: message.query,
            error: err,
          });
        }
        return;
      }
      case 'getActionRuns': {
        const instance = this._findInstance(message.instanceId);
        if (!instance) {
          return;
        }
        const { owner, repo } = message;
        if (typeof owner !== 'string' || typeof repo !== 'string') {
          // The runs view clears its loading gate only on an `actionRuns`
          // reply, and this message carries no `_requestId`.
          this._replyResultShapedError(message, 'actionRuns', vscode.l10n.t('The request could not be completed'));
          return;
        }
        const page = typeof message.page === 'number' ? message.page : 1;
        const limit = typeof message.limit === 'number' ? message.limit : 30;
        try {
          const client = new ForgejoClient(instance.url, instance.token, logger, instance.syncApiUrlsToInstanceUrl);
          const result = await client.listActionRuns(owner, repo, page, limit);
          this._reply('actionRuns', {
            instanceId: instance.id,
            owner,
            repo,
            page,
            actionRuns: result.workflow_runs ?? [],
            totalCount: result.total_count ?? 0,
          });
        } catch (error) {
          const err = userFacingErrorMessage(error);
          logger.error(`getActionRuns failed for ${instance.name}/${owner}/${repo}: ${err}`);
          this._reply('actionRuns', {
            instanceId: message.instanceId,
            owner,
            repo,
            page: typeof message.page === 'number' ? message.page : 1,
            error: err,
          });
        }
        return;
      }
      case 'getActionRun': {
        const instance = this._findInstance(message.instanceId);
        if (!instance) {
          return;
        }
        const { owner, repo, runId } = message;
        if (typeof owner !== 'string' || typeof repo !== 'string' || typeof runId !== 'number') {
          // The detail view clears its loading gate only on an `actionRun`
          // reply, and this message carries no `_requestId`.
          this._replyResultShapedError(message, 'actionRun', vscode.l10n.t('The request could not be completed'));
          return;
        }
        try {
          const client = new ForgejoClient(instance.url, instance.token, logger, instance.syncApiUrlsToInstanceUrl);
          const run = await client.getActionRun(owner, repo, runId);
          this._reply('actionRun', {
            instanceId: instance.id,
            owner,
            repo,
            runId,
            run,
          });
        } catch (error) {
          const err = userFacingErrorMessage(error);
          logger.error(`getActionRun failed for ${instance.name}/${owner}/${repo}/${runId}: ${err}`);
          this._reply('actionRun', { instanceId: message.instanceId, owner, repo, runId, error: err });
        }
        return;
      }
      case 'getActionRunJobs': {
        const instance = this._findInstance(message.instanceId);
        if (!instance) {
          return;
        }
        const { owner, repo, runId } = message;
        if (typeof owner !== 'string' || typeof repo !== 'string' || typeof runId !== 'number') {
          // The jobs list clears its loading gate only on an `actionRunJobs`
          // reply, and this message carries no `_requestId`.
          this._replyResultShapedError(message, 'actionRunJobs', vscode.l10n.t('The request could not be completed'));
          return;
        }
        try {
          const client = new ForgejoClient(instance.url, instance.token, logger, instance.syncApiUrlsToInstanceUrl);
          const jobs = await client.getActionRunJobs(owner, repo, runId);
          this._reply('actionRunJobs', {
            instanceId: instance.id,
            owner,
            repo,
            runId,
            jobs,
          });
        } catch (error) {
          const err = userFacingErrorMessage(error);
          logger.error(`getActionRunJobs failed for ${instance.name}/${owner}/${repo}/${runId}: ${err}`);
          this._reply('actionRunJobs', { instanceId: message.instanceId, owner, repo, runId, error: err });
        }
        return;
      }
      case 'getActionRunArtifacts': {
        const instance = this._findInstance(message.instanceId);
        if (!instance) {
          return;
        }
        const { owner, repo, runId } = message;
        if (typeof owner !== 'string' || typeof repo !== 'string' || typeof runId !== 'number') {
          // The artifacts list clears its loading gate only on an
          // `actionRunArtifacts` reply, and this message carries no
          // `_requestId`.
          this._replyResultShapedError(
            message,
            'actionRunArtifacts',
            vscode.l10n.t('The request could not be completed'),
          );
          return;
        }
        try {
          const client = new ForgejoClient(instance.url, instance.token, logger, instance.syncApiUrlsToInstanceUrl);
          const artifacts = await client.getActionRunArtifacts(owner, repo, runId);
          this._reply('actionRunArtifacts', {
            instanceId: instance.id,
            owner,
            repo,
            runId,
            artifacts,
          });
        } catch (error) {
          const err = userFacingErrorMessage(error);
          logger.error(`getActionRunArtifacts failed for ${instance.name}/${owner}/${repo}/${runId}: ${err}`);
          this._reply('actionRunArtifacts', { instanceId: message.instanceId, owner, repo, runId, error: err });
        }
        return;
      }
      case 'getActionJobLog': {
        const instance = this._findInstance(message.instanceId);
        if (!instance) {
          return;
        }
        const { owner, repo, jobId } = message;
        if (typeof owner !== 'string' || typeof repo !== 'string' || typeof jobId !== 'number') {
          // The log view clears its loading gate only on an `actionJobLog`
          // reply, and this message carries no `_requestId`.
          this._replyResultShapedError(message, 'actionJobLog', vscode.l10n.t('The request could not be completed'));
          return;
        }
        try {
          const client = new ForgejoClient(instance.url, instance.token, logger, instance.syncApiUrlsToInstanceUrl);
          const log = await client.getActionJobLog(owner, repo, jobId);
          this._reply('actionJobLog', {
            instanceId: instance.id,
            owner,
            repo,
            jobId,
            log,
          });
        } catch (error) {
          const err = userFacingErrorMessage(error);
          logger.error(`getActionJobLog failed for ${instance.name}/${owner}/${repo}/jobs/${jobId}: ${err}`);
          this._reply('actionJobLog', { instanceId: message.instanceId, owner, repo, jobId, error: err });
        }
        return;
      }
      case 'dispatchWorkflow': {
        const instance = this._findInstance(message.instanceId);
        if (!instance) {
          return;
        }
        const { owner, repo, workflowfilename, ref, inputs } = message;
        if (
          typeof owner !== 'string' ||
          typeof repo !== 'string' ||
          typeof workflowfilename !== 'string' ||
          typeof ref !== 'string'
        ) {
          return;
        }
        if (
          !(await this._confirmDestructive(
            vscode.l10n.t(
              'Run workflow "{0}" on ref "{1}" in {2}?',
              workflowfilename,
              ref,
              confirmInstanceScope(instance, owner, repo),
            ),
          ))
        ) {
          this._reply('actionRunDispatched', {
            instanceId: instance.id,
            owner,
            repo,
            workflowfilename,
            cancelled: true,
          });
          return;
        }
        try {
          const client = new ForgejoClient(instance.url, instance.token, logger, instance.syncApiUrlsToInstanceUrl);
          const run = await client.dispatchWorkflow(
            owner,
            repo,
            workflowfilename,
            ref,
            inputs && typeof inputs === 'object' ? (inputs as Record<string, string>) : undefined,
          );
          this._reply('actionRunDispatched', {
            instanceId: instance.id,
            owner,
            repo,
            workflowfilename,
            accepted: true,
            run,
          });
        } catch (error) {
          const err = userFacingErrorMessage(error);
          logger.error(`dispatchWorkflow failed for ${instance.name}/${owner}/${repo}/${workflowfilename}: ${err}`);
          this._reply('actionRunDispatched', {
            instanceId: message.instanceId,
            owner,
            repo,
            workflowfilename,
            error: err,
          });
        }
        return;
      }
      case 'cancelActionRun': {
        const instance = this._findInstance(message.instanceId);
        if (!instance) {
          return;
        }
        const { owner, repo, runId } = message;
        if (typeof owner !== 'string' || typeof repo !== 'string' || typeof runId !== 'number') {
          return;
        }
        if (
          !(await this._confirmDestructive(
            vscode.l10n.t(
              'Cancel run #{0} in {1}? In-progress jobs will be stopped.',
              runId,
              confirmInstanceScope(instance, owner, repo),
            ),
          ))
        ) {
          this._reply('actionRunCancelled', { instanceId: instance.id, owner, repo, runId, cancelled: true });
          return;
        }
        try {
          const client = new ForgejoClient(instance.url, instance.token, logger, instance.syncApiUrlsToInstanceUrl);
          await client.cancelActionRun(owner, repo, runId);
          this._reply('actionRunCancelled', {
            instanceId: instance.id,
            owner,
            repo,
            runId,
            success: true,
          });
        } catch (error) {
          const err = userFacingErrorMessage(error);
          logger.error(`cancelActionRun failed for ${instance.name}/${owner}/${repo}/${runId}: ${err}`);
          this._reply('actionRunCancelled', {
            instanceId: message.instanceId,
            owner,
            repo,
            runId,
            error: err,
          });
        }
        return;
      }
      case 'deleteActionRun': {
        const instance = this._findInstance(message.instanceId);
        if (!instance) {
          return;
        }
        const { owner, repo, runId } = message;
        if (typeof owner !== 'string' || typeof repo !== 'string' || typeof runId !== 'number') {
          return;
        }
        if (
          !(await this._confirmDestructive(
            vscode.l10n.t(
              'Delete run #{0} in {1}? This cannot be undone.',
              runId,
              confirmInstanceScope(instance, owner, repo),
            ),
          ))
        ) {
          this._reply('actionRunDeleted', { instanceId: instance.id, owner, repo, runId, cancelled: true });
          return;
        }
        try {
          const client = new ForgejoClient(instance.url, instance.token, logger, instance.syncApiUrlsToInstanceUrl);
          await client.deleteActionRun(owner, repo, runId);
          this._reply('actionRunDeleted', {
            instanceId: instance.id,
            owner,
            repo,
            runId,
            success: true,
          });
        } catch (error) {
          const err = userFacingErrorMessage(error);
          logger.error(`deleteActionRun failed for ${instance.name}/${owner}/${repo}/${runId}: ${err}`);
          this._reply('actionRunDeleted', {
            instanceId: message.instanceId,
            owner,
            repo,
            runId,
            error: err,
          });
        }
        return;
      }
      case 'downloadActionArtifact': {
        const instance = this._findInstance(message.instanceId);
        if (!instance) {
          return;
        }
        const { owner, repo, artifactId, name } = message;
        if (
          typeof owner !== 'string' ||
          typeof repo !== 'string' ||
          typeof artifactId !== 'number' ||
          typeof name !== 'string'
        ) {
          return;
        }
        try {
          // The artifact name is webview-supplied and lands in the save
          // dialog's default path: without stripping any directory part a
          // hostile name (`../../.ssh/authorized_keys` or `/etc/cron.d/x`)
          // would pre-fill an arbitrary location and one Enter would write
          // there. Taking the last segment of either separator (rather than
          // `path.basename`, whose treatment of `\` is platform-dependent)
          // leaves only the file name; the `.zip` extension the filter expects
          // is preserved.
          const safeName = name.split(/[\\/]/).pop() || `artifact-${artifactId}.zip`;
          const defaultName = safeName.endsWith('.zip') ? safeName : `${safeName}.zip`;
          const uri = await vscode.window.showSaveDialog({
            defaultUri: vscode.Uri.file(defaultName),
            filters: { 'ZIP Archive': ['zip'] },
          });
          if (!uri) {
            this._reply('actionArtifactDownloaded', {
              instanceId: message.instanceId,
              owner,
              repo,
              artifactId,
              cancelled: true,
            });
            return;
          }
          const client = new ForgejoClient(instance.url, instance.token, logger, instance.syncApiUrlsToInstanceUrl);
          // The artifact streams straight to disk (no 50 MB memory cap), so
          // report progress while it downloads.
          await vscode.window.withProgress(
            {
              location: vscode.ProgressLocation.Notification,
              title: vscode.l10n.t('Downloading artifact {0}…', defaultName),
            },
            (progress) =>
              client.downloadActionArtifactToFile(owner, repo, artifactId, uri.fsPath, (bytesWritten) => {
                progress.report({
                  message: vscode.l10n.t('{0} MB downloaded', (bytesWritten / (1024 * 1024)).toFixed(1)),
                });
              }),
          );
          this._reply('actionArtifactDownloaded', {
            instanceId: instance.id,
            owner,
            repo,
            artifactId,
            path: uri.fsPath,
          });
        } catch (error) {
          const err = userFacingErrorMessage(error);
          logger.error(`downloadActionArtifact failed for ${instance.name}/${owner}/${repo}/${artifactId}: ${err}`);
          this._reply('actionArtifactDownloaded', {
            instanceId: message.instanceId,
            owner,
            repo,
            artifactId,
            error: err,
          });
        }
        return;
      }
      case 'renderMarkdown': {
        const { text, _requestId } = message;
        const instance = this._findInstance(message.instanceId);
        // Early returns are safe for requests carrying a _requestId: the
        // dispatch wrapper answers them with a generic requestError.
        if (!instance || typeof text !== 'string' || typeof _requestId !== 'string') {
          return;
        }
        try {
          const client = new ForgejoClient(instance.url, instance.token, logger, instance.syncApiUrlsToInstanceUrl);
          const html = await client.renderMarkdown(text, message.context);
          const htmlWithResolvedImages = await resolveAttachmentImages(html, instance);
          this._reply('renderedMarkdown', { _requestId, html: htmlWithResolvedImages });
        } catch (error) {
          const err = userFacingErrorMessage(error);
          logger.error(`renderMarkdown failed for ${instance.name}: ${err}`);
          this._reply('renderedMarkdown', { _requestId, error: err });
        }
        return;
      }
      case 'getRepoContents': {
        const instance = this._findInstance(message.instanceId);
        if (!instance) {
          return;
        }
        const { owner, repo, path, ref } = message;
        if (
          typeof owner !== 'string' ||
          typeof repo !== 'string' ||
          // The path is interpolated into the contents route; a `..` segment would
          // let the URL parser walk out of it and reach another API endpoint.
          !isSafeRepoPath(path) ||
          typeof ref !== 'string'
        ) {
          // The file browser keys its loading gate on the identity it sent and
          // only a `repoContents` reply clears it. This message carries no
          // `_requestId`, so the dispatch fallback cannot answer it: reply with
          // the same shape as the error path below instead of dropping it.
          // The fields are echoed verbatim (not normalized) because the loader
          // keys its gate on the raw values: `RepoDetail.vue` forwards an
          // unnormalised `default_branch`, so a missing `ref` arrives as
          // `undefined` and a `''` substitute would clear a different key.
          this._replyResultShapedError(message, 'repoContents', vscode.l10n.t('The request could not be completed'));
          return;
        }
        try {
          const client = new ForgejoClient(instance.url, instance.token, logger, instance.syncApiUrlsToInstanceUrl);
          const rawEntries = await client.getRepoContents(owner, repo, path, ref || undefined);
          // Forgejo omits the payload of files above `[api] DEFAULT_MAX_BLOB_SIZE`
          // (10 MiB by default) and reports the real size instead, which the file browser
          // and the README preview would render as an empty document. Serve the same
          // localized explanation the PR diff provider uses.
          const entries = rawEntries.map((entry) => {
            const notice = entry.content ? undefined : missingPayloadNotice(entry.size);
            return notice ? { ...entry, content: Buffer.from(`${notice}\n`).toString('base64') } : entry;
          });
          logger.debug(
            `getRepoContents returned ${entries.length} entries for ${instance.name}/${owner}/${repo}/${path}@${ref}: ${JSON.stringify(entries.map((e) => ({ name: e.name, path: e.path, type: e.type })))}`,
          );
          this._reply('repoContents', {
            instanceId: instance.id,
            owner,
            repo,
            ref,
            path,
            entries,
          });
        } catch (error) {
          const err = userFacingErrorMessage(error);
          logger.error(`getRepoContents failed for ${instance.name}/${owner}/${repo}/${path}: ${err}`);
          this._reply('repoContents', {
            instanceId: message.instanceId,
            owner,
            repo,
            ref,
            path,
            error: err,
          });
        }
        return;
      }
      case 'openRepoFile': {
        const { instanceId, owner, repo, path, ref } = message;
        if (
          typeof instanceId !== 'string' ||
          typeof owner !== 'string' ||
          typeof repo !== 'string' ||
          !isSafeRepoPath(path) ||
          typeof ref !== 'string'
        ) {
          // This message carries no `_requestId`, so the dispatch fallback
          // cannot answer it; the handler's error contract is a visible message
          // rather than a reply.
          vscode.window.showErrorMessage(vscode.l10n.t('The request could not be completed'));
          return;
        }
        try {
          const uri = buildRepoFileUri({ instanceId, owner, repo, ref, path });
          await vscode.commands.executeCommand('vscode.open', uri, { preview: false });
        } catch (error) {
          const err = userFacingErrorMessage(error);
          logger.error(`openRepoFile failed for ${owner}/${repo}/${path}: ${err}`);
          vscode.window.showErrorMessage(vscode.l10n.t('Unable to open file: {0}', err));
        }
        return;
      }
      case 'searchRepoFiles': {
        const instance = this._findInstance(message.instanceId);
        if (!instance) {
          return;
        }
        const { owner, repo, ref, query } = message;
        if (
          typeof owner !== 'string' ||
          typeof repo !== 'string' ||
          typeof ref !== 'string' ||
          typeof query !== 'string'
        ) {
          // The file-search view only clears its loading gate on a
          // `repoFilesSearchResult` reply and this message carries no
          // `_requestId`, so the dispatch fallback cannot answer it.
          this._replyResultShapedError(
            message,
            'repoFilesSearchResult',
            vscode.l10n.t('The request could not be completed'),
          );
          return;
        }
        try {
          const client = new ForgejoClient(instance.url, instance.token, logger, instance.syncApiUrlsToInstanceUrl);
          const { files, truncated } = await client.searchRepoFiles(owner, repo, ref, query);
          if (truncated) {
            // The tree could not be read completely, so the search may be
            // missing matches: the webview says so instead of implying that a
            // file does not exist.
            logger.info(`searchRepoFiles for ${owner}/${repo}@${ref} ran over a truncated tree`);
          }
          this._reply('repoFilesSearchResult', {
            instanceId: instance.id,
            owner,
            repo,
            ref,
            query,
            files,
            truncated,
          });
        } catch (error) {
          const err = userFacingErrorMessage(error);
          logger.error(`searchRepoFiles failed for ${owner}/${repo}@${ref}: ${err}`);
          this._reply('repoFilesSearchResult', {
            instanceId: message.instanceId,
            owner,
            repo,
            ref,
            query,
            error: err,
          });
        }
        return;
      }
      case 'getFileHistory': {
        const instance = this._findInstance(message.instanceId);
        if (!instance) {
          return;
        }
        const { owner, repo, path, ref } = message;
        if (typeof owner !== 'string' || typeof repo !== 'string' || !isSafeRepoPath(path) || typeof ref !== 'string') {
          // Same reasoning as getRepoContents: the history view only clears its
          // loading gate on a `fileHistory` reply and this message carries no
          // `_requestId` for the dispatch fallback to answer. The fields are
          // echoed verbatim so the reply lands on the key the loader set, even
          // when `ref`/`path` are missing.
          this._replyResultShapedError(message, 'fileHistory', vscode.l10n.t('The request could not be completed'));
          return;
        }
        try {
          const client = new ForgejoClient(instance.url, instance.token, logger, instance.syncApiUrlsToInstanceUrl);
          const commits = await client.getFileHistory(owner, repo, path, ref);
          this._reply('fileHistory', {
            instanceId: instance.id,
            owner,
            repo,
            path,
            ref,
            commits,
          });
        } catch (error) {
          const err = userFacingErrorMessage(error);
          logger.error(`getFileHistory failed for ${owner}/${repo}/${path}@${ref}: ${err}`);
          this._reply('fileHistory', {
            instanceId: message.instanceId,
            owner,
            repo,
            path,
            ref,
            error: err,
          });
        }
        return;
      }
      case 'openRepoFileDiff': {
        const { instanceId, owner, repo, path, baseRef, headRef } = message;
        if (
          typeof instanceId !== 'string' ||
          typeof owner !== 'string' ||
          typeof repo !== 'string' ||
          !isSafeRepoPath(path) ||
          typeof baseRef !== 'string' ||
          typeof headRef !== 'string'
        ) {
          // Same reasoning as openRepoFile: no `_requestId` to answer, so the
          // rejection has to reach the user through the handler's own contract.
          vscode.window.showErrorMessage(vscode.l10n.t('The request could not be completed'));
          return;
        }
        try {
          const leftUri = buildRepoFileUri({ instanceId, owner, repo, ref: baseRef, path });
          const rightUri = buildRepoFileUri({ instanceId, owner, repo, ref: headRef, path });
          await vscode.commands.executeCommand('vscode.diff', leftUri, rightUri, `${path} (${baseRef}..${headRef})`);
        } catch (error) {
          const err = userFacingErrorMessage(error);
          logger.error(`openRepoFileDiff failed for ${owner}/${repo}/${path}: ${err}`);
          vscode.window.showErrorMessage(vscode.l10n.t('Unable to open diff: {0}', err));
        }
        return;
      }
      case 'getRepoRefs': {
        const { instanceId, owner, repo } = message;
        if (typeof instanceId !== 'string' || typeof owner !== 'string' || typeof repo !== 'string') {
          // The refs view only clears its loading gate on a `repoRefs` reply and
          // this message carries no `_requestId`, so the dispatch fallback
          // cannot answer it.
          this._replyResultShapedError(message, 'repoRefs', vscode.l10n.t('The request could not be completed'));
          return;
        }
        const instance = this._findInstance(instanceId);
        if (!instance) {
          return;
        }
        try {
          const client = new ForgejoClient(instance.url, instance.token, logger, instance.syncApiUrlsToInstanceUrl);
          const [branches, tags, releases] = await Promise.all([
            client.getRepoBranches(owner, repo),
            client.getRepoTags(owner, repo),
            client.getRepoReleases(owner, repo),
          ]);
          this._reply('repoRefs', { instanceId, owner, repo, branches, tags, releases });
        } catch (error) {
          const err = userFacingErrorMessage(error);
          logger.error(`getRepoRefs failed for ${owner}/${repo}: ${err}`);
          this._reply('repoRefs', { instanceId, owner, repo, error: err });
        }
        return;
      }
      case 'createRepoBranch': {
        const { instanceId, owner, repo, newBranchName, oldRefName } = message;
        if (
          typeof instanceId !== 'string' ||
          typeof owner !== 'string' ||
          typeof repo !== 'string' ||
          typeof newBranchName !== 'string'
        ) {
          return;
        }
        const instance = this._findInstance(instanceId);
        if (!instance) {
          return;
        }
        try {
          const client = new ForgejoClient(instance.url, instance.token, logger, instance.syncApiUrlsToInstanceUrl);
          const oldRef = typeof oldRefName === 'string' ? oldRefName : undefined;
          await client.createBranch(owner, repo, { new_branch_name: newBranchName, old_ref_name: oldRef });
          this._reply('repoBranchCreated', { instanceId, owner, repo, branch: newBranchName });
        } catch (error) {
          const err = userFacingErrorMessage(error);
          logger.error(`createRepoBranch failed for ${owner}/${repo}/${newBranchName}: ${err}`);
          this._reply('repoBranchCreated', { instanceId, owner, repo, branch: newBranchName, error: err });
        }
        return;
      }
      case 'deleteRepoBranch': {
        const { instanceId, owner, repo, branch } = message;
        if (
          typeof instanceId !== 'string' ||
          typeof owner !== 'string' ||
          typeof repo !== 'string' ||
          typeof branch !== 'string'
        ) {
          return;
        }
        const instance = this._findInstance(instanceId);
        if (!instance) {
          return;
        }
        if (
          !(await this._confirmDestructive(
            vscode.l10n.t('Delete branch "{0}" in {1}?', branch, confirmInstanceScope(instance, owner, repo)),
          ))
        ) {
          this._reply('repoBranchDeleted', { instanceId, owner, repo, branch, cancelled: true });
          return;
        }
        try {
          const client = new ForgejoClient(instance.url, instance.token, logger, instance.syncApiUrlsToInstanceUrl);
          await client.deleteBranch(owner, repo, branch);
          this._reply('repoBranchDeleted', { instanceId, owner, repo, branch });
        } catch (error) {
          const err = userFacingErrorMessage(error);
          logger.error(`deleteRepoBranch failed for ${owner}/${repo}/${branch}: ${err}`);
          this._reply('repoBranchDeleted', { instanceId, owner, repo, branch, error: err });
        }
        return;
      }
      case 'createRepoTag': {
        const { instanceId, owner, repo, tagName, target, message: tagMessage } = message;
        if (
          typeof instanceId !== 'string' ||
          typeof owner !== 'string' ||
          typeof repo !== 'string' ||
          typeof tagName !== 'string'
        ) {
          return;
        }
        const instance = this._findInstance(instanceId);
        if (!instance) {
          return;
        }
        try {
          const client = new ForgejoClient(instance.url, instance.token, logger, instance.syncApiUrlsToInstanceUrl);
          await client.createTag(owner, repo, {
            tag_name: tagName,
            target: typeof target === 'string' ? target : undefined,
            message: typeof tagMessage === 'string' ? tagMessage : undefined,
          });
          this._reply('repoTagCreated', { instanceId, owner, repo, tag: tagName });
        } catch (error) {
          const err = userFacingErrorMessage(error);
          logger.error(`createRepoTag failed for ${owner}/${repo}/${tagName}: ${err}`);
          this._reply('repoTagCreated', { instanceId, owner, repo, tag: tagName, error: err });
        }
        return;
      }
      case 'deleteRepoTag': {
        const { instanceId, owner, repo, tag } = message;
        if (
          typeof instanceId !== 'string' ||
          typeof owner !== 'string' ||
          typeof repo !== 'string' ||
          typeof tag !== 'string'
        ) {
          return;
        }
        const instance = this._findInstance(instanceId);
        if (!instance) {
          return;
        }
        if (
          !(await this._confirmDestructive(
            vscode.l10n.t('Delete tag "{0}" in {1}?', tag, confirmInstanceScope(instance, owner, repo)),
          ))
        ) {
          this._reply('repoTagDeleted', { instanceId, owner, repo, tag, cancelled: true });
          return;
        }
        try {
          const client = new ForgejoClient(instance.url, instance.token, logger, instance.syncApiUrlsToInstanceUrl);
          await client.deleteTag(owner, repo, tag);
          this._reply('repoTagDeleted', { instanceId, owner, repo, tag });
        } catch (error) {
          const err = userFacingErrorMessage(error);
          logger.error(`deleteRepoTag failed for ${owner}/${repo}/${tag}: ${err}`);
          this._reply('repoTagDeleted', { instanceId, owner, repo, tag, error: err });
        }
        return;
      }
      case 'createRepoRelease': {
        const {
          instanceId,
          owner,
          repo,
          tagName,
          name,
          body,
          targetCommitish,
          prerelease,
          draft,
          hideArchiveLinks,
          _requestId,
        } = message;
        if (
          typeof instanceId !== 'string' ||
          typeof owner !== 'string' ||
          typeof repo !== 'string' ||
          typeof tagName !== 'string' ||
          typeof _requestId !== 'string'
        ) {
          return;
        }
        const instance = this._findInstance(instanceId);
        if (!instance) {
          return;
        }
        try {
          const client = new ForgejoClient(instance.url, instance.token, logger, instance.syncApiUrlsToInstanceUrl);
          const release = await client.createRelease(owner, repo, {
            tag_name: tagName,
            name: typeof name === 'string' ? name : undefined,
            body: typeof body === 'string' ? body : undefined,
            target_commitish: typeof targetCommitish === 'string' ? targetCommitish : undefined,
            prerelease: typeof prerelease === 'boolean' ? prerelease : undefined,
            draft: typeof draft === 'boolean' ? draft : undefined,
            hide_archive_links: typeof hideArchiveLinks === 'boolean' ? hideArchiveLinks : undefined,
          });
          this._reply('repoReleaseCreated', {
            instanceId,
            owner,
            repo,
            release: tagName,
            item: release,
            _requestId,
          });
        } catch (error) {
          const err = userFacingErrorMessage(error);
          logger.error(`createRepoRelease failed for ${owner}/${repo}/${tagName}: ${err}`);
          this._reply('repoReleaseCreated', {
            instanceId,
            owner,
            repo,
            release: tagName,
            error: err,
            _requestId,
          });
        }
        return;
      }
      case 'deleteRepoRelease': {
        const { instanceId, owner, repo, id } = message;
        if (
          typeof instanceId !== 'string' ||
          typeof owner !== 'string' ||
          typeof repo !== 'string' ||
          typeof id !== 'number'
        ) {
          return;
        }
        const instance = this._findInstance(instanceId);
        if (!instance) {
          return;
        }
        if (
          !(await this._confirmDestructive(
            vscode.l10n.t('Delete release #{0} in {1}?', id, confirmInstanceScope(instance, owner, repo)),
          ))
        ) {
          this._reply('repoReleaseDeleted', { instanceId, owner, repo, release: String(id), cancelled: true });
          return;
        }
        try {
          const client = new ForgejoClient(instance.url, instance.token, logger, instance.syncApiUrlsToInstanceUrl);
          await client.deleteRelease(owner, repo, id);
          this._reply('repoReleaseDeleted', { instanceId, owner, repo, release: String(id) });
        } catch (error) {
          const err = userFacingErrorMessage(error);
          logger.error(`deleteRepoRelease failed for ${owner}/${repo}/${id}: ${err}`);
          this._reply('repoReleaseDeleted', { instanceId, owner, repo, release: String(id), error: err });
        }
        return;
      }
      case 'editRepoRelease': {
        const { instanceId, owner, repo, id, data } = message;
        if (
          typeof instanceId !== 'string' ||
          typeof owner !== 'string' ||
          typeof repo !== 'string' ||
          typeof id !== 'number' ||
          !data ||
          typeof data !== 'object'
        ) {
          return;
        }
        const instance = this._findInstance(instanceId);
        if (!instance) {
          return;
        }
        try {
          const client = new ForgejoClient(instance.url, instance.token, logger, instance.syncApiUrlsToInstanceUrl);
          await client.editRelease(owner, repo, id, {
            tag_name: typeof data.tag_name === 'string' ? data.tag_name : undefined,
            name: typeof data.name === 'string' ? data.name : undefined,
            body: typeof data.body === 'string' ? data.body : undefined,
            target_commitish: typeof data.target_commitish === 'string' ? data.target_commitish : undefined,
            prerelease: typeof data.prerelease === 'boolean' ? data.prerelease : undefined,
            draft: typeof data.draft === 'boolean' ? data.draft : undefined,
            hide_archive_links: typeof data.hide_archive_links === 'boolean' ? data.hide_archive_links : undefined,
          });
          this._reply('repoReleaseEdited', { instanceId, owner, repo, release: String(id) });
        } catch (error) {
          const err = userFacingErrorMessage(error);
          logger.error(`editRepoRelease failed for ${owner}/${repo}/${id}: ${err}`);
          this._reply('repoReleaseEdited', { instanceId, owner, repo, release: String(id), error: err });
        }
        return;
      }
      case 'createReleaseAttachment': {
        const { instanceId, owner, repo, id, name, data, _requestId } = message;
        if (
          typeof instanceId !== 'string' ||
          typeof owner !== 'string' ||
          typeof repo !== 'string' ||
          typeof id !== 'number' ||
          typeof name !== 'string' ||
          !Array.isArray(data) ||
          typeof _requestId !== 'string'
        ) {
          return;
        }
        const instance = this._findInstance(instanceId);
        if (!instance) {
          return;
        }
        try {
          const client = new ForgejoClient(instance.url, instance.token, logger, instance.syncApiUrlsToInstanceUrl);
          const file = new Uint8Array(data);
          const attachment = await client.createReleaseAttachment(owner, repo, id, file, name);
          this._reply('releaseAttachmentCreated', {
            instanceId,
            owner,
            repo,
            id,
            attachment,
            _requestId,
          });
        } catch (error) {
          const err = userFacingErrorMessage(error);
          logger.error(`createReleaseAttachment failed for ${owner}/${repo}/releases/${id}: ${err}`);
          this._reply('releaseAttachmentCreated', {
            instanceId,
            owner,
            repo,
            id,
            error: err,
            _requestId,
          });
        }
        return;
      }
      case 'deleteReleaseAttachment': {
        const { instanceId, owner, repo, id, attachmentId, _requestId } = message;
        if (
          typeof instanceId !== 'string' ||
          typeof owner !== 'string' ||
          typeof repo !== 'string' ||
          typeof id !== 'number' ||
          typeof attachmentId !== 'number' ||
          typeof _requestId !== 'string'
        ) {
          return;
        }
        const instance = this._findInstance(instanceId);
        if (!instance) {
          return;
        }
        if (
          !(await this._confirmDestructive(
            vscode.l10n.t(
              'Delete attachment #{0} of release #{1} in {2}?',
              attachmentId,
              id,
              confirmInstanceScope(instance, owner, repo),
            ),
          ))
        ) {
          this._reply('releaseAttachmentDeleted', {
            instanceId,
            owner,
            repo,
            id,
            attachmentId,
            cancelled: true,
            _requestId,
          });
          return;
        }
        try {
          const client = new ForgejoClient(instance.url, instance.token, logger, instance.syncApiUrlsToInstanceUrl);
          await client.deleteReleaseAttachment(owner, repo, id, attachmentId);
          this._reply('releaseAttachmentDeleted', {
            instanceId,
            owner,
            repo,
            id,
            attachmentId,
            _requestId,
          });
        } catch (error) {
          const err = userFacingErrorMessage(error);
          logger.error(`deleteReleaseAttachment failed for ${owner}/${repo}/releases/${id}/${attachmentId}: ${err}`);
          this._reply('releaseAttachmentDeleted', {
            instanceId,
            owner,
            repo,
            id,
            attachmentId,
            error: err,
            _requestId,
          });
        }
        return;
      }
      case 'showInputBox': {
        const { id, prompt, value, placeHolder } = message;
        if (typeof id !== 'string' || typeof prompt !== 'string') {
          return;
        }
        const result = await vscode.window.showInputBox({
          prompt,
          value: typeof value === 'string' ? value : undefined,
          placeHolder: typeof placeHolder === 'string' ? placeHolder : undefined,
          ignoreFocusOut: true,
        });
        this._reply('showInputBoxResult', { id, value: result ?? undefined, cancelled: result === undefined });
        return;
      }
      case 'showConfirm': {
        const { id, message: confirmMessage, confirmLabel } = message;
        if (typeof id !== 'string' || typeof confirmMessage !== 'string' || typeof confirmLabel !== 'string') {
          return;
        }
        const result = await vscode.window.showInformationMessage(confirmMessage, { modal: true }, confirmLabel);
        this._reply('showConfirmResult', { id, confirmed: result === confirmLabel });
        return;
      }
      case 'copyToClipboard': {
        const text = message.text;
        if (typeof text === 'string') {
          await vscode.env.clipboard.writeText(text);
          vscode.window.showInformationMessage(vscode.l10n.t('Copied to clipboard'));
        }
        return;
      }
      case 'previewReadme': {
        const { owner, repo, content, instanceId } = message;
        if (typeof owner === 'string' && typeof repo === 'string' && typeof content === 'string') {
          // The instance id keys the virtual document: two instances hosting the
          // same owner/repo must not share (and overwrite) one README document.
          openReadmePreview(
            this._readmeProvider,
            owner,
            repo,
            content,
            typeof instanceId === 'string' ? instanceId : undefined,
          );
        }
        return;
      }
      case 'openPrWorktree': {
        await this._handleOpenPrWorktree(message);
        return;
      }
      case 'startWorkOnIssue': {
        await this._handleStartWorkOnIssue(message);
        return;
      }
      case 'removeWorktree': {
        const { id } = message;
        if (typeof id === 'string') {
          // Double-click/double-submit guard, keyed on the same identity
          // dimension as openPrWorktree/startWorkOnIssue. The `remove:` prefix
          // keeps it a separate entry: InFlightTasks reuses the in-flight
          // promise, so sharing the exact open key would silently drop a
          // legitimate remove that races an open (and vice versa) without any
          // reply reaching the webview.
          const record = this._worktreeManager.getWorktree(id);
          const key = record
            ? record.kind === 'issue'
              ? `remove:start-work:${record.instanceId}:${record.owner}/${record.repo}#${record.prIndex}`
              : `remove:${record.instanceId}:${record.owner}/${record.repo}#${record.prIndex}`
            : `remove:${id}`;
          await this._worktreeInFlight.run(key, async () => {
            // Removing a worktree deletes the local directory and any work it
            // holds, so like every other destructive prompt it names its target.
            // The scope is data (instance name and owner/repo), composed around
            // the translated sentence; a missing instance record leaves the
            // prompt unscoped rather than blocking a local cleanup.
            const scope = record
              ? `${confirmInstanceScope(this._findInstance(record.instanceId) ?? { name: record.instanceId }, record.owner, record.repo)}: `
              : '';
            // The confirmation lives inside the guard (same reasoning as
            // mergePullRequest). The webview tracks no pending state for
            // removeWorktree, so a decline needs no reply: the record and
            // the worktrees list simply stay as they are.
            if (
              !(await this._confirmDestructive(
                `${scope}${vscode.l10n.t(
                  'Delete this worktree? The local directory will be permanently deleted (not moved to the recycle bin) and any uncommitted changes will be lost.',
                )}`,
              ))
            ) {
              return;
            }
            try {
              await this._worktreeManager.removeWorktree(id);
              this._reply('worktreeRemoved', { id });
            } catch (error) {
              // removeWorktree keeps the record on failure so the user can
              // retry; the error reaches the user exactly once, through this
              // worktreeError notification shown by the webview.
              const err = userFacingErrorMessage(error);
              const failedRecord = this._worktreeManager.getWorktree(id);
              this._reply('worktreeError', {
                error: err,
                operation: 'remove',
                instanceId: failedRecord?.instanceId,
                owner: failedRecord?.owner,
                repo: failedRecord?.repo,
                index: failedRecord?.prIndex,
              });
            }
            this._reply('worktreesList', { worktrees: this._worktreeManager.getWorktrees() });
          });
        }
        return;
      }
      case 'setWorktreeOpenMode': {
        const mode = message.mode;
        if (mode === 'ask' || mode === 'currentWindow' || mode === 'newWindow') {
          await this._config.setWorktreeOpenMode(mode);
          this._reply('worktreeOpenMode', { mode });
        }
        return;
      }
      case 'setWorktreeCacheDirectory': {
        const directory = message.directory;
        if (typeof directory === 'string') {
          if (!(await this._setWorktreeCacheDirectory(directory))) {
            return;
          }
          this._reply('worktreeCacheDirectory', {
            directory: this._config.getWorktreeCacheDirectory() ?? '',
            defaultDirectory: this._config.getDefaultWorktreeCacheDirectory(),
          });
        }
        return;
      }
      case 'browseWorktreeCacheDirectory': {
        const result = await vscode.window.showOpenDialog({
          canSelectFiles: false,
          canSelectFolders: true,
          canSelectMany: false,
          openLabel: vscode.l10n.t('Select Cache Directory'),
        });
        if (result && result.length > 0) {
          const directory = result[0].fsPath;
          if (!(await this._setWorktreeCacheDirectory(directory))) {
            return;
          }
          this._reply('worktreeCacheDirectory', {
            directory: this._config.getWorktreeCacheDirectory() ?? '',
            defaultDirectory: this._config.getDefaultWorktreeCacheDirectory(),
          });
        }
        return;
      }
      case 'openOnboardingPanel': {
        vscode.commands.executeCommand('forgejoToolkit.openOnboarding');
        return;
      }
    }
  }

  public openSettings() {
    this._revealView();
    this._postOrQueue({ command: 'openSettings' });
  }

  public openDashboard() {
    this._revealView();
    this._postOrQueue({ command: 'openDashboard' });
  }

  /**
   * Bring the sidebar view on screen before messaging it. Commands like
   * "Open Settings" used to silently no-op when the view had never been
   * resolved; focusing the view id forces VS Code to resolve it, and the
   * queued message reaches the webview once it mounts.
   */
  private _revealView() {
    if (this._view) {
      this._view.show(false);
    } else {
      void vscode.commands.executeCommand('forgejoToolkitView.focus');
    }
  }

  public openCreatePullRequest(payload: { instanceId: string; owner: string; repo: string; head: string }) {
    this._postOrQueue({ command: 'openCreatePullRequest', ...payload });
  }

  public openNewIssue(payload: { instanceId: string; owner: string; repo: string; title?: string; body?: string }) {
    this._postOrQueue({ command: 'openNewIssue', ...payload });
  }

  public openPullRequestDetail(payload: { instanceId: string; owner: string; repo: string; index: number }) {
    this._postOrQueue({ command: 'openPullRequestDetail', ...payload });
  }

  /** Lets the dashboard reload a PR detail after a review was submitted from the comment panel. */
  public notifyPullRequestReviewSubmitted(payload: { instanceId: string; owner: string; repo: string; index: number }) {
    this._postOrQueue({ command: 'pullRequestReviewSubmitted', ...payload });
  }

  private _postOrQueue(message: HostToWebviewMessage) {
    // When the sidebar has never been shown the webview does not exist yet;
    // queue the message and flush it once the webview mounts and asks for its
    // initial state (see the getInitialState handler). Multiple messages may
    // arrive before that, so this is a queue, not a single slot. The queue is
    // capped: if the sidebar is never resolved at all, an unbounded queue
    // would grow for the whole session — these messages are transient
    // notifications, so the oldest is dropped.
    if (this._view) {
      this._view.webview.postMessage(message);
    } else {
      if (this._pendingMessages.length >= ForgejoToolkitViewProvider.MAX_PENDING_MESSAGES) {
        this._pendingMessages.shift();
        logger.error('Pending webview message queue is full; dropped the oldest message');
      }
      this._pendingMessages.push(message);
    }
  }

  public refresh() {
    // Refresh is also the escape hatch for a repository that changed behind the
    // extension (a merge made elsewhere, a pushed commit): the tree and
    // contents memos have short TTLs but are shared process-wide, so their
    // entries must go before the webview re-reads anything.
    invalidateRepoContentCaches();
    this._sendInstances();
    // A just-published repository must drop the "Publish to Forgejo" button
    // (forgejoToolkit.hasUnpublishedRepo) without waiting for an editor
    // switch; debounced so a refresh burst does not spawn repeated git runs.
    this._scheduleLinkedRepositoryDetect();
    // Also tell the webview to invalidate its instance-level data caches —
    // previously this command only refreshed the instance list itself.
    this._reply('refreshData', {});
  }

  public updateTitle(locale: 'en' | 'zh') {
    this._updateViewTitle(locale);
  }

  private _findInstance(id: unknown): ForgejoInstance | undefined {
    if (typeof id !== 'string') {
      return undefined;
    }
    return this._config.getInstances().find((i) => i.id === id);
  }

  private _buildDiffUri(
    instanceId: string,
    owner: string,
    repo: string,
    index: number,
    ref: string,
    filepath: string,
    isBase: boolean,
    status?: string,
  ): vscode.Uri {
    const params = { index, ref, isBase, status };
    return vscode.Uri.from({
      scheme: 'forgejo-pr',
      path: `/${instanceId}/${owner}/${repo}/${filepath}`,
      query: JSON.stringify(params),
    });
  }

  private _updateViewTitle(locale: 'en' | 'zh') {
    if (!this._view) {
      return;
    }
    // The `locale` argument is kept because callers pass the selected locale
    // (the user's `forgejoToolkit.locale` can differ from the display
    // language); the text itself is resolved by l10n so the host has a single
    // source of truth for user-facing strings instead of a hard-coded zh/en
    // pair.
    void locale;
    this._view.title = vscode.l10n.t('Dashboard');
  }

  private _sendInstances() {
    if (this._view?.visible) {
      this._reply('instances', { data: this._config.getInstances().map(toPublicInstance) });
    }
  }

  /**
   * Mandatory host-side confirmation for destructive webview commands. The
   * webview is untrusted: a compromised webview could skip its own confirm
   * dialog, so the host always re-confirms before executing. Webview code
   * must not show its own confirmation for these commands — that would
   * double-prompt the user.
   */
  private async _confirmDestructive(message: string): Promise<boolean> {
    const confirmLabel = vscode.l10n.t('Confirm');
    const choice = await vscode.window.showWarningMessage(message, { modal: true }, confirmLabel);
    return choice === confirmLabel;
  }

  /**
   * Ask before discarding a leftover PR worktree that is no longer checked out
   * at the PR head. `git worktree remove --force` (plus the throwaway branch
   * delete) drops uncommitted changes and local commits, so those cases need
   * an explicit confirmation; a clean leftover is refreshed silently, since
   * recreating it is the only way to get the updated head and prompting every
   * time would be noise.
   */
  private async _confirmDiscardStaleWorktree(info: StalePrWorktreeInfo, index: number): Promise<boolean> {
    if (!info.dirty && info.commitsAhead === 0) {
      return true;
    }
    const holds: string[] = [];
    if (info.dirty) {
      holds.push(vscode.l10n.t('uncommitted changes'));
    }
    if (info.commitsAhead > 0) {
      holds.push(vscode.l10n.t('{0} local commit(s)', info.commitsAhead));
    }
    return this._confirmDestructive(
      vscode.l10n.t(
        'The local worktree for PR #{0} is out of date and holds {1}. Delete it and check out the current PR head? That local work will be lost.',
        index,
        holds.join(', '),
      ),
    );
  }

  private async _exportInstances(ids?: string[]) {
    if (!this._view) {
      return;
    }
    const encryptLabel = vscode.l10n.t('Encrypt with password');
    const plainTextLabel = vscode.l10n.t('Plain text');
    const choice = await vscode.window.showWarningMessage(
      vscode.l10n.t(
        'Choose how to export instance configuration. Access tokens will be included in plain text unless encrypted.',
      ),
      { modal: true },
      encryptLabel,
      plainTextLabel,
    );
    if (choice !== encryptLabel && choice !== plainTextLabel) {
      this._reply('instancesExported', { success: false, cancelled: true });
      return;
    }
    let password: string | undefined;
    if (choice === encryptLabel) {
      password = await this._promptExportPassword();
      if (!password) {
        this._reply('instancesExported', { success: false, cancelled: true });
        return;
      }
    }
    const uri = await vscode.window.showSaveDialog({
      defaultUri: vscode.Uri.file('forgejo-toolkit-instances.json'),
      filters: { JSON: ['json'] },
    });
    if (!uri) {
      this._reply('instancesExported', { success: false, cancelled: true });
      return;
    }
    try {
      let data: object = this._buildExportData(ids);
      if (password) {
        data = this._encryptExportData(data, password);
      }
      // Atomic write: an export interrupted halfway (a full disk, a crash) must
      // not destroy the export file that is already at that path.
      await writeFileAtomically(uri.fsPath, JSON.stringify(data, null, 2));
      this._reply('instancesExported', { success: true, path: uri.fsPath });
    } catch (error) {
      const err = userFacingErrorMessage(error);
      logger.error(`exportInstances failed: ${err}`);
      this._reply('instancesExported', { success: false, error: err });
    }
  }

  private _buildExportData(ids?: string[]): object {
    const allInstances = this._config.getInstances();
    const instances = ids ? allInstances.filter((instance) => ids.includes(instance.id)) : allInstances;
    const configuration = vscode.workspace.getConfiguration('forgejoToolkit');
    const settings: ExportSettings = {
      locale: configuration.get<string>('locale') ?? undefined,
      debug: configuration.get<boolean>('debug') ?? undefined,
      worktreeOpenMode: this._config.getWorktreeOpenMode(),
      worktreeCacheDirectory: this._config.getWorktreeCacheDirectory() ?? undefined,
    };
    return { version: 2, instances, settings };
  }

  private async _copyInstancesToClipboard(ids?: string[]) {
    if (!this._view) {
      return;
    }
    const encryptLabel = vscode.l10n.t('Encrypt with password');
    const plainTextLabel = vscode.l10n.t('Plain text');
    const choice = await vscode.window.showWarningMessage(
      vscode.l10n.t(
        'Choose how to export instance configuration. Access tokens will be included in plain text unless encrypted.',
      ),
      { modal: true },
      encryptLabel,
      plainTextLabel,
    );
    if (choice !== encryptLabel && choice !== plainTextLabel) {
      this._reply('instancesExported', { success: false, cancelled: true });
      return;
    }
    let password: string | undefined;
    if (choice === encryptLabel) {
      password = await this._promptExportPassword();
      if (!password) {
        this._reply('instancesExported', { success: false, cancelled: true });
        return;
      }
    }
    try {
      let data: object = this._buildExportData(ids);
      if (password) {
        data = this._encryptExportData(data, password);
      }
      await vscode.env.clipboard.writeText(JSON.stringify(data, null, 2));
      this._reply('instancesExported', { success: true });
    } catch (error) {
      const err = userFacingErrorMessage(error);
      logger.error(`copyInstancesToClipboard failed: ${err}`);
      this._reply('instancesExported', { success: false, error: err });
    }
  }

  private async _promptExportPassword(): Promise<string | undefined> {
    const password = await vscode.window.showInputBox({
      prompt: vscode.l10n.t('Enter export password'),
      password: true,
      ignoreFocusOut: true,
    });
    if (!password) {
      return undefined;
    }
    const confirm = await vscode.window.showInputBox({
      prompt: vscode.l10n.t('Confirm export password'),
      password: true,
      ignoreFocusOut: true,
    });
    if (password !== confirm) {
      await vscode.window.showErrorMessage(vscode.l10n.t('Passwords do not match'));
      return undefined;
    }
    return password;
  }

  private _encryptExportData(data: object, password: string): object {
    const iterations = 100_000;
    const salt = crypto.randomBytes(16);
    const iv = crypto.randomBytes(16);
    const key = crypto.pbkdf2Sync(password, salt, iterations, 32, 'sha256');
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    const plaintext = JSON.stringify(data);
    const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const authTag = cipher.getAuthTag();
    return {
      version: 2,
      encrypted: true,
      iterations,
      salt: salt.toString('base64'),
      iv: iv.toString('base64'),
      authTag: authTag.toString('base64'),
      data: encrypted.toString('base64'),
    };
  }

  private async _previewImportInstances() {
    if (!this._view) {
      return;
    }
    const uris = await vscode.window.showOpenDialog({
      canSelectFiles: true,
      canSelectFolders: false,
      canSelectMany: false,
      filters: { JSON: ['json'] },
    });
    if (!uris || uris.length === 0) {
      // The webview keeps a single in-flight slot for this request; a silent
      // cancel would wedge it forever, so answer explicitly.
      this._reply('importInstancesPreview', {
        instances: [],
        existingIds: [],
        tokenConflicts: [],
        settings: undefined,
        cancelled: true,
      });
      return;
    }
    try {
      const { instances, settings } = await readExportDataFromUri(uris[0]);
      // Stash the full entries host-side; the webview only receives a
      // token-less copy and later confirms by id, so token values never
      // cross into the webview process in either direction.
      this._pendingImportInstances = instances;
      const existingInstances = this._config.getInstances();
      const existingIds = existingInstances.map((instance) => instance.id);
      // Conflict flags (stored-token collisions and in-file duplicates) are
      // computed host-side (parallel to `instances`) — see the message type.
      const tokenConflicts = computeImportTokenConflicts(instances, existingInstances);
      this._reply('importInstancesPreview', {
        instances: stripInstanceTokens(instances),
        existingIds,
        tokenConflicts,
        settings,
      });
    } catch (error) {
      this._pendingImportInstances = undefined;
      if (error instanceof ImportCancelledError) {
        // The user dismissed the password prompt: answer like the file-picker
        // cancel above so the preview slot frees without an error banner.
        this._reply('importInstancesPreview', {
          instances: [],
          existingIds: [],
          tokenConflicts: [],
          settings: undefined,
          cancelled: true,
        });
        return;
      }
      const err = userFacingErrorMessage(error);
      logger.error(`previewImportInstances failed: ${err}`);
      this._reply('importInstancesPreview', {
        instances: [],
        existingIds: [],
        tokenConflicts: [],
        settings: undefined,
        error: err,
      });
    }
  }

  private async _importInstances(instancesToImport?: ForgejoInstance[], settings?: ExportSettings) {
    if (!this._view) {
      return;
    }
    let instances: ForgejoInstance[];
    if (instancesToImport) {
      instances = instancesToImport;
    } else {
      const uris = await vscode.window.showOpenDialog({
        canSelectFiles: true,
        canSelectFolders: false,
        canSelectMany: false,
        filters: { JSON: ['json'] },
      });
      if (!uris || uris.length === 0) {
        this._reply('instancesImported', { success: false, cancelled: true });
        return;
      }
      try {
        const data = await readExportDataFromUri(uris[0]);
        instances = data.instances;
        if (data.settings) {
          settings = data.settings;
        }
      } catch (error) {
        if (error instanceof ImportCancelledError) {
          // Dismissing the password prompt is a cancel, not a failure: match
          // the file-picker cancel reply so no error status is shown.
          this._reply('instancesImported', { success: false, cancelled: true });
          return;
        }
        const err = userFacingErrorMessage(error);
        logger.error(`importInstances failed: ${err}`);
        this._reply('instancesImported', { success: false, error: err });
        return;
      }
    }
    try {
      for (const instance of instances) {
        try {
          await this._config.addInstance(instance);
        } catch (error) {
          // Same contract as the onboarding guide: the failure reply names the
          // instance, because "the import failed" alone gives the user nothing
          // to act on.
          throw new Error(
            vscode.l10n.t(
              'Importing instance {0} failed: {1}',
              instance.name || instance.url,
              userFacingErrorMessage(error),
            ),
          );
        }
      }
      await this._applyImportSettings(settings);
      this._sendInstances();
      this._detectAndSendLinkedRepository();
      this._reply('instancesImported', { success: true, count: instances.length });
    } catch (error) {
      const err = userFacingErrorMessage(error);
      logger.error(`importInstances failed: ${err}`);
      this._reply('instancesImported', { success: false, error: err });
    }
  }

  /**
   * Persist a custom worktree cache directory after validating that it exists
   * (creating it when needed) and is writable. Returns false and surfaces an
   * error when the directory cannot be used; an empty value resets to the
   * default directory and is always accepted.
   */
  private async _setWorktreeCacheDirectory(directory: string): Promise<boolean> {
    const trimmed = directory.trim();
    if (trimmed) {
      try {
        await validateCacheDirectory(trimmed);
      } catch (error) {
        const err = userFacingErrorMessage(error);
        void vscode.window.showErrorMessage(
          vscode.l10n.t('Cannot use "{0}" as the worktree cache directory: {1}', trimmed, err),
        );
        return false;
      }
    }
    await this._config.setWorktreeCacheDirectory(trimmed);
    return true;
  }

  private async _applyImportSettings(settings: ExportSettings | undefined) {
    if (!settings) {
      return;
    }
    const configuration = vscode.workspace.getConfiguration('forgejoToolkit');
    if (settings.locale === 'en' || settings.locale === 'zh') {
      await configuration.update('locale', settings.locale, true);
      this._reply('setLocale', { locale: settings.locale });
      this._updateViewTitle(settings.locale);
    }
    if (typeof settings.debug === 'boolean') {
      await configuration.update('debug', settings.debug, true);
      this._reply('setDebug', { debug: settings.debug });
    }
    if (
      settings.worktreeOpenMode === 'ask' ||
      settings.worktreeOpenMode === 'currentWindow' ||
      settings.worktreeOpenMode === 'newWindow'
    ) {
      await this._config.setWorktreeOpenMode(settings.worktreeOpenMode);
      this._reply('worktreeOpenMode', { mode: settings.worktreeOpenMode });
    }
    if (typeof settings.worktreeCacheDirectory === 'string') {
      if (await this._setWorktreeCacheDirectory(settings.worktreeCacheDirectory)) {
        const directory = this._config.getWorktreeCacheDirectory() ?? '';
        const defaultDirectory = this._config.getDefaultWorktreeCacheDirectory();
        this._reply('worktreeCacheDirectory', { directory, defaultDirectory });
      }
    }
  }

  private _linkedRepoDetectTimer: ReturnType<typeof setTimeout> | undefined;
  /** Cold-start detection timer; cleared on dispose so a disposed host never scans git. */
  private _initialDetectTimer: ReturnType<typeof setTimeout> | undefined;

  // Debounced: rapid tab switches must not spawn a git subprocess burst.
  private _scheduleLinkedRepositoryDetect(): void {
    clearTimeout(this._linkedRepoDetectTimer);
    this._linkedRepoDetectTimer = setTimeout(() => {
      void this._detectAndSendLinkedRepository();
    }, 300);
  }

  private async _detectAndSendLinkedRepository() {
    try {
      const { linked, all, unpublished } = await detectLinkedRepositories(this._config.getInstances());
      // Gate the editor context menu (Copy Permalink) on whether the workspace
      // is linked to a Forgejo repository. This must run even when the view is
      // hidden, otherwise the key stays false until the sidebar is opened.
      void vscode.commands.executeCommand('setContext', 'forgejoToolkit.hasLinkedRepo', Boolean(linked));
      // The SCM "Publish to Forgejo" button only makes sense while at least one
      // workspace repository has no Forgejo remote yet; once everything is
      // published, pushing belongs to the built-in sync action.
      void vscode.commands.executeCommand('setContext', 'forgejoToolkit.hasUnpublishedRepo', unpublished.length > 0);
      if (!this._view?.visible) {
        return;
      }
      this._reply('linkedRepository', { linked, all });
    } catch (error) {
      // Timer- and event-driven callers have no error surface; a rejection
      // here would otherwise surface as an unhandled rejection.
      logger.error(`Linked repository detection failed: ${userFacingErrorMessage(error)}`);
    }
  }

  private _reply<T extends HostToWebviewMessage['command']>(
    command: T,
    data: Omit<Extract<HostToWebviewMessage, { command: T }>, 'command'>,
  ) {
    // Mark the request as answered so the dispatch fallback does not emit a
    // duplicate requestError reply.
    const requestId = (data as { _requestId?: unknown })._requestId;
    if (typeof requestId === 'string') {
      this._unansweredRequests.delete(requestId);
    }
    this._view?.webview.postMessage({ command, ...data } as HostToWebviewMessage);
  }

  public pushNotifications(instanceId: string, notifications: unknown[]): void {
    // Poller results feed the unread badge/toast slot only; the filtered
    // notifications view is written exclusively by getNotifications replies.
    // `coveredIds` tells the view which rows this poll actually examined: only
    // those may be reconciled as read, so a row beyond the fetched page is never
    // silently marked read.
    const coveredIds = notifications
      .map((notification) => (notification as { id?: unknown })?.id)
      .filter((id): id is number => typeof id === 'number');
    this._reply('polledNotifications', { instanceId, notifications, coveredIds });
  }

  public pushNotificationError(instanceId: string, error: string): void {
    this._reply('polledNotifications', { instanceId, error });
  }

  public openNotifications(): void {
    this._reply('openNotifications', {});
  }

  /**
   * Worktree directory for a PR/issue: the record of an existing worktree wins
   * so a worktree created before the instance discriminator existed keeps its
   * directory (and cannot be orphaned by the new naming below). Otherwise the
   * name carries an instance-derived suffix, because `worktrees/` is shared by
   * every instance and the same `owner/repo` slug on two instances must not
   * resolve to one directory: the second open would reuse - and
   * `discardStalePrWorktree` could delete - the other instance's checkout.
   */
  private _resolveWorktreePath(worktreesDir: string, defaultName: string, worktreeId: string): string {
    const recorded = this._worktreeManager.getWorktree(worktreeId);
    if (recorded?.worktreePath && isPathInsideFolder(worktreesDir, recorded.worktreePath)) {
      return recorded.worktreePath;
    }
    return path.join(worktreesDir, defaultName);
  }

  private async _handleOpenPrWorktree(message: { instanceId: string; owner: string; repo: string; index: number }) {
    // A rapid second invocation for the same PR reuses the in-flight run
    // instead of fetching the same branch or adding the same path twice.
    const key = `${message.instanceId}:${message.owner}/${message.repo}#${message.index}`;
    await this._worktreeInFlight.run(key, () => this._doOpenPrWorktree(message));
  }

  /**
   * Resolve the local checkout a worktree can be added to: the current
   * workspace, a previously used local clone, or the shared bare cache
   * (offering to clone or pick a folder). Never replies to the webview; the
   * caller maps the outcome to its own reply message. A clone failure is
   * thrown so the caller's catch reports it like any other git error.
   */
  private async _resolveWorktreeSourceRepo(
    instance: ForgejoInstance,
    owner: string,
    repo: string,
  ): Promise<
    | { kind: 'resolved'; sourceRepoPath: string; cacheDir: string }
    | { kind: 'cancelled' }
    | { kind: 'error'; message: string }
  > {
    // Trailing slashes are stripped like everywhere else the instance URL is
    // joined with a path: `https://host//owner/repo.git` makes git/Forgejo
    // answer a redirect or 404 that the user cannot correct from the UI.
    const cloneUrl = `${instance.url.replace(/\/+$/, '')}/${owner}/${repo}.git`;
    const cacheDir = this._worktreeManager.getCacheDirectory();

    let sourceRepoPath = await isCurrentWorkspaceBaseRepo(instance.url, owner, repo);
    if (!sourceRepoPath) {
      sourceRepoPath = await findLocalRepo(instance.url, owner, repo);
    }

    if (!sourceRepoPath) {
      // The shared bare clone is keyed by repository *and* instance: two
      // configured instances commonly host the same `owner/repo` slug, and a
      // single-instance path would make the second instance silently reuse the
      // first one's clone (its remotes point at the other host, so the
      // subsequent "which remote belongs to this repo" lookup fails).
      const cacheRepoPath = path.join(cacheDir, 'repos', `${owner}-${repo}-${instanceCacheSuffix(instance)}.git`);
      const cacheRepoExisted = await fs.promises
        .access(cacheRepoPath)
        .then(() => true)
        .catch(() => false);

      const choice = await vscode.window.showQuickPick(
        [
          {
            label: cacheRepoExisted
              ? vscode.l10n.t('Open cached bare repository')
              : vscode.l10n.t('Clone to cache directory'),
            value: 'clone' as const,
          },
          { label: vscode.l10n.t('Select an existing local repository'), value: 'select' as const },
          { label: vscode.l10n.t('Cancel'), value: 'cancel' as const },
        ],
        {
          placeHolder: vscode.l10n.t('No local repository found for {owner}/{repo}. What would you like to do?', {
            owner,
            repo,
          }),
          ignoreFocusOut: true,
        },
      );
      if (!choice || choice.value === 'cancel') {
        return { kind: 'cancelled' };
      }

      if (choice.value === 'clone') {
        sourceRepoPath = cacheRepoPath;
        if (!cacheRepoExisted) {
          // Dedupe on the target path: a concurrent open of another PR from
          // the same repository reuses the in-flight clone instead of running
          // `git clone --bare` into the same directory (which would fail).
          await this._bareCloneInFlight.run(`clone:${cacheRepoPath}`, async () => {
            // Re-check inside the task: when this run is not the one that
            // started the clone (or the other open finished while this one
            // was still at the picker), the cache repository is already there.
            const nowExists = await fs.promises.access(cacheRepoPath).then(
              () => true,
              () => false,
            );
            if (nowExists) {
              return;
            }
            await vscode.window.withProgress(
              {
                location: vscode.ProgressLocation.Notification,
                title: vscode.l10n.t('Cloning {0}/{1}…', owner, repo),
              },
              () => cloneRepository(cloneUrl, cacheRepoPath, instance.token),
            );
          });
        }
        await this._worktreeManager.touchCachedRepo(cacheRepoPath);
        // Lazy LRU sweep of the bare clone cache (no timer): aged-out and
        // over-cap repositories are removed while a worktree is created.
        void this._worktreeManager
          .cleanupCachedRepos()
          .then((removed) => {
            if (removed.length > 0) {
              logger.info(`Cleaned up ${removed.length} unused cached repositories: ${removed.join(', ')}`);
            }
          })
          .catch((error: unknown) => {
            logger.debug(`Cached repository cleanup failed: ${userFacingErrorMessage(error)}`);
          });
      } else {
        const selected = await vscode.window.showOpenDialog({
          canSelectFiles: false,
          canSelectFolders: true,
          canSelectMany: false,
          openLabel: vscode.l10n.t('Select repository'),
        });
        if (!selected || selected.length === 0) {
          return { kind: 'cancelled' };
        }
        sourceRepoPath = selected[0].fsPath;
        if (!(await isGitRepository(sourceRepoPath))) {
          return { kind: 'error', message: vscode.l10n.t('Selected folder is not a git repository') };
        }
        const remotes = await listRemotes(sourceRepoPath);
        const normalizedInstanceUrl = instance.url.replace(/\/$/, '');
        const expectedUrls = [
          `${normalizedInstanceUrl}/${owner}/${repo}.git`,
          `${normalizedInstanceUrl}/${owner}/${repo}`,
        ];
        // Transport-agnostic comparison: an ssh/scp remote and the https spelling
        // of the same repository name the same repository, credentials are
        // ignored, and a portless transport (ssh/scp/git) matches an instance URL
        // with or without a web port. The shared normalizeGitUrl comparison
        // matched none of those, so the user's own checkout was rejected as "not
        // the PR base repository" whenever the remote carried a token, used an scp
        // login other than `git`, or the instance URL carried a port.
        const matches = remotes.some((remote) => expectedUrls.some((url) => sameRepositoryUrl(remote.url, url)));
        if (!matches) {
          return { kind: 'error', message: vscode.l10n.t('Selected repository does not match the PR base repository') };
        }
      }
    }
    return { kind: 'resolved', sourceRepoPath, cacheDir };
  }

  private async _handleStartWorkOnIssue(message: {
    instanceId: string;
    owner: string;
    repo: string;
    index: number;
    title?: string;
  }) {
    // The guard key is built from the raw fields on purpose: `_doStartWorkOnIssue`
    // echoes them back for an invalid target, and reusing the same parts keeps
    // the in-flight entry and the reply's loading key in sync.
    const key = `start-work:${message.instanceId}:${message.owner}/${message.repo}#${message.index}`;
    await this._worktreeInFlight.run(key, () => this._doStartWorkOnIssue(message));
  }

  private async _doStartWorkOnIssue(message: {
    instanceId: unknown;
    owner: unknown;
    repo: unknown;
    index: unknown;
    title?: string;
  }) {
    const target = parseWorktreeTarget(message);
    if (!target) {
      logger.error(`startWorkOnIssue ignored: invalid repository identity in the webview message`);
      // The webview sets its start-work spinner before posting and only clears
      // it on a `startWorkResult`; dropping the invalid target silently would
      // leave that spinner running forever. Echo the identity fields so the
      // reply is routed to the same loading key the request used (the webview
      // builds that key by string interpolation, so it matches whatever it
      // sent). The guard has already rejected non-string owner/repo values.
      this._reply('startWorkResult', {
        instanceId: typeof message.instanceId === 'string' ? message.instanceId : '',
        owner: typeof message.owner === 'string' ? message.owner : '',
        repo: typeof message.repo === 'string' ? message.repo : '',
        index: typeof message.index === 'number' ? message.index : 0,
        error: vscode.l10n.t('The request could not be completed'),
      });
      return;
    }
    const { instanceId, owner, repo, index } = target;
    const reply = (data: { cancelled?: boolean; error?: string; worktree?: unknown }) =>
      this._reply('startWorkResult', { instanceId, owner, repo, index, ...data });

    const instance = this._findInstance(instanceId);
    if (!instance) {
      reply({ error: vscode.l10n.t('Instance not found') });
      return;
    }

    let openMode = this._config.getWorktreeOpenMode();
    if (openMode === 'ask') {
      const choice = await vscode.window.showQuickPick(
        [
          { label: vscode.l10n.t('New window'), value: 'newWindow' as const },
          { label: vscode.l10n.t('Current window'), value: 'currentWindow' as const },
        ],
        {
          placeHolder: vscode.l10n.t('How would you like to open the issue worktree?'),
          ignoreFocusOut: true,
        },
      );
      if (!choice) {
        reply({ cancelled: true });
        return;
      }
      openMode = choice.value;
    }
    const openInNewWindow = openMode === 'newWindow';

    try {
      const resolved = await this._resolveWorktreeSourceRepo(instance, owner, repo);
      if (resolved.kind === 'cancelled') {
        reply({ cancelled: true });
        return;
      }
      if (resolved.kind === 'error') {
        reply({ error: resolved.message });
        return;
      }
      const { sourceRepoPath, cacheDir } = resolved;

      const slug = sanitizeForPath(message.title ?? '');
      const slugSuffix = slug ? `-${slug}` : '';
      const branch = `issue-${index}${slugSuffix}`;
      const worktreesDir = path.join(cacheDir, 'worktrees');
      const worktreeId = `${instanceId}:${owner}/${repo}#issue-${index}`;
      const worktreePath = this._resolveWorktreePath(
        worktreesDir,
        `${owner}-${repo}-${instanceCacheSuffix(instance)}-issue-${index}${slugSuffix}`,
        worktreeId,
      );
      assertInsideWorktreeCache(worktreesDir, worktreePath);

      // A leftover directory from an earlier start-work run is reopened as
      // is; the branch inside is already the issue branch. A directory that
      // is not a git worktree (no `.git` entry) is a broken leftover and is
      // removed and recreated instead of being opened as-is.
      let existsOnDisk = await fs.promises.access(worktreePath).then(
        () => true,
        () => false,
      );
      if (existsOnDisk) {
        const looksLikeWorktree = await fs.promises.access(path.join(worktreePath, '.git')).then(
          () => true,
          () => false,
        );
        if (!looksLikeWorktree) {
          logger.error(`startWorkOnIssue: removing invalid leftover directory ${worktreePath}`);
          await fs.promises.rm(worktreePath, { recursive: true, force: true });
          existsOnDisk = false;
        }
      }
      let defaultBranch = 'main';
      if (!existsOnDisk) {
        const client = new ForgejoClient(instance.url, instance.token, logger, instance.syncApiUrlsToInstanceUrl);
        const detail = await client.getRepoDetail(owner, repo);
        defaultBranch = detail.repository.default_branch ?? 'main';
        // Fetch through the remote that actually points at this repo, not a
        // hardcoded 'origin' (with several remotes it may point elsewhere).
        const remoteName = await resolveRemoteForRepo(sourceRepoPath, instance.url, owner, repo);
        if (!remoteName) {
          reply({ error: vscode.l10n.t('No git remote in the local repository points at {0}/{1}', owner, repo) });
          return;
        }
        // FETCH_HEAD works as the start point in regular checkouts and bare
        // cache clones alike (see fetchBranch).
        await fetchBranch(sourceRepoPath, remoteName, defaultBranch, instance.token);
        await createWorktreeWithNewBranch(sourceRepoPath, worktreePath, branch, 'FETCH_HEAD');
      } else {
        // Reopening a leftover directory needs no git work, but the recorded
        // base branch should still be right. A recorded worktree already
        // carries it (no API call, so reopening stays possible offline);
        // otherwise resolve the default branch like the create path, falling
        // back to 'main' when the server cannot be reached — the branch is
        // display-only, so a wrong guess must not block the open.
        const recorded = this._worktreeManager.getWorktree(worktreeId);
        if (recorded) {
          defaultBranch = recorded.baseBranch;
        } else {
          try {
            const client = new ForgejoClient(instance.url, instance.token, logger, instance.syncApiUrlsToInstanceUrl);
            const detail = await client.getRepoDetail(owner, repo);
            defaultBranch = detail.repository.default_branch ?? 'main';
          } catch (error) {
            logger.error(
              `startWorkOnIssue: could not resolve the default branch of ${owner}/${repo}: ${userFacingErrorMessage(error)}`,
            );
          }
        }
      }

      // Record the worktree so the Settings UI can delete it and the bare
      // cache clone stays protected from the LRU sweep. Same persistence
      // timing as openPrWorktree: in current-window mode the record has to
      // be written before openFolder reloads the window.
      const worktree: WorktreeInfo = {
        id: worktreeId,
        kind: 'issue',
        instanceId,
        owner,
        repo,
        prIndex: index,
        prTitle: message.title ?? `Issue #${index}`,
        headBranch: branch,
        headSha: '',
        baseBranch: defaultBranch,
        sourceRepoPath,
        worktreePath,
        createdAt: Date.now(),
      };
      const opened = await openWorktree(worktreePath, openInNewWindow, () =>
        this._worktreeManager.addWorktree(worktree),
      );
      if (!opened) {
        reply({ cancelled: true });
        return;
      }
      if (openInNewWindow) {
        await this._worktreeManager.addWorktree(worktree);
      }
      // The webview merges this into its worktree list, so a worktree created by
      // "Start work" appears in Settings without a separate round trip.
      reply({ worktree });
      vscode.window.showInformationMessage(
        vscode.l10n.t('Started work on issue #{0}: created branch {1}', index, branch),
      );
    } catch (error) {
      const err = userFacingErrorMessage(error);
      logger.error(`startWorkOnIssue failed for ${owner}/${repo}#${index}: ${err}`);
      reply({ error: err });
    }
  }

  private async _doOpenPrWorktree(message: { instanceId: string; owner: string; repo: string; index: number }) {
    const target = parseWorktreeTarget(message);
    if (!target) {
      logger.error(`openPrWorktree ignored: invalid repository identity in the webview message`);
      // _doStartWorkOnIssue answers its invalid-target path the same way: the
      // PR view sets its spinner before posting and only a worktree reply
      // clears it, so dropping the request silently would leave it spinning.
      this._reply('worktreeError', {
        error: vscode.l10n.t('The request could not be completed'),
        operation: 'open',
        instanceId: typeof message.instanceId === 'string' ? message.instanceId : undefined,
        owner: typeof message.owner === 'string' ? message.owner : undefined,
        repo: typeof message.repo === 'string' ? message.repo : undefined,
        index: typeof message.index === 'number' ? message.index : undefined,
      });
      return;
    }
    const { instanceId, owner, repo, index } = target;
    const instance = this._findInstance(instanceId);
    if (!instance) {
      this._reply('worktreeError', {
        error: vscode.l10n.t('Instance not found'),
        operation: 'open',
        instanceId,
        owner,
        repo,
        index,
      });
      return;
    }

    let openMode = this._config.getWorktreeOpenMode();
    if (openMode === 'ask') {
      const choice = await vscode.window.showQuickPick(
        [
          { label: vscode.l10n.t('New window'), value: 'newWindow' as const },
          { label: vscode.l10n.t('Current window'), value: 'currentWindow' as const },
        ],
        {
          placeHolder: vscode.l10n.t('How would you like to open the PR worktree?'),
          ignoreFocusOut: true,
        },
      );
      if (!choice) {
        this._reply('worktreeCancelled', { instanceId, owner, repo, index });
        return;
      }
      openMode = choice.value;
    }
    const openInNewWindow = openMode === 'newWindow';

    const existing = this._worktreeManager.findWorktree(instanceId, owner, repo, index);
    // PR detail fetched for the head-sha revalidation of a recorded worktree;
    // the create path below reuses it instead of issuing a second API call.
    let prefetchedPr: Awaited<ReturnType<ForgejoClient['getPullRequestDetail']>> | undefined;
    if (existing) {
      const existsOnDisk = await fs.promises.access(existing.worktreePath).then(
        () => true,
        () => false,
      );
      if (existsOnDisk) {
        // A recorded worktree is only reopened as-is when the PR head still
        // matches the recorded sha; after a force-push the outdated directory
        // must not be opened silently. findWorktree only returns PR records,
        // so issue worktrees (which have no head sha) never reach this check.
        // When the current head cannot be determined, the open fails the same
        // way the no-record create path does instead of guessing.
        try {
          const client = new ForgejoClient(instance.url, instance.token, logger, instance.syncApiUrlsToInstanceUrl);
          prefetchedPr = await client.getPullRequestDetail(owner, repo, index);
        } catch (error) {
          const err = userFacingErrorMessage(error);
          logger.error(`openPrWorktree head check failed for ${owner}/${repo}#${index}: ${err}`);
          this._reply('worktreeError', { error: err, operation: 'open', instanceId, owner, repo, index });
          return;
        }
        const currentHeadSha = prefetchedPr.head?.sha;
        if (!currentHeadSha) {
          this._reply('worktreeError', {
            error: vscode.l10n.t('Could not determine PR head branch or sha'),
            operation: 'open',
            instanceId,
            owner,
            repo,
            index,
          });
          return;
        }
        if (currentHeadSha === existing.headSha) {
          try {
            const opened = await openWorktree(existing.worktreePath, openInNewWindow);
            if (!opened) {
              this._reply('worktreeCancelled', { instanceId, owner, repo, index });
              return;
            }
            this._reply('worktreeOpened', { worktree: existing, existed: true });
          } catch (error) {
            const err = userFacingErrorMessage(error);
            this._reply('worktreeError', { error: err, operation: 'open', instanceId, owner, repo, index });
          }
          return;
        }
        // Stale record: discard the outdated directory and its throwaway
        // branch through the same stale semantics as a leftover directory,
        // then fall through to the create path with the record kept;
        // addWorktree overwrites it with the new head. The recorded path is
        // revalidated explicitly because a renamed PR title changes the path
        // the create path computes, which would otherwise orphan this one.
        try {
          const inspection = await inspectPrWorktree(existing.worktreePath, currentHeadSha);
          if (inspection.state === 'stale') {
            if (!(await this._confirmDiscardStaleWorktree(inspection.info, index))) {
              this._reply('worktreeCancelled', { instanceId, owner, repo, index });
              return;
            }
            await discardStalePrWorktree(existing.sourceRepoPath, existing.worktreePath, inspection.info.branch);
          }
        } catch (error) {
          const err = userFacingErrorMessage(error);
          this._reply('worktreeError', { error: err, operation: 'open', instanceId, owner, repo, index });
          return;
        }
      } else {
        // The recorded worktree directory is gone from disk; drop the stale
        // record and fall through to recreate it.
        await this._worktreeManager.forgetWorktree(existing.id);
      }
    }

    try {
      const client = new ForgejoClient(instance.url, instance.token, logger, instance.syncApiUrlsToInstanceUrl);
      const pr = prefetchedPr ?? (await client.getPullRequestDetail(owner, repo, index));
      const headBranch = pr.head?.ref;
      const headSha = pr.head?.sha;
      const baseBranch = pr.base?.ref ?? 'main';
      const prTitle = pr.title ?? `PR #${index}`;
      if (!headBranch || !headSha) {
        this._reply('worktreeError', {
          error: vscode.l10n.t('Could not determine PR head branch or sha'),
          operation: 'open',
          instanceId,
          owner,
          repo,
          index,
        });
        return;
      }

      const resolved = await this._resolveWorktreeSourceRepo(instance, owner, repo);
      if (resolved.kind === 'cancelled') {
        this._reply('worktreeCancelled', { instanceId, owner, repo, index });
        return;
      }
      if (resolved.kind === 'error') {
        this._reply('worktreeError', {
          error: resolved.message,
          operation: 'open',
          instanceId,
          owner,
          repo,
          index,
        });
        return;
      }
      const { sourceRepoPath, cacheDir } = resolved;

      const sanitizedTitle = sanitizeForPath(prTitle);
      const titleSuffix = sanitizedTitle ? `-${sanitizedTitle}` : '';
      const worktreesDir = path.join(cacheDir, 'worktrees');
      const worktreePath = this._resolveWorktreePath(
        worktreesDir,
        `${owner}-${repo}-${instanceCacheSuffix(instance)}-pr-${index}${titleSuffix}`,
        `${instanceId}:${owner}/${repo}#pr-${index}`,
      );
      assertInsideWorktreeCache(worktreesDir, worktreePath);

      // A leftover directory is only reused when it is actually checked out at
      // the current PR head sha; a stale one (PR was updated, or the directory
      // is not a valid worktree) is discarded and recreated below — after
      // confirming when it still holds uncommitted changes or local commits,
      // because the forced removal discards both.
      const inspection = await inspectPrWorktree(worktreePath, headSha);
      if (inspection.state === 'stale') {
        if (!(await this._confirmDiscardStaleWorktree(inspection.info, index))) {
          this._reply('worktreeCancelled', { instanceId, owner, repo, index });
          return;
        }
        await discardStalePrWorktree(sourceRepoPath, worktreePath, inspection.info.branch);
      }
      const worktreeState = inspection.state;

      if (worktreeState === 'current') {
        const worktree: WorktreeInfo = {
          id: `${instanceId}:${owner}/${repo}#pr-${index}`,
          instanceId,
          owner,
          repo,
          prIndex: index,
          prTitle,
          headBranch,
          headSha,
          baseBranch,
          sourceRepoPath,
          worktreePath,
          createdAt: Date.now(),
        };
        const openedForCurrent = await openWorktree(worktreePath, openInNewWindow, () =>
          this._worktreeManager.addWorktree(worktree),
        );
        if (!openedForCurrent) {
          this._reply('worktreeCancelled', { instanceId, owner, repo, index });
          return;
        }
        // Record only after the user confirmed the open, so a cancelled
        // "replace current window" prompt leaves no stale entry. In
        // current-window mode the beforeOpen callback above already recorded
        // it (the window reloads right after openFolder returns control).
        if (openInNewWindow) {
          await this._worktreeManager.addWorktree(worktree);
        }
        this._reply('worktreeOpened', { worktree, existed: true });
        return;
      }

      // Fetch through the remote that actually points at this repo, not a
      // hardcoded 'origin' (with several remotes it may point elsewhere).
      const remoteName = await resolveRemoteForRepo(sourceRepoPath, instance.url, owner, repo);
      if (!remoteName) {
        this._reply('worktreeError', {
          error: vscode.l10n.t('No git remote in the local repository points at {0}/{1}', owner, repo),
          operation: 'open',
          instanceId,
          owner,
          repo,
          index,
        });
        return;
      }

      const localBranch = `pr-${index}-${headSha.slice(0, 7)}`;
      await fetchPullRequestHead(sourceRepoPath, remoteName, index, localBranch, instance.token);

      // Verify the fetched code is the PR head the API reported. Pull refs are
      // per-repository, so a matching remote serves the right ones; the check
      // catches the remaining drift (PR updated between the API call and the
      // fetch) instead of silently opening stale code.
      const fetchedSha = await getRefCommitSha(sourceRepoPath, localBranch);
      if (fetchedSha !== headSha) {
        await deleteBranch(sourceRepoPath, localBranch).catch(() => undefined);
        this._reply('worktreeError', {
          error: vscode.l10n.t(
            'Fetched PR head does not match commit {0}; the pull request may have been updated, please retry',
            headSha.slice(0, 7),
          ),
          operation: 'open',
          instanceId,
          owner,
          repo,
          index,
        });
        return;
      }

      await createWorktreeFromBranch(sourceRepoPath, worktreePath, localBranch);

      const worktree: WorktreeInfo = {
        id: `${instanceId}:${owner}/${repo}#pr-${index}`,
        instanceId,
        owner,
        repo,
        prIndex: index,
        prTitle,
        headBranch,
        headSha,
        baseBranch,
        sourceRepoPath,
        worktreePath,
        createdAt: Date.now(),
      };
      const openedNew = await openWorktree(worktreePath, openInNewWindow, () =>
        this._worktreeManager.addWorktree(worktree),
      );
      if (!openedNew) {
        this._reply('worktreeCancelled', { instanceId, owner, repo, index });
        return;
      }
      // Record only after the user confirmed the open, so a cancelled
      // "replace current window" prompt leaves no stale entry. In
      // current-window mode the beforeOpen callback above already recorded
      // it (the window reloads right after openFolder returns control).
      if (openInNewWindow) {
        await this._worktreeManager.addWorktree(worktree);
      }
      this._reply('worktreeOpened', { worktree, existed: false });
    } catch (error) {
      const err = userFacingErrorMessage(error);
      logger.error(`openPrWorktree failed for ${owner}/${repo}#${index}: ${err}`);
      this._reply('worktreeError', { error: err, operation: 'open', instanceId, owner, repo, index });
    }
  }

  private async _resolveCommitAvatars(
    detail: {
      repository: unknown;
      readme?: string;
      branches: string[];
      recentCommits: Array<{
        sha: string;
        commit: unknown;
        author?: { avatar_url?: string };
        committer?: { avatar_url?: string };
        html_url: string;
      }>;
    },
    instance: ForgejoInstance,
  ): Promise<typeof detail> {
    // Dedupe by URL first: the same author typically appears on most of the
    // listed commits, and each resolution is an HTTP fetch proxied through
    // the host.
    const avatarUrls = new Set<string>();
    for (const commit of detail.recentCommits) {
      if (commit.committer?.avatar_url) {
        avatarUrls.add(commit.committer.avatar_url);
      }
      if (commit.author?.avatar_url) {
        avatarUrls.add(commit.author.avatar_url);
      }
    }
    const resolvedUrls = new Map<string, string>();
    await Promise.all(
      Array.from(avatarUrls).map(async (url) => {
        resolvedUrls.set(url, await this._resolveAvatarUrl(url, instance));
      }),
    );
    const resolvedCommits = detail.recentCommits.map((commit) => {
      const resolved = { ...commit };
      if (commit.committer?.avatar_url) {
        resolved.committer = {
          ...commit.committer,
          avatar_url: resolvedUrls.get(commit.committer.avatar_url) ?? commit.committer.avatar_url,
        };
      }
      if (commit.author?.avatar_url) {
        resolved.author = {
          ...commit.author,
          avatar_url: resolvedUrls.get(commit.author.avatar_url) ?? commit.author.avatar_url,
        };
      }
      return resolved;
    });
    return { ...detail, recentCommits: resolvedCommits };
  }

  private async _resolveAvatarUrl(url: string, instance: ForgejoInstance): Promise<string> {
    if (!this._view) {
      logger.debug(`[avatar] no view, returning original url: ${url}`);
      return url;
    }
    logger.debug(`[avatar] resolving: ${url}`);
    try {
      // Only same-origin URLs are proxied through the host: avatars on private
      // instances (force-login) need the API token, and the token must never
      // leak to third-party origins. Everything else — gravatar, but also any
      // intranet address a malicious instance plants in avatar_url — is
      // returned as-is for the webview to load directly (its CSP allows
      // https: images), so the host never fetches attacker-chosen targets.
      // Relative URLs resolve against the instance URL and are same-origin.
      // Non-http(s) schemes (e.g. data:) have origin "null" and pass through.
      const parsed = new URL(url, instance.url);
      if (!isSameOrigin(parsed.href, instance.url)) {
        logger.debug(`[avatar] not same-origin, returning original url: ${url}`);
        return url;
      }
      return (await this._fetchAvatarDataUrl(parsed.href, instance)) ?? url;
    } catch (error) {
      const err = userFacingErrorMessage(error);
      logger.error(`[avatar] error resolving ${url}: ${err}`);
      return url;
    }
  }

  /**
   * Fetch a same-origin avatar as a data URL, going through the session-level
   * cache. Returns null (cached briefly) when the fetch fails; the caller
   * falls back to the original URL.
   */
  private _fetchAvatarDataUrl(absoluteUrl: string, instance: ForgejoInstance): Promise<string | null> {
    const cached = getCachedAvatar(absoluteUrl);
    if (cached) {
      return cached;
    }
    const promise = (async (): Promise<string | null> => {
      try {
        // A hung image host must not stall the surrounding Promise.all; on
        // timeout the fetch rejects and the original URL is kept.
        const init: RequestInit = {
          signal: AbortSignal.timeout(API_REQUEST_TIMEOUT_MS),
          headers: { Authorization: `token ${instance.token}` },
        };
        // Route through the configured proxy like every other host-side
        // request: without it an instance reachable only through the proxy
        // makes every avatar stall until the 30 s timeout and then fall back to
        // the raw URL. A dispatcher is only understood by the undici fetch that
        // created it, hence the paired helper.
        const response = await (getProxyFetch() ?? fetch)(absoluteUrl, init);
        logger.debug(`[avatar] response status: ${response.status} ${response.statusText}`);
        if (!response.ok) {
          logger.error(`[avatar] fetch failed: ${response.status} ${response.statusText}`);
          return null;
        }
        const buffer = await response.arrayBuffer();
        const base64 = Buffer.from(buffer).toString('base64');
        const contentType = response.headers.get('content-type') ?? 'image/png';
        logger.debug(`[avatar] resolved to data:${contentType};base64,${base64.slice(0, 40)}...`);
        return `data:${contentType};base64,${base64}`;
      } catch (error) {
        const err = userFacingErrorMessage(error);
        logger.error(`[avatar] error resolving ${absoluteUrl}: ${err}`);
        return null;
      }
    })();
    cacheResolvedAvatar(absoluteUrl, promise);
    return promise;
  }
}
