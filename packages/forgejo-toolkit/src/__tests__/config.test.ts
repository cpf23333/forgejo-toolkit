import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import * as path from 'path';
import { ConfigManager } from '../config';
import { clearServerVersions, setServerVersion } from '../api/serverVersion';
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

  afterEach(() => {
    // The probe cache is process-global; each test here gets a fresh store, so
    // the in-memory half has to be dropped too or it would leak across tests.
    clearServerVersions();
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

  it('derives a fresh id when an id is re-added with a different URL', async () => {
    // Same id + different URL is a different instance (slug collisions such as
    // `/a-b` vs `/a/b`, or an import file naming a known id), not an edit:
    // overwriting the stored entry would lose the first instance and rebind its
    // secret to the new URL.
    await config.addInstance(instance);
    await config.addInstance({ ...instance, token: '', url: 'https://forgejo.example.com/other/mount' });

    const instances = config.getInstances();
    expect(instances).toHaveLength(2);
    const [original, added] = instances;
    expect(original.id).toBe(instance.id);
    expect(original.url).toBe(instance.url);
    expect(original.token).toBe('token-1');
    expect(added.url).toBe('https://forgejo.example.com/other/mount');
    expect(added.id).not.toBe(instance.id);
    expect(added.id.startsWith(`${instance.id}-`)).toBe(true);
    // The newcomer's fresh id has no stored secret, so an empty-token add
    // leaves it without a credential rather than borrowing the original's.
    expect(added.token).toBe('');
    expect(fake.secretStore.has(`forgejoToolkit.instanceToken.${added.id}`)).toBe(false);
  });

  it('does not expose the stored secret when an empty-token re-add switches origin', async () => {
    await config.addInstance(instance);
    // An import file can carry a known id with an attacker-chosen URL; the
    // stored token must not follow it to the new host.
    await config.addInstance({ ...instance, token: '', url: 'https://evil.example', name: 'x', username: 'x' });

    const instances = config.getInstances();
    expect(instances).toHaveLength(2);
    const added = instances.find((i) => i.url === 'https://evil.example');
    expect(added?.token).toBe('');
    // The original entry and its credential stay bound to the original URL;
    // the secret is stored under the original id only.
    const original = instances.find((i) => i.id === instance.id);
    expect(original?.url).toBe(instance.url);
    expect(original?.token).toBe('token-1');
    expect(fake.secretStore.get('forgejoToolkit.instanceToken.forgejo.example.com-user')).toBe('token-1');
  });

  it('does not rehydrate a secret for the colliding entry after a reload', async () => {
    await config.addInstance(instance);
    await config.addInstance({ ...instance, token: '', url: 'https://evil.example', name: 'x', username: 'x' });

    // Simulate the next activation over the same storage: init() reads the
    // secret by id, and the derived id has no secret stored under it.
    const reloaded = new ConfigManager(fake.context as never);
    await reloaded.init();

    const instances = reloaded.getInstances();
    expect(instances.find((i) => i.url === 'https://evil.example')?.token).toBe('');
    expect(instances.find((i) => i.id === instance.id)?.token).toBe('token-1');
  });

  it('stores a new token under the derived id on a colliding re-add', async () => {
    await config.addInstance(instance);
    await config.addInstance({ ...instance, token: 'token-2', url: 'https://evil.example' });

    const instances = config.getInstances();
    expect(instances).toHaveLength(2);
    const added = instances.find((i) => i.url === 'https://evil.example');
    expect(added?.token).toBe('token-2');
    expect(fake.secretStore.get(`forgejoToolkit.instanceToken.${added?.id}`)).toBe('token-2');
    expect(instances.find((i) => i.id === instance.id)?.token).toBe('token-1');
  });

  it('gives two instances whose paths slug to the same id distinct ids with their own tokens', async () => {
    // `/a-b` and `/a/b` fold to the same slug, so both compute
    // `forgejo.example.com-a-b-user`: the second add must not overwrite the
    // first (see resolveInstanceIdCollision).
    const first = {
      ...instance,
      id: 'forgejo.example.com-a-b-user',
      url: 'https://forgejo.example.com/a-b',
      token: 'token-1',
    };
    const second = {
      ...instance,
      id: 'forgejo.example.com-a-b-user',
      url: 'https://forgejo.example.com/a/b',
      token: 'token-2',
    };
    await config.addInstance(first);
    await config.addInstance(second);

    const instances = config.getInstances();
    expect(instances).toHaveLength(2);
    const storedFirst = instances.find((i) => i.url === first.url);
    const storedSecond = instances.find((i) => i.url === second.url);
    expect(storedFirst?.id).toBe(first.id);
    expect(storedFirst?.token).toBe('token-1');
    expect(storedSecond?.id).not.toBe(first.id);
    expect(storedSecond?.token).toBe('token-2');
    // The derivation is deterministic: removing and re-adding the second
    // instance lands on the same id again.
    await config.removeInstance(storedSecond?.id ?? '');
    await config.addInstance(second);
    expect(config.getInstances().find((i) => i.url === second.url)?.id).toBe(storedSecond?.id);
  });

  it('refuses a non-http(s) URL instead of storing it', async () => {
    // Defence in depth at the storage boundary: an entry with a file:/data: URL
    // can never be talked to, would be rendered as a link by the webview and can
    // reach openExternal, so nothing may persist it.
    await expect(
      config.addInstance({ ...instance, url: 'file:///etc/passwd', token: '', name: 'x', username: 'x' }),
    ).rejects.toThrow('Enter a valid http(s) URL for the Forgejo instance.');
    await expect(config.addInstance({ ...instance, url: 'not a valid url' })).rejects.toThrow(
      'Enter a valid http(s) URL for the Forgejo instance.',
    );

    expect(config.getInstances()).toHaveLength(0);
    expect(fake.secretStore.size).toBe(0);
  });

  it('refuses a URL that embeds a credential instead of storing one that cannot work', async () => {
    // Node's `fetch` refuses to construct a request from a URL carrying
    // credentials, so such an entry would be stored and then fail every request
    // with a message blaming the instance ("check that it is running"). The
    // credential belongs in the token field, which SecretStorage holds and the
    // client sends as an Authorization header.
    await expect(
      config.addInstance({ ...instance, url: 'https://alice:token-1@forgejo.example.com', token: 'token-1' }),
    ).rejects.toThrow('Enter a valid http(s) URL for the Forgejo instance.');
    await expect(
      config.addInstance({ ...instance, url: 'https://token-1@forgejo.example.com', token: 'token-1' }),
    ).rejects.toThrow('Enter a valid http(s) URL for the Forgejo instance.');

    expect(config.getInstances()).toHaveLength(0);
    // Nothing was stored, not even the credential the URL carried.
    expect(fake.secretStore.size).toBe(0);
  });

  it('accepts a URL whose path merely contains an `@`', async () => {
    // `hasUrlUserinfo` must not mistake a path segment for userinfo.
    await config.addInstance({ ...instance, url: 'https://forgejo.example.com/owner@example/repo' });
    expect(config.getInstances()[0].url).toBe('https://forgejo.example.com/owner@example/repo');
  });

  it('fails closed on an unparseable stored URL instead of reusing the stored secret', async () => {
    // A stored entry can predate the scheme/parse checks (hand-edited storage, an
    // older build). Its URL differs from the re-added one, so the re-add gets a
    // fresh id and the secret stays bound to the broken entry alone.
    await fake.context.globalState.update('forgejoToolkit.instances', [
      { ...instance, token: '', url: 'not a valid url' },
    ]);
    await fake.context.secrets.store('forgejoToolkit.instanceToken.forgejo.example.com-user', 'token-1');

    await config.addInstance({ ...instance, token: '' });

    const instances = config.getInstances();
    expect(instances).toHaveLength(2);
    const added = instances.find((i) => i.url === instance.url);
    expect(added?.id).not.toBe(instance.id);
    expect(added?.token).toBe('');
    expect(instances.find((i) => i.id === instance.id)?.url).toBe('not a valid url');
  });

  it('keeps the stored secret on an empty-token update and replaces it on a non-empty one', async () => {
    await config.addInstance(instance);
    await config.updateInstance(instance.id, { token: '', name: 'renamed' });
    expect(config.getInstances()[0].token).toBe('token-1');
    expect(config.getInstances()[0].name).toBe('renamed');

    await config.updateInstance(instance.id, { token: 'token-2' });
    expect(config.getInstances()[0].token).toBe('token-2');
  });

  it('drops the stored secret when an update moves the URL to another origin without a new token', async () => {
    // An empty token update means "unchanged", but the stored credential belongs
    // to the stored URL: keeping it would send the token to a host it was never
    // paired with (addInstance gives a colliding id a fresh id for the same
    // reason; an update edits in place, so the secret has to go instead).
    await config.addInstance(instance);
    await config.updateInstance(instance.id, { url: 'https://evil.example' });

    const [stored] = config.getInstances();
    expect(stored.url).toBe('https://evil.example');
    expect(stored.token).toBe('');
    // Deleted, not merely hidden: init() rehydrates tokens by id, so a
    // surviving SecretStorage entry would be re-attached to the new URL at the
    // next activation.
    expect(fake.secretStore.has('forgejoToolkit.instanceToken.forgejo.example.com-user')).toBe(false);
  });

  it('restores the dropped secret when the instance write fails after an origin switch', async () => {
    // The delete-then-write order keeps the token from ever sitting next to a
    // URL it was not paired with; when the write fails, the new URL never
    // landed, so the credential must be put back rather than lost.
    await config.addInstance(instance);
    const realUpdate = fake.context.globalState.update;
    fake.context.globalState.update = async () => {
      throw new Error('storage full');
    };
    try {
      await expect(config.updateInstance(instance.id, { url: 'https://evil.example' })).rejects.toThrow('storage full');
    } finally {
      fake.context.globalState.update = realUpdate;
    }

    const [stored] = config.getInstances();
    // (The fake store returns its array by reference, so the in-place edit of
    // the entry is visible regardless of the failed write; what the rollback
    // must restore is the credential.)
    expect(stored.token).toBe('token-1');
    expect(fake.secretStore.get('forgejoToolkit.instanceToken.forgejo.example.com-user')).toBe('token-1');
  });

  it('restores the replaced secret when the instance write fails after a token update', async () => {
    // The new token is stored before the instance list is written; when the
    // write fails the entry keeps its old URL, so the slot must not keep a
    // token that was issued for the new host.
    await config.addInstance(instance);
    const realUpdate = fake.context.globalState.update;
    fake.context.globalState.update = async () => {
      throw new Error('storage full');
    };
    try {
      await expect(config.updateInstance(instance.id, { token: 'token-2' })).rejects.toThrow('storage full');
    } finally {
      fake.context.globalState.update = realUpdate;
    }

    expect(config.getInstances()[0].token).toBe('token-1');
    expect(fake.secretStore.get('forgejoToolkit.instanceToken.forgejo.example.com-user')).toBe('token-1');
  });

  it('deletes the freshly stored secret when the write fails and the slot was empty', async () => {
    // With no previous credential to restore, the rollback of a failed write
    // removes the token the update just stored: the entry still names the old
    // URL, and a leftover token would authenticate against it without the user
    // ever having saved that pairing.
    await config.addInstance({ ...instance, token: '' });
    const realUpdate = fake.context.globalState.update;
    fake.context.globalState.update = async () => {
      throw new Error('storage full');
    };
    try {
      await expect(config.updateInstance(instance.id, { token: 'token-2' })).rejects.toThrow('storage full');
    } finally {
      fake.context.globalState.update = realUpdate;
    }

    expect(config.getInstances()[0].token).toBe('');
    expect(fake.secretStore.has('forgejoToolkit.instanceToken.forgejo.example.com-user')).toBe(false);
  });

  it('keeps the secret dropped when the origin switch succeeds', async () => {
    // The rollback above restores the credential only on a failed write; a
    // successful origin switch must still leave the instance token-less.
    await config.addInstance(instance);
    await config.updateInstance(instance.id, { url: 'https://evil.example' });

    expect(config.getInstances()[0].token).toBe('');
    expect(fake.secretStore.has('forgejoToolkit.instanceToken.forgejo.example.com-user')).toBe(false);
  });

  it('rolls back the stored token when addInstance fails to write the instance list', async () => {
    // The secret is stored before the list write; if the write fails no entry
    // names the id, so the fresh token must not be left as an orphan.
    const realUpdate = fake.context.globalState.update;
    fake.context.globalState.update = async () => {
      throw new Error('storage full');
    };
    try {
      await expect(config.addInstance(instance)).rejects.toThrow('storage full');
    } finally {
      fake.context.globalState.update = realUpdate;
    }

    expect(fake.secretStore.has('forgejoToolkit.instanceToken.forgejo.example.com-user')).toBe(false);
    expect(config.getInstances()).toHaveLength(0);
  });

  it('restores the previous token when a re-add fails to write the instance list', async () => {
    await config.addInstance(instance);
    const realUpdate = fake.context.globalState.update;
    fake.context.globalState.update = async () => {
      throw new Error('storage full');
    };
    try {
      await expect(config.addInstance({ ...instance, token: 'token-2' })).rejects.toThrow('storage full');
    } finally {
      fake.context.globalState.update = realUpdate;
    }

    expect(fake.secretStore.get('forgejoToolkit.instanceToken.forgejo.example.com-user')).toBe('token-1');
    expect(config.getInstances()[0].token).toBe('token-1');
  });

  it('restores the in-memory token when the secret delete of an origin switch fails', async () => {
    // The delete failed before the URL write ran, so storage still holds the
    // consistent "old URL + old token" pair; the in-memory copy must match it
    // instead of leaving this session with a token-less view of the instance.
    await config.addInstance(instance);
    const realDelete = fake.context.secrets.delete;
    fake.context.secrets.delete = async () => {
      throw new Error('keyring unavailable');
    };
    try {
      await expect(config.updateInstance(instance.id, { url: 'https://evil.example' })).rejects.toThrow(
        'keyring unavailable',
      );
    } finally {
      fake.context.secrets.delete = realDelete;
    }

    expect(config.getInstances()[0].token).toBe('token-1');
    expect(fake.secretStore.get('forgejoToolkit.instanceToken.forgejo.example.com-user')).toBe('token-1');
  });

  it('does not reattach the dropped secret to the new origin after a reload', async () => {
    await config.addInstance(instance);
    await config.updateInstance(instance.id, { url: 'https://evil.example' });

    const reloaded = new ConfigManager(fake.context as never);
    await reloaded.init();

    const [stored] = reloaded.getInstances();
    expect(stored.url).toBe('https://evil.example');
    expect(stored.token).toBe('');
  });

  it('keeps the stored secret when an update changes only the path on the same origin', async () => {
    await config.addInstance(instance);
    await config.updateInstance(instance.id, { url: 'https://forgejo.example.com/other/mount' });

    expect(config.getInstances()[0].url).toBe('https://forgejo.example.com/other/mount');
    expect(config.getInstances()[0].token).toBe('token-1');
  });

  it('accepts a new token together with an origin switch', async () => {
    await config.addInstance(instance);
    await config.updateInstance(instance.id, { url: 'https://evil.example', token: 'token-2' });

    expect(config.getInstances()[0].token).toBe('token-2');
    expect(fake.secretStore.get('forgejoToolkit.instanceToken.forgejo.example.com-user')).toBe('token-2');
  });

  it('refuses a URL update that embeds a credential, keeping the stored one', async () => {
    // The other way a URL reaches the store, so the boundary check cannot live
    // only in the sidebar's editInstance.
    await config.addInstance(instance);

    await expect(
      config.updateInstance(instance.id, { url: 'https://alice:token-1@forgejo.example.com' }),
    ).rejects.toThrow('Enter a valid http(s) URL for the Forgejo instance.');
    await expect(config.updateInstance(instance.id, { url: 'file:///etc/passwd' })).rejects.toThrow(
      'Enter a valid http(s) URL for the Forgejo instance.',
    );

    expect(config.getInstances()[0].url).toBe(instance.url);
  });

  it('still applies an update that does not touch the URL', async () => {
    await config.addInstance(instance);
    await config.updateInstance(instance.id, { syncApiUrlsToInstanceUrl: true });
    expect(config.getInstances()[0].syncApiUrlsToInstanceUrl).toBe(true);
  });

  it('deletes the secret when the instance is removed', async () => {
    await config.addInstance(instance);
    await config.removeInstance(instance.id);
    expect(fake.secretStore.has('forgejoToolkit.instanceToken.forgejo.example.com-user')).toBe(false);
    expect(config.getInstances()).toHaveLength(0);
  });

  it('records probed versions in the shared key beside the instance list', () => {
    // §9 route 2: the manager hands the probe cache the store it lives in, so a
    // probe lands in globalState under its own key instead of staying in one
    // window's memory. The instance list itself is not touched by a probe.
    setServerVersion(instance.url, '16.0.1');

    expect(fake.store.get('forgejoToolkit.serverVersions')).toEqual({
      [instance.url]: { version: '16.0.1', writtenAt: expect.any(Number) },
    });
    expect(fake.store.get('forgejoToolkit.instances')).toBeUndefined();
  });

  it('drops the shared probe result when the instance is removed', async () => {
    // A probed version is a property of an instance: it goes when the instance
    // does, which is the "same cleanup semantics as the instance list" half of
    // §9 route 2.
    await config.addInstance(instance);
    setServerVersion(instance.url, '16.0.1');

    await config.removeInstance(instance.id);

    expect(fake.store.get('forgejoToolkit.serverVersions')).toEqual({});
  });

  it('restores the token when the instance-list write fails during removal', async () => {
    // The token is deleted before the list write; when the write fails the
    // entry is still stored, so its credential must be put back in memory and
    // SecretStorage instead of leaving a configured instance with no token.
    await config.addInstance(instance);
    await fake.context.globalState.update('forgejoToolkit.worktrees', [
      {
        id: 'w1',
        instanceId: instance.id,
        owner: 'owner',
        repo: 'repo',
        prIndex: 1,
        prTitle: 'title',
        headBranch: 'feature',
        headSha: 'abc1234',
        baseBranch: 'main',
        sourceRepoPath: '/cache/repos/owner-repo.git',
        worktreePath: '/cache/worktrees/w1',
        createdAt: 0,
      },
    ]);
    const realUpdate = fake.context.globalState.update;
    fake.context.globalState.update = async (key: string, value: unknown) => {
      if (key === 'forgejoToolkit.instances') {
        throw new Error('storage full');
      }
      return realUpdate(key, value);
    };
    try {
      await expect(config.removeInstance(instance.id)).rejects.toThrow('storage full');
    } finally {
      fake.context.globalState.update = realUpdate;
    }

    expect(config.getInstances()[0]?.token).toBe('token-1');
    expect(fake.secretStore.get('forgejoToolkit.instanceToken.forgejo.example.com-user')).toBe('token-1');
    // The write failed before the forget ran, so the worktree record survives:
    // the instance it belongs to was never removed.
    const worktrees = fake.context.globalState.get('forgejoToolkit.worktrees', []) as Array<{ id: string }>;
    expect(worktrees.map((w) => w.id)).toEqual(['w1']);
  });

  it('restores the in-memory token when the secret delete of a removal fails', async () => {
    // The delete failed before the list write ran, so storage still holds the
    // consistent "entry + secret" pair; the in-memory copy must match it.
    await config.addInstance(instance);
    const realDelete = fake.context.secrets.delete;
    fake.context.secrets.delete = async () => {
      throw new Error('keyring unavailable');
    };
    try {
      await expect(config.removeInstance(instance.id)).rejects.toThrow('keyring unavailable');
    } finally {
      fake.context.secrets.delete = realDelete;
    }

    expect(config.getInstances()[0]?.token).toBe('token-1');
    expect(fake.secretStore.get('forgejoToolkit.instanceToken.forgejo.example.com-user')).toBe('token-1');
  });

  it('migrates legacy plaintext tokens from globalState into SecretStorage on init', async () => {
    await fake.context.globalState.update('forgejoToolkit.instances', [instance]);
    await config.init();
    expect(fake.secretStore.get('forgejoToolkit.instanceToken.forgejo.example.com-user')).toBe('token-1');
    const stored = fake.context.globalState.get('forgejoToolkit.instances', []) as ForgejoInstance[];
    expect(stored[0].token).toBe('');
    expect(config.getInstances()[0].token).toBe('token-1');
  });

  it('keeps the SecretStorage listener alive when the init migration throws', async () => {
    // On a system without a working keyring, secrets.get/store reject during
    // the migration; the onDidChange registration must not be skipped along
    // with the failed migration, or this window would stop tracking other
    // windows' token edits for the rest of the session.
    await fake.context.globalState.update('forgejoToolkit.instances', [instance]);
    const realGet = fake.context.secrets.get;
    fake.context.secrets.get = async () => {
      throw new Error('no keyring');
    };
    await expect(config.init()).rejects.toThrow('no keyring');
    expect(fake.context.subscriptions).toHaveLength(1);

    // The listener registered before the migration is still live.
    fake.context.secrets.get = realGet;
    const fireSpy = (config as unknown as { _onInstancesChanged: { fire: ReturnType<typeof vi.fn> } })
      ._onInstancesChanged.fire;
    fireSpy.mockClear();
    const tokenKey = 'forgejoToolkit.instanceToken.forgejo.example.com-user';
    await fake.context.secrets.store(tokenKey, 'token-rotated');
    fake.fireSecretChange(tokenKey);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(config.getInstances()[0].token).toBe('token-rotated');
    expect(fireSpy).toHaveBeenCalledTimes(1);
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
