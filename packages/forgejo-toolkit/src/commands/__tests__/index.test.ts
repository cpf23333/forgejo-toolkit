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
import { REFRESH_VIEW_COMMANDS } from '../../webview/activeView';

async function flushAsync() {
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
}

function registerHandlers() {
  return registerHandlersWithProvider().handlers;
}

/**
 * The same registration, keeping the provider the commands were handed: the
 * view-title refresh commands share one handler on it, and "they all refresh the
 * view the reader is on" is only observable through that provider.
 */
function registerHandlersWithProvider() {
  const controller = {
    addComment: mocks.addComment,
    deleteComment: mocks.deleteComment,
    getCommentContext: mocks.getCommentContext,
  };
  // The extension's own identity, as the real extension host fills it in: the
  // publisher and the package name from the manifest, joined by a dot.
  const context = { subscriptions: [] as Array<{ dispose(): void }>, extension: { id: 'cpf23333.forgejo-toolkit' } };
  // Registering the commands is also what hands the view provider the runs the
  // webview reaches — the AI pre-review's pull request detail button
  // (`setAiPreReviewRunner`) and the create form's "Generate description" control
  // (`setPrDescriptionRunner`) — so even this suite, which never dispatches a
  // webview message, has to pass a provider that accepts both handovers.
  const viewProvider = {
    refresh: vi.fn(),
    setAiPreReviewRunner: vi.fn(),
    setPrDescriptionRunner: vi.fn(),
  };
  registerCommands(context as never, {} as never, {} as never, viewProvider as never, controller as never);
  const handlers = new Map<string, (...args: unknown[]) => void>();
  for (const [name, callback] of vi.mocked(vscode.commands.registerCommand).mock.calls) {
    handlers.set(name, callback as (...args: unknown[]) => void);
  }
  return { handlers, viewProvider };
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

/**
 * A visible editor for one side of a PR diff file. Both sides of a diff share
 * the path and differ only in the query, so the query is what tells them apart.
 */
function editorForUri(query: string) {
  return {
    document: { uri: { scheme: 'forgejo-pr', path: '/i/o/r/f.ts', query } },
    selection: { active: { line: 0 }, start: { line: 0 }, end: { line: 0 }, isEmpty: true },
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

  it('leaves the anchor to addComment when the invocation names no line', async () => {
    // The editor context menu forwards the document uri, not a line, and the
    // palette forwards nothing. `addComment` is the layer that reads the
    // selection, so the handler must not pre-empt it: passing
    // `selection.active.line` from here flattened every selection, because
    // `addComment` only consults the selection when it was given no line.
    mockActiveEditor(4, { start: { line: 4 }, end: { line: 4 }, isEmpty: true });
    const handlers = registerHandlers();

    handlers.get('forgejoToolkit.addPullReviewComment')!();
    await flushAsync();

    expect(mocks.addComment).toHaveBeenCalledWith(expect.anything(), undefined);
  });

  it('does not flatten a two-line selection to its active line', async () => {
    // The reported scenario: two lines selected inside one hunk of a PR diff,
    // right-clicked, "Add Pull Review Comment". The anchor must reach
    // `addComment` as a range (it resolves `extra_lines_count` itself) instead
    // of collapsing to the caret line.
    mockActiveEditor(2, { start: { line: 1 }, end: { line: 2 }, isEmpty: false });
    const handlers = registerHandlers();

    handlers.get('forgejoToolkit.addPullReviewComment')!();
    await flushAsync();

    expect(mocks.addComment).toHaveBeenCalledWith(expect.anything(), undefined);
  });

  it('resolves the diff side the invocation names when both sides share a path', async () => {
    // `vscode.diff` shows two documents of the same file: both sides carry the
    // same scheme and path and differ only in the query (which holds `isBase`
    // and `ref`). Matching on the path alone picked whichever side
    // `visibleTextEditors` listed first, so a right-click on the head side
    // could resolve the base editor — and the head line number was then
    // validated against the base line table and refused with "Comments can
    // only be added to lines within the pull request diff".
    const baseEditor = editorForUri('{"index":2,"ref":"base-sha","isBase":true}');
    const headEditor = editorForUri('{"index":2,"ref":"head-sha","isBase":false}');
    (vscode.window as { visibleTextEditors?: unknown }).visibleTextEditors = [baseEditor, headEditor];
    const handlers = registerHandlers();

    handlers.get('forgejoToolkit.addPullReviewComment')!({
      scheme: 'forgejo-pr',
      path: '/i/o/r/f.ts',
      query: '{"index":2,"ref":"head-sha","isBase":false}',
    });
    await flushAsync();

    expect(mocks.addComment.mock.calls[0][0]).toBe(headEditor);
  });

  it('resolves the base side when the invocation names it and the head side is listed first', async () => {
    // The same defect in the other listing order: whichever side came first won
    // regardless of which one the click named.
    const baseEditor = editorForUri('{"index":2,"ref":"base-sha","isBase":true}');
    const headEditor = editorForUri('{"index":2,"ref":"head-sha","isBase":false}');
    (vscode.window as { visibleTextEditors?: unknown }).visibleTextEditors = [headEditor, baseEditor];
    const handlers = registerHandlers();

    handlers.get('forgejoToolkit.addPullReviewComment')!({
      scheme: 'forgejo-pr',
      path: '/i/o/r/f.ts',
      query: '{"index":2,"ref":"base-sha","isBase":true}',
    });
    await flushAsync();

    expect(mocks.addComment.mock.calls[0][0]).toBe(baseEditor);
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
    name: string;
    publisher: string;
    contributes: { menus: Record<string, Array<{ command: string; when?: string }>> };
  };

  const menuItem = (menu: string, command: string) =>
    (manifest.contributes.menus[menu] ?? []).find((item) => item.command === command);

  it('filters the native settings editor to the extension id the manifest declares', () => {
    // A live walkthrough found the filtered settings editor empty: the command was
    // handing `@ext:forgejo-toolkit` to `workbench.action.openSettings`, and the
    // extension id is `<publisher>.<name>` — the package name alone matches no
    // extension, so the editor opened saying no settings were found. The filter is
    // derived from the extension the host is running (`context.extension.id`),
    // which is exactly the identity this reads out of the manifest.
    const id = `${manifest.publisher}.${manifest.name}`;
    expect(id).toBe('cpf23333.forgejo-toolkit');

    const handlers = registerHandlers();
    handlers.get('forgejoToolkit.openNativeSettings')!();

    expect(vscode.commands.executeCommand).toHaveBeenCalledWith('workbench.action.openSettings', `@ext:${id}`);
  });

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

/**
 * The view-title refresh: one icon and one handler, with one item per target
 * whose `when` clause names the view it belongs to.
 *
 * A command's title is static, so the tooltip that says the true thing has to be
 * a command of its own (see the Webview UI section of
 * `docs/architecture/README.md`). These assertions read the manifest the way VS
 * Code evaluates it — every item's clause is matched against every value the host
 * can store under `forgejoToolkit.activeView` — so an item that overlaps another,
 * one that claims a view it does not refresh, or a second refresh entry in the
 * palette fails here instead of on screen.
 */
describe('the view-title refresh items', () => {
  const manifest = JSON.parse(
    readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'package.json'), 'utf8'),
  ) as {
    contributes: {
      commands: Array<{ command: string; title?: string; icon?: string }>;
      menus: Record<string, Array<{ command: string; when?: string }>>;
    };
  };
  const readNls = (file: string) =>
    JSON.parse(
      readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', file), 'utf8'),
    ) as Record<string, string>;

  /** The command each reported view has to offer, and the views that offer none. */
  const EXPECTED_ITEM: Record<string, string> = {
    dashboard: 'forgejoToolkit.refreshInstances',
    repoDetail: 'forgejoToolkit.refreshRepository',
    repoIssues: 'forgejoToolkit.refreshRepository',
    repoPullRequests: 'forgejoToolkit.refreshRepository',
    actionRunDetail: 'forgejoToolkit.refreshRepository',
    issueDetail: 'forgejoToolkit.refreshIssue',
    pullRequestDetail: 'forgejoToolkit.refreshPullRequest',
    notifications: 'forgejoToolkit.refreshNotifications',
    // The only sidebar route deliberately without one: its results belong to the
    // query in its own box, and re-running that query is what its Search control
    // does.
    globalSearch: '',
  };

  const refreshItems = (manifest.contributes.menus['view/title'] ?? []).filter((item) =>
    (REFRESH_VIEW_COMMANDS as readonly string[]).includes(item.command),
  );

  /**
   * The `forgejoToolkit.activeView` values a clause matches.
   *
   * Only the two shapes this extension writes are read — one equality, or one
   * anchored alternation — so a clause that tests the key another way (a
   * negation, which would make an item visible where it must not be) is reported
   * as unreadable rather than silently counted as no match.
   */
  function matchedActiveViews(when: string | undefined): string[] | undefined {
    if (typeof when !== 'string') {
      return undefined;
    }
    const equality = /forgejoToolkit\.activeView == ([a-zA-Z]+)/.exec(when);
    if (equality) {
      return [equality[1]];
    }
    const alternation = /forgejoToolkit\.activeView =~ \/\^\(([a-zA-Z|]+)\)\$\//.exec(when);
    return alternation ? alternation[1].split('|') : undefined;
  }

  /** Every refresh item a reported view would show, `view == forgejoToolkitView` included. */
  function itemsForView(view: string): string[] {
    return refreshItems
      .filter((item) => item.when?.includes('view == forgejoToolkitView'))
      .filter((item) => matchedActiveViews(item.when)?.includes(view))
      .map((item) => item.command);
  }

  it('contributes one item per refresh command, all sharing the refresh icon', () => {
    const withRefreshIcon = manifest.contributes.commands.filter((entry) => entry.icon === '$(refresh)');
    expect(withRefreshIcon.map((entry) => entry.command).sort()).toEqual([...REFRESH_VIEW_COMMANDS].sort());
    for (const id of REFRESH_VIEW_COMMANDS) {
      expect(
        refreshItems.filter((item) => item.command === id),
        id,
      ).toHaveLength(1);
    }
  });

  it('shows exactly one item, for the view the sidebar reported', () => {
    for (const [view, expected] of Object.entries(EXPECTED_ITEM)) {
      expect(itemsForView(view), view).toEqual(expected ? [expected] : []);
    }
    // A report of "nothing to refresh" — the dashboard of an installation with
    // no instance — has to leave the icon away, and so has a value the host
    // refuses (which it stores as no view at all).
    expect(itemsForView('none')).toEqual([]);
    expect(itemsForView('someFutureView')).toEqual([]);
  });

  it('gates every item on the sidebar view, which no panel reports', () => {
    // The settings tab, the setup wizard and the three editor-area panels are
    // separate documents with no view title bar, and none of them mounts the
    // sidebar's shell, so none of them ever reports a view. The `view` half of the
    // clause is what keeps an item out of any other view a contribution could
    // reach.
    for (const item of refreshItems) {
      expect(matchedActiveViews(item.when), `${item.command} has no readable activeView clause`).toBeDefined();
      expect(item.when, item.command).toContain('view == forgejoToolkitView');
    }
  });

  it('gives each item its own tooltip, in both languages', () => {
    const titles = REFRESH_VIEW_COMMANDS.map(
      (id) => manifest.contributes.commands.find((entry) => entry.command === id)?.title ?? '',
    );
    for (const [index, title] of titles.entries()) {
      expect(title, REFRESH_VIEW_COMMANDS[index]).toMatch(/^%command\.[a-zA-Z]+\.title%$/);
    }
    // The wording differences are the point: five items that all said "Refresh"
    // would leave the reader guessing which one they are looking at.
    expect(new Set(titles).size).toBe(titles.length);

    const en = readNls('package.nls.json');
    const zh = readNls('package.nls.zh-cn.json');
    for (const title of titles) {
      const key = title.slice(1, -1);
      expect(en[key], `en: ${key}`).toBeTruthy();
      expect(zh[key], `zh: ${key}`).toBeTruthy();
      expect(zh[key], key).not.toBe(en[key]);
    }
  });

  it('keeps the palette to the one refresh that matches the sidebar', () => {
    // Every contributed command is in the palette unless a `commandPalette` entry
    // says otherwise, so ungated entries would list five refresh actions whose
    // titles only one of them can honour.
    const palette = (manifest.contributes.menus.commandPalette ?? []).filter((item) =>
      (REFRESH_VIEW_COMMANDS as readonly string[]).includes(item.command),
    );
    expect(palette.map((item) => item.command).sort()).toEqual([...REFRESH_VIEW_COMMANDS].sort());
    for (const item of palette) {
      const itemWhen = refreshItems.find((viewItem) => viewItem.command === item.command)?.when;
      expect(matchedActiveViews(item.when), item.command).toEqual(matchedActiveViews(itemWhen));
      // `view` is not set in the palette, so the clause may not test it there.
      expect(item.when, item.command).not.toContain('view ==');
    }
  });

  it('registers every refresh command on the one handler', () => {
    const { handlers, viewProvider } = registerHandlersWithProvider();
    for (const id of REFRESH_VIEW_COMMANDS) {
      const handler = handlers.get(id);
      expect(handler, `${id} is not registered`).toBeDefined();
      handler!();
    }
    // One implementation, several items: the press is routed by the webview
    // (`refreshActiveView`), which is the only side that knows its own route.
    expect(viewProvider.refresh).toHaveBeenCalledTimes(REFRESH_VIEW_COMMANDS.length);
  });
});
