import { describe, it, expect, vi, beforeEach } from 'vitest';

// The shared extension-setup vscode mock lacks the comments API and drops the
// query from Uri.toString, which this controller relies on, so this file
// registers its own mock (it takes precedence over the setup-file mock).
const state = vi.hoisted(() => ({
  createdThreads: [] as Array<{
    uriString: string;
    range: unknown;
    comments: unknown[];
    // The reply box only appears when the controller sets this; the fake starts
    // it off exactly as VS Code's own `CommentThread` default does.
    canReply: boolean;
    collapsibleState: number;
    dispose: ReturnType<typeof vi.fn>;
  }>,
  openHandlers: [] as Array<(doc: unknown) => unknown>,
  closeHandlers: [] as Array<(doc: unknown) => unknown>,
  editorHandlers: [] as Array<(editor: unknown) => unknown>,
  visibleRangesHandlers: [] as Array<(event?: { textEditor?: { document: unknown } }) => unknown>,
  visibleEditorHandlers: [] as Array<() => unknown>,
  visibleEditors: [] as Array<{ document: unknown; setDecorations: ReturnType<typeof vi.fn> }>,
  diffFetches: 0,
  comments: null as unknown[] | null,
  diffError: null as Error | null,
  // Reviews the comments endpoint rejects, keyed by review id.
  failedReviewIds: [] as number[],
  // Overrides the review list the client returns; null keeps the default.
  listReviews: null as Array<{ id: number; state: string; user: { login: string } }> | null,
  // Review ids the comments endpoint is asked for, in call order.
  commentsRequests: [] as number[],
  // Peak number of comment requests in flight at the same time.
  peakCommentsInFlight: 0,
  commentsInFlight: 0,
  // When set, every comments request blocks on this gate instead of resolving
  // immediately. Used to observe the fan-out while requests are in flight;
  // a timer would be affected by the suite's fake-timer tests.
  commentsGate: null as { promise: Promise<void>; resolve(): void } | null,
  // Commands the controller registered, by id: the reply command is the only
  // one it owns, and the test invokes it the way the workbench would.
  registeredCommands: new Map<string, (...args: unknown[]) => unknown>(),
  // Issue/PR comments the reply created, in call order: the reply is an
  // ordinary pull request comment, so this is the endpoint it must go through.
  issueComments: [] as Array<{ owner: string; repo: string; index: number; body: string }>,
  // When set, the issue-comment endpoint rejects with this error.
  issueCommentError: null as Error | null,
  // Review comments written into a pending review. The reply must never land
  // here — the pending review is the AI pre-review's draft area — so the
  // endpoints are mocked to record whether anything reached them at all.
  reviewWrites: [] as Array<{ endpoint: string; reviewId?: number; body: unknown }>,
  // Makes the list endpoint report a PENDING review of the signed-in user, so
  // the interactive add-comment path finds it and the reply tests can show that
  // a reply ignores it.
  pendingReviewId: null as number | null,
}));

function createGate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, resolve: release };
}

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
            canReply: false,
            collapsibleState: 0,
            contextValue: undefined as string | undefined,
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
      onDidCloseTextDocument: vi.fn((cb: (doc: unknown) => unknown) => {
        state.closeHandlers.push(cb);
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
      onDidChangeVisibleTextEditors: vi.fn((cb: () => unknown) => {
        state.visibleEditorHandlers.push(cb);
        return { dispose: vi.fn() };
      }),
      onDidChangeTextEditorVisibleRanges: vi.fn((cb: (event?: { textEditor?: { document: unknown } }) => unknown) => {
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
      // The controller registers its own reply command at construction, because
      // the command needs the thread the workbench hands it and no other module
      // has that state.
      registerCommand: vi.fn((command: string, handler: (...args: unknown[]) => unknown) => {
        state.registeredCommands.set(command, handler);
        return { dispose: vi.fn() };
      }),
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
    CommentThreadState: { Unresolved: 0, Resolved: 1 },
    Uri: {
      from: vi.fn((c: { scheme: string; path: string; query?: string }) => makeUri(c.scheme, c.path, c.query)),
      parse: vi.fn((s: string) => ({ fsPath: s, scheme: s.split(':')[0] })),
      file: vi.fn((p: string) => ({ fsPath: p, scheme: 'file' })),
    },
    l10n: {
      // Mirrors `vscode.l10n.t`, which interpolates the positional arguments
      // into the `{0}` placeholders; a mock that dropped them would hide which
      // ids a message names.
      t: (message: string, ...args: unknown[]) =>
        args.reduce<string>((text, arg, index) => text.replace(`{${index}}`, String(arg)), message),
    },
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
  // resolveAttachmentImages (used when submitting a comment) imports this.
  API_REQUEST_TIMEOUT_MS: 30_000,
  ForgejoClient: vi.fn().mockImplementation(function () {
    return {
      getPullRequestDiff: vi.fn(async () => {
        state.diffFetches += 1;
        if (state.diffError) {
          throw state.diffError;
        }
        return DIFF;
      }),
      listPullReviews: vi.fn(async () => {
        const reviews = state.listReviews ?? [{ id: 10, state: 'COMMENTED', user: { login: 'reviewer' } }];
        if (state.pendingReviewId === null) {
          return reviews;
        }
        return [...reviews, { id: state.pendingReviewId, state: 'PENDING', user: { login: 'user' } }];
      }),
      getPullReviewComments: vi.fn(async (_owner: string, _repo: string, _index: number, reviewId: number) => {
        state.commentsRequests.push(reviewId);
        state.commentsInFlight += 1;
        state.peakCommentsInFlight = Math.max(state.peakCommentsInFlight, state.commentsInFlight);
        try {
          // A gate (not a timer: the suite has fake-timer tests) so a burst is
          // observably in flight together; the concurrency cap is what keeps
          // that number bounded.
          if (state.commentsGate) {
            await state.commentsGate.promise;
          }
          if (state.failedReviewIds.includes(reviewId)) {
            throw new Error(`comments unavailable for review ${reviewId}`);
          }
          return state.comments ?? COMMENTS;
        } finally {
          state.commentsInFlight -= 1;
        }
      }),
      // `POST /repos/{owner}/{repo}/issues/{index}/comments` — the endpoint
      // Forgejo serves for issues *and* pull requests, and the one the reply
      // goes through so it is visible in the timeline immediately.
      createIssueComment: vi.fn(async (owner: string, repo: string, index: number, body: string) => {
        if (state.issueCommentError) {
          throw state.issueCommentError;
        }
        state.issueComments.push({ owner, repo, index, body });
        return { id: 900 };
      }),
      // The two endpoints that write into the user's pending review. Only the
      // AI pre-review uses them; the reply must not reach either, so the mocks
      // record what arrived instead of the reply relying on their absence.
      addPullReviewComment: vi.fn(
        async (_owner: string, _repo: string, _index: number, reviewId: number, body: unknown) => {
          state.reviewWrites.push({ endpoint: 'append', reviewId, body });
          return { id: 900 };
        },
      ),
      createPendingPullReview: vi.fn(async (_owner: string, _repo: string, _index: number, body: unknown) => {
        state.reviewWrites.push({ endpoint: 'create', reviewId: 88, body });
        return { id: 88 };
      }),
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
import * as attachmentResolver from '../../utils/resolveAttachmentImages';

/** Flush macrotasks until the predicate holds. */
async function flushUntil(predicate: () => boolean, attempts = 50) {
  for (let i = 0; i < attempts && !predicate(); i++) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

const INSTANCE_ID = 'inst-1';

function createConfig(): ConfigManager {
  return {
    getInstances: () => [
      {
        id: INSTANCE_ID,
        url: 'https://forgejo.example.com',
        // A token makes _createComment resolve attachment images, which is the
        // await the mid-render close test needs to interrupt.
        token: 'secret-token',
        name: 'user@forgejo.example.com',
        username: 'user',
      },
    ],
  } as unknown as ConfigManager;
}

function makeDocument(isBase: boolean, overrides?: { index?: number; ref?: string; instanceId?: string }) {
  // The query must serialize exactly like the controller's _buildUri so the
  // document matches the comments rendered for its side.
  const instanceId = overrides?.instanceId ?? INSTANCE_ID;
  const query = JSON.stringify({ index: overrides?.index ?? 2, ref: overrides?.ref ?? 'sha1', isBase });
  const path = `/${instanceId}/owner/repo/src/index.ts`;
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
    isClosed: false,
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
    state.closeHandlers.length = 0;
    state.editorHandlers.length = 0;
    state.visibleEditorHandlers.length = 0;
    state.visibleEditors.length = 0;
    state.commentsGate = null;
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

  it('disposes a thread when its document closes, leaving the other diff side alone', async () => {
    const controller = new PullReviewCommentController(createConfig(), { fsPath: '/ext' } as never);
    const openDocument = state.openHandlers[0];
    const closeDocument = state.closeHandlers[0];

    const headDocument = makeDocument(false);
    const baseDocument = makeDocument(true);
    await openDocument(headDocument);
    await openDocument(baseDocument);
    expect(threadCount(controller)).toBe(2);
    const [headThread, baseThread] = state.createdThreads;

    // Closing a diff editor fires one close event per side; each event must
    // only dispose the threads anchored on that side's URI.
    closeDocument(headDocument);
    expect(headThread.dispose).toHaveBeenCalledTimes(1);
    expect(baseThread.dispose).not.toHaveBeenCalled();
    expect(threadCount(controller)).toBe(1);

    closeDocument(baseDocument);
    expect(baseThread.dispose).toHaveBeenCalledTimes(1);
    expect(threadCount(controller)).toBe(0);

    controller.dispose();
  });

  it('drops the comment context when its thread is disposed on document close', async () => {
    const controller = new PullReviewCommentController(createConfig(), { fsPath: '/ext' } as never);
    const openDocument = state.openHandlers[0];
    const closeDocument = state.closeHandlers[0];

    const headDocument = makeDocument(false);
    await openDocument(headDocument);
    const thread = state.createdThreads[0];
    const contextValue = (thread.comments[0] as { contextValue?: string }).contextValue as string;
    expect(controller.getCommentContext(contextValue)).toBeDefined();

    closeDocument(headDocument);

    expect(thread.dispose).toHaveBeenCalled();
    expect(controller.getCommentContext(contextValue)).toBeUndefined();
    controller.dispose();
  });

  it('ignores close events for documents without threads', async () => {
    const controller = new PullReviewCommentController(createConfig(), { fsPath: '/ext' } as never);
    const openDocument = state.openHandlers[0];
    const closeDocument = state.closeHandlers[0];

    const headDocument = makeDocument(false);
    await openDocument(headDocument);
    expect(threadCount(controller)).toBe(1);

    closeDocument(makeDocument(true));

    expect(threadCount(controller)).toBe(1);
    expect(state.createdThreads[0].dispose).not.toHaveBeenCalled();
    controller.dispose();
  });

  it('creates no thread when the document closes while the review data is still loading', async () => {
    const controller = new PullReviewCommentController(createConfig(), { fsPath: '/ext' } as never);
    const openDocument = state.openHandlers[0];
    const closeDocument = state.closeHandlers[0];

    // The close fires while the load is in flight, so the close handler finds
    // no threads to dispose; without the post-load isClosed guard the render
    // that finishes afterwards would leak a ghost thread into the Comments
    // panel (no further close event ever arrives for it).
    const headDocument = makeDocument(false);
    const pendingRender = openDocument(headDocument);
    headDocument.isClosed = true;
    closeDocument(headDocument);
    await pendingRender;

    expect(state.createdThreads).toHaveLength(0);
    expect(threadCount(controller)).toBe(0);
    controller.dispose();
  });

  it('sweeps threads whose document is no longer visible when no close event arrives', async () => {
    vi.useFakeTimers();
    try {
      const controller = new PullReviewCommentController(createConfig(), { fsPath: '/ext' } as never);
      const openDocument = state.openHandlers[0];

      const headDocument = makeDocument(false);
      const baseDocument = makeDocument(true);
      state.visibleEditors.push({ document: headDocument, setDecorations: vi.fn() });
      state.visibleEditors.push({ document: baseDocument, setDecorations: vi.fn() });
      await openDocument(headDocument);
      await openDocument(baseDocument);
      expect(threadCount(controller)).toBe(2);
      const [headThread, baseThread] = state.createdThreads;
      state.visibleEditors.length = 0;

      // Closing the diff editor removes both documents from the visible
      // editors, but VS Code may never fire onDidCloseTextDocument for the
      // virtual PR documents; the visible-editor fallback must clean up.
      state.visibleEditorHandlers[0]();
      await vi.advanceTimersByTimeAsync(1000);

      expect(headThread.dispose).toHaveBeenCalledTimes(1);
      expect(baseThread.dispose).toHaveBeenCalledTimes(1);
      expect(threadCount(controller)).toBe(0);
      controller.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps threads of documents that are still visible', async () => {
    vi.useFakeTimers();
    try {
      const controller = new PullReviewCommentController(createConfig(), { fsPath: '/ext' } as never);
      const openDocument = state.openHandlers[0];

      const headDocument = makeDocument(false);
      state.visibleEditors.push({ document: headDocument, setDecorations: vi.fn() });
      await openDocument(headDocument);
      const headThread = state.createdThreads[0];

      // Another document becoming visible must not touch this side's threads.
      state.visibleEditors.push({ document: makeDocument(true), setDecorations: vi.fn() });
      state.visibleEditorHandlers[0]();
      await vi.advanceTimersByTimeAsync(1000);

      expect(headThread.dispose).not.toHaveBeenCalled();
      expect(threadCount(controller)).toBe(1);
      controller.dispose();
    } finally {
      vi.useRealTimers();
    }
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

  it('warns when the post-mutation refresh fails instead of staying silent', async () => {
    // The mutation itself was already applied and reported by the panel; a
    // refresh failure that only hits the log would leave the diff threads stale
    // with no sign anything went wrong.
    const controller = new PullReviewCommentController(createConfig(), { fsPath: '/ext' } as never);
    const openDocument = state.openHandlers[0];
    await openDocument(makeDocument(false));
    vi.mocked(vscode.window.showWarningMessage).mockClear();

    state.diffError = new Error('offline');
    try {
      const internals = controller as unknown as {
        _refreshOpenPrDocuments(params: {
          instanceId: string;
          owner: string;
          repo: string;
          index: number;
        }): Promise<void>;
      };
      await internals._refreshOpenPrDocuments({ instanceId: INSTANCE_ID, owner: 'owner', repo: 'repo', index: 2 });

      expect(vi.mocked(vscode.window.showWarningMessage)).toHaveBeenCalledWith(
        expect.stringContaining('refreshing the review threads failed'),
      );
    } finally {
      state.diffError = null;
      controller.dispose();
    }
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
    state.closeHandlers.length = 0;
    state.comments = null;
  });

  function contextCount(controller: PullReviewCommentController): number {
    return (controller as unknown as { _commentContextMap: Map<string, unknown> })._commentContextMap.size;
  }

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

  it('keeps a re-created comment deletable after a re-render', async () => {
    vi.useFakeTimers();
    try {
      const controller = new PullReviewCommentController(createConfig(), { fsPath: '/ext' } as never);
      const openDocument = state.openHandlers[0];

      await openDocument(makeDocument(false));
      const thread = state.createdThreads[0];
      const contextValue = (thread.comments[0] as { contextValue?: string }).contextValue as string;
      expect(controller.getCommentContext(contextValue)).toBeDefined();

      // A refresh re-renders the same comment: the thread is updated in place
      // with a freshly built comment whose encoded context is identical (the
      // encoding is pure over the coordinates). Dropping the old comment's
      // context while building the new one removed the entry the new comment
      // needs, so Delete found no context and returned silently.
      vi.setSystemTime(Date.now() + 60_000);
      await openDocument(makeDocument(false));

      expect(thread.dispose).not.toHaveBeenCalled();
      const replacement = thread.comments[0] as { contextValue?: string };
      expect(replacement.contextValue).toBe(contextValue);
      expect(controller.getCommentContext(contextValue)).toBeDefined();
      controller.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it('prunes threads of an earlier render when the document closes mid-render', async () => {
    const controller = new PullReviewCommentController(createConfig(), { fsPath: '/ext' } as never);
    const openDocument = state.openHandlers[0];

    const headDocument = makeDocument(false);
    await openDocument(headDocument);
    const headThread = state.createdThreads[0];
    const contextValue = (headThread.comments[0] as { contextValue?: string }).contextValue as string;

    // A second render with two comments on the same side: the first builds its
    // comment through an attachment resolution, and the document closes during
    // that await. The loop must stop before attaching a thread for it — a
    // thread created for a closed document would leak into the Comments panel
    // (no further close event ever arrives for it) — and must still run the
    // prune afterwards, or the head thread stays in the panel and in the map.
    state.comments = [
      { id: 301, path: 'src/index.ts', position: 2, body: 'head note' },
      { id: 303, path: 'src/index.ts', position: 3, body: 'another head note' },
    ];
    let finishAttachment!: () => void;
    // The comment for the first entry is built through an attachment
    // resolution, which is where the document closes.
    const attachmentSpy = vi
      .spyOn(attachmentResolver, 'resolveAttachmentImages')
      .mockImplementation(() => new Promise<string>((resolve) => (finishAttachment = () => resolve('body'))));
    try {
      vi.setSystemTime(Date.now() + 60_000);
      const pendingRender = openDocument(headDocument);
      await flushUntil(() => finishAttachment !== undefined);
      headDocument.isClosed = true;
      finishAttachment();
      await pendingRender;
      // Let the async continuations the resolved attachment kicked off settle;
      // the thread mutations are chained, so the assertions must not race them.
      await flushUntil(() => headThread.dispose.mock.calls.length > 0, 10);

      expect(headThread.dispose).toHaveBeenCalled();
      expect(controller.getCommentContext(contextValue)).toBeUndefined();
      // No thread was attached for either comment of the aborted render, and
      // the comment built mid-close left no context behind: the only thread
      // ever created is the first render's, and the map is empty.
      expect(state.createdThreads).toHaveLength(1);
      expect(threadCount(controller)).toBe(0);
      expect(contextCount(controller)).toBe(0);
    } finally {
      attachmentSpy.mockRestore();
      controller.dispose();
    }
  });

  it('drops the orphaned replacement when the document closes mid-await of an in-place update', async () => {
    const controller = new PullReviewCommentController(createConfig(), { fsPath: '/ext' } as never);
    const openDocument = state.openHandlers[0];
    const closeDocument = state.closeHandlers[0];

    const headDocument = makeDocument(false);
    await openDocument(headDocument);
    const headThread = state.createdThreads[0];
    const originalComment = headThread.comments[0];
    const contextValue = (originalComment as { contextValue?: string }).contextValue as string;

    // A refresh re-renders the same comment, taking the in-place update
    // branch: building the replacement awaits attachment resolution, and the
    // document closes during that await. The close event disposes the thread
    // and removes it from `_threads`, so writing the replacement into it would
    // resurrect a dead thread — and the replacement's context, registered
    // before the guard could run, would stay in the map forever.
    let finishAttachment!: () => void;
    const attachmentSpy = vi
      .spyOn(attachmentResolver, 'resolveAttachmentImages')
      .mockImplementation(() => new Promise<string>((resolve) => (finishAttachment = () => resolve('body'))));
    try {
      vi.setSystemTime(Date.now() + 60_000);
      const pendingRender = openDocument(headDocument);
      await flushUntil(() => finishAttachment !== undefined);
      headDocument.isClosed = true;
      closeDocument(headDocument);
      finishAttachment();
      await pendingRender;

      // Disposed once, by the close event — not again by the render — and the
      // dead thread still carries the original comment, not the replacement.
      expect(headThread.dispose).toHaveBeenCalledTimes(1);
      expect(headThread.comments[0]).toBe(originalComment);
      expect(threadCount(controller)).toBe(0);
      // The replacement re-registered the same encoded context value (the
      // encoding is pure over the coordinates); the guard must drop it again.
      expect(controller.getCommentContext(contextValue)).toBeUndefined();
      expect(contextCount(controller)).toBe(0);
    } finally {
      attachmentSpy.mockRestore();
      controller.dispose();
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
    //
    // Fake timers (same pattern as the sweep tests above): the re-apply is
    // debounced by a real 50 ms timer, and a fixed real-time wait only
    // leaves ~30 ms of slack — too little on a loaded CI runner.
    vi.useFakeTimers();
    try {
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
      await vi.advanceTimersByTimeAsync(100);

      expect(editor.setDecorations).toHaveBeenCalled();
      const ranges = editor.setDecorations.mock.calls.at(-1)![1] as unknown[];
      expect(ranges).toEqual([]);
      controller.dispose();
    } finally {
      vi.useRealTimers();
    }
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

  it('prefers an explicit line number over a non-empty selection elsewhere', async () => {
    // Right-clicking a line number while a stale selection exists must anchor
    // the comment on the clicked line, not on the selection range.
    const controller = new PullReviewCommentController(createConfig(), { fsPath: '/ext' } as never);
    const editor = {
      document: makeDocument(false),
      selection: {
        isEmpty: false,
        start: { line: 0, character: 0 },
        end: { line: 1, character: 5 },
        active: { line: 1 },
      },
    };

    await controller.addComment(editor as never, 2);

    const context = panelState.createOrShow.mock.calls[0][2] as { lineNumber: number; extraLinesCount?: number };
    expect(context.lineNumber).toBe(2);
    expect(context.extraLinesCount).toBeUndefined();
    controller.dispose();
  });

  it('accepts a two-line selection inside one hunk', async () => {
    // The reported scenario: two lines selected inside the changed hunk of a PR
    // diff (head lines 2 and 3, 1-based, of `DIFF`), invoked through the editor
    // context menu, which passes no line number. Both lines are in the diff's
    // table, so the comment must open with the range anchored on the first line
    // and `extra_lines_count` = 1 — not be refused.
    vi.mocked(vscode.window.showErrorMessage).mockClear();
    const controller = new PullReviewCommentController(createConfig(), { fsPath: '/ext' } as never);
    const editor = {
      document: makeDocument(false),
      selection: {
        isEmpty: false,
        start: { line: 1, character: 4 },
        end: { line: 2, character: 6 },
        active: { line: 2 },
      },
    };

    await controller.addComment(editor as never);

    expect(vscode.window.showErrorMessage).not.toHaveBeenCalled();
    expect(panelState.createOrShow).toHaveBeenCalledTimes(1);
    const context = panelState.createOrShow.mock.calls[0][2] as {
      lineNumber: number;
      position: number;
      extraLinesCount?: number;
    };
    expect(context.lineNumber).toBe(1);
    expect(context.position).toBe(2);
    expect(context.extraLinesCount).toBe(1);
    controller.dispose();
  });

  it('still refuses a line that is not in the pull request diff at all', async () => {
    // The refused line is the anchor itself, so there is nothing to name beyond
    // the blanket refusal (an empty selection: a caret on a line the diff does
    // not contain, for example a file with no hunks for that path).
    vi.mocked(vscode.window.showErrorMessage).mockClear();
    const controller = new PullReviewCommentController(createConfig(), { fsPath: '/ext' } as never);
    const editor = {
      document: makeDocument(false),
      selection: {
        isEmpty: true,
        start: { line: 9, character: 0 },
        end: { line: 9, character: 0 },
        active: { line: 9 },
      },
    };

    await controller.addComment(editor as never);

    expect(panelState.createOrShow).not.toHaveBeenCalled();
    expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
      'Comments can only be added to lines within the pull request diff',
    );
    controller.dispose();
  });

  it('rejects a selection whose last line is outside the pull request diff, naming it', async () => {
    // Only the range's last line falls outside the hunk; the anchor line (0) is
    // commentable. The blanket "lines within the pull request diff" reads as
    // "your first line was wrong" while the caret sat on a changed line, so the
    // refusal names the line that is actually out of range — 1-based, as the
    // editor shows it, and the range stays refused.
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
    expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
      expect.stringContaining('reaches line 10, which is outside the pull request diff'),
    );
    controller.dispose();
  });

  it('surfaces a failed review-comment load instead of showing no comments', async () => {
    // Offline, a revoked token or a rate limit makes the review fetch fail. The
    // controller used to log and return, so the diff opened with zero threads
    // and the user believed nobody had commented on it.
    state.diffError = new Error('network down');
    vi.mocked(vscode.window.showErrorMessage).mockClear();
    const controller = new PullReviewCommentController(createConfig(), { fsPath: '/ext' } as never);
    const openDocument = state.openHandlers[0];

    try {
      await openDocument(makeDocument(false));

      expect(threadCount(controller)).toBe(0);
      expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
        expect.stringContaining('Could not load the review comments'),
      );
    } finally {
      state.diffError = null;
      controller.dispose();
    }
  });

  it('does not report an error when the file simply has no comments', async () => {
    state.comments = [];
    vi.mocked(vscode.window.showErrorMessage).mockClear();
    const controller = new PullReviewCommentController(createConfig(), { fsPath: '/ext' } as never);
    const openDocument = state.openHandlers[0];

    await openDocument(makeDocument(false));

    expect(threadCount(controller)).toBe(0);
    expect(vscode.window.showErrorMessage).not.toHaveBeenCalled();
    controller.dispose();
  });

  it('reports a failed diff load instead of returning silently', async () => {
    // Offline, an expired token or a deleted PR makes the diff fetch fail. The
    // command used to log and return, so the click produced no panel, no toast
    // and no hint about what went wrong.
    state.diffError = new Error('network down');
    const controller = new PullReviewCommentController(createConfig(), { fsPath: '/ext' } as never);
    const editor = {
      document: makeDocument(false),
      selection: {
        isEmpty: true,
        start: { line: 0, character: 0 },
        end: { line: 0, character: 0 },
        active: { line: 0 },
      },
    };
    vi.mocked(vscode.window.showErrorMessage).mockClear();

    try {
      await controller.addComment(editor as never);

      expect(panelState.createOrShow).not.toHaveBeenCalled();
      expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(expect.stringContaining('pull request diff'));
    } finally {
      state.diffError = null;
      controller.dispose();
    }
  });
});

describe('PullReviewCommentController strict URI parsing', () => {
  beforeEach(() => {
    state.createdThreads.length = 0;
    state.openHandlers.length = 0;
    state.diffFetches = 0;
    panelState.createOrShow.mockClear();
    vi.mocked(vscode.window.showWarningMessage).mockClear();
    vi.mocked(vscode.window.showErrorMessage).mockClear();
  });

  it('ignores a forgejo-pr document whose URI carries no usable ref', async () => {
    // The old fallback parsed a missing/empty ref as the default branch, so
    // threads were rendered — and comments anchored — against content the URI
    // never named. Strict parsing treats the document as not ours: no fetch,
    // no threads.
    const controller = new PullReviewCommentController(createConfig(), { fsPath: '/ext' } as never);
    const openDocument = state.openHandlers[0];

    await openDocument(makeDocument(false, { ref: '' }));

    expect(state.diffFetches).toBe(0);
    expect(threadCount(controller)).toBe(0);
    expect(vscode.window.showErrorMessage).not.toHaveBeenCalled();
    controller.dispose();
  });

  it('warns in addComment instead of acting on an unparseable PR diff URI', async () => {
    // The command used to proceed with the fallback parse (PR 0, default
    // branch); it must refuse with the same "no PR diff file" notice any
    // non-PR editor gets.
    const controller = new PullReviewCommentController(createConfig(), { fsPath: '/ext' } as never);
    const editor = {
      document: makeDocument(false, { ref: '' }),
      selection: {
        isEmpty: true,
        start: { line: 0, character: 0 },
        end: { line: 0, character: 0 },
        active: { line: 0 },
      },
    };

    await controller.addComment(editor as never);

    expect(vscode.window.showWarningMessage).toHaveBeenCalledWith(
      expect.stringContaining('No Forgejo PR diff file is active'),
    );
    expect(panelState.createOrShow).not.toHaveBeenCalled();
    expect(state.diffFetches).toBe(0);
    controller.dispose();
  });
});

describe('PullReviewCommentController review data cache lifetime', () => {
  beforeEach(() => {
    state.createdThreads.length = 0;
    state.openHandlers.length = 0;
    state.diffFetches = 0;
  });

  type CacheInternals = { _reviewDataCache: { size: number; byteSize(): number } };

  it('releases the cached diffs when the controller is disposed', async () => {
    // The controller lives as long as the extension host and holds parsed diffs
    // of every pull request opened; without clearing on dispose, several MiB per
    // large patch stay reachable even though no document can use them again.
    const controller = new PullReviewCommentController(createConfig(), { fsPath: '/ext' } as never);
    const openDocument = state.openHandlers[0];

    await openDocument(makeDocument(false));

    const cache = (controller as unknown as CacheInternals)._reviewDataCache;
    expect(cache.size).toBe(1);
    expect(cache.byteSize()).toBeGreaterThan(0);

    controller.dispose();

    expect(cache.size).toBe(0);
    expect(cache.byteSize()).toBe(0);
  });
});

/**
 * The review list can reach the shared 500-item cap, and one review's comments
 * need one request each: an unbounded fan-out opened hundreds of concurrent
 * authenticated requests per load, and a failed one dropped the review from the
 * data the panel and addComment read.
 */
describe('PullReviewCommentController review comments fan-out', () => {
  type FetchInternals = {
    _fetchReviewData(params: { instanceId: string; owner: string; repo: string; index: number }): Promise<{
      reviews: Array<{ review: { id?: number }; comments: unknown[]; incomplete?: boolean }>;
      incompleteReviewIds: number[];
    }>;
  };

  const PARAMS = { instanceId: INSTANCE_ID, owner: 'owner', repo: 'repo', index: 2 };

  beforeEach(() => {
    state.createdThreads.length = 0;
    state.openHandlers.length = 0;
    state.editorHandlers.length = 0;
    state.diffFetches = 0;
    state.failedReviewIds = [];
    state.commentsRequests = [];
    state.peakCommentsInFlight = 0;
    state.commentsInFlight = 0;
    state.commentsGate = null;
    state.comments = null;
    state.listReviews = null;
    panelState.createOrShow.mockClear();
    vi.mocked(vscode.window.showWarningMessage).mockClear();
  });

  function reviewList(count: number) {
    return Array.from({ length: count }, (_, index) => ({
      id: index + 1,
      state: 'COMMENTED',
      user: { login: 'user' },
    }));
  }

  it('bounds the per-review comment requests to a small pool', async () => {
    // 30 reviews -> 30 requests, but never more than the pool at a time. With no
    // non-macrotask way to observe an in-flight window, the gate is what makes
    // the cap observable: only a bounded number of requests can start while the
    // first batch is blocked. Before the cap, all 30 started at once.
    state.listReviews = reviewList(30);
    const gate = createGate();
    state.commentsGate = gate;
    const controller = new PullReviewCommentController(createConfig(), { fsPath: '/ext' } as never);
    const internals = controller as unknown as FetchInternals;

    try {
      const load = internals._fetchReviewData(PARAMS);
      // Let the first batch of requests reach the gate.
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();

      const startedWhileBlocked = state.commentsRequests.length;
      const dataAfterFirstBatch = state.peakCommentsInFlight;
      gate.resolve();
      state.commentsGate = null;
      const data = await load;

      // Every review is still fetched exactly once...
      expect(state.commentsRequests).toHaveLength(30);
      expect(new Set(state.commentsRequests).size).toBe(30);
      expect(dataAfterFirstBatch).toBe(4);
      expect(startedWhileBlocked).toBe(4);
      // ...and the full result survives the pool.
      expect(data.reviews).toHaveLength(30);
      expect(state.peakCommentsInFlight).toBe(4);
    } finally {
      gate.resolve();
      state.commentsGate = null;
      controller.dispose();
    }
  });

  it('keeps a review whose comments failed to load instead of dropping it', async () => {
    state.listReviews = [
      { id: 10, state: 'COMMENTED', user: { login: 'reviewer' } },
      { id: 11, state: 'PENDING', user: { login: 'user' } },
    ];
    state.failedReviewIds = [11];
    const controller = new PullReviewCommentController(createConfig(), { fsPath: '/ext' } as never);

    try {
      const data = await (controller as unknown as FetchInternals)._fetchReviewData(PARAMS);

      // The failed review must not vanish: its state and author are what the
      // panel and addComment read.
      expect(data.reviews.map((entry) => entry.review.id)).toEqual([10, 11]);
      const failed = data.reviews.find((entry) => entry.review.id === 11);
      expect(failed?.incomplete).toBe(true);
      expect(failed?.comments).toEqual([]);
      expect(data.incompleteReviewIds).toEqual([11]);
    } finally {
      controller.dispose();
    }
  });

  it('reports an incomplete review load and still shows the file', async () => {
    state.listReviews = [
      { id: 10, state: 'COMMENTED', user: { login: 'reviewer' } },
      { id: 11, state: 'PENDING', user: { login: 'user' } },
    ];
    state.failedReviewIds = [11];
    const controller = new PullReviewCommentController(createConfig(), { fsPath: '/ext' } as never);
    const openDocument = state.openHandlers[0];
    const shown = vi.mocked(vscode.window.showWarningMessage);

    try {
      await openDocument(makeDocument(false));

      expect(shown).toHaveBeenCalledWith(expect.stringContaining('Some reviews could not be loaded'));
      expect(shown.mock.calls[0][0]).toContain('11');
    } finally {
      controller.dispose();
    }
  });

  it('warns about an incomplete review load only once while the data stays cached', async () => {
    // `_loadAndRender` re-runs for every focus change and for every document
    // opened, and the 15 s cache answers those re-enters. A warning per render
    // therefore re-toasted one transient failure once per document and on every
    // focus change between the two sides of a diff.
    state.listReviews = [
      { id: 10, state: 'COMMENTED', user: { login: 'reviewer' } },
      { id: 11, state: 'PENDING', user: { login: 'user' } },
    ];
    state.failedReviewIds = [11];
    const controller = new PullReviewCommentController(createConfig(), { fsPath: '/ext' } as never);
    const openDocument = state.openHandlers[0];
    const activeEditor = state.editorHandlers[0];
    const shown = vi.mocked(vscode.window.showWarningMessage);

    try {
      await openDocument(makeDocument(false));
      expect(shown).toHaveBeenCalledTimes(1);

      // The other side of the diff: the cache answers, the fetch count does not
      // move, and the warning is not replayed.
      const fetchesAfterFirst = state.diffFetches;
      await openDocument(makeDocument(true));
      expect(state.diffFetches).toBe(fetchesAfterFirst);

      // A plain focus change re-enters the same path.
      activeEditor({ document: makeDocument(false) });
      await flushUntil(() => threadCount(controller) > 0);

      expect(shown).toHaveBeenCalledTimes(1);
    } finally {
      controller.dispose();
    }
  });

  it('warns again for a different pull request whose failing review shares an id', async () => {
    // Review ids are per-pull-request sequences, so review 11 here is not the
    // review 11 that failed in the other pull request. Fingerprinting them
    // without the pull request swallowed the second warning entirely.
    state.listReviews = [
      { id: 10, state: 'COMMENTED', user: { login: 'reviewer' } },
      { id: 11, state: 'PENDING', user: { login: 'user' } },
    ];
    state.failedReviewIds = [11];
    const controller = new PullReviewCommentController(createConfig(), { fsPath: '/ext' } as never);
    const openDocument = state.openHandlers[0];
    const shown = vi.mocked(vscode.window.showWarningMessage);

    try {
      await openDocument(makeDocument(false));
      expect(shown).toHaveBeenCalledTimes(1);

      // A different pull request of the same repository, whose failing review
      // carries the same per-PR id.
      await openDocument(makeDocument(false, { index: 3 }));

      expect(shown).toHaveBeenCalledTimes(2);
      expect(shown.mock.calls[1][0]).toContain('11');
    } finally {
      controller.dispose();
    }
  });

  it('warns again when the same reviews fail after a complete load recovered', async () => {
    vi.useFakeTimers();
    try {
      state.listReviews = [
        { id: 10, state: 'COMMENTED', user: { login: 'reviewer' } },
        { id: 11, state: 'PENDING', user: { login: 'user' } },
      ];
      state.failedReviewIds = [11];
      const controller = new PullReviewCommentController(createConfig(), { fsPath: '/ext' } as never);
      const openDocument = state.openHandlers[0];
      const shown = vi.mocked(vscode.window.showWarningMessage);

      await openDocument(makeDocument(false));
      expect(shown).toHaveBeenCalledTimes(1);

      // The instance recovers: a re-fetch after the cache TTL loads every
      // review, so the remembered failure no longer describes the data.
      state.failedReviewIds = [];
      vi.setSystemTime(Date.now() + 60_000);
      await openDocument(makeDocument(false));
      expect(shown).toHaveBeenCalledTimes(1);

      // It fails again on the same review: this is a new failure and the user
      // must hear about it rather than be left with stale, silently hidden data.
      state.failedReviewIds = [11];
      vi.setSystemTime(Date.now() + 120_000);
      await openDocument(makeDocument(false));

      expect(shown).toHaveBeenCalledTimes(2);
      controller.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it('localizes the missing-instance failure instead of embedding the id raw', async () => {
    const controller = new PullReviewCommentController(createConfig(), { fsPath: '/ext' } as never);
    // Spying rather than only comparing the rendered text: the raw
    // concatenation renders the same string, so only the call itself proves the
    // message went through the translation seam (`vscode.l10n.t`) and not
    // through a template literal no bundle can reach.
    const translate = vi.spyOn(vscode.l10n, 't');

    try {
      const failure = await (
        controller as unknown as {
          _fetchReviewData(params: {
            instanceId: string;
            owner: string;
            repo: string;
            index: number;
          }): Promise<unknown>;
        }
      )
        ._fetchReviewData({ instanceId: 'gone-instance', owner: 'owner', repo: 'repo', index: 2 })
        .catch((error: unknown) => error);

      expect((failure as Error).message).toBe('Forgejo instance not found: gone-instance');
      expect(translate).toHaveBeenCalledWith('Forgejo instance not found: {0}', 'gone-instance');
    } finally {
      translate.mockRestore();
      controller.dispose();
    }
  });

  it('does not start a second review when the pending review failed to load', async () => {
    vi.useFakeTimers();
    try {
      // The bug: the dropped review left the pending-review lookup with nothing
      // to find, so addComment passed no `pendingReviewId` and the editor told
      // the user it would start a NEW review ("Review started…") even though one
      // was already pending. The load below is the one that counts: the cache's
      // TTL expires and the re-fetch is what fails.
      state.listReviews = [{ id: 11, state: 'PENDING', user: { login: 'user' } }];
      state.failedReviewIds = [11];
      state.comments = [];
      const controller = new PullReviewCommentController(createConfig(), { fsPath: '/ext' } as never);
      const editor = {
        document: makeDocument(false),
        selection: {
          isEmpty: true,
          start: { line: 2, character: 0 },
          end: { line: 2, character: 0 },
          active: { line: 2 },
        },
      };

      await controller.addComment(editor as never, 2);
      panelState.createOrShow.mockClear();
      // A pending review can have no comments yet; the review itself is the
      // only thing addComment needs from this list.
      state.comments = null;

      // Let the review-data cache expire so the next addComment re-fetches and
      // hits the failing comments request.
      vi.setSystemTime(Date.now() + 60_000);

      try {
        await controller.addComment(editor as never, 2);
      } finally {
        state.listReviews = null;
        state.failedReviewIds = [];
      }

      expect(panelState.createOrShow).toHaveBeenCalledTimes(1);
      const context = panelState.createOrShow.mock.calls[0][2] as { pendingReviewId?: number };
      expect(context.pendingReviewId).toBe(11);
      controller.dispose();
    } finally {
      vi.useRealTimers();
    }
  });
});

/**
 * A whole-load failure is never cached (`_loadReviewData` only stores successful
 * loads) and the in-flight map only coalesces while a fetch runs, so every
 * document render of the pull request re-fetches. Without the per-pull-request
 * fingerprint, each of those renders re-toasted the identical error — one toast
 * per open diff document, plus one per focus change.
 */
describe('PullReviewCommentController load-failure toast dedup', () => {
  beforeEach(() => {
    state.createdThreads.length = 0;
    state.openHandlers.length = 0;
    state.editorHandlers.length = 0;
    state.diffFetches = 0;
    state.diffError = null;
    vi.mocked(vscode.window.showErrorMessage).mockClear();
  });

  it('toasts a whole-load failure once per pull request while the failure persists', async () => {
    state.diffError = new Error('network down');
    const controller = new PullReviewCommentController(createConfig(), { fsPath: '/ext' } as never);
    const openDocument = state.openHandlers[0];
    const activeEditor = state.editorHandlers[0];
    const shown = vi.mocked(vscode.window.showErrorMessage);

    try {
      await openDocument(makeDocument(false));
      await openDocument(makeDocument(true));
      // A focus change re-enters the load path too.
      activeEditor({ document: makeDocument(false) });
      await flushUntil(() => state.diffFetches >= 3);

      // Every render re-fetched (nothing is cached), but the toast appeared once.
      expect(state.diffFetches).toBeGreaterThanOrEqual(3);
      expect(shown).toHaveBeenCalledTimes(1);
      expect(shown).toHaveBeenCalledWith(expect.stringContaining('Could not load the review comments'));
    } finally {
      state.diffError = null;
      controller.dispose();
    }
  });

  it('scopes the failure memory per pull request', async () => {
    state.diffError = new Error('network down');
    const controller = new PullReviewCommentController(createConfig(), { fsPath: '/ext' } as never);
    const openDocument = state.openHandlers[0];
    const shown = vi.mocked(vscode.window.showErrorMessage);

    try {
      await openDocument(makeDocument(false));
      expect(shown).toHaveBeenCalledTimes(1);

      // A different pull request failing with the same error has not been
      // reported yet: its toast must not be swallowed by the first one's.
      await openDocument(makeDocument(false, { index: 3 }));
      expect(shown).toHaveBeenCalledTimes(2);
    } finally {
      state.diffError = null;
      controller.dispose();
    }
  });

  it('toasts again when a different failure replaces the reported one', async () => {
    state.diffError = new Error('network down');
    const controller = new PullReviewCommentController(createConfig(), { fsPath: '/ext' } as never);
    const openDocument = state.openHandlers[0];
    const shown = vi.mocked(vscode.window.showErrorMessage);

    try {
      await openDocument(makeDocument(false));
      expect(shown).toHaveBeenCalledTimes(1);

      // A new fingerprint (e.g. the network recovered and the token is now the
      // problem) is a failure the user has not heard about.
      state.diffError = new Error('token expired');
      await openDocument(makeDocument(false));
      expect(shown).toHaveBeenCalledTimes(2);
    } finally {
      state.diffError = null;
      controller.dispose();
    }
  });

  it('toasts again after the load recovers and fails again', async () => {
    vi.useFakeTimers();
    try {
      state.diffError = new Error('network down');
      const controller = new PullReviewCommentController(createConfig(), { fsPath: '/ext' } as never);
      const openDocument = state.openHandlers[0];
      const shown = vi.mocked(vscode.window.showErrorMessage);

      await openDocument(makeDocument(false));
      expect(shown).toHaveBeenCalledTimes(1);

      // The instance recovers: the successful load clears the failure memory.
      state.diffError = null;
      await openDocument(makeDocument(false));
      expect(threadCount(controller)).toBeGreaterThan(0);

      // The same failure returns: it is a new failure after a recovery, and
      // the user must hear about it. The cache TTL has to expire first, or the
      // cached success would answer the re-render without a fetch.
      state.diffError = new Error('network down');
      vi.setSystemTime(Date.now() + 60_000);
      await openDocument(makeDocument(false));

      expect(shown).toHaveBeenCalledTimes(2);
      controller.dispose();
    } finally {
      state.diffError = null;
      vi.useRealTimers();
    }
  });
});

/**
 * The decoration sync used to be triggered by any document's visible ranges and
 * logged a line every time it painted at least one range. Since the re-apply
 * writes to the output channel, that line changed the output editor's own
 * visible ranges and re-triggered the sync that had written it: with
 * `forgejoToolkit.debug` on and one expanded multi-line thread, the channel
 * filled up on its own and clearing it started the loop again.
 */
describe('PullReviewCommentController range-decoration sync', () => {
  const MULTI_LINE_COMMENT = [
    { id: 201, path: 'src/index.ts', position: 2, original_position: 0, extra_lines_count: 3, body: 'multi' },
  ];

  beforeEach(() => {
    state.createdThreads.length = 0;
    state.openHandlers.length = 0;
    state.visibleEditors.length = 0;
    state.visibleRangesHandlers.length = 0;
    state.comments = null;
  });

  function internals(controller: PullReviewCommentController) {
    return controller as unknown as {
      _applyThreadRangeDecorations(): void;
      _shouldSyncDecorationsForDocument(document?: unknown): boolean;
    };
  }

  /** An editor that is not a PR document: the output channel, a comment input. */
  function outputEditor() {
    const uri = 'output:extension-output-forgejo-toolkit';
    return {
      document: { uri: { scheme: 'output', toString: () => uri } },
      setDecorations: vi.fn(),
    };
  }

  function fireVisibleRangeChange(editor: unknown) {
    for (const handler of state.visibleRangesHandlers) {
      handler({ textEditor: { document: (editor as { document: unknown }).document } });
    }
  }

  it('logs the per-editor detail once while the computed detail is unchanged', async () => {
    vi.useFakeTimers();
    try {
      state.comments = MULTI_LINE_COMMENT;
      const editor = { document: makeDocument(false), setDecorations: vi.fn() };
      state.visibleEditors.push(editor);
      const debug = vi.fn();
      const controller = new PullReviewCommentController(
        createConfig(),
        { fsPath: '/ext' } as never,
        {
          debug,
          info: vi.fn(),
          error: vi.fn(),
        } as never,
      );
      const openDocument = state.openHandlers[0];
      await openDocument(makeDocument(false));

      // The first paint carries the diagnostic value the line was added for.
      expect(debug).toHaveBeenCalledTimes(1);
      expect(debug.mock.calls[0][0]).toContain('Thread range decorations applied per visible editor:');
      expect(debug.mock.calls[0][0]).toContain('=1');

      // Identical re-applications — the visible-ranges debounce this very
      // output used to retrigger — must stay silent.
      internals(controller)._applyThreadRangeDecorations();
      internals(controller)._applyThreadRangeDecorations();

      expect(debug).toHaveBeenCalledTimes(1);
      controller.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it('logs again when the computed detail genuinely changes', async () => {
    vi.useFakeTimers();
    try {
      state.comments = MULTI_LINE_COMMENT;
      const editor = { document: makeDocument(false), setDecorations: vi.fn() };
      state.visibleEditors.push(editor);
      const debug = vi.fn();
      const controller = new PullReviewCommentController(
        createConfig(),
        { fsPath: '/ext' } as never,
        {
          debug,
          info: vi.fn(),
          error: vi.fn(),
        } as never,
      );
      const openDocument = state.openHandlers[0];
      await openDocument(makeDocument(false));
      expect(debug).toHaveBeenCalledTimes(1);

      // A new visible editor changes the detail; the user reproducing a
      // "highlight misses lines" report needs to see the updated counts.
      state.visibleEditors.push(outputEditor());
      internals(controller)._applyThreadRangeDecorations();

      expect(debug).toHaveBeenCalledTimes(2);
      expect(debug.mock.calls[1][0]).toContain('=1');
      expect(debug.mock.calls[1][0]).toContain('=0');
      controller.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not schedule decoration work for a visible-range change on a document it does not decorate', async () => {
    vi.useFakeTimers();
    try {
      state.comments = MULTI_LINE_COMMENT;
      const editor = { document: makeDocument(false), setDecorations: vi.fn() };
      state.visibleEditors.push(editor);
      const controller = new PullReviewCommentController(createConfig(), { fsPath: '/ext' } as never);
      const openDocument = state.openHandlers[0];
      await openDocument(makeDocument(false));
      editor.setDecorations.mockClear();

      const output = outputEditor();
      expect(internals(controller)._shouldSyncDecorationsForDocument(output.document)).toBe(false);
      // Collapsing the only multi-line thread would change the painted ranges,
      // so a scheduled sync could not be silently skipped as identical: the
      // event must be filtered out before the timer is ever armed.
      state.createdThreads[0].collapsibleState = 0;
      fireVisibleRangeChange(output);
      await vi.advanceTimersByTimeAsync(500);

      // Neither the debounced timer nor an immediate re-apply ran: the output
      // panel's own visible-range changes (the debug line landing in it) can no
      // longer drive the decoration sync.
      expect(editor.setDecorations).not.toHaveBeenCalled();

      // A PR document whose visible ranges changed still syncs: that is how a
      // user-initiated collapse/expand reaches the controller at all.
      expect(internals(controller)._shouldSyncDecorationsForDocument(editor.document)).toBe(true);
      fireVisibleRangeChange(editor);
      await vi.advanceTimersByTimeAsync(500);
      expect(editor.setDecorations).toHaveBeenCalledTimes(1);
      expect(editor.setDecorations.mock.calls[0][1]).toEqual([]);
      controller.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not call setDecorations again while the computed range set is unchanged', async () => {
    vi.useFakeTimers();
    try {
      state.comments = MULTI_LINE_COMMENT;
      const editor = { document: makeDocument(false), setDecorations: vi.fn() };
      state.visibleEditors.push(editor);
      const controller = new PullReviewCommentController(createConfig(), { fsPath: '/ext' } as never);
      const openDocument = state.openHandlers[0];
      await openDocument(makeDocument(false));
      expect(editor.setDecorations).toHaveBeenCalledTimes(1);

      internals(controller)._applyThreadRangeDecorations();

      expect(editor.setDecorations).toHaveBeenCalledTimes(1);
      controller.dispose();
    } finally {
      vi.useRealTimers();
    }
  });
});

/**
 * A reply is a comment on a comment — conversation, not review content. Forgejo
 * has no reply object, so a reply carries a quote of the comment it answers. Our
 * reply goes through the issue-comment endpoint (timeline comment, no review
 * submitted) with the platform's own attribution line and `> ` quoting, but
 * writes the reply text first so the instance home feed — which stores a body's
 * first line — shows the user's own words (see `reviewReply.test.ts` for that
 * order). VS Code's
 * Comments tab shows our threads but the reply button only exists when
 * `canReply` is set, and a submitted reply arrives as the
 * `comments/commentThread/context` command's argument — there is no other hook.
 * These tests drive that command the way the workbench does.
 */
describe('PullReviewCommentController replies', () => {
  const REVIEWED = [
    {
      id: 101,
      path: 'src/index.ts',
      position: 2,
      original_position: 0,
      body: 'first line\nsecond line',
      user: { login: 'reviewer' },
    },
  ];

  beforeEach(() => {
    state.createdThreads.length = 0;
    state.openHandlers.length = 0;
    state.closeHandlers.length = 0;
    state.editorHandlers.length = 0;
    state.visibleEditors.length = 0;
    state.comments = REVIEWED;
    state.listReviews = null;
    state.failedReviewIds = [];
    state.commentsRequests = [];
    state.pendingReviewId = null;
    state.issueComments = [];
    state.issueCommentError = null;
    state.reviewWrites = [];
    state.registeredCommands.clear();
    state.diffError = null;
    panelState.createOrShow.mockClear();
    vi.mocked(vscode.window.showErrorMessage).mockClear();
    vi.mocked(vscode.window.showWarningMessage).mockClear();
    vi.mocked(vscode.window.showInformationMessage).mockClear();
  });

  /** The reply command the controller registered, as the workbench invokes it. */
  function replyCommand() {
    const handler = state.registeredCommands.get('forgejoToolkit.replyToPullReviewComment');
    expect(handler).toBeDefined();
    return handler as (reply: unknown) => Promise<unknown>;
  }

  /** The local echoes a thread carries, in the order they appear. */
  function echoedComments(thread: { comments: unknown[] }) {
    return (
      thread.comments as Array<{
        body: { value: string };
        mode: number;
        label?: string;
        contextValue?: string;
        author: { name: string };
      }>
    ).filter((comment) => comment.contextValue?.startsWith('forgejo-timeline-reply:') === true);
  }

  /** The reviews a refresh reloads; the mock answers them from `state`. */
  function refresh(controller: PullReviewCommentController): Promise<void> {
    return controller.refreshPullRequestComments({
      instanceId: INSTANCE_ID,
      owner: 'owner',
      repo: 'repo',
      index: 2,
    });
  }

  it('allows replies on every thread it creates', async () => {
    const controller = new PullReviewCommentController(createConfig(), { fsPath: '/ext' } as never);
    const openDocument = state.openHandlers[0];

    await openDocument(makeDocument(false));

    expect(state.createdThreads).toHaveLength(1);
    expect(state.createdThreads[0].canReply).toBe(true);
    controller.dispose();
  });

  it('posts the reply as a quoted issue comment on the pull request', async () => {
    // The body is the platform's own pieces in our own order (see
    // `reviewReply.ts`): the reply text first, a blank line, the attribution line
    // linking the original comment, a blank line, then the quoted comment marked
    // line by line. Reply-first is what puts the user's words on the body's first
    // line, which is the part Forgejo's instance home activity feed stores and
    // renders. The endpoint is the issue/PR comment one, so the reply is a
    // timeline comment: immediately visible, and no review is created or
    // submitted.
    const controller = new PullReviewCommentController(createConfig(), { fsPath: '/ext' } as never);
    const openDocument = state.openHandlers[0];
    await openDocument(makeDocument(false));
    const thread = state.createdThreads[0];

    await replyCommand()({ thread, text: '111' });

    expect(state.issueComments).toEqual([
      {
        owner: 'owner',
        repo: 'repo',
        index: 2,
        body: [
          '111',
          '',
          '@reviewer wrote in https://forgejo.example.com/owner/repo/pulls/2/files#issuecomment-101:',
          '',
          '> first line',
          '> second line',
        ].join('\n'),
      },
    ]);
    // The property the instance home feed depends on: the body starts with the
    // reply, not with the quote or the attribution line.
    expect(state.issueComments[0].body.split('\n')[0]).toBe('111');
    expect(state.issueComments[0].body.endsWith('> first line\n> second line')).toBe(true);
    // Nothing went into the pending review: the reply is not review content.
    expect(state.reviewWrites).toEqual([]);
    expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(
      'Reply posted as a comment on the pull request timeline.',
    );
    controller.dispose();
  });

  it('posts a reply that starts with blank lines with the text as the body first line', async () => {
    // The reply box only refuses a text that is empty after trimming, so a text
    // starting with newlines reaches the post. The feed's excerpt is the body's
    // first line, and an empty one renders a row with no text at all, so the
    // leading blank lines must not survive into the body.
    const controller = new PullReviewCommentController(createConfig(), { fsPath: '/ext' } as never);
    const openDocument = state.openHandlers[0];
    await openDocument(makeDocument(false));

    await replyCommand()({ thread: state.createdThreads[0], text: '\n\nhello' });

    const [body] = state.issueComments.map((comment) => comment.body);
    expect(body.split('\n')[0]).toBe('hello');
    expect(body.startsWith('\n')).toBe(false);
    expect(body).toBe(
      [
        'hello',
        '',
        '@reviewer wrote in https://forgejo.example.com/owner/repo/pulls/2/files#issuecomment-101:',
        '',
        '> first line',
        '> second line',
      ].join('\n'),
    );
    controller.dispose();
  });

  it('puts a multi-line reply first, with its own first line as the body first line', async () => {
    // A reply is free text and often several lines. The excerpting consumer takes
    // the top of the body, so the first line must be the first line the user
    // typed — not a quote, and not the reply's later lines.
    const controller = new PullReviewCommentController(createConfig(), { fsPath: '/ext' } as never);
    const openDocument = state.openHandlers[0];
    await openDocument(makeDocument(false));

    await replyCommand()({ thread: state.createdThreads[0], text: 'first line of the reply\nsecond line' });

    const [body] = state.issueComments.map((comment) => comment.body);
    expect(body.split('\n')[0]).toBe('first line of the reply');
    expect(body.split('\n')[1]).toBe('second line');
    expect(body.split('\n')[2]).toBe('');
    // The quoted block is unchanged and still closes the body.
    expect(body.endsWith('> first line\n> second line')).toBe(true);
    expect(body).toContain(
      '@reviewer wrote in https://forgejo.example.com/owner/repo/pulls/2/files#issuecomment-101:\n\n> first line',
    );
    controller.dispose();
  });

  it('echoes the posted reply into the thread as a read-only timeline comment', async () => {
    // The reply is a timeline comment, so the review API never returns it and
    // the thread would otherwise show nothing after a successful post. The echo
    // is the posted body unchanged plus a marker saying where the text lives.
    const controller = new PullReviewCommentController(createConfig(), { fsPath: '/ext' } as never);
    const openDocument = state.openHandlers[0];
    await openDocument(makeDocument(false));
    const thread = state.createdThreads[0];
    const serverComment = thread.comments[0];

    await replyCommand()({ thread, text: '111' });

    expect(thread.comments).toHaveLength(2);
    // After the server comment it answers, never before it.
    expect(thread.comments[0]).toBe(serverComment);
    const [echo] = echoedComments(thread);
    expect(echo).toBeDefined();
    // The body is exactly what the POST sent — reply first, quote block included.
    expect(echo.body.value).toBe(state.issueComments[0].body);
    expect(echo.body.value).toBe(
      [
        '111',
        '',
        '@reviewer wrote in https://forgejo.example.com/owner/repo/pulls/2/files#issuecomment-101:',
        '',
        '> first line',
        '> second line',
      ].join('\n'),
    );
    // Read-only, and marked so nobody mistakes it for a server review comment.
    expect(echo.mode).toBe(vscode.CommentMode.Preview);
    expect(echo.label).toBe('Posted to the pull request timeline');
    expect(echo.contextValue).toBe('forgejo-timeline-reply:0');
    expect(echo.author.name).toBe('user');
    // Never registered as one of the server's comments: no context, so the
    // comment cannot be edited, deleted or quoted as review content.
    expect(controller.getCommentContext(echo.contextValue as string)).toBeUndefined();
    expect((controller as unknown as { _commentContextMap: Map<string, unknown> })._commentContextMap.size).toBe(1);
    controller.dispose();
  });

  it('quotes the server comment, not the earlier echo, when replying twice', async () => {
    // The echo carries a contextValue so it can be recognised; treating it as
    // the comment being answered would quote our own local copy back and hide
    // which server comment the reply belongs to.
    const controller = new PullReviewCommentController(createConfig(), { fsPath: '/ext' } as never);
    const openDocument = state.openHandlers[0];
    await openDocument(makeDocument(false));
    const thread = state.createdThreads[0];

    await replyCommand()({ thread, text: 'first reply' });
    await replyCommand()({ thread, text: 'second reply' });

    expect(state.issueComments).toHaveLength(2);
    // The newest reply opens the body; the quote it carries is the server
    // comment's, and never our own earlier echo.
    expect(state.issueComments[1].body.split('\n')[0]).toBe('second reply');
    expect(state.issueComments[1].body).toContain('> first line');
    expect(state.issueComments[1].body).not.toContain('first reply');
    expect(echoedComments(thread)).toHaveLength(2);
    expect(vscode.window.showErrorMessage).not.toHaveBeenCalled();
    controller.dispose();
  });

  it('re-applies the echo after a refresh without duplicating it', async () => {
    const controller = new PullReviewCommentController(createConfig(), { fsPath: '/ext' } as never);
    const openDocument = state.openHandlers[0];
    const document = makeDocument(false);
    await openDocument(document);
    const thread = state.createdThreads[0];

    await replyCommand()({ thread, text: '111' });
    const postedBody = state.issueComments[0].body;
    expect(echoedComments(thread)).toHaveLength(1);

    // The refresh path the PR detail page and every mutation use: reload the
    // reviews and re-render every open document of the pull request. The
    // threads are rebuilt from review data, which never carries the reply.
    const textDocuments = (vscode.workspace as unknown as { textDocuments: unknown[] }).textDocuments;
    textDocuments.push(document);
    try {
      await refresh(controller);
      await refresh(controller);
    } finally {
      textDocuments.length = 0;
    }

    expect(thread.dispose).not.toHaveBeenCalled();
    expect(thread.comments).toHaveLength(2);
    const echoes = echoedComments(thread);
    expect(echoes).toHaveLength(1);
    expect(echoes[0].body.value).toBe(postedBody);
    expect(echoes[0].contextValue).toBe('forgejo-timeline-reply:0');
    controller.dispose();
  });

  it('re-applies the echo when the thread is rebuilt from scratch', async () => {
    const controller = new PullReviewCommentController(createConfig(), { fsPath: '/ext' } as never);
    const openDocument = state.openHandlers[0];
    const closeDocument = state.closeHandlers[0];
    const document = makeDocument(false);
    await openDocument(document);
    const thread = state.createdThreads[0];

    await replyCommand()({ thread, text: '111' });
    const postedBody = state.issueComments[0].body;

    // Closing the document disposes the thread; re-opening it rebuilds a new
    // one from review data. The echo has to come back with it.
    closeDocument(document);
    expect(thread.dispose).toHaveBeenCalled();
    await openDocument(document);

    const rebuilt = state.createdThreads[1];
    expect(rebuilt).not.toBe(thread);
    const echoes = echoedComments(rebuilt);
    expect(echoes).toHaveLength(1);
    expect(echoes[0].body.value).toBe(postedBody);
    controller.dispose();
  });

  it('never re-posts or writes anything when the echo is re-applied', async () => {
    // The echo is local-only: a refresh re-renders threads, not the timeline,
    // and must not send the remembered reply anywhere or touch a review.
    const controller = new PullReviewCommentController(createConfig(), { fsPath: '/ext' } as never);
    const openDocument = state.openHandlers[0];
    const document = makeDocument(false);
    await openDocument(document);
    const thread = state.createdThreads[0];

    await replyCommand()({ thread, text: '111' });
    expect(state.issueComments).toHaveLength(1);

    const textDocuments = (vscode.workspace as unknown as { textDocuments: unknown[] }).textDocuments;
    textDocuments.push(document);
    try {
      await refresh(controller);
    } finally {
      textDocuments.length = 0;
    }

    // Still exactly the one POST the user submitted, and no review write.
    expect(state.issueComments).toHaveLength(1);
    expect(state.reviewWrites).toEqual([]);
    expect(echoedComments(thread)).toHaveLength(1);
    controller.dispose();
  });

  it("keeps two threads' echoes apart", async () => {
    // Two anchors in one file are two threads; each remembers its own replies,
    // and a refresh re-applies each thread's own echo only.
    state.comments = [
      { id: 201, path: 'src/index.ts', position: 2, original_position: 0, body: 'note a', user: { login: 'reviewer' } },
      { id: 202, path: 'src/index.ts', position: 3, original_position: 0, body: 'note b', user: { login: 'reviewer' } },
    ];
    const controller = new PullReviewCommentController(createConfig(), { fsPath: '/ext' } as never);
    const openDocument = state.openHandlers[0];
    const document = makeDocument(false);
    await openDocument(document);
    expect(state.createdThreads).toHaveLength(2);
    const [firstThread, secondThread] = state.createdThreads;

    await replyCommand()({ thread: firstThread, text: 'answer to a' });
    await replyCommand()({ thread: secondThread, text: 'answer to b' });

    expect(echoedComments(firstThread)).toHaveLength(1);
    expect(echoedComments(secondThread)).toHaveLength(1);
    // Each body starts with its own reply, whichever thread it belongs to.
    expect(echoedComments(firstThread)[0].body.value.split('\n')[0]).toBe('answer to a');
    expect(echoedComments(secondThread)[0].body.value.split('\n')[0]).toBe('answer to b');
    expect(echoedComments(firstThread)[0].body.value).not.toContain('answer to b');

    const textDocuments = (vscode.workspace as unknown as { textDocuments: unknown[] }).textDocuments;
    textDocuments.push(document);
    try {
      await refresh(controller);
    } finally {
      textDocuments.length = 0;
    }

    expect(echoedComments(firstThread)).toHaveLength(1);
    expect(echoedComments(secondThread)).toHaveLength(1);
    expect(echoedComments(firstThread)[0].body.value.split('\n')[0]).toBe('answer to a');
    expect(echoedComments(secondThread)[0].body.value.split('\n')[0]).toBe('answer to b');
    controller.dispose();
  });

  it('leaves an existing pending review untouched', async () => {
    // Forgejo allows one pending review per user and pull request. The reply is
    // a timeline comment, so even with a draft in progress it must not append
    // to it (which used to hide the reply until the user submitted the review)
    // and must not start a second one.
    state.listReviews = [{ id: 10, state: 'COMMENTED', user: { login: 'reviewer' } }];
    state.pendingReviewId = 77;
    const controller = new PullReviewCommentController(createConfig(), { fsPath: '/ext' } as never);
    const openDocument = state.openHandlers[0];
    await openDocument(makeDocument(false));

    await replyCommand()({ thread: state.createdThreads[0], text: 'agreed' });

    expect(state.issueComments).toHaveLength(1);
    expect(state.issueComments[0].body).toContain('agreed');
    expect(state.reviewWrites).toEqual([]);
    controller.dispose();
  });

  it('revalidates a multi-line anchor range before posting', async () => {
    // The range the thread covers is part of the revalidation: `position` and
    // `extra_lines_count` must both still be lines of the diff, so a range whose
    // tail left the diff is refused rather than truncated. The fixture's head
    // side ends at line 4, so a range of 2..5 no longer fits.
    state.comments = [{ id: 102, path: 'src/index.ts', position: 2, extra_lines_count: 3, body: 'range' }];
    const controller = new PullReviewCommentController(createConfig(), { fsPath: '/ext' } as never);
    const openDocument = state.openHandlers[0];
    await openDocument(makeDocument(false));

    await replyCommand()({ thread: state.createdThreads[0], text: 'ok' });

    expect(state.issueComments).toEqual([]);
    expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
      'This comment is no longer on a line within the pull request diff, so the reply was not posted',
    );
    controller.dispose();
  });

  it('posts when the whole anchor range is still inside the diff', async () => {
    // The positive half of the range revalidation: a multi-line thread whose
    // lines all still exist must go through, so the guard above cannot pass by
    // refusing every ranged anchor.
    state.comments = [
      {
        id: 105,
        path: 'src/index.ts',
        position: 2,
        extra_lines_count: 1,
        body: 'range',
        user: { login: 'reviewer' },
      },
    ];
    const controller = new PullReviewCommentController(createConfig(), { fsPath: '/ext' } as never);
    const openDocument = state.openHandlers[0];
    await openDocument(makeDocument(false));

    await replyCommand()({ thread: state.createdThreads[0], text: 'ok' });

    expect(state.issueComments).toHaveLength(1);
    expect(state.issueComments[0].body).toContain('@reviewer wrote in');
    expect(vscode.window.showErrorMessage).not.toHaveBeenCalled();
    controller.dispose();
  });

  it('revalidates a base-side anchor against the base side of the diff', async () => {
    // The side the thread carries decides which line table is checked: a
    // base-side anchor is validated against the base file's lines, so a line
    // that only exists on the head side is refused.
    state.comments = [{ id: 103, path: 'src/index.ts', position: 0, original_position: 9, body: 'base' }];
    const controller = new PullReviewCommentController(createConfig(), { fsPath: '/ext' } as never);
    const openDocument = state.openHandlers[0];
    await openDocument(makeDocument(true));

    await replyCommand()({ thread: state.createdThreads[0], text: 'ok' });

    expect(state.issueComments).toEqual([]);
    expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
      'This comment is no longer on a line within the pull request diff, so the reply was not posted',
    );
    controller.dispose();
  });

  it('surfaces a failed POST, leaves no comment that looks posted and appends no echo', async () => {
    const controller = new PullReviewCommentController(createConfig(), { fsPath: '/ext' } as never);
    const openDocument = state.openHandlers[0];
    await openDocument(makeDocument(false));
    const thread = state.createdThreads[0];
    const commentsBefore = [...(thread.comments as unknown[])];
    state.issueCommentError = new Error('offline');

    await replyCommand()({ thread, text: 'never lands' });

    expect(vscode.window.showErrorMessage).toHaveBeenCalledWith('Could not post the reply: offline');
    expect(vscode.window.showInformationMessage).not.toHaveBeenCalled();
    expect(state.issueComments).toEqual([]);
    expect(state.reviewWrites).toEqual([]);
    // The thread keeps exactly what it had: the input still holds the reply,
    // nothing was appended to it as if the post had succeeded, and no echo was
    // remembered (a failed POST must not leave a phantom comment).
    expect(thread.comments).toEqual(commentsBefore);
    expect(echoedComments(thread)).toHaveLength(0);
    controller.dispose();
  });

  it('refuses an anchor that is no longer on a diff line', async () => {
    // The comment leaves the diff (a force-push, or a line that was rolled
    // back): the reply must be refused, never relocated to a nearby line.
    //
    // The guard is over the thread's *anchor*, not over the comment's presence:
    // `replyToComment` revalidates the thread's encoded path/line/side against
    // the diff's own line tables, so the stale line is what has to be the one
    // outside them. The fixture's head side ends at line 4, so line 9 is a line
    // the diff no longer carries (the render still shows the thread: it only
    // checks that the line exists in the document).
    state.comments = [{ id: 104, path: 'src/index.ts', position: 9, original_position: 0, body: 'stale anchor' }];
    const controller = new PullReviewCommentController(createConfig(), { fsPath: '/ext' } as never);
    const openDocument = state.openHandlers[0];
    await openDocument(makeDocument(false));
    const thread = state.createdThreads[0];

    await replyCommand()({ thread, text: 'hello' });

    expect(state.issueComments).toEqual([]);
    expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
      'This comment is no longer on a line within the pull request diff, so the reply was not posted',
    );
    controller.dispose();
  });

  it('ignores a reply submitted with an empty body', async () => {
    const controller = new PullReviewCommentController(createConfig(), { fsPath: '/ext' } as never);
    const openDocument = state.openHandlers[0];
    await openDocument(makeDocument(false));

    await replyCommand()({ thread: state.createdThreads[0], text: '   ' });

    expect(state.issueComments).toEqual([]);
    expect(state.reviewWrites).toEqual([]);
    expect(vscode.window.showErrorMessage).not.toHaveBeenCalled();
    controller.dispose();
  });

  it('ignores a thread that is not one of ours', async () => {
    const controller = new PullReviewCommentController(createConfig(), { fsPath: '/ext' } as never);
    await replyCommand()({ thread: { contextValue: 'someone-elses-thread', comments: [] }, text: 'hi' });

    expect(state.issueComments).toEqual([]);
    expect(vscode.window.showErrorMessage).not.toHaveBeenCalled();
    controller.dispose();
  });

  it('does not require the AI pre-review switch to reply', async () => {
    // A reply is the user's own action, not the AI feature: the AI settings are
    // off (the config manager exposes none) and the reply must still go out.
    const controller = new PullReviewCommentController(createConfig(), { fsPath: '/ext' } as never);
    const openDocument = state.openHandlers[0];
    await openDocument(makeDocument(false));

    await replyCommand()({ thread: state.createdThreads[0], text: 'manual' });

    expect(state.issueComments).toHaveLength(1);
    // Reply-first: the user's own words open the body, with the quote after them.
    expect(state.issueComments[0].body.split('\n')[0]).toBe('manual');
    expect(state.issueComments[0].body).toContain('\n\n@reviewer wrote in');
    controller.dispose();
  });
});
