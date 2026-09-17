import * as vscode from 'vscode';
import * as path from 'path';
import type { ForgejoInstance } from '@cpf23333-forgejo-toolkit/shared/webview/messages';
import { logger } from './logger';

export type { ForgejoInstance };

const INSTANCES_KEY = 'forgejoToolkit.instances';
const TOKEN_SECRET_PREFIX = 'forgejoToolkit.instanceToken.';
const DEFAULT_INTERVAL_SECONDS = 300;
const MIN_INTERVAL_SECONDS = 60;
const MAX_INTERVAL_SECONDS = 3600;

export class ConfigManager {
  private readonly _onInstancesChanged = new vscode.EventEmitter<ForgejoInstance[]>();
  readonly onInstancesChanged = this._onInstancesChanged.event;
  private readonly _tokens = new Map<string, string>();

  constructor(private context: vscode.ExtensionContext) {}

  // Loads tokens from SecretStorage into memory and migrates legacy plaintext
  // tokens out of globalState. Must be called once during extension activation.
  async init(): Promise<void> {
    const stored = this._getStoredInstances();
    let migrated = false;
    for (const instance of stored) {
      const secret = await this.context.secrets.get(this._tokenSecretKey(instance.id));
      if (secret !== undefined) {
        this._tokens.set(instance.id, secret);
      } else if (instance.token) {
        await this.context.secrets.store(this._tokenSecretKey(instance.id), instance.token);
        this._tokens.set(instance.id, instance.token);
      }
      if (instance.token) {
        migrated = true;
      }
    }
    if (migrated) {
      await this.context.globalState.update(
        INSTANCES_KEY,
        stored.map((instance) => ({ ...instance, token: '' })),
      );
    }
    // Keep the in-memory token table in sync with SecretStorage: other windows
    // share the storage but not this Map, so without this their token edits
    // would only apply here after a reload. Disposed with the extension context.
    this.context.subscriptions.push(
      this.context.secrets.onDidChange((event) => {
        if (!event.key.startsWith(TOKEN_SECRET_PREFIX)) {
          return;
        }
        const id = event.key.slice(TOKEN_SECRET_PREFIX.length);
        void this.context.secrets.get(event.key).then(
          (secret) => {
            if (secret === undefined) {
              this._tokens.delete(id);
            } else {
              this._tokens.set(id, secret);
            }
            this._onInstancesChanged.fire(this.getInstances());
          },
          (error: unknown) => {
            logger.error(
              `Failed to refresh stored token for instance ${id}: ${error instanceof Error ? error.message : String(error)}`,
            );
          },
        );
      }),
    );
  }

  getInstances(): ForgejoInstance[] {
    return this._getStoredInstances().map((instance) => ({
      ...instance,
      token: this._tokens.get(instance.id) ?? '',
    }));
  }

  async addInstance(instance: ForgejoInstance): Promise<void> {
    // Token semantics (shared with updateInstance): a non-empty token is
    // stored in SecretStorage; an empty token means "keep the existing
    // credential". Re-adding an instance id without re-entering its token
    // (e.g. re-import) therefore preserves the stored secret instead of
    // wiping it.
    if (instance.token) {
      await this.context.secrets.store(this._tokenSecretKey(instance.id), instance.token);
      this._tokens.set(instance.id, instance.token);
    }
    const instances = this._getStoredInstances().filter((i) => i.id !== instance.id);
    instances.push({ ...instance, token: '' });
    await this._writeInstancesMerged(instances);
    this._onInstancesChanged.fire(this.getInstances());
  }

  async updateInstance(id: string, updates: Partial<Omit<ForgejoInstance, 'id'>>): Promise<void> {
    const instances = this._getStoredInstances();
    const index = instances.findIndex((i) => i.id === id);
    if (index === -1) {
      return;
    }
    // An empty token update means "unchanged", so the stored secret is kept.
    if (updates.token) {
      await this.context.secrets.store(this._tokenSecretKey(id), updates.token);
      this._tokens.set(id, updates.token);
    }
    instances[index] = { ...instances[index], ...updates, token: '' };
    await this._writeInstancesMerged(instances);
    this._onInstancesChanged.fire(this.getInstances());
  }

  async removeInstance(id: string): Promise<void> {
    this._tokens.delete(id);
    await this.context.secrets.delete(this._tokenSecretKey(id));
    const instances = this._getStoredInstances().filter((i) => i.id !== id);
    await this._writeInstancesMerged(instances, id);
    this._onInstancesChanged.fire(this.getInstances());
  }

  /**
   * Write the instance list, merged by id with a fresh read taken immediately
   * before the write. globalState has no cross-window change event, so another
   * window may have updated the list since this window last read it; writing a
   * stale list back would silently drop the other window's additions. Entries
   * this call intentionally removed (`removedId`) stay removed. The merge
   * cannot close the race entirely (get→update is not atomic), but it shrinks
   * the window to the synchronous span between the two calls.
   */
  private async _writeInstancesMerged(instances: ForgejoInstance[], removedId?: string): Promise<void> {
    const fresh = this._getStoredInstances();
    const known = new Set(instances.map((i) => i.id));
    const merged = [...instances];
    for (const instance of fresh) {
      if (!known.has(instance.id) && instance.id !== removedId) {
        merged.push(instance);
      }
    }
    await this.context.globalState.update(INSTANCES_KEY, merged);
  }

  private _getStoredInstances(): ForgejoInstance[] {
    return this.context.globalState.get<ForgejoInstance[]>(INSTANCES_KEY, []);
  }

  private _tokenSecretKey(id: string): string {
    return `${TOKEN_SECRET_PREFIX}${id}`;
  }

  getWorktreeOpenMode(): 'ask' | 'currentWindow' | 'newWindow' {
    const value = vscode.workspace.getConfiguration('forgejoToolkit').get<string>('worktreeOpenMode', 'ask');
    if (value === 'currentWindow' || value === 'newWindow') {
      return value;
    }
    return 'ask';
  }

  async setWorktreeOpenMode(mode: 'ask' | 'currentWindow' | 'newWindow'): Promise<void> {
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

  isNotificationPollingEnabled(): boolean {
    return vscode.workspace.getConfiguration('forgejoToolkit').get<boolean>('notificationPollingEnabled', true);
  }

  getNotificationPollingInterval(): number {
    const value = vscode.workspace
      .getConfiguration('forgejoToolkit')
      .get<number>('notificationPollingInterval', DEFAULT_INTERVAL_SECONDS);
    if (typeof value !== 'number' || Number.isNaN(value)) {
      return DEFAULT_INTERVAL_SECONDS;
    }
    return Math.max(MIN_INTERVAL_SECONDS, Math.min(MAX_INTERVAL_SECONDS, Math.round(value)));
  }

  isMockApiEnabled(): boolean {
    return vscode.workspace.getConfiguration('forgejoToolkit').get<boolean>('useMockApi', false);
  }
}
