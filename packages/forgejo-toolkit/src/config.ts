import * as vscode from 'vscode';
import * as path from 'path';
import type { ForgejoInstance } from '@cpf23333-forgejo-toolkit/shared/webview/messages';
import { isSameOriginUrl } from './webview/instanceImport';
import { isHttpUrl } from './webview/connectionTest';
import { resolveInstanceIdCollision } from './instanceIdentity';
import { hasUrlUserinfo } from './utils/redactUrlUserinfo';
import { WorktreeManager } from './worktree/worktreeManager';
import { logger } from './logger';
import {
  createMementoServerVersionCache,
  deleteSharedServerVersion,
  setServerVersionCacheStorage,
} from './api/serverVersionCache';

export type { ForgejoInstance };

const INSTANCES_KEY = 'forgejoToolkit.instances';
/**
 * The shared, timestamped probe cache of §9 route 2, deliberately stored next to
 * the instance list: a probed version is a property of an instance, so it has
 * the same lifetime and the same cleanup semantics as the entries above it. It
 * is a cache, not an arbiter — the polling election never reads this key (§2
 * decision 1) — so a lost cross-window update only costs one extra probe.
 */
const SERVER_VERSIONS_KEY = 'forgejoToolkit.serverVersions';
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

  constructor(private context: vscode.ExtensionContext) {
    // §9 route 2: hand the shared probe cache the store it lives in. Registered
    // here because this is where the extension context and the key beside the
    // instance list are known; `extension.ts` builds this manager before it
    // probes anything, so every probe in this window sees the shared entries.
    // A store the host refuses to read or write degrades to the process-local
    // cache (see `serverVersion.ts`), which is why the adapter reports failures
    // through the logger instead of throwing.
    setServerVersionCacheStorage(
      createMementoServerVersionCache(context.globalState, SERVER_VERSIONS_KEY, (message) => logger.debug(message)),
    );
  }

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
    // Keep the in-memory token table in sync with SecretStorage: other windows
    // share the storage but not this Map, so without this their token edits
    // would only apply here after a reload. Disposed with the extension context.
    // Registered before the migration below on purpose: `secrets.get`/`store`
    // can reject on a system without a working keyring, and a throw there must
    // not skip this registration — the listener is what keeps this window's
    // tokens in sync for the rest of the session.
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
  }

  getInstances(): ForgejoInstance[] {
    return this._getStoredInstances().map((instance) => ({
      ...instance,
      token: this._tokens.get(instance.id) ?? '',
    }));
  }

  async addInstance(instance: ForgejoInstance): Promise<void> {
    // Defence in depth at the storage boundary: everything downstream (API
    // requests, links rendered by the webview, `vscode.env.openExternal`) can
    // only use an http(s) instance URL, and the callers that already check the
    // scheme (the connection test, the import sanitizer) are not all of them.
    // An unparseable URL is refused too, so an entry that can never work is not
    // persisted where the Settings UI would only offer to edit it again.
    if (!isHttpUrl(instance.url)) {
      throw new Error(vscode.l10n.t('Enter a valid http(s) URL for the Forgejo instance.'));
    }
    // A URL that embeds a credential as userinfo is refused for the same
    // reason: Node's `fetch` refuses to construct a request from a URL with
    // credentials at all, so storing it produces an instance whose every call
    // fails with a transport error the user sees as "cannot connect to the
    // instance". The credential belongs in the token field, which is stored in
    // SecretStorage and sent as an Authorization header. Refused rather than
    // stripped silently: dropping a secret the user typed, without telling
    // them, would leave a saved instance that authenticates as nobody.
    if (hasUrlUserinfo(instance.url)) {
      throw new Error(vscode.l10n.t('Enter a valid http(s) URL for the Forgejo instance.'));
    }
    // A stored entry with the same id but a different URL is a different
    // instance, not an edit of this one: instanceIdFor folds path punctuation
    // (`/a-b` and `/a/b` slug identically), and an import file can name a known
    // id with an arbitrary URL. Overwriting the stored entry would lose the
    // first instance and — because init() rehydrates tokens by id — rebind its
    // stored secret to the new URL, handing the token to a host it was never
    // paired with. The newcomer gets a fresh id derived from its URL instead,
    // so the existing entry and its credential stay untouched; a re-add of the
    // unchanged instance keeps its id and still updates in place.
    const entry = {
      ...instance,
      id: resolveInstanceIdCollision(instance.id, instance.url, this._getStoredInstances()),
    };
    // Token semantics (shared with updateInstance): a non-empty token is
    // stored in SecretStorage; an empty token means "keep the existing
    // credential" (e.g. re-import). Keeping is only possible for the unchanged
    // URL: the collision resolution above guarantees that a stored entry with
    // this id has exactly this URL, so the secret under it can never be
    // re-attached to a different host. The slot's previous value is captured
    // before the store so a failed instance-list write below can roll the
    // secret back instead of leaving a value no stored entry points at.
    const previousToken = entry.token
      ? (this._tokens.get(entry.id) ?? (await this.context.secrets.get(this._tokenSecretKey(entry.id))))
      : undefined;
    if (entry.token) {
      await this.context.secrets.store(this._tokenSecretKey(entry.id), entry.token);
      this._tokens.set(entry.id, entry.token);
    }
    const instances = this._getStoredInstances().filter((i) => i.id !== entry.id);
    instances.push({ ...entry, token: '' });
    try {
      await this._writeInstancesMerged(instances);
    } catch (error) {
      // The write failed, so no entry names this id — the freshly stored
      // token would be an orphan. Restore the slot's previous value (or drop
      // the new one when the slot was empty), best-effort: a failed restore
      // must not replace the write's own error.
      if (entry.token) {
        if (previousToken === undefined) {
          this._tokens.delete(entry.id);
          try {
            await this.context.secrets.delete(this._tokenSecretKey(entry.id));
          } catch {
            // Best-effort; see above.
          }
        } else {
          this._tokens.set(entry.id, previousToken);
          try {
            await this.context.secrets.store(this._tokenSecretKey(entry.id), previousToken);
          } catch {
            // Best-effort; see above.
          }
        }
      }
      throw error;
    }
    this._onInstancesChanged.fire(this.getInstances());
  }

  /**
   * Apply a partial update to a stored instance.
   *
   * A `url` update goes through the same refusals `addInstance` applies, and for
   * the same reason: this is the other way a URL reaches the store, and an entry
   * that `fetch` cannot request would fail every call with a message blaming the
   * instance. Callers that already gate the URL (the sidebar's editInstance)
   * are not the only ones — this is the boundary itself.
   *
   * A `url` update that moves to another origin without a new token also drops
   * the stored secret: the credential belongs to the URL it was entered for and
   * must never be sent to a different host.
   */
  async updateInstance(id: string, updates: Partial<Omit<ForgejoInstance, 'id'>>): Promise<void> {
    const instances = this._getStoredInstances();
    const index = instances.findIndex((i) => i.id === id);
    if (index === -1) {
      return;
    }
    if (updates.url !== undefined && (!isHttpUrl(updates.url) || hasUrlUserinfo(updates.url))) {
      throw new Error(vscode.l10n.t('Enter a valid http(s) URL for the Forgejo instance.'));
    }
    // An empty token update means "unchanged", so the stored secret is kept —
    // unless the URL moves to another origin. The secret belongs to the stored
    // URL and must not follow the entry to a host it was never paired with:
    // addInstance gives an id reused with a different URL a fresh id for the
    // same reason, but an update edits in place, so the secret has to go
    // instead. It is deleted from memory and SecretStorage both — init()
    // rehydrates tokens by id, so a surviving stored copy would be re-attached
    // to the new URL at the next activation. The entry is left token-less and
    // the UI asks for a fresh credential.
    //
    // Both mutations capture the slot's previous value first: the
    // instance-list write below may fail, and the rollback then needs the value
    // it is restoring. For the new-token branch this matters as much as for
    // the origin-switch one — a failed write leaves the entry at its old URL
    // while the slot holds a token issued for the new host. `previousToken`
    // stays undefined when this update does not touch the secret slot, so the
    // catch can tell "nothing to roll back" apart from "the slot was empty"
    // (whose rollback deletes the freshly stored value).
    let previousToken: { value: string | undefined } | undefined;
    if (updates.token) {
      previousToken = { value: this._tokens.get(id) ?? (await this.context.secrets.get(this._tokenSecretKey(id))) };
      await this.context.secrets.store(this._tokenSecretKey(id), updates.token);
      this._tokens.set(id, updates.token);
    } else if (updates.url !== undefined && !isSameOriginUrl(instances[index].url, updates.url)) {
      previousToken = { value: this._tokens.get(id) ?? (await this.context.secrets.get(this._tokenSecretKey(id))) };
      this._tokens.delete(id);
      try {
        await this.context.secrets.delete(this._tokenSecretKey(id));
      } catch (error) {
        // The delete failed before the URL write below ran, so storage still
        // holds "old URL + old token" — a consistent pair. Restore the
        // in-memory copy to match it instead of leaving this session with a
        // token-less view of an instance that still has its secret.
        if (previousToken.value !== undefined) {
          this._tokens.set(id, previousToken.value);
        }
        throw error;
      }
    }
    instances[index] = { ...instances[index], ...updates, token: '' };
    try {
      await this._writeInstancesMerged(instances);
    } catch (error) {
      // The delete-then-write order is deliberate (a token must never survive
      // in storage next to a URL it was not paired with), but when the write
      // fails the new URL never landed — leaving the secret slot mutated would
      // strand the instance at its old URL with no credential (origin switch)
      // or with a token issued for a host the entry does not name (new token).
      // Put the previous value back in memory and SecretStorage — or remove
      // the freshly stored one when the slot was empty — best-effort: a failed
      // restore must not replace the write's own error. Then rethrow.
      if (previousToken !== undefined) {
        if (previousToken.value === undefined) {
          this._tokens.delete(id);
          try {
            await this.context.secrets.delete(this._tokenSecretKey(id));
          } catch {
            // Best-effort: a failed delete must not replace the write's own
            // error; the in-memory removal at least keeps this session working.
          }
        } else {
          this._tokens.set(id, previousToken.value);
          try {
            await this.context.secrets.store(this._tokenSecretKey(id), previousToken.value);
          } catch {
            // Best-effort: a failed re-store must not replace the write's own
            // error; the in-memory token at least keeps this session working.
          }
        }
      }
      throw error;
    }
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
    // Capture the slot's previous value first, as addInstance/updateInstance do:
    // the instance-list write below may fail, and the rollback then needs the
    // credential it restores. The in-memory table wins over a SecretStorage
    // read so a token another window rotated is not clobbered by a stale read.
    const previousToken = this._tokens.get(id) ?? (await this.context.secrets.get(this._tokenSecretKey(id)));
    this._tokens.delete(id);
    try {
      await this.context.secrets.delete(this._tokenSecretKey(id));
    } catch (error) {
      // The delete failed before the list write ran, so storage still holds the
      // entry and its secret — a consistent pair. Restore the in-memory copy to
      // match instead of leaving this session with a token-less view of an
      // instance that is still fully configured.
      if (previousToken !== undefined) {
        this._tokens.set(id, previousToken);
      }
      throw error;
    }
    const stored = this._getStoredInstances();
    const removedUrl = stored.find((entry) => entry.id === id)?.url;
    const instances = stored.filter((i) => i.id !== id);
    try {
      await this._writeInstancesMerged(instances, id);
    } catch (error) {
      // The write failed, so the entry is still stored — but its credential is
      // already gone from memory and SecretStorage. Put it back, best-effort: a
      // failed restore must not replace the write's own error.
      if (previousToken !== undefined) {
        this._tokens.set(id, previousToken);
        try {
          await this.context.secrets.store(this._tokenSecretKey(id), previousToken);
        } catch {
          // Best-effort; see above.
        }
      }
      throw error;
    }
    // Runs only after the instance list write landed: the records are forgotten
    // once the instance is really gone, so a failed write above needs no
    // worktree rollback.
    const forgottenWorktrees = await this._worktrees.forgetInstanceWorktrees(id);
    // §9 route 2: the probe result is a property of the instance, so its shared
    // entry goes when the instance does — the "same cleanup semantics as the
    // instance list" half of that decision. Best-effort and merged like every
    // other write here; a lost update only means one extra probe.
    if (removedUrl !== undefined) {
      void deleteSharedServerVersion(removedUrl);
    }
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
