import * as vscode from 'vscode';
import * as path from 'path';
import type { ForgejoInstance } from '@cpf23333-forgejo-toolkit/shared/webview/messages';
import { isSameOriginUrl } from './webview/instanceImport';
import { WorktreeManager } from './worktree/worktreeManager';
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
  /**
   * Used only to reach the persisted worktree records when an instance that
   * owns some is removed (see `removeInstance`); created lazily so activation
   * does not need it.
   */
  private _worktreeManager?: WorktreeManager;

  constructor(private context: vscode.ExtensionContext) {}

  private get _worktrees(): WorktreeManager {
    this._worktreeManager ??= new WorktreeManager(
      this.context,
      () => this.getWorktreeCacheDirectory(),
      () => this.getDefaultWorktreeCacheDirectory(),
    );
    return this._worktreeManager;
  }

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
      // Go through the merged write like add/remove/update: the migration
      // rewrites the whole instance list from this window's snapshot, and a
      // plain update would drop an instance another window added between the
      // read above and this write. `stripTokens` drops the plaintext token from
      // every entry of the merged list, including one the merge picked up from
      // the store, so no credential survives in globalState.
      await this._writeInstancesMerged(
        stored.map((instance) => ({ ...instance, token: '' })),
        undefined,
        true,
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
    // wiping it — but only when the URL stays on the same origin. An import
    // file can name a known id with a different URL, and silently rebinding
    // the stored secret to that host would hand the token over (editInstance
    // refuses the same move).
    const stored = this._getStoredInstances().find((i) => i.id === instance.id);
    if (instance.token) {
      await this.context.secrets.store(this._tokenSecretKey(instance.id), instance.token);
      this._tokens.set(instance.id, instance.token);
    } else if (stored && !isSameOriginUrl(stored.url, instance.url)) {
      // Different origin: the stored secret belongs to the original URL, so it
      // must not survive under this id at all. `init()` rehydrates tokens by
      // instance id, so merely dropping the in-memory copy would re-attach the
      // old token to the new URL (and thus send it to that host) at the next
      // activation. Deleting it leaves this entry token-less, so the UI asks
      // for a fresh credential.
      this._tokens.delete(instance.id);
      await this.context.secrets.delete(this._tokenSecretKey(instance.id));
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

  /**
   * Remove an instance: its stored token and its configuration entry.
   *
   * The instance's worktree records are dropped with it (see
   * `WorktreeManager.forgetInstanceWorktrees`): once the instance is gone the
   * dashboard can no longer offer to remove those worktrees, and a surviving
   * record would keep its orphaned checkout out of the lazy sweep for good. The
   * checkout directories themselves are left on disk — they may hold
   * uncommitted work and this runs without a confirmation of its own — so the
   * caller can tell the user where they are: a checkout backed by an ordinary
   * local clone is never reclaimed by the sweep, and once the record is gone
   * nothing else points at it.
   *
   * Returns how many worktree records were dropped and the directories they
   * named (read before they are forgotten).
   */
  async removeInstance(id: string): Promise<{ removed: number; strandedCheckouts: string[] }> {
    const strandedCheckouts = this._worktrees
      .getWorktrees()
      .filter((worktree) => worktree.instanceId === id)
      .map((worktree) => worktree.worktreePath);
    this._tokens.delete(id);
    await this.context.secrets.delete(this._tokenSecretKey(id));
    const instances = this._getStoredInstances().filter((i) => i.id !== id);
    await this._writeInstancesMerged(instances, id);
    const forgottenWorktrees = await this._worktrees.forgetInstanceWorktrees(id);
    this._onInstancesChanged.fire(this.getInstances());
    return { removed: forgottenWorktrees, strandedCheckouts };
  }

  /**
   * Write the instance list, merged by id with a fresh read taken immediately
   * before the write. globalState has no cross-window change event, so another
   * window may have updated the list since this window last read it; writing a
   * stale list back would silently drop the other window's additions. Entries
   * this call intentionally removed (`removedId`) stay removed. The merge
   * cannot close the race entirely (get→update is not atomic), but it shrinks
   * the window to the synchronous span between the two calls.
   *
   * `stripMergedTokens` drops the plaintext token from every entry of the
   * merged list, including an entry the merge picked up from the store. The
   * migration uses it: every instance in a migrated list was either just moved
   * into SecretStorage or added by a window that already stores its token
   * there, so nothing legitimate loses a credential.
   */
  private async _writeInstancesMerged(
    instances: ForgejoInstance[],
    removedId?: string,
    stripMergedTokens = false,
  ): Promise<void> {
    const fresh = this._getStoredInstances();
    const known = new Set(instances.map((i) => i.id));
    const merged = [...instances];
    for (const instance of fresh) {
      if (!known.has(instance.id) && instance.id !== removedId) {
        merged.push(instance);
      }
    }
    await this.context.globalState.update(
      INSTANCES_KEY,
      stripMergedTokens ? merged.map((instance) => ({ ...instance, token: '' })) : merged,
    );
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
