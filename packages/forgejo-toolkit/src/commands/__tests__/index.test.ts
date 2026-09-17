import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';

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

import { registerCommands } from '../index';

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
});
