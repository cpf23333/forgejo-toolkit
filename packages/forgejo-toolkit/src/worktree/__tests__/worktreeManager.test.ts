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
import { WorktreeManager, WorktreeInfo, CACHE_REPO_MAX_AGE_MS, CACHE_REPO_MAX_COUNT } from '../worktreeManager';

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
    fs.rmSync(sourceDir, { recursive: true, force: true });
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

describe('WorktreeManager cached repo cleanup', () => {
  let cacheDir: string;

  beforeEach(async () => {
    cacheDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'worktree-cache-'));
    await fs.promises.mkdir(path.join(cacheDir, 'repos'), { recursive: true });
  });

  afterEach(async () => {
    await fs.promises.rm(cacheDir, { recursive: true, force: true });
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
      await fs.promises.rm(emptyDir, { recursive: true, force: true });
    }
  });
});
