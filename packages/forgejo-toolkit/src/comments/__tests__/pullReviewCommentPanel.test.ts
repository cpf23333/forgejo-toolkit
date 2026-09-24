import { describe, it, expect, vi, afterEach } from 'vitest';
import * as vscode from 'vscode';

const clientMocks = vi.hoisted(() => ({
  createPendingPullReview: vi.fn(
    async (_owner: string, _repo: string, _index: number, _comment: Record<string, unknown>) => ({ id: 42 }),
  ),
  addPullReviewComment: vi.fn(async () => ({})),
  deletePullReview: vi.fn(async () => ({})),
  renderMarkdown: vi.fn(async (text: string) => `<p>${text}</p>`),
  searchMentions: vi.fn(async () => ({ users: [{ value: 'alice' }], issues: [{ value: '#1' }] })),
}));
vi.mock('../../api/client', () => ({
  // resolveAttachmentImages reads this constant, and the panel renders markdown
  // through it: without the export the attachment fetch would build
  // `AbortSignal.timeout(undefined)` and silently skip inlining.
  API_REQUEST_TIMEOUT_MS: 30_000,
  ForgejoClient: class {
    constructor(url: string) {
      // Mirror the real client: its constructor resolves the configured origin
      // and therefore throws for a URL that is not absolute, which
      // `config.ts`/`instanceImport.ts` accept unvalidated.
      new URL(url.replace(/\/$/, ''));
    }
    createPendingPullReview = clientMocks.createPendingPullReview;
    addPullReviewComment = clientMocks.addPullReviewComment;
    deletePullReview = clientMocks.deletePullReview;
    renderMarkdown = clientMocks.renderMarkdown;
    searchMentions = clientMocks.searchMentions;
  },
}));

import {
  PullReviewCommentPanel,
  type PullReviewCommentContext,
  type PullReviewCommentPanelCallbacks,
} from '../pullReviewCommentPanel';
import type { ConfigManager, ForgejoInstance } from '../../config';

function createFakePanel() {
  const handlers: Array<(message: unknown) => unknown> = [];
  const disposeHandlers: Array<() => void> = [];
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
    // The real panel is disposed from the outside (`panel.dispose()`), which
    // fires the registered callback; the fake has to do the same so `_dispose`
    // cleanup is observable.
    onDidDispose: vi.fn((handler: () => void) => {
      disposeHandlers.push(handler);
      return { dispose: vi.fn() };
    }),
    reveal: vi.fn(),
    dispose: vi.fn(() => {
      for (const handler of disposeHandlers) {
        handler();
      }
    }),
    // Simulate the webview answering back (draft-state replies, requests).
    receive: (message: unknown) => {
      for (const handler of handlers) {
        void handler(message);
      }
    },
    // A request from the webview reaches the panel's dispatcher, which is the
    // first handler the panel registers. `receive` above fans a message out to
    // every listener instead, which is what a pending draft-state query — it
    // registers its own listener — has to see.
    send: (message: unknown) => handlers[0]?.(message),
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
  return {
    getInstances: vi.fn(() => []),
    onInstancesChanged: vi.fn(() => ({ dispose: vi.fn() })),
  } as unknown as ConfigManager;
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

  it('recovers the switch chain after a failed switch so later switches still run', async () => {
    const fakePanel = createFakePanel();
    vi.mocked(vscode.window.createWebviewPanel).mockReturnValue(fakePanel as unknown as vscode.WebviewPanel);
    // The confirmation prompt throws on the first switch.
    vi.mocked(vscode.window.showWarningMessage).mockRejectedValueOnce(new Error('modal failed') as never);

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
      expect(vscode.window.showWarningMessage).toHaveBeenCalled();
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    // The failed switch keeps the old context.
    expect(panelInternals(panel)._context.lineNumber).toBe(1);

    // A later switch must not be swallowed by the previously rejected chain.
    PullReviewCommentPanel.createOrShow(
      vscode.Uri.file('/ext') as vscode.Uri,
      createConfig(),
      createContext({ lineNumber: 20 }),
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    fakePanel.receive({ command: 'pullReviewCommentDraftState', dirty: false });
    await vi.waitFor(() => {
      expect(panelInternals(panel)._context.lineNumber).toBe(20);
    });
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

describe('PullReviewCommentPanel shared-composable requests', () => {
  afterEach(() => {
    PullReviewCommentPanel.currentPanel = undefined;
    vi.clearAllMocks();
  });

  function configWithInstance(url = 'https://forgejo.example.com'): ConfigManager {
    return {
      getInstances: () => [
        {
          id: 'demo',
          url,
          token: 'secret-token',
          name: 'Demo',
          username: 'demo-user',
        },
      ],
      onInstancesChanged: () => ({ dispose: () => {} }),
    } as unknown as ConfigManager;
  }

  function openPanel(instanceUrl = 'https://forgejo.example.com', callbacks?: PullReviewCommentPanelCallbacks) {
    const fakePanel = createFakePanel();
    vi.mocked(vscode.window.createWebviewPanel).mockReturnValue(fakePanel as unknown as vscode.WebviewPanel);
    const panel = PullReviewCommentPanel.createOrShow(
      vscode.Uri.file('/ext') as vscode.Uri,
      configWithInstance(instanceUrl),
      createContext(),
      callbacks,
    );
    return { fakePanel, panel, send: (message: unknown) => fakePanel.send(message) };
  }

  /**
   * Reuse the open panel for another line/pull request the way the extension
   * does when the user opens a comment elsewhere, and let the draft-state guard
   * (the panel asks the webview before dropping an editor) settle.
   */
  async function switchTo(
    fakePanel: ReturnType<typeof createFakePanel>,
    panel: PullReviewCommentPanel,
    context: PullReviewCommentContext,
  ): Promise<void> {
    PullReviewCommentPanel.createOrShow(vscode.Uri.file('/ext') as vscode.Uri, configWithInstance(), context);
    await new Promise((resolve) => setTimeout(resolve, 0));
    fakePanel.receive({ command: 'pullReviewCommentDraftState', dirty: false });
    await vi.waitFor(() => {
      expect(panelInternals(panel)._context).toBe(context);
    });
  }

  /** Post the messages the host sent to the webview. */
  function postedMessages(fakePanel: ReturnType<typeof createFakePanel>): Array<Record<string, unknown>> {
    return fakePanel.webview.postMessage.mock.calls.map((call) => call[0] as Record<string, unknown>);
  }

  it('answers getInitialState so the shared composable can mount', async () => {
    const { fakePanel, send } = openPanel();
    await send({ command: 'getInitialState' });

    const reply = fakePanel.webview.postMessage.mock.calls
      .map((call) => call[0] as Record<string, unknown>)
      .find((message) => message.command === 'initialState');
    expect(reply).toBeDefined();
    // Tokens must never reach a webview: only the opaque fingerprint travels.
    expect(reply?.instances).toEqual([
      {
        id: 'demo',
        url: 'https://forgejo.example.com',
        // The credential-free twin the webview hands to git or the browser
        // (see `toPublicInstance`); this instance URL carries none, so it is the
        // stored URL unchanged.
        functionalUrl: 'https://forgejo.example.com',
        name: 'Demo',
        username: 'demo-user',
        tokenFingerprint: expect.stringMatching(/^[0-9a-f]+-\d+$/),
      },
    ]);
    expect(reply?.locale).toBe('en');
    // The editor panel has no worktree manager; inert defaults keep the
    // composable's state shape valid.
    expect(reply?.worktrees).toEqual([]);
  });

  it('answers getLinkedRepository with an empty result', async () => {
    const { fakePanel, send } = openPanel();
    await send({ command: 'getLinkedRepository' });
    expect(fakePanel.webview.postMessage).toHaveBeenCalledWith({ command: 'linkedRepository' });
  });

  it('renders markdown through the instance client', async () => {
    const { fakePanel, send } = openPanel();
    await send({ command: 'renderMarkdown', instanceId: 'demo', text: 'hi', _requestId: 'render-1' });

    expect(clientMocks.renderMarkdown).toHaveBeenCalledWith('hi', undefined);
    expect(fakePanel.webview.postMessage).toHaveBeenCalledWith({
      command: 'renderedMarkdown',
      _requestId: 'render-1',
      html: '<p>hi</p>',
    });
  });

  it('reports a renderMarkdown failure to the waiting request', async () => {
    clientMocks.renderMarkdown.mockRejectedValueOnce(new Error('boom'));
    const { fakePanel, send } = openPanel();
    await send({ command: 'renderMarkdown', instanceId: 'demo', text: 'hi', _requestId: 'render-2' });

    expect(fakePanel.webview.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ command: 'renderedMarkdown', _requestId: 'render-2', error: 'boom' }),
    );
  });

  it('inlines instance attachment images returned by the markdown API', async () => {
    const attachmentUrl = 'https://forgejo.example.com/attachments/11111111-2222-3333-4444-555555555555';
    clientMocks.renderMarkdown.mockResolvedValueOnce(`<p><img src="${attachmentUrl}"></p>`);
    const fetchMock = vi.fn(async () => ({
      ok: true,
      headers: new Headers({ 'content-type': 'image/png' }),
      arrayBuffer: async () => new Uint8Array([137, 80, 78, 71]).buffer,
    }));
    vi.stubGlobal('fetch', fetchMock);
    try {
      const { fakePanel, send } = openPanel();
      await send({ command: 'renderMarkdown', instanceId: 'demo', text: 'hi', _requestId: 'render-img' });

      // Fetched with the instance token, then inlined so the sandboxed webview
      // can render it without ever seeing the token.
      expect(fetchMock).toHaveBeenCalledWith(
        attachmentUrl,
        expect.objectContaining({ headers: { Authorization: 'token secret-token' } }),
      );
      const reply = fakePanel.webview.postMessage.mock.calls
        .map((call) => call[0] as Record<string, unknown>)
        .find((message) => message.command === 'renderedMarkdown' && message._requestId === 'render-img');
      expect(reply?.html).toContain('data:image/png;base64,');
      expect(reply?.html).not.toContain(attachmentUrl);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('searches mentions for the panel context', async () => {
    const { fakePanel, send } = openPanel();
    await send({ command: 'searchMentions', instanceId: 'demo', query: 'al', type: 'all', _requestId: 'mention-1' });

    expect(clientMocks.searchMentions).toHaveBeenCalledWith('demo-user', 'demo-repo', 'al', 'all');
    expect(fakePanel.webview.postMessage).toHaveBeenCalledWith({
      command: 'mentionSearchResult',
      _requestId: 'mention-1',
      users: [{ value: 'alice' }],
      issues: [{ value: '#1' }],
    });
  });

  it('answers unhandled request/response commands instead of dropping them', async () => {
    const { fakePanel, send } = openPanel();
    await send({ command: 'getRepoContents', instanceId: 'demo', _requestId: 'req-9' });

    expect(fakePanel.webview.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ command: 'requestError', _requestId: 'req-9' }),
    );
  });

  it('ignores a fire-and-forget command without logging an error', async () => {
    const { logger } = await import('../../logger');
    const errorSpy = vi.spyOn(logger, 'error');
    try {
      const { fakePanel, send } = openPanel();
      fakePanel.webview.postMessage.mockClear();

      // A shared-composable broadcast this panel does not implement: nobody is
      // waiting for an answer, so it must not be reported as a failure.
      await send({ command: 'getNotifications', instanceId: 'demo' });

      expect(errorSpy).not.toHaveBeenCalled();
      expect(fakePanel.webview.postMessage).not.toHaveBeenCalledWith(
        expect.objectContaining({ command: 'requestError' }),
      );
    } finally {
      errorSpy.mockRestore();
    }
  });

  it('rejects an attachment upload carrying a hostile repository name', async () => {
    const { fakePanel, send } = openPanel();
    clientMocks.searchMentions.mockClear();
    await send({
      command: 'createIssueAttachment',
      instanceId: 'demo',
      owner: 'demo-user',
      repo: 'x/../../admin/users',
      index: 2,
      name: 'shot.png',
      data: [1, 2, 3],
      _requestId: 'req-att',
    });

    // The guard runs before the handler, so no API client work happens and the
    // waiting request is answered instead of left pending.
    expect(fakePanel.webview.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ command: 'requestError', _requestId: 'req-att' }),
    );
    expect(fakePanel.webview.postMessage).not.toHaveBeenCalledWith(
      expect.objectContaining({ command: 'issueAttachmentCreated' }),
    );
  });

  it('rejects an attachment upload whose index is not a positive integer', async () => {
    // The index becomes a path segment of the upload route: '1/assets/../../releases/5'
    // would post the host's bytes to another same-origin endpoint.
    const { fakePanel, send } = openPanel();
    await send({
      command: 'createIssueAttachment',
      instanceId: 'demo',
      owner: 'demo-user',
      repo: 'demo-repo',
      index: '1/assets/../../releases/5',
      name: 'shot.png',
      data: [1, 2, 3],
      _requestId: 'req-att-index',
    });

    expect(fakePanel.webview.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        command: 'issueAttachmentCreated',
        _requestId: 'req-att-index',
        // Localized host error: the assertion names the l10n key instead of a
        // hardcoded English literal.
        error: vscode.l10n.t('Invalid attachment target'),
      }),
    );
  });

  it('localizes an empty comment body rejection', async () => {
    const { send } = openPanel();

    await send({ command: 'submitPullReviewComment', body: '   ', mode: 'single' });

    expect(vscode.l10n.t).toHaveBeenCalledWith('Empty comment body');
  });

  it('localizes an attachment target rejection', async () => {
    const { send } = openPanel();

    await send({
      command: 'createIssueAttachment',
      instanceId: 'demo',
      owner: 'demo-user',
      repo: 'demo-repo',
      index: '1/assets/../../releases/5',
      name: 'shot.png',
      data: [1, 2, 3],
      _requestId: 'req-l10n',
    });

    expect(vscode.l10n.t).toHaveBeenCalledWith('Invalid attachment target');
  });

  it('localizes a missing pending review rejection', async () => {
    const { send } = openPanel();

    await send({ command: 'submitPullReview', event: 'COMMENT' });

    expect(vscode.l10n.t).toHaveBeenCalledWith('No pending review');
  });

  it('rejects a mention search carrying a hostile owner', async () => {
    const { fakePanel, send } = openPanel();
    clientMocks.searchMentions.mockClear();
    await send({
      command: 'searchMentions',
      instanceId: 'demo',
      owner: '..',
      repo: 'demo-repo',
      query: 'al',
      type: 'all',
      _requestId: 'req-mention',
    });

    expect(clientMocks.searchMentions).not.toHaveBeenCalled();
    expect(fakePanel.webview.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ command: 'requestError', _requestId: 'req-mention' }),
    );
  });

  it('answers a throwing submit handler and never rejects the message promise', async () => {
    // An instance URL that is not absolute passes configuration unvalidated and
    // makes the ForgejoClient constructor throw. The dispatch promise must not
    // reject, and the editor has to receive its completion command — it clears
    // the `submitting` flag on that command only, so without the reply every
    // button stays disabled forever.
    const { fakePanel, send } = openPanel('forgejo.example.com');

    const dispatch = send({ command: 'submitPullReviewComment', body: 'hello', mode: 'single' });
    await expect(dispatch).resolves.toBeUndefined();

    expect(fakePanel.webview.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ command: 'pullReviewCommentSubmitted', error: expect.any(String) }),
    );
    expect(fakePanel.webview.postMessage).not.toHaveBeenCalledWith(
      expect.objectContaining({ command: 'requestError' }),
    );
  });

  it('answers a submit whose handler throws outside its own try block', async () => {
    // `_findInstance` runs before the handler's try/catch, so only the
    // dispatcher-level fallback can answer this one.
    let getInstancesCalls = 0;
    const config = {
      getInstances: () => {
        getInstancesCalls += 1;
        // The panel renders once while it is constructed; the handler's lookup
        // is the call that explodes.
        if (getInstancesCalls > 1) {
          throw new Error('storage exploded');
        }
        return [{ id: 'demo', url: 'https://forgejo.example.com', token: 't', name: 'Demo', username: 'demo-user' }];
      },
      onInstancesChanged: () => ({ dispose: () => {} }),
    } as unknown as ConfigManager;
    const fakePanel = createFakePanel();
    let messageHandler: ((message: unknown) => Promise<void>) | undefined;
    fakePanel.webview.onDidReceiveMessage = vi.fn((...args: unknown[]) => {
      messageHandler = args[0] as (message: unknown) => Promise<void>;
      return { dispose: vi.fn() };
    });
    vi.mocked(vscode.window.createWebviewPanel).mockReturnValue(fakePanel as unknown as vscode.WebviewPanel);
    PullReviewCommentPanel.createOrShow(vscode.Uri.file('/ext') as vscode.Uri, config, createContext());

    await expect(
      messageHandler?.({ command: 'submitPullReviewComment', body: 'hello', mode: 'single' }),
    ).resolves.toBeUndefined();

    expect(fakePanel.webview.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ command: 'pullReviewCommentSubmitted', error: expect.any(String) }),
    );
  });

  it('answers a throwing submitPullReview handler through pullReviewSubmitted', async () => {
    const { fakePanel, send } = openPanel('forgejo.example.com');

    await expect(send({ command: 'submitPullReview', reviewId: 5, event: 'COMMENT' })).resolves.toBeUndefined();

    expect(fakePanel.webview.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ command: 'pullReviewSubmitted', error: expect.any(String) }),
    );
  });

  it('answers a throwing deletePullReview handler through pullReviewDeleted', async () => {
    const { fakePanel, send } = openPanel('forgejo.example.com');
    // Earlier tests replace the shared mock's confirmation default, so the
    // accept path is queued explicitly.
    vi.mocked(vscode.window.showWarningMessage).mockResolvedValueOnce('Cancel Review' as never);

    await expect(send({ command: 'deletePullReview', reviewId: 5 })).resolves.toBeUndefined();

    expect(fakePanel.webview.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ command: 'pullReviewDeleted', error: expect.any(String) }),
    );
  });

  it('ignores malformed messages without rejecting the dispatch promise', async () => {
    const { fakePanel, send } = openPanel();
    fakePanel.webview.postMessage.mockClear();

    for (const message of [undefined, 'not-an-object', 42, { noCommand: true }]) {
      await expect(send(message)).resolves.toBeUndefined();
    }

    // Nothing to answer and nothing to report: these are not requests.
    expect(fakePanel.webview.postMessage).not.toHaveBeenCalled();
  });

  it('clears the draft-state query timer when the panel is disposed', async () => {
    vi.useFakeTimers();
    try {
      const fakePanel = createFakePanel();
      vi.mocked(vscode.window.createWebviewPanel).mockReturnValue(fakePanel as unknown as vscode.WebviewPanel);
      const panel = PullReviewCommentPanel.createOrShow(
        vscode.Uri.file('/ext') as vscode.Uri,
        configWithInstance(),
        createContext(),
      );
      // A context switch starts the draft-state query, which arms a 2 s timeout.
      PullReviewCommentPanel.createOrShow(
        vscode.Uri.file('/ext') as vscode.Uri,
        configWithInstance(),
        createContext({ lineNumber: 9 }),
      );
      await vi.advanceTimersByTimeAsync(1);
      expect(fakePanel.webview.postMessage).toHaveBeenCalledWith({ command: 'queryPullReviewCommentDraft' });
      expect(vi.getTimerCount()).toBe(1);

      panel.dispose();

      // The timeout must be gone: firing it later would post to a disposed
      // webview (and the query promise would never settle).
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('drops a reply whose request finished after the panel was disposed', async () => {
    // The submit handlers reply only after their network call resolves, so
    // closing the panel mid-request made `_reply` post to a disposed webview.
    // That post rejects, and the un-caught rejection surfaced in the extension
    // host as an unhandled rejection.
    const unhandled: unknown[] = [];
    const onUnhandledRejection = (reason: unknown) => {
      unhandled.push(reason);
    };
    process.on('unhandledRejection', onUnhandledRejection);
    try {
      const { fakePanel, panel, send } = openPanel();
      let finishSubmit!: () => void;
      const started = new Promise<void>((resolveStarted) => {
        clientMocks.createPendingPullReview.mockImplementationOnce(
          () =>
            new Promise((resolve) => {
              resolveStarted();
              finishSubmit = () => resolve({ id: 42 });
            }),
        );
      });

      const dispatch = send({ command: 'submitPullReviewComment', body: 'hello', mode: 'review' });
      await started;
      // A plain function, not a `vi.fn()`: Vitest attaches its own handler to a
      // mock's result, which would swallow the very rejection under test.
      const posted: unknown[] = [];
      (fakePanel.webview as unknown as { postMessage: unknown }).postMessage = (message: unknown) => {
        posted.push(message);
        // Posting to a disposed webview rejects; that rejection is the hazard.
        return Promise.reject(new Error('Webview is disposed'));
      };
      panel.dispose();

      finishSubmit();
      await expect(dispatch).resolves.toBeUndefined();
      // Give Node a turn to report an unhandled rejection.
      await new Promise((resolve) => setTimeout(resolve, 0));

      // The rejection is the hazard this guards against, so it comes first.
      expect(unhandled).toEqual([]);
      expect(posted).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandledRejection);
    }
  });

  it('does not query a disposed webview or arm a stale timer for a queued context switch', async () => {
    vi.useFakeTimers();
    try {
      const { fakePanel, panel } = openPanel();
      fakePanel.webview.postMessage.mockClear();
      const internals = panel as unknown as {
        _switchContext(context: PullReviewCommentContext): void;
      };

      // A context switch is queued on the switch chain; the panel is disposed
      // before the chained body runs. Asking the disposed webview about its
      // draft posted to it and armed a fresh 2 s timer that `_dispose` had
      // already walked past.
      internals._switchContext(createContext({ lineNumber: 9 }));
      panel.dispose();
      await vi.advanceTimersByTimeAsync(10);

      expect(fakePanel.webview.postMessage).not.toHaveBeenCalledWith({ command: 'queryPullReviewCommentDraft' });
      expect(vi.getTimerCount()).toBe(0);
      // The stale switch does not retitle the closed panel either.
      expect(panelInternals(panel)._context.lineNumber).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps a submit that resolves after a context switch on the context it started with', async () => {
    // The panel is a singleton: opening another comment while a submit is in
    // flight replaces the context (and rebuilds the editor). The reply, the
    // callbacks, the new review id and the panel close all belong to the editor
    // the request started from — reading the live context after the await
    // answered, notified and disposed the editor the user had just opened
    // (losing its text) and gave its review id to the wrong editor.
    const onSubmitted = vi.fn();
    const { fakePanel, panel, send } = openPanel('https://forgejo.example.com', { onSubmitted });
    const startingContext = panelInternals(panel)._context;

    // The first submit hangs until this test resolves it.
    let finishStartingSubmit!: () => void;
    const startingSubmitStarted = new Promise<void>((resolveStarted) => {
      clientMocks.createPendingPullReview.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveStarted();
            finishStartingSubmit = () => resolve({ id: 42 });
          }),
      );
    });
    const startingDispatch = send({ command: 'submitPullReviewComment', body: 'first', mode: 'review' });
    await startingSubmitStarted;

    // The user opens another line while the request is in flight.
    const newContext = createContext({ index: 3, path: 'src/other.ts', lineNumber: 4, pendingReviewId: 7 });
    await switchTo(fakePanel, panel, newContext);

    // The editor they just opened submits too: its own request is in flight
    // when the stale one settles.
    let finishNewSubmit!: () => void;
    const newSubmitStarted = new Promise<void>((resolveStarted) => {
      clientMocks.addPullReviewComment.mockImplementationOnce(
        () =>
          new Promise<object>((resolve) => {
            resolveStarted();
            finishNewSubmit = () => resolve({});
          }),
      );
    });
    const newDispatch = send({
      command: 'submitPullReviewComment',
      body: 'second',
      mode: 'review',
      pendingReviewId: 7,
    });
    await newSubmitStarted;
    fakePanel.webview.postMessage.mockClear();

    finishStartingSubmit();
    await expect(startingDispatch).resolves.toBeUndefined();

    // (a) The reply names the pull request the submit started with, not the one
    // on screen now.
    expect(fakePanel.webview.postMessage).toHaveBeenCalledWith({
      command: 'pullReviewCommentSubmitted',
      instanceId: 'demo',
      owner: 'demo-user',
      repo: 'demo-repo',
      index: 2,
    });
    // (c) The stale reply is attributed to the context it started with, so it
    // does not name the editor now on screen: the reply that names that context
    // follows only when its own request settles below.
    expect(
      postedMessages(fakePanel).filter(
        (message) => message.command === 'pullReviewCommentSubmitted' && message.index === 3,
      ),
    ).toEqual([]);
    expect(onSubmitted).not.toHaveBeenCalled();
    // (b) The editor the user opened keeps both its panel and its content.
    expect(fakePanel.dispose).not.toHaveBeenCalled();
    expect(PullReviewCommentPanel.currentPanel).toBe(panel);
    // (d) Its pending review is not rewritten with the review the stale request
    // created, and the context the request started with is left alone too.
    expect(newContext.pendingReviewId).toBe(7);
    expect(startingContext.pendingReviewId).toBeUndefined();
    expect(panelInternals(panel)._context).toBe(newContext);

    // The newcomer's own reply is the one that completes it.
    finishNewSubmit();
    await expect(newDispatch).resolves.toBeUndefined();
    expect(fakePanel.webview.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ command: 'pullReviewCommentSubmitted', index: 3 }),
    );
  });

  it('still disposes and notifies when the submit resolves for the context it started with', async () => {
    const onSubmitted = vi.fn();
    const { fakePanel, send } = openPanel('https://forgejo.example.com', { onSubmitted });

    await send({ command: 'submitPullReviewComment', body: 'hello', mode: 'review' });

    // The ordinary case is unchanged: reply, callback and close all belong to
    // the only context there is.
    expect(fakePanel.webview.postMessage).toHaveBeenCalledWith({
      command: 'pullReviewCommentSubmitted',
      instanceId: 'demo',
      owner: 'demo-user',
      repo: 'demo-repo',
      index: 2,
    });
    expect(onSubmitted).toHaveBeenCalledWith(expect.objectContaining({ index: 2 }));
    expect(fakePanel.dispose).toHaveBeenCalledTimes(1);
    expect(PullReviewCommentPanel.currentPanel).toBeUndefined();
    expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(
      'Review started. Add more comments via the line context menu, then submit the review.',
    );
  });

  it('keeps a delete that resolves after a context switch on the context it started with', async () => {
    const onDeleted = vi.fn();
    const { fakePanel, panel, send } = openPanel('https://forgejo.example.com', { onDeleted });

    // Hold the confirmation modal open, then the delete request itself.
    let confirmDelete!: (choice: unknown) => void;
    vi.mocked(vscode.window.showWarningMessage).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          confirmDelete = resolve;
        }) as never,
    );
    let finishDelete!: () => void;
    let deleteStarted!: () => void;
    const deleteStartedPromise = new Promise<void>((resolveStarted) => {
      deleteStarted = resolveStarted;
    });
    clientMocks.deletePullReview.mockImplementationOnce(
      () =>
        new Promise<object>((resolve) => {
          deleteStarted();
          finishDelete = () => resolve({});
        }),
    );
    const dispatch = send({ command: 'deletePullReview', reviewId: 5 });

    // The panel confirms the review of the pull request it was showing; the
    // user opens another comment while the modal is up.
    const newContext = createContext({ index: 3, path: 'src/other.ts', lineNumber: 4, pendingReviewId: 7 });
    await switchTo(fakePanel, panel, newContext);
    confirmDelete('Cancel Review');
    await deleteStartedPromise;
    fakePanel.webview.postMessage.mockClear();

    finishDelete();
    await expect(dispatch).resolves.toBeUndefined();

    // The request went to the pull request it started from — the awaited modal
    // must not let a switched context retarget the delete.
    expect(clientMocks.deletePullReview).toHaveBeenCalledWith('demo-user', 'demo-repo', 2, 5);
    expect(fakePanel.webview.postMessage).toHaveBeenCalledWith({
      command: 'pullReviewDeleted',
      instanceId: 'demo',
      owner: 'demo-user',
      repo: 'demo-repo',
      index: 2,
    });
    expect(onDeleted).not.toHaveBeenCalled();
    expect(fakePanel.dispose).not.toHaveBeenCalled();
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
      onInstancesChanged: () => ({ dispose: () => {} }),
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

describe('PullReviewCommentPanel instance lifecycle', () => {
  afterEach(() => {
    PullReviewCommentPanel.currentPanel = undefined;
    vi.clearAllMocks();
  });

  function demoInstance(url = 'https://forgejo.example.com'): ForgejoInstance {
    return { id: 'demo', url, token: 't', name: 'Demo', username: 'demo-user' };
  }

  /** A config whose instance list can be replaced and whose change event fires. */
  function instanceConfig(initial: ForgejoInstance[]): {
    config: ConfigManager;
    setInstances: (next: ForgejoInstance[]) => void;
    fireInstancesChanged: () => void;
  } {
    let current = initial;
    const listeners: Array<() => void> = [];
    const config = {
      getInstances: () => current,
      onInstancesChanged: (listener: () => void) => {
        listeners.push(listener);
        return { dispose: vi.fn() };
      },
    } as unknown as ConfigManager;
    return {
      config,
      setInstances: (next) => {
        current = next;
      },
      fireInstancesChanged: () => {
        for (const listener of listeners) {
          listener();
        }
      },
    };
  }

  function openPanel(config: ConfigManager) {
    const fakePanel = createFakePanel();
    vi.mocked(vscode.window.createWebviewPanel).mockReturnValue(fakePanel as unknown as vscode.WebviewPanel);
    const panel = PullReviewCommentPanel.createOrShow(vscode.Uri.file('/ext') as vscode.Uri, config, createContext());
    return { fakePanel, panel };
  }

  it('disposes the panel exactly once when its instance is removed', () => {
    const { config, setInstances, fireInstancesChanged } = instanceConfig([demoInstance()]);
    const { fakePanel } = openPanel(config);
    expect(fakePanel.dispose).not.toHaveBeenCalled();

    setInstances([]);
    fireInstancesChanged();
    // A repeated notification (another window writing the list, say) must not
    // dispose the panel a second time.
    fireInstancesChanged();

    expect(fakePanel.dispose).toHaveBeenCalledTimes(1);
    expect(PullReviewCommentPanel.currentPanel).toBeUndefined();
    expect(vscode.window.showWarningMessage).toHaveBeenCalledTimes(1);
    expect(vscode.l10n.t).toHaveBeenCalledWith(
      'The review comment editor was closed because its Forgejo instance was removed.',
    );
  });

  it('disposes the panel when its instance is repointed at another server', () => {
    const { config, setInstances, fireInstancesChanged } = instanceConfig([demoInstance()]);
    const { fakePanel } = openPanel(config);

    setInstances([demoInstance('https://other.example.com')]);
    fireInstancesChanged();

    expect(fakePanel.dispose).toHaveBeenCalledTimes(1);
    expect(vscode.l10n.t).toHaveBeenCalledWith(
      'The review comment editor was closed because its Forgejo instance now points to a different server.',
    );
  });

  it('keeps the panel open when the instance survives the change', () => {
    const { config, setInstances, fireInstancesChanged } = instanceConfig([demoInstance()]);
    const { fakePanel } = openPanel(config);

    // A token edit is the same server, and an unrelated instance joining the
    // list must not close this panel either.
    setInstances([
      { ...demoInstance(), token: 'rotated' },
      { id: 'other', url: 'https://other.example.com', token: '', name: 'Other', username: 'other-user' },
    ]);
    fireInstancesChanged();

    expect(fakePanel.dispose).not.toHaveBeenCalled();
    expect(vscode.window.showWarningMessage).not.toHaveBeenCalled();
  });

  it('keeps the panel open when the instance URL only gains a trailing slash', () => {
    const { config, setInstances, fireInstancesChanged } = instanceConfig([demoInstance()]);
    const { fakePanel } = openPanel(config);

    setInstances([demoInstance('https://forgejo.example.com/')]);
    fireInstancesChanged();

    // The same origin: the recorded review context is still valid.
    expect(fakePanel.dispose).not.toHaveBeenCalled();
  });
});
