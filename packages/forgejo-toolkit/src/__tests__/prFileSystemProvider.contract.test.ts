import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';

const clientMocks = vi.hoisted(() => ({ getRepoContents: vi.fn() }));

vi.mock('../api/client', () => ({
  API_REQUEST_TIMEOUT_MS: 30_000,
  ForgejoClient: vi.fn().mockImplementation(function () {
    return { getRepoContents: clientMocks.getRepoContents };
  }),
}));

import { ForgejoPrDiffFileSystemProvider, parseForgejoPrUri } from '../prFileSystemProvider';
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
    // controller. It is a FileSystemError like every other failure this
    // provider reports (a plain Error bypasses VS Code's file-system error
    // handling; the sibling provider reports the same state as FileNotFound).
    const provider = new ForgejoPrDiffFileSystemProvider(createConfig([]));

    const failure = await provider.readFile(prUri()).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toContain('Forgejo instance not found: inst-1');
    expect((failure as { code?: string }).code).toBe('FileNotFound');
    expect(vscode.l10n.t).toHaveBeenCalledWith('Forgejo instance not found: {0}', 'inst-1');
  });

  it('reports a URI without a ref as not found instead of serving the default branch', async () => {
    // The contents endpoint answers a missing/empty ref with the default branch,
    // while the URI claims to address a specific sha — serving one as the other
    // mislabels the diff. The sibling repo provider refuses a ref-less URI the
    // same way.
    const provider = new ForgejoPrDiffFileSystemProvider(createConfig());

    const noRef = JSON.stringify({ index: 2 });
    const emptyRef = JSON.stringify({ index: 2, ref: '' });
    await expect(provider.readFile(prUri('/inst-1/owner/repo/src/index.ts', noRef))).rejects.toThrow(/FileNotFound/);
    await expect(provider.readFile(prUri('/inst-1/owner/repo/src/index.ts', emptyRef))).rejects.toThrow(/FileNotFound/);
    expect(() => provider.stat(prUri('/inst-1/owner/repo/src/index.ts', noRef))).toThrow(/FileNotFound/);
    expect(clientMocks.getRepoContents).not.toHaveBeenCalled();
  });

  it('reports a URI with an unparseable index as not found instead of falling back to PR 0', async () => {
    // The index used to degrade to 0, which names no pull request at all: an
    // invalid URI must be refused, not silently retargeted.
    const provider = new ForgejoPrDiffFileSystemProvider(createConfig());
    const badIndex = JSON.stringify({ index: 'not-a-number', ref: 'head-sha' });

    await expect(provider.readFile(prUri('/inst-1/owner/repo/src/index.ts', badIndex))).rejects.toThrow(/FileNotFound/);
    expect(clientMocks.getRepoContents).not.toHaveBeenCalled();
  });
});

/**
 * The one parser every `forgejo-pr` consumer shares (the provider above, the
 * review-comment controller, the permalink command): the three used to parse
 * with different fallbacks, so the same URI named different content depending
 * on which of them read it.
 */
describe('parseForgejoPrUri', () => {
  const uri = (path: string, query: string, scheme = 'forgejo-pr') =>
    ({ scheme, path, query, toString: () => `${scheme}:${path}?${query}` }) as never;

  it('parses the URI shape the extension builds', () => {
    const parsed = parseForgejoPrUri(
      uri('/inst-1/owner/repo/src/index.ts', JSON.stringify({ index: 2, ref: 'sha', isBase: true, status: 'renamed' })),
    );

    expect(parsed).toEqual({
      instanceId: 'inst-1',
      owner: 'owner',
      repo: 'repo',
      index: 2,
      ref: 'sha',
      path: 'src/index.ts',
      isBase: true,
      status: 'renamed',
    });
  });

  it('defaults isBase to false and lets status stay absent', () => {
    const parsed = parseForgejoPrUri(uri('/inst-1/owner/repo/f.ts', JSON.stringify({ index: 2, ref: 'sha' })));

    expect(parsed?.isBase).toBe(false);
    expect(parsed?.status).toBeUndefined();
  });

  it('refuses a URI of another scheme', () => {
    const parsed = parseForgejoPrUri(uri('/inst-1/owner/repo/f.ts', JSON.stringify({ index: 2, ref: 'sha' }), 'file'));

    expect(parsed).toBeUndefined();
  });

  it('refuses a missing or empty ref instead of addressing the default branch', () => {
    const path = '/inst-1/owner/repo/f.ts';

    expect(parseForgejoPrUri(uri(path, JSON.stringify({ index: 2 })))).toBeUndefined();
    expect(parseForgejoPrUri(uri(path, JSON.stringify({ index: 2, ref: '' })))).toBeUndefined();
  });

  it('refuses an invalid index instead of falling back to PR 0', () => {
    const path = '/inst-1/owner/repo/f.ts';

    // Zero names no pull request; neither do a non-number or a fraction.
    expect(parseForgejoPrUri(uri(path, JSON.stringify({ index: 0, ref: 'sha' })))).toBeUndefined();
    expect(parseForgejoPrUri(uri(path, JSON.stringify({ index: 'not-a-number', ref: 'sha' })))).toBeUndefined();
    expect(parseForgejoPrUri(uri(path, JSON.stringify({ index: 1.5, ref: 'sha' })))).toBeUndefined();
    expect(parseForgejoPrUri(uri(path, JSON.stringify({ ref: 'sha' })))).toBeUndefined();
  });

  it('refuses a query that is not JSON and a path without the four segments', () => {
    expect(parseForgejoPrUri(uri('/inst-1/owner/repo/f.ts', 'not-json'))).toBeUndefined();
    expect(parseForgejoPrUri(uri('/inst-1/owner/repo', JSON.stringify({ index: 2, ref: 'sha' })))).toBeUndefined();
    expect(parseForgejoPrUri(uri('/inst-1/owner/repo/f.ts', ''))).toBeUndefined();
  });
});
