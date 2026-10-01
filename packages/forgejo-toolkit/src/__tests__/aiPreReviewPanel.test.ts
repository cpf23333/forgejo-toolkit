import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as vscode from 'vscode';
import { AiPreReviewPanel, selectPanelEntries } from '../aiPreReviewPanel';
import { PR_REVIEW_MAX_COMMENT_LENGTH } from '@cpf23333-forgejo-toolkit/shared/limits';
import type {
  AiPreReviewPanelCandidate,
  AiPreReviewPanelPayload,
} from '@cpf23333-forgejo-toolkit/shared/webview/messages';

/**
 * The AI pre-review confirmation panel, host side.
 *
 * It is the run's only write gate and it replaced a multi-select quick pick whose
 * rows could not show a comment body in full. Four properties are what this suite
 * exists for:
 *
 * 1. the answer is the user's — a closed tab, the cancel button and a message that
 *    names no card all mean "write nothing", and the first answer wins;
 * 2. the answer carries the **bodies** the panel's editors hold, so a wording can
 *    be fixed before the draft exists instead of after it does;
 * 3. every entry is re-validated against the host's own payload — an index that
 *    was actually offered, a body that is a string, non-empty after trimming and
 *    within `PR_REVIEW_MAX_COMMENT_LENGTH` — and the **whole create is refused,
 *    creating nothing, if any entry fails**. An anchor field in the message is
 *    ignored outright, because anchors never come from the webview;
 * 4. the panel is not the writer — it reports what the run wrote, and the two
 *    non-decision actions (open a diff, reach the draft) are navigation only.
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

function candidate(overrides: Partial<AiPreReviewPanelCandidate> = {}): AiPreReviewPanelCandidate {
  return {
    index: 0,
    path: 'src/index.ts',
    line: 2,
    side: 'head',
    extraLines: 0,
    body: 'This logs on every call.',
    diff: { status: 'modified', baseSha: 'abc123', headSha: 'def456' },
    ...overrides,
  };
}

function payload(overrides: Partial<AiPreReviewPanelPayload> = {}): AiPreReviewPanelPayload {
  return {
    instanceId: 'inst-1',
    owner: 'demo-user',
    repo: 'demo-repo',
    index: 2,
    pullRequestTitle: 'Add dark mode',
    model: { name: 'Fake Model', vendor: 'fake', family: 'fake', id: 'fake-model' },
    scope: 'changed-files',
    // Two of the three files the run fetched: the run covered the pull request as
    // far as the brief's table went, which is what the header has to say.
    changedFileCount: 2,
    changedFilesTotal: 2,
    candidateCount: 2,
    drops: [{ label: 'line not in the diff', count: 1 }],
    candidates: [
      candidate({ index: 0 }),
      candidate({ index: 1, path: 'src/other.ts', line: 4, side: 'base', extraLines: 2, body: 'Second.' }),
    ],
    ...overrides,
  };
}

/** Opens one panel over a fake webview panel and returns both halves. */
function openPanel(
  overrides: Partial<AiPreReviewPanelPayload> = {},
  host?: { revealPullRequestDetail: (payload: never) => void },
): { panel: AiPreReviewPanel; webview: ReturnType<typeof createFakePanel> } {
  const webview = createFakePanel();
  vi.mocked(vscode.window.createWebviewPanel).mockReturnValue(webview as unknown as vscode.WebviewPanel);
  const panel = AiPreReviewPanel.createOrShow(vscode.Uri.file('/ext') as vscode.Uri, payload(overrides), host as never);
  return { panel, webview };
}

/** What the panel posted to the webview, in order. */
function posted(webview: ReturnType<typeof createFakePanel>): Array<Record<string, unknown>> {
  return (webview.webview.postMessage as unknown as { mock: { calls: unknown[][] } }).mock.calls.map(
    ([message]) => message as Record<string, unknown>,
  );
}

/** The reason of a refusal the panel posted, or `undefined` when it posted none. */
function rejectionReason(webview: ReturnType<typeof createFakePanel>): string | undefined {
  const rejection = posted(webview).find((message) => message.command === 'aiPreReviewPanelRejected');
  return rejection ? String(rejection.reason) : undefined;
}

/**
 * Whether the panel has answered yet, after giving pending microtasks a turn.
 *
 * A refusal must leave this false: the question stays open so the user can fix the
 * card and press Create again.
 */
async function answered(panel: AiPreReviewPanel): Promise<boolean> {
  let settled = false;
  void panel.decision.then(() => {
    settled = true;
  });
  await Promise.resolve();
  return settled;
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('AiPreReviewPanel.createOrShow', () => {
  it('opens one editor-tab panel titled for the question, beside the editor', async () => {
    const { panel, webview } = openPanel();

    expect(vscode.window.createWebviewPanel).toHaveBeenCalledTimes(1);
    expect(vscode.window.createWebviewPanel).toHaveBeenCalledWith(
      AiPreReviewPanel.viewType,
      'AI pre-review: review the proposed comments',
      vscode.ViewColumn.Beside,
      expect.objectContaining({ enableScripts: true, retainContextWhenHidden: true }),
    );
    // The document was rendered (its own payload injection is asserted in
    // `src/webview/__tests__/content.test.ts`).
    expect(webview.webview.html.length).toBeGreaterThan(0);
    // Nothing is answered until the user answers.
    expect(await answered(panel)).toBe(false);
  });
});

describe('the panel answer', () => {
  it('returns the checked cards with the bodies sent, in the payload order', async () => {
    const { panel, webview } = openPanel();

    // The webview sends what its editors hold, in the order the user happened to
    // click them; the host keeps the order the cards were shown in, so the drafts
    // are created in the order the user read them.
    webview.receive({
      command: 'aiPreReviewPanelCreate',
      entries: [
        { index: 1, body: 'Second, edited.' },
        { index: 0, body: 'Mine now.' },
      ],
    });

    expect(await panel.decision).toEqual({
      kind: 'create',
      entries: [
        { index: 0, body: 'Mine now.' },
        { index: 1, body: 'Second, edited.' },
      ],
    });
  });

  it('carries the model wording through unchanged when a card was not edited', async () => {
    const { panel, webview } = openPanel();

    webview.receive({ command: 'aiPreReviewPanelCreate', entries: [{ index: 0, body: 'This logs on every call.' }] });

    expect(await panel.decision).toEqual({
      kind: 'create',
      entries: [{ index: 0, body: 'This logs on every call.' }],
    });
  });

  it('reads only the index and the body of an entry, never the anchor fields beside them', async () => {
    // The message is untrusted: an entry that carries its own anchor must not be
    // able to move the comment. The answer holds the index and the body only, so a
    // forged path/line/side/extraLines/diff cannot reach the write path at all.
    const { panel, webview } = openPanel();

    webview.receive({
      command: 'aiPreReviewPanelCreate',
      entries: [
        {
          index: 0,
          body: 'Mine now.',
          path: '../etc/passwd',
          line: 999,
          side: 'base',
          extraLines: 40,
          diff: { status: 'renamed', baseSha: 'x', headSha: 'y' },
        },
      ],
    });

    expect(await panel.decision).toEqual({ kind: 'create', entries: [{ index: 0, body: 'Mine now.' }] });
  });

  it('treats the cancel action as "nothing at all"', async () => {
    const { panel, webview } = openPanel();

    webview.receive({ command: 'aiPreReviewPanelCancel' });

    expect(await panel.decision).toEqual({ kind: 'cancel' });
  });

  it('treats a closed tab as "nothing at all", and keeps an answer already given', async () => {
    const first = openPanel();
    first.webview.dispose();
    expect(await first.panel.decision).toEqual({ kind: 'cancel' });

    const second = openPanel();
    second.webview.receive({ command: 'aiPreReviewPanelCreate', entries: [{ index: 1, body: 'Second.' }] });
    expect(await second.panel.decision).toEqual({ kind: 'create', entries: [{ index: 1, body: 'Second.' }] });
    // The user closed the tab a moment after pressing Create: the run is already
    // acting on that answer and must not be turned into a cancellation.
    second.webview.dispose();
    expect(await second.panel.decision).toEqual({ kind: 'create', entries: [{ index: 1, body: 'Second.' }] });
  });

  it('keeps the question open when the answer names no card', async () => {
    const { panel, webview } = openPanel();

    webview.receive({ command: 'aiPreReviewPanelCreate', entries: [] });
    webview.receive({ command: 'aiPreReviewPanelCreate', entries: 'nope' });
    webview.receive({ command: 'aiPreReviewPanelCreate' });

    // Nothing settled and nothing refused: an answer that names no card is not an
    // answer at all, so the panel keeps its buttons and the user can still choose.
    expect(await answered(panel)).toBe(false);
    expect(posted(webview)).toEqual([]);
  });
});

describe('the panel re-validates every entry', () => {
  /** The reason the panel posted for one Create message, and whether it answered. */
  async function refuse(message: Record<string, unknown>) {
    const { panel, webview } = openPanel();
    webview.receive({ command: 'aiPreReviewPanelCreate', ...message });
    return { panel, webview, reason: rejectionReason(webview) };
  }

  it('refuses an index the run never offered, and creates nothing', async () => {
    const { panel, webview, reason } = await refuse({ entries: [{ index: 99, body: 'Not mine.' }] });

    expect(await answered(panel)).toBe(false);
    expect(reason).toContain('cannot accept');
    expect(posted(webview)).toEqual([{ command: 'aiPreReviewPanelRejected', reason }]);
  });

  it('refuses an entry that is not an object', async () => {
    const { panel, reason } = await refuse({ entries: ['0'] });

    expect(await answered(panel)).toBe(false);
    expect(reason).toContain('cannot accept');
  });

  it('refuses a body that is not text', async () => {
    const { panel, reason } = await refuse({ entries: [{ index: 0, body: { text: 'no' } }] });

    expect(await answered(panel)).toBe(false);
    expect(reason).toContain('cannot accept');
  });

  it('refuses the same card twice rather than picking one of the two bodies', async () => {
    const { panel, reason } = await refuse({
      entries: [
        { index: 0, body: 'First.' },
        { index: 0, body: 'Second.' },
      ],
    });

    expect(await answered(panel)).toBe(false);
    expect(reason).toContain('cannot accept');
  });

  it('refuses an emptied body, naming that card, and keeps the question open', async () => {
    // The behaviour chosen for a ticked card whose body was emptied: the whole
    // create is refused with a message naming the card, because silently skipping
    // it would create fewer drafts than the button promised and would drop a card
    // the user had ticked. Nothing is written, and the user can fix it in place.
    const { panel, webview, reason } = await refuse({ entries: [{ index: 0, body: '' }] });

    expect(await answered(panel)).toBe(false);
    expect(reason).toContain('src/index.ts:2 (head)');
    expect(reason).toContain('empty body');
    expect(posted(webview)).toEqual([{ command: 'aiPreReviewPanelRejected', reason }]);
  });

  it('refuses a whitespace-only body the same way', async () => {
    const { panel, reason } = await refuse({ entries: [{ index: 1, body: '  \n\t ' }] });

    expect(await answered(panel)).toBe(false);
    // The card is named by its range and side, so "which one" is never a guess.
    expect(reason).toContain('src/other.ts:4-6 (base)');
    expect(reason).toContain('empty body');
  });

  it('refuses an over-length body, naming the card and both numbers', async () => {
    const tooLong = 'x'.repeat(PR_REVIEW_MAX_COMMENT_LENGTH + 1);
    const { panel, reason } = await refuse({ entries: [{ index: 0, body: tooLong }] });

    expect(await answered(panel)).toBe(false);
    expect(reason).toContain('src/index.ts:2 (head)');
    expect(reason).toContain(`${PR_REVIEW_MAX_COMMENT_LENGTH + 1} characters`);
    expect(reason).toContain(`${PR_REVIEW_MAX_COMMENT_LENGTH}-character limit`);
  });

  it('accepts a body exactly at the cap, and changes nothing about it', async () => {
    const { panel, webview } = openPanel();
    const atCap = 'y'.repeat(PR_REVIEW_MAX_COMMENT_LENGTH);

    webview.receive({ command: 'aiPreReviewPanelCreate', entries: [{ index: 0, body: atCap }] });

    expect(await panel.decision).toEqual({ kind: 'create', entries: [{ index: 0, body: atCap }] });
    expect(rejectionReason(webview)).toBeUndefined();
  });

  it('refuses the whole create when one entry is bad, so the good card is not written alone', async () => {
    const { panel, webview, reason } = await refuse({
      entries: [
        { index: 0, body: 'A perfectly good edit.' },
        { index: 1, body: '   ' },
      ],
    });

    // A partial write is exactly what the user cannot see coming: the panel said
    // "Create 2 draft comment(s)", so writing one and losing the other silently is
    // the surprise this refusal exists to prevent.
    expect(await answered(panel)).toBe(false);
    expect(reason).toContain('src/other.ts:4-6 (base)');
    expect(posted(webview)).toEqual([{ command: 'aiPreReviewPanelRejected', reason }]);
  });

  it('lets the user fix the body and press Create again after a refusal', async () => {
    const { panel, webview } = openPanel();

    webview.receive({ command: 'aiPreReviewPanelCreate', entries: [{ index: 0, body: '' }] });
    expect(await answered(panel)).toBe(false);

    webview.receive({ command: 'aiPreReviewPanelCreate', entries: [{ index: 0, body: 'Fixed.' }] });

    expect(await panel.decision).toEqual({ kind: 'create', entries: [{ index: 0, body: 'Fixed.' }] });
  });
});

describe('the panel result', () => {
  it('reports what the run wrote, and the failure when part of it failed', async () => {
    const { panel, webview } = openPanel();

    panel.reportResult({ created: 2 });
    expect(webview.webview.postMessage).toHaveBeenCalledWith({ command: 'aiPreReviewPanelResult', created: 2 });

    panel.reportResult({ created: 1, failure: 'server said no' });
    expect(webview.webview.postMessage).toHaveBeenCalledWith({
      command: 'aiPreReviewPanelResult',
      created: 1,
      failure: 'server said no',
    });
  });

  it('posts a refusal as its own message, without answering the question', async () => {
    const { panel, webview } = openPanel();

    panel.reportRejected('Nothing was created: the comment for src/index.ts:2 (head) has an empty body.');

    expect(webview.webview.postMessage).toHaveBeenCalledWith({
      command: 'aiPreReviewPanelRejected',
      reason: 'Nothing was created: the comment for src/index.ts:2 (head) has an empty body.',
    });
    expect(await answered(panel)).toBe(false);
  });

  it('drops the report once the panel is gone instead of rejecting', async () => {
    const { panel, webview } = openPanel();
    panel.dispose();
    webview.webview.postMessage.mockClear();

    panel.reportResult({ created: 1 });
    panel.reportRejected('nothing was created');

    expect(webview.webview.postMessage).not.toHaveBeenCalled();
  });
});

describe('the card actions', () => {
  it('opens the diff at the commented line, on the side the anchor belongs to', async () => {
    const { webview } = openPanel();

    webview.receive({ command: 'aiPreReviewPanelOpenDiff', index: 0 });
    await vi.waitFor(() => expect(vscode.commands.executeCommand).toHaveBeenCalled());

    const [command, left, right, title] = vi.mocked(vscode.commands.executeCommand).mock.calls[0] as unknown as [
      string,
      { path: string; query: string },
      { path: string; query: string },
      string,
    ];
    expect(command).toBe('vscode.diff');
    expect(title).toBe('src/index.ts (#2)');
    // Both sides are the extension's own diff URIs, at the pull request's own
    // shas — the same machinery the dashboard's "open diff" action uses.
    expect(left.path).toBe('/inst-1/demo-user/demo-repo/src/index.ts');
    expect(JSON.parse(left.query)).toEqual({ index: 2, ref: 'abc123', isBase: true, status: 'modified' });
    expect(right.path).toBe('/inst-1/demo-user/demo-repo/src/index.ts');
    expect(JSON.parse(right.query)).toEqual({ index: 2, ref: 'def456', isBase: false, status: 'modified' });
    // A head-side anchor is revealed in the head document.
    expect(vscode.window.showTextDocument).toHaveBeenCalledWith(right, {
      selection: expect.objectContaining({ startLine: 1, endLine: 1 }),
      preview: false,
    });
  });

  it('reveals a range on the base side in the base document', async () => {
    const { webview } = openPanel();

    webview.receive({ command: 'aiPreReviewPanelOpenDiff', index: 1 });
    await vi.waitFor(() => expect(vscode.window.showTextDocument).toHaveBeenCalled());

    const [uri, options] = vi.mocked(vscode.window.showTextDocument).mock.calls[0] as unknown as [
      { query: string },
      { selection: { startLine: number; endLine: number } },
    ];
    expect(JSON.parse(uri.query).isBase).toBe(true);
    // line 4 for 2 extra lines: the range covers 4–6, 0-based 3–5.
    expect(options.selection).toMatchObject({ startLine: 3, endLine: 5 });
  });

  it('opens nothing for an index the run never offered or a candidate with no shas', async () => {
    const { webview } = openPanel({ candidates: [candidate({ diff: { status: 'modified' } })] });

    webview.receive({ command: 'aiPreReviewPanelOpenDiff', index: 99 });
    webview.receive({ command: 'aiPreReviewPanelOpenDiff', index: 0 });
    webview.receive({ command: 'aiPreReviewPanelOpenDiff', index: 'not a number' });

    expect(vscode.commands.executeCommand).not.toHaveBeenCalled();
    expect(vscode.window.showTextDocument).not.toHaveBeenCalled();
  });

  it('refuses to build a diff URI from an unsafe path', async () => {
    // Defence in depth: the payload's paths come from the run's validated
    // candidates, and a path that could escape the repository must not reach a
    // URI even if one ever did.
    const { webview } = openPanel({ candidates: [candidate({ path: '../etc/passwd' })] });

    webview.receive({ command: 'aiPreReviewPanelOpenDiff', index: 0 });
    await Promise.resolve();

    expect(vscode.commands.executeCommand).not.toHaveBeenCalled();
  });

  it('reveals the pull request when the host can navigate, and does nothing without one', async () => {
    const host = { revealPullRequestDetail: vi.fn() };
    const withHost = openPanel({}, host);
    withHost.webview.receive({ command: 'aiPreReviewPanelOpenDraft' });
    expect(host.revealPullRequestDetail).toHaveBeenCalledWith({
      instanceId: 'inst-1',
      owner: 'demo-user',
      repo: 'demo-repo',
      index: 2,
    });

    const withoutHost = openPanel();
    withoutHost.webview.receive({ command: 'aiPreReviewPanelOpenDraft' });
    expect(host.revealPullRequestDetail).toHaveBeenCalledTimes(1);
  });
});

describe('selectPanelEntries', () => {
  const offered = [candidate({ index: 3 }), candidate({ index: 7 })];

  it('keeps the offered cards, with the bodies sent, in the offered order', () => {
    expect(
      selectPanelEntries(
        [
          { index: 7, body: 'Second.' },
          { index: 3, body: 'First, edited.' },
        ],
        offered,
      ),
    ).toEqual({
      kind: 'selected',
      entries: [
        { index: 3, body: 'First, edited.' },
        { index: 7, body: 'Second.' },
      ],
    });
  });

  it('reports "nothing named" separately from a refusal', () => {
    // Not an answer, so the panel keeps its question rather than showing a
    // refusal the user did not cause.
    expect(selectPanelEntries(undefined, offered)).toEqual({ kind: 'empty' });
    expect(selectPanelEntries([], offered)).toEqual({ kind: 'empty' });
    expect(selectPanelEntries('3', offered)).toEqual({ kind: 'empty' });
  });

  it('rejects an index that was not offered, a non-integer and a duplicate', () => {
    expect(selectPanelEntries([{ index: 5, body: 'x' }], offered)).toEqual({
      kind: 'rejected',
      failure: { kind: 'index-not-offered', position: 0 },
    });
    expect(selectPanelEntries([{ index: 3.5, body: 'x' }], offered)).toEqual({
      kind: 'rejected',
      failure: { kind: 'index-not-offered', position: 0 },
    });
    expect(selectPanelEntries(['3'], offered)).toEqual({
      kind: 'rejected',
      failure: { kind: 'not-an-entry', position: 0 },
    });
    expect(
      selectPanelEntries(
        [
          { index: 3, body: 'first' },
          { index: 3, body: 'second' },
        ],
        offered,
      ),
    ).toEqual({ kind: 'rejected', failure: { kind: 'duplicate-index', index: 3 } });
  });

  it('rejects a non-string, an empty and a whitespace-only body', () => {
    expect(selectPanelEntries([{ index: 3, body: 7 }], offered)).toEqual({
      kind: 'rejected',
      failure: { kind: 'body-not-a-string', index: 3 },
    });
    expect(selectPanelEntries([{ index: 3, body: '' }], offered)).toEqual({
      kind: 'rejected',
      failure: { kind: 'body-empty', index: 3 },
    });
    expect(selectPanelEntries([{ index: 3, body: ' \n ' }], offered)).toEqual({
      kind: 'rejected',
      failure: { kind: 'body-empty', index: 3 },
    });
  });

  it('rejects a body over the cap and keeps one at the cap', () => {
    expect(selectPanelEntries([{ index: 3, body: 'x'.repeat(PR_REVIEW_MAX_COMMENT_LENGTH + 1) }], offered)).toEqual({
      kind: 'rejected',
      failure: { kind: 'body-too-long', index: 3, length: PR_REVIEW_MAX_COMMENT_LENGTH + 1 },
    });
    expect(selectPanelEntries([{ index: 3, body: 'x'.repeat(PR_REVIEW_MAX_COMMENT_LENGTH) }], offered)).toEqual({
      kind: 'selected',
      entries: [{ index: 3, body: 'x'.repeat(PR_REVIEW_MAX_COMMENT_LENGTH) }],
    });
  });

  it('keeps the body exactly as sent, whitespace at either end included', () => {
    // The trim is the emptiness test, not a rewrite: the comment text is the
    // user's, and silently stripping it would be an edit they did not make.
    expect(selectPanelEntries([{ index: 3, body: '  kept as typed  ' }], offered)).toEqual({
      kind: 'selected',
      entries: [{ index: 3, body: '  kept as typed  ' }],
    });
  });
});
