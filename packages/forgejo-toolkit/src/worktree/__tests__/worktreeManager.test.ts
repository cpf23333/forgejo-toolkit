import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const mocks = vi.hoisted(() => ({
  removeWorktreeAndPrune: vi.fn(),
  deleteBranch: vi.fn(async () => undefined),
}));

vi.mock('../gitOperations', () => ({
  removeWorktreeAndPrune: mocks.removeWorktreeAndPrune,
  deleteBranch: mocks.deleteBranch,
}));

import * as vscode from 'vscode';
import { logger } from '../../logger';
import {
  WorktreeManager,
  WorktreeInfo,
  CACHE_REPO_MAX_AGE_MS,
  CACHE_REPO_MAX_COUNT,
  CLONE_OWNER_MARKER_MAX_AGE_MS,
  WORKTREE_MAX_AGE_MS,
} from '../worktreeManager';
import { removeTempDir, removeTempDirSync } from '../../__tests__/tempDir';

const WORKTREES_KEY = 'forgejoToolkit.worktrees';
const USAGE_KEY = 'forgejoToolkit.cacheRepoUsage';

function createContext(initial: WorktreeInfo[] = []) {
  const store = new Map<string, unknown>([[WORKTREES_KEY, initial]]);
  const context = {
    globalState: {
      get: vi.fn((key: string, defaultValue?: unknown) => (store.has(key) ? store.get(key) : defaultValue)),
      update: vi.fn(async (key: string, value: unknown) => {
        store.set(key, value);
      }),
    },
    globalStorageUri: { fsPath: '/global-storage' },
  } as unknown as vscode.ExtensionContext;
  return { context, store };
}

function makeWorktree(overrides: Partial<WorktreeInfo> = {}): WorktreeInfo {
  return {
    id: 'inst:owner/repo#pr-1',
    instanceId: 'inst',
    owner: 'owner',
    repo: 'repo',
    prIndex: 1,
    prTitle: 'Test PR',
    headBranch: 'feature',
    headSha: 'abc1234',
    baseBranch: 'main',
    sourceRepoPath: '/cache/repos/owner-repo.git',
    worktreePath: '/cache/worktrees/owner-repo-pr-1',
    createdAt: 1,
    ...overrides,
  };
}

describe('WorktreeManager.removeWorktree', () => {
  let sourceDir: string;

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.removeWorktreeAndPrune.mockResolvedValue(undefined);
    // removeWorktree only runs the git steps when the source repository
    // exists on disk, so point the record at a real directory.
    sourceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'worktree-manager-test-'));
  });

  afterEach(() => {
    removeTempDirSync(sourceDir);
  });

  it('removes the worktree via git first, then drops the record', async () => {
    const target = makeWorktree({ sourceRepoPath: sourceDir });
    const other = makeWorktree({ id: 'inst:owner/repo#pr-2', prIndex: 2 });
    const { context, store } = createContext([target, other]);
    const manager = new WorktreeManager(context);

    await manager.removeWorktree(target.id);

    expect(mocks.removeWorktreeAndPrune).toHaveBeenCalledWith(target.sourceRepoPath, target.worktreePath);
    expect(store.get(WORKTREES_KEY)).toEqual([other]);
  });

  it('deletes the throwaway PR branch after a successful removal', async () => {
    const target = makeWorktree({ sourceRepoPath: sourceDir });
    const { context } = createContext([target]);
    const manager = new WorktreeManager(context);

    await manager.removeWorktree(target.id);

    expect(mocks.deleteBranch).toHaveBeenCalledWith(sourceDir, 'pr-1-abc1234');
  });

  it('keeps the branch of an issue worktree (it is the user work branch)', async () => {
    const target = makeWorktree({
      sourceRepoPath: sourceDir,
      kind: 'issue',
      headBranch: 'issue-5-fix-bug',
      headSha: '',
    });
    const { context } = createContext([target]);
    const manager = new WorktreeManager(context);

    await manager.removeWorktree(target.id);

    expect(mocks.removeWorktreeAndPrune).toHaveBeenCalledTimes(1);
    expect(mocks.deleteBranch).not.toHaveBeenCalled();
  });

  it('drops the record without git when the source repository is gone from disk', async () => {
    const target = makeWorktree({ sourceRepoPath: path.join(sourceDir, 'does-not-exist') });
    const { context, store } = createContext([target]);
    const manager = new WorktreeManager(context);

    await manager.removeWorktree(target.id);

    expect(mocks.removeWorktreeAndPrune).not.toHaveBeenCalled();
    expect(store.get(WORKTREES_KEY)).toEqual([]);
  });

  it('removes the orphaned worktree directory when the source repository is gone', async () => {
    const orphanedDir = path.join(sourceDir, 'orphaned-worktree');
    fs.mkdirSync(orphanedDir);
    fs.writeFileSync(path.join(orphanedDir, 'leftover.txt'), 'stale');
    const target = makeWorktree({
      sourceRepoPath: path.join(sourceDir, 'does-not-exist'),
      worktreePath: orphanedDir,
    });
    const { context, store } = createContext([target]);
    const manager = new WorktreeManager(context);

    await manager.removeWorktree(target.id);

    // Dropping the record removes the only entry point to the directory, so
    // it must be deleted first instead of leaking on disk.
    expect(fs.existsSync(orphanedDir)).toBe(false);
    expect(store.get(WORKTREES_KEY)).toEqual([]);
  });

  it('keeps the record and surfaces the failure when the orphaned directory cannot be deleted', async () => {
    // A failed delete (a file still open in another process on Windows,
    // permissions, an I/O error) must not drop the record: the directory is
    // still there, and the record is the only entry point left to retry from.
    const orphanedDir = path.join(sourceDir, 'undeletable-worktree');
    fs.mkdirSync(orphanedDir);
    const target = makeWorktree({
      sourceRepoPath: path.join(sourceDir, 'does-not-exist'),
      worktreePath: orphanedDir,
    });
    const { context, store } = createContext([target]);
    const manager = new WorktreeManager(context);
    const rmSpy = vi
      .spyOn(fs.promises, 'rm')
      .mockImplementationOnce(() =>
        Promise.reject(Object.assign(new Error('EBUSY: resource busy or locked'), { code: 'EBUSY' })),
      );
    try {
      await expect(manager.removeWorktree(target.id)).rejects.toThrow(/EBUSY/);

      expect(store.get(WORKTREES_KEY)).toEqual([target]);
      // The view provider surfaces the error via worktreeError; the manager
      // must not also toast, or the user would see the error twice.
      expect(vscode.window.showErrorMessage).not.toHaveBeenCalled();
    } finally {
      rmSpy.mockRestore();
    }
  });

  it('keeps the record and rethrows without toasting when git removal fails', async () => {
    const target = makeWorktree({ sourceRepoPath: sourceDir });
    const { context, store } = createContext([target]);
    const manager = new WorktreeManager(context);
    mocks.removeWorktreeAndPrune.mockRejectedValue(new Error('fatal: removal failed'));

    await expect(manager.removeWorktree(target.id)).rejects.toThrow('fatal: removal failed');

    expect(store.get(WORKTREES_KEY)).toEqual([target]);
    // The view provider surfaces the error via worktreeError; the manager
    // must not also toast, or the user would see the error twice.
    expect(vscode.window.showErrorMessage).not.toHaveBeenCalled();
  });

  it('is a no-op for an unknown id', async () => {
    const target = makeWorktree();
    const { context, store } = createContext([target]);
    const manager = new WorktreeManager(context);

    await manager.removeWorktree('inst:owner/repo#pr-999');

    expect(mocks.removeWorktreeAndPrune).not.toHaveBeenCalled();
    expect(store.get(WORKTREES_KEY)).toEqual([target]);
  });
});

describe('WorktreeManager.forgetWorktree', () => {
  it('drops the record without touching the disk', async () => {
    const target = makeWorktree();
    const { context, store } = createContext([target]);
    const manager = new WorktreeManager(context);

    await manager.forgetWorktree(target.id);

    expect(mocks.removeWorktreeAndPrune).not.toHaveBeenCalled();
    expect(store.get(WORKTREES_KEY)).toEqual([]);
  });
});

describe('WorktreeManager globalState write serialization', () => {
  let sourceDir: string;

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.removeWorktreeAndPrune.mockResolvedValue(undefined);
    sourceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'worktree-manager-test-'));
  });

  afterEach(() => {
    removeTempDirSync(sourceDir);
  });

  it('merges concurrent addWorktree calls instead of losing one record', async () => {
    const { context, store } = createContext([]);
    const manager = new WorktreeManager(context);

    // Without the write queue both calls read the same empty snapshot and the
    // second write-back would clobber the first.
    await Promise.all([
      manager.addWorktree(makeWorktree({ id: 'inst:owner/repo#pr-1' })),
      manager.addWorktree(makeWorktree({ id: 'inst:owner/repo#pr-2', prIndex: 2 })),
    ]);

    const ids = (store.get(WORKTREES_KEY) as WorktreeInfo[]).map((w) => w.id).sort();
    expect(ids).toEqual(['inst:owner/repo#pr-1', 'inst:owner/repo#pr-2']);
  });

  it('does not lose a record added while a removal is still running git operations', async () => {
    const target = makeWorktree({ sourceRepoPath: sourceDir });
    const { context, store } = createContext([target]);
    const manager = new WorktreeManager(context);

    let finishGit!: () => void;
    mocks.removeWorktreeAndPrune.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          finishGit = resolve;
        }),
    );

    const removal = manager.removeWorktree(target.id);
    // The removal is now blocked inside its git step; an addWorktree issued
    // meanwhile used to be lost when the removal wrote back its stale snapshot.
    const addition = manager.addWorktree(makeWorktree({ id: 'inst:owner/repo#pr-2', prIndex: 2 }));
    // Wait until the removal actually reaches its (mocked) git step so
    // `finishGit` is assigned before it is called below. The mock is a plain
    // in-memory promise — no real I/O — so the call arrives within a tick; an
    // exhausted budget still fails the test loudly (`finishGit` would be
    // undefined) rather than passing on a wrong state, so a longer wall-clock
    // budget would buy nothing here.
    for (let i = 0; i < 50 && mocks.removeWorktreeAndPrune.mock.calls.length === 0; i++) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    finishGit();
    await Promise.all([removal, addition]);

    const ids = (store.get(WORKTREES_KEY) as WorktreeInfo[]).map((w) => w.id);
    expect(ids).toEqual(['inst:owner/repo#pr-2']);
  });

  it('does not lose a record another window added while its git operations ran', async () => {
    // Two VS Code windows are separate processes sharing the same globalState
    // keys; the module write queue only serializes this host. A record written
    // straight to the store while removeWorktree sits in `git worktree remove`
    // stands in for the other window's addWorktree / touchCachedRepo / sweep —
    // writing back the pre-operation snapshot silently dropped it.
    const target = makeWorktree({ sourceRepoPath: sourceDir });
    const foreign = makeWorktree({ id: 'inst:owner/repo#pr-9', prIndex: 9 });
    const { context, store } = createContext([target]);
    const manager = new WorktreeManager(context);

    mocks.removeWorktreeAndPrune.mockImplementation(async () => {
      store.set(WORKTREES_KEY, [...(store.get(WORKTREES_KEY) as WorktreeInfo[]), foreign]);
    });

    await manager.removeWorktree(target.id);

    const ids = (store.get(WORKTREES_KEY) as WorktreeInfo[]).map((w) => w.id);
    expect(ids).toEqual([foreign.id]);
  });

  it('keeps the write queue alive after a failed write', async () => {
    const target = makeWorktree({ sourceRepoPath: sourceDir });
    const { context, store } = createContext([target]);
    const manager = new WorktreeManager(context);
    mocks.removeWorktreeAndPrune.mockRejectedValue(new Error('fatal: removal failed'));

    await expect(manager.removeWorktree(target.id)).rejects.toThrow('fatal: removal failed');

    // The next queued write must still run: the queue swallows the rejection.
    await manager.addWorktree(makeWorktree({ id: 'inst:owner/repo#pr-2', prIndex: 2 }));
    const ids = (store.get(WORKTREES_KEY) as WorktreeInfo[]).map((w) => w.id).sort();
    expect(ids).toEqual(['inst:owner/repo#pr-1', 'inst:owner/repo#pr-2']);
  });

  it('merges a touchCachedRepo issued concurrently with another usage write', async () => {
    const { context, store } = createContext([]);
    const manager = new WorktreeManager(context);

    await Promise.all([manager.touchCachedRepo('/cache/repos/a.git'), manager.touchCachedRepo('/cache/repos/b.git')]);

    const usage = store.get(USAGE_KEY) as Record<string, number>;
    expect(usage[path.resolve('/cache/repos/a.git')]).toBeGreaterThan(0);
    expect(usage[path.resolve('/cache/repos/b.git')]).toBeGreaterThan(0);
  });
});

describe('WorktreeManager cached repo cleanup', () => {
  let cacheDir: string;

  beforeEach(async () => {
    cacheDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'worktree-cache-'));
    await fs.promises.mkdir(path.join(cacheDir, 'repos'), { recursive: true });
  });

  afterEach(async () => {
    await removeTempDir(cacheDir);
  });

  function createManager(initial: WorktreeInfo[] = []) {
    const { context, store } = createContext(initial);
    return { manager: new WorktreeManager(context, () => cacheDir), store };
  }

  async function makeCachedRepo(name: string): Promise<string> {
    const repoPath = path.join(cacheDir, 'repos', name);
    await fs.promises.mkdir(repoPath, { recursive: true });
    return repoPath;
  }

  async function seedUsage(store: Map<string, unknown>, entries: Record<string, number>) {
    store.set(USAGE_KEY, entries);
  }

  function exists(p: string): Promise<boolean> {
    return fs.promises.access(p).then(
      () => true,
      () => false,
    );
  }

  it('stamps a cached repo as used on touchCachedRepo', async () => {
    const repoPath = await makeCachedRepo('owner-repo.git');
    const { manager, store } = createManager();

    await manager.touchCachedRepo(repoPath);

    const usage = store.get(USAGE_KEY) as Record<string, number>;
    expect(usage[path.resolve(repoPath)]).toBeGreaterThan(0);
  });

  it('deletes repos unused for longer than the max age', async () => {
    const oldRepo = await makeCachedRepo('old.git');
    const recentRepo = await makeCachedRepo('recent.git');
    const now = Date.now();
    const { manager, store } = createManager();
    await seedUsage(store, {
      [path.resolve(oldRepo)]: now - CACHE_REPO_MAX_AGE_MS - 1000,
      [path.resolve(recentRepo)]: now,
    });

    const removed = await manager.cleanupCachedRepos(now);

    expect(removed).toEqual(['old.git']);
    expect(await exists(oldRepo)).toBe(false);
    expect(await exists(recentRepo)).toBe(true);
    const usage = store.get(USAGE_KEY) as Record<string, number>;
    expect(usage[path.resolve(oldRepo)]).toBeUndefined();
    expect(usage[path.resolve(recentRepo)]).toBe(now);
  });

  it('stamps untracked repos as used now instead of deleting them', async () => {
    const repoPath = await makeCachedRepo('untracked.git');
    const now = Date.now();
    const { manager, store } = createManager();

    const removed = await manager.cleanupCachedRepos(now);

    expect(removed).toEqual([]);
    expect(await exists(repoPath)).toBe(true);
    const usage = store.get(USAGE_KEY) as Record<string, number>;
    expect(usage[path.resolve(repoPath)]).toBe(now);
  });

  it('never deletes a repo referenced by a recorded worktree', async () => {
    const repoPath = await makeCachedRepo('in-use.git');
    const now = Date.now();
    const worktree = makeWorktree({ sourceRepoPath: repoPath });
    const { manager, store } = createManager([worktree]);
    await seedUsage(store, { [path.resolve(repoPath)]: now - CACHE_REPO_MAX_AGE_MS - 1000 });

    const removed = await manager.cleanupCachedRepos(now);

    expect(removed).toEqual([]);
    expect(await exists(repoPath)).toBe(true);
  });

  it('evicts the least recently used repos beyond the count cap', async () => {
    const now = Date.now();
    const usage: Record<string, number> = {};
    for (let i = 0; i < CACHE_REPO_MAX_COUNT + 2; i++) {
      const repoPath = await makeCachedRepo(`repo-${String(i).padStart(2, '0')}.git`);
      usage[path.resolve(repoPath)] = now - (CACHE_REPO_MAX_COUNT + 2 - i) * 1000;
    }
    const { manager, store } = createManager();
    await seedUsage(store, usage);

    const removed = await manager.cleanupCachedRepos(now);

    expect(removed.sort()).toEqual(['repo-00.git', 'repo-01.git']);
    const remaining = await fs.promises.readdir(path.join(cacheDir, 'repos'));
    expect(remaining).toHaveLength(CACHE_REPO_MAX_COUNT);
  });

  it('never evicts a clone the caller is using, even under the count cap', async () => {
    // The clone an operation just touched has no worktree record yet, so the
    // sweep sees it as any other unreferenced clone: it can be a count-cap
    // victim (or an age victim when its usage write has not been observed).
    // Only the recorded worktrees protect a clone, so the caller names the clone
    // it is working in.
    const now = Date.now();
    const usage: Record<string, number> = {};
    const inUse = await makeCachedRepo('in-use.git');
    usage[path.resolve(inUse)] = now;
    for (let i = 0; i < CACHE_REPO_MAX_COUNT + 1; i++) {
      const repoPath = await makeCachedRepo(`other-${String(i).padStart(2, '0')}.git`);
      usage[path.resolve(repoPath)] = now - (CACHE_REPO_MAX_COUNT + 1 - i) * 1000;
    }
    const { manager, store } = createManager();
    await seedUsage(store, usage);

    const removed = await manager.cleanupCachedRepos(now, [inUse]);

    expect(removed).not.toContain('in-use.git');
    expect(await exists(inUse)).toBe(true);
    expect(await fs.promises.readdir(path.join(cacheDir, 'repos'))).toHaveLength(CACHE_REPO_MAX_COUNT + 1);
    // The clone an operation is not using stayed eligible.
    expect(removed).toContain('other-00.git');
  });

  it('ignores files and non-.git directories', async () => {
    const plainDir = path.join(cacheDir, 'repos', 'notes');
    await fs.promises.mkdir(plainDir, { recursive: true });
    const strayFile = path.join(cacheDir, 'repos', 'stray.git');
    await fs.promises.writeFile(strayFile, 'not a repo');
    const now = Date.now();
    const { manager } = createManager();

    const removed = await manager.cleanupCachedRepos(now);

    expect(removed).toEqual([]);
    expect(await exists(plainDir)).toBe(true);
    expect(await exists(strayFile)).toBe(true);
  });

  it('prunes usage entries for repos deleted outside the sweep', async () => {
    const repoPath = await makeCachedRepo('kept.git');
    const gonePath = path.resolve(cacheDir, 'repos', 'gone.git');
    const now = Date.now();
    const { manager, store } = createManager();
    await seedUsage(store, {
      [path.resolve(repoPath)]: now,
      [gonePath]: now,
    });

    await manager.cleanupCachedRepos(now);

    const usage = store.get(USAGE_KEY) as Record<string, number>;
    expect(usage[gonePath]).toBeUndefined();
    expect(usage[path.resolve(repoPath)]).toBe(now);
  });

  it('returns an empty list when the repos directory does not exist', async () => {
    const emptyDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'worktree-cache-empty-'));
    try {
      const { context } = createContext();
      const emptyManager = new WorktreeManager(context, () => emptyDir);
      await expect(emptyManager.cleanupCachedRepos()).resolves.toEqual([]);
    } finally {
      await removeTempDir(emptyDir);
    }
  });

  it('reclaims a clone-owner marker older than a day, but never a fresh one', async () => {
    // cloneRepository deletes its own marker when the attempt settles, so an old
    // marker can only be the orphan of a crashed process — and while it sits
    // there, every failure cleanup for that path declines as if a clone were
    // still in flight. A fresh marker may belong to a clone running right now
    // (or to a failed attempt whose own cleanup has not read it yet), so it
    // stays.
    const now = Date.now();
    const staleMarker = path.join(cacheDir, 'repos', 'owner-repo.git.clone-owner.1-2-aaa');
    const freshMarker = path.join(cacheDir, 'repos', 'other-repo.git.clone-owner.1-2-bbb');
    await fs.promises.writeFile(staleMarker, '1-2-aaa');
    await fs.promises.writeFile(freshMarker, '1-2-bbb');
    const stale = new Date(now - CLONE_OWNER_MARKER_MAX_AGE_MS - 60_000);
    await fs.promises.utimes(staleMarker, stale, stale);
    const { manager } = createManager();

    const removed = await manager.cleanupCachedRepos(now);

    expect(await exists(staleMarker)).toBe(false);
    expect(await exists(freshMarker)).toBe(true);
    // Markers are bookkeeping files, not caches: they are not reported in the
    // removed-names list the caller logs as "unused cached repositories".
    expect(removed).toEqual([]);
  });
});

describe('WorktreeManager worktree cleanup', () => {
  let cacheDir: string;

  beforeEach(async () => {
    cacheDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'worktree-sweep-'));
    // cleanupCachedRepos sweeps both directories, so the repos sibling must
    // exist for the worktree half to be reached.
    await fs.promises.mkdir(path.join(cacheDir, 'repos'), { recursive: true });
    await fs.promises.mkdir(path.join(cacheDir, 'worktrees'), { recursive: true });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await removeTempDir(cacheDir);
  });

  function createManager(initial: WorktreeInfo[] = []) {
    const { context, store } = createContext(initial);
    return { manager: new WorktreeManager(context, () => cacheDir), store };
  }

  function exists(target: string): Promise<boolean> {
    return fs.promises.access(target).then(
      () => true,
      () => false,
    );
  }

  /** A checkout holding `leftover.txt` so its removal is observable. */
  async function makeDir(name: string): Promise<string> {
    const target = path.join(cacheDir, 'worktrees', name);
    await fs.promises.mkdir(target, { recursive: true });
    await fs.promises.writeFile(path.join(target, 'leftover.txt'), 'stale');
    return target;
  }

  /**
   * Ages a directory and its immediate entries. Must run last: writing the
   * `.git` marker inside a directory updates that directory's mtime, and the
   * sweep reads the newest mtime among the directory and its immediate
   * entries, so every entry has to be aged for the checkout to look abandoned.
   */
  async function age(target: string, now: number, ageMs: number): Promise<void> {
    const when = new Date(now - ageMs);
    for (const name of await fs.promises.readdir(target)) {
      await fs.promises.utimes(path.join(target, name), when, when);
    }
    await fs.promises.utimes(target, when, when);
  }

  /**
   * A checkout of a *normal* clone: `git worktree add` leaves a `.git` *file*
   * holding `gitdir: <source>/.git/worktrees/<name>` (the gitdir lives inside
   * the source's `.git`), not a `.git` directory. Returns the source clone
   * path so a test can delete it, as the repository cache sweep does, leaving
   * the checkout unusable and unreachable.
   */
  async function addNonBareWorktree(target: string, sourceRepoPath: string): Promise<string> {
    const gitDir = path.join(sourceRepoPath, '.git', 'worktrees', path.basename(target));
    await fs.promises.mkdir(gitDir, { recursive: true });
    await fs.promises.writeFile(path.join(target, '.git'), `gitdir: ${gitDir}\n`);
    return sourceRepoPath;
  }

  /**
   * A checkout of the shared *bare* cache clone: the gitdir is a direct child
   * of the bare repository directory (`<bare>.git/worktrees/<name>`, as git
   * 2.55 writes it), so there is no nested `.git` — a fixture that creates one
   * describes a layout git never produces. Returns the bare clone path.
   */
  async function addBareWorktree(target: string, bareRepoPath: string): Promise<string> {
    const gitDir = path.join(bareRepoPath, 'worktrees', path.basename(target));
    await fs.promises.mkdir(gitDir, { recursive: true });
    await fs.promises.writeFile(path.join(target, '.git'), `gitdir: ${gitDir}\n`);
    return bareRepoPath;
  }

  /** The shared bare clone of a repository, as `_resolveWorktreeSourceRepo` builds it. */
  function cacheClone(name: string): string {
    return path.join(cacheDir, 'repos', `${name}.git`);
  }

  /** A plain clone the user selected as the worktree source. */
  function localClone(name: string): string {
    return path.join(cacheDir, 'clones', name);
  }

  it('removes an unreferenced worktree whose bare cache clone was swept', async () => {
    const now = Date.now();
    const target = await makeDir('owner-repo-deadbeef-pr-1');
    const sourceRepoPath = await addBareWorktree(target, cacheClone('owner-repo-deadbeef'));
    // The clone was deleted or swept: nothing can use this checkout again.
    await removeTempDir(sourceRepoPath);
    await age(target, now, WORKTREE_MAX_AGE_MS + 60_000);
    const { manager } = createManager();

    const removed = await manager.cleanupCachedRepos(now);

    expect(removed).toEqual(['owner-repo-deadbeef-pr-1']);
    expect(await exists(target)).toBe(false);
  });

  it('removes an unreferenced worktree whose non-bare source clone was deleted', async () => {
    const now = Date.now();
    const target = await makeDir('owner-repo-deadbeef-pr-2');
    const sourceRepoPath = await addNonBareWorktree(target, localClone('owner-repo-deadbeef'));
    await removeTempDir(sourceRepoPath);
    await age(target, now, WORKTREE_MAX_AGE_MS + 60_000);
    const { manager } = createManager();

    const removed = await manager.cleanupCachedRepos(now);

    expect(removed).toEqual(['owner-repo-deadbeef-pr-2']);
    expect(await exists(target)).toBe(false);
  });

  it('keeps an unreferenced worktree whose bare cache clone is still there', async () => {
    // Without a record it cannot be opened again, but its git metadata is live
    // and its contents are the user's; only the extension's own abandoned
    // checkouts are swept.
    const now = Date.now();
    const target = await makeDir('owner-repo-live-pr-1');
    await addBareWorktree(target, cacheClone('owner-repo-live'));
    await age(target, now, WORKTREE_MAX_AGE_MS + 60_000);
    const { manager } = createManager();

    const removed = await manager.cleanupCachedRepos(now);

    expect(removed).toEqual([]);
    expect(await exists(target)).toBe(true);
  });

  it('keeps an unreferenced worktree whose non-bare source clone is still there', async () => {
    const now = Date.now();
    const target = await makeDir('owner-repo-live-pr-2');
    await addNonBareWorktree(target, localClone('owner-repo-live'));
    await age(target, now, WORKTREE_MAX_AGE_MS + 60_000);
    const { manager } = createManager();

    const removed = await manager.cleanupCachedRepos(now);

    expect(removed).toEqual([]);
    expect(await exists(target)).toBe(true);
  });

  it('never removes a worktree a record still references', async () => {
    const now = Date.now();
    const target = await makeDir('owner-repo-deadbeef-pr-3');
    const sourceRepoPath = await addBareWorktree(target, cacheClone('owner-repo-deadbeef'));
    await removeTempDir(sourceRepoPath);
    await age(target, now, WORKTREE_MAX_AGE_MS + 60_000);
    const { manager, store } = createManager([makeWorktree({ worktreePath: target })]);

    const removed = await manager.cleanupCachedRepos(now);

    expect(removed).toEqual([]);
    expect(await exists(target)).toBe(true);
    expect(store.get(WORKTREES_KEY)).toHaveLength(1);
  });

  // Windows compares paths case-insensitively, so a record whose path differs
  // from the directory only in casing still references it — the deletion guard
  // must not miss it (a user retyping the cache-directory setting with a
  // different drive-letter casing is enough to produce that).
  it.skipIf(process.platform !== 'win32')(
    'never removes a worktree a record references under a different casing',
    async () => {
      const now = Date.now();
      const target = await makeDir('owner-repo-deadbeef-pr-4');
      const sourceRepoPath = await addNonBareWorktree(target, localClone('owner-repo-deadbeef'));
      await removeTempDir(sourceRepoPath);
      await age(target, now, WORKTREE_MAX_AGE_MS + 60_000);
      const { manager } = createManager([makeWorktree({ worktreePath: target.toUpperCase() })]);

      const removed = await manager.cleanupCachedRepos(now);

      expect(removed).toEqual([]);
      expect(await exists(target)).toBe(true);
    },
  );

  it('leaves an aged worktree younger than the age bound alone', async () => {
    const now = Date.now();
    const target = await makeDir('owner-repo-deadbeef-pr-5');
    const sourceRepoPath = await addBareWorktree(target, cacheClone('owner-repo-deadbeef'));
    await removeTempDir(sourceRepoPath);
    await age(target, now, WORKTREE_MAX_AGE_MS - 60_000);
    const { manager } = createManager();

    const removed = await manager.cleanupCachedRepos(now);

    expect(removed).toEqual([]);
    expect(await exists(target)).toBe(true);
  });

  it('leaves a checkout created moments ago alone even when its source is gone', async () => {
    // The sweep can run while a worktree is being created: the create path only
    // enters the globalState write queue when it records the worktree, so the
    // sweep may see a fresh directory no record points at yet. The age bound is
    // what makes that overlap safe — a just-created checkout is never "abandoned".
    const target = await makeDir('owner-repo-deadbeef-fresh');
    const sourceRepoPath = await addNonBareWorktree(target, localClone('owner-repo-deadbeef'));
    await removeTempDir(sourceRepoPath);
    const { manager } = createManager();

    const removed = await manager.cleanupCachedRepos(Date.now());

    expect(removed).toEqual([]);
    expect(await exists(target)).toBe(true);
  });

  it('keeps an aged checkout that was touched inside recently', async () => {
    // A linked worktree's root mtime only moves when an entry is added to or
    // removed from the root itself: editing `src/file.ts` updates `src`, not
    // the root, so the root alone would age out a checkout its owner still
    // works in.
    const now = Date.now();
    const target = await makeDir('owner-repo-deadbeef-pr-6');
    const sourceRepoPath = await addNonBareWorktree(target, localClone('owner-repo-deadbeef'));
    await fs.promises.mkdir(path.join(target, 'src'));
    await fs.promises.writeFile(path.join(target, 'src', 'index.ts'), 'work in progress');
    await removeTempDir(sourceRepoPath);
    await age(target, now, WORKTREE_MAX_AGE_MS + 60_000);
    await fs.promises.utimes(path.join(target, 'src'), new Date(now), new Date(now));
    const { manager } = createManager();

    const removed = await manager.cleanupCachedRepos(now);

    expect(removed).toEqual([]);
    expect(await exists(target)).toBe(true);
  });

  it('keeps an aged plain directory the extension did not create', async () => {
    // `<cacheDir>/worktrees` is a plain directory a user can drop notes, a
    // script or another tool's checkout into. Without a linked-worktree marker
    // there is no proof the extension created what is about to be deleted.
    const now = Date.now();
    const target = await makeDir('notes');
    await age(target, now, WORKTREE_MAX_AGE_MS * 3);
    const { manager } = createManager();

    const removed = await manager.cleanupCachedRepos(now);

    expect(removed).toEqual([]);
    expect(await exists(target)).toBe(true);
  });

  it('keeps an aged directory whose .git file is not a linked-worktree marker', async () => {
    // A submodule checkout's `.git` is a file too, but it points at
    // `<super>/.git/modules/<name>`. The marker is git's `worktrees/<name>`
    // shape, so a dangling pointer like this one is not the extension's.
    const now = Date.now();
    const target = await makeDir('sub-checkout');
    const gitDir = path.join(cacheDir, 'repos', 'gone-super', '.git', 'modules', 'sub-checkout');
    await fs.promises.writeFile(path.join(target, '.git'), `gitdir: ${gitDir}\n`);
    await age(target, now, WORKTREE_MAX_AGE_MS + 60_000);
    const { manager } = createManager();

    const removed = await manager.cleanupCachedRepos(now);

    expect(removed).toEqual([]);
    expect(await exists(target)).toBe(true);
  });

  it('keeps an aged checkout whose source repository cannot be probed', async () => {
    // An unreachable source (offline network drive, permissions, I/O error)
    // says nothing about whether it still exists: only a definitive "not
    // found" may mark the checkout as abandoned.
    const now = Date.now();
    const failingCodes = ['EACCES', 'EPERM', 'EIO'];
    const targets: string[] = [];
    const unreadable = new Map<string, string>();
    for (const [index, code] of failingCodes.entries()) {
      const target = await makeDir(`owner-repo-unreachable-${index}`);
      const sourceRepoPath = await addNonBareWorktree(target, localClone(`owner-repo-unreachable-${index}`));
      await age(target, now, WORKTREE_MAX_AGE_MS + 60_000);
      unreadable.set(path.resolve(sourceRepoPath), code);
      targets.push(target);
    }
    const realAccess = fs.promises.access;
    const accessSpy = vi
      .spyOn(fs.promises, 'access')
      .mockImplementation(async (candidate: fs.PathLike, mode?: number) => {
        const code = unreadable.get(path.resolve(String(candidate)));
        if (code) {
          throw Object.assign(new Error(`${code}: simulated source probe failure`), { code });
        }
        return realAccess(candidate, mode);
      });
    const logSpy = vi.spyOn(logger, 'error').mockImplementation(() => undefined);
    const { manager } = createManager();

    const removed = await manager.cleanupCachedRepos(now);

    expect(accessSpy).toHaveBeenCalled();
    expect(removed).toEqual([]);
    for (const target of targets) {
      expect(await exists(target)).toBe(true);
    }
    expect(logSpy).toHaveBeenCalledTimes(failingCodes.length);
    const messages = logSpy.mock.calls.map((call) => String(call[0]));
    for (const code of failingCodes) {
      expect(messages.some((message) => message.includes(code))).toBe(true);
    }
  });

  it('removes an abandoned checkout whose source path cannot exist', async () => {
    // A file where a directory must be makes the derived source path
    // definitively absent (ENOENT on Windows, ENOTDIR on POSIX) — unlike an
    // unreadable source, that does prove the checkout is abandoned.
    const now = Date.now();
    const blockingFile = path.join(cacheDir, 'repos', 'stray.git');
    await fs.promises.writeFile(blockingFile, 'not a repository');
    const target = await makeDir('owner-repo-deadbeef-pr-8');
    const gitDir = path.join(blockingFile, 'inner', '.git', 'worktrees', path.basename(target));
    await fs.promises.writeFile(path.join(target, '.git'), `gitdir: ${gitDir}\n`);
    await age(target, now, WORKTREE_MAX_AGE_MS + 60_000);
    const { manager } = createManager();

    const removed = await manager.cleanupCachedRepos(now);

    expect(removed).toEqual(['owner-repo-deadbeef-pr-8']);
    expect(await exists(target)).toBe(false);
  });

  it('leaves a foreign git checkout under the same parent alone', async () => {
    // A real repository someone put in the cache directory: its `.git` is a
    // directory, which the extension never creates there.
    const now = Date.now();
    const repoPath = path.join(cacheDir, 'worktrees', 'my-own-checkout');
    await fs.promises.mkdir(path.join(repoPath, '.git'), { recursive: true });
    await fs.promises.writeFile(path.join(repoPath, '.git', 'HEAD'), 'ref: refs/heads/main\n');
    await age(repoPath, now, WORKTREE_MAX_AGE_MS * 3);
    const { manager } = createManager();

    const removed = await manager.cleanupCachedRepos(now);

    expect(removed).toEqual([]);
    expect(await exists(repoPath)).toBe(true);
  });

  it('sweeps worktrees and cached repositories in one pass', async () => {
    const now = Date.now();
    const repoPath = path.join(cacheDir, 'repos', 'old.git');
    await fs.promises.mkdir(repoPath, { recursive: true });
    const target = await makeDir('owner-repo-deadbeef-pr-7');
    const worktreeSource = await addBareWorktree(target, cacheClone('owner-repo-deadbeef'));
    await removeTempDir(worktreeSource);
    await age(target, now, WORKTREE_MAX_AGE_MS + 60_000);
    const { manager, store } = createManager();
    store.set(USAGE_KEY, { [path.resolve(repoPath)]: now - CACHE_REPO_MAX_AGE_MS - 1_000 });

    const removed = await manager.cleanupCachedRepos(now);

    expect(removed).toEqual(['old.git', 'owner-repo-deadbeef-pr-7']);
    expect(await exists(repoPath)).toBe(false);
    expect(await exists(target)).toBe(false);
  });
});
