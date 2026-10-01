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
   * Every configuration write the code under test made. The model pick is
   * stored through a normal configuration update at global scope, so these are
   * the writes that prove "the choice is the source of truth" — key, value and
   * target alike.
   */
  settingUpdates: [] as Array<{ key: string; value: unknown; target?: unknown }>,
  /**
   * Whether the progress notification's cancellation token starts out cancelled.
   * The mock hands the run a token whose `isCancellationRequested` reads this, so
   * a case can cancel the run without a real notification.
   */
  cancelRequested: false,
  /**
   * The command handlers `registerAiPreReviewCommand` registered, by id. The
   * probe is reached through the command in the real extension, so one case
   * asserts it is registered at all; the behavioural cases call the exported
   * function directly rather than through a fire-and-forget handler.
   */
  registeredCommands: new Map<string, (...args: unknown[]) => unknown>(),
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
        // The model pick is stored as an ordinary configuration update at global
        // scope, so the mock records the write *and* applies it: a case that runs
        // the flow twice then sees the second run read what the first one stored,
        // which is the behaviour "the same model is used without asking" means.
        update: vi.fn(async (key: string, value: unknown, target?: unknown) => {
          state.settingUpdates.push({ key, value, target });
          state.settings[key] = value;
        }),
      })),
      onDidChangeConfiguration: vi.fn(() => ({ dispose: vi.fn() })),
      onDidChangeWorkspaceFolders: vi.fn(() => ({ dispose: vi.fn() })),
      textDocuments: [],
      workspaceFolders: [],
    },
    ConfigurationTarget: { Global: 1, Workspace: 2, WorkspaceFolder: 3 },
    commands: {
      executeCommand: vi.fn(),
      registerCommand: vi.fn((id: string, handler: (...args: unknown[]) => unknown) => {
        state.registeredCommands.set(id, handler);
        return { dispose: vi.fn() };
      }),
    },
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
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { http, HttpResponse } from 'msw';
import { mockServer, startMockServer, stopMockServer } from '../test/mocks/server';
import { resetMockState } from '../test/mocks/handlers';
import { mockInstance } from '../test/mocks/data/instances';
import { mockPullRequestDiff as MOCK_DIFF } from '../test/mocks/data/pullRequestExtras';
import {
  AI_PRE_REVIEW_PROBE_PROMPT,
  COMMAND_AI_PRE_REVIEW_CHOOSE_MODEL,
  COMMAND_AI_PRE_REVIEW_PROBE,
  aiPreReviewProbeShapes,
  chooseAiPreReviewModel,
  probeAiPreReviewChatModels,
  registerAiPreReviewCommand,
  runAiPreReview,
  writePreReviewDrafts,
} from '../aiPreReview';
import { AI_PRE_REVIEW_SYSTEM_PROMPT } from '../aiPreReviewBrief';
import { parseAiPreReviewModelSelector } from '../aiPreReviewSettings';
import { AI_PRE_REVIEW_DIAGNOSTICS_FILE_NAME } from '../aiPreReviewDiagnostics';
import { logger } from '../logger';
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
 *
 * The identity fields are settable because the choice is written into the
 * setting as `vendor/id` (or `vendor/family`): two candidates have to be
 * distinguishable by the value a case can then assert and feed back.
 *
 * `answers` is for the retry cases: the *n*-th call gets the *n*-th entry (the
 * last one repeats), which is what "the provider is flaky, so the same model
 * answers differently on the next call" looks like to the caller. When it is
 * absent every call gets `answer`, so a case that does not care about flakiness
 * reads exactly as it did before the retry existed.
 */
function createModel(
  options: {
    answer?: string;
    /** One answer per call; the last entry repeats. Takes precedence over `answer`. */
    answers?: readonly string[];
    tokens?: number;
    maxInputTokens?: number;
    failWith?: unknown;
    streamFailWith?: unknown;
    name?: string;
    id?: string;
    vendor?: string;
    family?: string;
  } = {},
) {
  const answer = options.answer ?? '{"comments":[]}';
  let callIndex = 0;
  return {
    name: options.name ?? 'Fake Model',
    id: options.id ?? 'fake-model',
    vendor: options.vendor ?? 'fake',
    family: options.family ?? 'fake',
    version: '1',
    maxInputTokens: options.maxInputTokens ?? 128_000,
    countTokens: vi.fn(async () => options.tokens ?? 10),
    sendRequest: vi.fn(async () => {
      if (options.failWith) {
        throw options.failWith;
      }
      const sequence = options.answers;
      const text = sequence ? (sequence[Math.min(callIndex, sequence.length - 1)] ?? answer) : answer;
      callIndex += 1;
      return {
        text: (async function* () {
          if (options.streamFailWith) {
            throw options.streamFailWith;
          }
          yield text;
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

/** Every configuration write made so far, in order. */
function settingUpdates(): Array<{ key: string; value: unknown; target?: unknown }> {
  return state.settingUpdates;
}

/**
 * How many of these models were asked anything at all. The no-rotation cases are
 * built on this: one chosen model may be asked twice, but no run may ever touch
 * a second model.
 */
function modelsCalled(models: Array<ReturnType<typeof createModel>>): number {
  return models.filter((model) => model.sendRequest.mock.calls.length > 0).length;
}

/**
 * Answers the model pick with one specific model, and every other quick pick the
 * way `pickFirst` does. Used by the cases that are about what the user chose.
 */
function pickModel(wanted: ReturnType<typeof createModel>): void {
  vi.mocked(vscode.window.showQuickPick).mockImplementation(async (items, options) => {
    const resolved = (await items) as unknown as Array<{ model?: unknown }>;
    const title = String((options as { title?: unknown } | undefined)?.title ?? '');
    if (title.includes('which chat model')) {
      return (resolved.find((item) => item.model === wanted) ?? resolved[0]) as never;
    }
    return (resolved.length > 0 ? [resolved[0]] : []) as never;
  });
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
 * `role` is optional because the fake always sets it and a future fake might
 * not — the request-shape case asserts it is `'user'` precisely so the fake
 * cannot hide a change of role.
 */
type SendRequestMock = { mock: { calls: Array<[Array<{ role?: string; content: string }>, ...unknown[]]> } };

/** The concatenation of both prompt messages the model was handed. */
function sentPrompt(model: ReturnType<typeof createModel>): string {
  const messages = (model.sendRequest as unknown as SendRequestMock).mock.calls[0]?.[0] ?? [];
  return messages.map((message) => message.content).join('\n');
}

/** The quick-pick call whose title is the model picker, if the run made one. */
function modelPickCall(): { items: Array<{ label: string; description?: string; detail?: string }> } | undefined {
  const call = vi
    .mocked(vscode.window.showQuickPick)
    .mock.calls.find(([, options]) =>
      String((options as { title?: unknown } | undefined)?.title ?? '').includes('which chat model'),
    );
  return call === undefined
    ? undefined
    : { items: (call[0] ?? []) as unknown as Array<{ label: string; description?: string; detail?: string }> };
}

/**
 * The quick-pick items of one **candidate** list, in order.
 *
 * The model pick and the confirmation list are both `showQuickPick` calls, so
 * the index alone would silently read the wrong one; the call is found by its
 * title instead. `callIndex` still orders the candidate lists among themselves,
 * because a run shows at most one.
 */
function offeredItems(callIndex = 0): Array<{ label: string; picked?: boolean }> {
  const calls = vi
    .mocked(vscode.window.showQuickPick)
    .mock.calls.filter(
      ([, options]) => !String((options as { title?: unknown } | undefined)?.title ?? '').includes('which chat model'),
    );
  const call = calls[callIndex];
  const items = (call?.[0] ?? []) as unknown as Array<{ label: string; picked?: boolean }>;
  return items;
}

/**
 * A quick pick that selects the first offered item, shaped like the call it is
 * answering: the model pick wants one item back and the confirmation list an
 * array (its multi-select would reject a single item). Installed by default for
 * the model pick so a case with several offered models and no configured one
 * still exercises the model it would otherwise ask about, and reused by the
 * cases that confirm a candidate.
 */
function pickFirst(): void {
  vi.mocked(vscode.window.showQuickPick).mockImplementation(async (items, options) => {
    const resolved = (await items) as unknown as unknown[];
    const title = String((options as { title?: unknown } | undefined)?.title ?? '');
    if (title.includes('which chat model')) {
      return (resolved.length > 0 ? resolved[0] : undefined) as never;
    }
    return (resolved.length > 0 ? [resolved[0]] : []) as never;
  });
}

/**
 * Every line the run handed to the logger, at any level.
 *
 * The spies keep calling through to the real `Logger`, so the debug gate is
 * still the extension's own (`forgejoToolkit.debug`); what they add is the
 * ability to read the strings, including the debug ones that a test run — with
 * debug off — would never see in the output channel. `vi.clearAllMocks()` in
 * `beforeEach` resets the call history between cases.
 */
function loggedLines(): string[] {
  return [
    ...vi.mocked(logger.debug).mock.calls,
    ...vi.mocked(logger.info).mock.calls,
    ...vi.mocked(logger.error).mock.calls,
  ].map(([message]) => String(message));
}

/**
 * Temp log directories the dump cases created, removed by the suite's
 * `afterEach`. The dump tests need a real directory: the point of two of them is
 * that the file is *not* there when debug is off.
 */
const logDirs: string[] = [];

/** Turns `forgejoToolkit.debug` on for one case, which is what opens the dump. */
function debugging(): void {
  vi.spyOn(logger, 'isDebugEnabled').mockReturnValue(true);
}

beforeEach(async () => {
  state.settings = {};
  state.settingUpdates = [];
  state.cancelRequested = false;
  state.registeredCommands.clear();
  captured.length = 0;
  pendingReads.length = 0;
  vi.clearAllMocks();
  // The MSW fixtures keep mutable session state (a PENDING review, for one), and
  // this suite has cases that write drafts. Resetting it here is what keeps a
  // later case's brief independent of an earlier case's writes.
  resetMockState();
  vi.spyOn(logger, 'debug');
  vi.spyOn(logger, 'info');
  vi.spyOn(logger, 'error');
  // The dump is opened by this switch, so every case starts from "off" and the
  // cases that want it call `debugging()`. Set here rather than only in the mock
  // because the Logger caches the setting it read at construction.
  vi.spyOn(logger, 'isDebugEnabled').mockReturnValue(false);
  vi.mocked(controller.findPendingReview).mockResolvedValue(undefined);
  // The default answer to the model pick: a case that offers several models
  // with nothing configured would otherwise stop at a dismissed pick and never
  // reach what it is asserting about. Cases that are about the dismissal (or
  // about the candidate list) install their own implementation.
  pickFirst();
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
  for (const directory of logDirs.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
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
    state.settings.aiPreReviewModel = 'fake/declined-model';
    const error = Object.assign(new Error('user declined'), { code: 'NoPermissions' });
    const model = createModel({ failWith: error, id: 'declined-model', family: 'declined-model' });
    setModel(model);

    await runAiPreReview(config, undefined, controller, params());

    expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
      expect.stringContaining('Permission to use the chat model was not granted'),
    );
    // The consent answer applies to the rest of the run: one call, no retry.
    expect(model.sendRequest).toHaveBeenCalledTimes(1);
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

  it('reports an answer that is not JSON and creates nothing', async () => {
    state.settings.aiPreReview = true;
    setModel(createModel({ answer: 'I think this looks fine overall.' }));

    await runAiPreReview(config, undefined, controller, params());

    expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(expect.stringContaining('the answer was not JSON'));
    expect(await postedBodies('/reviews')).toEqual([]);
  });
});

/**
 * The chosen model is **validated, never substituted** (§7.2). The fixed
 * instruction prompt is a constant, so whether the chosen model can hold it is
 * answered before anything is read — and a model that cannot hold it ends the
 * run with both numbers rather than being swapped for a larger one.
 *
 * The old behaviour this replaces was an automatic choice: the run picked the
 * offered model with the largest budget that could take the request. The
 * maintainer rejected that in every form, so the cases here assert the other
 * direction — the numbers are reported and the run stops — including that the
 * larger model sitting right next to the chosen one is never called.
 */
describe('the chosen model is validated, never substituted (§7.2)', () => {
  it('refuses a chosen model that cannot hold the instruction prompt, with both numbers', async () => {
    state.settings.aiPreReview = true;
    state.settings.aiPreReviewModel = 'fake/tiny';
    const tiny = createModel({ id: 'tiny', family: 'tiny', maxInputTokens: 5 });
    const large = createModel({ id: 'large', family: 'large', maxInputTokens: 128_000 });
    setModels(tiny, large);

    await runAiPreReview(config, undefined, controller, params());

    // Nothing was read, nothing was asked — not even the model that would fit.
    expect(captured).toEqual([]);
    expect(tiny.sendRequest).not.toHaveBeenCalled();
    expect(large.sendRequest).not.toHaveBeenCalled();
    expect(modelsCalled([tiny, large])).toBe(0);
    expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
      expect.stringContaining('cannot hold its fixed instruction prompt'),
    );
    // `countTokens` reports 10 for every text, and `tiny`'s budget is 5.
    expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
      expect.stringContaining('10 tokens are needed and its input budget is 5'),
    );
    expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
      expect.stringContaining('Fake Model (vendor=fake, family=tiny, id=tiny)'),
    );
    expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
      expect.stringContaining('no other model was substituted'),
    );
    // The remedy is the user's: the command that changes the stored choice.
    expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
      expect.stringContaining('forgejoToolkit.aiPreReviewChooseModel'),
    );
    // And the one action that cannot help is said out loud.
    expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
      expect.stringContaining('shrinks the request but not the instructions'),
    );
  });

  it('refuses when the chosen model will not measure the instructions, and still substitutes nothing', async () => {
    state.settings.aiPreReview = true;
    state.settings.aiPreReviewModel = 'fake/unmeasurable';
    const unmeasurable = createModel({ id: 'unmeasurable', family: 'unmeasurable' });
    unmeasurable.countTokens.mockRejectedValue(new Error('no tokenizer here'));
    const large = createModel({ id: 'large', family: 'large', maxInputTokens: 128_000 });
    setModels(unmeasurable, large);

    await runAiPreReview(config, undefined, controller, params());

    expect(captured).toEqual([]);
    expect(unmeasurable.sendRequest).not.toHaveBeenCalled();
    expect(large.sendRequest).not.toHaveBeenCalled();
    expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
      expect.stringContaining('would not measure its fixed instruction prompt'),
    );
    expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
      expect.stringContaining('no other model was substituted'),
    );
  });

  it('still asks, and still refuses, when every offered model is too small for the instructions', async () => {
    state.settings.aiPreReview = true;
    // Nothing is configured, so the question is asked — of every offered model,
    // including the two that cannot hold the instructions. The run then refuses
    // the answer it was given instead of quietly picking something else.
    const first = createModel({ id: 'small-a', family: 'small-a', maxInputTokens: 5 });
    const second = createModel({ id: 'small-b', family: 'small-b', maxInputTokens: 10 });
    setModels(first, second);

    await runAiPreReview(config, undefined, controller, params());

    expect(modelPickCall()?.items).toHaveLength(2);
    expect(captured).toEqual([]);
    expect(modelsCalled([first, second])).toBe(0);
    expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
      expect.stringContaining('cannot hold its fixed instruction prompt'),
    );
  });

  it('uses a chosen model that fits, with the instruction measurement in the log', async () => {
    state.settings.aiPreReview = true;
    state.settings.aiPreReviewModel = 'fake/roomy';
    const roomy = createModel({ answer: '{"comments":[]}', id: 'roomy', family: 'roomy', maxInputTokens: 8_000 });
    setModels(roomy);

    await runAiPreReview(config, undefined, controller, params());

    expect(roomy.sendRequest).toHaveBeenCalledTimes(1);
    expect(vscode.window.showErrorMessage).not.toHaveBeenCalled();
    expect(loggedLines()).toContainEqual(expect.stringContaining('the fixed instruction prompt costs 10 token(s)'));
  });
});

/**
 * `forgejoToolkit.aiPreReviewModel` (§7.2): the user names the model, this
 * feature stops choosing on its own, and a value it cannot honour refuses the
 * run instead of being quietly dropped.
 *
 * The pure parsing cases run against `parseAiPreReviewModelSelector` directly;
 * everything else goes through the command, because what matters is the user's
 * setting producing a refusal, a selector, or a picker — not the intermediate
 * object.
 */
describe('the configured chat model (§7.2)', () => {
  /** The one refusal message the run shows, with its arguments filled in. */
  function refusalMessage(): string {
    return vi
      .mocked(vscode.window.showErrorMessage)
      .mock.calls.map(([message]) => String(message))
      .join('\n');
  }

  describe('parsing the accepted forms', () => {
    it('reads vendor/family and vendor/id into the same selector', () => {
      for (const value of ['deepseek/deepseek-flash', 'copilot/gpt-4o']) {
        expect(parseAiPreReviewModelSelector(value)).toEqual({
          vendor: value.split('/')[0],
          family: value.split('/')[1],
          id: value.split('/')[1],
        });
      }
    });

    it('trims and lower-cases, so letter case and stray spaces do not matter', () => {
      expect(parseAiPreReviewModelSelector('  DeepSeek / DeepSeek-Flash  ')).toEqual({
        vendor: 'deepseek',
        family: 'deepseek-flash',
        id: 'deepseek-flash',
      });
    });

    it('accepts an optional @version suffix, splitting it from the right', () => {
      expect(parseAiPreReviewModelSelector('copilot/gpt-4o@1.2.3')).toEqual({
        vendor: 'copilot',
        family: 'gpt-4o',
        id: 'gpt-4o',
        version: '1.2.3',
      });
      // A selector with no version names no version, rather than defaulting one.
      expect(parseAiPreReviewModelSelector('copilot/gpt-4o')).not.toHaveProperty('version');
    });

    it('refuses to guess at anything else', () => {
      const garbage = [
        '',
        '   ',
        'deepseek-flash',
        '/deepseek-flash',
        'deepseek/',
        'deepseek',
        'deepseek/flash/extra',
        'deepseek/@1.0',
        'deepseek/flash@',
        'a/b@1@2/3',
      ];
      expect(garbage.map((value) => parseAiPreReviewModelSelector(value))).toEqual(garbage.map(() => undefined));
    });
  });
  describe('a configured model is used, and no other model is ever called', () => {
    it('uses the configured model without asking and without passing a selector to the editor', async () => {
      state.settings.aiPreReview = true;
      state.settings.aiPreReviewModel = ' DeepSeek / DeepSeek-Flash ';
      // The configured model is last in the editor's list, and two other models
      // are offered beside it: no ordering, no fallback and no pick may move the
      // run onto either of them.
      const otherVendor = createModel({ id: 'other', vendor: 'openai', family: 'gpt-4o' });
      const otherFamily = createModel({ id: 'flash-lite', vendor: 'deepseek', family: 'deepseek-flash-lite' });
      const configured = createModel({
        answer: '{"comments":[]}',
        id: 'deepseek-flash',
        vendor: 'deepseek',
        family: 'deepseek-flash',
      });
      setModels(otherVendor, otherFamily, configured);

      await runAiPreReview(config, undefined, controller, params());

      // The listing is unfiltered: the refusal message and the picker both have
      // to be able to name everything the editor offers.
      expect(vscode.lm.selectChatModels).toHaveBeenCalledWith();
      expect(configured.sendRequest).toHaveBeenCalledTimes(1);
      expect(modelsCalled([otherVendor, otherFamily, configured])).toBe(1);
      // A configured model is never a question, and nothing is written for it:
      // the setting already says it.
      expect(modelPickCall()).toBeUndefined();
      expect(settingUpdates()).toEqual([]);
      expect(loggedLines()).toContainEqual(
        expect.stringContaining('names Fake Model (vendor=deepseek, family=deepseek-flash'),
      );
    });

    it('ignores a larger budget beside it: the setting outranks budget, and the picker stays closed', async () => {
      state.settings.aiPreReview = true;
      state.settings.aiPreReviewModel = 'fake/fake-target';
      const big = createModel({ id: 'big', family: 'big', maxInputTokens: 128_000 });
      const configured = createModel({ id: 'fake-model', family: 'fake-target', maxInputTokens: 8_000 });
      setModels(big, configured);

      await runAiPreReview(config, undefined, controller, params());

      expect(configured.sendRequest).toHaveBeenCalledTimes(1);
      expect(big.sendRequest).not.toHaveBeenCalled();
      expect(modelPickCall()).toBeUndefined();
      expect(loggedLines()).toContainEqual(
        expect.stringContaining('names Fake Model (vendor=fake, family=fake-target'),
      );
    });

    it('retries the configured model twice and reports the calls it spent', async () => {
      state.settings.aiPreReview = true;
      state.settings.aiPreReviewModel = 'fake/first';
      const one = createModel({ answer: 'prose', id: 'first', name: 'One' });
      const two = createModel({ answer: '{"comments":[]}', id: 'second', name: 'Two' });
      // The configured model is listed twice, which the picker's list collapses:
      // a duplicated row would be a question with two identical answers.
      setModels(one, one, two);

      await runAiPreReview(config, undefined, controller, params());

      // The configured model is asked, and — because its answer broke the
      // contract — asked exactly once more. `two` answers with valid JSON and is
      // still never called: the run's one model is the setting's.
      expect(one.sendRequest).toHaveBeenCalledTimes(2);
      expect(two.sendRequest).not.toHaveBeenCalled();
      expect(refusalMessage()).toContain('the same question 2 time(s)');
      expect(refusalMessage()).toContain('its bound is 2 attempt(s) per run');
      expect(refusalMessage()).toContain('no other model was called');
      expect(refusalMessage()).toContain(
        'attempt 1 of 2: the answer was not JSON; attempt 2 of 2: the answer was not JSON',
      );
    });
  });

  describe('a configured model that is not offered refuses the run', () => {
    it('names the configured value and every offered model with its budget', async () => {
      state.settings.aiPreReview = true;
      state.settings.aiPreReviewModel = 'deepseek/deepseek-flash';
      const first = createModel({
        id: 'gpt-4o-mini',
        vendor: 'copilot',
        family: 'gpt-4o-mini',
        maxInputTokens: 64_000,
      });
      const second = createModel({ id: 'llama-local', vendor: 'ollama', family: 'llama', maxInputTokens: 8_192 });
      setModels(first, second);

      await runAiPreReview(config, undefined, controller, params());

      // Nothing was read, nothing was asked, nothing was created — and the
      // offered models were not even offered as a pick: the configured value is
      // an instruction, and the run refuses rather than asking a new question.
      expect(captured).toEqual([]);
      expect(first.sendRequest).not.toHaveBeenCalled();
      expect(second.sendRequest).not.toHaveBeenCalled();
      expect(modelsCalled([first, second])).toBe(0);
      expect(vscode.window.showQuickPick).not.toHaveBeenCalled();
      expect(settingUpdates()).toEqual([]);

      const message = refusalMessage();
      expect(message).toContain('"forgejoToolkit.aiPreReviewModel" is "deepseek/deepseek-flash"');
      expect(message).toContain('names no chat model VS Code offers');
      expect(message).toContain('Nothing was sent and nothing was created');
      // The list a correction needs: what to type, and what each can hold.
      expect(message).toContain('Fake Model (copilot/gpt-4o-mini, maxInputTokens=64000)');
      expect(refusalMessage()).toContain('Fake Model (ollama/llama, id=llama-local, maxInputTokens=8192)');
      // And the action that writes a valid value for the user.
      expect(message).toContain('forgejoToolkit.aiPreReviewChooseModel');
      // The channel keeps the same facts in one line.
      expect(loggedLines()).toContainEqual(
        expect.stringContaining('"forgejoToolkit.aiPreReviewModel" is set to "deepseek/deepseek-flash"'),
      );
    });

    it('refuses a value that is not an accepted form at all, still listing what is offered', async () => {
      state.settings.aiPreReview = true;
      state.settings.aiPreReviewModel = 'just-a-name';
      const offered = createModel({ id: 'gpt-4o', vendor: 'copilot', family: 'gpt-4o', maxInputTokens: 64_000 });
      setModels(offered);

      await runAiPreReview(config, undefined, controller, params());

      expect(captured).toEqual([]);
      expect(offered.sendRequest).not.toHaveBeenCalled();
      const message = refusalMessage();
      expect(message).toContain('"just-a-name"');
      expect(message).toContain('Fake Model (copilot/gpt-4o, maxInputTokens=64000)');
      expect(message).toContain('forgejoToolkit.aiPreReviewChooseModel');
      // The unparseable path is reported instead of the model pick, so a typo can
      // never end in "which model do you want".
      expect(vscode.window.showQuickPick).not.toHaveBeenCalled();
    });
  });
});

/**
 * The model question (§7.2): asked whenever the setting is empty, answered into
 * the setting, and never remembered anywhere else. There is deliberately no
 * "what the window remembers" half any more — that store was the thing the
 * maintainer rejected, and the case that used to pin it now pins the setting.
 */
describe('the model pick (§7.2)', () => {
  // These cases replace `showQuickPick`'s implementation, and this suite is
  // deliberately pooled: without restoring the default here, one case's picker
  // would answer the next case's question.
  beforeEach(() => {
    pickFirst();
  });

  it('asks whenever the setting is empty, listing every offered model with its provider and budget', async () => {
    state.settings.aiPreReview = true;
    const first = createModel({
      id: 'fake-model',
      vendor: 'deepseek',
      family: 'deepseek-flash',
      name: 'DeepSeek Flash',
    });
    const second = createModel({
      id: 'llama-local',
      vendor: 'ollama',
      family: 'llama',
      name: 'Ollama Local',
      maxInputTokens: 8_192,
    });
    setModels(first, second);

    await runAiPreReview(config, undefined, controller, params());

    const items = modelPickCall()?.items ?? [];
    expect(items).toHaveLength(2);
    // The provider that would receive the brief is in the label itself…
    expect(items[0].label).toBe('DeepSeek Flash — deepseek/deepseek-flash');
    expect(items[1].label).toBe('Ollama Local — ollama/llama');
    // …and again, spelled out, with the model id and the input budget.
    expect(items[0].description).toBe('id: fake-model');
    expect(items[0].detail).toContain('sent to the "deepseek" provider');
    expect(items[0].detail).toContain('maxInputTokens=128000');
    expect(items[1].detail).toContain('sent to the "ollama" provider');
    expect(items[1].detail).toContain('maxInputTokens=8192');
    // The default picker takes the first item, so the run continued into the
    // request rather than stopping at the question.
    expect(first.sendRequest).toHaveBeenCalledTimes(1);
  });

  it('asks even when the editor offers exactly one model: one model is not a choice the user made', async () => {
    state.settings.aiPreReview = true;
    const only = createModel({ id: 'only', family: 'only' });
    setModel(only);

    await runAiPreReview(config, undefined, controller, params());

    expect(modelPickCall()?.items).toHaveLength(1);
    expect(only.sendRequest).toHaveBeenCalledTimes(1);
    // The answer is the setting's now, so the question is not asked again.
    expect(settingUpdates()).toEqual([{ key: 'aiPreReviewModel', value: 'fake/only', target: 1 }]);
  });

  it('writes the pick into the setting and reuses it on the next run without asking', async () => {
    state.settings.aiPreReview = true;
    // Both models share a vendor and a family and differ only by id, which is
    // why the stored value is `vendor/id`: storing the family would let the next
    // run match the other model.
    const first = createModel({ id: 'first', family: 'shared', name: 'First' });
    const second = createModel({ id: 'second', family: 'shared', name: 'Second' });
    setModels(first, second);
    pickModel(second);

    await runAiPreReview(config, undefined, controller, params());

    expect(modelPickCall()).toBeDefined();
    expect(second.sendRequest).toHaveBeenCalledTimes(1);
    expect(modelsCalled([first, second])).toBe(1);
    // The choice is a normal configuration update at global scope, so the
    // Settings UI shows it and the user can edit it by hand.
    expect(settingUpdates()).toEqual([{ key: 'aiPreReviewModel', value: 'fake/second', target: 1 }]);
    expect(state.settings.aiPreReviewModel).toBe('fake/second');
    expect(loggedLines()).toContainEqual(
      expect.stringContaining('"forgejoToolkit.aiPreReviewModel" = "fake/second" was written'),
    );

    // Next run: the setting is the source of truth, so nothing is asked and the
    // same model — not its same-family sibling — is used again.
    await runAiPreReview(config, undefined, controller, params());

    const pickerCalls = vi
      .mocked(vscode.window.showQuickPick)
      .mock.calls.filter(([, options]) =>
        String((options as { title?: unknown } | undefined)?.title ?? '').includes('which chat model'),
      );
    expect(pickerCalls).toHaveLength(1);
    expect(first.sendRequest).not.toHaveBeenCalled();
    expect(second.sendRequest).toHaveBeenCalledTimes(2);
    expect(settingUpdates()).toHaveLength(1);
  });

  it('cancels the run when the pick is dismissed: zero model calls, zero requests, nothing stored', async () => {
    state.settings.aiPreReview = true;
    const first = createModel();
    const second = createModel({ id: 'second' });
    setModels(first, second);
    vi.mocked(vscode.window.showQuickPick).mockResolvedValue(undefined as never);

    await runAiPreReview(config, undefined, controller, params());

    expect(modelsCalled([first, second])).toBe(0);
    expect(captured).toEqual([]);
    expect(settingUpdates()).toEqual([]);
    expect(state.settings.aiPreReviewModel).toBeUndefined();
    const message = vi
      .mocked(vscode.window.showInformationMessage)
      .mock.calls.map(([text]) => String(text))
      .join('\n');
    expect(message).toContain('no chat model was chosen');
    expect(message).toContain('Nothing was sent and nothing was created');
  });
});

/**
 * The command that changes the stored model later — the action every refusal
 * points at. It is pure configuration: it lists, asks, stores, and sends nothing
 * to any model.
 */
describe('choosing the model later (COMMAND_AI_PRE_REVIEW_CHOOSE_MODEL)', () => {
  beforeEach(() => {
    pickFirst();
  });

  it('lists the offered models, stores the pick and says what changed', async () => {
    const first = createModel({ id: 'first', family: 'shared', name: 'First' });
    const second = createModel({ id: 'second', family: 'shared', name: 'Second' });
    setModels(first, second);
    pickModel(second);

    await chooseAiPreReviewModel();

    const items = modelPickCall()?.items ?? [];
    expect(items.map((item) => item.label)).toEqual(['First — fake/shared', 'Second — fake/shared']);
    expect(settingUpdates()).toEqual([{ key: 'aiPreReviewModel', value: 'fake/second', target: 1 }]);
    expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(
      expect.stringContaining('The setting "forgejoToolkit.aiPreReviewModel" is now "fake/second"'),
    );
    // Choosing is configuration: not one model call, not one HTTP request.
    expect(modelsCalled([first, second])).toBe(0);
    expect(captured).toEqual([]);
  });

  it('changes nothing when the pick is dismissed', async () => {
    const only = createModel({ id: 'only', family: 'only' });
    setModel(only);
    vi.mocked(vscode.window.showQuickPick).mockResolvedValue(undefined as never);

    await chooseAiPreReviewModel();

    expect(settingUpdates()).toEqual([]);
    expect(only.sendRequest).not.toHaveBeenCalled();
    expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(
      expect.stringContaining('no chat model was chosen'),
    );
  });

  it('reports that no model is available instead of storing an empty choice', async () => {
    setModels();

    await chooseAiPreReviewModel();

    expect(settingUpdates()).toEqual([]);
    expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(expect.stringContaining('No chat model is available'));
  });
});

describe('the contract failure is diagnosable (§8.1, §9.3)', () => {
  /** The one error message a contract failure shows, with its arguments filled in. */
  function failureMessage(): string {
    const calls = vi.mocked(vscode.window.showErrorMessage).mock.calls;
    return calls.map(([message]) => String(message)).join('\n');
  }

  it('says an empty answer was empty', async () => {
    state.settings.aiPreReview = true;
    setModel(createModel({ answer: '   ' }));

    await runAiPreReview(config, undefined, controller, params());

    expect(failureMessage()).toContain('the answer was empty');
    expect(loggedLines()).toContainEqual(
      expect.stringContaining(
        'AI pre-review: Fake Model (vendor=fake, family=fake, id=fake-model) returned an empty answer',
      ),
    );
    expect(await postedBodies('/reviews')).toEqual([]);
  });

  it('says a non-JSON answer was not JSON', async () => {
    state.settings.aiPreReview = true;
    setModel(createModel({ answer: 'The diff looks good to me.' }));

    await runAiPreReview(config, undefined, controller, params());

    expect(failureMessage()).toContain('the answer was not JSON');
    expect(loggedLines()).toContainEqual(expect.stringContaining('returned an answer that is not JSON'));
  });

  it('names the "comments" field when the JSON has the wrong shape', async () => {
    state.settings.aiPreReview = true;
    setModel(createModel({ answer: '{"note":"no comments here"}' }));

    await runAiPreReview(config, undefined, controller, params());

    expect(failureMessage()).toContain('its "comments" field is missing or not an array');
    expect(loggedLines()).toContainEqual(
      expect.stringContaining('returned JSON whose "comments" field is missing or not an array'),
    );
  });

  it('names the top level when the JSON is not an object at all', async () => {
    state.settings.aiPreReview = true;
    setModel(createModel({ answer: '[{"path":"src/index.ts"}]' }));

    await runAiPreReview(config, undefined, controller, params());

    expect(failureMessage()).toContain('its top level is not an object');
    expect(loggedLines()).toContainEqual(expect.stringContaining('returned JSON whose top level is not an object'));
  });

  it('logs the model identity and a bounded shape, never the answer or the diff', async () => {
    state.settings.aiPreReview = true;
    // The diff body switch is on so the brief carries the code, and the answer
    // keeps code of its own past its first line: neither may reach a log line.
    state.settings.aiPreReviewIncludeDiff = true;
    const firstLine = 'Sorry, I cannot answer in JSON.';
    const longAnswer = `${firstLine}\n${'hiddenAnswerMarker '.repeat(200)}\n${'z'.repeat(4_000)}`;
    setModel(
      createModel({ answer: longAnswer, name: 'Ollama Local', id: 'llama-local', vendor: 'ollama', family: 'llama' }),
    );

    await runAiPreReview(config, undefined, controller, params());

    const lines = loggedLines();
    const shape = lines.find((line) => line.includes('answer shape:'));
    expect(shape).toBeDefined();
    // The shape names the model and the bounded facts about the answer.
    expect(shape).toContain('Ollama Local (vendor=ollama, family=llama, id=llama-local)');
    expect(shape).toContain(`length=${longAnswer.length}`);
    expect(shape).toContain('startsWithBrace=false');
    expect(shape).toContain(JSON.stringify(firstLine));

    for (const line of lines) {
      // No diff text, no brief, no answer past its bounded prefix, and no long
      // line at all.
      expect(line).not.toContain("console.log('hello')");
      expect(line).not.toContain('hiddenAnswerMarker');
      expect(line).not.toContain('[changed-files]');
      expect(line).not.toContain('z'.repeat(200));
      expect(line.length).toBeLessThan(400);
    }
    // The bounded prefix is a debug-level diagnostic; the error line only says
    // which model failed and how.
    const errorLines = vi
      .mocked(logger.error)
      .mock.calls.map(([message]) => String(message))
      .join('\n');
    expect(errorLines).toContain('AI pre-review: Ollama Local (vendor=ollama, family=llama, id=llama-local)');
    expect(errorLines).not.toContain(firstLine);
    expect(vi.mocked(logger.debug).mock.calls.length).toBeGreaterThan(0);
  });
});

/**
 * The bounded retry **of the one chosen model** (§7.2).
 *
 * The probe evidence says a provider's failures are per call rather than per
 * model, so asking the same model the same prompt again is worth exactly one
 * retry — bounded at `AI_PRE_REVIEW_MAX_ATTEMPTS_PER_MODEL` (2), which is the
 * whole of a run's call bound. What that evidence does **not** license is moving
 * to another model: the maintainer's requirement is that the extension never
 * picks or switches a model, so these cases assert both halves — the retry
 * happens on the chosen model with byte-identical messages, and no other offered
 * model is ever called, however badly the chosen one fails.
 */
describe('the bounded retry of the chosen model (§7.2)', () => {
  const validAnswer = JSON.stringify({
    comments: [{ path: 'src/index.ts', line: 2, side: 'head', extraLines: 0, body: 'This logs on every call.' }],
  });

  function failureMessage(): string {
    const calls = vi.mocked(vscode.window.showErrorMessage).mock.calls;
    return calls.map(([message]) => String(message)).join('\n');
  }

  it('retries the same model after an empty answer and succeeds', async () => {
    state.settings.aiPreReview = true;
    state.settings.aiPreReviewModel = 'fake/flaky';
    // The provider's empty stream on the first call, the contracted JSON on the
    // second: exactly the shape of failure the probe evidence established, and
    // the reason one retry of the same model exists.
    const flaky = createModel({ answers: ['', validAnswer], id: 'flaky', name: 'Flaky Model' });
    setModels(flaky);

    await runAiPreReview(config, undefined, controller, params());

    expect(flaky.sendRequest).toHaveBeenCalledTimes(2);
    expect(offeredItems()).toHaveLength(1);
    expect(await postedBodies('/reviews')).toHaveLength(1);
    // Both asks sent the same single message, so "same model, same prompt" is
    // what actually went out.
    const calls = (flaky.sendRequest as unknown as SendRequestMock).mock.calls;
    expect(calls).toHaveLength(2);
    expect(calls[1]?.[0]).toEqual(calls[0]?.[0]);
    expect(loggedLines()).toContainEqual(
      expect.stringContaining(
        '1 earlier answer(s) did not return the contracted JSON; Flaky Model (vendor=fake, family=fake, id=flaky) did, on attempt 2 of 2 for the chosen model (2 call(s) spent this run)',
      ),
    );
  });

  it('retries the same model after a non-JSON fragment and succeeds', async () => {
    state.settings.aiPreReview = true;
    state.settings.aiPreReviewModel = 'fake/fragment';
    // The 5–10 character fragment a real run produced ("comments[]" and
    // "\u007b\"\":}" were the maintainer's; any non-JSON fragment behaves the same).
    const flaky = createModel({ answers: ['comments[]', validAnswer], id: 'fragment', name: 'Fragment Model' });
    setModels(flaky);

    await runAiPreReview(config, undefined, controller, params());

    expect(flaky.sendRequest).toHaveBeenCalledTimes(2);
    expect(offeredItems()).toHaveLength(1);
    expect(await postedBodies('/reviews')).toHaveLength(1);
    expect(loggedLines()).toContainEqual(expect.stringContaining('on attempt 2 of 2 for the chosen model'));
  });

  it('never calls a second model, however many are offered, when the chosen one fails every time', async () => {
    state.settings.aiPreReview = true;
    state.settings.aiPreReviewModel = 'fake/chosen';
    const chosen = createModel({ answer: 'prose, every single time', id: 'chosen', name: 'Chosen' });
    // `other` answers the contracted JSON on its first call; a run that rotated
    // models would reach it and finish. It must never be asked.
    const other = createModel({ answer: validAnswer, id: 'other', name: 'Other' });
    setModels(chosen, other);

    await runAiPreReview(config, undefined, controller, params());

    expect(chosen.sendRequest).toHaveBeenCalledTimes(2);
    expect(other.sendRequest).not.toHaveBeenCalled();
    // The property under test, stated directly: exactly one distinct model was
    // called in this run.
    expect(modelsCalled([chosen, other])).toBe(1);
    expect(await postedBodies('/reviews')).toEqual([]);
    const message = failureMessage();
    expect(message).toContain('no other model was called');
    expect(message).toContain('Chosen (vendor=fake, family=fake, id=chosen)');
    expect(message).toContain('attempt 1 of 2: the answer was not JSON; attempt 2 of 2: the answer was not JSON');
    // The remedy the user has is named: the command that changes the model.
    expect(message).toContain('forgejoToolkit.aiPreReviewChooseModel');
  });

  it('spends its two attempts and reports how many model calls the run made', async () => {
    state.settings.aiPreReview = true;
    state.settings.aiPreReviewModel = 'fake/one';
    const chosen = createModel({ answer: 'prose', id: 'one', name: 'One' });
    setModels(chosen);

    await runAiPreReview(config, undefined, controller, params());

    expect(chosen.sendRequest).toHaveBeenCalledTimes(2);
    const message = failureMessage();
    expect(message).toContain('the same question 2 time(s)');
    expect(message).toContain('its bound is 2 attempt(s) per run');
    expect(message).toContain('One (vendor=fake, family=fake, id=one)');
    expect(message).toContain('Nothing was created');
    // One log line per attempt, each naming the model and which ask it was.
    const errorLines = vi.mocked(logger.error).mock.calls.map(([line]) => String(line));
    expect(
      errorLines.filter(
        (line) => line.includes('AI pre-review:') && line.includes('id=one') && line.includes('for the chosen model'),
      ),
    ).toHaveLength(2);
    expect(await postedBodies('/reviews')).toEqual([]);
  });

  it('collapses a model the editor lists twice into one picker row', async () => {
    state.settings.aiPreReview = true;
    const duplicated = createModel({ answer: '{"comments":[]}', id: 'twice', family: 'twice', name: 'Twice' });
    // `selectChatModels` can hand back the same model twice; the picker has to
    // show one row per model, because two identical rows are not a question.
    setModels(duplicated, duplicated);

    await runAiPreReview(config, undefined, controller, params());

    expect(modelPickCall()?.items).toHaveLength(1);
    expect(duplicated.sendRequest).toHaveBeenCalledTimes(1);
    expect(settingUpdates()).toEqual([{ key: 'aiPreReviewModel', value: 'fake/twice', target: 1 }]);
  });

  it('does not retry a model whose answer is a valid empty comment list', async () => {
    state.settings.aiPreReview = true;
    const quiet = createModel({ answer: '{"comments":[]}', id: 'quiet' });
    setModels(quiet);

    await runAiPreReview(config, undefined, controller, params());

    // The contract was met, so there is nothing to retry: the run reports the
    // outcome (one call) instead of spending a second ask.
    expect(quiet.sendRequest).toHaveBeenCalledTimes(1);
    expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(
      expect.stringContaining('produced no usable comments'),
    );
  });

  it('never retries a failing model call, and never tries another model for it', async () => {
    state.settings.aiPreReview = true;
    state.settings.aiPreReviewModel = 'fake/blocked';
    const blocked = createModel({ id: 'blocked', failWith: Object.assign(new Error('quota'), { code: 'Blocked' }) });
    const spare = createModel({ answer: validAnswer, id: 'spare' });
    setModels(blocked, spare);

    await runAiPreReview(config, undefined, controller, params());

    // One call to the failing model, none to it again, none to any other model:
    // a provider failure is not an answer shape.
    expect(blocked.sendRequest).toHaveBeenCalledTimes(1);
    expect(spare.sendRequest).not.toHaveBeenCalled();
    expect(modelsCalled([blocked, spare])).toBe(1);
    expect(await postedBodies('/reviews')).toEqual([]);
    expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
      expect.stringContaining('The AI pre-review could not be completed'),
    );
  });

  it('does not retry after the consent dialog is declined', async () => {
    state.settings.aiPreReview = true;
    state.settings.aiPreReviewModel = 'fake/declined';
    const declined = createModel({
      id: 'declined',
      failWith: Object.assign(new Error('user declined'), { code: 'NoPermissions' }),
    });
    const spare = createModel({ answer: validAnswer, id: 'spare' });
    setModels(declined, spare);

    await runAiPreReview(config, undefined, controller, params());

    // Not this model again (the dialog must not be re-shown) and not another
    // model either: the answer applies to the rest of the run.
    expect(declined.sendRequest).toHaveBeenCalledTimes(1);
    expect(spare.sendRequest).not.toHaveBeenCalled();
    expect(modelsCalled([declined, spare])).toBe(1);
    expect(await postedBodies('/reviews')).toEqual([]);
  });

  it('does not retry after the run is cancelled mid-stream', async () => {
    state.settings.aiPreReview = true;
    state.settings.aiPreReviewModel = 'fake/cancelled';
    // The one cancelled arm a mocked token cannot produce: the provider aborts
    // the stream itself.
    const cancelled = createModel({
      id: 'cancelled',
      streamFailWith: Object.assign(new Error('cancelled'), { name: 'AbortError' }),
    });
    const spare = createModel({ answer: validAnswer, id: 'spare' });
    setModels(cancelled, spare);

    await runAiPreReview(config, undefined, controller, params());

    expect(cancelled.sendRequest).toHaveBeenCalledTimes(1);
    expect(spare.sendRequest).not.toHaveBeenCalled();
    expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(
      expect.stringContaining('was cancelled. No comments were created'),
    );
    expect(await postedBodies('/reviews')).toEqual([]);
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
    // The model is configured, so the only question this run could ask is the
    // confirmation list — which a cancelled run must never reach.
    state.settings.aiPreReviewModel = 'fake/fake-model';
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
    // to drop a whole file rather than send a prompt the model cannot take. The
    // count is of the exact text one message carries — the synthetic counter
    // charges 10 per `- src/` line plus 10 — so the full table (two changed
    // files plus the existing comment's metadata row = 40) does not fit a
    // 30-token budget, while the one-file table (20) does.
    model.countTokens = vi.fn(async (text: string) => (text.match(/^- src\//gm) ?? []).length * 10 + 10) as never;
    model.maxInputTokens = 30;
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
    state.settings.aiPreReviewModel = 'fake/fake-model';
    const model = createModel();
    // The instructions are cheap and the brief is not: that is the only way to
    // reach this arm, because a chosen model that cannot hold the *instructions*
    // is refused before anything is read (§7.2).
    model.countTokens = vi.fn(countInstructionsCheaply()) as never;
    model.maxInputTokens = 1_000;
    setModel(model);

    await runAiPreReview(config, undefined, controller, params());

    expect(model.sendRequest).not.toHaveBeenCalled();
    // 10_000 for the brief, against a 1_000 budget, with the model named. The
    // instructions themselves are inside the same message the brief is, so this
    // synthetic counter — which charges only for the `[changed-files]` section —
    // reports the request as one number rather than as a sum of halves.
    expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
      expect.stringContaining('Fake Model (vendor=fake, family=fake, id=fake-model)'),
    );
    expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
      expect.stringContaining('(10000 tokens needed, 1000 available)'),
    );
    expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
      expect.stringContaining('no other model was substituted'),
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
    // The model is configured, so the dismissed pick below is the confirmation
    // list rather than the model question.
    state.settings.aiPreReviewModel = 'fake/fake-model';
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
    // Configured, so the empty answer below is the confirmation list returning
    // an empty selection rather than a dismissed model question.
    state.settings.aiPreReviewModel = 'fake/fake-model';
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
    // Configured, so the quick-pick assertion below is about the confirmation
    // list: a run left with nothing to confirm must not ask about it.
    state.settings.aiPreReviewModel = 'fake/fake-model';
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

/**
 * The debug-only diagnostics. Two properties, and they are the whole contract of
 * the escape hatch: **off by default and silent** (no file, no directory, and
 * still nothing but the bounded shape on the Output Channel), and **complete
 * when on** (the exact messages and the whole answer, which is the thing the
 * default path deliberately never keeps).
 */
describe('the debug diagnostics dump', () => {
  /** A log directory the run can write to, cleaned up by the suite's `afterEach`. */
  async function logDirectory(): Promise<{ logUri: vscode.Uri; directory: string }> {
    const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ai-pre-review-dump-'));
    logDirs.push(directory);
    return { logUri: { fsPath: directory } as unknown as vscode.Uri, directory };
  }

  function dumpPath(directory: string): string {
    return path.join(directory, AI_PRE_REVIEW_DIAGNOSTICS_FILE_NAME);
  }

  async function dumpText(directory: string): Promise<string> {
    return await fs.promises.readFile(dumpPath(directory), 'utf8');
  }

  it('writes no file at all while forgejoToolkit.debug is off', async () => {
    state.settings.aiPreReview = true;
    setModel(createModel({ answer: '{"comments":[]}' }));
    const { logUri, directory } = await logDirectory();

    await runAiPreReview(config, undefined, controller, params(), { logUri });

    await expect(fs.promises.access(dumpPath(directory))).rejects.toThrow();
    expect(await fs.promises.readdir(directory)).toEqual([]);
    // And the channel got nothing about a dump either: the path is only
    // announced when there is a file to announce.
    expect(loggedLines().some((line) => line.includes('diagnostics'))).toBe(false);
  });

  it('writes the exact messages and the full raw answer while debug is on', async () => {
    state.settings.aiPreReview = true;
    // The diff body switch is on so the request carries code, and the answer
    // keeps code of its own past its first line: the dump is the one place both
    // are allowed to appear.
    state.settings.aiPreReviewIncludeDiff = true;
    debugging();
    const firstLine = 'Sorry, I cannot answer in JSON.';
    const longAnswer = `${firstLine}\n${'hiddenAnswerMarker '.repeat(200)}\n${'z'.repeat(4_000)}`;
    setModel(createModel({ answer: longAnswer, name: 'Ollama Local', id: 'llama-local', vendor: 'ollama' }));
    const { logUri, directory } = await logDirectory();

    await runAiPreReview(config, undefined, controller, params(), { logUri });

    const text = await dumpText(directory);
    // Self-describing: what the file is, which run it belongs to, which models
    // were offered, and the shape of the request.
    expect(text).toContain('[run] started=');
    expect(text).toContain(`target: ${mockInstance.id}:demo-user/demo-repo#2`);
    expect(text).toContain('chat models offered by vscode.lm.selectChatModels(): 1');
    expect(text).toContain('model 1: Ollama Local (vendor=ollama, family=fake, id=llama-local)');
    expect(text).toContain('one User message carrying the fixed instructions and then the request');
    // Which model the run used, where the choice came from, and the one bound
    // that now exists: two calls, one model.
    expect(text).toContain('model used by this run: Ollama Local (vendor=ollama, family=fake, id=llama-local)');
    expect(text).toContain('chosen from the model the user picked just now (written into the setting)');
    expect(text).toContain('attempt bound: at most 2 model call(s) per run');
    expect(text).toContain('one chosen model, asked again only after a contract violation');
    expect(text).toContain('no other model is ever called');
    // One call, one block, labelled with both counts.
    expect(text).toContain('attempt 1/2 for the chosen model (call 1 of at most 2 in this run)');
    // The instruction half, the brief and the diff body are all in the file…
    expect(text).toContain(AI_PRE_REVIEW_SYSTEM_PROMPT);
    expect(text).toContain('[changed-files]');
    expect(text).toContain("+console.log('hello');");
    // …and the answer is complete rather than the bounded prefix.
    expect(text).toContain(longAnswer);
    expect(text).toContain(`answer chars: ${longAnswer.length}`);
    expect(text).toContain('outcome: contract violation: the answer is not JSON');
    expect(text).toContain('note: answer shape: ');
    // The channel names the file and still never the text.
    expect(loggedLines()).toContainEqual(expect.stringContaining(`are written to ${dumpPath(directory)}`));
    for (const line of loggedLines()) {
      expect(line).not.toContain('hiddenAnswerMarker');
      expect(line).not.toContain(AI_PRE_REVIEW_SYSTEM_PROMPT);
    }
  });

  it('numbers every attempt of the same model, so a repeated ask is visible', async () => {
    state.settings.aiPreReview = true;
    debugging();
    // The chosen model asked twice by the retry: the two blocks have to be
    // tellable apart, otherwise the dump cannot show that a retry happened.
    const flaky = createModel({ answers: ['comments[]', '{"comments":[]}'], id: 'flaky', name: 'Flaky Model' });
    setModels(flaky);
    const { logUri, directory } = await logDirectory();

    await runAiPreReview(config, undefined, controller, params(), { logUri });

    const text = await dumpText(directory);
    expect(text).toContain('attempt 1/2 for the chosen model (call 1 of at most 2 in this run)');
    expect(text).toContain('attempt 2/2 for the chosen model (call 2 of at most 2 in this run)');
    expect(text).toContain('outcome: contract violation: the answer is not JSON');
    expect(text).toContain('outcome: the contracted JSON, with 0 proposed comment(s)');
    // The first ask's answer and the second's are both kept, each in its block.
    expect(text.indexOf('comments[]')).toBeLessThan(text.indexOf('attempt 2/2 for the chosen model'));
    expect(text).toContain('answer chars: 10');
  });

  it('records a model call that failed outright, so the dump explains the run', async () => {
    state.settings.aiPreReview = true;
    debugging();
    setModel(createModel({ failWith: Object.assign(new Error('quota'), { code: 'Blocked' }) }));
    const { logUri, directory } = await logDirectory();

    await runAiPreReview(config, undefined, controller, params(), { logUri });

    const text = await dumpText(directory);
    // The messages are recorded even though no text came back, and the outcome
    // is the reason the run reported.
    expect(text).toContain('messages sent: 1');
    expect(text).toContain(AI_PRE_REVIEW_SYSTEM_PROMPT);
    expect(text).toContain('answer chars: 0');
    expect(text).toContain('outcome: model call failed:');
    expect(text).toContain('quota');
  });
});

/**
 * The debug-only probe. Its job is to separate "our request is wrong" from
 * "these models cannot answer at all", so the assertions are about what it asks,
 * who it asks, and the file it leaves behind — and about it sending nothing at
 * all while either gate is closed.
 */
describe('the chat model probe', () => {
  async function logDirectory(): Promise<{ logUri: vscode.Uri; directory: string }> {
    const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ai-pre-review-probe-'));
    logDirs.push(directory);
    return { logUri: { fsPath: directory } as unknown as vscode.Uri, directory };
  }

  it('sends nothing while the feature switch is off, whatever debug says', async () => {
    debugging();
    const model = createModel();
    setModel(model);

    await probeAiPreReviewChatModels({ logUri: { fsPath: 'ignored' } as unknown as vscode.Uri });

    expect(model.sendRequest).not.toHaveBeenCalled();
    expect(vscode.window.showWarningMessage).toHaveBeenCalledWith(expect.stringContaining('The AI pre-review is off.'));
  });

  it('sends nothing while forgejoToolkit.debug is off', async () => {
    state.settings.aiPreReview = true;
    const model = createModel();
    setModel(model);

    await probeAiPreReviewChatModels({ logUri: { fsPath: 'ignored' } as unknown as vscode.Uri });

    expect(model.sendRequest).not.toHaveBeenCalled();
    expect(vscode.window.showWarningMessage).toHaveBeenCalledWith(
      expect.stringContaining('runs only while the setting "forgejoToolkit.debug" is on'),
    );
    // And nothing was written anywhere: the probe has no dump to write to.
    expect(vi.mocked(vscode.window.showInformationMessage)).not.toHaveBeenCalled();
  });

  it('asks every offered model with every shape and writes the question and the answers', async () => {
    state.settings.aiPreReview = true;
    debugging();
    // Answers differ per model so the dump can be read as a comparison.
    const normal = createModel({ answer: '{}', id: 'normal', name: 'Normal Model' });
    const degenerate = createModel({ answer: 'comments[]', id: 'degenerate', name: 'Degenerate Model' });
    setModels(normal, degenerate);
    const { logUri, directory } = await logDirectory();

    await probeAiPreReviewChatModels({ logUri });

    const shapes = aiPreReviewProbeShapes();
    expect(normal.sendRequest).toHaveBeenCalledTimes(shapes.length);
    expect(degenerate.sendRequest).toHaveBeenCalledTimes(shapes.length);
    // The trivial question is the whole request: no repository, no pull request.
    for (const [messages] of (normal.sendRequest as unknown as SendRequestMock).mock.calls) {
      expect(messages.length).toBeGreaterThan(0);
      expect(messages.every((message) => message.role === 'user')).toBe(true);
    }
    const text = await fs.promises.readFile(path.join(directory, AI_PRE_REVIEW_DIAGNOSTICS_FILE_NAME), 'utf8');
    expect(text).toContain('[probe] started=');
    expect(text).toContain('shapes asked of every model: 3');
    expect(text).toContain(`question: ${JSON.stringify(AI_PRE_REVIEW_PROBE_PROMPT)}`);
    expect(text).toContain('control: one user message, no instructions');
    expect(text).toContain('two user messages: instructions, then the request');
    expect(text).toContain('one user message: instructions then the request');
    expect(text).toContain('id=normal');
    expect(text).toContain('id=degenerate');
    // The verdict the maintainer reads first: one model answered, the other did not.
    expect(text).toContain('answered exactly "{}" as asked');
    expect(text).toContain('did NOT answer the requested "{}"');
    expect(text).toContain('comments[]');
    expect(vi.mocked(vscode.window.showInformationMessage)).toHaveBeenCalledWith(
      expect.stringContaining('made 6 model call(s)'),
    );
  });

  it('stops asking when consent is declined instead of re-asking every model', async () => {
    state.settings.aiPreReview = true;
    debugging();
    const declined = createModel({
      failWith: Object.assign(new Error('NoPermissions'), { code: 'NoPermissions' }),
      id: 'declined',
    });
    const other = createModel({ answer: '{}', id: 'other' });
    setModels(declined, other);
    const { logUri, directory } = await logDirectory();

    await probeAiPreReviewChatModels({ logUri });

    // One call, not three: the consent dialog's answer applies to the rest.
    expect(declined.sendRequest).toHaveBeenCalledTimes(1);
    expect(other.sendRequest).not.toHaveBeenCalled();
    const text = await fs.promises.readFile(path.join(directory, AI_PRE_REVIEW_DIAGNOSTICS_FILE_NAME), 'utf8');
    expect(text).toContain('outcome: model call failed: NoPermissions');
    // The user is told once what happened, and still gets the file path.
    expect(vi.mocked(vscode.window.showInformationMessage)).toHaveBeenCalledWith(
      expect.stringContaining('made 1 model call(s)'),
    );
  });

  it('records a failing call as an outcome instead of aborting the probe', async () => {
    state.settings.aiPreReview = true;
    debugging();
    const failing = createModel({ failWith: new Error('provider said no'), id: 'broken' });
    const working = createModel({ answer: '{}', id: 'working' });
    setModels(failing, working);
    const { logUri, directory } = await logDirectory();

    await probeAiPreReviewChatModels({ logUri });

    // Every shape was still asked of the working model.
    expect(working.sendRequest).toHaveBeenCalledTimes(aiPreReviewProbeShapes().length);
    const text = await fs.promises.readFile(path.join(directory, AI_PRE_REVIEW_DIAGNOSTICS_FILE_NAME), 'utf8');
    expect(text).toContain('outcome: model call failed: provider said no');
    expect(text).toContain('answer chars: 0');
    expect(vi.mocked(vscode.window.showInformationMessage)).toHaveBeenCalled();
  });

  it('is registered as a command, and contributed behind the debug setting', () => {
    const context = { subscriptions: [] as { dispose: () => void }[] } as unknown as vscode.ExtensionContext;
    registerAiPreReviewCommand(context, config, undefined as never, controller);

    expect(state.registeredCommands.has(COMMAND_AI_PRE_REVIEW_PROBE)).toBe(true);
    // The model chooser is a command too, so the run's refusal messages can
    // point at a real action rather than only at a setting key.
    expect(state.registeredCommands.has(COMMAND_AI_PRE_REVIEW_CHOOSE_MODEL)).toBe(true);

    // Contributed too, not just registered: a command the palette never offers
    // because the gate is missing is a diagnostic nobody can run.
    const packageJson = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'package.json'), 'utf8')) as {
      contributes: {
        commands: { command: string; title: string }[];
        menus: { commandPalette: { command: string; when?: string }[] };
      };
    };
    const command = packageJson.contributes.commands.find((entry) => entry.command === COMMAND_AI_PRE_REVIEW_PROBE);
    expect(command?.title).toBe('%command.aiPreReviewProbeChatModels.title%');
    const palette = packageJson.contributes.menus.commandPalette.find(
      (entry) => entry.command === COMMAND_AI_PRE_REVIEW_PROBE,
    );
    expect(palette?.when).toBe('config.forgejoToolkit.debug');
    for (const file of ['package.nls.json', 'package.nls.zh-cn.json']) {
      const bundle = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', file), 'utf8')) as Record<
        string,
        string
      >;
      expect((bundle['command.aiPreReviewProbeChatModels.title'] ?? '').trim()).not.toBe('');
    }
  });

  it('contributes the model chooser as an ordinary command with a bilingual title', () => {
    const packageJson = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'package.json'), 'utf8')) as {
      contributes: {
        commands: { command: string; title: string }[];
        menus: { commandPalette: { command: string; when?: string }[] };
      };
    };
    const command = packageJson.contributes.commands.find(
      (entry) => entry.command === COMMAND_AI_PRE_REVIEW_CHOOSE_MODEL,
    );
    expect(command?.title).toBe('%command.aiPreReviewChooseModel.title%');
    // Deliberately not gated: choosing a model is configuration and sends
    // nothing, so it is reachable from the palette whatever the switches say.
    // (A command contributed without a `commandPalette` entry is offered by
    // default; none of the gates listed there may name this command.)
    expect(
      packageJson.contributes.menus.commandPalette.some(
        (entry) => entry.command === COMMAND_AI_PRE_REVIEW_CHOOSE_MODEL,
      ),
    ).toBe(false);
    for (const file of ['package.nls.json', 'package.nls.zh-cn.json']) {
      const bundle = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', file), 'utf8')) as Record<
        string,
        string
      >;
      expect((bundle['command.aiPreReviewChooseModel.title'] ?? '').trim()).not.toBe('');
    }
  });
});

/**
 * The request shape. The feature used to send two `User` messages (instructions,
 * then the brief); it now sends one. These assertions are what keeps a future
 * refactor from quietly splitting the contract into a message a provider could
 * drop — the failure mode this change exists to rule out.
 */
describe('the request shape', () => {
  it('sends one User message carrying the instructions and then the request', async () => {
    state.settings.aiPreReview = true;
    const model = createModel({ answer: '{"comments":[]}' });
    setModel(model);

    await runAiPreReview(config, undefined, controller, params());

    const messages = (model.sendRequest as unknown as SendRequestMock).mock.calls[0]?.[0] ?? [];
    expect(messages).toHaveLength(1);
    expect(messages[0]?.role).toBe('user');
    // The contract first, the pull request after it, in the one string.
    expect(messages[0]?.content.startsWith(AI_PRE_REVIEW_SYSTEM_PROMPT)).toBe(true);
    expect(messages[0]?.content).toContain('[changed-files]');
    expect(messages[0]?.content.length).toBeGreaterThan(AI_PRE_REVIEW_SYSTEM_PROMPT.length);
  });

  it('keeps the justification the consent dialog shows', async () => {
    state.settings.aiPreReview = true;
    const model = createModel({ answer: '{"comments":[]}' });
    setModel(model);

    await runAiPreReview(config, undefined, controller, params());

    const options = (model.sendRequest as unknown as { mock: { calls: Array<[unknown, { justification?: string }]> } })
      .mock.calls[0]?.[1];
    expect(options?.justification).toContain('AI pre-review');
  });
});
