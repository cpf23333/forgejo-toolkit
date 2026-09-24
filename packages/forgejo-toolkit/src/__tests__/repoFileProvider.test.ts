import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';
import { RepoFileSystemProvider, buildRepoFileUri } from '../repoFileProvider';

const getRepoContents = vi.fn();

vi.mock('../api/client', () => ({
  ForgejoClient: vi.fn().mockImplementation(function () {
    return { getRepoContents };
  }),
}));

const instance = {
  id: 'demo-instance',
  name: 'demo@forgejo.example.com',
  url: 'https://forgejo.example.com',
  token: 'token',
  syncApiUrlsToInstanceUrl: true,
};

const provider = new RepoFileSystemProvider({ getInstances: () => [instance] } as never);
const uri = buildRepoFileUri({
  instanceId: instance.id,
  owner: 'demo-user',
  repo: 'demo-repo',
  ref: 'main',
  path: 'asset.bin',
});

describe('RepoFileSystemProvider.readFile', () => {
  beforeEach(() => {
    getRepoContents.mockReset();
  });

  it('explains a withheld payload instead of reporting the file as missing', async () => {
    // Forgejo omits the payload above `[api] DEFAULT_MAX_BLOB_SIZE` and reports
    // the real size; "file not found" was the wrong answer for that.
    getRepoContents.mockResolvedValue([
      { name: 'asset.bin', path: 'asset.bin', type: 'file', size: 12 * 1024 * 1024, content: '' },
    ]);

    const bytes = await provider.readFile(uri);

    const text = new TextDecoder().decode(bytes);
    expect(text).toContain('browser');
    expect(text).toContain('12.0');
  });

  it('opens a genuinely empty file as an empty document', async () => {
    getRepoContents.mockResolvedValue([{ name: 'asset.bin', path: 'asset.bin', type: 'file', size: 0, content: '' }]);

    await expect(provider.readFile(uri)).resolves.toEqual(new Uint8Array(0));
  });

  it('decodes base64 content for a normal file', async () => {
    getRepoContents.mockResolvedValue([
      {
        name: 'asset.bin',
        path: 'asset.bin',
        type: 'file',
        size: 5,
        content: Buffer.from('hello').toString('base64'),
      },
    ]);

    const bytes = await provider.readFile(uri);

    expect(new TextDecoder().decode(bytes)).toBe('hello');
  });

  it('reports a missing file as not found', async () => {
    getRepoContents.mockResolvedValue([]);

    await expect(provider.readFile(uri)).rejects.toThrow(/FileNotFound/);
  });

  it('treats a directory holding exactly one file as a directory', async () => {
    // The contents API answers a file path with that file alone and a directory
    // path with its children, so one echoed entry means "this path is a file";
    // a single child whose path differs means the URI names the directory.
    getRepoContents.mockResolvedValue([
      { name: 'only.txt', path: 'only.txt', type: 'file', size: 5, content: 'aGVsbG8=' },
    ]);

    await expect(provider.stat(uri)).resolves.toMatchObject({ type: vscode.FileType.Directory });
    // Reading it as a file must not serve the child's content.
    await expect(provider.readFile(uri)).rejects.toThrow(/FileNotFound/);
  });

  it('reports the file type and size for a file the API echoed back', async () => {
    getRepoContents.mockResolvedValue([
      { name: 'asset.bin', path: 'asset.bin', type: 'file', size: 5, content: 'aGVsbG8=' },
    ]);

    await expect(provider.stat(uri)).resolves.toMatchObject({ type: vscode.FileType.File, size: 5 });
  });
});
