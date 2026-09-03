import { describe, it, expect, vi, beforeEach } from 'vitest';

// The shared extension-setup vscode mock lacks the comments API and drops the
// query from Uri.toString, which this controller relies on, so this file
// registers its own mock (it takes precedence over the setup-file mock).
const state = vi.hoisted(() => ({
  createdThreads: [] as Array<{ uriString: string; dispose: ReturnType<typeof vi.fn> }>,
  openHandlers: [] as Array<(doc: unknown) => unknown>,
  editorHandlers: [] as Array<(editor: unknown) => unknown>,
  diffFetches: 0,
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
        createCommentThread: vi.fn((uri: { toString(): string }, _range: unknown, comments: unknown[]) => {
          const thread = { uriString: uri.toString(), comments, canReply: true, collapsibleState: 0, dispose: vi.fn() };
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
      showErrorMessage: vi.fn(),
      showWarningMessage: vi.fn(),
      showInformationMessage: vi.fn(),
      createOutputChannel: vi.fn(() => ({ appendLine: vi.fn(), show: vi.fn(), dispose: vi.fn() })),
    },
    commands: {
      executeCommand: vi.fn(),
    },
    Range: class {
      constructor(
        public startLine: number,
        public startChar: number,
        public endLine: number,
        public endChar: number,
      ) {}
    },
    MarkdownString: class {
      supportHtml = false;
      constructor(public value: string) {}
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
      getPullReviewComments: vi.fn(async () => COMMENTS),
    };
  }),
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
  return { uri, lineCount: 10 };
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
