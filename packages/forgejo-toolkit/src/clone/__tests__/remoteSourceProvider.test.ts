import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as vscode from 'vscode';
import type { ForgejoInstance } from '@cpf23333-forgejo-toolkit/shared/webview/messages';

const clientMocks = vi.hoisted(() => ({
  searchRepositories: vi.fn(),
  getUserRepositories: vi.fn(),
}));

vi.mock('../../api/client', () => ({
  ForgejoClient: vi.fn().mockImplementation(function () {
    return {
      searchRepositories: clientMocks.searchRepositories,
      getUserRepositories: clientMocks.getUserRepositories,
    };
  }),
}));

import {
  ForgejoRemoteSourceProvider,
  registerForgejoRemoteSourceProviders,
  syncRemoteSourceProviders,
  toRemoteSource,
  type GitApi,
  type RemoteSourceProvider,
} from '../remoteSourceProvider';

const testInstance: ForgejoInstance = {
  id: 'forgejo.example.com-user',
  url: 'https://forgejo.example.com',
  token: 'secret-token',
  name: 'user@forgejo.example.com',
  username: 'user',
};

function createRepo(overrides: Record<string, unknown> = {}) {
  return {
    id: 1,
    name: 'demo',
    full_name: 'owner/demo',
    html_url: 'https://forgejo.example.com/owner/demo',
    private: false,
    description: 'a demo repo',
    owner: { id: 1, login: 'owner', full_name: '', email: '', avatar_url: '' },
    default_branch: 'main',
    stars_count: 0,
    forks_count: 0,
    open_issues_count: 0,
    ...overrides,
  };
}

function createFakeGitApi() {
  const providers: RemoteSourceProvider[] = [];
  const disposables: Array<{ dispose: ReturnType<typeof vi.fn> }> = [];
  const api: GitApi = {
    registerRemoteSourceProvider: vi.fn((provider: RemoteSourceProvider) => {
      providers.push(provider);
      const disposable = { dispose: vi.fn() };
      disposables.push(disposable);
      return disposable;
    }),
  };
  return { api, providers, disposables };
}

function createFakeContext() {
  return { subscriptions: [] as Array<{ dispose(): void }> };
}

describe('ForgejoRemoteSourceProvider', () => {
  beforeEach(() => {
    clientMocks.searchRepositories.mockReset();
    clientMocks.getUserRepositories.mockReset();
  });

  it('is named after the instance and supports server-side queries', () => {
    const provider = new ForgejoRemoteSourceProvider(testInstance);
    expect(provider.name).toBe('user@forgejo.example.com');
    expect(provider.supportsQuery).toBe(true);
  });

  it('searches repositories server-side when a query is given', async () => {
    clientMocks.searchRepositories.mockResolvedValue([
      createRepo({
        clone_url: 'https://forgejo.example.com/owner/demo.git',
        ssh_url: 'git@forgejo.example.com:owner/demo.git',
      }),
    ]);
    const provider = new ForgejoRemoteSourceProvider(testInstance);

    const sources = await provider.getRemoteSources('  demo  ');

    expect(clientMocks.searchRepositories).toHaveBeenCalledWith('demo');
    expect(clientMocks.getUserRepositories).not.toHaveBeenCalled();
    expect(sources).toEqual([
      {
        name: 'owner/demo',
        description: 'a demo repo',
        url: ['https://forgejo.example.com/owner/demo.git', 'git@forgejo.example.com:owner/demo.git'],
      },
    ]);
  });

  it("lists the user's own repositories when no query is given", async () => {
    clientMocks.getUserRepositories.mockResolvedValue([createRepo({ description: '' })]);
    const provider = new ForgejoRemoteSourceProvider(testInstance);

    const sources = await provider.getRemoteSources();

    expect(clientMocks.getUserRepositories).toHaveBeenCalledTimes(1);
    expect(clientMocks.searchRepositories).not.toHaveBeenCalled();
    expect(sources).toHaveLength(1);
    expect(sources[0].name).toBe('owner/demo');
    expect(sources[0].description).toBeUndefined();
    // No clone_url in the payload: falls back to the constructed HTTPS URL.
    expect(sources[0].url).toEqual(['https://forgejo.example.com/owner/demo.git']);
  });

  it('rethrows a user-facing error so the git quick pick can display it', async () => {
    clientMocks.searchRepositories.mockRejectedValue(new Error('network down'));
    const provider = new ForgejoRemoteSourceProvider(testInstance);

    await expect(provider.getRemoteSources('demo')).rejects.toThrow('network down');
  });
});

describe('toRemoteSource', () => {
  it('trims a trailing slash from the instance url when constructing the clone url', () => {
    const source = toRemoteSource({ ...testInstance, url: 'https://forgejo.example.com/' }, createRepo());
    expect(source.url).toEqual(['https://forgejo.example.com/owner/demo.git']);
  });
});

describe('syncRemoteSourceProviders', () => {
  it('registers new instances once and disposes removed ones', () => {
    const { api, providers, disposables } = createFakeGitApi();
    const registrations = new Map<string, { dispose(): void }>();
    const other: ForgejoInstance = { ...testInstance, id: 'codeberg.org-user', url: 'https://codeberg.org' };

    syncRemoteSourceProviders(api, [testInstance, other], registrations);
    expect(providers).toHaveLength(2);
    expect(registrations.size).toBe(2);

    // Re-sync with the same list: no duplicate registrations.
    syncRemoteSourceProviders(api, [testInstance, other], registrations);
    expect(providers).toHaveLength(2);

    // Removing an instance disposes only its registration.
    syncRemoteSourceProviders(api, [other], registrations);
    expect(registrations.size).toBe(1);
    expect(registrations.has('codeberg.org-user')).toBe(true);
    expect(disposables[0].dispose).toHaveBeenCalledTimes(1);
    expect(disposables[1].dispose).not.toHaveBeenCalled();
  });
});

describe('registerForgejoRemoteSourceProviders', () => {
  const getExtension = () => vi.mocked(vscode.extensions.getExtension);

  beforeEach(() => {
    getExtension().mockReset();
  });

  function createConfig(instances: ForgejoInstance[]) {
    const listeners: Array<(i: ForgejoInstance[]) => void> = [];
    return {
      listeners,
      getInstances: vi.fn(() => instances),
      onInstancesChanged: vi.fn((listener: (i: ForgejoInstance[]) => void) => {
        listeners.push(listener);
        return { dispose: vi.fn() };
      }),
    };
  }

  it('does nothing when the git extension is not installed', async () => {
    getExtension().mockReturnValue(undefined as never);
    const config = createConfig([testInstance]);

    await registerForgejoRemoteSourceProviders(createFakeContext() as never, config);

    expect(config.onInstancesChanged).not.toHaveBeenCalled();
  });

  it('registers a provider per instance and re-syncs on instance changes', async () => {
    const { api, providers } = createFakeGitApi();
    getExtension().mockReturnValue({
      activate: vi.fn(async () => ({ enabled: true, getAPI: vi.fn(() => api) })),
    } as never);
    const config = createConfig([testInstance]);
    const context = createFakeContext();

    await registerForgejoRemoteSourceProviders(context as never, config);

    expect(providers).toHaveLength(1);
    expect(providers[0].name).toBe('user@forgejo.example.com');
    expect(config.onInstancesChanged).toHaveBeenCalledTimes(1);

    // Simulate an instance addition through the captured change listener.
    config.listeners[0]([testInstance, { ...testInstance, id: 'codeberg.org-user', name: 'user@codeberg.org' }]);
    expect(providers).toHaveLength(2);

    // Disposing the extension context disposes all provider registrations.
    for (const subscription of context.subscriptions) {
      subscription.dispose();
    }
    // No assertion on internal maps; the important part is disposal does not throw.
  });

  it('waits for enablement when the git extension is disabled', async () => {
    const { api, providers } = createFakeGitApi();
    let enablementListener: ((enabled: boolean) => void) | undefined;
    const gitExports = {
      enabled: false,
      getAPI: vi.fn(() => api),
      onDidChangeEnablement: vi.fn((listener: (enabled: boolean) => void) => {
        enablementListener = listener;
        return { dispose: vi.fn() };
      }),
    };
    getExtension().mockReturnValue({ activate: vi.fn(async () => gitExports) } as never);
    const config = createConfig([testInstance]);

    await registerForgejoRemoteSourceProviders(createFakeContext() as never, config);

    expect(gitExports.getAPI).not.toHaveBeenCalled();
    expect(providers).toHaveLength(0);

    enablementListener?.(true);
    expect(providers).toHaveLength(1);
  });

  it('logs and gives up when the git API cannot be obtained', async () => {
    getExtension().mockReturnValue({
      activate: vi.fn(async () => ({
        enabled: true,
        getAPI: vi.fn(() => {
          throw new Error('git extension disabled');
        }),
      })),
    } as never);
    const config = createConfig([testInstance]);

    await registerForgejoRemoteSourceProviders(createFakeContext() as never, config);

    expect(config.onInstancesChanged).not.toHaveBeenCalled();
  });
});
