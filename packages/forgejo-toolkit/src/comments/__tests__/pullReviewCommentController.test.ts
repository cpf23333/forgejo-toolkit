import { describe, it, expect, vi, beforeEach } from 'vitest';

// The shared extension-setup vscode mock lacks the comments API and drops the
// query from Uri.toString, which this controller relies on, so this file
// registers its own mock (it takes precedence over the setup-file mock).
const state = vi.hoisted(() => ({
  createdThreads: [] as Array<{
    uriString: string;
    range: unknown;
    comments: unknown[];
    collapsibleState: number;
    dispose: ReturnType<typeof vi.fn>;
  }>,
  openHandlers: [] as Array<(doc: unknown) => unknown>,
  editorHandlers: [] as Array<(editor: unknown) => unknown>,
  visibleRangesHandlers: [] as Array<() => unknown>,
  visibleEditors: [] as Array<{ document: unknown; setDecorations: ReturnType<typeof vi.fn> }>,
  diffFetches: 0,
  comments: null as unknown[] | null,
}));

vi.mock('vscode', () => {
  const makeUri = (scheme: string, path: string, query?: string) => ({
    scheme,
    path,
    query,
    fsPath: path,
    toString() {
      return query ? `${scheme}:${path}?${query}` : `${scheme}:${path}`;
    },
  });
  return {
    comments: {
      createCommentController: vi.fn(() => ({
        commentingRangeProvider: undefined,
        createCommentThread: vi.fn((uri: { toString(): string }, range: unknown, comments: unknown[]) => {
          const thread = {
            uri,
            uriString: uri.toString(),
            range,
            comments,
            canReply: true,
            collapsibleState: 0,
            dispose: vi.fn(),
          };
          state.createdThreads.push(thread);
          return thread;
        }),
        dispose: vi.fn(),
      })),
    },
    workspace: {
      onDidOpenTextDocument: vi.fn((cb: (doc: unknown) => unknown) => {
        state.openHandlers.push(cb);
        return { dispose: vi.fn() };
      }),
      textDocuments: [],
      getConfiguration: vi.fn(() => ({ get: vi.fn(), update: vi.fn() })),
      onDidChangeConfiguration: vi.fn(() => ({ dispose: vi.fn() })),
    },
    window: {
      onDidChangeActiveTextEditor: vi.fn((cb: (editor: unknown) => unknown) => {
        state.editorHandlers.push(cb);
        return { dispose: vi.fn() };
      }),
      onDidChangeVisibleTextEditors: vi.fn(() => ({ dispose: vi.fn() })),
      onDidChangeTextEditorVisibleRanges: vi.fn((cb: () => unknown) => {
        state.visibleRangesHandlers.push(cb);
        return { dispose: vi.fn() };
      }),
      get visibleTextEditors() {
        return state.visibleEditors;
      },
      createTextEditorDecorationType: vi.fn(() => ({ dispose: vi.fn() })),
      showErrorMessage: vi.fn(),
      showWarningMessage: vi.fn(),
      showInformationMessage: vi.fn(),
      createOutputChannel: vi.fn(() => ({ appendLine: vi.fn(), show: vi.fn(), dispose: vi.fn() })),
    },
    commands: {
      executeCommand: vi.fn(),
    },
    Range: class {
      start: { line: number; character: number };
      end: { line: number; character: number };
      constructor(
        public startLine: number,
        public startChar: number,
        public endLine: number,
        public endChar: number,
      ) {
        this.start = { line: startLine, character: startChar };
        this.end = { line: endLine, character: endChar };
      }
    },
    MarkdownString: class {
      supportHtml = false;
      constructor(public value: string) {}
    },
    ThemeColor: class {
      constructor(public id: string) {}
    },
    CommentMode: { Preview: 0, Editing: 1 },
    CommentThreadCollapsibleState: { Collapsed: 0, Expanded: 1 },
    Uri: {
      from: vi.fn((c: { scheme: string; path: string; query?: string }) => makeUri(c.scheme, c.path, c.query)),
      parse: vi.fn((s: string) => ({ fsPath: s, scheme: s.split(':')[0] })),
      file: vi.fn((p: string) => ({ fsPath: p, scheme: 'file' })),
    },
    l10n: { t: (m: string) => m },
  };
});

const DIFF = `diff --git a/src/index.ts b/src/index.ts
index 1111111..2222222 100644
--- a/src/index.ts
+++ b/src/index.ts
@@ -1,3 +1,4 @@
 line1
-line2
+line2 changed
+line2.5
 line3
`;

// One comment per diff side of the same file.
const COMMENTS = [
  { id: 100, path: 'src/index.ts', position: 0, original_position: 2, body: 'base note', user: { login: 'reviewer' } },
  { id: 101, path: 'src/index.ts', position: 2, original_position: 0, body: 'head note', user: { login: 'reviewer' } },
];

vi.mock('../../api/client', () => ({
  ForgejoClient: vi.fn().mockImplementation(function () {
    return {
      getPullRequestDiff: vi.fn(async () => {
        state.diffFetches += 1;
        return DIFF;
      }),
      listPullReviews: vi.fn(async () => [{ id: 10, state: 'COMMENTED', user: { login: 'reviewer' } }]),
      getPullReviewComments: vi.fn(async () => state.comments ?? COMMENTS),
    };
  }),
}));

// addComment opens the singleton comment panel; capture the context it would
// receive instead of spinning up a real webview panel.
const panelState = vi.hoisted(() => ({ createOrShow: vi.fn() }));
vi.mock('../pullReviewCommentPanel', () => ({
  PullReviewCommentPanel: { createOrShow: panelState.createOrShow },
}));

import { PullReviewCommentController } from '../pullReviewCommentController';
import { FORGEJO_PR_SCHEME } from '../../prFileSystemProvider';
import type { ConfigManager } from '../../config';
import * as vscode from 'vscode';

const INSTANCE_ID = 'inst-1';

function createConfig(): ConfigManager {
  return {
    getInstances: () => [
      {
        id: INSTANCE_ID,
        url: 'https://forgejo.example.com',
        token: '',
        name: 'user@forgejo.example.com',
        username: 'user',
      },
    ],
  } as unknown as ConfigManager;
}

function makeDocument(isBase: boolean) {
  // The query must serialize exactly like the controller's _buildUri so the
  // document matches the comments rendered for its side.
  const query = JSON.stringify({ index: 2, ref: 'sha1', isBase });
  const path = `/${INSTANCE_ID}/owner/repo/src/index.ts`;
  const uri = {
    scheme: FORGEJO_PR_SCHEME,
    path,
    query,
    toString() {
      return `${FORGEJO_PR_SCHEME}:${path}?${query}`;
    },
  };
  return {
    uri,
    lineCount: 10,
    // The controller ends a multi-line thread range at the last line's end
    // character so the final line stays highlighted.
    lineAt: (line: number) => ({ text: `mock line ${line}` }),
  };
}

function threadCount(controller: PullReviewCommentController): number {
  return (controller as unknown as { _threads: Map<string, unknown> })._threads.size;
}

describe('PullReviewCommentController thread cleanup', () => {
  beforeEach(() => {
    state.createdThreads.length = 0;
    state.openHandlers.length = 0;
  });

  it('keeps base-side threads alive when the head-side document renders, and vice versa', async () => {
    const logs: string[] = [];
    const logger = { debug: vi.fn(), info: vi.fn(), error: vi.fn((m: string) => logs.push(m)) };
    const controller = new PullReviewCommentController(createConfig(), { fsPath: '/ext' } as never, logger as never);
    const openDocument = state.openHandlers[0];

    await openDocument(makeDocument(false));
    expect(logs).toEqual([]);
    expect(threadCount(controller)).toBe(1);
    const headThread = state.createdThreads[0];
    expect(headThread.uriString).toContain('"isBase":false');

    // Rendering the base side must not dispose the head side's thread.
    await openDocument(makeDocument(true));
    expect(threadCount(controller)).toBe(2);
    expect(headThread.dispose).not.toHaveBeenCalled();
    const baseThread = state.createdThreads[1];
    expect(baseThread.uriString).toContain('"isBase":true');

    // Re-rendering the head side only refreshes its own thread.
    await openDocument(makeDocument(false));
    expect(threadCount(controller)).toBe(2);
    expect(baseThread.dispose).not.toHaveBeenCalled();

    controller.dispose();
  });
});

describe('PullReviewCommentController load coalescing', () => {
  beforeEach(() => {
    state.createdThreads.length = 0;
    state.openHandlers.length = 0;
    state.diffFetches = 0;
  });

  it('serializes concurrent opens of the same document into one fetch and one thread set', async () => {
    const controller = new PullReviewCommentController(createConfig(), { fsPath: '/ext' } as never);
    const openDocument = state.openHandlers[0];

    // onDidOpenTextDocument and onDidChangeActiveTextEditor fire together.
    await Promise.all([openDocument(makeDocument(false)), openDocument(makeDocument(false))]);

    expect(state.diffFetches).toBe(1);
    expect(threadCount(controller)).toBe(1);
    controller.dispose();
  });

  it('reuses the cached review data across documents of the same pull request', async () => {
    const controller = new PullReviewCommentController(createConfig(), { fsPath: '/ext' } as never);
    const openDocument = state.openHandlers[0];

    await openDocument(makeDocument(false));
    await openDocument(makeDocument(true));

    expect(state.diffFetches).toBe(1);
    expect(threadCount(controller)).toBe(2);
    controller.dispose();
  });

  it('reloads after the TTL expires', async () => {
    vi.useFakeTimers();
    try {
      const controller = new PullReviewCommentController(createConfig(), { fsPath: '/ext' } as never);
      const openDocument = state.openHandlers[0];

      await openDocument(makeDocument(false));
      expect(state.diffFetches).toBe(1);

      vi.setSystemTime(Date.now() + 60_000);
      await openDocument(makeDocument(false));
      expect(state.diffFetches).toBe(2);
      controller.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it('invalidates the cache when refreshing after a mutation', async () => {
    const controller = new PullReviewCommentController(createConfig(), { fsPath: '/ext' } as never);
    const openDocument = state.openHandlers[0];

    await openDocument(makeDocument(false));
    expect(state.diffFetches).toBe(1);

    const internals = controller as unknown as {
      _refreshOpenPrDocuments(params: {
        instanceId: string;
        owner: string;
        repo: string;
        index: number;
      }): Promise<void>;
    };
    await internals._refreshOpenPrDocuments({ instanceId: INSTANCE_ID, owner: 'owner', repo: 'repo', index: 2 });
    expect(state.diffFetches).toBe(2);
    controller.dispose();
  });
});

describe('PullReviewCommentController context key', () => {
  beforeEach(() => {
    state.editorHandlers.length = 0;
    vi.mocked(vscode.commands.executeCommand).mockClear();
  });

  it('sets forgejoToolkit.inPullRequestDiff from the active editor scheme', () => {
    const controller = new PullReviewCommentController(createConfig(), { fsPath: '/ext' } as never);
    const executeCommand = vi.mocked(vscode.commands.executeCommand);

    // No active editor in the mock -> key cleared.
    expect(executeCommand).toHaveBeenCalledWith('setContext', 'forgejoToolkit.inPullRequestDiff', false);

    const onEditorChange = state.editorHandlers[0];
    executeCommand.mockClear();
    onEditorChange({ document: makeDocument(false) });
    expect(executeCommand).toHaveBeenCalledWith('setContext', 'forgejoToolkit.inPullRequestDiff', true);

    executeCommand.mockClear();
    onEditorChange({ document: { uri: { scheme: 'file' } } });
    expect(executeCommand).toHaveBeenCalledWith('setContext', 'forgejoToolkit.inPullRequestDiff', false);

    controller.dispose();
  });
});

describe('PullReviewCommentController comment context cleanup', () => {
  beforeEach(() => {
    state.createdThreads.length = 0;
    state.openHandlers.length = 0;
    state.comments = null;
  });

  it('drops the comment context when a re-render disposes its thread', async () => {
    vi.useFakeTimers();
    try {
      const controller = new PullReviewCommentController(createConfig(), { fsPath: '/ext' } as never);
      const openDocument = state.openHandlers[0];

      await openDocument(makeDocument(false));
      const thread = state.createdThreads[0];
      const contextValue = (thread.comments[0] as { contextValue?: string }).contextValue as string;
      expect(controller.getCommentContext(contextValue)).toBeDefined();

      // The head-side comment (position 2) vanishes upstream; after the review
      // data cache TTL the re-render disposes its thread and must drop the
      // encoded context entry too.
      state.comments = [COMMENTS[0]];
      vi.setSystemTime(Date.now() + 60_000);
      await openDocument(makeDocument(false));

      expect(thread.dispose).toHaveBeenCalled();
      expect(controller.getCommentContext(contextValue)).toBeUndefined();
      controller.dispose();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('PullReviewCommentController multi-line comments', () => {
  beforeEach(() => {
    state.createdThreads.length = 0;
    state.openHandlers.length = 0;
    state.visibleEditors.length = 0;
    state.comments = null;
    panelState.createOrShow.mockClear();
    vi.mocked(vscode.window.showErrorMessage).mockClear();
  });

  it('renders a multi-line comment as a thread spanning anchor..anchor+extra_lines_count', async () => {
    // Forgejo anchor semantics: `position` is the FIRST line of the range and
    // `extra_lines_count` extends it forward (verified against Forgejo's
    // models/issues/comment.go DisplayLine).
    state.comments = [
      { id: 102, path: 'src/index.ts', position: 2, original_position: 0, extra_lines_count: 3, body: 'multi' },
    ];
    const controller = new PullReviewCommentController(createConfig(), { fsPath: '/ext' } as never);
    const openDocument = state.openHandlers[0];

    await openDocument(makeDocument(false));

    // 0-based anchor line 1, extending 3 lines forward -> lines 1..4. The
    // range must end at the last line's end character, not column 0, or the
    // final line renders without a highlight.
    expect(state.createdThreads[0].range).toMatchObject({ startLine: 1, endLine: 4, endChar: 'mock line 4'.length });
    controller.dispose();
  });

  it('clamps an outdated multi-line range to the document end', async () => {
    state.comments = [
      { id: 103, path: 'src/index.ts', position: 9, original_position: 0, extra_lines_count: 5, body: 'multi' },
    ];
    const controller = new PullReviewCommentController(createConfig(), { fsPath: '/ext' } as never);
    const openDocument = state.openHandlers[0];

    // lineCount is 10 in makeDocument, so the range ends at line index 9.
    await openDocument(makeDocument(false));

    expect(state.createdThreads[0].range).toMatchObject({ startLine: 8, endLine: 9 });
    controller.dispose();
  });

  it('paints a whole-line decoration on the final line of a multi-line comment', async () => {
    // VS Code's native thread-range decoration is inline: the first and
    // interior lines get a full-width band but the final line is tinted only
    // up to the end column. The controller supplements just that final line;
    // decorating the whole range would double-tint the native-covered lines.
    state.comments = [
      { id: 104, path: 'src/index.ts', position: 2, original_position: 0, extra_lines_count: 3, body: 'multi' },
    ];
    const editor = { document: makeDocument(false), setDecorations: vi.fn() };
    state.visibleEditors.push(editor);
    const controller = new PullReviewCommentController(createConfig(), { fsPath: '/ext' } as never);
    const openDocument = state.openHandlers[0];

    await openDocument(makeDocument(false));

    expect(editor.setDecorations).toHaveBeenCalled();
    const ranges = editor.setDecorations.mock.calls.at(-1)![1] as Array<{ startLine: number; endLine: number }>;
    expect(ranges).toHaveLength(1);
    expect(ranges[0]).toMatchObject({ startLine: 4, endLine: 4 });
    controller.dispose();
  });

  it('leaves single-line comments to the native inline decoration', async () => {
    const editor = { document: makeDocument(false), setDecorations: vi.fn() };
    state.visibleEditors.push(editor);
    const controller = new PullReviewCommentController(createConfig(), { fsPath: '/ext' } as never);
    const openDocument = state.openHandlers[0];

    // Default COMMENTS: one single-line comment per diff side.
    await openDocument(makeDocument(false));

    expect(editor.setDecorations).toHaveBeenCalled();
    const ranges = editor.setDecorations.mock.calls.at(-1)![1] as unknown[];
    expect(ranges).toEqual([]);
    controller.dispose();
  });

  it('deduplicates last-line supplements from overlapping threads on the same line', async () => {
    // Two threads ending on the same line must produce a single decoration:
    // the translucent theme color would otherwise stack once per thread and
    // make that line darker than the natively-decorated lines around it.
    state.comments = [
      { id: 106, path: 'src/index.ts', position: 2, original_position: 0, extra_lines_count: 3, body: 'multi a' },
      { id: 107, path: 'src/index.ts', position: 3, original_position: 0, extra_lines_count: 2, body: 'multi b' },
    ];
    const editor = { document: makeDocument(false), setDecorations: vi.fn() };
    state.visibleEditors.push(editor);
    const controller = new PullReviewCommentController(createConfig(), { fsPath: '/ext' } as never);
    const openDocument = state.openHandlers[0];

    await openDocument(makeDocument(false));

    expect(editor.setDecorations).toHaveBeenCalled();
    const ranges = editor.setDecorations.mock.calls.at(-1)![1] as Array<{ startLine: number; endLine: number }>;
    expect(ranges).toHaveLength(1);
    expect(ranges[0]).toMatchObject({ startLine: 4, endLine: 4 });
    controller.dispose();
  });

  it('does not paint supplements for collapsed threads', async () => {
    // VS Code's own range decorator only paints expanded threads; the
    // supplements must follow suit or a collapsed thread would leave a
    // tinted final line behind with nothing on the interior lines. The
    // extension host learns about user-initiated collapse silently (no
    // event), so the controller re-applies debounced off the
    // visible-ranges event that the zone widget's height change triggers.
    state.comments = [
      { id: 108, path: 'src/index.ts', position: 2, original_position: 0, extra_lines_count: 3, body: 'multi' },
    ];
    const editor = { document: makeDocument(false), setDecorations: vi.fn() };
    state.visibleEditors.push(editor);
    const controller = new PullReviewCommentController(createConfig(), { fsPath: '/ext' } as never);
    const openDocument = state.openHandlers[0];

    await openDocument(makeDocument(false));
    state.createdThreads[0].collapsibleState = 0;
    editor.setDecorations.mockClear();

    for (const handler of state.visibleRangesHandlers) {
      handler();
    }
    await new Promise((resolve) => setTimeout(resolve, 80));

    expect(editor.setDecorations).toHaveBeenCalled();
    const ranges = editor.setDecorations.mock.calls.at(-1)![1] as unknown[];
    expect(ranges).toEqual([]);
    controller.dispose();
  });

  it('re-applies range decorations when the active editor changes', async () => {
    // Focus changes are the safety net for editors that lost their decorations
    // without a visible-editors event: the re-apply runs synchronously in the
    // handler, ahead of the serialized re-render it also triggers.
    state.comments = [
      { id: 105, path: 'src/index.ts', position: 2, original_position: 0, extra_lines_count: 3, body: 'multi' },
    ];
    const editor = { document: makeDocument(false), setDecorations: vi.fn() };
    state.visibleEditors.push(editor);
    const controller = new PullReviewCommentController(createConfig(), { fsPath: '/ext' } as never);
    const openDocument = state.openHandlers[0];

    await openDocument(makeDocument(false));
    editor.setDecorations.mockClear();

    state.editorHandlers.at(-1)!(editor);

    expect(editor.setDecorations).toHaveBeenCalled();
    const ranges = editor.setDecorations.mock.calls.at(-1)![1] as Array<{ startLine: number; endLine: number }>;
    expect(ranges).toHaveLength(1);
    expect(ranges[0]).toMatchObject({ startLine: 4, endLine: 4 });
    controller.dispose();
  });

  it('comments on the selected line range when adding a comment with a selection', async () => {
    const controller = new PullReviewCommentController(createConfig(), { fsPath: '/ext' } as never);
    const editor = {
      document: makeDocument(false),
      selection: {
        isEmpty: false,
        start: { line: 1, character: 0 },
        end: { line: 3, character: 6 },
        active: { line: 3 },
      },
    };

    await controller.addComment(editor as never);

    expect(panelState.createOrShow).toHaveBeenCalledTimes(1);
    const context = panelState.createOrShow.mock.calls[0][2] as {
      lineNumber: number;
      position: number;
      extraLinesCount?: number;
    };
    expect(context.lineNumber).toBe(1);
    expect(context.position).toBe(2);
    expect(context.extraLinesCount).toBe(2);
    controller.dispose();
  });

  it('excludes the last line of a selection ending at column 0', async () => {
    const controller = new PullReviewCommentController(createConfig(), { fsPath: '/ext' } as never);
    const editor = {
      document: makeDocument(false),
      selection: {
        isEmpty: false,
        start: { line: 1, character: 2 },
        end: { line: 3, character: 0 },
        active: { line: 3 },
      },
    };

    await controller.addComment(editor as never);

    const context = panelState.createOrShow.mock.calls[0][2] as { extraLinesCount?: number };
    expect(context.extraLinesCount).toBe(1);
    controller.dispose();
  });

  it('keeps single-line behavior for an explicit line number without a selection', async () => {
    const controller = new PullReviewCommentController(createConfig(), { fsPath: '/ext' } as never);
    const editor = {
      document: makeDocument(false),
      selection: {
        isEmpty: true,
        start: { line: 5, character: 0 },
        end: { line: 5, character: 0 },
        active: { line: 5 },
      },
    };

    await controller.addComment(editor as never, 2);

    const context = panelState.createOrShow.mock.calls[0][2] as { lineNumber: number; extraLinesCount?: number };
    expect(context.lineNumber).toBe(2);
    expect(context.extraLinesCount).toBeUndefined();
    controller.dispose();
  });

  it('rejects a selection whose last line is outside the pull request diff', async () => {
    const controller = new PullReviewCommentController(createConfig(), { fsPath: '/ext' } as never);
    const editor = {
      document: makeDocument(false),
      selection: {
        isEmpty: false,
        start: { line: 0, character: 0 },
        end: { line: 9, character: 1 },
        active: { line: 9 },
      },
    };

    await controller.addComment(editor as never);

    expect(panelState.createOrShow).not.toHaveBeenCalled();
    expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(expect.stringContaining('pull request diff'));
    controller.dispose();
  });
});
