import * as vscode from 'vscode';

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

  async removeWorktree(id: string): Promise<void> {
    const worktrees = this.getWorktrees();
    const target = worktrees.find((w) => w.id === id);
    if (!target) {
      return;
    }
    await this.context.globalState.update(
      WORKTREES_KEY,
      worktrees.filter((w) => w.id !== id),
    );
    try {
      await vscode.workspace.fs.delete(vscode.Uri.file(target.worktreePath), { recursive: true, useTrash: false });
    } catch {
      // Ignore cleanup errors; directory may already be gone or in use.
    }
  }

  getCacheDirectory(): string {
    const custom = this.getCustomCacheDirectory?.();
    if (custom && custom.trim()) {
      return custom.trim();
    }
    return this.getDefaultCacheDirectory?.() ?? vscode.Uri.joinPath(this.context.globalStorageUri, 'worktrees').fsPath;
  }
}
