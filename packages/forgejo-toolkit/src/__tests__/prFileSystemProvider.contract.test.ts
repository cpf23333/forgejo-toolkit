import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';

const clientMocks = vi.hoisted(() => ({ getRepoContents: vi.fn() }));

vi.mock('../api/client', () => ({
  API_REQUEST_TIMEOUT_MS: 30_000,
  ForgejoClient: vi.fn().mockImplementation(function () {
    return { getRepoContents: clientMocks.getRepoContents };
  }),
}));

import { ForgejoPrDiffFileSystemProvider } from '../prFileSystemProvider';
import type { ConfigManager } from '../config';

const instance = {
  id: 'inst-1',
  url: 'https://forgejo.example.com',
  token: 'secret-token',
  name: 'user@forgejo.example.com',
  username: 'user',
};

function createConfig(instances: unknown[] = [instance]): ConfigManager {
  return { getInstances: () => instances } as unknown as ConfigManager;
}

function prUri(path = '/inst-1/owner/repo/src/index.ts', query = JSON.stringify({ index: 2, ref: 'head-sha' })) {
  return { scheme: 'forgejo-pr', path, query, toString: () => `forgejo-pr:${path}?${query}` } as never;
}

/** A URI this provider did not build: its query is not the JSON it writes. */
function unparseableUri() {
  return {
    scheme: 'forgejo-pr',
    path: '/inst-1/owner/repo/src/index.ts',
    query: 'not-json',
    toString: () => 'x',
  } as never;
}

describe('ForgejoPrDiffFileSystemProvider read-only contract', () => {
  beforeEach(() => {
    clientMocks.getRepoContents.mockReset();
    vi.mocked(vscode.l10n.t).mockClear();
  });

  it('refuses writeFile, delete and rename the way the sibling provider does', () => {
    // The provider is registered with `isReadonly: true` and serves PR content
    // straight from the instance, so a save has nowhere to go. Silent no-ops
    // made the editor believe the write succeeded; RepoFileSystemProvider
    // throws NoPermissions for the same three operations.
    const provider = new ForgejoPrDiffFileSystemProvider(createConfig());
    const uri = prUri();

    expect(() => provider.writeFile(uri, new Uint8Array(0), { create: true, overwrite: true })).toThrow(
      /NoPermissions/,
    );
    expect(() => provider.delete(uri, { recursive: false })).toThrow(/NoPermissions/);
    expect(() => provider.rename(uri, prUri('/inst-1/owner/repo/src/other.ts'), { overwrite: false })).toThrow(
      /NoPermissions/,
    );
    expect(() => provider.createDirectory(uri)).toThrow(/NoPermissions/);
    // None of them may reach the network on the way out.
    expect(clientMocks.getRepoContents).not.toHaveBeenCalled();
  });

  it('reports an unparseable URI as not found instead of as an empty file', async () => {
    // `stat` claimed File/size 0 while `readFile` answered empty bytes: the
    // editor then opened an empty document for a URI that is not one this
    // provider serves. Both now answer FileNotFound, like the sibling provider.
    const provider = new ForgejoPrDiffFileSystemProvider(createConfig());

    expect(() => provider.stat(unparseableUri())).toThrow(/FileNotFound/);
    await expect(provider.readFile(unparseableUri())).rejects.toThrow(/FileNotFound/);
  });

  it('keeps serving a genuinely empty side without asking the API', async () => {
    // The added/removed sides are legitimately empty; that must not be caught up
    // in the refusal above.
    const provider = new ForgejoPrDiffFileSystemProvider(createConfig());
    const query = JSON.stringify({ index: 2, ref: 'head-sha', isBase: true, status: 'added' });

    await expect(provider.readFile(prUri('/inst-1/owner/repo/src/index.ts', query))).resolves.toHaveLength(0);
    expect(clientMocks.getRepoContents).not.toHaveBeenCalled();
  });

  it('localizes the missing-instance error with the shared key', async () => {
    // The raw English interpolation was the only unlocalized user-facing string
    // here; the bundle already carries this key for the review-comment
    // controller.
    const provider = new ForgejoPrDiffFileSystemProvider(createConfig([]));

    await expect(provider.readFile(prUri())).rejects.toThrow('Forgejo instance not found: inst-1');
    expect(vscode.l10n.t).toHaveBeenCalledWith('Forgejo instance not found: {0}', 'inst-1');
  });
});
