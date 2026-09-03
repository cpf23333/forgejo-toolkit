import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  removeWorktreeAndPrune: vi.fn(),
}));

vi.mock('../gitOperations', () => ({
  removeWorktreeAndPrune: mocks.removeWorktreeAndPrune,
}));

import * as vscode from 'vscode';
import { WorktreeManager, WorktreeInfo } from '../worktreeManager';

const WORKTREES_KEY = 'forgejoToolkit.worktrees';

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
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.removeWorktreeAndPrune.mockResolvedValue(undefined);
  });

  it('removes the worktree via git first, then drops the record', async () => {
    const target = makeWorktree();
    const other = makeWorktree({ id: 'inst:owner/repo#pr-2', prIndex: 2 });
    const { context, store } = createContext([target, other]);
    const manager = new WorktreeManager(context);

    await manager.removeWorktree(target.id);

    expect(mocks.removeWorktreeAndPrune).toHaveBeenCalledWith(target.sourceRepoPath, target.worktreePath);
    expect(store.get(WORKTREES_KEY)).toEqual([other]);
  });

  it('keeps the record and rethrows without toasting when git removal fails', async () => {
    const target = makeWorktree();
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
