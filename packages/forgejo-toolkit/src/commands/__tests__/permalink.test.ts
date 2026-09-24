import { afterEach, describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';
import { copyPermalink, encodePermalinkPath } from '../permalink';
import { FORGEJO_PR_SCHEME } from '../../prFileSystemProvider';
import type { ConfigManager } from '../../config';

const gitMocks = vi.hoisted(() => ({
  detectLinkedRepository: vi.fn(),
  getCurrentCommitSha: vi.fn(),
}));
vi.mock('../../worktree/gitOperations', () => gitMocks);

describe('encodePermalinkPath', () => {
  it('leaves a plain path unchanged', () => {
    expect(encodePermalinkPath('src/index.ts')).toBe('src/index.ts');
  });

  it('keeps `/` separators while encoding each segment', () => {
    expect(encodePermalinkPath('my dir/my file.txt')).toBe('my%20dir/my%20file.txt');
  });

  it('encodes `#` so it cannot truncate the URL before the line fragment', () => {
    expect(encodePermalinkPath('a#b.txt')).toBe('a%23b.txt');
  });

  it('encodes `?` and `%`', () => {
    expect(encodePermalinkPath('what?.txt')).toBe('what%3F.txt');
    expect(encodePermalinkPath('100%.txt')).toBe('100%25.txt');
  });

  it('encodes non-ASCII file names per segment', () => {
    expect(encodePermalinkPath('文档/说明.md')).toBe(`${encodeURIComponent('文档')}/${encodeURIComponent('说明')}.md`);
  });

  it('produces a valid URL when combined with a line-range fragment', () => {
    const url = `https://forgejo.example.com/owner/repo/blob/main/${encodePermalinkPath('dir/a#b.txt')}#L3`;
    const parsed = new URL(url);
    expect(parsed.pathname).toBe('/owner/repo/blob/main/dir/a%23b.txt');
    expect(parsed.hash).toBe('#L3');
  });
});

/**
 * The permalink points at a blob on the ref the diff side belongs to, and one
 * side of the pair is empty for a file the PR added or removed: copying then
 * hands out a URL that resolves to a 404.
 */
describe('copyPermalink sides without a blob', () => {
  function createConfig(): ConfigManager {
    return {
      getInstances: () => [
        {
          id: 'inst-1',
          url: 'https://forgejo.example.com',
          token: '',
          name: 'user@forgejo.example.com',
          username: 'user',
        },
      ],
    } as unknown as ConfigManager;
  }

  function editorFor(isBase: boolean, status: string) {
    const path = '/inst-1/owner/repo/src/old.ts';
    return {
      document: {
        uri: {
          scheme: FORGEJO_PR_SCHEME,
          path,
          query: JSON.stringify({ index: 2, ref: 'sha1', isBase, status }),
        },
      },
      selection: { start: { line: 0 }, end: { line: 0 } },
    };
  }

  afterEach(() => {
    (vscode.window as unknown as { activeTextEditor: unknown }).activeTextEditor = undefined;
    vi.mocked(vscode.env.clipboard.writeText).mockClear();
    vi.mocked(vscode.window.showWarningMessage).mockClear();
  });

  it('refuses the head side of a removed file instead of copying a dead link', async () => {
    (vscode.window as unknown as { activeTextEditor: unknown }).activeTextEditor = editorFor(false, 'removed');

    await copyPermalink(createConfig());

    expect(vscode.window.showWarningMessage).toHaveBeenCalledWith(expect.stringContaining('head ref'));
    expect(vscode.env.clipboard.writeText).not.toHaveBeenCalled();
  });

  it('still copies the base side of a removed file', async () => {
    (vscode.window as unknown as { activeTextEditor: unknown }).activeTextEditor = editorFor(true, 'removed');

    await copyPermalink(createConfig());

    expect(vscode.window.showWarningMessage).not.toHaveBeenCalled();
    expect(vscode.env.clipboard.writeText).toHaveBeenCalledWith(
      expect.stringContaining('https://forgejo.example.com/owner/repo/blob/sha1/src/old.ts'),
    );
  });
});

/**
 * The clipboard is the one place a permalink leaves the extension as a value the
 * user pastes elsewhere, so a credential embedded in the configured instance URL
 * must never reach it.
 */
describe('copyPermalink credential redaction', () => {
  const SECRET = 'secret-token';

  function createConfig(url: string): ConfigManager {
    return {
      getInstances: () => [{ id: 'inst-1', url, token: SECRET, name: 'user@forgejo.example.com', username: 'user' }],
    } as unknown as ConfigManager;
  }

  function prEditor() {
    const path = '/inst-1/owner/repo/src/index.ts';
    return {
      document: {
        uri: { scheme: FORGEJO_PR_SCHEME, path, query: JSON.stringify({ index: 2, ref: 'sha1', isBase: false }) },
      },
      selection: { start: { line: 0 }, end: { line: 0 } },
    };
  }

  function fileEditor() {
    return {
      document: { uri: { scheme: 'file', fsPath: '/repo/src/index.ts' } },
      selection: { start: { line: 0 }, end: { line: 0 } },
    };
  }

  afterEach(() => {
    (vscode.window as unknown as { activeTextEditor: unknown }).activeTextEditor = undefined;
    vi.mocked(vscode.env.clipboard.writeText).mockClear();
    vi.mocked(vscode.window.showWarningMessage).mockClear();
    gitMocks.detectLinkedRepository.mockReset();
    gitMocks.getCurrentCommitSha.mockReset();
  });

  it('drops a password embedded in the instance URL of a PR-file permalink', async () => {
    (vscode.window as unknown as { activeTextEditor: unknown }).activeTextEditor = prEditor();

    await copyPermalink(createConfig(`https://alice:${SECRET}@forgejo.example.com`));

    const copied = vi.mocked(vscode.env.clipboard.writeText).mock.calls[0][0];
    expect(copied).not.toContain(SECRET);
    expect(copied).toContain('forgejo.example.com/owner/repo/blob/sha1/src/index.ts');
  });

  it('drops a token written in the username position of a workspace-file permalink', async () => {
    (vscode.window as unknown as { activeTextEditor: unknown }).activeTextEditor = fileEditor();
    gitMocks.detectLinkedRepository.mockResolvedValue({
      instanceId: 'inst-1',
      owner: 'owner',
      repo: 'repo',
      localPath: '/repo',
    });
    gitMocks.getCurrentCommitSha.mockResolvedValue('abc123');

    await copyPermalink(createConfig(`https://${SECRET}@forgejo.example.com`));

    const copied = vi.mocked(vscode.env.clipboard.writeText).mock.calls[0][0];
    expect(copied).not.toContain(SECRET);
    expect(copied).toContain('forgejo.example.com/owner/repo/blob/abc123/src/index.ts');
  });
});
