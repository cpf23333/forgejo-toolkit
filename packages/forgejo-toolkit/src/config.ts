import * as vscode from 'vscode';
import * as path from 'path';
import type { ForgejoInstance } from '@cpf23333-forgejo-toolkit/shared/webview/messages';

export type { ForgejoInstance };

const INSTANCES_KEY = 'forgejoToolkit.instances';

export class ConfigManager {
  constructor(private context: vscode.ExtensionContext) {}

  getInstances(): ForgejoInstance[] {
    return this.context.globalState.get<ForgejoInstance[]>(INSTANCES_KEY, []);
  }

  async addInstance(instance: ForgejoInstance): Promise<void> {
    const instances = this.getInstances().filter((i) => i.id !== instance.id);
    instances.push(instance);
    await this.context.globalState.update(INSTANCES_KEY, instances);
  }

  async updateInstance(id: string, updates: Partial<Omit<ForgejoInstance, 'id'>>): Promise<void> {
    const instances = this.getInstances();
    const index = instances.findIndex((i) => i.id === id);
    if (index === -1) {
      return;
    }
    instances[index] = { ...instances[index], ...updates };
    await this.context.globalState.update(INSTANCES_KEY, instances);
  }

  async removeInstance(id: string): Promise<void> {
    const instances = this.getInstances().filter((i) => i.id !== id);
    await this.context.globalState.update(INSTANCES_KEY, instances);
  }

  getWorktreeOpenMode(): 'currentWindow' | 'newWindow' {
    const value = vscode.workspace.getConfiguration('forgejoToolkit').get<string>('worktreeOpenMode', 'newWindow');
    return value === 'currentWindow' ? 'currentWindow' : 'newWindow';
  }

  async setWorktreeOpenMode(mode: 'currentWindow' | 'newWindow'): Promise<void> {
    await vscode.workspace.getConfiguration('forgejoToolkit').update('worktreeOpenMode', mode, true);
  }

  getWorktreeCacheDirectory(): string | undefined {
    return vscode.workspace.getConfiguration('forgejoToolkit').get<string | undefined>('worktreeCacheDirectory');
  }

  getDefaultWorktreeCacheDirectory(): string {
    const homeDir = process.env.HOME ?? process.env.USERPROFILE;
    if (homeDir) {
      return vscode.Uri.file(path.join(homeDir, 'forgejo-toolkit-worktrees')).fsPath;
    }
    return vscode.Uri.joinPath(this.context.globalStorageUri, 'worktrees').fsPath;
  }

  async setWorktreeCacheDirectory(directory: string): Promise<void> {
    await vscode.workspace.getConfiguration('forgejoToolkit').update('worktreeCacheDirectory', directory, true);
  }
}
