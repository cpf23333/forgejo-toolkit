import { describe, it, expect, vi, afterEach } from 'vitest';
import * as vscode from 'vscode';
import {
  PullReviewCommentPanel,
  type PullReviewCommentContext,
  type PullReviewCommentPanelCallbacks,
} from '../pullReviewCommentPanel';
import type { ConfigManager } from '../../config';

function createFakePanel() {
  return {
    title: '',
    webview: {
      html: '',
      postMessage: vi.fn(),
      onDidReceiveMessage: vi.fn(() => ({ dispose: vi.fn() })),
    },
    onDidDispose: vi.fn(() => ({ dispose: vi.fn() })),
    reveal: vi.fn(),
    dispose: vi.fn(),
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
    expect(PullReviewCommentPanel.currentPanel).toBe(panel);
  });

  it('updates context, callbacks and title when reusing the current panel', () => {
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
    expect(fakePanel.reveal).toHaveBeenCalledTimes(1);

    const internals = panelInternals(panel);
    expect(internals._context.index).toBe(3);
    expect(internals._context.path).toBe('src/other.ts');
    // The reused panel must not keep the previous pull request's closures.
    expect(internals._callbacks).toBe(newCallbacks);
    expect(fakePanel.title).toBe('src/other.ts:5');
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
});
