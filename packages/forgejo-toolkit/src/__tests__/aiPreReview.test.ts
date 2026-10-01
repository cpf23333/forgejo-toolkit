import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * The host half of the AI pre-review: the command, its two degradation layers,
 * the confirmation list and the draft writes.
 *
 * The `vscode` mock is hand-written here rather than reused from
 * `src/__tests__/extension-setup.ts`, for the reason the design record's §9.5
 * gives: the shared mock has no `lm` field at all, so "the editor has no
 * language model API" is the *default* environment and cannot be exercised
 * there. This file installs the module's own mock (which takes precedence over
 * the setup file's) and gives every case the `lm` shape it needs.
 *
 * The writes are asserted against the real MSW handlers rather than against
 * `ForgejoClient` spies, because the point is what reached the server: a
 * `submit` that never became a request, and a run that sent nothing at all.
 */

const state = vi.hoisted(() => ({
  /** Configuration values, keyed by the setting name without its section. */
  settings: {} as Record<string, unknown>,
  /**
   * Whether the progress notification's cancellation token starts out cancelled.
   * The mock hands the run a token whose `isCancellationRequested` reads this, so
   * a case can cancel the run without a real notification.
   */
  cancelRequested: false,
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
  const lm = {
    selectChatModels: vi.fn(async () => [] as never[]),
  };
  return {
    lm,
    LanguageModelChatMessage: {
      User: vi.fn((content: string) => ({ role: 'user', content })),
    },
    ProgressLocation: { SourceControl: 1, Window: 10, Notification: 15 },
    window: {
      showErrorMessage: vi.fn(),
      showInformationMessage: vi.fn(),
      showWarningMessage: vi.fn(async () => undefined),
      showQuickPick: vi.fn(),
      showInputBox: vi.fn(),
      // The run reports progress around the fetch and the model call, and the
      // token it hands back is the one the cancellation case flips.
      withProgress: vi.fn(async (_options: unknown, task: (progress: unknown, token: unknown) => unknown) =>
        task(
          { report: vi.fn() },
          {
            isCancellationRequested: state.cancelRequested,
            onCancellationRequested: vi.fn(() => ({ dispose: vi.fn() })),
          },
        ),
      ),
      activeTextEditor: undefined,
      get visibleTextEditors() {
        return [] as never[];
      },
      createOutputChannel: vi.fn(() => ({ appendLine: vi.fn(), show: vi.fn(), dispose: vi.fn() })),
      onDidChangeActiveTextEditor: vi.fn(() => ({ dispose: vi.fn() })),
      onDidChangeWindowState: vi.fn(() => ({ dispose: vi.fn() })),
      state: { focused: true },
    },
    workspace: {
      getConfiguration: vi.fn(() => ({
        get: vi.fn((key: string, fallback?: unknown) => (key in state.settings ? state.settings[key] : fallback)),
        update: vi.fn(),
      })),
      onDidChangeConfiguration: vi.fn(() => ({ dispose: vi.fn() })),
      onDidChangeWorkspaceFolders: vi.fn(() => ({ dispose: vi.fn() })),
      textDocuments: [],
      workspaceFolders: [],
    },
    commands: { executeCommand: vi.fn(), registerCommand: vi.fn(() => ({ dispose: vi.fn() })) },
    Uri: {
      file: vi.fn((path: string) => makeUri('file', path)),
      parse: vi.fn((url: string) => makeUri(url.split(':')[0] ?? '', url)),
      from: vi.fn((components: { scheme: string; path: string; query?: string }) =>
        makeUri(components.scheme, components.path, components.query),
      ),
      joinPath: vi.fn((...args: unknown[]) => makeUri('file', args.join('/'))),
    },
    env: {
      language: 'en',
      sessionId: 'test-session',
      openExternal: vi.fn(async () => true),
      clipboard: { writeText: vi.fn(async () => undefined) },
    },
    extensions: { getExtension: vi.fn(), onDidChange: vi.fn(() => ({ dispose: vi.fn() })) },
    l10n: {
      t: vi.fn((message: string, ...args: unknown[]) =>
        message.replace(/\{([^{}]+)\}/g, (placeholder, key: string) => {
          const value = args[Number(key)];
          return value === undefined ? placeholder : String(value);
        }),
      ),
    },
    EventEmitter: vi.fn().mockImplementation(function () {
      return { event: vi.fn(), fire: vi.fn(), dispose: vi.fn() };
    }),
    Disposable: { from: vi.fn() },
    FileSystemError: {
      FileNotFound: (uri?: unknown) =>
        Object.assign(new Error(`FileNotFound: ${String(uri)}`), { code: 'FileNotFound' }),
      Unavailable: (message?: string) => Object.assign(new Error(String(message)), { code: 'Unavailable' }),
      NoPermissions: () => Object.assign(new Error('NoPermissions'), { code: 'NoPermissions' }),
    },
    FileType: { Unknown: 0, File: 1, Directory: 2, SymbolicLink: 64 },
  };
});

import * as vscode from 'vscode';
import { http, HttpResponse } from 'msw';
import { mockServer, startMockServer, stopMockServer } from '../test/mocks/server';
import { mockInstance } from '../test/mocks/data/instances';
import { mockPullRequestDiff as MOCK_DIFF } from '../test/mocks/data/pullRequestExtras';
import { runAiPreReview, writePreReviewDrafts } from '../aiPreReview';
import type { ForgejoPrUriParams } from '../prFileSystemProvider';
import type { ConfigManager } from '../config';
import type { PullReviewCommentController } from '../comments/pullReviewCommentController';

/** What one intercepted request carried. */
interface CapturedRequest {
  method: string;
  path: string;
  body: string;
}

const captured: CapturedRequest[] = [];
const pendingReads: Promise<void>[] = [];

/**
 * A model whose answer is a fixed string. `countTokens` is a fixed value so a
 * test can drive the budget branches without depending on a real tokenizer.
 */
function createModel(
  options: {
    answer?: string;
    tokens?: number;
    maxInputTokens?: number;
    failWith?: unknown;
    streamFailWith?: unknown;
  } = {},
) {
  const answer = options.answer ?? '{"comments":[]}';
  return {
    name: 'Fake Model',
    id: 'fake-model',
    vendor: 'fake',
    family: 'fake',
    version: '1',
    maxInputTokens: options.maxInputTokens ?? 128_000,
    countTokens: vi.fn(async () => options.tokens ?? 10),
    sendRequest: vi.fn(async () => {
      if (options.failWith) {
        throw options.failWith;
      }
      return {
        text: (async function* () {
          if (options.streamFailWith) {
            throw options.streamFailWith;
          }
          yield answer;
        })(),
      };
    }),
  };
}

function setModel(model: ReturnType<typeof createModel>): void {
  vi.mocked(vscode.lm.selectChatModels).mockImplementation(async () => [model] as never[]);
}

/** Every model the editor offers, in the order `selectChatModels` returns them. */
function setModels(...models: ReturnType<typeof createModel>[]): void {
  vi.mocked(vscode.lm.selectChatModels).mockImplementation(async () => models as never[]);
}

/** A count that is cheap for the instruction prompt and expensive for the brief. */
function countInstructionsCheaply(): (text: string) => Promise<number> {
  return async (text: string) => (text.includes('[changed-files]') ? 10_000 : 10);
}

const controller = {
  findPendingReview: vi.fn(async () => undefined),
  refreshPullRequestComments: vi.fn(async () => undefined),
} as unknown as PullReviewCommentController;

const config = {
  getInstances: () => [mockInstance],
  onInstancesChanged: () => ({ dispose: vi.fn() }),
} as unknown as ConfigManager;

function params(overrides?: Partial<ForgejoPrUriParams>): ForgejoPrUriParams {
  return {
    instanceId: mockInstance.id,
    owner: 'demo-user',
    repo: 'demo-repo',
    index: 2,
    ref: 'def456',
    path: 'src/index.ts',
    isBase: false,
    ...overrides,
  };
}

/** The request bodies of every `POST` the run issued, in order. */
async function postedBodies(pathSuffix: string): Promise<Record<string, unknown>[]> {
  await Promise.all(pendingReads.splice(0));
  return captured
    .filter((entry) => entry.method === 'POST' && entry.path.endsWith(pathSuffix))
    .map((entry) => JSON.parse(entry.body) as Record<string, unknown>);
}

/** One page, the way the shared mock handlers slice a list response. */
function paginateForTest(request: Request, items: unknown[]): unknown[] {
  const url = new URL(request.url);
  const page = Math.max(1, Number(url.searchParams.get('page')) || 1);
  const limit = Number(url.searchParams.get('limit')) || items.length || 1;
  const start = (page - 1) * limit;
  return items.slice(start, start + limit);
}

/**
 * The mock's own argument list. `vi.mocked(...).mock.calls` is typed against
 * the *declared* signature `sendRequest` has on `LanguageModelChat`, which the
 * fake does not implement, so the calls are read through this narrower shape.
 */
type SendRequestMock = { mock: { calls: Array<[{ content: string }[]]> } };

/** The concatenation of both prompt messages the model was handed. */
function sentPrompt(model: ReturnType<typeof createModel>): string {
  const messages = (model.sendRequest as unknown as SendRequestMock).mock.calls[0]?.[0] ?? [];
  return messages.map((message) => message.content).join('\n');
}

/** The quick-pick items a case offered, in order. */
function offeredItems(callIndex = 0): Array<{ label: string; picked?: boolean }> {
  const call = vi.mocked(vscode.window.showQuickPick).mock.calls[callIndex];
  const items = (call?.[0] ?? []) as unknown as Array<{ label: string; picked?: boolean }>;
  return items;
}

/** A quick pick that selects the first offered item, or none when empty. */
function pickFirst(): void {
  vi.mocked(vscode.window.showQuickPick).mockImplementation(async (items) => {
    const resolved = (await items) as unknown as unknown[];
    return (resolved.length > 0 ? [resolved[0]] : []) as never;
  });
}

beforeEach(async () => {
  state.settings = {};
  state.cancelRequested = false;
  captured.length = 0;
  pendingReads.length = 0;
  vi.clearAllMocks();
  vi.mocked(controller.findPendingReview).mockResolvedValue(undefined);
  mockServer.events.on('request:start', (event: { request: Request }) => {
    const request = event.request;
    const url = new URL(request.url);
    pendingReads.push(
      request
        .clone()
        .text()
        .then((body) => {
          captured.push({ method: request.method, path: url.pathname, body });
        })
        .catch(() => {
          captured.push({ method: request.method, path: url.pathname, body: '' });
        }),
    );
  });
  await startMockServer();
});

afterEach(() => {
  stopMockServer();
  // `mockServer.use()` handlers prepend for the rest of the process; reset them
  // so a case that serves a wider pull request cannot change what a later case
  // sees.
  mockServer.resetHandlers();
  mockServer.events.removeAllListeners();
  vi.clearAllMocks();
});

describe('the feature switch is checked before anything else happens', () => {
  it('refuses, sends nothing and never touches the model when it is off', async () => {
    const model = createModel();
    setModel(model);

    await runAiPreReview(config, undefined, controller, params());

    expect(captured).toEqual([]);
    expect(vscode.lm.selectChatModels).not.toHaveBeenCalled();
    expect(model.sendRequest).not.toHaveBeenCalled();
    expect(vscode.window.showWarningMessage).toHaveBeenCalledWith(
      expect.stringContaining('forgejoToolkit.aiPreReview'),
    );
  });

  it('treats a non-boolean value as off, like the other setting readers', async () => {
    state.settings.aiPreReview = 'true';
    const model = createModel();
    setModel(model);

    await runAiPreReview(config, undefined, controller, params());

    expect(captured).toEqual([]);
    expect(model.sendRequest).not.toHaveBeenCalled();
  });
});

describe('the two degradation layers', () => {
  it('reports the missing language model API without any request', async () => {
    state.settings.aiPreReview = true;
    // The setup-file mock has no `lm` field; deleting it here reproduces that
    // editor exactly.
    const original = vscode.lm;
    (vscode as { lm?: unknown }).lm = undefined;
    try {
      await runAiPreReview(config, undefined, controller, params());
    } finally {
      (vscode as { lm?: unknown }).lm = original;
    }

    expect(captured).toEqual([]);
    expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(expect.stringContaining('no language model API'));
  });

  it('reports an empty model list without any HTTP request', async () => {
    state.settings.aiPreReview = true;
    vi.mocked(vscode.lm.selectChatModels).mockResolvedValue([] as never[]);

    await runAiPreReview(config, undefined, controller, params());

    expect(captured).toEqual([]);
    expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(expect.stringContaining('No chat model is available'));
  });

  it('reports a rejecting model list without any HTTP request', async () => {
    state.settings.aiPreReview = true;
    vi.mocked(vscode.lm.selectChatModels).mockRejectedValue(new Error('model listing failed'));

    await runAiPreReview(config, undefined, controller, params());

    expect(captured).toEqual([]);
    expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
      expect.stringContaining('No chat model is available. The AI pre-review was not started'),
    );
  });

  it('reports NoPermissions without repeating the consent dialog', async () => {
    state.settings.aiPreReview = true;
    const error = Object.assign(new Error('user declined'), { code: 'NoPermissions' });
    setModel(createModel({ failWith: error }));

    await runAiPreReview(config, undefined, controller, params());

    expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
      expect.stringContaining('Permission to use the chat model was not granted'),
    );
    expect(vscode.window.showQuickPick).not.toHaveBeenCalled();
  });

  it('reports Blocked with the cause and creates nothing', async () => {
    state.settings.aiPreReview = true;
    const error = Object.assign(new Error('quota exceeded'), { code: 'Blocked' });
    setModel(createModel({ failWith: error }));

    await runAiPreReview(config, undefined, controller, params());

    expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
      expect.stringContaining('The AI pre-review could not be completed'),
    );
    expect(await postedBodies('/reviews')).toEqual([]);
  });

  it('reports NotFound with the cause and creates nothing', async () => {
    state.settings.aiPreReview = true;
    const error = Object.assign(new Error('model is gone'), { code: 'NotFound' });
    setModel(createModel({ failWith: error }));

    await runAiPreReview(config, undefined, controller, params());

    expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
      expect.stringContaining('The AI pre-review could not be completed'),
    );
    expect(await postedBodies('/reviews')).toEqual([]);
  });

  it('treats a stream that fails with a cancellation as cancelled, not as an error', async () => {
    state.settings.aiPreReview = true;
    setModel(createModel({ streamFailWith: Object.assign(new Error('cancelled'), { name: 'AbortError' }) }));

    await runAiPreReview(config, undefined, controller, params());

    expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(
      expect.stringContaining('was cancelled. No comments were created'),
    );
    expect(await postedBodies('/reviews')).toEqual([]);
  });

  it('reports an unparseable answer and creates nothing', async () => {
    state.settings.aiPreReview = true;
    setModel(createModel({ answer: 'I think this looks fine overall.' }));

    await runAiPreReview(config, undefined, controller, params());

    expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(expect.stringContaining('could not be parsed'));
    expect(await postedBodies('/reviews')).toEqual([]);
  });
});

describe('the model is chosen by its input budget, not by list order', () => {
  it('uses the first offered model that can hold the whole request', async () => {
    state.settings.aiPreReview = true;
    const tiny = createModel({ answer: '{"comments":[]}', maxInputTokens: 200 });
    const large = createModel({ answer: '{"comments":[]}', maxInputTokens: 128_000 });
    // `tiny` comes first, which is exactly what the old `models[0]` did.
    setModels(tiny, large);

    await runAiPreReview(config, undefined, controller, params());

    expect(large.sendRequest).toHaveBeenCalledTimes(1);
    expect(tiny.sendRequest).not.toHaveBeenCalled();
  });

  it('skips a model that cannot hold even the instructions and uses the next one', async () => {
    state.settings.aiPreReview = true;
    const nano = createModel({ answer: '{"comments":[]}', maxInputTokens: 5 });
    const large = createModel({ answer: '{"comments":[]}', maxInputTokens: 8_000 });
    // `countTokens` reports 10 for every text, so nano's 5-token budget cannot
    // take the instructions and large's 8_000 can.
    setModels(nano, large);

    await runAiPreReview(config, undefined, controller, params());

    expect(large.sendRequest).toHaveBeenCalledTimes(1);
    expect(nano.sendRequest).not.toHaveBeenCalled();
    expect(vscode.window.showErrorMessage).not.toHaveBeenCalled();
  });

  it('says how many models were offered and the largest budget when none can hold the instructions', async () => {
    state.settings.aiPreReview = true;
    // Both are smaller than the 10 tokens the instructions cost, and the HTTP
    // mocks are never reached: the check runs before the first request.
    setModels(createModel({ maxInputTokens: 5 }), createModel({ maxInputTokens: 10 }));

    await runAiPreReview(config, undefined, controller, params());

    expect(captured).toEqual([]);
    expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
      expect.stringContaining('none of the 2 chat model(s) VS Code offered can take its instructions'),
    );
    expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
      expect.stringContaining('the largest input budget is 10 tokens'),
    );
    // Both remedies the user can act on, the guarantee that nothing left, and
    // the one action that cannot help said out loud.
    expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
      expect.stringContaining('Choose a model with a larger input budget in the chat model picker'),
    );
    expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
      expect.stringContaining('shrinks the request but not the instructions'),
    );
    expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
      expect.stringContaining('Nothing was sent and nothing was created.'),
    );
  });
});

describe('progress and cancellation (§6.2)', () => {
  /** Runs one case with a `withProgress` that records what the run reported. */
  async function runWithReportedProgress(): Promise<{ titles: string[]; options: Record<string, unknown> }> {
    const titles: string[] = [];
    let options: Record<string, unknown> = {};
    vi.mocked(vscode.window.withProgress).mockImplementation((async (
      received: Record<string, unknown>,
      task: (progress: unknown, token: unknown) => unknown,
    ) => {
      options = received;
      return await task(
        { report: (value: { message?: string }) => titles.push(String(value.message)) },
        {
          isCancellationRequested: state.cancelRequested,
          onCancellationRequested: vi.fn(() => ({ dispose: vi.fn() })),
        },
      );
    }) as never);
    await runAiPreReview(config, undefined, controller, params());
    return { titles, options };
  }

  it('wraps the run in one cancellable notification and names the phase it is in', async () => {
    state.settings.aiPreReview = true;
    setModel(createModel({ answer: '{"comments":[]}' }));

    const { titles, options } = await runWithReportedProgress();

    expect(options).toMatchObject({
      location: vscode.ProgressLocation.Notification,
      cancellable: true,
    });
    expect(titles).toEqual(['Reading the pull request…', 'Asking the chat model for review comments…']);
  });

  it('cancelling shows the documented sentence and writes nothing', async () => {
    state.settings.aiPreReview = true;
    state.cancelRequested = true;
    const model = createModel({ answer: '{"comments":[]}' });
    setModel(model);

    await runWithReportedProgress();

    expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(
      expect.stringContaining('The AI pre-review was cancelled. No comments were created.'),
    );
    // Nothing reached the model and nothing reached the server.
    expect(model.sendRequest).not.toHaveBeenCalled();
    expect(await postedBodies('/reviews')).toEqual([]);
    expect(await postedBodies('/comments')).toEqual([]);
    expect(vscode.window.showQuickPick).not.toHaveBeenCalled();
  });
});

describe('what the prompt contains in each mode', () => {
  const answer = '{"comments":[]}';

  it('sends the brief only, with comment metadata and no diff body, by default', async () => {
    state.settings.aiPreReview = true;
    const model = createModel({ answer });
    setModel(model);

    await runAiPreReview(config, undefined, controller, params());

    const prompt = sentPrompt(model);
    expect(prompt).toContain('src/index.ts');
    expect(prompt).toContain('+10 -2');
    expect(prompt).toContain('modified');
    expect(prompt).toContain('demo-user');
    // Metadata of an existing review comment, never its body.
    expect(prompt).toContain('[existing-review-comment-metadata]');
    expect(prompt).not.toContain('Consider renaming this variable');
    // No diff body, and none of the leak-prone fields the record excludes.
    expect(prompt).not.toContain('[diff]');
    expect(prompt).not.toContain("console.log('hello')");
    expect(prompt).not.toContain('forgejo.example.com');
    expect(prompt).not.toContain('This PR adds a dark mode toggle');
  });

  it('adds the diff body when the second switch is on', async () => {
    state.settings.aiPreReview = true;
    state.settings.aiPreReviewIncludeDiff = true;
    const model = createModel({ answer });
    setModel(model);

    await runAiPreReview(config, undefined, controller, params());

    const prompt = sentPrompt(model);
    expect(prompt).toContain('[diff]');
    expect(prompt).toContain('--- src/index.ts ---');
    expect(prompt).toContain("+console.log('hello');");
    expect(prompt).toContain('src/index.ts');
  });

  it('still sends only the brief when the feature switch is on and the diff switch is not', async () => {
    state.settings.aiPreReview = true;
    state.settings.aiPreReviewIncludeDiff = false;
    const model = createModel({ answer });
    setModel(model);

    await runAiPreReview(config, undefined, controller, params());

    expect(sentPrompt(model)).not.toContain('[diff]');
  });
});

describe('the prompt budget drops whole files', () => {
  /**
   * A diff of two files, so the file-granularity cut has something to drop.
   * The default handlers serve a one-file pull request, so the second changed
   * file is added to the response for these cases only.
   */
  const otherFileBlock = `diff --git a/src/other.ts b/src/other.ts
index 3333333..4444444 100644
--- a/src/other.ts
+++ b/src/other.ts
@@ -1 +1,2 @@
 export const other = 1;
+export const extra = 2;
`;

  function serveTwoFiles(): void {
    mockServer.use(
      http.get('https://*/api/v1/repos/:owner/:repo/pulls/:index/files', ({ request }) =>
        HttpResponse.json(
          paginateForTest(request, [
            { filename: 'src/index.ts', status: 'modified', additions: 10, deletions: 2, changes: 12 },
            { filename: 'src/other.ts', status: 'modified', additions: 1, deletions: 0, changes: 1 },
          ]),
        ),
      ),
      http.get(
        'https://*/api/v1/repos/:owner/:repo/pulls/:index.diff',
        () => new HttpResponse(`${MOCK_DIFF}${otherFileBlock}`, { headers: { 'Content-Type': 'text/plain' } }),
      ),
    );
  }

  it('drops files by granularity, notes the truncation, and still runs', async () => {
    state.settings.aiPreReview = true;
    serveTwoFiles();
    const model = createModel({ answer: '{"comments":[]}' });
    // A budget that fits the header and one file row but not two: the run has
    // to drop a whole file rather than send a prompt the model cannot take.
    model.countTokens = vi.fn(async (text: string) => (text.match(/^- src\//gm) ?? []).length * 10 + 10) as never;
    model.maxInputTokens = 40;
    setModel(model);

    await runAiPreReview(config, undefined, controller, params());

    expect(model.sendRequest).toHaveBeenCalledTimes(1);
    const prompt = sentPrompt(model);
    expect(prompt).toContain('truncatedBy=token-budget');
    expect(prompt).toContain('src/index.ts');
    expect(prompt).not.toContain('src/other.ts');
    // The cut removes files, never the contract: the same request still states
    // the JSON shape the answer is parsed against and says the list is partial.
    expect(prompt).toContain(
      '{"comments":[{"path":string,"line":number,"side":"head"|"base","extraLines":number,"body":string}]}',
    );
    expect(prompt).toContain('strict JSON only');
    expect(prompt).toContain('[truncated: the file list is incomplete (truncatedBy=token-budget)');
  });

  it('names what it needed and what was available when the request cannot fit', async () => {
    state.settings.aiPreReview = true;
    const model = createModel();
    // The instructions are cheap and the brief is not, which is the only way to
    // reach this arm now that the model is chosen by budget: a model that cannot
    // hold the instructions never gets this far.
    model.countTokens = vi.fn(countInstructionsCheaply()) as never;
    model.maxInputTokens = 1_000;
    setModel(model);

    await runAiPreReview(config, undefined, controller, params());

    expect(model.sendRequest).not.toHaveBeenCalled();
    // 10 instruction tokens + 10_000 for the brief, against a 1_000 budget, with
    // the offered-model facts beside it.
    expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
      expect.stringContaining('10010 tokens needed, 1000 available'),
    );
    expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
      expect.stringContaining('among the 1 model(s) offered is 1000'),
    );
    expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
      expect.stringContaining('Turn off the setting "forgejoToolkit.aiPreReviewIncludeDiff"'),
    );
    expect(await postedBodies('/reviews')).toEqual([]);
  });
});

describe('the confirmation flow', () => {
  const validAnswer = JSON.stringify({
    comments: [
      { path: 'src/index.ts', line: 2, side: 'head', extraLines: 0, body: 'This logs on every call.' },
      { path: 'src/index.ts', line: 1, side: 'base', extraLines: 0, body: 'The old first line is gone.' },
    ],
  });

  it('shows every candidate with nothing pre-selected and lets the user dismiss the list', async () => {
    state.settings.aiPreReview = true;
    setModel(createModel({ answer: validAnswer }));
    vi.mocked(vscode.window.showQuickPick).mockResolvedValue(undefined as never);

    await runAiPreReview(config, undefined, controller, params());

    const items = offeredItems();
    expect(items).toHaveLength(2);
    expect(items[0].label).toContain('src/index.ts:2 (head)');
    expect(items[1].label).toContain('src/index.ts:1 (base)');
    for (const item of items) {
      expect(item).not.toHaveProperty('picked');
    }
    expect(await postedBodies('/reviews')).toEqual([]);
    expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(
      expect.stringContaining('was cancelled. No comments were created'),
    );
  });

  it('writes only the confirmed comments and never submits a review', async () => {
    state.settings.aiPreReview = true;
    setModel(createModel({ answer: validAnswer }));
    pickFirst();

    await runAiPreReview(config, undefined, controller, params());

    const created = await postedBodies('/reviews');
    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({ event: 'PENDING', body: '.', comments: [{ new_position: 2 }] });
    // Exactly one review was opened and no second comment was appended: the
    // user confirmed one of the two candidates.
    expect(await postedBodies('/comments')).toEqual([]);
    // The only request to `/reviews/...` routes is the list read; nothing
    // submitted (`POST /reviews/{id}`) and nothing was deleted.
    expect(captured.filter((entry) => /\/reviews\/\d+$/.test(entry.path))).toEqual([]);
    expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(
      expect.stringContaining('Started a pending review with 1 draft comment(s)'),
    );
  });

  it('writes nothing when the user confirms nothing', async () => {
    state.settings.aiPreReview = true;
    setModel(createModel({ answer: validAnswer }));
    vi.mocked(vscode.window.showQuickPick).mockResolvedValue([] as never);

    await runAiPreReview(config, undefined, controller, params());

    expect(await postedBodies('/reviews')).toEqual([]);
    expect(await postedBodies('/comments')).toEqual([]);
  });

  it('appends to an existing pending review instead of opening a second one', async () => {
    state.settings.aiPreReview = true;
    setModel(createModel({ answer: validAnswer }));
    // Seed the server state the way the interactive path does: one PENDING
    // review already exists for this user, so the run must not open a second.
    const seeded = await fetch('https://forgejo.example.com/api/v1/repos/demo-user/demo-repo/pulls/2/reviews', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ event: 'PENDING', body: '.', comments: [] }),
    });
    expect(seeded.status).toBe(200);
    vi.mocked(controller.findPendingReview).mockResolvedValue(100);
    pickFirst();

    await runAiPreReview(config, undefined, controller, params());

    // The seeding request is the only `POST .../reviews` in this test: the run
    // itself opened no second review.
    const openedReviews = (await postedBodies('/reviews')).filter((body) => (body.comments as unknown[])?.length !== 0);
    expect(openedReviews).toEqual([]);
    const appended = await postedBodies('/comments');
    expect(appended).toHaveLength(1);
    expect(appended[0]).toMatchObject({ new_position: 2, body: 'This logs on every call.' });
    expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(
      expect.stringContaining('existing pending review #100'),
    );
  });

  it('stops without writing when the pending-review lookup itself fails', async () => {
    state.settings.aiPreReview = true;
    setModel(createModel({ answer: validAnswer }));
    vi.mocked(controller.findPendingReview).mockRejectedValue(new Error('reviews unavailable'));
    pickFirst();

    await runAiPreReview(config, undefined, controller, params());

    expect(await postedBodies('/reviews')).toEqual([]);
    expect(await postedBodies('/comments')).toEqual([]);
    expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
      expect.stringContaining('could not check for an existing pending review'),
    );
  });
});

describe('anchor and field validation', () => {
  it('drops a bad anchor and a bad field, counts them, and writes the rest', async () => {
    state.settings.aiPreReview = true;
    setModel(
      createModel({
        answer: JSON.stringify({
          comments: [
            { path: 'src/index.ts', line: 2, side: 'head', extraLines: 0, body: 'Valid one.' },
            // Line 99 is nowhere in the diff.
            { path: 'src/index.ts', line: 99, side: 'head', extraLines: 0, body: 'Off the file.' },
            // A path the brief never listed.
            { path: 'src/other.ts', line: 1, side: 'head', extraLines: 0, body: 'Wrong file.' },
            // Empty body.
            { path: 'src/index.ts', line: 1, side: 'head', extraLines: 0, body: '   ' },
          ],
        }),
      }),
    );
    pickFirst();

    await runAiPreReview(config, undefined, controller, params());

    const items = offeredItems();
    expect(items).toHaveLength(1);
    expect(await postedBodies('/reviews')).toHaveLength(1);
    expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(
      expect.stringContaining('line not in the diff x1'),
    );
    expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(
      expect.stringContaining('path not in the changed files x1'),
    );
    expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(expect.stringContaining('empty body x1'));
  });

  it('never moves, flips or clamps a rejected anchor', async () => {
    state.settings.aiPreReview = true;
    setModel(
      createModel({
        answer: JSON.stringify({
          comments: [
            // Line 3 is a context line of the hunk, so it exists on the head
            // side only: the base side of the same file line number is a
            // different position, and the candidate must be dropped rather than
            // flipped.
            { path: 'src/index.ts', line: 3, side: 'base', extraLines: 0, body: 'Base side of a head-only line.' },
            { path: 'src/index.ts', line: 1, side: 'head', extraLines: 5, body: 'Range runs past the hunk.' },
          ],
        }),
      }),
    );

    await runAiPreReview(config, undefined, controller, params());

    expect(vscode.window.showQuickPick).not.toHaveBeenCalled();
    expect(await postedBodies('/reviews')).toEqual([]);
    expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(
      expect.stringContaining('line not in the diff x1'),
    );
    expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(expect.stringContaining('invalid line range x1'));
  });
});

describe('the write loop keeps what it already created', () => {
  const candidates = [
    { path: 'src/index.ts', line: 2, side: 'head' as const, extraLines: 0, body: 'First.' },
    { path: 'src/index.ts', line: 1, side: 'head' as const, extraLines: 0, body: 'Second.' },
  ];
  const target = { owner: 'demo-user', repo: 'demo-repo', index: 2 };

  it('creates the review with the first comment and appends the rest', async () => {
    const client = {
      createPendingPullReview: vi.fn(async () => ({ id: 42 })),
      addPullReviewComment: vi.fn(async () => ({})),
    };

    const outcome = await writePreReviewDrafts(client as never, target, undefined, candidates);

    expect(outcome).toEqual({ written: 2 });
    expect(client.createPendingPullReview).toHaveBeenCalledTimes(1);
    expect(client.addPullReviewComment).toHaveBeenCalledTimes(1);
    expect(client.addPullReviewComment).toHaveBeenCalledWith('demo-user', 'demo-repo', 2, 42, {
      body: 'Second.',
      path: 'src/index.ts',
      new_position: 1,
    });
  });

  it('appends every comment when a pending review already exists', async () => {
    const client = {
      createPendingPullReview: vi.fn(async () => ({ id: 42 })),
      addPullReviewComment: vi.fn(async () => ({})),
    };

    const outcome = await writePreReviewDrafts(client as never, target, 77, candidates);

    expect(outcome).toEqual({ written: 2 });
    expect(client.createPendingPullReview).not.toHaveBeenCalled();
    expect(client.addPullReviewComment).toHaveBeenCalledTimes(2);
    expect(client.addPullReviewComment).toHaveBeenNthCalledWith(
      1,
      'demo-user',
      'demo-repo',
      2,
      77,
      expect.objectContaining({ body: 'First.' }),
    );
  });

  it('keeps the drafts already written when a later one fails', async () => {
    const client = {
      createPendingPullReview: vi.fn(async () => ({ id: 42 })),
      addPullReviewComment: vi.fn(async () => {
        throw new Error('server said no');
      }),
    };

    const outcome = await writePreReviewDrafts(client as never, target, undefined, candidates);

    expect(outcome.written).toBe(1);
    expect(outcome.failure?.reason).toContain('server said no');
    // The first draft is not rolled back: there is no delete call anywhere in
    // this path, by design (§6.4).
    expect(client.createPendingPullReview).toHaveBeenCalledTimes(1);
    expect('deletePullReviewComment' in client).toBe(false);
  });

  it('stops when the created review has no id, keeping the first draft', async () => {
    const client = {
      createPendingPullReview: vi.fn(async () => ({})),
      addPullReviewComment: vi.fn(async () => ({})),
    };

    const outcome = await writePreReviewDrafts(client as never, target, undefined, candidates);

    expect(outcome.written).toBe(1);
    expect(outcome.failure?.reason).toContain('did not return the new review id');
    expect(client.addPullReviewComment).not.toHaveBeenCalled();
  });

  it('maps a base-side candidate to old_position', async () => {
    const client = {
      createPendingPullReview: vi.fn(async () => ({ id: 42 })),
      addPullReviewComment: vi.fn(async () => ({})),
    };

    await writePreReviewDrafts(client as never, target, undefined, [
      { path: 'src/index.ts', line: 2, side: 'base', extraLines: 1, body: 'Old side.' },
    ]);

    expect(client.createPendingPullReview).toHaveBeenCalledWith('demo-user', 'demo-repo', 2, {
      body: 'Old side.',
      path: 'src/index.ts',
      old_position: 2,
      extra_lines_count: 1,
    });
  });
});
