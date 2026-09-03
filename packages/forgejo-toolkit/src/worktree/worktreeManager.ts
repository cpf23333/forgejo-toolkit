import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { removeWorktreeAndPrune } from './gitOperations';

export interface WorktreeInfo {
  id: string;
  instanceId: string;
  owner: string;
  repo: string;
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
      (w) => w.instanceId === instanceId && w.owner === owner && w.repo === repo && w.prIndex === prIndex,
    );
  }

  async addWorktree(info: WorktreeInfo): Promise<void> {
    const worktrees = this.getWorktrees().filter((w) => w.id !== info.id);
    worktrees.push(info);
    await this.context.globalState.update(WORKTREES_KEY, worktrees);
  }

  /**
   * Remove a worktree: run `git worktree remove` first (falling back to prune
   * + manual delete inside removeWorktreeAndPrune) so the source repository's
   * .git/worktrees metadata and the branch's checked-out state are cleaned up,
   * then drop the record. On failure the record is kept so the UI retains an
   * entry point for retry, and the error is surfaced to the user.
   */
  async removeWorktree(id: string): Promise<void> {
    const worktrees = this.getWorktrees();
    const target = worktrees.find((w) => w.id === id);
    if (!target) {
      return;
    }
    try {
      await removeWorktreeAndPrune(target.sourceRepoPath, target.worktreePath);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      void vscode.window.showErrorMessage(vscode.l10n.t('Failed to remove worktree: {0}', message));
      throw error;
    }
    await this.context.globalState.update(
      WORKTREES_KEY,
      worktrees.filter((w) => w.id !== id),
    );
  }

  /** Drop the record without touching the disk (used when the directory is already gone). */
  async forgetWorktree(id: string): Promise<void> {
    await this.context.globalState.update(
      WORKTREES_KEY,
      this.getWorktrees().filter((w) => w.id !== id),
    );
  }

  getCacheDirectory(): string {
    const custom = this.getCustomCacheDirectory?.();
    if (custom && custom.trim()) {
      return custom.trim();
    }
    return this.getDefaultCacheDirectory?.() ?? vscode.Uri.joinPath(this.context.globalStorageUri, 'worktrees').fsPath;
  }
}
