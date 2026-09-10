import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ConfigManager } from '../config';
import type { ForgejoInstance } from '@cpf23333-forgejo-toolkit/shared/webview/messages';

function createFakeContext() {
  const store = new Map<string, unknown>();
  const secretStore = new Map<string, string>();
  const secretListeners: Array<(event: { key: string }) => void> = [];
  return {
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
});
