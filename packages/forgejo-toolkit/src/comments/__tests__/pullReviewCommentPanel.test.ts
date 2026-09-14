import { describe, it, expect, vi, afterEach } from 'vitest';
import * as vscode from 'vscode';

const clientMocks = vi.hoisted(() => ({
  createPendingPullReview: vi.fn(
    async (_owner: string, _repo: string, _index: number, _comment: Record<string, unknown>) => ({ id: 42 }),
  ),
  addPullReviewComment: vi.fn(async () => ({})),
}));
vi.mock('../../api/client', () => ({
  ForgejoClient: class {
    createPendingPullReview = clientMocks.createPendingPullReview;
    addPullReviewComment = clientMocks.addPullReviewComment;
  },
}));

import {
  PullReviewCommentPanel,
  type PullReviewCommentContext,
  type PullReviewCommentPanelCallbacks,
} from '../pullReviewCommentPanel';
import type { ConfigManager } from '../../config';

function createFakePanel() {
  const handlers: Array<(message: unknown) => unknown> = [];
  return {
    title: '',
    webview: {
      html: '',
      postMessage: vi.fn(),
      onDidReceiveMessage: vi.fn((handler: (message: unknown) => unknown) => {
        handlers.push(handler);
        return { dispose: vi.fn() };
      }),
    },
    onDidDispose: vi.fn(() => ({ dispose: vi.fn() })),
    reveal: vi.fn(),
    dispose: vi.fn(),
    // Simulate the webview answering back (draft-state replies, requests).
    receive: (message: unknown) => {
      for (const handler of handlers) {
        void handler(message);
      }
    },
  };
}

function createContext(overrides?: Partial<PullReviewCommentContext>): PullReviewCommentContext {
  return {
    instanceId: 'demo',
    owner: 'demo-user',
    repo: 'demo-repo',
    index: 2,
    path: 'src/index.ts',
    position: 2,
    isBase: false,
    lineNumber: 1,
    mode: 'review',
    ...overrides,
  };
}

function createConfig(): ConfigManager {
  return { getInstances: vi.fn(() => []) } as unknown as ConfigManager;
}

function panelInternals(panel: PullReviewCommentPanel): {
  _context: PullReviewCommentContext;
  _callbacks?: PullReviewCommentPanelCallbacks;
} {
  return panel as unknown as {
    _context: PullReviewCommentContext;
    _callbacks?: PullReviewCommentPanelCallbacks;
  };
}

describe('PullReviewCommentPanel.createOrShow', () => {
  afterEach(() => {
    PullReviewCommentPanel.currentPanel = undefined;
    vi.clearAllMocks();
  });

  it('creates a new panel when none is open', () => {
    const fakePanel = createFakePanel();
    vi.mocked(vscode.window.createWebviewPanel).mockReturnValue(fakePanel as unknown as vscode.WebviewPanel);

    const panel = PullReviewCommentPanel.createOrShow(
      vscode.Uri.file('/ext') as vscode.Uri,
      createConfig(),
      createContext(),
    );

    expect(vscode.window.createWebviewPanel).toHaveBeenCalledTimes(1);
    // Opens beside the diff editor instead of covering it.
    expect(vscode.window.createWebviewPanel).toHaveBeenCalledWith(
      PullReviewCommentPanel.viewType,
      expect.any(String),
      vscode.ViewColumn.Beside,
      expect.any(Object),
    );
    expect(PullReviewCommentPanel.currentPanel).toBe(panel);
  });

  it('updates context, callbacks and title when reusing the current panel', async () => {
    const fakePanel = createFakePanel();
    vi.mocked(vscode.window.createWebviewPanel).mockReturnValue(fakePanel as unknown as vscode.WebviewPanel);

    const oldCallbacks: PullReviewCommentPanelCallbacks = { onSubmitted: vi.fn() };
    const newCallbacks: PullReviewCommentPanelCallbacks = { onSubmitted: vi.fn() };

    const panel = PullReviewCommentPanel.createOrShow(
      vscode.Uri.file('/ext') as vscode.Uri,
      createConfig(),
      createContext(),
      oldCallbacks,
    );
    const reused = PullReviewCommentPanel.createOrShow(
      vscode.Uri.file('/ext') as vscode.Uri,
      createConfig(),
      createContext({ index: 3, path: 'src/other.ts', lineNumber: 4 }),
      newCallbacks,
    );

    expect(reused).toBe(panel);
    expect(vscode.window.createWebviewPanel).toHaveBeenCalledTimes(1);
    // reveal() without a column keeps the panel where the user left it.
    expect(fakePanel.reveal).toHaveBeenCalledTimes(1);
    expect(fakePanel.reveal).toHaveBeenCalledWith();

    // A context switch is guarded by a draft check: the panel asks the
    // webview whether the current editor holds an unsubmitted draft. The
    // guard runs in a microtask chain, so let it post the query first.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(fakePanel.webview.postMessage).toHaveBeenCalledWith({ command: 'queryPullReviewCommentDraft' });
    fakePanel.receive({ command: 'pullReviewCommentDraftState', dirty: false });
    await vi.waitFor(() => {
      expect(panelInternals(panel)._context.index).toBe(3);
    });

    const internals = panelInternals(panel);
    expect(internals._context.path).toBe('src/other.ts');
    // The reused panel must not keep the previous pull request's closures.
    expect(internals._callbacks).toBe(newCallbacks);
    expect(fakePanel.title).toBe('src/other.ts:5');
    // A clean editor switches without asking the user.
    expect(vscode.window.showWarningMessage).not.toHaveBeenCalled();
  });

  it('switches context without prompting when the webview reports no draft', async () => {
    const fakePanel = createFakePanel();
    vi.mocked(vscode.window.createWebviewPanel).mockReturnValue(fakePanel as unknown as vscode.WebviewPanel);

    const panel = PullReviewCommentPanel.createOrShow(
      vscode.Uri.file('/ext') as vscode.Uri,
      createConfig(),
      createContext(),
    );
    PullReviewCommentPanel.createOrShow(
      vscode.Uri.file('/ext') as vscode.Uri,
      createConfig(),
      createContext({ lineNumber: 9 }),
    );

    await new Promise((resolve) => setTimeout(resolve, 0));
    fakePanel.receive({ command: 'pullReviewCommentDraftState', dirty: false });
    await vi.waitFor(() => {
      expect(panelInternals(panel)._context.lineNumber).toBe(9);
    });
    expect(vscode.window.showWarningMessage).not.toHaveBeenCalled();
  });

  it('asks for confirmation and switches when the user discards the draft', async () => {
    const fakePanel = createFakePanel();
    vi.mocked(vscode.window.createWebviewPanel).mockReturnValue(fakePanel as unknown as vscode.WebviewPanel);
    vi.mocked(vscode.window.showWarningMessage).mockResolvedValue('Discard Draft' as never);

    const panel = PullReviewCommentPanel.createOrShow(
      vscode.Uri.file('/ext') as vscode.Uri,
      createConfig(),
      createContext(),
    );
    PullReviewCommentPanel.createOrShow(
      vscode.Uri.file('/ext') as vscode.Uri,
      createConfig(),
      createContext({ lineNumber: 9 }),
    );

    await new Promise((resolve) => setTimeout(resolve, 0));
    fakePanel.receive({ command: 'pullReviewCommentDraftState', dirty: true });
    await vi.waitFor(() => {
      expect(panelInternals(panel)._context.lineNumber).toBe(9);
    });
    expect(vscode.window.showWarningMessage).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ modal: true }),
      'Discard Draft',
    );
  });

  it('keeps the old context and draft when the user declines the discard', async () => {
    const fakePanel = createFakePanel();
    vi.mocked(vscode.window.createWebviewPanel).mockReturnValue(fakePanel as unknown as vscode.WebviewPanel);
    vi.mocked(vscode.window.showWarningMessage).mockResolvedValue(undefined as never);

    const panel = PullReviewCommentPanel.createOrShow(
      vscode.Uri.file('/ext') as vscode.Uri,
      createConfig(),
      createContext(),
    );
    PullReviewCommentPanel.createOrShow(
      vscode.Uri.file('/ext') as vscode.Uri,
      createConfig(),
      createContext({ lineNumber: 9 }),
    );

    await new Promise((resolve) => setTimeout(resolve, 0));
    fakePanel.receive({ command: 'pullReviewCommentDraftState', dirty: true });
    // Let the guard chain settle; the context must stay on the original line.
    await vi.waitFor(() => {
      expect(vscode.window.showWarningMessage).toHaveBeenCalled();
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(panelInternals(panel)._context.lineNumber).toBe(1);
    // The declined switch never re-titles the panel for the new line.
    expect(fakePanel.title).not.toBe('src/index.ts:10');
  });

  it('clears stale callbacks when the reuse caller passes none', () => {
    const fakePanel = createFakePanel();
    vi.mocked(vscode.window.createWebviewPanel).mockReturnValue(fakePanel as unknown as vscode.WebviewPanel);

    const panel = PullReviewCommentPanel.createOrShow(
      vscode.Uri.file('/ext') as vscode.Uri,
      createConfig(),
      createContext(),
      { onSubmitted: vi.fn() },
    );
    PullReviewCommentPanel.createOrShow(vscode.Uri.file('/ext') as vscode.Uri, createConfig(), createContext());

    expect(panelInternals(panel)._callbacks).toBeUndefined();
  });

  it('answers deletePullReview with cancelled when the user declines the confirmation', async () => {
    const fakePanel = createFakePanel();
    let messageHandler: ((message: unknown) => Promise<void>) | undefined;
    fakePanel.webview.onDidReceiveMessage = vi.fn((...args: unknown[]) => {
      messageHandler = args[0] as (message: unknown) => Promise<void>;
      return { dispose: vi.fn() };
    });
    vi.mocked(vscode.window.createWebviewPanel).mockReturnValue(fakePanel as unknown as vscode.WebviewPanel);
    // Declining the modal confirm resolves with undefined.
    vi.mocked(vscode.window.showWarningMessage).mockResolvedValue(undefined as never);

    PullReviewCommentPanel.createOrShow(vscode.Uri.file('/ext') as vscode.Uri, createConfig(), createContext());
    await messageHandler?.({ command: 'deletePullReview', reviewId: 5 });

    // The webview waits for this reply to reset its loading state; without it
    // a declined confirm would wedge the cancel button forever.
    expect(fakePanel.webview.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ command: 'pullReviewDeleted', cancelled: true }),
    );
  });
});

describe('PullReviewCommentPanel multi-line comments', () => {
  afterEach(() => {
    PullReviewCommentPanel.currentPanel = undefined;
    vi.clearAllMocks();
  });

  function createConfigWithInstance(): ConfigManager {
    return {
      getInstances: () => [
        { id: 'demo', url: 'https://forgejo.example.com', token: 't', name: 'Demo', username: 'demo-user' },
      ],
    } as unknown as ConfigManager;
  }

  it('shows the line range in the panel title', () => {
    const fakePanel = createFakePanel();
    vi.mocked(vscode.window.createWebviewPanel).mockReturnValue(fakePanel as unknown as vscode.WebviewPanel);

    PullReviewCommentPanel.createOrShow(
      vscode.Uri.file('/ext') as vscode.Uri,
      createConfig(),
      createContext({ lineNumber: 1, position: 2, extraLinesCount: 3 }),
    );

    expect(vscode.window.createWebviewPanel).toHaveBeenCalledWith(
      PullReviewCommentPanel.viewType,
      'src/index.ts:2-5',
      vscode.ViewColumn.Beside,
      expect.any(Object),
    );
  });

  it('submits extra_lines_count for a multi-line comment', async () => {
    const fakePanel = createFakePanel();
    let messageHandler: ((message: unknown) => Promise<void>) | undefined;
    fakePanel.webview.onDidReceiveMessage = vi.fn((...args: unknown[]) => {
      messageHandler = args[0] as (message: unknown) => Promise<void>;
      return { dispose: vi.fn() };
    });
    vi.mocked(vscode.window.createWebviewPanel).mockReturnValue(fakePanel as unknown as vscode.WebviewPanel);

    PullReviewCommentPanel.createOrShow(
      vscode.Uri.file('/ext') as vscode.Uri,
      createConfigWithInstance(),
      createContext({ lineNumber: 1, position: 2, extraLinesCount: 3 }),
    );
    await messageHandler?.({ command: 'submitPullReviewComment', body: 'looks off', mode: 'review' });

    expect(clientMocks.createPendingPullReview).toHaveBeenCalledWith(
      'demo-user',
      'demo-repo',
      2,
      expect.objectContaining({ new_position: 2, extra_lines_count: 3 }),
    );
  });

  it('omits extra_lines_count for a single-line comment', async () => {
    const fakePanel = createFakePanel();
    let messageHandler: ((message: unknown) => Promise<void>) | undefined;
    fakePanel.webview.onDidReceiveMessage = vi.fn((...args: unknown[]) => {
      messageHandler = args[0] as (message: unknown) => Promise<void>;
      return { dispose: vi.fn() };
    });
    vi.mocked(vscode.window.createWebviewPanel).mockReturnValue(fakePanel as unknown as vscode.WebviewPanel);

    PullReviewCommentPanel.createOrShow(
      vscode.Uri.file('/ext') as vscode.Uri,
      createConfigWithInstance(),
      createContext(),
    );
    await messageHandler?.({ command: 'submitPullReviewComment', body: 'single', mode: 'review' });

    const comment = clientMocks.createPendingPullReview.mock.calls[0]![3];
    expect(comment.extra_lines_count).toBeUndefined();
  });
});
