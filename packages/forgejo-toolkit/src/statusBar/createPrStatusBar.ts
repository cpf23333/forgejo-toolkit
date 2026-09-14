import * as path from 'path';
import * as vscode from 'vscode';
import { ForgejoClient } from '../api/client';
import type { ForgejoPullRequest } from '../api/types';
import type { ConfigManager } from '../config';
import { logger } from '../logger';
import { detectLinkedRepository, getCurrentBranch, getGitHeadPath } from '../worktree/gitOperations';
import { userFacingErrorMessage } from '../api/errors';

const REFRESH_DEBOUNCE_MS = 300;
const OPEN_PR_CACHE_TTL_MS = 60_000;

interface OpenPrCacheEntry {
  value: number | undefined;
  expiresAt: number;
}

/**
 * Whether an open pull request's head is the given branch of the current
 * repository. A fork's same-named branch must not match, so when the API
 * reports the head repository it has to be the current one. head.repo is null
 * when the fork was deleted; then fall back to the label, which is
 * "<owner>:<branch>" cross-repo and "<branch>" within the same repository.
 */
function isOpenPrForBranch(pr: ForgejoPullRequest, branch: string, owner: string, repo: string): boolean {
  const head = pr.head;
  if (!head?.ref || head.ref !== branch) {
    return false;
  }
  const fullName = head.repo?.full_name;
  if (fullName) {
    return fullName.toLowerCase() === `${owner}/${repo}`.toLowerCase();
  }
  const label = head.label;
  if (!label) {
    return false;
  }
  if (label === branch) {
    return true;
  }
  if (!label.endsWith(`:${branch}`)) {
    return false;
  }
  const labelOwner = label.slice(0, label.length - branch.length - 1);
  return labelOwner.toLowerCase() === owner.toLowerCase();
}

/**
 * Shows a context-aware "Create PR" button in the status bar for the workspace
 * repository linked to a configured Forgejo instance.
 */
export class CreatePrStatusBarController implements vscode.Disposable {
  private readonly _item: vscode.StatusBarItem;
  private readonly _disposables: vscode.Disposable[] = [];
  private _headWatchers: vscode.Disposable[] = [];
  private _watchedHeadPath: string | undefined;
  private _refreshTimer: ReturnType<typeof setTimeout> | undefined;
  private _generation = 0;
  // Session-level cache: the default branch rarely changes, and being briefly
  // wrong about it only affects whether the button appears, so no TTL.
  private readonly _defaultBranchCache = new Map<string, string | undefined>();
  // Short TTL: a PR merged or closed outside the extension must not leave the
  // status bar stale for the whole session.
  private readonly _openPrCache = new Map<string, OpenPrCacheEntry>();

  constructor(private readonly _config: ConfigManager) {
    // Slightly below the git extension's branch item (priority 100) so the
    // button sits right next to the current branch indicator.
    this._item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 99);
    this._disposables.push(
      this._item,
      this._config.onInstancesChanged(() => this.scheduleRefresh()),
      vscode.workspace.onDidChangeWorkspaceFolders(() => this.scheduleRefresh()),
      // In multi-repository workspaces the linked repository follows the
      // active editor; re-resolve when it changes (debounced).
      vscode.window.onDidChangeActiveTextEditor(() => this.scheduleRefresh()),
    );
    this.scheduleRefresh();
  }

  public dispose(): void {
    clearTimeout(this._refreshTimer);
    this._generation += 1;
    for (const disposable of this._disposables) {
      disposable.dispose();
    }
    this._disposeHeadWatchers();
  }

  /** Debounced refresh used by event triggers. */
  public scheduleRefresh(): void {
    clearTimeout(this._refreshTimer);
    this._refreshTimer = setTimeout(() => {
      this.refresh().catch((error: unknown) => {
        logger.error(`[createPrStatusBar] refresh failed: ${userFacingErrorMessage(error)}`);
      });
    }, REFRESH_DEBOUNCE_MS);
  }

  /** Called when a pull request is created, merged, or closed through the extension. */
  public notifyPullRequestsChanged(): void {
    this._openPrCache.clear();
    this.scheduleRefresh();
  }

  public async refresh(): Promise<void> {
    const generation = ++this._generation;
    const isStale = () => generation !== this._generation;
    try {
      const linked = await detectLinkedRepository(this._config.getInstances());
      if (isStale()) {
        return;
      }
      const headPath = linked ? await getGitHeadPath(linked.localPath) : undefined;
      if (isStale()) {
        return;
      }
      this._setHeadWatcher(headPath);
      if (!linked) {
        this._item.hide();
        return;
      }
      const branch = await getCurrentBranch(linked.localPath);
      if (isStale()) {
        return;
      }
      if (!branch) {
        this._item.hide();
        return;
      }
      const instance = this._config.getInstances().find((i) => i.id === linked.instanceId);
      if (!instance) {
        this._item.hide();
        return;
      }

      const client = new ForgejoClient(instance.url, instance.token, logger, instance.syncApiUrlsToInstanceUrl);
      const repoKey = `${linked.instanceId}/${linked.owner}/${linked.repo}`;
      if (!this._defaultBranchCache.has(repoKey)) {
        const detail = await client.getRepoDetail(linked.owner, linked.repo);
        this._defaultBranchCache.set(repoKey, detail.repository.default_branch);
      }
      if (isStale()) {
        return;
      }
      const defaultBranch = this._defaultBranchCache.get(repoKey);
      if (!defaultBranch || branch === defaultBranch) {
        this._item.hide();
        return;
      }

      const prKey = `${repoKey}:${branch}`;
      const cachedPr = this._openPrCache.get(prKey);
      if (!cachedPr || cachedPr.expiresAt <= Date.now()) {
        const pulls = await client.getRepoPullRequests(linked.owner, linked.repo, 'open');
        // Only the first page of open pull requests is checked; a PR for this
        // branch beyond the default page size will not be detected.
        const match = pulls.find((pr) => isOpenPrForBranch(pr, branch, linked.owner, linked.repo));
        this._openPrCache.set(prKey, { value: match?.number, expiresAt: Date.now() + OPEN_PR_CACHE_TTL_MS });
      }
      if (isStale()) {
        return;
      }
      const prNumber = this._openPrCache.get(prKey)?.value;

      if (prNumber !== undefined) {
        this._item.text = `$(git-pull-request) PR #${prNumber}`;
        this._item.tooltip = vscode.l10n.t('Open pull request #{0} for branch "{1}"', prNumber, branch);
        this._item.command = {
          command: 'forgejoToolkit.createPrFromCurrentBranch',
          title: vscode.l10n.t('Open Pull Request'),
          arguments: [{ index: prNumber }],
        };
      } else {
        this._item.text = `$(git-pull-request-create) ${vscode.l10n.t('Create PR')}`;
        this._item.tooltip = vscode.l10n.t('Create a pull request from branch "{0}"', branch);
        this._item.command = 'forgejoToolkit.createPrFromCurrentBranch';
      }
      this._item.show();
    } catch (error) {
      // A failed lookup (e.g. a transient network error) is not proof that the
      // button should disappear — keep the last known state and only log.
      logger.error(`[createPrStatusBar] refresh failed: ${userFacingErrorMessage(error)}`);
    }
  }

  /**
   * Watch the real HEAD file of the linked repository: the git root can sit
   * above the workspace folder, and linked worktrees keep HEAD in the main
   * repository's .git/worktrees/<name>/ directory. Rebuilds the watcher only
   * when the resolved path changes.
   */
  private _setHeadWatcher(headPath: string | undefined): void {
    if (headPath === this._watchedHeadPath) {
      return;
    }
    this._watchedHeadPath = headPath;
    this._disposeHeadWatchers();
    if (!headPath) {
      return;
    }
    // Branch switches rewrite HEAD, so watching it catches checkouts.
    const watcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(path.dirname(headPath), path.basename(headPath)),
    );
    watcher.onDidChange(() => this.scheduleRefresh());
    watcher.onDidCreate(() => this.scheduleRefresh());
    watcher.onDidDelete(() => this.scheduleRefresh());
    this._headWatchers.push(watcher);
  }

  private _disposeHeadWatchers(): void {
    for (const watcher of this._headWatchers) {
      watcher.dispose();
    }
    this._headWatchers = [];
  }
}
