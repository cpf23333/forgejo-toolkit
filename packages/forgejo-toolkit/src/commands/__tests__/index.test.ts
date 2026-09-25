import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const mocks = vi.hoisted(() => ({
  copyPermalink: vi.fn(),
  publishToForgejo: vi.fn(),
  createIssueFromComment: vi.fn(),
  createPrFromCurrentBranch: vi.fn(),
  addComment: vi.fn(),
  deleteComment: vi.fn(),
  getCommentContext: vi.fn(),
}));

vi.mock('../../webview/viewProvider', () => ({ ForgejoToolkitViewProvider: class {} }));
vi.mock('../../webview/onboardingPanel', () => ({ OnboardingWebviewPanel: { createOrShow: vi.fn() } }));
vi.mock('../../comments/pullReviewCommentController', () => ({
  COMMAND_ADD_COMMENT: 'forgejoToolkit.addPullReviewComment',
  PullReviewCommentController: class {},
}));
vi.mock('../permalink', () => ({ copyPermalink: mocks.copyPermalink }));
vi.mock('../publish', () => ({ publishToForgejo: mocks.publishToForgejo }));
vi.mock('../../editor/todoCommentCodeAction', () => ({
  COMMAND_CREATE_ISSUE_FROM_COMMENT: 'forgejoToolkit.createIssueFromComment',
  createIssueFromComment: mocks.createIssueFromComment,
}));
vi.mock('../createPullRequest', () => ({ createPrFromCurrentBranch: mocks.createPrFromCurrentBranch }));

import { registerCommands, toLineNumber } from '../index';

async function flushAsync() {
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
}

function registerHandlers() {
  const controller = {
    addComment: mocks.addComment,
    deleteComment: mocks.deleteComment,
    getCommentContext: mocks.getCommentContext,
  };
  const context = { subscriptions: [] as Array<{ dispose(): void }> };
  registerCommands(context as never, {} as never, {} as never, {} as never, controller as never);
  const handlers = new Map<string, (...args: unknown[]) => void>();
  for (const [name, callback] of vi.mocked(vscode.commands.registerCommand).mock.calls) {
    handlers.set(name, callback as (...args: unknown[]) => void);
  }
  return handlers;
}

interface FakeSelection {
  start: { line: number };
  end: { line: number };
  isEmpty: boolean;
}

/** Minimal stand-in for the active editor the handler reads the selection from. */
function mockActiveEditor(active: number, selection: FakeSelection) {
  (vscode.window as { activeTextEditor?: unknown }).activeTextEditor = {
    document: { uri: { scheme: 'forgejo-pr', path: '/i/o/r/f.ts', query: '{}' } },
    selection: { active: { line: active }, ...selection },
  };
}

describe('registerCommands', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (vscode.window as { activeTextEditor?: unknown }).activeTextEditor = undefined;
    (vscode.window as { visibleTextEditors?: unknown }).visibleTextEditors = [];
  });

  it('ignores a second publishToForgejo invocation while one is running', async () => {
    let finishPublish!: () => void;
    mocks.publishToForgejo.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          finishPublish = resolve;
        }),
    );
    const handlers = registerHandlers();
    const publish = handlers.get('forgejoToolkit.publishToForgejo')!;

    publish();
    publish();
    expect(mocks.publishToForgejo).toHaveBeenCalledTimes(1);

    finishPublish();
    await flushAsync();
    // After the first run settled the command is armed again.
    publish();
    expect(mocks.publishToForgejo).toHaveBeenCalledTimes(2);
    // Let the second run settle too so the module-level in-flight flag does
    // not leak into the next test.
    finishPublish();
    await flushAsync();
  });

  it('re-arms publishToForgejo after a failure', async () => {
    mocks.publishToForgejo.mockRejectedValue(new Error('push failed'));
    const handlers = registerHandlers();
    const publish = handlers.get('forgejoToolkit.publishToForgejo')!;

    publish();
    await flushAsync();
    publish();
    expect(mocks.publishToForgejo).toHaveBeenCalledTimes(2);
    expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(expect.stringContaining('push failed'), 'View Log');
  });

  it('ignores a second createPrFromCurrentBranch invocation while one is running', async () => {
    // The flow mixes input boxes and pushes (and is reachable from the status
    // bar), so a quick double-click must not stack two runs of it.
    let finishCreate!: () => void;
    mocks.createPrFromCurrentBranch.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          finishCreate = resolve;
        }),
    );
    const handlers = registerHandlers();
    const createPr = handlers.get('forgejoToolkit.createPrFromCurrentBranch')!;

    createPr();
    createPr();
    expect(mocks.createPrFromCurrentBranch).toHaveBeenCalledTimes(1);

    finishCreate();
    await flushAsync();
    // After the first run settled the command is armed again.
    createPr();
    expect(mocks.createPrFromCurrentBranch).toHaveBeenCalledTimes(2);
    // Let the second run settle too so the module-level in-flight flag does
    // not leak into the next test.
    finishCreate();
    await flushAsync();
  });

  it('re-arms createPrFromCurrentBranch after a failure', async () => {
    mocks.createPrFromCurrentBranch.mockRejectedValue(new Error('push failed'));
    const handlers = registerHandlers();
    const createPr = handlers.get('forgejoToolkit.createPrFromCurrentBranch')!;

    createPr();
    await flushAsync();
    createPr();
    expect(mocks.createPrFromCurrentBranch).toHaveBeenCalledTimes(2);
    expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(expect.stringContaining('push failed'), 'View Log');
  });

  it('lets a navigation invocation (args.index) through while a create flow is running', async () => {
    // The args.index path only opens an existing pull request — no input boxes,
    // no push — so it must not be blocked by the create-flow guard: otherwise a
    // click on the status bar's existing-PR entry is silently dropped while a
    // creation sits at an input box.
    let finishers: Array<() => void> = [];
    mocks.createPrFromCurrentBranch.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          finishers.push(resolve);
        }),
    );
    const handlers = registerHandlers();
    const createPr = handlers.get('forgejoToolkit.createPrFromCurrentBranch')!;

    createPr();
    createPr({ index: 7 });
    expect(mocks.createPrFromCurrentBranch).toHaveBeenCalledTimes(2);
    expect(mocks.createPrFromCurrentBranch).toHaveBeenLastCalledWith(expect.anything(), expect.anything(), {
      index: 7,
    });

    // Settle both runs so the module-level guard does not leak into the next
    // test.
    for (const finish of finishers) {
      finish();
    }
    finishers = [];
    await flushAsync();
  });

  it('does not let a navigation invocation release the create-flow guard', async () => {
    // Navigation neither takes nor releases the guard: if it cleared the flag
    // on settle, a quick navigation finishing mid-create would unguard the
    // still-running create flow and let a second one stack.
    let finishCreate!: () => void;
    let finishNavigation!: () => void;
    mocks.createPrFromCurrentBranch.mockImplementation(
      (_config: unknown, _viewProvider: unknown, args?: { index?: number }) =>
        new Promise<void>((resolve) => {
          if (typeof args?.index === 'number') {
            finishNavigation = resolve;
          } else {
            finishCreate = resolve;
          }
        }),
    );
    const handlers = registerHandlers();
    const createPr = handlers.get('forgejoToolkit.createPrFromCurrentBranch')!;

    createPr();
    createPr({ index: 7 });
    finishNavigation();
    await flushAsync();
    // The create flow is still running, so a second create stays blocked even
    // though the navigation already settled.
    createPr();
    expect(mocks.createPrFromCurrentBranch).toHaveBeenCalledTimes(2);

    finishCreate();
    await flushAsync();
    // Once the create flow settles the command is armed again.
    createPr();
    expect(mocks.createPrFromCurrentBranch).toHaveBeenCalledTimes(3);
    finishCreate();
    await flushAsync();
  });

  it('reports copyPermalink failures with a View Log action', async () => {
    mocks.copyPermalink.mockRejectedValue(new Error('no upstream'));
    const handlers = registerHandlers();

    handlers.get('forgejoToolkit.copyPermalink')!();
    await flushAsync();

    expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(expect.stringContaining('no upstream'), 'View Log');
  });

  it('reports review comment failures with a View Log action', async () => {
    (vscode.window as { activeTextEditor?: unknown }).activeTextEditor = {
      selection: { active: { line: 0 } },
    };
    mocks.addComment.mockRejectedValue(new Error('API down'));
    const handlers = registerHandlers();

    handlers.get('forgejoToolkit.addPullReviewComment')!();
    await flushAsync();

    expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(expect.stringContaining('API down'), 'View Log');
  });

  it('reports deletePullReviewComment failures with a View Log action', async () => {
    mocks.getCommentContext.mockReturnValue({ commentId: 7 });
    mocks.deleteComment.mockRejectedValue(new Error('API down'));
    const handlers = registerHandlers();

    handlers.get('forgejoToolkit.deletePullReviewComment')!({ contextValue: 'ctx' });
    await flushAsync();

    expect(mocks.deleteComment).toHaveBeenCalledWith({ commentId: 7 });
    expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(expect.stringContaining('API down'), 'View Log');
  });

  it('reports createIssueFromComment failures with a View Log action', async () => {
    mocks.createIssueFromComment.mockRejectedValue(new Error('API down'));
    const handlers = registerHandlers();

    handlers.get('forgejoToolkit.createIssueFromComment')!({});
    await flushAsync();

    expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(expect.stringContaining('API down'), 'View Log');
  });

  it('anchors the line-number gutter action on the clicked line, not the selection', async () => {
    // `editor/lineNumber/context` runs the command with the clicked line as a
    // single `{ lineNumber, uri }` argument. The selection deliberately points
    // at another line: a handler that only reads a second, positional argument
    // ignores the click and anchors the comment on the selection instead.
    mockActiveEditor(4, { start: { line: 1 }, end: { line: 1 }, isEmpty: true });
    const handlers = registerHandlers();

    handlers.get('forgejoToolkit.addPullReviewComment')!({ lineNumber: 2, uri: { scheme: 'forgejo-pr' } });
    await flushAsync();

    // 2 is 1-based (the API's numbering); addComment takes a 0-based line.
    expect(mocks.addComment).toHaveBeenCalledWith(expect.anything(), 1);
  });

  it('anchors the gutter action for the documented (uri, lineNumbers) argument order', async () => {
    mockActiveEditor(9, { start: { line: 8 }, end: { line: 8 }, isEmpty: true });
    const handlers = registerHandlers();

    handlers.get('forgejoToolkit.addPullReviewComment')!({ scheme: 'forgejo-pr' }, [7, 6]);
    await flushAsync();

    expect(mocks.addComment).toHaveBeenCalledWith(expect.anything(), 6);
  });

  it('falls back to the selection when the invocation names no line', async () => {
    mockActiveEditor(4, { start: { line: 4 }, end: { line: 4 }, isEmpty: true });
    const handlers = registerHandlers();

    handlers.get('forgejoToolkit.addPullReviewComment')!();
    await flushAsync();

    expect(mocks.addComment).toHaveBeenCalledWith(expect.anything(), 4);
  });

  it('targets the visible editor the invocation uri names, not the active one', async () => {
    // With a diff editor open both sides are visible; the gutter click names
    // the side it happened on, and the active editor may be the other one.
    const activeEditor = {
      document: { uri: { scheme: 'forgejo-pr', path: '/i/o/r/base.ts', query: '{}' } },
      selection: { active: { line: 0 } },
    };
    const clickedEditor = {
      document: { uri: { scheme: 'forgejo-pr', path: '/i/o/r/head.ts', query: '{}' } },
      selection: { active: { line: 0 } },
    };
    (vscode.window as { activeTextEditor?: unknown }).activeTextEditor = activeEditor;
    (vscode.window as { visibleTextEditors?: unknown }).visibleTextEditors = [activeEditor, clickedEditor];
    const handlers = registerHandlers();

    handlers.get('forgejoToolkit.addPullReviewComment')!({
      lineNumber: 3,
      uri: { scheme: 'forgejo-pr', path: '/i/o/r/head.ts', query: '{}' },
    });
    await flushAsync();

    expect(mocks.addComment).toHaveBeenCalledWith(clickedEditor, 2);
  });

  it('uses the uri-named visible editor even when no editor is active', async () => {
    const visibleEditor = {
      document: { uri: { scheme: 'forgejo-pr', path: '/i/o/r/head.ts', query: '{}' } },
      selection: { active: { line: 0 } },
    };
    (vscode.window as { visibleTextEditors?: unknown }).visibleTextEditors = [visibleEditor];
    const handlers = registerHandlers();

    handlers.get('forgejoToolkit.addPullReviewComment')!({
      lineNumber: 2,
      uri: { scheme: 'forgejo-pr', path: '/i/o/r/head.ts', query: '{}' },
    });
    await flushAsync();

    expect(mocks.addComment).toHaveBeenCalledWith(visibleEditor, 1);
    expect(vscode.window.showWarningMessage).not.toHaveBeenCalled();
  });

  it('falls back to the active editor when the uri matches no visible editor', async () => {
    // The document may have closed between the click and the dispatch; the
    // active editor is the best target left.
    const activeEditor = {
      document: { uri: { scheme: 'forgejo-pr', path: '/i/o/r/base.ts', query: '{}' } },
      selection: { active: { line: 5 } },
    };
    (vscode.window as { activeTextEditor?: unknown }).activeTextEditor = activeEditor;
    (vscode.window as { visibleTextEditors?: unknown }).visibleTextEditors = [
      { document: { uri: { scheme: 'forgejo-pr', path: '/i/o/r/other.ts', query: '{}' } } },
    ];
    const handlers = registerHandlers();

    handlers.get('forgejoToolkit.addPullReviewComment')!({
      lineNumber: 2,
      uri: { scheme: 'forgejo-pr', path: '/i/o/r/gone.ts', query: '{}' },
    });
    await flushAsync();

    // The line still comes from the click; only the editor fell back.
    expect(mocks.addComment).toHaveBeenCalledWith(activeEditor, 1);
  });
});

describe('toLineNumber', () => {
  it('reads the line number out of the object shape VS Code passes', () => {
    expect(toLineNumber({ lineNumber: 7, uri: { scheme: 'forgejo-pr' } }, undefined)).toBe(7);
  });

  it('accepts the documented (uri, lineNumbers, ...) argument order', () => {
    expect(toLineNumber({ scheme: 'forgejo-pr' }, [7, 6])).toBe(7);
  });

  it('returns undefined when the invocation names no line', () => {
    expect(toLineNumber(undefined, undefined)).toBeUndefined();
  });

  it('ignores argument values that are not finite line numbers', () => {
    expect(toLineNumber({ lineNumber: Number.NaN }, undefined)).toBeUndefined();
    expect(toLineNumber({ scheme: 'forgejo-pr' }, ['7'])).toBeUndefined();
  });
});

describe('package.json contributions', () => {
  const manifest = JSON.parse(
    readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'package.json'), 'utf8'),
  ) as {
    contributes: { menus: Record<string, Array<{ command: string; when?: string }>> };
  };

  const menuItem = (menu: string, command: string) =>
    (manifest.contributes.menus[menu] ?? []).find((item) => item.command === command);

  it('contributes deletePullReviewComment to the single-comment context menu', () => {
    // The reachable menu id is `comments/comment/context`; the previously used
    // `comment/context` is not a menu VS Code recognizes, so the command never
    // appeared. Guard stays on the controller id and the comment contextValue
    // this extension sets (`forgejo:...`).
    expect(menuItem('comment/context', 'forgejoToolkit.deletePullReviewComment')).toBeUndefined();
    expect(menuItem('comments/comment/context', 'forgejoToolkit.deletePullReviewComment')?.when).toBe(
      'commentController == forgejo-pull-review-comments && comment =~ /^forgejo:/',
    );
  });
});
