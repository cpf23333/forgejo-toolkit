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
import { createRequire } from 'module';
import { buildRepoFileUri } from '../repoFileProvider';
import { WorktreeManager, WorktreeInfo } from '../worktree/worktreeManager';
import {
  cloneRepository,
  createWorktreeFromBranch,
  fetchPullRequestHead,
  findLocalRepo,
  getRemoteUrl,
  isCurrentWorkspaceBaseRepo,
  isGitRepository,
  normalizeGitUrl,
  openWorktree,
  sanitizeForPath,
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

    const require = createRequire(__filename);
    const codiconCssPath = require.resolve('@vscode/codicons/dist/codicon.css');
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [
        vscode.Uri.joinPath(this._extensionUri, 'out', 'webview'),
        vscode.Uri.file(path.dirname(codiconCssPath)),
      ],
    };

    webviewView.webview.html = getWebviewContent(webviewView.webview, this._extensionUri.fsPath, {
      codiconCssPath,
    });

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
          case 'editInstance': {
            const { id, url, token } = message;
            if (typeof id !== 'string' || typeof url !== 'string' || typeof token !== 'string') {
              this._reply('saveInstanceResult', { success: false, error: 'Invalid input' });
              return;
            }
            try {
              const client = new ForgejoClient(url, token, logger);
              const user = await client.getCurrentUser();

              const normalizedUrl = url.replace(/\/$/, '');
              await this._config.updateInstance(id, {
                url: normalizedUrl,
                token,
                name: `${user.login}@${new URL(normalizedUrl).hostname}`,
                username: user.login,
              });
              this._sendInstances();
              this._reply('saveInstanceResult', { success: true });
              vscode.window.showInformationMessage(`Updated Forgejo instance for ${user.login}`);
            } catch (error) {
              const err = error instanceof Error ? error.message : String(error);
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
              const client = new ForgejoClient(instance.url, instance.token, logger);
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
              const err = error instanceof Error ? error.message : String(error);
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
              const client = new ForgejoClient(instance.url, instance.token, logger);
              const item = await client.createIssue(owner, repo, data);
              this._reply('issueCreated', {
                instanceId: instance.id,
                owner,
                repo,
                index: (item as { number?: number }).number ?? 0,
                item,
              });
            } catch (error) {
              const err = error instanceof Error ? error.message : String(error);
              logger.error(`createIssue failed for ${instance.name}/${owner}/${repo}: ${err}`);
              this._reply('issueCreated', { instanceId: message.instanceId, owner, repo, index: 0, error: err });
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
              const client = new ForgejoClient(instance.url, instance.token, logger);
              const item = await client.editIssue(owner, repo, index, data);
              this._reply('issueUpdated', {
                instanceId: instance.id,
                owner,
                repo,
                index,
                item,
              });
            } catch (error) {
              const err = error instanceof Error ? error.message : String(error);
              logger.error(`editIssue failed for ${instance.name}/${owner}/${repo}#${index}: ${err}`);
              this._reply('issueUpdated', { instanceId: message.instanceId, owner, repo, index, error: err });
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
              const client = new ForgejoClient(instance.url, instance.token, logger);
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
              const err = error instanceof Error ? error.message : String(error);
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
              const client = new ForgejoClient(instance.url, instance.token, logger);
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
              const err = error instanceof Error ? error.message : String(error);
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
              const client = new ForgejoClient(instance.url, instance.token, logger);
              const item = await client.createPullRequest(owner, repo, data);
              this._reply('pullRequestCreated', {
                instanceId: instance.id,
                owner,
                repo,
                index: (item as { number?: number }).number ?? 0,
                item,
              });
            } catch (error) {
              const err = error instanceof Error ? error.message : String(error);
              logger.error(`createPullRequest failed for ${instance.name}/${owner}/${repo}: ${err}`);
              this._reply('pullRequestCreated', {
                instanceId: message.instanceId,
                owner,
                repo,
                index: 0,
                error: err,
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
              const client = new ForgejoClient(instance.url, instance.token, logger);
              const item = await client.editPullRequest(owner, repo, index, data);
              this._reply('pullRequestUpdated', {
                instanceId: instance.id,
                owner,
                repo,
                index,
                item,
              });
            } catch (error) {
              const err = error instanceof Error ? error.message : String(error);
              logger.error(`editPullRequest failed for ${instance.name}/${owner}/${repo}#${index}: ${err}`);
              this._reply('pullRequestUpdated', {
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
              const client = new ForgejoClient(instance.url, instance.token, logger);
              const comments = await client.getPullRequestCommentsAndTimeline(owner, repo, index);
              this._reply('pullRequestCommentsAndTimeline', {
                instanceId: instance.id,
                owner,
                repo,
                index,
                comments,
              });
            } catch (error) {
              const err = error instanceof Error ? error.message : String(error);
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
              const client = new ForgejoClient(instance.url, instance.token, logger);
              const commits = await client.getPullRequestCommits(owner, repo, index);
              this._reply('pullRequestCommits', {
                instanceId: instance.id,
                owner,
                repo,
                index,
                commits,
              });
            } catch (error) {
              const err = error instanceof Error ? error.message : String(error);
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
              const client = new ForgejoClient(instance.url, instance.token, logger);
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
              const err = error instanceof Error ? error.message : String(error);
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
              const err = error instanceof Error ? error.message : String(error);
              logger.error(`openRepoFile failed for ${owner}/${repo}/${path}: ${err}`);
              vscode.window.showErrorMessage(`Unable to open file: ${err}`);
            }
            return;
          }
          case 'getRepoRefs': {
            const { instanceId, owner, repo } = message;
            if (
              typeof instanceId !== 'string' ||
              typeof owner !== 'string' ||
              typeof repo !== 'string'
            ) {
              return;
            }
            const instance = this._findInstance(instanceId);
            if (!instance) {
              return;
            }
            try {
              const client = new ForgejoClient(instance.url, instance.token, logger);
              const [branches, tags, releases] = await Promise.all([
                client.getRepoBranches(owner, repo),
                client.getRepoTags(owner, repo),
                client.getRepoReleases(owner, repo),
              ]);
              this._reply('repoRefs', { instanceId, owner, repo, branches, tags, releases });
            } catch (error) {
              const err = error instanceof Error ? error.message : String(error);
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
              const client = new ForgejoClient(instance.url, instance.token, logger);
              const oldRef = typeof oldRefName === 'string' ? oldRefName : undefined;
              await client.createBranch(owner, repo, { new_branch_name: newBranchName, old_ref_name: oldRef });
              this._reply('repoBranchCreated', { instanceId, owner, repo, branch: newBranchName });
            } catch (error) {
              const err = error instanceof Error ? error.message : String(error);
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
              const client = new ForgejoClient(instance.url, instance.token, logger);
              await client.deleteBranch(owner, repo, branch);
              this._reply('repoBranchDeleted', { instanceId, owner, repo, branch });
            } catch (error) {
              const err = error instanceof Error ? error.message : String(error);
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
              const client = new ForgejoClient(instance.url, instance.token, logger);
              await client.createTag(owner, repo, {
                tag_name: tagName,
                target: typeof target === 'string' ? target : undefined,
                message: typeof tagMessage === 'string' ? tagMessage : undefined,
              });
              this._reply('repoTagCreated', { instanceId, owner, repo, tag: tagName });
            } catch (error) {
              const err = error instanceof Error ? error.message : String(error);
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
              const client = new ForgejoClient(instance.url, instance.token, logger);
              await client.deleteTag(owner, repo, tag);
              this._reply('repoTagDeleted', { instanceId, owner, repo, tag });
            } catch (error) {
              const err = error instanceof Error ? error.message : String(error);
              logger.error(`deleteRepoTag failed for ${owner}/${repo}/${tag}: ${err}`);
              this._reply('repoTagDeleted', { instanceId, owner, repo, tag, error: err });
            }
            return;
          }
          case 'createRepoRelease': {
            const { instanceId, owner, repo, tagName, name, body, targetCommitish, prerelease, draft, hideArchiveLinks } = message;
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
              const client = new ForgejoClient(instance.url, instance.token, logger);
              await client.createRelease(owner, repo, {
                tag_name: tagName,
                name: typeof name === 'string' ? name : undefined,
                body: typeof body === 'string' ? body : undefined,
                target_commitish: typeof targetCommitish === 'string' ? targetCommitish : undefined,
                prerelease: typeof prerelease === 'boolean' ? prerelease : undefined,
                draft: typeof draft === 'boolean' ? draft : undefined,
                hide_archive_links: typeof hideArchiveLinks === 'boolean' ? hideArchiveLinks : undefined,
              });
              this._reply('repoReleaseCreated', { instanceId, owner, repo, release: tagName });
            } catch (error) {
              const err = error instanceof Error ? error.message : String(error);
              logger.error(`createRepoRelease failed for ${owner}/${repo}/${tagName}: ${err}`);
              this._reply('repoReleaseCreated', { instanceId, owner, repo, release: tagName, error: err });
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
              const client = new ForgejoClient(instance.url, instance.token, logger);
              await client.deleteRelease(owner, repo, id);
              this._reply('repoReleaseDeleted', { instanceId, owner, repo, release: String(id) });
            } catch (error) {
              const err = error instanceof Error ? error.message : String(error);
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
              const client = new ForgejoClient(instance.url, instance.token, logger);
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
              const err = error instanceof Error ? error.message : String(error);
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
              const client = new ForgejoClient(instance.url, instance.token, logger);
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
              const err = error instanceof Error ? error.message : String(error);
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
              const client = new ForgejoClient(instance.url, instance.token, logger);
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
              const err = error instanceof Error ? error.message : String(error);
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
            const { id, message: confirmMessage } = message;
            if (typeof id !== 'string' || typeof confirmMessage !== 'string') {
              return;
            }
            const result = await vscode.window.showInformationMessage(
              confirmMessage,
              { modal: true },
              'Yes',
              'No',
            );
            this._reply('showConfirmResult', { id, confirmed: result === 'Yes' });
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
            if (mode === 'ask' || mode === 'currentWindow' || mode === 'newWindow') {
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
      this._reply('worktreeError', { error: vscode.l10n.t('Instance not found') });
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
      try {
        await openWorktree(existing.worktreePath, openInNewWindow);
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
        this._reply('worktreeError', { error: vscode.l10n.t('Could not determine PR head branch or sha') });
        return;
      }

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
          this._reply('worktreeCancelled', { instanceId, owner, repo, index });
          return;
        }

        if (choice.value === 'clone') {
          sourceRepoPath = cacheRepoPath;
          if (!cacheRepoExisted) {
            await cloneRepository(cloneUrl, sourceRepoPath, instance.token);
          }
        } else {
          const selected = await vscode.window.showOpenDialog({
            canSelectFiles: false,
            canSelectFolders: true,
            canSelectMany: false,
            openLabel: vscode.l10n.t('Select repository'),
          });
          if (!selected || selected.length === 0) {
            this._reply('worktreeCancelled', { instanceId, owner, repo, index });
            return;
          }
          sourceRepoPath = selected[0].fsPath;
          if (!(await isGitRepository(sourceRepoPath))) {
            this._reply('worktreeError', { error: vscode.l10n.t('Selected folder is not a git repository') });
            return;
          }
          const remote = await getRemoteUrl(sourceRepoPath);
          const normalizedInstanceUrl = instance.url.replace(/\/$/, '');
          const expectedUrls = [
            `${normalizedInstanceUrl}/${owner}/${repo}.git`,
            `${normalizedInstanceUrl}/${owner}/${repo}`,
          ];
          if (!remote || !expectedUrls.some((url) => normalizeGitUrl(remote) === normalizeGitUrl(url))) {
            this._reply('worktreeError', {
              error: vscode.l10n.t('Selected repository does not match the PR base repository'),
            });
            return;
          }
        }
      }

      const sanitizedTitle = sanitizeForPath(prTitle);
      const titleSuffix = sanitizedTitle ? `-${sanitizedTitle}` : '';
      const worktreePath = path.join(cacheDir, 'worktrees', `${owner}-${repo}-pr-${index}${titleSuffix}`);

      const worktreeExisted = await fs.promises
        .access(worktreePath)
        .then(() => true)
        .catch(() => false);

      if (worktreeExisted) {
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
        await openWorktree(worktreePath, openInNewWindow);
        this._reply('worktreeOpened', { worktree, existed: true });
        return;
      }

      const localBranch = `pr-${index}-${headSha.slice(0, 7)}`;
      await fetchPullRequestHead(sourceRepoPath, 'origin', index, localBranch);

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
      await openWorktree(worktreePath, openInNewWindow);
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
