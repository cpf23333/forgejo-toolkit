import { describe, it, expect, beforeEach, vi } from 'vitest';
import * as path from 'path';
import { ConfigManager } from '../config';
import type { ForgejoInstance } from '@cpf23333-forgejo-toolkit/shared/webview/messages';

function createFakeContext() {
  const store = new Map<string, unknown>();
  const secretStore = new Map<string, string>();
  const secretListeners: Array<(event: { key: string }) => void> = [];
  return {
    store,
    secretStore,
    fireSecretChange(key: string) {
      for (const listener of secretListeners) {
        listener({ key });
      }
    },
    context: {
      subscriptions: [] as Array<{ dispose(): void }>,
      globalState: {
        get: (key: string, fallback?: unknown) => store.get(key) ?? fallback,
        update: async (key: string, value: unknown) => {
          store.set(key, value);
        },
      },
      globalStorageUri: { fsPath: '/global-storage' },
      secrets: {
        get: async (key: string) => secretStore.get(key),
        store: async (key: string, value: string) => {
          secretStore.set(key, value);
        },
        delete: async (key: string) => {
          secretStore.delete(key);
        },
        onDidChange: (listener: (event: { key: string }) => void) => {
          secretListeners.push(listener);
          return { dispose: () => undefined };
        },
      },
    },
  };
}

const instance: ForgejoInstance = {
  id: 'forgejo.example.com-user',
  url: 'https://forgejo.example.com',
  token: 'token-1',
  name: 'user@forgejo.example.com',
  username: 'user',
};

describe('ConfigManager', () => {
  let fake: ReturnType<typeof createFakeContext>;
  let config: ConfigManager;

  beforeEach(() => {
    fake = createFakeContext();
    config = new ConfigManager(fake.context as never);
  });

  it('stores tokens in SecretStorage and never in globalState', async () => {
    await config.addInstance(instance);
    const stored = fake.context.globalState.get('forgejoToolkit.instances', []) as ForgejoInstance[];
    expect(stored[0].token).toBe('');
    expect(fake.secretStore.get('forgejoToolkit.instanceToken.forgejo.example.com-user')).toBe('token-1');
    expect(config.getInstances()[0].token).toBe('token-1');
  });

  it('keeps the existing secret when re-adding the same id with an empty token', async () => {
    await config.addInstance(instance);
    // Re-adding without a token means "keep the existing credential".
    await config.addInstance({ ...instance, token: '' });
    expect(config.getInstances()[0].token).toBe('token-1');
    expect(fake.secretStore.get('forgejoToolkit.instanceToken.forgejo.example.com-user')).toBe('token-1');
  });

  it('keeps the stored secret on an empty-token same-origin re-add with another path', async () => {
    await config.addInstance(instance);
    await config.addInstance({ ...instance, token: '', url: 'https://forgejo.example.com/other/mount' });
    expect(config.getInstances()[0].url).toBe('https://forgejo.example.com/other/mount');
    expect(config.getInstances()[0].token).toBe('token-1');
  });

  it('does not expose the stored secret when an empty-token re-add switches origin', async () => {
    await config.addInstance(instance);
    // An import file can carry a known id with an attacker-chosen URL; the
    // stored token must not follow it to the new host.
    await config.addInstance({ ...instance, token: '', url: 'https://evil.example', name: 'x', username: 'x' });

    const [stored] = config.getInstances();
    expect(stored.url).toBe('https://evil.example');
    expect(stored.token).toBe('');
    // The secret must be removed, not merely hidden: tokens are rehydrated by
    // instance id, so a surviving entry would be attached to the new URL again
    // at the next activation.
    expect(fake.secretStore.has('forgejoToolkit.instanceToken.forgejo.example.com-user')).toBe(false);
  });

  it('does not rehydrate the old secret for the new origin after a reload', async () => {
    await config.addInstance(instance);
    await config.addInstance({ ...instance, token: '', url: 'https://evil.example', name: 'x', username: 'x' });

    // Simulate the next activation over the same storage: init() reads the
    // secret by id, so this is where a surviving entry would leak the token.
    const reloaded = new ConfigManager(fake.context as never);
    await reloaded.init();

    const [stored] = reloaded.getInstances();
    expect(stored.url).toBe('https://evil.example');
    expect(stored.token).toBe('');
  });

  it('still accepts a new token on a different-origin re-add', async () => {
    await config.addInstance(instance);
    await config.addInstance({ ...instance, token: 'token-2', url: 'https://evil.example' });

    expect(config.getInstances()[0].token).toBe('token-2');
    expect(fake.secretStore.get('forgejoToolkit.instanceToken.forgejo.example.com-user')).toBe('token-2');
  });

  it('fails closed on an unparseable URL instead of reusing the stored secret', async () => {
    await config.addInstance(instance);
    await config.addInstance({ ...instance, token: '', url: 'not a valid url' });

    expect(config.getInstances()[0].token).toBe('');

    // The same must hold when the *stored* URL is the unparseable side.
    const broken = createFakeContext();
    const brokenConfig = new ConfigManager(broken.context as never);
    await brokenConfig.addInstance({ ...instance, url: 'not a valid url' });
    await brokenConfig.addInstance({ ...instance, token: '' });
    expect(brokenConfig.getInstances()[0].token).toBe('');
  });

  it('keeps the stored secret on an empty-token update and replaces it on a non-empty one', async () => {
    await config.addInstance(instance);
    await config.updateInstance(instance.id, { token: '', name: 'renamed' });
    expect(config.getInstances()[0].token).toBe('token-1');
    expect(config.getInstances()[0].name).toBe('renamed');

    await config.updateInstance(instance.id, { token: 'token-2' });
    expect(config.getInstances()[0].token).toBe('token-2');
  });

  it('deletes the secret when the instance is removed', async () => {
    await config.addInstance(instance);
    await config.removeInstance(instance.id);
    expect(fake.secretStore.has('forgejoToolkit.instanceToken.forgejo.example.com-user')).toBe(false);
    expect(config.getInstances()).toHaveLength(0);
  });

  it('migrates legacy plaintext tokens from globalState into SecretStorage on init', async () => {
    await fake.context.globalState.update('forgejoToolkit.instances', [instance]);
    await config.init();
    expect(fake.secretStore.get('forgejoToolkit.instanceToken.forgejo.example.com-user')).toBe('token-1');
    const stored = fake.context.globalState.get('forgejoToolkit.instances', []) as ForgejoInstance[];
    expect(stored[0].token).toBe('');
    expect(config.getInstances()[0].token).toBe('token-1');
  });

  it('refreshes the in-memory token table when SecretStorage changes elsewhere', async () => {
    await config.addInstance(instance);
    await config.init();
    // The mocked vscode EventEmitter does not wire fire() to event listeners,
    // so assert on the fire spy instead of a subscribed callback.
    const fireSpy = (config as unknown as { _onInstancesChanged: { fire: ReturnType<typeof vi.fn> } })
      ._onInstancesChanged.fire;
    fireSpy.mockClear();

    // Another window rotated the token directly in SecretStorage.
    const tokenKey = 'forgejoToolkit.instanceToken.forgejo.example.com-user';
    await fake.context.secrets.store(tokenKey, 'token-rotated');
    fake.fireSecretChange(tokenKey);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(config.getInstances()[0].token).toBe('token-rotated');
    expect(fireSpy).toHaveBeenCalledTimes(1);

    // Deletion elsewhere clears the cached token too.
    await fake.context.secrets.delete(tokenKey);
    fake.fireSecretChange(tokenKey);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(config.getInstances()[0].token).toBe('');
    expect(fireSpy).toHaveBeenCalledTimes(2);
  });

  it('ignores SecretStorage changes for unrelated keys', async () => {
    await config.addInstance(instance);
    await config.init();
    const fireSpy = (config as unknown as { _onInstancesChanged: { fire: ReturnType<typeof vi.fn> } })
      ._onInstancesChanged.fire;
    fireSpy.mockClear();

    fake.fireSecretChange('forgejoToolkit.somethingElse');
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(fireSpy).not.toHaveBeenCalled();
    expect(config.getInstances()[0].token).toBe('token-1');
  });

  /**
   * Rig globalState.get so that right after this window reads the instance
   * list, "another window" writes an extra instance into the shared store.
   * The write path must then merge instead of dropping the concurrent entry.
   */
  function injectConcurrentAdd(concurrent: ForgejoInstance) {
    const realGet = fake.context.globalState.get;
    let firstRead = true;
    fake.context.globalState.get = (key: string, fallback?: unknown) => {
      const value = realGet(key, fallback);
      if (firstRead && key === 'forgejoToolkit.instances') {
        firstRead = false;
        fake.store.set(key, [...(value as ForgejoInstance[]), concurrent]);
      }
      return value;
    };
    return () => {
      fake.context.globalState.get = realGet;
    };
  }

  it('preserves an instance added by another window during addInstance', async () => {
    await config.addInstance(instance);
    const concurrent: ForgejoInstance = {
      id: 'other-window-instance',
      url: 'https://forgejo.example.com',
      token: '',
      name: 'other',
      username: 'other',
    };
    const restore = injectConcurrentAdd(concurrent);

    await config.addInstance({ ...instance, id: 'new-instance' });
    restore();

    const ids = (fake.store.get('forgejoToolkit.instances') as ForgejoInstance[]).map((i) => i.id);
    expect(ids).toContain('other-window-instance');
    expect(ids).toContain('new-instance');
  });

  it('preserves an instance added by another window during removeInstance', async () => {
    await config.addInstance(instance);
    const concurrent: ForgejoInstance = {
      id: 'other-window-instance',
      url: 'https://forgejo.example.com',
      token: '',
      name: 'other',
      username: 'other',
    };
    const restore = injectConcurrentAdd(concurrent);

    await config.removeInstance(instance.id);
    restore();

    const ids = (fake.store.get('forgejoToolkit.instances') as ForgejoInstance[]).map((i) => i.id);
    expect(ids).toContain('other-window-instance');
    expect(ids).not.toContain(instance.id);
  });

  it('preserves an instance added by another window during the legacy-token migration', async () => {
    // init() rewrites the whole list to strip the migrated plaintext token; a
    // plain globalState.update would drop whatever another window added between
    // that read and the write.
    await fake.context.globalState.update('forgejoToolkit.instances', [instance]);
    const concurrent: ForgejoInstance = {
      id: 'other-window-instance',
      url: 'https://forgejo.example.com',
      token: 'other-window-token',
      name: 'other',
      username: 'other',
    };
    const restore = injectConcurrentAdd(concurrent);

    await config.init();
    restore();

    const stored = fake.store.get('forgejoToolkit.instances') as ForgejoInstance[];
    expect(stored.map((i) => i.id)).toEqual([instance.id, 'other-window-instance']);
    // The migrated entry keeps no plaintext token, and neither does the entry
    // the merge picked up from the store.
    expect(stored.every((i) => i.token === '')).toBe(true);
  });

  it('drops the worktree records of the removed instance and their cache-usage entries', async () => {
    await config.addInstance(instance);
    const record = (id: string, sourceRepoPath: string) => ({
      id,
      instanceId: instance.id,
      owner: 'owner',
      repo: 'repo',
      prIndex: 1,
      prTitle: 'title',
      headBranch: 'feature',
      headSha: 'abc1234',
      baseBranch: 'main',
      sourceRepoPath,
      worktreePath: `/cache/worktrees/${id}`,
      createdAt: 0,
    });
    await fake.context.globalState.update('forgejoToolkit.worktrees', [
      record('w1', '/cache/repos/owner-repo.git'),
      record('w2', '/other/repo.git'),
      { ...record('w3', '/cache/repos/other.git'), id: 'w3', instanceId: 'another-instance' },
    ]);
    await fake.context.globalState.update('forgejoToolkit.cacheRepoUsage', {
      '/cache/repos/owner-repo.git': 1,
      '/other/repo.git': 2,
      '/cache/repos/other.git': 3,
    });

    const removed = await config.removeInstance(instance.id);

    expect(removed.removed).toBe(2);
    // The checkouts stay on disk, so the caller is told where they are (a
    // checkout backed by an ordinary clone is never reclaimed by the sweep).
    expect(removed.strandedCheckouts).toEqual(['/cache/worktrees/w1', '/cache/worktrees/w2']);
    const worktrees = fake.context.globalState.get('forgejoToolkit.worktrees', []) as Array<{ id: string }>;
    expect(worktrees.map((w) => w.id)).toEqual(['w3']);
    // Only the clones no surviving record references lose their usage entry:
    // the shared one stays tracked.
    const usage = fake.context.globalState.get('forgejoToolkit.cacheRepoUsage', {}) as Record<string, number>;
    expect(Object.keys(usage).map((key) => path.posix.basename(key.replace(/\\/g, '/')))).toEqual(['other.git']);
  });
});
