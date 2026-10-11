import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as vscode from 'vscode';
import { NotificationSummaryPanel } from '../notificationSummaryPanel';
import type { NotificationSummaryPanelPayload } from '@cpf23333-forgejo-toolkit/shared/webview/messages';

/**
 * The notification-summary panel, host side.
 *
 * The webview half is tested where it lives; what this suite is about is the tab's own
 * four rules (`docs/design/notification-summary.md` §4):
 *
 * 1. **one panel, re-rendered for whichever notification it was invoked on** — a second
 *    run replaces the payload of the open tab and reveals it rather than stacking one;
 * 2. the payload of a re-render travels as `notificationSummaryPanelPayload`, the
 *    message the webview replaces its state with;
 * 3. the panel's regenerate runs the whole flow again for the entity the panel is
 *    showing, once per click, and a run that throws still answers with a payload;
 * 4. the panel writes nothing: its other message is the settings destination.
 */

function createFakePanel() {
  const handlers: Array<(message: unknown) => unknown> = [];
  const disposeHandlers: Array<() => void> = [];
  const fake = {
    title: '',
    webview: {
      html: '',
      postMessage: vi.fn(async () => true),
      onDidReceiveMessage: vi.fn((handler: (message: unknown) => unknown) => {
        handlers.push(handler);
        return { dispose: vi.fn() };
      }),
    },
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
    receive: (message: unknown) => {
      for (const handler of handlers) {
        void handler(message);
      }
    },
  };
  return fake;
}

function payload(overrides: Partial<NotificationSummaryPanelPayload> = {}): NotificationSummaryPanelPayload {
  return {
    instanceId: 'mock-instance-1',
    owner: 'demo-user',
    repo: 'demo-repo',
    type: 'issue',
    index: 1,
    title: 'Fix login bug',
    outcome: 'answer',
    model: { name: 'GPT-4o', vendor: 'copilot', id: 'gpt-4o' },
    transport: { id: 'vscode.lm', kind: 'vscode.lm', provider: 'copilot' },
    scope: 'body-and-comments',
    truncated: false,
    answer: 'The discussion settled on a fix.',
    ...overrides,
  };
}

/** Opens one panel over a fake webview panel and returns both halves. */
function open(
  overrides: Partial<NotificationSummaryPanelPayload> = {},
  run?: Parameters<typeof NotificationSummaryPanel.createOrShow>[2],
): { panel: NotificationSummaryPanel; webview: ReturnType<typeof createFakePanel> } {
  const webview = createFakePanel();
  vi.mocked(vscode.window.createWebviewPanel).mockReturnValue(webview as unknown as vscode.WebviewPanel);
  const panel = NotificationSummaryPanel.createOrShow(vscode.Uri.file('/ext') as vscode.Uri, payload(overrides), run);
  return { panel, webview };
}

/** What the panel posted to the webview, in order. */
function posted(webview: ReturnType<typeof createFakePanel>): Array<Record<string, unknown>> {
  return (webview.webview.postMessage as unknown as { mock: { calls: unknown[][] } }).mock.calls.map(
    ([message]) => message as Record<string, unknown>,
  );
}

/** Lets the panel's async message handler finish. */
async function flush(): Promise<void> {
  for (let turn = 0; turn < 5; turn += 1) {
    await Promise.resolve();
  }
}

beforeEach(() => {
  vi.clearAllMocks();
  // The tab is a singleton: a case that leaves one open would hand it to the next one.
  NotificationSummaryPanel.current?.dispose();
  vi.clearAllMocks();
});

afterEach(() => {
  NotificationSummaryPanel.current?.dispose();
  vi.clearAllMocks();
});

describe('NotificationSummaryPanel.createOrShow', () => {
  it('opens one editor-tab panel titled for the entity, beside the editor', () => {
    const { webview } = open();

    expect(vscode.window.createWebviewPanel).toHaveBeenCalledTimes(1);
    expect(vscode.window.createWebviewPanel).toHaveBeenCalledWith(
      NotificationSummaryPanel.viewType,
      'Discussion summary: demo-user/demo-repo#1',
      vscode.ViewColumn.Beside,
      expect.objectContaining({ enableScripts: true, retainContextWhenHidden: true }),
    );
    // The document was rendered (its own payload injection is asserted in
    // `src/webview/__tests__/content.test.ts`).
    expect(webview.webview.html.length).toBeGreaterThan(0);
  });

  it('re-renders the open panel for another notification instead of stacking a second', () => {
    const first = open();
    const secondPayload = payload({ owner: 'other-user', repo: 'other-repo', index: 7, answer: 'Another answer.' });

    const second = NotificationSummaryPanel.createOrShow(vscode.Uri.file('/ext') as vscode.Uri, secondPayload);

    expect(vscode.window.createWebviewPanel).toHaveBeenCalledTimes(1);
    expect(second).toBe(first.panel);
    expect(NotificationSummaryPanel.current).toBe(first.panel);
    // The tab follows the notification it now shows, and the webview is told wholesale.
    expect(first.webview.title).toBe('Discussion summary: other-user/other-repo#7');
    expect(posted(first.webview)).toEqual([{ command: 'notificationSummaryPanelPayload', payload: secondPayload }]);
    expect(first.webview.reveal).toHaveBeenCalled();
  });
});

describe('the panel regenerate', () => {
  it('runs the summary again for the entity it is showing, once per click', async () => {
    const run = vi.fn(async () => payload({ answer: 'Second answer.' }));
    const { webview } = open({}, run);

    webview.receive({ command: 'notificationSummaryRegenerate' });
    await flush();

    expect(run).toHaveBeenCalledTimes(1);
    // The identity only: the panel knows the entity, not the model, the scope or the
    // prompt — those are the run's own business.
    expect(run).toHaveBeenCalledWith({
      instanceId: 'mock-instance-1',
      owner: 'demo-user',
      repo: 'demo-repo',
      index: 1,
      type: 'issue',
    });
    expect(posted(webview)).toEqual([
      { command: 'notificationSummaryPanelPayload', payload: payload({ answer: 'Second answer.' }) },
    ]);
  });

  it('does not start a second run while one is in flight', async () => {
    let settle: ((value: NotificationSummaryPanelPayload) => void) | undefined;
    const run = vi.fn(
      () =>
        new Promise<NotificationSummaryPanelPayload>((resolve) => {
          settle = resolve;
        }),
    );
    const { webview } = open({}, run);

    webview.receive({ command: 'notificationSummaryRegenerate' });
    await flush();
    webview.receive({ command: 'notificationSummaryRegenerate' });
    await flush();

    expect(run).toHaveBeenCalledTimes(1);
    settle?.(payload({ answer: 'Settled.' }));
    await flush();
    expect(posted(webview)).toHaveLength(1);
  });

  it('answers with a payload when the run threw, so the page is not left waiting', async () => {
    const run = vi.fn(async () => {
      throw new Error('the run blew up');
    });
    const { webview } = open({}, run);

    webview.receive({ command: 'notificationSummaryRegenerate' });
    await flush();

    const [message] = posted(webview);
    expect(message?.command).toBe('notificationSummaryPanelPayload');
    const next = message?.payload as NotificationSummaryPanelPayload;
    expect(next.outcome).toBe('refused');
    expect(String(next.failure)).toContain('the run blew up');
    // The next attempt starts from the same entity.
    expect(next.owner).toBe('demo-user');
    expect(next.index).toBe(1);
  });

  it('drops a regenerate when no run was registered', async () => {
    const { webview } = open();

    webview.receive({ command: 'notificationSummaryRegenerate' });
    await flush();

    expect(posted(webview)).toEqual([]);
  });
});

describe('the panel writes nothing', () => {
  it('opens the settings page through the one command a webview can reach', async () => {
    const { webview } = open();

    webview.receive({ command: 'openNativeSettings' });
    await flush();

    expect(vscode.commands.executeCommand).toHaveBeenCalledWith('forgejoToolkit.openNativeSettings');
    // It is navigation only: nothing is posted back and no payload is replaced.
    expect(posted(webview)).toEqual([]);
  });

  it('ignores a message it does not know', async () => {
    const run = vi.fn(async () => payload());
    const { webview } = open({}, run);

    webview.receive({ command: 'notificationSummarySomethingElse' });
    webview.receive(undefined);
    await flush();

    expect(run).not.toHaveBeenCalled();
    expect(posted(webview)).toEqual([]);
    expect(vscode.commands.executeCommand).not.toHaveBeenCalled();
  });
});

describe('the panel lifecycle', () => {
  it('forgets itself when the tab is closed, so the next run opens a new one', () => {
    const first = open();

    // Closing the tab is VS Code disposing the panel, which the fake replays.
    first.webview.dispose();

    expect(NotificationSummaryPanel.current).toBeUndefined();
    const second = open();
    expect(second.panel).not.toBe(first.panel);
    expect(vscode.window.createWebviewPanel).toHaveBeenCalledTimes(2);
  });

  it('runs nothing after it was disposed', async () => {
    const run = vi.fn(async () => payload());
    const { webview } = open({}, run);

    webview.dispose();
    webview.receive({ command: 'notificationSummaryRegenerate' });
    await flush();

    expect(run).not.toHaveBeenCalled();
    expect(posted(webview)).toEqual([]);
  });
});
