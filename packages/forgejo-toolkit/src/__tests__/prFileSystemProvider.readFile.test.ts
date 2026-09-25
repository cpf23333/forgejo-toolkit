import { describe, expect, it, vi, beforeEach } from 'vitest';
import * as vscode from 'vscode';

const clientMocks = vi.hoisted(() => ({ getRepoContents: vi.fn() }));

vi.mock('../api/client', () => ({
  API_REQUEST_TIMEOUT_MS: 30_000,
  ForgejoClient: vi.fn().mockImplementation(function () {
    return { getRepoContents: clientMocks.getRepoContents };
  }),
}));

vi.mock('vscode', () => ({
  l10n: { t: vi.fn((message: string, ...args: unknown[]) => (args.length ? `${message} ${args.join(' ')}` : message)) },
  EventEmitter: class {
    readonly event = vi.fn();
    fire = vi.fn();
    dispose = vi.fn();
  },
  // The logger reads the debug flag on construction (imported by the provider)
  // and writes its output through an output channel on the failing paths.
  workspace: { getConfiguration: () => ({ get: () => undefined }) },
  window: { createOutputChannel: () => ({ appendLine: vi.fn(), show: vi.fn(), dispose: vi.fn() }) },
  // The provider reports its own judgments (a URI naming no served file, an
  // entry that cannot be opened) as FileSystemError too; the real class
  // flattens VS Code's file-system error codes, which the tests assert on.
  FileSystemError: {
    FileNotFound: (uri?: unknown) => Object.assign(new Error(`FileNotFound: ${String(uri)}`), { code: 'FileNotFound' }),
    Unavailable: (message?: string) => Object.assign(new Error(String(message)), { code: 'Unavailable' }),
  },
}));

import { ForgejoPrDiffFileSystemProvider } from '../prFileSystemProvider';
import { ApiError } from '../api/errors';
import type { ConfigManager } from '../config';

const instance = {
  id: 'inst-1',
  url: 'https://forgejo.example.com',
  token: 'secret-token',
  name: 'user@forgejo.example.com',
  username: 'user',
};

function createConfig(): ConfigManager {
  return { getInstances: () => [instance] } as unknown as ConfigManager;
}

function prUri(status?: string, isBase = false, path = 'src/index.ts') {
  const query = JSON.stringify({ index: 2, ref: 'head-sha', isBase, status });
  return {
    scheme: 'forgejo-pr',
    path: `/inst-1/owner/repo/${path}`,
    query,
    toString: () => `forgejo-pr:/inst-1/owner/repo/${path}?${query}`,
  } as never;
}

/** The 404 the client throws for a missing blob (an `ApiError`, as in production). */
function notFoundError(): ApiError {
  return new ApiError('http', 'Forgejo API error 404: Not Found ({"message":"file does not exist"})', 404);
}

describe('ForgejoPrDiffFileSystemProvider.readFile', () => {
  beforeEach(() => {
    clientMocks.getRepoContents.mockReset();
    vi.mocked(vscode.l10n.t).mockClear();
  });

  it('decodes the requested revision of the file', async () => {
    clientMocks.getRepoContents.mockResolvedValue([
      { type: 'file', path: 'src/index.ts', content: Buffer.from('hello').toString('base64') },
    ]);

    const provider = new ForgejoPrDiffFileSystemProvider(createConfig());
    const bytes = await provider.readFile(prUri());

    expect(new TextDecoder().decode(bytes)).toBe('hello');
    expect(clientMocks.getRepoContents).toHaveBeenCalledWith('owner', 'repo', 'src/index.ts', 'head-sha');
  });

  it('serves an empty side for an added file without asking the API', async () => {
    // The base side of an added file legitimately does not exist, so no fetch is
    // made and no error is reported.
    const provider = new ForgejoPrDiffFileSystemProvider(createConfig());
    const bytes = await provider.readFile(prUri('added', true));

    expect(bytes).toHaveLength(0);
    expect(clientMocks.getRepoContents).not.toHaveBeenCalled();
  });

  it('serves an empty side for a removed file without asking the API', async () => {
    const provider = new ForgejoPrDiffFileSystemProvider(createConfig());
    const bytes = await provider.readFile(prUri('removed'));

    expect(bytes).toHaveLength(0);
    expect(clientMocks.getRepoContents).not.toHaveBeenCalled();
  });

  it('reports a 404 instead of fabricating an empty side', async () => {
    // A force-pushed or gc'd sha, a path missing at that ref, or a token that
    // lost access all answer 404. Returning empty bytes made those look like
    // added/removed files, so the diff showed the whole file as changed.
    clientMocks.getRepoContents.mockRejectedValue(notFoundError());

    const provider = new ForgejoPrDiffFileSystemProvider(createConfig());

    await expect(provider.readFile(prUri())).rejects.toThrow(/Could not load[\s\S]*src\/index\.ts[\s\S]*head-sha/);
    expect(vscode.l10n.t).toHaveBeenCalledWith(
      'Could not load {0} at {1}: {2}',
      'src/index.ts',
      'head-sha',
      expect.stringContaining('Not found'),
    );
  });

  it('reports a transport failure as unavailable rather than as empty content', async () => {
    clientMocks.getRepoContents.mockRejectedValue(new Error('network down'));

    const provider = new ForgejoPrDiffFileSystemProvider(createConfig());

    await expect(provider.readFile(prUri())).rejects.toThrow(/network down/);
  });

  it('serves the withheld-payload notice when the API omits the content', async () => {
    clientMocks.getRepoContents.mockResolvedValue([{ type: 'file', path: 'src/index.ts', content: '', size: 12 }]);

    const provider = new ForgejoPrDiffFileSystemProvider(createConfig());
    const bytes = await provider.readFile(prUri());

    expect(new TextDecoder().decode(bytes)).toContain('browser');
  });

  it('refuses an answer whose entry does not echo the requested path instead of serving another file', async () => {
    // The contents endpoint answers a file path with that file alone and a
    // directory path with its children; without the echo check, a directory
    // URI whose first child is a file was served as the requested file's
    // content. The sibling repo provider applies the same check.
    clientMocks.getRepoContents.mockResolvedValue([
      { type: 'file', path: 'src/other.ts', content: Buffer.from('other').toString('base64') },
    ]);

    const provider = new ForgejoPrDiffFileSystemProvider(createConfig());

    await expect(provider.readFile(prUri())).rejects.toThrow(/FileNotFound/);
  });

  it('explains an unreadable symlink with the shared message instead of a generic failure', async () => {
    clientMocks.getRepoContents.mockResolvedValue([{ type: 'symlink', path: 'src/index.ts', size: 9 }]);

    const provider = new ForgejoPrDiffFileSystemProvider(createConfig());
    const failure = await provider.readFile(prUri()).catch((error: unknown) => error);

    expect((failure as { code?: string }).code).toBe('Unavailable');
    expect((failure as Error).message).toContain('symbolic link');
  });

  it('explains an unreadable submodule with the shared message instead of a generic failure', async () => {
    clientMocks.getRepoContents.mockResolvedValue([{ type: 'submodule', path: 'src/index.ts', size: 0 }]);

    const provider = new ForgejoPrDiffFileSystemProvider(createConfig());
    const failure = await provider.readFile(prUri()).catch((error: unknown) => error);

    expect((failure as { code?: string }).code).toBe('Unavailable');
    expect((failure as Error).message).toContain('submodule');
  });

  it('serves a symlink or submodule whose content the server did send', async () => {
    // The entry has a payload, so nothing is invented and nothing is refused —
    // the server owns the answer, whatever the declared type says.
    clientMocks.getRepoContents.mockResolvedValue([
      { type: 'symlink', path: 'src/index.ts', size: 5, content: Buffer.from('hello').toString('base64') },
    ]);

    const provider = new ForgejoPrDiffFileSystemProvider(createConfig());
    const bytes = await provider.readFile(prUri());

    expect(new TextDecoder().decode(bytes)).toBe('hello');
  });
});
