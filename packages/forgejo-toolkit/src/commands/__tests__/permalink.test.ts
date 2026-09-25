import { afterEach, describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';
import { copyPermalink, encodePermalinkPath } from '../permalink';
import { FORGEJO_PR_SCHEME } from '../../prFileSystemProvider';
import type { ConfigManager } from '../../config';

const gitMocks = vi.hoisted(() => ({
  detectLinkedRepository: vi.fn(),
  getCurrentCommitSha: vi.fn(),
  runGit: vi.fn(),
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
 * A forgejo-pr URI that is missing its ref (or carries an unusable index) used
 * to parse with fallbacks, so the command handed out a `/blob//path` link that
 * resolves to a 404. Parsing is strict now: such a URI is rejected with the
 * parse-failure warning instead of producing a broken permalink.
 */
describe('copyPermalink strict PR URI parsing', () => {
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

  function prEditorWithQuery(query: string) {
    return {
      document: {
        uri: { scheme: FORGEJO_PR_SCHEME, path: '/inst-1/owner/repo/src/index.ts', query },
      },
      selection: { start: { line: 0 }, end: { line: 0 } },
    };
  }

  afterEach(() => {
    (vscode.window as unknown as { activeTextEditor: unknown }).activeTextEditor = undefined;
    vi.mocked(vscode.env.clipboard.writeText).mockClear();
    vi.mocked(vscode.window.showWarningMessage).mockClear();
  });

  it('warns instead of copying a blob link without a ref', async () => {
    (vscode.window as unknown as { activeTextEditor: unknown }).activeTextEditor = prEditorWithQuery(
      JSON.stringify({ index: 2 }),
    );

    await copyPermalink(createConfig());

    expect(vscode.window.showWarningMessage).toHaveBeenCalledWith(
      expect.stringContaining('Unable to parse Forgejo PR file URI'),
    );
    expect(vscode.env.clipboard.writeText).not.toHaveBeenCalled();
  });

  it('warns instead of copying when the index names no pull request', async () => {
    (vscode.window as unknown as { activeTextEditor: unknown }).activeTextEditor = prEditorWithQuery(
      JSON.stringify({ index: 'not-a-number', ref: 'sha1' }),
    );

    await copyPermalink(createConfig());

    expect(vscode.window.showWarningMessage).toHaveBeenCalledWith(
      expect.stringContaining('Unable to parse Forgejo PR file URI'),
    );
    expect(vscode.env.clipboard.writeText).not.toHaveBeenCalled();
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
    // The whole userinfo goes, not just the secret: the clipboard holds a link
    // someone follows, and `alice:***@host` is not one that resolves.
    expect(copied).toBe('https://forgejo.example.com/owner/repo/blob/sha1/src/index.ts#L1');
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
    expect(copied).toBe('https://forgejo.example.com/owner/repo/blob/abc123/src/index.ts#L1');
  });

  it('leaves a trailing-slash instance URL without a double slash after stripping', async () => {
    // The stripping helper re-serializes an absolute URL, which appends a
    // trailing slash; the call sites trim it so the join stays single-slashed.
    (vscode.window as unknown as { activeTextEditor: unknown }).activeTextEditor = prEditor();

    await copyPermalink(createConfig(`https://alice:${SECRET}@forgejo.example.com/`));

    const copied = vi.mocked(vscode.env.clipboard.writeText).mock.calls[0][0];
    expect(copied).toBe('https://forgejo.example.com/owner/repo/blob/sha1/src/index.ts#L1');
    expect(copied).not.toContain('//owner');
  });
});

/**
 * The `file`-scheme permalink names the local HEAD commit; while that commit is
 * on no remote-tracking branch the blob URL resolves to a 404 for whoever
 * follows it. The copy still happens (the push may be imminent), but the
 * confirmation says the link is not live yet.
 */
describe('copyPermalink unpushed commit note', () => {
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

  function fileEditor() {
    return {
      document: { uri: { scheme: 'file', fsPath: '/repo/src/index.ts' } },
      selection: { start: { line: 0 }, end: { line: 0 } },
    };
  }

  afterEach(() => {
    (vscode.window as unknown as { activeTextEditor: unknown }).activeTextEditor = undefined;
    vi.mocked(vscode.env.clipboard.writeText).mockClear();
    vi.mocked(vscode.window.showInformationMessage).mockClear();
    gitMocks.detectLinkedRepository.mockReset();
    gitMocks.getCurrentCommitSha.mockReset();
    gitMocks.runGit.mockReset();
  });

  function setupFilePermalink() {
    (vscode.window as unknown as { activeTextEditor: unknown }).activeTextEditor = fileEditor();
    gitMocks.detectLinkedRepository.mockResolvedValue({
      instanceId: 'inst-1',
      owner: 'owner',
      repo: 'repo',
      localPath: '/repo',
    });
    gitMocks.getCurrentCommitSha.mockResolvedValue('abc123');
  }

  it('notes in the confirmation when HEAD is on no remote-tracking branch', async () => {
    setupFilePermalink();
    // `git branch --remotes --contains` prints nothing for an unpushed commit.
    gitMocks.runGit.mockResolvedValue({ stdout: '', stderr: '' });

    await copyPermalink(createConfig());

    expect(gitMocks.runGit).toHaveBeenCalledWith(['branch', '--remotes', '--contains', 'abc123'], '/repo');
    expect(vscode.env.clipboard.writeText).toHaveBeenCalledWith(
      'https://forgejo.example.com/owner/repo/blob/abc123/src/index.ts#L1',
    );
    expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(expect.stringContaining('may not be pushed yet'));
  });

  it('copies without the note when a remote-tracking branch contains HEAD', async () => {
    setupFilePermalink();
    gitMocks.runGit.mockResolvedValue({ stdout: '  origin/main\n', stderr: '' });

    await copyPermalink(createConfig());

    expect(vscode.window.showInformationMessage).toHaveBeenCalledWith('Permalink copied to clipboard');
  });

  it('keeps the plain confirmation when git cannot answer the containment check', async () => {
    // The check failing (no git, an unreadable repository) must not block or
    // annotate the copy: "unknown" is not "unpushed".
    setupFilePermalink();
    gitMocks.runGit.mockRejectedValue(new Error('git not found'));

    await copyPermalink(createConfig());

    expect(vscode.env.clipboard.writeText).toHaveBeenCalledWith(
      'https://forgejo.example.com/owner/repo/blob/abc123/src/index.ts#L1',
    );
    expect(vscode.window.showInformationMessage).toHaveBeenCalledWith('Permalink copied to clipboard');
  });
});
