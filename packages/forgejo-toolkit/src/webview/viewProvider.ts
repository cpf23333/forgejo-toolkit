import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { logger } from '../logger';
import { ForgejoClient } from '../api/client';
import type { ForgejoChangedFile } from '../api/types';
import { ConfigManager } from '../config';
import type { ExportSettings, ForgejoInstance } from '@cpf23333-forgejo-toolkit/shared/webview/messages';
import { toPublicInstance } from '@cpf23333-forgejo-toolkit/shared/webview/messages';
import { getWebviewContent } from './content';
import type { ReadmeContentProvider } from '../readmeProvider';
import { openReadmePreview } from '../readmeProvider';
import { buildRepoFileUri } from '../repoFileProvider';
import { WorktreeManager, WorktreeInfo, validateCacheDirectory } from '../worktree/worktreeManager';
import { InFlightTasks } from '../worktree/inFlightTasks';
import {
  cloneRepository,
  createWorktreeFromBranch,
  createWorktreeWithNewBranch,
  detectLinkedRepository,
  fetchBranch,
  fetchPullRequestHead,
  findLocalRepo,
  getRemoteUrl,
  isCurrentWorkspaceBaseRepo,
  isGitRepository,
  openWorktree,
  revertMergeCommit,
  sanitizeForPath,
  validatePrWorktree,
} from '../worktree/gitOperations';
import { normalizeGitUrl } from '@cpf23333-forgejo-toolkit/shared/git/url';
import type { HostToWebviewMessage } from '@cpf23333-forgejo-toolkit/shared/webview/messages';
import { computeTokenConflicts, readExportDataFromUri, sanitizeImportedInstances } from './instanceImport';
import { userFacingErrorMessage } from '../api/errors';
import { probeServerVersion } from '../api/versionProbe';
import { resolveAttachmentImages } from '../utils/resolveAttachmentImages';
import { resolveLocale } from '../utils/resolveLocale';

export class ForgejoToolkitViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'forgejoToolkitView';

  /** Invoked after a pull request is created, merged, or closed through the webview. */
  public onPullRequestsChanged: (() => void) | undefined;

  private _view?: vscode.WebviewView;
  private _pendingMessages: HostToWebviewMessage[] = [];
  /** Request ids currently being handled; a reply removes the id (see `_reply`). */
  private readonly _unansweredRequests = new Set<string>();
  private readonly _worktreeManager: WorktreeManager;
  /** Guards against concurrent openPrWorktree runs for the same PR (double-click). */
  private readonly _worktreeInFlight = new InFlightTasks();

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

    this._context.subscriptions.push(this._config.onInstancesChanged(() => this._sendInstances()));
    this._context.subscriptions.push(
      vscode.workspace.onDidChangeWorkspaceFolders(() => this._detectAndSendLinkedRepository()),
      // In multi-repository workspaces the linked repository follows the
      // active editor; re-resolve when it changes (debounced).
      vscode.window.onDidChangeActiveTextEditor(() => this._scheduleLinkedRepositoryDetect()),
      { dispose: () => clearTimeout(this._linkedRepoDetectTimer) },
    );
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

    webviewView.webview.html = getWebviewContent(webviewView.webview, this._extensionUri.fsPath);

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

  private async _handleMessage(message: any): Promise<void> {
    logger.debug(`Received message from webview: ${message.command}`);
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
          this._reply('testConnectionResult', { success: false, error: 'Invalid input' });
          return;
        }
        // When editing an instance the token field is left empty to keep the
        // stored token (tokens are never sent to the webview); fall back to it
        // so testing the connection of a private instance does not fail.
        let effectiveToken = token;
        if (!effectiveToken && typeof instanceId === 'string') {
          effectiveToken = this._findInstance(instanceId)?.token ?? token;
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
          this._reply('testConnectionResult', { success: false, error: err });
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
          const instanceHost = new URL(normalizedUrl).host;
          const instance: ForgejoInstance = {
            id: `${instanceHost}-${user.login}`,
            url: normalizedUrl,
            token,
            name: `${user.login}@${instanceHost}`,
            username: user.login,
            syncApiUrlsToInstanceUrl,
          };

          await this._config.addInstance(instance);
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
        await this._config.removeInstance(id);
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
        const rawInstances = Array.isArray((message as { instances?: unknown[] }).instances)
          ? (message as { instances: unknown[] }).instances
          : undefined;
        let instancesToImport: ForgejoInstance[] | undefined;
        if (rawInstances) {
          // The webview sends untrusted JSON: validate every entry instead of
          // trusting the cast. If nothing survives, report it as an import
          // failure rather than silently importing zero instances.
          const { valid, dropped } = sanitizeImportedInstances(rawInstances);
          if (valid.length === 0) {
            logger.error(`importInstances: dropped all ${dropped} invalid instance entries from the webview`);
            this._reply('instancesImported', {
              success: false,
              error: vscode.l10n.t('No valid instances found in the import data'),
            });
            return;
          }
          if (dropped > 0) {
            logger.info(`importInstances: dropped ${dropped} invalid instance entries from the webview`);
          }
          instancesToImport = valid;
        }
        const settings = (message as { settings?: ExportSettings }).settings;
        await this._importInstances(instancesToImport, settings);
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
        try {
          const client = new ForgejoClient(instance.url, instance.token, logger, instance.syncApiUrlsToInstanceUrl);
          const issues = await client.getUserIssues(message.state ?? 'open');
          this._reply('myIssues', { instanceId: instance.id, issues });
        } catch (error) {
          const err = userFacingErrorMessage(error);
          logger.error(`getMyIssues failed for ${instance.name}: ${err}`);
          this._reply('myIssues', { instanceId: message.instanceId, error: err });
        }
        return;
      }
      case 'getMyPullRequests': {
        const instance = this._findInstance(message.instanceId);
        if (!instance) {
          return;
        }
        try {
          const client = new ForgejoClient(instance.url, instance.token, logger, instance.syncApiUrlsToInstanceUrl);
          const pulls = await client.getUserPullRequests(message.state ?? 'open');
          this._reply('myPullRequests', { instanceId: instance.id, pullRequests: pulls });
        } catch (error) {
          const err = userFacingErrorMessage(error);
          logger.error(`getMyPullRequests failed for ${instance.name}: ${err}`);
          this._reply('myPullRequests', { instanceId: message.instanceId, error: err });
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
        const { statusTypes, subjectType, limit } = message;
        try {
          const client = new ForgejoClient(instance.url, instance.token, logger, instance.syncApiUrlsToInstanceUrl);
          const notifications = await client.getNotifications(
            Array.isArray(statusTypes) ? statusTypes : undefined,
            Array.isArray(subjectType)
              ? (subjectType.filter((t): t is 'issue' | 'pull' | 'repository' =>
                  ['issue', 'pull', 'repository'].includes(t as string),
                ) as ('issue' | 'pull' | 'repository')[])
              : undefined,
            typeof limit === 'number' ? limit : 50,
          );
          logger.info(`getNotifications returned ${notifications.length} items for ${instance.name}`);
          this._reply('notifications', {
            instanceId: instance.id,
            notifications,
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
          const detailWithResolvedAvatars = await this._resolveCommitAvatars(detail);
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
          const commitsWithResolvedAvatars = await this._resolveCommitAvatars({
            repository: {},
            branches: [],
            recentCommits: commits,
          });
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
          typeof user !== 'string'
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
          await revertMergeCommit(localRepo, pr.merge_commit_sha, pr.base?.ref, instance.token, instance.url);
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
          this._reply('revertMergeCommitResult', {
            instanceId: message.instanceId,
            owner,
            repo,
            index,
            error: err,
          });
        }
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
          const { state_toggle: stateToggle, ...prData } = data;
          const item = await client.editPullRequest(owner, repo, index, prData);
          this._reply('pullRequestUpdated', {
            instanceId: instance.id,
            owner,
            repo,
            index,
            item,
            ...(stateToggle ? { stateToggle: true } : {}),
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
        if (typeof username !== 'string' || typeof _requestId !== 'string') {
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
          const defaultName = name.endsWith('.zip') ? name : `${name}.zip`;
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
          typeof path !== 'string' ||
          typeof ref !== 'string'
        ) {
          return;
        }
        try {
          const client = new ForgejoClient(instance.url, instance.token, logger, instance.syncApiUrlsToInstanceUrl);
          const entries = await client.getRepoContents(owner, repo, path, ref || undefined);
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
          typeof path !== 'string' ||
          typeof ref !== 'string'
        ) {
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
          return;
        }
        try {
          const client = new ForgejoClient(instance.url, instance.token, logger, instance.syncApiUrlsToInstanceUrl);
          const files = await client.searchRepoFiles(owner, repo, ref, query);
          this._reply('repoFilesSearchResult', {
            instanceId: instance.id,
            owner,
            repo,
            ref,
            query,
            files,
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
        if (
          typeof owner !== 'string' ||
          typeof repo !== 'string' ||
          typeof path !== 'string' ||
          typeof ref !== 'string'
        ) {
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
          typeof path !== 'string' ||
          typeof baseRef !== 'string' ||
          typeof headRef !== 'string'
        ) {
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
        const { owner, repo, content } = message;
        if (typeof owner === 'string' && typeof repo === 'string' && typeof content === 'string') {
          openReadmePreview(this._readmeProvider, owner, repo, content);
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
          try {
            await this._worktreeManager.removeWorktree(id);
            this._reply('worktreeRemoved', { id });
          } catch (error) {
            // removeWorktree keeps the record on failure so the user can
            // retry; the error reaches the user exactly once, through this
            // worktreeError notification shown by the webview.
            const err = userFacingErrorMessage(error);
            const record = this._worktreeManager.getWorktree(id);
            this._reply('worktreeError', {
              error: err,
              operation: 'remove',
              instanceId: record?.instanceId,
              owner: record?.owner,
              repo: record?.repo,
              index: record?.prIndex,
            });
          }
          this._reply('worktreesList', { worktrees: this._worktreeManager.getWorktrees() });
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
    // arrive before that, so this is a queue, not a single slot.
    if (this._view) {
      this._view.webview.postMessage(message);
    } else {
      this._pendingMessages.push(message);
    }
  }

  public refresh() {
    this._sendInstances();
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
    const title = locale === 'zh' ? '仪表盘' : 'Dashboard';
    this._view.title = title;
  }

  private _sendInstances() {
    if (this._view?.visible) {
      this._reply('instances', { data: this._config.getInstances().map(toPublicInstance) });
    }
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
      this._reply('instancesExported', { success: false });
      return;
    }
    let password: string | undefined;
    if (choice === encryptLabel) {
      password = await this._promptExportPassword();
      if (!password) {
        this._reply('instancesExported', { success: false });
        return;
      }
    }
    const uri = await vscode.window.showSaveDialog({
      defaultUri: vscode.Uri.file('forgejo-toolkit-instances.json'),
      filters: { JSON: ['json'] },
    });
    if (!uri) {
      this._reply('instancesExported', { success: false });
      return;
    }
    try {
      let data: object = this._buildExportData(ids);
      if (password) {
        data = this._encryptExportData(data, password);
      }
      await fs.promises.writeFile(uri.fsPath, JSON.stringify(data, null, 2), 'utf8');
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
      this._reply('instancesExported', { success: false });
      return;
    }
    let password: string | undefined;
    if (choice === encryptLabel) {
      password = await this._promptExportPassword();
      if (!password) {
        this._reply('instancesExported', { success: false });
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
      const existingInstances = this._config.getInstances();
      const existingIds = existingInstances.map((instance) => instance.id);
      // Conflict flags are computed host-side (parallel to `instances`) so
      // stored tokens are never sent to the webview.
      const tokenConflicts = computeTokenConflicts(instances, existingInstances);
      this._reply('importInstancesPreview', { instances, existingIds, tokenConflicts, settings });
    } catch (error) {
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
        this._reply('instancesImported', { success: false });
        return;
      }
      try {
        const data = await readExportDataFromUri(uris[0]);
        instances = data.instances;
        if (data.settings) {
          settings = data.settings;
        }
      } catch (error) {
        const err = userFacingErrorMessage(error);
        logger.error(`importInstances failed: ${err}`);
        this._reply('instancesImported', { success: false, error: err });
        return;
      }
    }
    try {
      for (const instance of instances) {
        await this._config.addInstance(instance);
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

  // Debounced: rapid tab switches must not spawn a git subprocess burst.
  private _scheduleLinkedRepositoryDetect(): void {
    clearTimeout(this._linkedRepoDetectTimer);
    this._linkedRepoDetectTimer = setTimeout(() => {
      void this._detectAndSendLinkedRepository();
    }, 300);
  }

  private async _detectAndSendLinkedRepository() {
    const linked = await detectLinkedRepository(this._config.getInstances());
    // Gate the editor context menu (Copy Permalink) on whether the workspace
    // is linked to a Forgejo repository. This must run even when the view is
    // hidden, otherwise the key stays false until the sidebar is opened.
    void vscode.commands.executeCommand('setContext', 'forgejoToolkit.hasLinkedRepo', Boolean(linked));
    if (!this._view?.visible) {
      return;
    }
    this._reply('linkedRepository', { linked });
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
    this._reply('polledNotifications', { instanceId, notifications });
  }

  public pushNotificationError(instanceId: string, error: string): void {
    this._reply('polledNotifications', { instanceId, error });
  }

  public openNotifications(): void {
    this._reply('openNotifications', {});
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
    const cloneUrl = `${instance.url}/${owner}/${repo}.git`;
    const cacheDir = this._worktreeManager.getCacheDirectory();

    let sourceRepoPath = await isCurrentWorkspaceBaseRepo(instance.url, owner, repo);
    if (!sourceRepoPath) {
      sourceRepoPath = await findLocalRepo(instance.url, owner, repo);
    }

    if (!sourceRepoPath) {
      const cacheRepoPath = path.join(cacheDir, 'repos', `${owner}-${repo}.git`);
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
          await vscode.window.withProgress(
            {
              location: vscode.ProgressLocation.Notification,
              title: vscode.l10n.t('Cloning {0}/{1}…', owner, repo),
            },
            () => cloneRepository(cloneUrl, cacheRepoPath, instance.token),
          );
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
        const remote = await getRemoteUrl(sourceRepoPath);
        const normalizedInstanceUrl = instance.url.replace(/\/$/, '');
        const expectedUrls = [
          `${normalizedInstanceUrl}/${owner}/${repo}.git`,
          `${normalizedInstanceUrl}/${owner}/${repo}`,
        ];
        if (!remote || !expectedUrls.some((url) => normalizeGitUrl(remote) === normalizeGitUrl(url))) {
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
    // Same double-click guard as openPrWorktree.
    const key = `start-work:${message.instanceId}:${message.owner}/${message.repo}#${message.index}`;
    await this._worktreeInFlight.run(key, () => this._doStartWorkOnIssue(message));
  }

  private async _doStartWorkOnIssue(message: {
    instanceId: string;
    owner: string;
    repo: string;
    index: number;
    title?: string;
  }) {
    const { instanceId, owner, repo, index } = message;
    const reply = (data: { cancelled?: boolean; error?: string }) =>
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
      const worktreePath = path.join(cacheDir, 'worktrees', `${owner}-${repo}-issue-${index}${slugSuffix}`);

      // A leftover directory from an earlier start-work run is reopened as
      // is; the branch inside is already the issue branch.
      const existsOnDisk = await fs.promises.access(worktreePath).then(
        () => true,
        () => false,
      );
      if (!existsOnDisk) {
        const client = new ForgejoClient(instance.url, instance.token, logger, instance.syncApiUrlsToInstanceUrl);
        const detail = await client.getRepoDetail(owner, repo);
        const defaultBranch = detail.repository.default_branch ?? 'main';
        // FETCH_HEAD works as the start point in regular checkouts and bare
        // cache clones alike (see fetchBranch).
        await fetchBranch(sourceRepoPath, 'origin', defaultBranch, instance.token);
        await createWorktreeWithNewBranch(sourceRepoPath, worktreePath, branch, 'FETCH_HEAD');
      }

      const opened = await openWorktree(worktreePath, openInNewWindow);
      if (!opened) {
        reply({ cancelled: true });
        return;
      }
      reply({});
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
    const { instanceId, owner, repo, index } = message;
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
    if (existing) {
      const existsOnDisk = await fs.promises.access(existing.worktreePath).then(
        () => true,
        () => false,
      );
      if (existsOnDisk) {
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
      // The recorded worktree directory is gone from disk; drop the stale
      // record and fall through to recreate it.
      await this._worktreeManager.forgetWorktree(existing.id);
    }

    try {
      const client = new ForgejoClient(instance.url, instance.token, logger, instance.syncApiUrlsToInstanceUrl);
      const pr = await client.getPullRequestDetail(owner, repo, index);
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
      const worktreePath = path.join(cacheDir, 'worktrees', `${owner}-${repo}-pr-${index}${titleSuffix}`);

      // A leftover directory is only reused when it is actually checked out at
      // the current PR head sha; a stale one (PR was updated, or the directory
      // is not a valid worktree) is removed and recreated below.
      const worktreeState = await validatePrWorktree(sourceRepoPath, worktreePath, headSha);

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
        const openedForCurrent = await openWorktree(worktreePath, openInNewWindow);
        if (!openedForCurrent) {
          this._reply('worktreeCancelled', { instanceId, owner, repo, index });
          return;
        }
        // Record only after the user confirmed the open, so a cancelled
        // "replace current window" prompt leaves no stale entry.
        await this._worktreeManager.addWorktree(worktree);
        this._reply('worktreeOpened', { worktree, existed: true });
        return;
      }

      const localBranch = `pr-${index}-${headSha.slice(0, 7)}`;
      await fetchPullRequestHead(sourceRepoPath, 'origin', index, localBranch, instance.token);

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
      const openedNew = await openWorktree(worktreePath, openInNewWindow);
      if (!openedNew) {
        this._reply('worktreeCancelled', { instanceId, owner, repo, index });
        return;
      }
      // Record only after the user confirmed the open, so a cancelled
      // "replace current window" prompt leaves no stale entry.
      await this._worktreeManager.addWorktree(worktree);
      this._reply('worktreeOpened', { worktree, existed: false });
    } catch (error) {
      const err = userFacingErrorMessage(error);
      logger.error(`openPrWorktree failed for ${owner}/${repo}#${index}: ${err}`);
      this._reply('worktreeError', { error: err, operation: 'open', instanceId, owner, repo, index });
    }
  }

  private async _resolveCommitAvatars(detail: {
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
  }): Promise<typeof detail> {
    const resolvedCommits = await Promise.all(
      detail.recentCommits.map(async (commit) => {
        const resolved = { ...commit };
        if (commit.committer?.avatar_url) {
          resolved.committer = {
            ...commit.committer,
            avatar_url: await this._resolveAvatarUrl(commit.committer.avatar_url),
          };
        }
        if (commit.author?.avatar_url) {
          resolved.author = {
            ...commit.author,
            avatar_url: await this._resolveAvatarUrl(commit.author.avatar_url),
          };
        }
        return resolved;
      }),
    );
    return { ...detail, recentCommits: resolvedCommits };
  }

  private async _resolveAvatarUrl(url: string): Promise<string> {
    if (!this._view) {
      logger.debug(`[avatar] no view, returning original url: ${url}`);
      return url;
    }
    logger.debug(`[avatar] resolving: ${url}`);
    try {
      const response = await fetch(url);
      logger.debug(`[avatar] response status: ${response.status} ${response.statusText}`);
      if (!response.ok) {
        logger.error(`[avatar] fetch failed: ${response.status} ${response.statusText}`);
        return url;
      }
      const buffer = await response.arrayBuffer();
      const base64 = Buffer.from(buffer).toString('base64');
      const contentType = response.headers.get('content-type') ?? 'image/png';
      logger.debug(`[avatar] resolved to data:${contentType};base64,${base64.slice(0, 40)}...`);
      return `data:${contentType};base64,${base64}`;
    } catch (error) {
      const err = userFacingErrorMessage(error);
      logger.error(`[avatar] error resolving ${url}: ${err}`);
      return url;
    }
  }
}
