import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { deleteBranch, removeWorktreeAndPrune } from './gitOperations';

export interface WorktreeInfo {
  id: string;
  instanceId: string;
  owner: string;
  repo: string;
  /**
   * What the worktree was created for. Records predating this field are PR
   * worktrees, so `undefined` is treated as `'pr'`. Issue worktrees reuse
   * `prIndex`/`prTitle` for the issue number/title and leave `headSha` empty.
   */
  kind?: 'pr' | 'issue';
  prIndex: number;
  prTitle: string;
  headBranch: string;
  headSha: string;
  baseBranch: string;
  sourceRepoPath: string;
  worktreePath: string;
  createdAt: number;
}

const WORKTREES_KEY = 'forgejoToolkit.worktrees';
const CACHE_REPO_USAGE_KEY = 'forgejoToolkit.cacheRepoUsage';

/**
 * Serializes every globalState read-modify-write cycle in this module.
 * addWorktree/removeWorktree/forgetWorktree and the cache-usage writes all
 * read the persisted array, transform it, and write it back; two overlapping
 * cycles would silently drop one side's change (an orphaned worktree record,
 * or a bare cache clone evicted by the LRU sweep while still in use). The
 * queue is module-level because every WorktreeManager instance in this
 * extension host persists to the same globalState keys. A failed task must
 * not poison the queue, so each link starts by swallowing the previous
 * rejection (the caller still sees it through the returned promise).
 */
let globalStateWriteQueue: Promise<unknown> = Promise.resolve();

function enqueueGlobalStateWrite<T>(task: () => Promise<T>): Promise<T> {
  const run = globalStateWriteQueue
    .catch(() => {
      // keep the queue alive after a failed write
    })
    .then(task);
  globalStateWriteQueue = run;
  return run;
}

/** Cached bare repositories unused for this long are deleted by the LRU sweep. */
export const CACHE_REPO_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
/** Beyond this many cached bare repositories, the least recently used are deleted. */
export const CACHE_REPO_MAX_COUNT = 20;

/**
 * Verify that a directory can serve as the worktree cache: create it when it
 * does not exist yet, then probe writability with a temporary file. Throws
 * when the directory cannot be created or written to.
 */
export async function validateCacheDirectory(directory: string): Promise<void> {
  await fs.promises.mkdir(directory, { recursive: true });
  const probe = path.join(directory, `.write-test-${process.pid}-${Date.now()}`);
  try {
    await fs.promises.writeFile(probe, '');
  } finally {
    await fs.promises.rm(probe, { force: true });
  }
}

export class WorktreeManager {
  constructor(
    private context: vscode.ExtensionContext,
    private getCustomCacheDirectory?: () => string | undefined,
    private getDefaultCacheDirectory?: () => string,
  ) {}

  getWorktrees(): WorktreeInfo[] {
    return this.context.globalState.get<WorktreeInfo[]>(WORKTREES_KEY, []);
  }

  getWorktree(id: string): WorktreeInfo | undefined {
    return this.getWorktrees().find((w) => w.id === id);
  }

  findWorktree(instanceId: string, owner: string, repo: string, prIndex: number): WorktreeInfo | undefined {
    return this.getWorktrees().find(
      (w) =>
        (w.kind ?? 'pr') === 'pr' &&
        w.instanceId === instanceId &&
        w.owner === owner &&
        w.repo === repo &&
        w.prIndex === prIndex,
    );
  }

  async addWorktree(info: WorktreeInfo): Promise<void> {
    return enqueueGlobalStateWrite(async () => {
      const worktrees = this.getWorktrees().filter((w) => w.id !== info.id);
      worktrees.push(info);
      await this.context.globalState.update(WORKTREES_KEY, worktrees);
    });
  }

  /**
   * Remove a worktree: run `git worktree remove` first (falling back to prune
   * + manual delete inside removeWorktreeAndPrune) so the source repository's
   * .git/worktrees metadata and the branch's checked-out state are cleaned up,
   * then drop the record. When the source repository itself is gone from disk
   * (deleted manually) the git steps cannot run — the worktree directory
   * (inside the cache directory, a controlled generated path) is removed
   * best-effort before the record is dropped, or it would be orphaned
   * forever with no entry point left to clean it up. On failure the record
   * is kept so the
   * UI retains an entry point for retry, and the error is thrown for the
   * caller to surface (the view provider forwards it to the webview as
   * `worktreeError`) — this method must not also toast, or the user would see
   * the error twice.
   *
   * PR worktrees also delete their throwaway local branch (`pr-<n>-<sha7>`):
   * `git worktree remove` never removes branches, so every PR head update
   * would otherwise accumulate one dead branch. Issue worktrees keep their
   * branch — it is the user's own work branch.
   *
   * The whole read-snapshot → git operations → write-back sequence runs inside
   * the module write queue: the git steps can take seconds, and a record added
   * meanwhile must not be lost when the (stale) snapshot is written back.
   * Serializing the git operations too is the accepted trade-off — removals
   * are rare and user-triggered.
   */
  async removeWorktree(id: string): Promise<void> {
    return enqueueGlobalStateWrite(async () => {
      const worktrees = this.getWorktrees();
      const target = worktrees.find((w) => w.id === id);
      if (!target) {
        return;
      }
      const sourceExists = await fs.promises.access(target.sourceRepoPath).then(
        () => true,
        () => false,
      );
      if (sourceExists) {
        await removeWorktreeAndPrune(target.sourceRepoPath, target.worktreePath);
        if ((target.kind ?? 'pr') === 'pr' && target.headSha) {
          const localBranch = `pr-${target.prIndex}-${target.headSha.slice(0, 7)}`;
          await deleteBranch(target.sourceRepoPath, localBranch).catch(() => undefined);
        }
      } else {
        await fs.promises.rm(target.worktreePath, { recursive: true, force: true }).catch(() => undefined);
      }
      await this.context.globalState.update(
        WORKTREES_KEY,
        worktrees.filter((w) => w.id !== id),
      );
    });
  }

  /** Drop the record without touching the disk (used when the directory is already gone). */
  async forgetWorktree(id: string): Promise<void> {
    return enqueueGlobalStateWrite(async () => {
      await this.context.globalState.update(
        WORKTREES_KEY,
        this.getWorktrees().filter((w) => w.id !== id),
      );
    });
  }

  getCacheDirectory(): string {
    const custom = this.getCustomCacheDirectory?.();
    if (custom && custom.trim()) {
      return custom.trim();
    }
    return this.getDefaultCacheDirectory?.() ?? vscode.Uri.joinPath(this.context.globalStorageUri, 'worktrees').fsPath;
  }

  private _getCacheRepoUsage(): Record<string, number> {
    return this.context.globalState.get<Record<string, number>>(CACHE_REPO_USAGE_KEY, {});
  }

  /** Stamps a cached bare repository as used now (LRU recency for the sweep). */
  async touchCachedRepo(cacheRepoPath: string): Promise<void> {
    return enqueueGlobalStateWrite(async () => {
      const usage = { ...this._getCacheRepoUsage() };
      usage[path.resolve(cacheRepoPath)] = Date.now();
      await this.context.globalState.update(CACHE_REPO_USAGE_KEY, usage);
    });
  }

  /**
   * LRU sweep for the bare clone cache (`<cacheDir>/repos/*.git`), which is
   * otherwise never cleaned. Deletes repositories unused for
   * CACHE_REPO_MAX_AGE_MS and, when more than CACHE_REPO_MAX_COUNT remain,
   * the least recently used ones. Repositories referenced by a recorded
   * worktree are never deleted (their worktrees' git metadata points into
   * them), and deletion is restricted to direct `*.git` children of the
   * repos directory. Triggered lazily from worktree operations — no timer.
   * Returns the names of the removed repositories. The sweep reads the
   * worktree records and rewrites the usage map, so it runs inside the module
   * write queue like the other globalState mutations (a concurrent
   * touchCachedRepo must not be overwritten by a stale usage snapshot).
   */
  async cleanupCachedRepos(now: number = Date.now()): Promise<string[]> {
    return enqueueGlobalStateWrite(() => this._cleanupCachedRepos(now));
  }

  private async _cleanupCachedRepos(now: number): Promise<string[]> {
    const reposDir = path.join(this.getCacheDirectory(), 'repos');
    const resolvedReposDir = path.resolve(reposDir);
    const entries = await fs.promises.readdir(reposDir, { withFileTypes: true }).catch(() => [] as fs.Dirent[]);
    const candidates = entries.filter((entry) => entry.isDirectory() && entry.name.endsWith('.git'));
    if (candidates.length === 0) {
      return [];
    }

    // Defense in depth: only ever delete direct children of the repos dir.
    const repos = candidates
      .map((entry) => path.resolve(reposDir, entry.name))
      .filter((repoPath) => path.dirname(repoPath) === resolvedReposDir);
    const activePaths = new Set(this.getWorktrees().map((w) => path.resolve(w.sourceRepoPath)));

    const usage = { ...this._getCacheRepoUsage() };
    // Repositories that predate usage tracking get a fresh timestamp instead
    // of being treated as ancient and wiped on the first sweep.
    const tracked = repos.map((repoPath) => {
      const lastUsed = usage[repoPath] ?? now;
      usage[repoPath] = lastUsed;
      return { repoPath, lastUsed };
    });

    const removable = tracked.filter(({ repoPath }) => !activePaths.has(repoPath));
    const victims = new Set(
      removable.filter(({ lastUsed }) => now - lastUsed > CACHE_REPO_MAX_AGE_MS).map(({ repoPath }) => repoPath),
    );
    const survivors = removable
      .filter(({ repoPath }) => !victims.has(repoPath))
      .sort((a, b) => a.lastUsed - b.lastUsed);
    while (survivors.length > CACHE_REPO_MAX_COUNT) {
      victims.add(survivors.shift()!.repoPath);
    }

    const removed: string[] = [];
    for (const { repoPath } of tracked) {
      if (!victims.has(repoPath)) {
        continue;
      }
      try {
        await fs.promises.rm(repoPath, { recursive: true, force: true });
        removed.push(path.basename(repoPath));
        delete usage[repoPath];
      } catch {
        // A repo that cannot be deleted stays (and keeps its usage entry);
        // the next sweep retries.
      }
    }
    // Drop usage entries for repos under this directory that no longer exist
    // on disk (e.g. deleted manually), so the map cannot grow unboundedly.
    const onDisk = new Set(repos);
    for (const key of Object.keys(usage)) {
      if (path.dirname(key) === resolvedReposDir && !onDisk.has(key)) {
        delete usage[key];
      }
    }
    await this.context.globalState.update(CACHE_REPO_USAGE_KEY, usage);
    return removed;
  }
}
