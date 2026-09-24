import { describe, it, expect, vi, beforeEach } from 'vitest';

// The shared extension-setup vscode mock lacks CodeAction/CodeActionKind, so
// this file registers its own minimal mock (it takes precedence).
vi.mock('vscode', () => ({
  window: {
    showWarningMessage: vi.fn(),
    showErrorMessage: vi.fn(),
    showInformationMessage: vi.fn(),
  },
  commands: {
    executeCommand: vi.fn(),
  },
  l10n: {
    t: (message: string, ...args: unknown[]) => (args.length > 0 ? `${message} ${args.join(' ')}` : message),
  },
  CodeAction: class {
    command: unknown;
    constructor(
      public title: string,
      public kind?: unknown,
    ) {}
  },
  CodeActionKind: { QuickFix: 'quickfix' },
}));

const gitMocks = vi.hoisted(() => ({
  detectLinkedRepository: vi.fn(),
  getCurrentCommitSha: vi.fn(),
}));
vi.mock('../../worktree/gitOperations', () => gitMocks);

// Only encodePermalinkPath is needed from the permalink module; mocking it
// avoids pulling prFileSystemProvider into this minimal vscode mock.
vi.mock('../../commands/permalink', () => ({
  encodePermalinkPath: (filePath: string) => filePath.split('/').map(encodeURIComponent).join('/'),
}));

import * as vscode from 'vscode';
import {
  COMMAND_CREATE_ISSUE_FROM_COMMENT,
  TodoCommentCodeActionProvider,
  createIssueFromComment,
  extractTodoComment,
} from '../todoCommentCodeAction';
import { detectLinkedRepository, getCurrentCommitSha } from '../../worktree/gitOperations';
import type { ConfigManager } from '../../config';

const INSTANCE = {
  id: 'inst-1',
  url: 'https://forgejo.example.com',
  token: '',
  name: 'Mock',
  username: 'demo-user',
};

function createConfig(instance = INSTANCE): ConfigManager {
  return { getInstances: () => [instance] } as unknown as ConfigManager;
}

describe('extractTodoComment', () => {
  it('extracts marker and text from common comment styles', () => {
    expect(extractTodoComment('// TODO: handle errors')).toEqual({ marker: 'TODO', text: 'handle errors' });
    expect(extractTodoComment('# FIXME handle errors')).toEqual({ marker: 'FIXME', text: 'handle errors' });
    expect(extractTodoComment(' * TODO handle errors')).toEqual({ marker: 'TODO', text: 'handle errors' });
    expect(extractTodoComment('<!-- TODO handle errors -->')).toEqual({ marker: 'TODO', text: 'handle errors -->' });
    expect(extractTodoComment('TODO: handle errors')).toEqual({ marker: 'TODO', text: 'handle errors' });
  });

  it('accepts text starting right after the marker or colon without a space', () => {
    expect(extractTodoComment('// TODO:12313')).toEqual({ marker: 'TODO', text: '12313' });
    expect(extractTodoComment('// FIXME:12313')).toEqual({ marker: 'FIXME', text: '12313' });
  });

  it('rejects markers without trailing text', () => {
    expect(extractTodoComment('// TODO')).toBeUndefined();
    expect(extractTodoComment('// TODO:')).toBeUndefined();
  });

  it('rejects markers outside a comment context', () => {
    expect(extractTodoComment('const message = "TODO: fix"')).toBeUndefined();
    expect(extractTodoComment('call(TODO_VALUE)')).toBeUndefined();
  });

  it('is case-sensitive and requires a whole-word marker', () => {
    expect(extractTodoComment('// todo: handle errors')).toBeUndefined();
    expect(extractTodoComment('// TODOLIST handle errors')).toBeUndefined();
  });
});

describe('TodoCommentCodeActionProvider', () => {
  function documentWith(lines: string[]) {
    return {
      uri: { fsPath: '/repo/src/a.ts' },
      lineAt: (line: number) => ({ text: lines[line] }),
    };
  }

  it('offers a quick fix with the create-issue command for TODO lines', () => {
    const provider = new TodoCommentCodeActionProvider();
    const document = documentWith(['const a = 1;', '// TODO: refactor this']);
    const actions = provider.provideCodeActions(
      document as never,
      {
        start: { line: 1 },
        end: { line: 1 },
      } as never,
    );

    expect(actions).toHaveLength(1);
    expect(actions[0].title).toContain('TODO');
    const command = actions[0].command as { command: string; arguments: unknown[] };
    expect(command.command).toBe(COMMAND_CREATE_ISSUE_FROM_COMMENT);
    expect(command.arguments[0]).toEqual({ fsPath: '/repo/src/a.ts', line: 1, text: 'refactor this' });
  });

  it('offers nothing for lines without a TODO comment', () => {
    const provider = new TodoCommentCodeActionProvider();
    const document = documentWith(['const a = 1;']);
    const actions = provider.provideCodeActions(
      document as never,
      {
        start: { line: 0 },
        end: { line: 0 },
      } as never,
    );
    expect(actions).toEqual([]);
  });
});

describe('createIssueFromComment', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const linked = { instanceId: 'inst-1', owner: 'owner', repo: 'repo', localPath: '/repo' };

  it('prefills the new-issue form with the comment text and a permalink body', async () => {
    vi.mocked(detectLinkedRepository).mockResolvedValue(linked as never);
    vi.mocked(getCurrentCommitSha).mockResolvedValue('abc123');
    const viewProvider = { openNewIssue: vi.fn() };

    await createIssueFromComment(createConfig(), viewProvider as never, {
      fsPath: '/repo/src/a.ts',
      line: 4,
      text: 'refactor this',
    });

    expect(viewProvider.openNewIssue).toHaveBeenCalledWith({
      instanceId: 'inst-1',
      owner: 'owner',
      repo: 'repo',
      title: 'refactor this',
      body: 'https://forgejo.example.com/owner/repo/blob/abc123/src/a.ts#L5',
    });
    expect(vscode.commands.executeCommand).toHaveBeenCalledWith('forgejoToolkitView.focus');
  });

  it('falls back to a path reference when the commit SHA is unavailable', async () => {
    vi.mocked(detectLinkedRepository).mockResolvedValue(linked as never);
    vi.mocked(getCurrentCommitSha).mockResolvedValue(undefined);
    const viewProvider = { openNewIssue: vi.fn() };

    await createIssueFromComment(createConfig(), viewProvider as never, {
      fsPath: '/repo/src/a.ts',
      line: 0,
      text: 'fix me',
    });

    expect(viewProvider.openNewIssue).toHaveBeenCalledWith(expect.objectContaining({ body: 'src/a.ts#L1' }));
  });

  it('warns instead of navigating when no repository is linked', async () => {
    vi.mocked(detectLinkedRepository).mockResolvedValue(undefined);
    const viewProvider = { openNewIssue: vi.fn() };

    await createIssueFromComment(createConfig(), viewProvider as never, {
      fsPath: '/repo/src/a.ts',
      line: 0,
      text: 'fix me',
    });

    expect(viewProvider.openNewIssue).not.toHaveBeenCalled();
    expect(vscode.window.showWarningMessage).toHaveBeenCalledWith(expect.stringContaining('No linked Forgejo'));
  });

  it('warns when the file is outside the linked repository', async () => {
    vi.mocked(detectLinkedRepository).mockResolvedValue(linked as never);
    const viewProvider = { openNewIssue: vi.fn() };

    await createIssueFromComment(createConfig(), viewProvider as never, {
      fsPath: '/elsewhere/a.ts',
      line: 0,
      text: 'fix me',
    });

    expect(viewProvider.openNewIssue).not.toHaveBeenCalled();
    expect(vscode.window.showWarningMessage).toHaveBeenCalledWith(expect.stringContaining('outside'));
  });

  it('never persists a credential embedded in the instance URL into the issue body', async () => {
    // The reference becomes the issue's body, which is stored server-side and
    // readable by everyone with repository access.
    vi.mocked(detectLinkedRepository).mockResolvedValue(linked as never);
    vi.mocked(getCurrentCommitSha).mockResolvedValue('abc123');
    const viewProvider = { openNewIssue: vi.fn() };

    await createIssueFromComment(
      createConfig({ ...INSTANCE, url: 'https://alice:secret-token@forgejo.example.com' }),
      viewProvider as never,
      { fsPath: '/repo/src/a.ts', line: 4, text: 'refactor this' },
    );

    const body = (viewProvider.openNewIssue.mock.calls[0][0] as { body: string }).body;
    expect(body).not.toContain('secret-token');
    // The userinfo is removed, not masked: a reader of the issue has to be able
    // to open the link, and `alice:***@host` is not a URL that resolves.
    expect(body).toBe('https://forgejo.example.com/owner/repo/blob/abc123/src/a.ts#L5');
  });

  it('removes a token written in the username position from the issue body', async () => {
    vi.mocked(detectLinkedRepository).mockResolvedValue(linked as never);
    vi.mocked(getCurrentCommitSha).mockResolvedValue('abc123');
    const viewProvider = { openNewIssue: vi.fn() };

    await createIssueFromComment(
      createConfig({ ...INSTANCE, url: 'https://secret-token@forgejo.example.com/' }),
      viewProvider as never,
      { fsPath: '/repo/src/a.ts', line: 0, text: 'refactor this' },
    );

    const body = (viewProvider.openNewIssue.mock.calls[0][0] as { body: string }).body;
    expect(body).toBe('https://forgejo.example.com/owner/repo/blob/abc123/src/a.ts#L1');
  });
});
