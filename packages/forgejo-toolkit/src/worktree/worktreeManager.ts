import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { logger } from '../logger';
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
 * Worktree checkouts abandoned for this long are deleted by the same lazy sweep.
 * A checkout of a large repository costs tens to hundreds of MiB, and a record
 * that was forgotten (or whose source clone was swept) leaves nothing else that
 * could ever clean it up. The age is read from the newest mtime among the
 * checkout's directory and its immediate entries (see isAgedOut).
 */
export const WORKTREE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

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
   * first, or it would be orphaned forever with no entry point left to clean it
   * up; a failed delete keeps the record and throws. On failure of either path
   * the record is kept so the UI retains an entry point for retry, and the error
   * is thrown for the caller to surface (the view provider forwards it to the
   * webview as `worktreeError`) — this method must not also toast, or the user
   * would see the error twice.
   *
   * PR worktrees also delete their throwaway local branch (`pr-<n>-<sha7>`):
   * `git worktree remove` never removes branches, so every PR head update
   * would otherwise accumulate one dead branch. Issue worktrees keep their
   * branch — it is the user's own work branch.
   *
   * The whole read-snapshot → git operations → write-back sequence runs inside
   * the module write queue, so two removals in this host cannot interleave; the
   * write-back itself re-reads the records first (see the merge comment there),
   * which is what keeps an entry another *window* added during the slow git
   * steps. Serializing the git operations too is the accepted trade-off —
   * removals are rare and user-triggered.
   *
   * Returns false when there is no record for `id`: the caller then has nothing
   * to report as removed, and the checkout (if it still exists) was not touched
   * because this record set never knew its path.
   */
  async removeWorktree(id: string): Promise<boolean> {
    return enqueueGlobalStateWrite(async () => {
      const worktrees = this.getWorktrees();
      const target = worktrees.find((w) => w.id === id);
      if (!target) {
        return false;
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
        // The record is the only entry point to the orphaned checkout, so it may
        // be dropped only once the directory is really gone. A delete can fail
        // for reasons the user can act on (a file still open in another process
        // on Windows, permissions, an I/O error), and swallowing that failure
        // dropped the record and reported success while the directory stayed on
        // disk with nothing left pointing at it — unreachable forever. Keep the
        // record instead, and throw so the caller surfaces the reason once
        // through `worktreeError` (same contract as a failed git removal).
        try {
          await fs.promises.rm(target.worktreePath, { recursive: true, force: true });
        } catch (error) {
          throw new Error(
            vscode.l10n.t(
              'Could not delete the worktree directory "{0}": {1}',
              target.worktreePath,
              error instanceof Error ? error.message : String(error),
            ),
          );
        }
      }
      // The write-back is a merge like config.ts::_writeInstancesMerged: the
      // read above is a snapshot, and the git steps between it and here take
      // seconds. The queue only serializes *this* extension host, while two
      // windows are separate processes sharing the same globalState keys, so
      // re-reading now keeps a record another window added meanwhile (a
      // concurrent PR open, touchCachedRepo, the lazy sweep) instead of dropping
      // it along with the stale snapshot. Only the entry this call intended to
      // remove is filtered out.
      await this.context.globalState.update(
        WORKTREES_KEY,
        this.getWorktrees().filter((w) => w.id !== id),
      );
      return true;
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

  /**
   * Drop every worktree record belonging to an instance that is being removed
   * from the configuration, and forget the cache-usage entries of the bare
   * clones only those records referenced.
   *
   * A record left behind after its instance is gone can never be acted on: the
   * dashboard no longer lists that instance, so there is no entry point to
   * remove the worktree — and because `_cleanupWorktrees` treats every recorded
   * path as in-use, the record also protects the orphaned checkout from the
   * lazy sweep forever.
   *
   * The directories on disk are deliberately *not* deleted here: a checkout may
   * hold the user's uncommitted work, and this runs as part of a config change
   * with no confirmation of its own. Dropping the record does not hand the
   * checkout to the lazy sweep either, unless its source repository is gone:
   * `_cleanupWorktrees` reclaims only a checkout whose `git worktree add`
   * marker names a source repository that no longer exists (see
   * isAbandonedWorktree), so a recordless checkout whose source still exists
   * stays on disk — and, with its record gone, is no longer visible in Settings
   * — until the user deletes it themselves. Only the bare clones lose their
   * active-protection and age out like any other unused clone. Returns how many
   * records were dropped.
   */
  async forgetInstanceWorktrees(instanceId: string): Promise<number> {
    return enqueueGlobalStateWrite(async () => {
      const worktrees = this.getWorktrees();
      const removed = worktrees.filter((w) => w.instanceId === instanceId);
      if (removed.length === 0) {
        return 0;
      }
      const remaining = worktrees.filter((w) => w.instanceId !== instanceId);
      await this.context.globalState.update(WORKTREES_KEY, remaining);

      // A bare clone still referenced by another instance's record is not
      // orphaned, so its usage entry stays.
      const stillReferenced = new Set(remaining.map((w) => pathKey(w.sourceRepoPath)));
      const usage = { ...this._getCacheRepoUsage() };
      // Usage keys are stored resolved (`touchCachedRepo`), so the same identity
      // rule applies here; on this platform that resolves the POSIX-looking
      // paths of records written elsewhere the way the sweep would.
      const usageKey = (target: string): string | undefined => {
        const resolved = path.resolve(target);
        return resolved in usage ? resolved : Object.keys(usage).find((key) => pathKey(key) === pathKey(target));
      };
      let usageChanged = false;
      for (const record of removed) {
        const key = usageKey(record.sourceRepoPath);
        if (key !== undefined && !stillReferenced.has(pathKey(record.sourceRepoPath))) {
          delete usage[key];
          usageChanged = true;
        }
      }
      if (usageChanged) {
        await this.context.globalState.update(CACHE_REPO_USAGE_KEY, usage);
      }
      return removed.length;
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
   * Lazily removes what the cache directory accumulated: bare clones
   * (`<cacheDir>/repos/*.git`) and abandoned worktree checkouts
   * (`<cacheDir>/worktrees/*`). Triggered from worktree operations — never a
   * timer. Returns the removed names (repositories first, then worktrees).
   *
   * Both sweeps read the persisted records, so they run inside the module write
   * queue like the other globalState mutations (a concurrent touchCachedRepo
   * must not be overwritten by a stale usage snapshot).
   */
  async cleanupCachedRepos(now: number = Date.now()): Promise<string[]> {
    return enqueueGlobalStateWrite(async () => [
      ...(await this._cleanupCachedRepos(now)),
      ...(await this._cleanupWorktrees(now)),
    ]);
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
    const activePaths = new Set(this.getWorktrees().map((w) => pathKey(w.sourceRepoPath)));

    const usage = { ...this._getCacheRepoUsage() };
    // Repositories that predate usage tracking get a fresh timestamp instead
    // of being treated as ancient and wiped on the first sweep.
    const tracked = repos.map((repoPath) => {
      const lastUsed = usage[repoPath] ?? now;
      usage[repoPath] = lastUsed;
      return { repoPath, lastUsed };
    });

    const removable = tracked.filter(({ repoPath }) => !activePaths.has(pathKey(repoPath)));
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

  /**
   * Deletes worktree checkouts under `<cacheDir>/worktrees` that the extension
   * created, that no record references and that are old enough to be abandoned
   * (WORKTREE_MAX_AGE_MS). Called from cleanupCachedRepos, so it is lazy like
   * the repository sweep and never a timer.
   *
   * The deletion rule is deliberately narrow, because `<cacheDir>/worktrees` is
   * a plain directory a user or another tool can put anything into. A direct
   * child is deleted only when *all* of these hold:
   *
   * 1. no persisted record resolves to that path (compared the way the
   *    platform compares paths, see pathKey);
   * 2. its `.git` entry is the linked-worktree marker `git worktree add`
   *    writes — a *file* holding `gitdir: <repo>/.git/worktrees/<name>` for a
   *    normal clone or `gitdir: <bare>.git/worktrees/<name>` for a bare one;
   * 3. the source repository that marker names is *definitively* absent
   *    (ENOENT/ENOTDIR, see isDefinitelyGone); and
   * 4. neither the directory nor any of its immediate entries has been
   *    modified for WORKTREE_MAX_AGE_MS (see isAgedOut).
   *
   * Everything else is left alone, however old: a `.git` directory (a real
   * checkout), no `.git` entry at all (a plain directory such as notes or a
   * script), any other `.git` shape (a submodule's `<super>/.git/modules/<name>`
   * pointer, a hand-written file), a source that cannot be probed, and any path
   * a record references.
   */
  private async _cleanupWorktrees(now: number): Promise<string[]> {
    const worktreesDir = path.join(this.getCacheDirectory(), 'worktrees');
    const resolvedWorktreesDir = path.resolve(worktreesDir);
    const entries = await fs.promises.readdir(worktreesDir, { withFileTypes: true }).catch(() => [] as fs.Dirent[]);
    const candidates = entries.filter((entry) => entry.isDirectory());
    if (candidates.length === 0) {
      return [];
    }

    // Defense in depth: only ever delete direct children of the worktrees dir,
    // and never one a record still points at.
    const referenced = new Set(this.getWorktrees().map((w) => pathKey(w.worktreePath)));
    const removed: string[] = [];
    for (const entry of candidates) {
      const worktreePath = path.resolve(worktreesDir, entry.name);
      if (path.dirname(worktreePath) !== resolvedWorktreesDir || referenced.has(pathKey(worktreePath))) {
        continue;
      }
      const stats = await fs.promises.lstat(worktreePath).catch(() => undefined);
      if (!stats || !stats.isDirectory() || !(await isAgedOut(worktreePath, stats.mtimeMs, now))) {
        continue;
      }
      if (!(await isAbandonedWorktree(worktreePath))) {
        continue;
      }
      try {
        await fs.promises.rm(worktreePath, { recursive: true, force: true });
        removed.push(entry.name);
      } catch {
        // A directory that cannot be deleted stays; the next sweep retries.
      }
    }
    return removed;
  }
}

/**
 * Identity of a path for set membership. Windows compares paths
 * case-insensitively (`C:\cache` and `c:\cache` are one directory), so an exact
 * string compare would let the "never a referenced path" guard miss — the
 * record keeps whatever casing the cache-directory setting had, while the
 * directory being swept carries the casing of the recomputed path.
 */
function pathKey(target: string): string {
  const resolved = path.resolve(target);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

/**
 * Whether a checkout has been untouched for WORKTREE_MAX_AGE_MS.
 *
 * The newest mtime of the directory *and of its immediate entries* is what
 * counts, not the root's alone: a linked worktree's root mtime only moves when
 * an entry is added to or removed from the root itself, while editing
 * `src/file.ts` updates `src`'s mtime. Reading the root alone would age out a
 * checkout its owner still works in. Only immediate entries are read, so a
 * `node_modules`-sized tree is never walked.
 *
 * Anything unreadable counts as recent: the age is what decides a deletion, so
 * a directory whose state cannot be determined must never be deleted on the
 * strength of a failed probe.
 */
async function isAgedOut(dir: string, ownMtimeMs: number, now: number): Promise<boolean> {
  let entries: string[];
  try {
    entries = await fs.promises.readdir(dir);
  } catch {
    return false;
  }
  let newest = ownMtimeMs;
  for (const name of entries) {
    const stats = await fs.promises.lstat(path.join(dir, name)).catch(() => undefined);
    if (!stats) {
      return false;
    }
    newest = Math.max(newest, stats.mtimeMs);
  }
  return now - newest > WORKTREE_MAX_AGE_MS;
}

/**
 * Whether a directory under `<cacheDir>/worktrees` is a checkout this extension
 * created and that nothing will ever use again (see _cleanupWorktrees).
 *
 * The extension only creates checkouts through `git worktree add`, which leaves
 * a linked-worktree marker in the directory: a `.git` *file* holding
 * `gitdir: <source>/.git/worktrees/<name>` (a normal clone) or
 * `gitdir: <bare>.git/worktrees/<name>` (a bare clone) — never a `.git`
 * directory. Requiring that marker is what keeps a plain directory the user
 * put there from being mistaken for a leftover, so a directory without it is
 * never deleted.
 *
 * The checkout is abandoned when the source repository the marker names no
 * longer exists: the gitdir it points at lives inside that repository, so once
 * the repository is gone the checkout cannot be committed to, diffed or even
 * read as a repository — it is unusable and drops out of every cleanup path.
 */
async function isAbandonedWorktree(worktreePath: string): Promise<boolean> {
  const gitDir = await readLinkedWorktreeGitDir(worktreePath);
  if (!gitDir) {
    return false;
  }
  return isDefinitelyGone(sourceRepoPathForGitDir(gitDir), worktreePath);
}

/**
 * The linked-worktree gitdir a checkout's `.git` entry points at, or undefined
 * when that entry is not the marker `git worktree add` writes.
 *
 * The marker is validated structurally rather than trusted: the gitdir must sit
 * in a directory literally named `worktrees` whose parent is the source
 * repository's `.git` directory or the bare clone (`<name>.git`). A
 * submodule's `.git` file (`gitdir: <super>/.git/modules/<name>`) and any other
 * hand-written pointer fail that shape check.
 */
async function readLinkedWorktreeGitDir(worktreePath: string): Promise<string | undefined> {
  const dotGit = path.join(worktreePath, '.git');
  const stats = await fs.promises.lstat(dotGit).catch(() => undefined);
  if (!stats || stats.isDirectory()) {
    // A `.git` directory is a real checkout, and a missing entry is not proof
    // of anything; neither is a marker this sweep may act on.
    return undefined;
  }
  const contents = await fs.promises.readFile(dotGit, 'utf8').catch(() => undefined);
  if (contents === undefined) {
    return undefined;
  }
  const match = /^gitdir:\s*(.+)$/m.exec(contents);
  if (!match) {
    return undefined;
  }
  const gitDir = path.resolve(worktreePath, match[1].trim());
  const worktreesDir = path.dirname(gitDir);
  if (path.basename(worktreesDir) !== 'worktrees') {
    return undefined;
  }
  const sourceDirName = path.basename(path.dirname(worktreesDir));
  if (sourceDirName !== '.git' && !sourceDirName.endsWith('.git')) {
    return undefined;
  }
  return gitDir;
}

/**
 * The source repository a validated linked-worktree gitdir belongs to, so the
 * sweep can tell whether that repository still exists.
 *
 * `git worktree add` records `<source>/.git/worktrees/<name>` for a normal
 * clone — the gitdir is inside the source's `.git` directory — and
 * `<bare>.git/worktrees/<name>` for a bare one, where the gitdir is a direct
 * child of the bare repository directory. Deriving the source as
 * `dirname(dirname(dirname(gitDir)))` only fits the first shape: for a bare
 * cache clone it trimmed one directory too many and produced
 * `<cacheDir>/repos`, which always exists, so a checkout whose bare clone had
 * been swept was never recognised as abandoned — the exact case this sweep was
 * added for.
 */
function sourceRepoPathForGitDir(gitDir: string): string {
  const repoDir = path.dirname(path.dirname(gitDir));
  return path.basename(repoDir) === '.git' ? path.dirname(repoDir) : repoDir;
}

/**
 * Whether a path is definitively absent from the filesystem.
 *
 * Only ENOENT ("no such file or directory") and ENOTDIR ("a path component is
 * not a directory") prove that: every other failure — EACCES/EPERM, an I/O
 * error, a timeout or a dropped connection on a network drive — says nothing
 * about whether the path exists. Reading those as "gone" would delete the
 * checkout of a source repository that is merely unreachable, so they keep the
 * directory and are logged.
 */
async function isDefinitelyGone(target: string, worktreePath: string): Promise<boolean> {
  try {
    await fs.promises.access(target);
    return false;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') {
      return true;
    }
    logger.error(
      `Worktree sweep: cannot tell whether the source repository of ${worktreePath} still exists (${target}): ${
        code ?? String(error)
      }; leaving the checkout alone`,
    );
    return false;
  }
}
