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
