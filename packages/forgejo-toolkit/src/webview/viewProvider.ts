import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { logger } from '../logger';
import { ForgejoClient } from '../api/client';
import type { ForgejoChangedFile } from '../api/types';
import { ConfigManager } from '../config';
import type { ForgejoInstance } from '@cpf23333-forgejo-toolkit/shared/webview/messages';
import { getWebviewContent } from './content';
import type { ReadmeContentProvider } from '../readmeProvider';
import { openReadmePreview } from '../readmeProvider';
import { WorktreeManager, WorktreeInfo } from '../worktree/worktreeManager';
import {
  cloneRepository,
  createWorktreeFromBranch,
  fetchPullRequestHead,
  findLocalRepo,
  openWorktree,
} from '../worktree/gitOperations';
import type { HostToWebviewMessage } from '@cpf23333-forgejo-toolkit/shared/webview/messages';

export class ForgejoToolkitViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'forgejoToolkitView';

  private _view?: vscode.WebviewView;
  private readonly _worktreeManager: WorktreeManager;

  constructor(
    private readonly _context: vscode.ExtensionContext,
    private readonly _extensionUri: vscode.Uri,
    private readonly _config: ConfigManager,
    private readonly _readmeProvider: ReadmeContentProvider,
  ) {
    this._worktreeManager = new WorktreeManager(
      _context,
      () => this._config.getWorktreeCacheDirectory(),
      () => this._config.getDefaultWorktreeCacheDirectory(),
    );
  }

  public resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken,
  ) {
    this._view = webviewView;

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this._extensionUri, 'out', 'webview')],
    };

    webviewView.webview.html = getWebviewContent(webviewView.webview, this._extensionUri.fsPath);

    webviewView.webview.onDidReceiveMessage(
      async (message) => {
        logger.debug(`Received message from webview: ${message.command}`);
        switch (message.command) {
          case 'getInstances':
            this._sendInstances();
            return;
          case 'getLocale': {
            const configured = vscode.workspace
              .getConfiguration('forgejoToolkit')
              .get<'en' | 'zh' | undefined>('locale');
            const locale: 'en' | 'zh' =
              configured && (configured === 'en' || configured === 'zh')
                ? configured
                : resolveLocale(vscode.env.language);
            const debug = vscode.workspace.getConfiguration('forgejoToolkit').get<boolean>('debug', false);
            this._reply('setLocale', { locale });
            this._reply('setDebug', { debug });
            this._updateViewTitle(locale);
            return;
          }
          case 'testConnection': {
            const { url, token } = message;
            if (typeof url !== 'string' || typeof token !== 'string') {
              this._reply('testConnectionResult', { success: false, error: 'Invalid input' });
              return;
            }
            try {
              const client = new ForgejoClient(url, token, logger);
              const user = await client.getCurrentUser();
              this._reply('testConnectionResult', { success: true, username: user.login });
            } catch (error) {
              const err = error instanceof Error ? error.message : String(error);
              logger.error(`testConnection failed: ${err}`);
              this._reply('testConnectionResult', { success: false, error: err });
            }
            return;
          }
          case 'saveInstance': {
            const { url, token } = message;
            if (typeof url !== 'string' || typeof token !== 'string') {
              this._reply('saveInstanceResult', { success: false, error: 'Invalid input' });
              return;
            }
            try {
              const client = new ForgejoClient(url, token, logger);
              const user = await client.getCurrentUser();

              const normalizedUrl = url.replace(/\/$/, '');
              const instance: ForgejoInstance = {
                id: `${new URL(normalizedUrl).hostname}-${user.login}`,
                url: normalizedUrl,
                token,
                name: `${user.login}@${new URL(normalizedUrl).hostname}`,
                username: user.login,
              };

              await this._config.addInstance(instance);
              this._sendInstances();
              this._reply('saveInstanceResult', { success: true });
              vscode.window.showInformationMessage(`Connected to Forgejo as ${user.login}`);
            } catch (error) {
              const err = error instanceof Error ? error.message : String(error);
              logger.error(`saveInstance failed: ${err}`);
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
          case 'openExternal':
            if (typeof message.url === 'string') {
              vscode.env.openExternal(vscode.Uri.parse(message.url));
            }
            return;
          case 'getRepositories': {
            const instance = this._findInstance(message.instanceId);
            if (!instance) {
              return;
            }
            try {
              const client = new ForgejoClient(instance.url, instance.token, logger);
              const repos = await client.getUserRepositories();
              this._reply('repositories', { instanceId: instance.id, repositories: repos });
            } catch (error) {
              const err = error instanceof Error ? error.message : String(error);
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
              const client = new ForgejoClient(instance.url, instance.token, logger);
              const issues = await client.getUserIssues(message.state ?? 'open');
              this._reply('myIssues', { instanceId: instance.id, issues });
            } catch (error) {
              const err = error instanceof Error ? error.message : String(error);
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
              const client = new ForgejoClient(instance.url, instance.token, logger);
              const pulls = await client.getUserPullRequests(message.state ?? 'open');
              this._reply('myPullRequests', { instanceId: instance.id, pullRequests: pulls });
            } catch (error) {
              const err = error instanceof Error ? error.message : String(error);
              logger.error(`getMyPullRequests failed for ${instance.name}: ${err}`);
              this._reply('myPullRequests', { instanceId: message.instanceId, error: err });
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
              const client = new ForgejoClient(instance.url, instance.token, logger);
              const detail = await client.getRepoDetail(owner, repo);
              const detailWithResolvedAvatars = await this._resolveCommitAvatars(detail);
              this._reply('repoDetail', {
                instanceId: instance.id,
                owner,
                repo,
                detail: detailWithResolvedAvatars,
              });
            } catch (error) {
              const err = error instanceof Error ? error.message : String(error);
              logger.error(`getRepoDetail failed for ${instance.name}/${owner}/${repo}: ${err}`);
              this._reply('repoDetail', { instanceId: message.instanceId, owner, repo, error: err });
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
              const client = new ForgejoClient(instance.url, instance.token, logger);
              const detail = await client.getIssueDetail(owner, repo, index);
              this._reply('issueDetail', {
                instanceId: instance.id,
                owner,
                repo,
                index,
                detail,
              });
            } catch (error) {
              const err = error instanceof Error ? error.message : String(error);
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
              const client = new ForgejoClient(instance.url, instance.token, logger);
              const detail = await client.getPullRequestDetail(owner, repo, index);
              this._reply('pullRequestDetail', {
                instanceId: instance.id,
                owner,
                repo,
                index,
                detail,
              });
            } catch (error) {
              const err = error instanceof Error ? error.message : String(error);
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
              const client = new ForgejoClient(instance.url, instance.token, logger);
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
                    changes: counts.changes ?? counts.additions ?? 0 + (counts.deletions ?? 0),
                  };
                });
              } catch {
                // counts are optional
              }

              logger.info(
                `getPullRequestFiles returned ${files.length} files for ${instance.name}/${owner}/${repo}#${index}: ${JSON.stringify(files.map((f) => ({ filename: f.filename, status: f.status, additions: f.additions, deletions: f.deletions })))}`,
              );
              this._reply('pullRequestFiles', {
                instanceId: instance.id,
                owner,
                repo,
                index,
                files,
              });
            } catch (error) {
              const err = error instanceof Error ? error.message : String(error);
              logger.error(`getPullRequestFiles failed for ${instance.name}/${owner}/${repo}#${index}: ${err}`);
              this._reply('pullRequestFiles', {
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
            const { instanceId, owner, repo, index, filename, status, baseSha, headSha } = message;
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
              const baseUri = this._buildDiffUri(instanceId, owner, repo, baseSha, filename, true, status);
              const headUri = this._buildDiffUri(instanceId, owner, repo, headSha, filename, false, status);
              const title = `${filename} (#${index})`;
              await vscode.commands.executeCommand('vscode.diff', baseUri, headUri, title);
            } catch (error) {
              const err = error instanceof Error ? error.message : String(error);
              logger.error(`openPullRequestDiff failed for ${owner}/${repo}#${index} ${filename}: ${err}`);
              vscode.window.showErrorMessage(`Unable to open diff: ${err}`);
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
                const baseUri = this._buildDiffUri(instanceId, owner, repo, baseSha, filename, true, status);
                const headUri = this._buildDiffUri(instanceId, owner, repo, headSha, filename, false, status);
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
            } catch (error) {
              const err = error instanceof Error ? error.message : String(error);
              logger.error(`openSelectedPullRequestDiffs failed for ${owner}/${repo}#${index}: ${err}`);
              vscode.window.showErrorMessage(`Unable to open selected diffs: ${err}`);
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
              const client = new ForgejoClient(instance.url, instance.token, logger);
              const issues = await client.getRepoIssues(owner, repo, message.state ?? 'open');
              this._reply('repoIssues', {
                instanceId: instance.id,
                owner,
                repo,
                state: message.state ?? 'open',
                issues,
              });
            } catch (error) {
              const err = error instanceof Error ? error.message : String(error);
              logger.error(`getRepoIssues failed for ${instance.name}/${owner}/${repo}: ${err}`);
              this._reply('repoIssues', {
                instanceId: message.instanceId,
                owner,
                repo,
                state: message.state ?? 'open',
                error: err,
              });
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
              const client = new ForgejoClient(instance.url, instance.token, logger);
              const pullRequests = await client.getRepoPullRequests(owner, repo, message.state ?? 'open');
              this._reply('repoPullRequests', {
                instanceId: instance.id,
                owner,
                repo,
                state: message.state ?? 'open',
                pullRequests,
              });
            } catch (error) {
              const err = error instanceof Error ? error.message : String(error);
              logger.error(`getRepoPullRequests failed for ${instance.name}/${owner}/${repo}: ${err}`);
              this._reply('repoPullRequests', {
                instanceId: message.instanceId,
                owner,
                repo,
                state: message.state ?? 'open',
                error: err,
              });
            }
            return;
          }
          case 'renderMarkdown': {
            const instance = this._findInstance(message.instanceId);
            if (!instance) {
              return;
            }
            const { text, key } = message;
            if (typeof text !== 'string' || typeof key !== 'string') {
              return;
            }
            try {
              const client = new ForgejoClient(instance.url, instance.token, logger);
              const html = await client.renderMarkdown(text, message.context);
              const htmlWithResolvedImages = await this._resolveImageUrls(html, instance);
              this._reply('renderedMarkdown', { key, html: htmlWithResolvedImages });
            } catch (error) {
              const err = error instanceof Error ? error.message : String(error);
              logger.error(`renderMarkdown failed for ${instance.name}: ${err}`);
              this._reply('renderedMarkdown', { key, error: err });
            }
            return;
          }
          case 'copyToClipboard': {
            const text = message.text;
            if (typeof text === 'string') {
              await vscode.env.clipboard.writeText(text);
              vscode.window.showInformationMessage('Copied to clipboard');
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
          case 'getWorktrees': {
            this._reply('worktreesList', { worktrees: this._worktreeManager.getWorktrees() });
            return;
          }
          case 'removeWorktree': {
            const { id } = message;
            if (typeof id === 'string') {
              await this._worktreeManager.removeWorktree(id);
              this._reply('worktreeRemoved', { id });
              this._reply('worktreesList', { worktrees: this._worktreeManager.getWorktrees() });
            }
            return;
          }
          case 'getWorktreeOpenMode': {
            this._reply('worktreeOpenMode', { mode: this._config.getWorktreeOpenMode() });
            return;
          }
          case 'setWorktreeOpenMode': {
            const mode = message.mode;
            if (mode === 'currentWindow' || mode === 'newWindow') {
              await this._config.setWorktreeOpenMode(mode);
              this._reply('worktreeOpenMode', { mode });
            }
            return;
          }
          case 'getWorktreeCacheDirectory': {
            const directory = this._config.getWorktreeCacheDirectory() ?? '';
            const defaultDirectory = this._config.getDefaultWorktreeCacheDirectory();
            this._reply('worktreeCacheDirectory', { directory, defaultDirectory });
            return;
          }
          case 'setWorktreeCacheDirectory': {
            const directory = message.directory;
            if (typeof directory === 'string') {
              await this._config.setWorktreeCacheDirectory(directory);
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
              openLabel: 'Select Cache Directory',
            });
            if (result && result.length > 0) {
              const directory = result[0].fsPath;
              await this._config.setWorktreeCacheDirectory(directory);
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
      },
      undefined,
      [],
    );

    webviewView.onDidChangeVisibility(() => {
      if (webviewView.visible) {
        this._sendInstances();
      }
    });
  }

  public openSettings() {
    this._view?.webview.postMessage({ command: 'openSettings' });
  }

  public openDashboard() {
    this._view?.webview.postMessage({ command: 'openDashboard' });
  }

  public refresh() {
    this._sendInstances();
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
    ref: string,
    filepath: string,
    isBase: boolean,
    status?: string,
  ): vscode.Uri {
    const params = { instanceId, owner, repo, ref, isBase, status };
    return vscode.Uri.from({
      scheme: 'forgejo-pr',
      path: `/${filepath}`,
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
      this._reply('instances', { data: this._config.getInstances() });
    }
  }

  private _reply<T extends HostToWebviewMessage['command']>(
    command: T,
    data: Omit<Extract<HostToWebviewMessage, { command: T }>, 'command'>,
  ) {
    this._view?.webview.postMessage({ command, ...data } as HostToWebviewMessage);
  }

  private async _handleOpenPrWorktree(message: { instanceId: string; owner: string; repo: string; index: number }) {
    const { instanceId, owner, repo, index } = message;
    const instance = this._findInstance(instanceId);
    if (!instance) {
      this._reply('worktreeError', { error: 'Instance not found' });
      return;
    }

    const existing = this._worktreeManager.findWorktree(instanceId, owner, repo, index);
    if (existing) {
      try {
        await openWorktree(existing.worktreePath, this._config.getWorktreeOpenMode() === 'newWindow');
        this._reply('worktreeOpened', { worktree: existing, existed: true });
      } catch (error) {
        const err = error instanceof Error ? error.message : String(error);
        this._reply('worktreeError', { error: err });
      }
      return;
    }

    try {
      const client = new ForgejoClient(instance.url, instance.token, logger);
      const pr = await client.getPullRequestDetail(owner, repo, index);
      const headBranch = pr.head?.ref;
      const headSha = pr.head?.sha;
      const baseBranch = pr.base?.ref ?? 'main';
      const prTitle = pr.title ?? `PR #${index}`;
      if (!headBranch || !headSha) {
        this._reply('worktreeError', { error: 'Could not determine PR head branch or sha' });
        return;
      }

      const cloneUrl = `${instance.url}/${owner}/${repo}.git`;
      const cacheDir = this._worktreeManager.getCacheDirectory();
      const localRepo = await findLocalRepo(instance.url, owner, repo);
      const sourceRepoPath = localRepo ?? path.join(cacheDir, 'repos', `${owner}-${repo}.git`);
      const sourceRepoExisted = localRepo
        ? true
        : await fs.promises
            .access(sourceRepoPath)
            .then(() => true)
            .catch(() => false);

      if (!sourceRepoExisted) {
        await cloneRepository(cloneUrl, sourceRepoPath, instance.token);
      }

      const localBranch = `pr-${index}-${headSha.slice(0, 7)}`;
      await fetchPullRequestHead(sourceRepoPath, 'origin', index, localBranch);

      const worktreePath = path.join(cacheDir, 'worktrees', `${owner}-${repo}-pr-${index}`);
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
      await this._worktreeManager.addWorktree(worktree);
      await openWorktree(worktreePath, this._config.getWorktreeOpenMode() === 'newWindow');
      this._reply('worktreeOpened', { worktree, existed: false });
    } catch (error) {
      const err = error instanceof Error ? error.message : String(error);
      logger.error(`openPrWorktree failed for ${owner}/${repo}#${index}: ${err}`);
      this._reply('worktreeError', { error: err });
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

  private async _resolveImageUrls(html: string, instance: ForgejoInstance): Promise<string> {
    const instanceBaseUrl = instance.url.replace(/\/$/, '');
    const imgSrcRegex = /<img[^\u003e]*\s+src=["']([^"']+)["'][^\u003e]*>/gi;
    const replacements: Array<{ start: number; end: number; value: string }> = [];
    let match;
    while ((match = imgSrcRegex.exec(html)) !== null) {
      const src = match[1];
      if (!src || src.startsWith('data:')) {
        continue;
      }
      let absoluteUrl: string;
      try {
        absoluteUrl = new URL(src, instanceBaseUrl).href;
      } catch {
        continue;
      }
      try {
        const response = await fetch(absoluteUrl, {
          headers: { Authorization: `token ${instance.token}` },
        });
        if (!response.ok) {
          continue;
        }
        const buffer = await response.arrayBuffer();
        const base64 = Buffer.from(buffer).toString('base64');
        const contentType = response.headers.get('content-type') ?? 'image/png';
        replacements.push({
          start: match.index,
          end: imgSrcRegex.lastIndex,
          value: `data:${contentType};base64,${base64}`,
        });
      } catch {
        // ignore image fetch errors, keep original url
      }
    }
    let result = html;
    for (let i = replacements.length - 1; i >= 0; i--) {
      const { start, end, value } = replacements[i];
      const original = result.slice(start, end);
      const srcMatch = /src=["'][^"']+["']/i.exec(original);
      if (!srcMatch) {
        continue;
      }
      const srcStart = start + srcMatch.index;
      result = result.slice(0, srcStart + 5) + value + result.slice(srcStart + srcMatch[0].length - 1);
    }
    return result;
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
      const err = error instanceof Error ? error.message : String(error);
      logger.error(`[avatar] error resolving ${url}: ${err}`);
      return url;
    }
  }
}

function resolveLocale(vscodeLanguage: string): 'en' | 'zh' {
  const lang = vscodeLanguage.toLowerCase();
  if (lang.startsWith('zh')) {
    return 'zh';
  }
  return 'en';
}
