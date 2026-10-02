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
  /**
   * The editors `window.visibleTextEditors` reports. Empty by default, because
   * the resolver falls back to the active editor when it names none; a case that
   * needs the menu argument's document to be resolved sets this.
   */
  visibleEditors: [] as unknown[],
}));

/**
 * The confirmation panel, as the run sees it.
 *
 * `aiPreReviewPanel` is mocked here rather than exercised against a real
 * webview: this suite is about what the **run** does with an answer — which
 * payload it built, what it wrote, what it reported — and the panel's own
 * behaviour (cards, checkboxes, the diff link, the result line) has its own
 * suite (`src/__tests__/aiPreReviewPanel.test.ts`) and a component test. What
 * this fake records is the payload of every run and the answer each case
 * installs, plus the result the run reported back.
 */
const panelState = vi.hoisted(() => ({
  createOrShow: vi.fn(),
  payloads: [] as Array<Record<string, unknown>>,
  navigation: [] as unknown[],
  extensionUris: [] as unknown[],
  results: [] as Array<{ created: number; failure?: string }>,
  disposed: 0,
  panel: undefined as unknown,
}));

vi.mock('../aiPreReviewPanel', () => ({
  AiPreReviewPanel: { createOrShow: panelState.createOrShow },
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
    // The part classes `@types/vscode` declares and a real provider instantiates.
    // The production diagnostic names a part by its **constructor name** rather
    // than with `instanceof`, so these exist for the fake response to hand over
    // genuine instances of the same classes the editor would.
    LanguageModelTextPart: class LanguageModelTextPart {
      constructor(public value: string) {}
    },
    LanguageModelToolCallPart: class LanguageModelToolCallPart {
      constructor(
        public callId: string,
        public name: string,
        public input: object,
      ) {}
    },
    LanguageModelToolResultPart: class LanguageModelToolResultPart {
      constructor(
        public callId: string,
        public content: unknown[],
      ) {}
    },
    LanguageModelPromptTsxPart: class LanguageModelPromptTsxPart {
      constructor(public value: unknown) {}
    },
    LanguageModelDataPart: class LanguageModelDataPart {
      constructor(
        public data: Uint8Array,
        public mimeType: string,
      ) {}
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
        return state.visibleEditors as never[];
      },
      showTextDocument: vi.fn(async () => ({})),
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
      // The diagnostics-file command opens the dump through these two; the mock
      // hands the document straight back so the case can assert on the URI.
      openTextDocument: vi.fn(async (uri: unknown) => ({ uri })),
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
  AI_PRE_REVIEW_PROBE_ECHO_ANSWER,
  AI_PRE_REVIEW_PROBE_ECHO_PROMPT,
  AI_PRE_REVIEW_PROBE_PROMPT,
  AI_PRE_REVIEW_SCOPE_BUTTON_CANCEL,
  AI_PRE_REVIEW_SCOPE_BUTTON_CHANGED_FILES,
  AI_PRE_REVIEW_SCOPE_BUTTON_CHANGED_LINES,
  AI_PRE_REVIEW_SCOPE_BUTTON_METADATA_ONLY,
  COMMAND_AI_PRE_REVIEW,
  COMMAND_AI_PRE_REVIEW_CHOOSE_MODEL,
  COMMAND_AI_PRE_REVIEW_OPEN_DIAGNOSTICS,
  COMMAND_AI_PRE_REVIEW_PROBE,
  aiPreReviewProbeShapes,
  chooseAiPreReviewModel,
  openAiPreReviewDiagnostics,
  probeAiPreReviewChatModels,
  registerAiPreReviewCommand,
  resolveAiPreReviewTarget,
  runAiPreReview,
  writePreReviewDrafts,
} from '../aiPreReview';
import { AI_PRE_REVIEW_ANSWER_EXCERPT_LENGTH, AI_PRE_REVIEW_SYSTEM_PROMPT } from '../aiPreReviewBrief';
import { parseAiPreReviewModelSelector } from '../aiPreReviewSettings';
import { AI_PRE_REVIEW_DIAGNOSTICS_FILE_NAME } from '../aiPreReviewDiagnostics';
import { logger } from '../logger';
import type { ForgejoPrUriParams } from '../prFileSystemProvider';
import type { ConfigManager } from '../config';
import type { ForgejoToolkitViewProvider } from '../webview/viewProvider';
import type { PullReviewCommentController } from '../comments/pullReviewCommentController';
import { removeTempDirSync } from './tempDir';

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
 *
 * `fragments` is for the accumulation cases: the response stream yields these
 * strings in order instead of one chunk, which is what a real provider does and
 * the only way to exercise where a fragment boundary can fall (inside a
 * multi-byte character, inside an escape sequence, inside a JSON string). When
 * it is absent the whole answer arrives as one chunk, exactly as before.
 *
 * `parts` is for the transport cases: it is the **stream** view of the same
 * response, one response part per entry (`partOfText`, `partOfToolCall`,
 * `partOfUnknown` build them, and the RPC-serialised envelopes the candidate
 * cases use are plain object literals) while `text` is derived from it the way
 * the API documents it — the text parts' values, in order. A response without
 * `parts` still carries text parts built from its own `fragments` (or its whole
 * answer), so the parts channel is what the answer normally comes from;
 * `projectionOnly` is the shape that has no `stream` at all and therefore
 * exercises the `text` fallback, `singleReadStream` is the one-shot cursor that
 * makes a second read fail loudly, and `forbidTextProjection` is the proof that a
 * parts answer never touched the projection.
 */
function createModel(
  options: {
    answer?: string;
    /** One answer per call; the last entry repeats. Takes precedence over `answer`. */
    answers?: readonly string[];
    /** One stream chunk per entry, in order; the answer is their concatenation. */
    fragments?: readonly string[];
    /**
     * The chunks the **`text` projection** yields, in order, for the responses
     * that carry no `stream` parts. It is the way to exercise a boundary inside
     * the text projection itself (`fragments` is the equivalent for the parts
     * channel); when it is absent the whole answer arrives as one chunk, exactly
     * as it did before these knobs existed.
     */
    textChunks?: readonly string[];
    /**
     * The `stream` view of the response, one part per entry; `text` is derived
     * from it as the text parts' values. Takes precedence over `fragments`.
     */
    parts?: readonly unknown[];
    /**
     * Fails a **second** read of a projection, the way a provider with one
     * underlying cursor does: the first `Symbol.asyncIterator()` call is served
     * and the next one throws. It is what makes "the response is consumed once" an
     * assertion rather than an inference — a case that reads both projections now
     * gets a loud failure instead of quietly different text.
     */
    singleReadStream?: boolean;
    /**
     * The response carries **only** a `text` property: no `stream` iterable at
     * all, which is the shape an older editor version hands over and the pure
     * fallback path (no candidate stream can exist without one).
     */
    projectionOnly?: boolean;
    /**
     * Reads the `text` property and throws if anything does. It is the proof that
     * no candidate stream's answer was taken from a second consumer: a case whose
     * parts carry the answer can assert the projection was never even touched.
     */
    forbidTextProjection?: boolean;
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
      const parts = options.parts;
      callIndex += 1;
      /** How many projection reads this response has already served. */
      let readCount = 0;
      /**
       * The response object of this call, with the two one-shot knobs applied:
       * a shared cursor throws on its second `Symbol.asyncIterator()` call, and
       * `forbidTextProjection` throws if the `text` property is even read.
       */
      const buildResponse = (projections: { text: AsyncIterable<string>; stream: AsyncIterable<unknown> }) => {
        const response: Record<string, unknown> = {};
        if (options.singleReadStream) {
          // A provider with one underlying cursor: the first `for await` gets the
          // parts, and a second reader gets a loud failure rather than silence.
          const single = (iterable: AsyncIterable<unknown>) => ({
            [Symbol.asyncIterator]() {
              if (readCount > 0) {
                throw new Error(`the response was read ${readCount + 1} times; it only offers one pass`);
              }
              readCount += 1;
              return iterable[Symbol.asyncIterator]();
            },
          });
          response.text = single(projections.text);
          response.stream = single(projections.stream);
        } else {
          response.text = projections.text;
          response.stream = projections.stream;
        }
        if (options.forbidTextProjection) {
          // Reading the projection at all is the failure this case is about.
          Object.defineProperty(response, 'text', {
            get: () => {
              throw new Error('the `text` projection was read although a candidate stream carried the answer');
            },
            enumerable: true,
            configurable: true,
          });
        }
        return response;
      };
      if (!parts) {
        // A response whose parts are the `fragments` themselves: the `stream` view
        // yields those chunks (as `LanguageModelTextPart`s, which is what a
        // provider's text parts are) and the `text` projection yields the same
        // chunks as strings — so the two projections agree on the text, which is
        // what the API documents, and the boundary cases are what the case is
        // about. `options.textChunks` makes the projection's own boundaries
        // explicit; specifying neither streams the whole answer as one part.
        // `options.parts` is the general form of the same rule.
        const chunks = options.textChunks ?? options.fragments ?? [text];
        const streamIterable = () =>
          (async function* () {
            if (options.streamFailWith) {
              throw options.streamFailWith;
            }
            for (const chunk of chunks) {
              yield partOfText(chunk);
            }
          })();
        const textIterable = () =>
          (async function* () {
            if (options.streamFailWith) {
              throw options.streamFailWith;
            }
            for (const chunk of chunks) {
              yield chunk;
            }
          })();
        if (options.projectionOnly) {
          // No `stream` property at all: the older editor shape, and the pure
          // "there is no candidate stream, so read `text`" path.
          return { text: textIterable() };
        }
        return buildResponse({ text: textIterable(), stream: streamIterable() });
      }
      return buildResponse({
        // The documented projection: the text parts' values, in order. It is
        // derived from `parts` rather than from `answer` so the two views of one
        // response genuinely agree; the segments are yielded one per text part,
        // which is where a part boundary can fall.
        text: (async function* () {
          if (options.streamFailWith) {
            throw options.streamFailWith;
          }
          for (const part of parts) {
            if (isTextPart(part)) {
              yield String((part as { value?: unknown }).value ?? '');
            }
          }
        })(),
        stream: (async function* () {
          if (options.streamFailWith) {
            throw options.streamFailWith;
          }
          for (const part of parts) {
            yield part;
          }
        })(),
      });
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

/**
 * The three part kinds a response can carry, built as the classes the editor
 * declares: a text part, a tool-call part with the structured input the whole
 * diagnostic is looking for, and a value that is none of the known classes — the
 * `unknown` arm of `LanguageModelChatResponse.stream`'s element type, which is
 * where a data part from a newer editor or a provider's own object lands.
 *
 * The fake response derives its `text` projection from these parts with
 * `isTextPart`, which is the documented rule ("everything except for text parts
 * filtered out of `stream`") written once. A part the fake cannot build as a real
 * class can still be handed over with `partOfUnknown`.
 */
function isTextPart(part: unknown): boolean {
  const ctor = (vscode as unknown as { LanguageModelTextPart?: new (...args: never[]) => unknown })
    .LanguageModelTextPart;
  return typeof ctor === 'function' && part instanceof ctor;
}

function partOfText(value: string): unknown {
  return new (vscode as unknown as { LanguageModelTextPart: new (value: string) => unknown }).LanguageModelTextPart(
    value,
  );
}

function partOfToolCall(name: string, input: object): unknown {
  return new (
    vscode as unknown as {
      LanguageModelToolCallPart: new (callId: string, name: string, input: object) => unknown;
    }
  ).LanguageModelToolCallPart('call-1', name, input);
}

function partOfUnknown(value: unknown): unknown {
  return value;
}

const controller = {
  findPendingReview: vi.fn(async () => undefined),
  refreshPullRequestComments: vi.fn(async () => undefined),
} as unknown as PullReviewCommentController;

const config = {
  getInstances: () => [mockInstance],
  onInstancesChanged: () => ({ dispose: vi.fn() }),
} as unknown as ConfigManager;

/**
 * The view provider as `registerAiPreReviewCommand` needs it.
 *
 * Registering the commands is also what hands the provider the run the pull
 * request detail page's button reaches (`setAiPreReviewRunner`), so the call
 * sites that only care about the contributions still have to pass something that
 * accepts that handover. `registeredRunner` is what those cases assert on: it is
 * proof that the two entries share one implementation rather than two that agree
 * by accident.
 */
function viewProviderWithRunner(): {
  provider: ForgejoToolkitViewProvider;
  registeredRunner: () => ((target: unknown) => void) | undefined;
} {
  let runner: ((target: unknown) => void) | undefined;
  const provider = {
    setAiPreReviewRunner(next: (target: unknown) => void) {
      runner = next;
    },
  } as unknown as ForgejoToolkitViewProvider;
  return { provider, registeredRunner: () => runner };
}

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
 * A quick pick that selects the first offered model.
 *
 * Installed by default so a case with several offered models and no configured
 * one still exercises the model it would otherwise ask about. The confirmation
 * step needs nothing from this mock any more — it is a webview panel now, and
 * `installPanel` answers it.
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

/** The `ExtensionContext` fields the run reads. */
function testHost(extra: { logUri?: vscode.Uri } = {}): { extensionUri: vscode.Uri; logUri?: vscode.Uri } {
  return { extensionUri: vscode.Uri.file('/ext') as vscode.Uri, ...extra };
}

/** What the panel answers in a case: the checked cards with their bodies, or nothing. */
type PanelAnswer = { kind: 'create'; entries: { index: number; body: string }[] } | { kind: 'cancel' };

/**
 * Installs the panel answer one case expects, and records what the run built.
 *
 * A case that is about the answer installs `cancel`, a different selection, or a
 * body the user edited. A **function** is handed the payload the run built, which
 * is how the default below stays honest: "the user checked the first card and left
 * the wording the model proposed" has to name that card's actual body, and the
 * fixtures here do not all use the same one.
 */
function installPanel(answer: PanelAnswer | ((payload: Record<string, unknown>) => PanelAnswer)): void {
  panelState.createOrShow.mockImplementation((extensionUri: unknown, payload: unknown, host?: unknown) => {
    panelState.extensionUris.push(extensionUri);
    const asPayload = payload as Record<string, unknown>;
    panelState.payloads.push(asPayload);
    panelState.navigation.push(host);
    const decision = typeof answer === 'function' ? answer(asPayload) : answer;
    const panel = {
      decision: Promise.resolve(decision),
      reportResult: vi.fn((result: { created: number; failure?: string }) => panelState.results.push(result)),
      dispose: vi.fn(() => {
        panelState.disposed += 1;
      }),
    };
    panelState.panel = panel;
    return panel;
  });
}

/**
 * The default answer: the user checked the first card and edited nothing.
 *
 * Reading the body out of the payload is what makes that true for every fixture —
 * the run writes exactly the text the panel held, so the default answer has to
 * hold the model's own wording for the card it names.
 */
function uneditedFirstCard(payload: Record<string, unknown>): PanelAnswer {
  const candidates = (payload.candidates ?? []) as { index: number; body: string }[];
  const first = candidates[0];
  return first ? { kind: 'create', entries: [{ index: first.index, body: first.body }] } : { kind: 'cancel' };
}

/** The payload of the last panel the run opened. */
function panelPayload(): Record<string, unknown> {
  const payload = panelState.payloads.at(-1);
  if (!payload) {
    throw new Error('the run opened no confirmation panel');
  }
  return payload;
}

/** The candidates one panel payload carried, with their indexes. */
function panelCandidates(): Array<Record<string, unknown>> {
  return (panelPayload().candidates ?? []) as Array<Record<string, unknown>>;
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
 * The first raw-answer block of a diagnostics dump, exactly as the dump holds
 * it. The markers carry the character count, and the text between them is the
 * bytes the code accumulated — which is what the accumulation cases compare
 * against their own literal.
 */
function recordedAnswer(dumpText: string): string {
  const match = /--- raw answer begin \(\d+ chars\) ---\n([\s\S]*?)\n--- raw answer end ---/.exec(dumpText);
  const answer = match?.[1];
  if (answer === undefined) {
    throw new Error('the diagnostics dump holds no raw answer block');
  }
  return answer;
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
  state.visibleEditors = [];
  captured.length = 0;
  pendingReads.length = 0;
  panelState.payloads.length = 0;
  panelState.navigation.length = 0;
  panelState.extensionUris.length = 0;
  panelState.results.length = 0;
  panelState.disposed = 0;
  panelState.panel = undefined;
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
  // A **stated** prompt scope by default, because the setting's own default is
  // `ask` — which shows the one modal and sends nothing until it is answered.
  // Cases about that question set the scope back to `ask` themselves; every
  // other case means "what happens under a scope that was already chosen", and
  // `metadata-only` is the closest reading of the old "no diff body" default.
  state.settings.aiPreReviewPromptScope = 'metadata-only';
  // The confirmation panel's default answer: the user checked the first
  // candidate and edited nothing, which is what the removed quick pick's own
  // default did. Cases about the answer or the panel install their own.
  installPanel(uneditedFirstCard);
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
    removeTempDirSync(directory);
  }
});

describe('the diff side the invocation names (§4.3)', () => {
  /** One side of a PR diff file: both sides share the path, only the query differs. */
  const editorForSide = (isBase: boolean) => ({
    document: {
      uri: {
        scheme: 'forgejo-pr',
        path: '/i/o/r/src/index.ts',
        query: JSON.stringify({ index: 2, ref: 'sha1', isBase }),
      },
    },
    selection: { active: { line: 0 } },
  });

  it('resolves the side its menu argument names, not the first side listed', () => {
    // A diff editor is two documents of the same file, so matching on the path
    // alone resolved whichever side `visibleTextEditors` listed first. The
    // pre-review then validated anchors (and wrote drafts) against the other
    // side's line table — the interactive path had the same defect, reported as
    // "Comments can only be added to lines within the pull request diff".
    const baseEditor = editorForSide(true);
    const headEditor = editorForSide(false);
    state.visibleEditors = [baseEditor, headEditor];

    const target = resolveAiPreReviewTarget(
      {
        scheme: 'forgejo-pr',
        path: '/i/o/r/src/index.ts',
        query: JSON.stringify({ index: 2, ref: 'sha1', isBase: false }),
      },
      undefined,
    );

    expect(target?.editor).toBe(headEditor);
    expect(target?.params.isBase).toBe(false);
  });
});

describe('the feature switch is checked before anything else happens', () => {
  it('refuses, sends nothing and never touches the model when it is off', async () => {
    const model = createModel();
    setModel(model);

    await runAiPreReview(config, undefined, controller, params(), testHost());

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

    await runAiPreReview(config, undefined, controller, params(), testHost());

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
      await runAiPreReview(config, undefined, controller, params(), testHost());
    } finally {
      (vscode as { lm?: unknown }).lm = original;
    }

    expect(captured).toEqual([]);
    expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(expect.stringContaining('no language model API'));
  });

  it('reports an empty model list without any HTTP request', async () => {
    state.settings.aiPreReview = true;
    vi.mocked(vscode.lm.selectChatModels).mockResolvedValue([] as never[]);

    await runAiPreReview(config, undefined, controller, params(), testHost());

    expect(captured).toEqual([]);
    expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(expect.stringContaining('No chat model is available'));
  });

  it('reports a rejecting model list without any HTTP request', async () => {
    state.settings.aiPreReview = true;
    vi.mocked(vscode.lm.selectChatModels).mockRejectedValue(new Error('model listing failed'));

    await runAiPreReview(config, undefined, controller, params(), testHost());

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

    await runAiPreReview(config, undefined, controller, params(), testHost());

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

    await runAiPreReview(config, undefined, controller, params(), testHost());

    expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
      expect.stringContaining('The AI pre-review of the whole pull request could not be completed'),
    );
    expect(await postedBodies('/reviews')).toEqual([]);
  });

  it('reports NotFound with the cause and creates nothing', async () => {
    state.settings.aiPreReview = true;
    const error = Object.assign(new Error('model is gone'), { code: 'NotFound' });
    setModel(createModel({ failWith: error }));

    await runAiPreReview(config, undefined, controller, params(), testHost());

    expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
      expect.stringContaining('The AI pre-review of the whole pull request could not be completed'),
    );
    expect(await postedBodies('/reviews')).toEqual([]);
  });

  it('treats a stream that fails with a cancellation as cancelled, not as an error', async () => {
    state.settings.aiPreReview = true;
    setModel(createModel({ streamFailWith: Object.assign(new Error('cancelled'), { name: 'AbortError' }) }));

    await runAiPreReview(config, undefined, controller, params(), testHost());

    expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(
      expect.stringContaining('was cancelled. No comments were created'),
    );
    expect(await postedBodies('/reviews')).toEqual([]);
  });

  it('reports an answer that is not JSON and creates nothing', async () => {
    state.settings.aiPreReview = true;
    setModel(createModel({ answer: 'I think this looks fine overall.' }));

    await runAiPreReview(config, undefined, controller, params(), testHost());

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

    await runAiPreReview(config, undefined, controller, params(), testHost());

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
      expect.stringContaining('Every prompt scope costs at least these instructions'),
    );
  });

  it('refuses when the chosen model will not measure the instructions, and still substitutes nothing', async () => {
    state.settings.aiPreReview = true;
    state.settings.aiPreReviewModel = 'fake/unmeasurable';
    const unmeasurable = createModel({ id: 'unmeasurable', family: 'unmeasurable' });
    unmeasurable.countTokens.mockRejectedValue(new Error('no tokenizer here'));
    const large = createModel({ id: 'large', family: 'large', maxInputTokens: 128_000 });
    setModels(unmeasurable, large);

    await runAiPreReview(config, undefined, controller, params(), testHost());

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

    await runAiPreReview(config, undefined, controller, params(), testHost());

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

    await runAiPreReview(config, undefined, controller, params(), testHost());

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

      await runAiPreReview(config, undefined, controller, params(), testHost());

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

      await runAiPreReview(config, undefined, controller, params(), testHost());

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

      await runAiPreReview(config, undefined, controller, params(), testHost());

      // The configured model is asked, and — because its answer broke the
      // contract — asked exactly once more. `two` answers with valid JSON and is
      // still never called: the run's one model is the setting's.
      expect(one.sendRequest).toHaveBeenCalledTimes(2);
      expect(two.sendRequest).not.toHaveBeenCalled();
      // The sentence names the scope and the coverage, then how many times that
      // one model was asked: the run is a whole-pull-request review, and the
      // failure report has to say what it was reading when it failed.
      expect(refusalMessage()).toContain(
        'the same question about the whole pull request (1 changed file(s)) 2 time(s)',
      );
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

      await runAiPreReview(config, undefined, controller, params(), testHost());

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

      await runAiPreReview(config, undefined, controller, params(), testHost());

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

    await runAiPreReview(config, undefined, controller, params(), testHost());

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

    await runAiPreReview(config, undefined, controller, params(), testHost());

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

    await runAiPreReview(config, undefined, controller, params(), testHost());

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
    await runAiPreReview(config, undefined, controller, params(), testHost());

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

    await runAiPreReview(config, undefined, controller, params(), testHost());

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

    await runAiPreReview(config, undefined, controller, params(), testHost());

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

    await runAiPreReview(config, undefined, controller, params(), testHost());

    expect(failureMessage()).toContain('the answer was not JSON');
    expect(loggedLines()).toContainEqual(expect.stringContaining('returned an answer that is not JSON'));
  });

  it('names the "comments" field when the JSON has the wrong shape', async () => {
    state.settings.aiPreReview = true;
    setModel(createModel({ answer: '{"note":"no comments here"}' }));

    await runAiPreReview(config, undefined, controller, params(), testHost());

    expect(failureMessage()).toContain('its "comments" field is missing or not an array');
    expect(loggedLines()).toContainEqual(
      expect.stringContaining('returned JSON whose "comments" field is missing or not an array'),
    );
  });

  it('names the top level when the JSON is not an object at all', async () => {
    state.settings.aiPreReview = true;
    setModel(createModel({ answer: '[{"path":"src/index.ts"}]' }));

    await runAiPreReview(config, undefined, controller, params(), testHost());

    expect(failureMessage()).toContain('its top level is not an object');
    expect(loggedLines()).toContainEqual(expect.stringContaining('returned JSON whose top level is not an object'));
  });

  it('quotes a short failed answer in full, escaped onto one line, with debug off', async () => {
    state.settings.aiPreReview = true;
    // `forgejoToolkit.debug` stays off (the suite's `beforeEach`): the excerpt is
    // part of the failure report itself, not a debug-only nicety.
    const answer = 'comments[]';
    setModel(createModel({ answer }));

    await runAiPreReview(config, undefined, controller, params(), testHost());

    const excerptLine = vi
      .mocked(logger.error)
      .mock.calls.map(([message]) => String(message))
      .find((line) => line.includes('excerpt'));
    expect(excerptLine).toBeDefined();
    expect(excerptLine).toContain('Fake Model (vendor=fake, family=fake, id=fake-model)');
    expect(excerptLine).toContain(`the answer is ${answer.length} character(s)`);
    expect(excerptLine).toContain(`excerpt ${JSON.stringify(answer)}`);
    expect(excerptLine).toContain('attempt 1 of 2 for the chosen model');
    expect(excerptLine).not.toContain('\n');
  });

  it('escapes the excerpt, so a newline or a quote cannot break the log line', async () => {
    state.settings.aiPreReview = true;
    const answer = 'first line\n"quoted"\\backslash\ttab';
    setModel(createModel({ answer }));

    await runAiPreReview(config, undefined, controller, params(), testHost());

    const errorLines = vi.mocked(logger.error).mock.calls.map(([message]) => String(message));
    const excerptLine = errorLines.find((line) => line.includes('excerpt'));
    expect(excerptLine).toContain(`excerpt ${JSON.stringify(answer)}`);
    // One line, whatever the answer held: the escaping is what the channel reads.
    for (const line of errorLines) {
      expect(line).not.toContain('\n');
    }
  });

  it('cuts a long answer at the excerpt cap and keeps the rest out of the channel', async () => {
    state.settings.aiPreReview = true;
    // The diff body switch is on so the brief carries code, and the answer is
    // built so the characters past the cap are unmistakable.
    state.settings.aiPreReviewPromptScope = 'full-diff';
    const answer = `${'a'.repeat(150)}${'b'.repeat(500)}`;
    setModel(createModel({ answer, name: 'Ollama Local', id: 'llama-local', vendor: 'ollama', family: 'llama' }));

    await runAiPreReview(config, undefined, controller, params(), testHost());

    const excerpt = answer.slice(0, AI_PRE_REVIEW_ANSWER_EXCERPT_LENGTH);
    expect(excerpt).toHaveLength(AI_PRE_REVIEW_ANSWER_EXCERPT_LENGTH);
    const lines = loggedLines();
    const excerptLine = lines.find((line) => line.includes('excerpt'));
    expect(excerptLine).toBeDefined();
    expect(excerptLine).toContain('Ollama Local (vendor=ollama, family=llama, id=llama-local)');
    expect(excerptLine).toContain(`the answer is ${answer.length} character(s)`);
    expect(excerptLine).toContain(`excerpt ${JSON.stringify(excerpt)}`);
    expect(excerptLine).toContain('attempt 1 of 2 for the chosen model');
    // Everything past the cap, and the diff, the brief and the prompt, stay out.
    for (const line of lines) {
      expect(line).not.toContain('b'.repeat(AI_PRE_REVIEW_ANSWER_EXCERPT_LENGTH));
      expect(line).not.toContain("console.log('hello')");
      expect(line).not.toContain('[changed-files]');
      expect(line).not.toContain(AI_PRE_REVIEW_SYSTEM_PROMPT);
    }
    // The debug-level shape line is still there, and still bounded.
    const shape = lines.find((line) => line.includes('answer shape:'));
    expect(shape).toContain(`length=${answer.length}`);
    expect(shape).toContain(JSON.stringify('a'.repeat(60)));
  });

  it('logs no answer text at all when the run succeeds with debug off', async () => {
    state.settings.aiPreReview = true;
    // Debug stays off (the suite's `beforeEach`), which is what the assertion is
    // about now. The fragment log below hands the answer's own text to
    // `logger.debug` while debug is on — that is the whole point of it — so "no
    // answer text" can only be asserted for the default mode. What still holds
    // for **both** modes is checked with it: the prompt, the brief and the diff
    // never appear on any line, and the fragment lines are the only answer text
    // the debug mode adds.
    const marker = 'SUCCESS_ANSWER_MARKER_9f3a';
    const answer = JSON.stringify({
      comments: [{ path: 'src/index.ts', line: 2, side: 'head', extraLines: 0, body: marker }],
    });
    setModel(createModel({ answer }));

    await runAiPreReview(config, undefined, controller, params(), testHost());

    // The run reached the confirmation list and wrote its one draft, so this is
    // the success path and not a failure that happens to look quiet.
    expect(await postedBodies('/reviews')).toHaveLength(1);
    for (const line of loggedLines()) {
      expect(line).not.toContain(marker);
      expect(line).not.toContain('excerpt');
      expect(line).not.toContain('answer fragment');
      expect(line).not.toContain('answer stream summary');
      expect(line).not.toContain(AI_PRE_REVIEW_SYSTEM_PROMPT);
    }
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

    await runAiPreReview(config, undefined, controller, params(), testHost());

    expect(flaky.sendRequest).toHaveBeenCalledTimes(2);
    expect(panelCandidates()).toHaveLength(1);
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

    await runAiPreReview(config, undefined, controller, params(), testHost());

    expect(flaky.sendRequest).toHaveBeenCalledTimes(2);
    expect(panelCandidates()).toHaveLength(1);
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

    await runAiPreReview(config, undefined, controller, params(), testHost());

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

    await runAiPreReview(config, undefined, controller, params(), testHost());

    expect(chosen.sendRequest).toHaveBeenCalledTimes(2);
    const message = failureMessage();
    expect(message).toContain('the same question about the whole pull request (1 changed file(s)) 2 time(s)');
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

    await runAiPreReview(config, undefined, controller, params(), testHost());

    expect(modelPickCall()?.items).toHaveLength(1);
    expect(duplicated.sendRequest).toHaveBeenCalledTimes(1);
    expect(settingUpdates()).toEqual([{ key: 'aiPreReviewModel', value: 'fake/twice', target: 1 }]);
  });

  it('does not retry a model whose answer is a valid empty comment list', async () => {
    state.settings.aiPreReview = true;
    const quiet = createModel({ answer: '{"comments":[]}', id: 'quiet' });
    setModels(quiet);

    await runAiPreReview(config, undefined, controller, params(), testHost());

    // The contract was met, so there is nothing to retry: the run reports the
    // outcome (one call) instead of spending a second ask.
    expect(quiet.sendRequest).toHaveBeenCalledTimes(1);
    // The sentence states the scope and the coverage, not only the outcome: this
    // run read the whole pull request and says how many changed files that was.
    expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(
      expect.stringContaining('read the whole pull request (1 changed file(s)) and produced no usable comments'),
    );
  });

  it('never retries a failing model call, and never tries another model for it', async () => {
    state.settings.aiPreReview = true;
    state.settings.aiPreReviewModel = 'fake/blocked';
    const blocked = createModel({ id: 'blocked', failWith: Object.assign(new Error('quota'), { code: 'Blocked' }) });
    const spare = createModel({ answer: validAnswer, id: 'spare' });
    setModels(blocked, spare);

    await runAiPreReview(config, undefined, controller, params(), testHost());

    // One call to the failing model, none to it again, none to any other model:
    // a provider failure is not an answer shape.
    expect(blocked.sendRequest).toHaveBeenCalledTimes(1);
    expect(spare.sendRequest).not.toHaveBeenCalled();
    expect(modelsCalled([blocked, spare])).toBe(1);
    expect(await postedBodies('/reviews')).toEqual([]);
    expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
      expect.stringContaining('The AI pre-review of the whole pull request could not be completed'),
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

    await runAiPreReview(config, undefined, controller, params(), testHost());

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

    await runAiPreReview(config, undefined, controller, params(), testHost());

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
    await runAiPreReview(config, undefined, controller, params(), testHost());
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
    // Both lines state the scope the entry point promises — the whole pull
    // request — and the second states the coverage, which the run only knows
    // after the changed-file list has arrived. The default fixture is a
    // one-file pull request.
    expect(titles).toEqual([
      'Reading the whole pull request…',
      'Asking the chat model to review the whole pull request (1 changed file(s))…',
    ]);
  });

  it('cancelling shows the documented sentence and writes nothing', async () => {
    state.settings.aiPreReview = true;
    // The model is configured, so the only question this run could ask is the
    // confirmation panel — which a cancelled run must never reach.
    state.settings.aiPreReviewModel = 'fake/fake-model';
    state.cancelRequested = true;
    const model = createModel({ answer: '{"comments":[]}' });
    setModel(model);

    await runWithReportedProgress();

    expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(
      expect.stringContaining('The AI pre-review of the whole pull request was cancelled. No comments were created.'),
    );
    // Nothing reached the model and nothing reached the server.
    expect(model.sendRequest).not.toHaveBeenCalled();
    expect(await postedBodies('/reviews')).toEqual([]);
    expect(await postedBodies('/comments')).toEqual([]);
    expect(panelState.createOrShow).not.toHaveBeenCalled();
  });
});

describe('what the prompt contains in each scope', () => {
  const answer = '{"comments":[]}';

  /** The head text the mocked contents endpoint serves for `src/index.ts`. */
  const indexPath = '/api/v1/repos/demo-user/demo-repo/contents/src/index.ts';
  const contentReads = (): CapturedRequest[] => captured.filter((entry) => entry.path.includes('/contents/'));

  it('sends the brief only, with comment metadata and no code at all, for metadata-only', async () => {
    state.settings.aiPreReview = true;
    state.settings.aiPreReviewPromptScope = 'metadata-only';
    const model = createModel({ answer });
    setModel(model);

    await runAiPreReview(config, undefined, controller, params(), testHost());

    const prompt = sentPrompt(model);
    expect(prompt).toContain('src/index.ts');
    expect(prompt).toContain('+10 -2');
    expect(prompt).toContain('modified');
    expect(prompt).toContain('demo-user');
    // Metadata of an existing review comment, never its body.
    expect(prompt).toContain('[existing-review-comment-metadata]');
    expect(prompt).not.toContain('Consider renaming this variable');
    // No code of any kind, and none of the leak-prone fields the record excludes.
    expect(prompt).not.toContain('[diff]');
    expect(prompt).not.toContain('[changed-file-contents]');
    expect(prompt).not.toContain("console.log('hello')");
    expect(prompt).not.toContain('export function greet');
    expect(prompt).not.toContain('forgejo.example.com');
    expect(prompt).not.toContain('This PR adds a dark mode toggle');
    // Nor is any file content read for a scope that does not send it.
    expect(contentReads()).toEqual([]);
  });

  it('sends the changed lines only, without a single context line, for changed-lines-only', async () => {
    state.settings.aiPreReview = true;
    state.settings.aiPreReviewPromptScope = 'changed-lines-only';
    const model = createModel({ answer });
    setModel(model);

    await runAiPreReview(config, undefined, controller, params(), testHost());

    const prompt = sentPrompt(model);
    expect(prompt).toContain('[diff]');
    expect(prompt).toContain('--- src/index.ts ---');
    expect(prompt).toContain("+console.log('hello');");
    // The hunk header is what keeps the added line's number unambiguous.
    expect(prompt).toContain('@@ -1,2 +1,3 @@');
    // The context lines are exactly what this scope does not pay for.
    expect(prompt).not.toContain(' const a = 1;');
    expect(prompt).not.toContain(' const b = 2;');
    expect(prompt).not.toContain('[changed-file-contents]');
    expect(contentReads()).toEqual([]);
  });

  it('keeps the whole diff, context lines and all, for full-diff', async () => {
    state.settings.aiPreReview = true;
    state.settings.aiPreReviewPromptScope = 'full-diff';
    const model = createModel({ answer });
    setModel(model);

    await runAiPreReview(config, undefined, controller, params(), testHost());

    const prompt = sentPrompt(model);
    expect(prompt).toContain('[diff]');
    expect(prompt).toContain(' const a = 1;');
    expect(prompt).toContain(' const b = 2;');
    expect(prompt).not.toContain('[changed-file-contents]');
    expect(contentReads()).toEqual([]);
  });

  it('adds the changed files themselves, at the head ref, for changed-files', async () => {
    state.settings.aiPreReview = true;
    state.settings.aiPreReviewPromptScope = 'changed-files';
    state.settings.aiPreReviewModel = 'fake/fake-model';
    const model = createModel({ answer });
    setModel(model);
    const requested: string[] = [];
    mockServer.events.on('request:start', (event: { request: Request }) => requested.push(event.request.url));

    await runAiPreReview(config, undefined, controller, params(), testHost());

    const prompt = sentPrompt(model);
    // The diff is still there, context lines included…
    expect(prompt).toContain('[diff]');
    expect(prompt).toContain(' const a = 1;');
    // …and the file's own head text is what this scope adds.
    expect(prompt).toContain('[changed-file-contents]');
    expect(prompt).toContain('export function greet(name: string): string {');
    // Only the pull request's changed files were read, and only at its head sha
    // (never the default branch, which would send code the review is not about).
    expect(contentReads().map((entry) => entry.path)).toEqual([indexPath]);
    expect(requested.filter((url) => url.includes('/contents/'))).toEqual([
      `https://forgejo.example.com${indexPath}?ref=def456`,
    ]);
  });

  it('still sends only the brief when the feature switch is on and the scope says metadata-only', async () => {
    state.settings.aiPreReview = true;
    state.settings.aiPreReviewPromptScope = 'metadata-only';
    const model = createModel({ answer });
    setModel(model);

    await runAiPreReview(config, undefined, controller, params(), testHost());

    expect(sentPrompt(model)).not.toContain('[diff]');
  });
});

/**
 * The prompt-scope question: the one modal, the write it causes, and the
 * fail-closed arm.
 *
 * Every case here starts from the setting's own default (`ask`) rather than the
 * suite's stated-scope default, because that is the state a first run sees.
 */
describe('the prompt-scope question', () => {
  const answer = '{"comments":[]}';

  /** The modal call, if this run showed one. */
  function scopeModalCall(): unknown[] | undefined {
    return vi
      .mocked(vscode.window.showInformationMessage)
      .mock.calls.find(([, options]) => (options as { modal?: boolean } | undefined)?.modal === true);
  }

  function scopeModalMessage(): string {
    return String(scopeModalCall()?.[0] ?? '');
  }

  function scopeModalButtons(): string[] {
    return (scopeModalCall()?.slice(2) ?? []).map((button) => String(button));
  }

  /**
   * Answers the modal with one of its own buttons (or dismisses it), and runs
   * `beforeAnswer` at the instant the question is on screen — which is how "no
   * request and no model call happened before the answer" becomes an assertion
   * about that moment rather than about the end of the run.
   */
  function answerScopeModal(button: string | undefined, beforeAnswer?: () => void): void {
    vi.mocked(vscode.window.showInformationMessage).mockImplementation((async (
      _message: unknown,
      options: unknown,
      ...items: unknown[]
    ) => {
      if ((options as { modal?: boolean } | undefined)?.modal !== true) {
        return undefined;
      }
      beforeAnswer?.();
      return items.find((item) => item === button);
    }) as never);
  }

  it('writes the answered scope and continues the run with it', async () => {
    state.settings.aiPreReview = true;
    state.settings.aiPreReviewPromptScope = 'ask';
    // Configured, so the only write this run can make is the scope's.
    state.settings.aiPreReviewModel = 'fake/fake-model';
    const model = createModel({ answer });
    setModel(model);
    answerScopeModal(AI_PRE_REVIEW_SCOPE_BUTTON_CHANGED_FILES);

    await runAiPreReview(config, undefined, controller, params(), testHost());

    expect(scopeModalCall()).toBeDefined();
    expect(scopeModalButtons()).toEqual([
      AI_PRE_REVIEW_SCOPE_BUTTON_CHANGED_FILES,
      AI_PRE_REVIEW_SCOPE_BUTTON_CHANGED_LINES,
      AI_PRE_REVIEW_SCOPE_BUTTON_METADATA_ONLY,
      AI_PRE_REVIEW_SCOPE_BUTTON_CANCEL,
    ]);
    // The choice is a normal global configuration update, exactly like the model
    // choice: visible, auditable and editable in the Settings UI.
    expect(state.settingUpdates).toEqual([
      { key: 'aiPreReviewPromptScope', value: 'changed-files', target: vscode.ConfigurationTarget.Global },
    ]);
    expect(state.settings.aiPreReviewPromptScope).toBe('changed-files');
    // …and the run continued with the scope it just wrote.
    expect(model.sendRequest).toHaveBeenCalledTimes(1);
    expect(sentPrompt(model)).toContain('[changed-file-contents]');
  });

  it('names the provider the content would go to', async () => {
    state.settings.aiPreReview = true;
    state.settings.aiPreReviewPromptScope = 'ask';
    state.settings.aiPreReviewModel = 'fake/fake-model';
    setModel(createModel({ answer }));
    answerScopeModal(AI_PRE_REVIEW_SCOPE_BUTTON_METADATA_ONLY);

    await runAiPreReview(config, undefined, controller, params(), testHost());

    const message = scopeModalMessage();
    expect(message).toContain('belongs to the "fake" provider');
    // The honest warning the task requires for the no-code scope.
    expect(message).toContain('no code at all');
    expect(message).toContain('cannot read a single changed line');
    // And the two facts that make the answer meaningful.
    expect(message).toContain('Nothing is requested or sent before you answer');
    expect(message).toContain('"forgejoToolkit.aiPreReviewPromptScope"');
  });

  it('sends nothing at all before the question is answered', async () => {
    state.settings.aiPreReview = true;
    state.settings.aiPreReviewPromptScope = 'ask';
    state.settings.aiPreReviewModel = 'fake/fake-model';
    const model = createModel({ answer });
    setModel(model);
    let atAnswerTime: { requests: number; modelCalls: number; writes: number } | undefined;
    answerScopeModal(AI_PRE_REVIEW_SCOPE_BUTTON_CHANGED_LINES, () => {
      atAnswerTime = {
        requests: captured.length,
        modelCalls: (model.sendRequest as unknown as SendRequestMock).mock.calls.length,
        writes: state.settingUpdates.length,
      };
    });

    await runAiPreReview(config, undefined, controller, params(), testHost());

    expect(atAnswerTime).toEqual({ requests: 0, modelCalls: 0, writes: 0 });
    // The answer was then honored: the cheapest code scope, written and used.
    expect(state.settings.aiPreReviewPromptScope).toBe('changed-lines-only');
    expect(sentPrompt(model)).toContain("+console.log('hello');");
    expect(sentPrompt(model)).not.toContain(' const a = 1;');
  });

  it('aborts with a clear message, no model call and no write when it is dismissed', async () => {
    state.settings.aiPreReview = true;
    state.settings.aiPreReviewPromptScope = 'ask';
    state.settings.aiPreReviewModel = 'fake/fake-model';
    const model = createModel({ answer });
    setModel(model);
    answerScopeModal(undefined);

    await runAiPreReview(config, undefined, controller, params(), testHost());

    expect(model.sendRequest).not.toHaveBeenCalled();
    // Fail-closed: nothing was read, nothing was written, and the setting still
    // asks the question for the next run.
    expect(captured).toEqual([]);
    expect(state.settingUpdates).toEqual([]);
    expect(state.settings.aiPreReviewPromptScope).toBe('ask');
    expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(
      expect.stringContaining('no prompt scope was chosen'),
    );
    expect(await postedBodies('/reviews')).toEqual([]);
  });

  it('treats the explicit cancel button exactly like a dismissal', async () => {
    state.settings.aiPreReview = true;
    state.settings.aiPreReviewPromptScope = 'ask';
    state.settings.aiPreReviewModel = 'fake/fake-model';
    const model = createModel({ answer });
    setModel(model);
    answerScopeModal(AI_PRE_REVIEW_SCOPE_BUTTON_CANCEL);

    await runAiPreReview(config, undefined, controller, params(), testHost());

    expect(model.sendRequest).not.toHaveBeenCalled();
    expect(state.settingUpdates).toEqual([]);
    expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(
      expect.stringContaining('no prompt scope was chosen'),
    );
  });

  it('asks nothing and writes nothing when a scope is already stated', async () => {
    state.settings.aiPreReview = true;
    state.settings.aiPreReviewPromptScope = 'full-diff';
    state.settings.aiPreReviewModel = 'fake/fake-model';
    setModel(createModel({ answer }));

    await runAiPreReview(config, undefined, controller, params(), testHost());

    expect(scopeModalCall()).toBeUndefined();
    expect(state.settingUpdates).toEqual([]);
  });
});

/**
 * The language the proposed comment bodies are written in.
 *
 * The model writes an English instruction block, so nothing but an explicit rule
 * makes it answer in Chinese on a Chinese editor — the acceptance run that found
 * this produced English bodies on a `zh-cn` editor. These cases assert the
 * **bytes that went out**: which language the rule names, that the rule is in
 * the prompt exactly once, and that both attempts of the one model send the same
 * prompt rather than a re-built one.
 */
describe('the language the comment bodies are asked for', () => {
  const answer = '{"comments":[]}';

  /** The instruction rule, counted in one message. */
  function languageRuleCount(text: string): number {
    return text.split('Write every comment body in').length - 1;
  }

  afterEach(() => {
    // The mock's display language is module-wide; every other case in this file
    // reads `en`, so a case that changes it puts it back.
    (vscode.env as { language: string }).language = 'en';
  });

  it('names Chinese in the prompt for a zh editor, and only once', async () => {
    state.settings.aiPreReview = true;
    state.settings.aiPreReviewModel = 'fake/fake-model';
    // The locale setting decides even against an English VS Code: it is the
    // language every surface that shows these bodies renders in.
    state.settings.locale = 'zh';
    (vscode.env as { language: string }).language = 'en-US';
    const model = createModel({ answer });
    setModel(model);

    await runAiPreReview(config, undefined, controller, params(), testHost());

    const prompt = sentPrompt(model);
    expect(prompt).toContain('Write every comment body in 简体中文');
    expect(prompt).not.toContain('body in English');
    // Once in the prompt, not once per rule and not appended per attempt.
    expect(languageRuleCount(prompt)).toBe(1);
    // The non-prose half of the rule is stated beside it, so the model is not
    // left to decide whether the JSON keys may be translated.
    expect(prompt).toContain('every value that is not prose');
    expect(prompt).toContain('"head"/"base"');
  });

  it('names English in the prompt for an en editor, and follows VS Code', async () => {
    state.settings.aiPreReview = true;
    state.settings.aiPreReviewModel = 'fake/fake-model';
    // No locale setting: the editor's display language decides, and this one is
    // English.
    (vscode.env as { language: string }).language = 'en';
    const model = createModel({ answer });
    setModel(model);

    await runAiPreReview(config, undefined, controller, params(), testHost());

    const prompt = sentPrompt(model);
    expect(prompt).toContain('Write every comment body in English');
    expect(prompt).not.toContain('简体中文');
    expect(languageRuleCount(prompt)).toBe(1);
  });

  it('follows a zh-cn display language when the setting states nothing', async () => {
    state.settings.aiPreReview = true;
    state.settings.aiPreReviewModel = 'fake/fake-model';
    (vscode.env as { language: string }).language = 'zh-cn';
    const model = createModel({ answer });
    setModel(model);

    await runAiPreReview(config, undefined, controller, params(), testHost());

    expect(sentPrompt(model)).toContain('Write every comment body in 简体中文');
  });

  it('sends the same language prompt to both attempts of the one model', async () => {
    state.settings.aiPreReview = true;
    state.settings.aiPreReviewModel = 'fake/fake-model';
    state.settings.locale = 'zh';
    // The retry's two asks: the first answer breaks the contract, so the same
    // model is asked the same question again.
    const model = createModel({ answers: ['comments[]', answer] });
    setModel(model);

    await runAiPreReview(config, undefined, controller, params(), testHost());

    const calls = (model.sendRequest as unknown as SendRequestMock).mock.calls;
    expect(calls).toHaveLength(2);
    // Same bytes, so "the same model, the same prompt" holds across the retry…
    expect(calls[1]?.[0]).toEqual(calls[0]?.[0]);
    // …and the rule was neither dropped nor duplicated by the second attempt.
    for (const call of calls) {
      const text = call[0]?.map((message) => message.content).join('\n') ?? '';
      expect(languageRuleCount(text)).toBe(1);
      expect(text).toContain('Write every comment body in 简体中文');
    }
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

    await runAiPreReview(config, undefined, controller, params(), testHost());

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

    await runAiPreReview(config, undefined, controller, params(), testHost());

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
      expect.stringContaining('Set the setting "forgejoToolkit.aiPreReviewPromptScope" to "changed-lines-only"'),
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

  it('hands every validated candidate to the panel in full, and writes nothing when it is dismissed', async () => {
    state.settings.aiPreReview = true;
    // The model is configured, so the only question this run asks is the panel.
    state.settings.aiPreReviewModel = 'fake/fake-model';
    state.settings.aiPreReviewPromptScope = 'changed-files';
    setModel(createModel({ answer: validAnswer }));
    installPanel({ kind: 'cancel' });

    await runAiPreReview(config, undefined, controller, params(), testHost());

    const payload = panelPayload();
    // The header states what the quick pick had no room for: the scope that run
    // actually used, the model (with its vendor), both counts — and, now that the
    // entry point is the pull request detail page, how much of the pull request
    // the run covered. The default fixture is a one-file pull request, so covered
    // and fetched are the same number.
    expect(payload.scope).toBe('changed-files');
    expect(payload.candidateCount).toBe(2);
    expect(payload.changedFileCount).toBe(1);
    expect(payload.changedFilesTotal).toBe(1);
    expect(payload.drops).toEqual([]);
    expect(payload).toMatchObject({ owner: 'demo-user', repo: 'demo-repo', index: 2 });
    expect((payload.model as { vendor: string }).vendor).toBe('fake');

    const candidates = panelCandidates();
    expect(candidates).toHaveLength(2);
    expect(candidates.map((candidate) => candidate.index)).toEqual([0, 1]);
    expect(candidates[0]).toMatchObject({ path: 'src/index.ts', line: 2, side: 'head', extraLines: 0 });
    expect(candidates[1]).toMatchObject({ path: 'src/index.ts', line: 1, side: 'base', extraLines: 0 });
    // The whole body — the reason the panel replaced the quick pick, whose label
    // VS Code truncates and which had no description or tooltip to hold the rest.
    expect(candidates[0].body).toBe('This logs on every call.');
    expect(candidates[1].body).toBe('The old first line is gone.');
    // The "open the diff" link's own facts, read from the same response the diff
    // came from: the head sha of this pull request.
    expect((candidates[0].diff as { headSha?: string }).headSha).toBe('def456');
    expect((candidates[0].diff as { status?: string }).status).toBe('modified');

    // Nothing was created, and the run reported the same cancellation sentence a
    // declined quick pick used to.
    expect(await postedBodies('/reviews')).toEqual([]);
    expect(panelState.results).toEqual([]);
    expect(panelState.disposed).toBe(1);
    expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(
      expect.stringContaining('was cancelled. No comments were created'),
    );
  });

  it('pins the confirmation guarantees: nothing pre-checked, no accept-all entry of ours', async () => {
    state.settings.aiPreReview = true;
    state.settings.aiPreReviewModel = 'fake/fake-model';
    setModel(createModel({ answer: validAnswer }));
    installPanel({ kind: 'cancel' });

    await runAiPreReview(config, undefined, controller, params(), testHost());

    const candidates = panelCandidates();
    expect(candidates).toHaveLength(2);
    // Every card is one candidate that passed the anchor validation, and its
    // fields are exactly the ones a card renders. There is no "checked",
    // "picked" or "selectAll" field anywhere in the payload: the extension
    // contributes no accept-all entry and pre-selects nothing, so the component
    // (see `webview/src/__tests__/AiPreReviewPanel.test.ts`) starts with nothing
    // checked because there is nothing to start from.
    for (const candidate of candidates) {
      expect(Object.keys(candidate).sort()).toEqual(['body', 'diff', 'extraLines', 'index', 'line', 'path', 'side']);
    }
    expect(Object.keys(panelPayload())).not.toContain('selectAll');
    expect(Object.keys(panelPayload())).not.toContain('checked');
  });

  it('reports the dropped reasons grouped, one line per reason, to the panel', async () => {
    state.settings.aiPreReview = true;
    state.settings.aiPreReviewModel = 'fake/fake-model';
    setModel(
      createModel({
        answer: JSON.stringify({
          comments: [
            { path: 'src/index.ts', line: 2, side: 'head', extraLines: 0, body: 'Kept.' },
            { path: 'src/index.ts', line: 99, side: 'head', extraLines: 0, body: 'Off the file.' },
            { path: 'src/other.ts', line: 1, side: 'head', extraLines: 0, body: 'Wrong file.' },
          ],
        }),
      }),
    );
    installPanel({ kind: 'cancel' });

    await runAiPreReview(config, undefined, controller, params(), testHost());

    // The quick pick could only say how many were dropped, in a sentence; the
    // panel's header names each reason with its own count.
    expect(panelPayload().drops).toEqual([
      { label: 'line not in the diff', count: 1 },
      { label: 'path not in the changed files', count: 1 },
    ]);
    expect(panelCandidates()).toHaveLength(1);
    expect(panelPayload().candidateCount).toBe(1);
  });

  it('writes only the confirmed comments and never submits a review', async () => {
    state.settings.aiPreReview = true;
    setModel(createModel({ answer: validAnswer }));
    pickFirst();

    await runAiPreReview(config, undefined, controller, params(), testHost());

    const created = await postedBodies('/reviews');
    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({ event: 'PENDING', body: '.', comments: [{ new_position: 2 }] });
    // Exactly one review was opened and no second comment was appended: the
    // user confirmed one of the two candidates.
    expect(await postedBodies('/comments')).toEqual([]);
    // The only request to `/reviews/...` routes is the list read; nothing
    // submitted (`POST /reviews/{id}`) and nothing was deleted.
    expect(captured.filter((entry) => /\/reviews\/\d+$/.test(entry.path))).toEqual([]);
    // The panel stays open on what it produced, and is told the outcome.
    expect(panelState.results).toEqual([{ created: 1 }]);
    expect(panelState.disposed).toBe(0);
    expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(
      expect.stringContaining('Started a pending review with 1 draft comment(s)'),
    );
  });

  it('writes nothing when the panel answers with an empty selection', async () => {
    state.settings.aiPreReview = true;
    // Configured, so the only question this run asks is the panel.
    state.settings.aiPreReviewModel = 'fake/fake-model';
    setModel(createModel({ answer: validAnswer }));
    // The panel's own Create action is disabled with nothing checked, so this is
    // a defensive case: an answer that names no card must still write nothing
    // rather than open a review with no comments in it.
    installPanel({ kind: 'create', entries: [] });

    await runAiPreReview(config, undefined, controller, params(), testHost());

    expect(await postedBodies('/reviews')).toEqual([]);
    expect(await postedBodies('/comments')).toEqual([]);
    expect(panelState.results).toEqual([]);
    expect(panelState.disposed).toBe(1);
  });

  it('creates the draft with the body the user edited, not the wording the model proposed', async () => {
    state.settings.aiPreReview = true;
    state.settings.aiPreReviewModel = 'fake/fake-model';
    setModel(createModel({ answer: validAnswer }));
    // The answer carries what the panel's editor held: the user rewrote the
    // wording before the draft existed, which is what the whole change is for.
    installPanel({ kind: 'create', entries: [{ index: 0, body: 'My own wording instead.' }] });

    await runAiPreReview(config, undefined, controller, params(), testHost());

    const opened = await postedBodies('/reviews');
    expect(opened).toHaveLength(1);
    const comments = opened[0].comments as Array<Record<string, unknown>>;
    expect(comments).toHaveLength(1);
    // The edited text is what reaches the server; the anchor is still the run's
    // own candidate (line 2 of the head side), so nothing about where the comment
    // lands came from the webview.
    expect(comments[0]).toMatchObject({ new_position: 2, body: 'My own wording instead.' });
    expect(panelState.results).toEqual([{ created: 1 }]);
    // The model's own wording is not written anywhere in this run.
    expect(JSON.stringify(opened)).not.toContain('This logs on every call.');
  });

  it('takes every anchor from its own candidate, even when the answer carries anchor fields', async () => {
    state.settings.aiPreReview = true;
    state.settings.aiPreReviewModel = 'fake/fake-model';
    setModel(createModel({ answer: validAnswer }));
    // A modified message: the entry names another path, line and side. Only the
    // index and the body may be read from it, so the comment must still anchor to
    // the run's own candidate for card 0 (src/index.ts line 2, head side).
    installPanel({
      kind: 'create',
      entries: [
        {
          index: 0,
          body: 'Edited.',
          path: '../etc/passwd',
          line: 999,
          side: 'base',
          extraLines: 40,
        } as { index: number; body: string },
      ],
    });

    await runAiPreReview(config, undefined, controller, params(), testHost());

    const comments = (await postedBodies('/reviews'))[0].comments as Array<Record<string, unknown>>;
    expect(comments[0]).toMatchObject({ path: 'src/index.ts', new_position: 2, body: 'Edited.' });
    expect(comments[0].old_position).toBeUndefined();
    expect(comments[0].extra_lines_count).toBeUndefined();
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

    await runAiPreReview(config, undefined, controller, params(), testHost());

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

    await runAiPreReview(config, undefined, controller, params(), testHost());

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

    await runAiPreReview(config, undefined, controller, params(), testHost());

    const candidates = panelCandidates();
    expect(candidates).toHaveLength(1);
    expect(candidates[0].body).toBe('Valid one.');
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
    // Configured, so the panel assertion below is about the confirmation step: a
    // run left with nothing to confirm must not ask about it.
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

    await runAiPreReview(config, undefined, controller, params(), testHost());

    expect(panelState.createOrShow).not.toHaveBeenCalled();
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

    await runAiPreReview(config, undefined, controller, params(), testHost({ logUri }));

    await expect(fs.promises.access(dumpPath(directory))).rejects.toThrow();
    expect(await fs.promises.readdir(directory)).toEqual([]);
    // And the channel got nothing about a dump either: the path is only
    // announced when there is a file to announce.
    expect(loggedLines().some((line) => line.includes('diagnostics'))).toBe(false);
  });

  it('writes the exact messages and the full raw answer while debug is on', async () => {
    state.settings.aiPreReview = true;
    // The `full-diff` scope so the request carries code, and the answer keeps
    // code of its own past its first line: the dump is the one place both are
    // allowed to appear.
    state.settings.aiPreReviewPromptScope = 'full-diff';
    debugging();
    const firstLine = 'Sorry, I cannot answer in JSON.';
    const longAnswer = `${firstLine}\n${'hiddenAnswerMarker '.repeat(200)}\n${'z'.repeat(4_000)}`;
    setModel(createModel({ answer: longAnswer, name: 'Ollama Local', id: 'llama-local', vendor: 'ollama' }));
    const { logUri, directory } = await logDirectory();

    await runAiPreReview(config, undefined, controller, params(), testHost({ logUri }));

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
    // The channel names the file and still never the text beyond the bounded
    // excerpt the failure report itself carries.
    expect(loggedLines()).toContainEqual(expect.stringContaining(`are written to ${dumpPath(directory)}`));
    for (const line of loggedLines()) {
      // The `z` run lives past the excerpt cap, so only the dump can hold it;
      // the prompt reaches neither.
      expect(line).not.toContain('z'.repeat(200));
      expect(line).not.toContain(AI_PRE_REVIEW_SYSTEM_PROMPT);
    }
  });

  it('keeps the instruction bytes the run sent in the dump, not a reconstruction', async () => {
    state.settings.aiPreReview = true;
    // A Chinese editor: the bytes in the file have to be the run's own
    // instruction block, not the English constant the probe and the tests pin.
    state.settings.locale = 'zh';
    debugging();
    setModel(createModel({ answer: '{"comments":[]}' }));
    const { logUri, directory } = await logDirectory();

    await runAiPreReview(config, undefined, controller, params(), testHost({ logUri }));

    const text = await dumpText(directory);
    expect(text).toContain('Write every comment body in 简体中文');
    expect(text).not.toContain('Write every comment body in English');
    // The English block is a different string entirely, so its absence is what
    // proves the dump holds the bytes the run sent.
    expect(text).not.toContain(AI_PRE_REVIEW_SYSTEM_PROMPT);
  });

  it('numbers every attempt of the same model, so a repeated ask is visible', async () => {
    state.settings.aiPreReview = true;
    debugging();
    // The chosen model asked twice by the retry: the two blocks have to be
    // tellable apart, otherwise the dump cannot show that a retry happened.
    const flaky = createModel({ answers: ['comments[]', '{"comments":[]}'], id: 'flaky', name: 'Flaky Model' });
    setModels(flaky);
    const { logUri, directory } = await logDirectory();

    await runAiPreReview(config, undefined, controller, params(), testHost({ logUri }));

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

    await runAiPreReview(config, undefined, controller, params(), testHost({ logUri }));

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
 * The accumulation of a streamed answer.
 *
 * A real run's answer once came back as a scrambled copy of our own request with
 * its punctuation stripped, and one of the three possible causes was ours: a
 * `for await` loop that drops, reorders or re-encodes the fragments it is handed.
 * This suite rules that out the only way it can be ruled out — a fake stream
 * whose fragment boundaries fall exactly where a lossy accumulation would break
 * (inside a multi-byte character, inside an escape sequence, inside a JSON
 * string) — and asserts the accumulated string is the literal the fragments
 * spell out, code unit for code unit. It needs no model and no provider: the
 * stream is this file's own fake.
 */
describe('the streamed answer is accumulated byte for byte (hypothesis C)', () => {
  /**
   * The answer the fake provider streams, as one literal: valid JSON whose value
   * carries a comma, an escaped quote, an escaped backslash, a `\uXXXX` escape,
   * an em dash and an astral character (`𝄞`, a UTF-16 surrogate pair) — every
   * kind of content a punctuation-eating or byte-slicing accumulation would
   * lose.
   */
  const ANSWER =
    '{"comments":[{"path":"src/utils/\\u00e9\\"x\\".ts","line":3,"side":"head","extraLines":0,' +
    '"body":"a,b;c — \\"quoted\\", \\\\ backslash, \\u0041 escape, and 𝄞 astral"}],"note":"s,p,l,i,t"}';

  /** A log directory the run can write to, cleaned up by the suite's `afterEach`. */
  async function logDirectory(): Promise<{ logUri: vscode.Uri; directory: string }> {
    const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ai-pre-review-accumulation-'));
    logDirs.push(directory);
    return { logUri: { fsPath: directory } as unknown as vscode.Uri, directory };
  }

  /** The literal split at the given character offsets, in order. */
  function splitAt(text: string, offsets: readonly number[]): string[] {
    const fragments: string[] = [];
    let start = 0;
    for (const end of [...offsets].sort((a, b) => a - b)) {
      fragments.push(text.slice(start, end));
      start = end;
    }
    fragments.push(text.slice(start));
    return fragments;
  }

  /**
   * The literal as the fragments a provider would produce. Every boundary is
   * found by content, and the cases below assert that the boundaries really did
   * land inside the characters they name — otherwise a later edit could quietly
   * turn this into "one chunk, asserted equal to itself".
   */
  function fragmentsOf(text: string): string[] {
    return splitAt(text, [
      text.indexOf(',"line"') + 1, // between the comma and the quote that opens a JSON key
      text.indexOf('a,b;c') + 2, // inside a JSON string value, right after a comma
      text.indexOf('\\u0041') + 3, // inside a `\uXXXX` escape sequence
      text.indexOf('\\"quoted') + 1, // between the backslash and the quote it escapes
      text.indexOf('\\\\ backslash') + 1, // between the two halves of a literal backslash
      text.indexOf('𝄞') + 1, // between the two code units of an astral character
      text.indexOf(',"note"') + 1, // between the comma and the quote that opens a JSON string
    ]);
  }

  it('names the characters this case is built on, so the literal cannot drift', () => {
    const parsed = JSON.parse(ANSWER) as { comments: { body: string }[]; note: string };
    const body = parsed.comments[0]?.body ?? '';
    expect(body).toContain('a,b;c');
    expect(body).toContain('"quoted"');
    expect(body).toContain('\\ backslash');
    expect(body).toContain('A escape');
    expect(body).toContain('\u{1D11E}');
    expect(parsed.note).toBe('s,p,l,i,t');
  });

  it('splits the answer at the boundaries it claims', () => {
    const fragments = fragmentsOf(ANSWER);
    expect(fragments).toHaveLength(8);
    expect(fragments.some((fragment) => fragment.endsWith('\uD834'))).toBe(true);
    expect(fragments.some((fragment) => fragment.startsWith('\uDD1E'))).toBe(true);
    expect(fragments.some((fragment) => fragment.endsWith('\\u0'))).toBe(true);
    expect(fragments.some((fragment) => fragment.endsWith('\\'))).toBe(true);
    // A fragment that begins with a quoted JSON key and ends with a comma inside
    // a string value: a JSON string boundary and a comma both fall on it.
    expect(fragments).toContain('"line":3,"side":"head","extraLines":0,"body":"a,');
  });

  it('keeps every fragment of a streamed answer, byte for byte, in the debug dump', async () => {
    state.settings.aiPreReview = true;
    debugging();
    const model = createModel({ fragments: fragmentsOf(ANSWER) });
    setModel(model);
    const { logUri, directory } = await logDirectory();

    await runAiPreReview(config, undefined, controller, params(), testHost({ logUri }));

    // The one observable that says the accumulation lost, reordered or
    // re-encoded nothing: `toBe` is code-unit equality, so a dropped comma, a
    // moved fragment or a lone surrogate fails here. The same text is what the
    // parser and the model-output policy downstream see.
    const text = await fs.promises.readFile(path.join(directory, AI_PRE_REVIEW_DIAGNOSTICS_FILE_NAME), 'utf8');
    expect(recordedAnswer(text)).toBe(ANSWER);
    expect(text).toContain(`answer chars: ${ANSWER.length}`);
  });

  it('quotes a fragmented answer byte for byte in the contract-failure excerpt', async () => {
    state.settings.aiPreReview = true;
    // A punctuation-heavy answer that is not JSON — the shape the failing runs
    // produced — with its fragment boundaries inside the escapes and inside the
    // astral character, so both the log line's escape and the accumulation are
    // exercised at once.
    const mangled = 'comments{"":"/utils/re.tsline3sideheadextra":,"":"a,b;c — \\"q\\", \\\\ 𝄞, and [1,2]"}';
    expect(mangled.length).toBeLessThan(AI_PRE_REVIEW_ANSWER_EXCERPT_LENGTH);
    setModel(
      createModel({
        fragments: splitAt(mangled, [
          mangled.indexOf(',"') + 1,
          mangled.indexOf('\\"q') + 1,
          mangled.indexOf('\\\\') + 1,
          mangled.indexOf('𝄞') + 1,
        ]),
      }),
    );

    await runAiPreReview(config, undefined, controller, params(), testHost());

    // The failure line quotes the accumulated answer, escaped onto one line:
    // both its length and its text have to be the streamed ones, so an
    // accumulation that dropped a fragment could not produce this line.
    const line = loggedLines().find((entry) => entry.includes('returned an answer that is not JSON'));
    expect(line).toBeDefined();
    expect(line).toContain(`the answer is ${mangled.length} character(s), excerpt ${JSON.stringify(mangled)}`);
  });
});

/**
 * The debug-only fragment log.
 *
 * The maintainer's failure was an answer that came back as a punctuation-stripped
 * copy of the request, and the accumulation loop was already ruled out byte for
 * byte by the suite above — so what is left to observe is the transport itself:
 * where one fragment ended and the next began. The dump holds the concatenation;
 * these lines are the only surface that shows the boundaries, and the only way to
 * tell "the provider's fragments are already corrupt" from "our accumulation
 * corrupts them".
 *
 * The gate is `forgejoToolkit.debug` through `logger.isDebugEnabled()`, checked
 * before any line is handed to `logger.debug`, so with debug off the assertions
 * are exact: **not one** fragment line and no summary reaches the channel, and the
 * case that asserts "no answer text at all" keeps asserting it for that mode (it
 * was adapted below — see "logs no answer text at all when the run succeeds with
 * debug off" — because it additionally used to hold with debug on, which is
 * exactly what these lines change).
 *
 * A stream that does not parse is asked **again** (the bounded retry), so a case
 * about one call's fragments reads the list of that call, not the whole log: the
 * expectations below are written as repetitions of one attempt's block so a
 * retry cannot make them pass by accident.
 */
describe('the debug-only fragment log of a streamed answer', () => {
  /** The run-path fragment lines of the logged output, in the order they appeared. */
  function fragmentLines(): string[] {
    return loggedLines().filter((line) => line.startsWith('AI pre-review: answer fragment '));
  }

  /** Every run-path closing line, in the order they appeared (one per attempt). */
  function summaryLines(): string[] {
    return loggedLines().filter((line) => line.startsWith('AI pre-review: answer stream summary: '));
  }

  /** One attempt's fragment lines, formatted from the fragments themselves. */
  function expectedFragmentLines(fragments: readonly string[]): string[] {
    return fragments.map(
      (fragment, index) =>
        `AI pre-review: answer fragment ${index + 1} of ${fragments.length} in the stream: length=${
          fragment.length
        }, text=${JSON.stringify(fragment)}`,
    );
  }

  /** One attempt's closing line, formatted from the fragments themselves. */
  function expectedSummaryLine(fragments: readonly string[]): string {
    const answer = fragments.join('');
    return `AI pre-review: answer stream summary: ${fragments.length} fragment(s), ${answer.length} character(s), excerpt=${JSON.stringify(
      answer,
    )}`;
  }

  const escapingFragments = ['{"a":"b', ',c\\"d', '\\\\e","f":[1,', '2]}'];

  it('logs every fragment of the `text` projection with its index, its length and its escaped text', async () => {
    state.settings.aiPreReview = true;
    debugging();
    // Not JSON, so the run spends both of its attempts on the same model and the
    // same prompt — which is what makes the repetition below the expected shape
    // rather than an accident. The response carries **no stream parts**, so this
    // is the one path where the `text` projection really is the answer channel,
    // and its own chunk boundaries are what the fragment list has to show.
    setModel(createModel({ textChunks: escapingFragments, answer: escapingFragments.join('') }));

    await runAiPreReview(config, undefined, controller, params(), testHost());

    expect(fragmentLines()).toEqual([
      ...expectedFragmentLines(escapingFragments),
      ...expectedFragmentLines(escapingFragments),
    ]);
  });

  it('closes the list with the fragment total, the character total and the bounded answer beginning', async () => {
    state.settings.aiPreReview = true;
    debugging();
    // Not JSON, so it is the failed path — and the fragments are still logged,
    // because the boundaries describe the transport rather than the verdict.
    const fragments = ['{"":"', '}'];
    setModel(createModel({ textChunks: fragments, answer: fragments.join('') }));

    await runAiPreReview(config, undefined, controller, params(), testHost());

    expect(summaryLines()).toEqual([expectedSummaryLine(fragments), expectedSummaryLine(fragments)]);
  });

  it('caps a long fragment with the excerpt cap and says on the line that it was cut', async () => {
    state.settings.aiPreReview = true;
    debugging();
    // One fragment longer than the cap, plus the fragment after it: the cap is
    // what keeps the channel readable, and the boundary between the two is the
    // datum the whole line exists for.
    const longFragment = `${'a'.repeat(AI_PRE_REVIEW_ANSWER_EXCERPT_LENGTH)}${'b'.repeat(500)}`;
    const fragments = [longFragment, 'tail'];
    setModel(createModel({ textChunks: fragments, answer: fragments.join('') }));

    await runAiPreReview(config, undefined, controller, params(), testHost());

    const lines = fragmentLines();
    expect(lines[0]).toContain(`fragment 1 of ${fragments.length} in the stream`);
    expect(lines[0]).toContain(`length=${longFragment.length}`);
    // The `, cut` note is derived from the exported cap, so the two cannot drift:
    // the text is the helper's excerpt and never the whole fragment.
    expect(lines[0]).toContain(`, cut from ${longFragment.length} characters`);
    expect(lines[0]).toContain(JSON.stringify(longFragment.slice(0, AI_PRE_REVIEW_ANSWER_EXCERPT_LENGTH)));
    expect(lines[0]).not.toContain('b'.repeat(AI_PRE_REVIEW_ANSWER_EXCERPT_LENGTH));
    expect(lines[1]).toContain('text="tail"');
    expect(lines[1]).not.toContain(', cut from');
    // The summary quotes the bounded beginning of the concatenation, not the
    // `b` run that lives past the cap.
    const summary = summaryLines()[0] ?? '';
    expect(summary).toContain(JSON.stringify(longFragment.slice(0, AI_PRE_REVIEW_ANSWER_EXCERPT_LENGTH)));
    expect(summary).not.toContain('b'.repeat(AI_PRE_REVIEW_ANSWER_EXCERPT_LENGTH));
  });

  it('escapes a quote, a backslash, a newline and a tab onto one line', async () => {
    state.settings.aiPreReview = true;
    debugging();
    // The characters JSON escaping exists for: none of them may split the line,
    // and the escaped form is the one a reader can compare with the dump.
    const fragment = 'first\n"quoted"\\backslash\ttab';
    const chunks = [fragment, '{"":"}'];
    setModel(createModel({ textChunks: chunks, answer: chunks.join('') }));

    await runAiPreReview(config, undefined, controller, params(), testHost());

    expect(fragmentLines()[0]).toContain(`length=${fragment.length}, text=${JSON.stringify(fragment)}`);
    // Not one of the logged lines holds a real newline or a real tab: the escape
    // is what keeps a provider's text from splitting the log line apart.
    for (const line of loggedLines()) {
      expect(line).not.toContain('\n');
      expect(line).not.toContain('\t');
    }
  });

  it('keeps a fragment boundary inside an astral character visible, escaped', async () => {
    state.settings.aiPreReview = true;
    debugging();
    // The boundary falls between the two code units of `𝄞`: the halves must be
    // escaped as lone surrogates rather than printed raw, because a raw print
    // reassembles them into the astral character and hides exactly the boundary
    // this line exists to show.
    const pair = '𝄞';
    const chunks = [pair.slice(0, 1), pair.slice(1), '{"":"}'];
    setModel(createModel({ textChunks: chunks, answer: chunks.join('') }));

    await runAiPreReview(config, undefined, controller, params(), testHost());

    const lines = fragmentLines();
    expect(lines[0]).toContain(`text=${JSON.stringify(pair.slice(0, 1))}`);
    expect(lines[1]).toContain(`text=${JSON.stringify(pair.slice(1))}`);
    expect(lines[0]).toContain('\\ud834');
    expect(lines[1]).toContain('\\udd1e');
    expect(lines[0]).not.toContain(pair);
    expect(lines[1]).not.toContain(pair);
  });

  it('never puts the prompt, the brief or the diff on a fragment or summary line', async () => {
    state.settings.aiPreReview = true;
    // The diff body switch is on, so the request the run sends carries code: the
    // fragment lines describe the answer, and an answer is all they may carry.
    state.settings.aiPreReviewPromptScope = 'full-diff';
    debugging();
    setModel(createModel({ fragments: ['not json, ', 'plainly'] }));

    await runAiPreReview(config, undefined, controller, params(), testHost());

    // Both kinds of line, from both attempts: the summarising line is checked
    // with the fragment lines because a leak would land on either.
    const lines = [...fragmentLines(), ...summaryLines()];
    expect(lines.length).toBeGreaterThan(1);
    for (const line of lines) {
      // The fixed instructions, the changed-file table and the diff body (the
      // code itself, with and without its `+` prefix): what was **sent** may
      // never appear, because these lines describe only what came back.
      expect(line).not.toContain(AI_PRE_REVIEW_SYSTEM_PROMPT);
      expect(line).not.toContain('[changed-files]');
      expect(line).not.toContain("console.log('hello')");
      expect(line).not.toContain(MOCK_DIFF);
      expect(line).not.toContain('demo-repo');
    }
  });

  it('logs no fragment line and no summary at all while debug is off', async () => {
    state.settings.aiPreReview = true;
    // The suite's `beforeEach` leaves debug off; this is the default path.
    setModel(createModel({ fragments: ['{"":"', '}'] }));

    await runAiPreReview(config, undefined, controller, params(), testHost());

    expect(fragmentLines()).toEqual([]);
    expect(summaryLines()).toEqual([]);
    // And nothing in the channel's reader either: no message, no toast and no
    // notification carries an answer fragment.
    for (const surface of [
      ...vi.mocked(vscode.window.showInformationMessage).mock.calls,
      ...vi.mocked(vscode.window.showWarningMessage).mock.calls,
      ...vi.mocked(vscode.window.showErrorMessage).mock.calls,
    ]) {
      expect(String(surface[0])).not.toContain('answer fragment');
      expect(String(surface[0])).not.toContain('answer stream summary');
    }
  });

  it('logs nothing while the token is cancelled, even with debug on', async () => {
    state.settings.aiPreReview = true;
    // The run-path loop checks the token before every chunk, so a cancelled stream
    // returns out of the loop and never reaches the log call: this is the case
    // that would leak a half-read stream's fragments if that check moved below the
    // log line. (`state.cancelRequested` is what the mock's token reads.)
    state.cancelRequested = true;
    debugging();
    setModel(createModel({ fragments: ['not json, ', 'plainly'] }));

    await runAiPreReview(config, undefined, controller, params(), testHost());

    expect(fragmentLines()).toEqual([]);
    expect(summaryLines()).toEqual([]);
  });

  it('logs nothing when the provider aborts the stream part-way', async () => {
    state.settings.aiPreReview = true;
    debugging();
    // The provider itself aborts: `for await` throws, so the loop never reaches
    // its end and there is no fragment list to write.
    setModel(
      createModel({
        fragments: ['{"":"', '}'],
        streamFailWith: Object.assign(new Error('cancelled'), { name: 'AbortError' }),
      }),
    );

    await runAiPreReview(config, undefined, controller, params(), testHost());

    expect(fragmentLines()).toEqual([]);
    expect(summaryLines()).toEqual([]);
  });

  it('logs the fragments of the probe path too', async () => {
    state.settings.aiPreReview = true;
    state.settings.aiPreReviewModel = 'fake/normal';
    debugging();
    // The probe refuses without a log directory (it exists to produce the file),
    // so this case needs one; `afterEach` removes it.
    const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ai-pre-review-probe-fragments-'));
    logDirs.push(directory);
    // The trivial question, answered with `{"":"}` in two fragments: the probe
    // path accumulates its own stream, so it needs its own fragment list.
    const answer = '{"":"}';
    const fragments = ['{"":"', '}'];
    setModel(createModel({ answer, fragments, id: 'normal', name: 'Normal Model' }));

    await probeAiPreReviewChatModels({ logUri: { fsPath: directory } as unknown as vscode.Uri });

    const shapes = aiPreReviewProbeShapes();
    const probeFragments = loggedLines().filter((line) => line.startsWith('AI pre-review: answer fragment '));
    const probeSummaries = loggedLines().filter((line) => line.startsWith('AI pre-review: answer stream summary: '));
    // Every shape the probe asked is one stream, and each one is logged whole.
    expect(probeFragments).toHaveLength(shapes.length * fragments.length);
    expect(probeSummaries).toHaveLength(shapes.length);
    expect(probeFragments).toContain(
      `AI pre-review: answer fragment 1 of ${fragments.length} in the stream: length=5, text=${JSON.stringify(
        fragments[0],
      )}`,
    );
    expect(probeSummaries[0]).toBe(
      `AI pre-review: answer stream summary: ${fragments.length} fragment(s), ${answer.length} character(s), excerpt=${JSON.stringify(
        answer,
      )}`,
    );
  });
});

/**
 * The debug-only **parts** log: `LanguageModelChatResponse.stream` beside the
 * `text` projection the run parses.
 *
 * Every case drives the probe rather than a run: the probe is one bare model call
 * with no pull request behind it, and it exercises the very same
 * `logResponseStreamParts` — so what is tested is the diagnostic, not a second
 * copy of it. The probe asks its shapes in order, one request each, so the lines
 * are grouped in that order and the case reads them back the same way.
 */
describe('the debug-only parts log of a response stream', () => {
  /** The probe's own shape list: the number of requests the cases have to expect. */
  const shapes = aiPreReviewProbeShapes().length;

  /** Every `part #…` line, in the order it was logged. */
  function partLines(): string[] {
    return loggedLines().filter((line) => /^AI pre-review: part #\d+ \(\d+ so far\) in the stream: /.test(line));
  }

  /** Every closing tally, in the order it was logged (one per request). */
  function tallyLines(): string[] {
    return loggedLines().filter((line) => line.startsWith('AI pre-review: part stream summary: '));
  }

  /** The parts lines of one request, in order — the probe asks one shape per request. */
  function partsOfRequest(index: number, perRequest: number): string[] {
    return partLines().slice(index * perRequest, (index + 1) * perRequest);
  }

  /** The tally of one request. */
  function tallyOfRequest(index: number): string {
    return tallyLines()[index] ?? '';
  }

  /** One text part's line, formatted from the part itself. */
  function expectedTextPartLine(index: number, value: string): string {
    return `AI pre-review: part #${index} (${index} so far) in the stream: kind=text, length=${
      value.length
    }, text=${JSON.stringify(value)}`;
  }

  /** One tool-call part's line, formatted from the part itself. */
  function expectedToolCallLine(index: number, name: string, input: object): string {
    const serialised = JSON.stringify(input);
    return `AI pre-review: part #${index} (${index} so far) in the stream: kind=tool-call, length=${
      (name + serialised).length
    }, tool=${JSON.stringify(name)}, input=${JSON.stringify(serialised)}`;
  }

  /**
   * One unknown part's line, formatted from the value's own JSON form.
   *
   * `kind` is spelled out at every call site rather than defaulted: the kind is
   * the part of the line under test (a plain object literal reports its real
   * constructor, `Object`, beside its `typeof`), so a case that hid it behind a
   * default would stop asserting it.
   */
  function expectedUnknownLine(index: number, value: unknown, kind: string): string {
    const raw = JSON.stringify(value);
    return `AI pre-review: part #${index} (${index} so far) in the stream: kind=${kind}, length=${
      raw.length
    }, inspection=${JSON.stringify(raw)}`;
  }

  /** One tally line, formatted from the kinds that arrived and the text they carried. */
  function expectedTally(kinds: readonly string[], text: string): string {
    const counts = new Map<string, number>();
    for (const kind of kinds) {
      counts.set(kind, (counts.get(kind) ?? 0) + 1);
    }
    const tally = counts.size === 0 ? 'no parts' : [...counts].map(([kind, count]) => `${count} ${kind}`).join(', ');
    const textParts = kinds.filter((kind) => kind === 'text').length;
    return `AI pre-review: part stream summary: ${kinds.length} part(s) (${tally}), ${textParts} text part(s) carrying ${text.length} character(s)`;
  }

  /** Runs the probe against one offered model with a log directory, as it requires. */
  async function runProbe(): Promise<void> {
    state.settings.aiPreReview = true;
    state.settings.aiPreReviewModel = 'fake/normal';
    const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ai-pre-review-probe-parts-'));
    logDirs.push(directory);
    await probeAiPreReviewChatModels({ logUri: { fsPath: directory } as unknown as vscode.Uri });
  }

  it('logs a text part with its kind, its length and its text', async () => {
    debugging();
    const parts = [partOfText('{"":"'), partOfText('}')];
    setModel(createModel({ answer: '{"":"}', parts, id: 'normal', name: 'Normal Model' }));

    await runProbe();

    expect(partLines()).toHaveLength(shapes * parts.length);
    // The probe asks the same question in every shape, so every request's parts
    // are the same two text parts — and the first request is read back literally.
    expect(partsOfRequest(0, 2)).toEqual([expectedTextPartLine(1, '{"":"'), expectedTextPartLine(2, '}')]);
  });

  it('logs a tool-call part with its tool name and its JSON input', async () => {
    debugging();
    const input = { comments: [{ path: 'src/index.ts', line: 3 }] };
    const parts = [partOfToolCall('forgejo_review', input), partOfText('{}')];
    setModel(createModel({ answer: '{}', parts, id: 'normal', name: 'Normal Model' }));

    await runProbe();

    // The name and the structured input are the whole point of the line: this is
    // the payload a text-level corruption of the answer cannot explain away.
    expect(partLines()).toContain(expectedToolCallLine(1, 'forgejo_review', input));
  });

  it('inspects an unknown part by its shape and never throws', async () => {
    debugging();
    const unknown = { mimeType: 'application/json', data: 'AQID' };
    const parts = [partOfUnknown(unknown), partOfText('{}')];
    setModel(createModel({ answer: '{}', parts, id: 'normal', name: 'Normal Model' }));

    await runProbe();

    // No provider class is behind this value, so the kind says `unknown` beside
    // its `typeof` and the content is the bounded inspection of its shape.
    expect(partLines()).toContain(expectedUnknownLine(1, unknown, 'unknown (Object, typeof=object)'));
  });

  it('describes a primitive part instead of reporting a class it does not have', async () => {
    debugging();
    // The `unknown` arm of the stream type includes values that are not objects
    // at all; one of those has no constructor name to report, so the kind is the
    // `typeof` alone — and the inspection is still a bounded one-liner.
    const parts = [partOfUnknown('a bare string part'), partOfText('{}')];
    setModel(createModel({ answer: '{}', parts, id: 'normal', name: 'Normal Model' }));

    await runProbe();

    expect(partLines()).toContain(expectedUnknownLine(1, 'a bare string part', 'unknown (typeof=string)'));
  });

  it('names the runtime class of an unknown part when it has one', async () => {
    debugging();
    // A part from a newer editor version: a real class the typings do not name,
    // so `unknown` is honest while the class name still says which channel it is.
    class LanguageModelDataPart {
      constructor(public mimeType: string) {}
    }
    const parts = [partOfUnknown(new LanguageModelDataPart('application/json')), partOfText('{}')];
    setModel(createModel({ answer: '{}', parts, id: 'normal', name: 'Normal Model' }));

    await runProbe();

    expect(partLines()).toContain(
      expectedUnknownLine(1, { mimeType: 'application/json' }, 'unknown (LanguageModelDataPart, typeof=object)'),
    );
  });

  it('describes an object that resists stringification instead of throwing', async () => {
    debugging();
    // An object whose `Symbol.toStringTag` getter throws: `Object.prototype
    // .toString` throws on it, so the inspection never runs unguarded against
    // whatever a provider decided to send. (Verified against the language: a
    // throwing `toStringTag` really does make `Object.prototype.toString.call`
    // throw.)
    const hostile = {
      get [Symbol.toStringTag](): string {
        throw new Error('no tag for you');
      },
    };
    expect(() => Object.prototype.toString.call(hostile)).toThrow('no tag for you');
    const parts = [partOfUnknown(hostile), partOfText('{}')];
    setModel(createModel({ answer: '{}', parts, id: 'normal', name: 'Normal Model' }));

    await runProbe();

    // The part still produced a line: the sweep describes what it cannot inspect
    // rather than dying on it.
    const line = partsOfRequest(0, 2)[0] ?? '';
    expect(line).toContain('kind=unknown (Object, typeof=object)');
    expect(line).toContain('inspection=');
  });
  it('keeps the tally of an unknown part keyed by that same kind', async () => {
    debugging();
    const unknown = { data: 'AQID' };
    const parts = [partOfText('{'), partOfUnknown(unknown), partOfText('}')];
    setModel(createModel({ answer: '{}', parts, id: 'normal', name: 'Normal Model' }));

    await runProbe();

    // One tally per response — the parts list is closed **after** the stream was
    // read once, so a response whose only text part is `{}` also logs the line
    // that says the parts carried no answer text at that length — and the kinds
    // are counted in the order they arrived.
    expect(tallyLines()).toContain(expectedTally(['text', 'unknown (Object, typeof=object)', 'text'], '{}'));
    expect(tallyOfRequest(0)).toBe(expectedTally(['text', 'unknown (Object, typeof=object)', 'text'], '{}'));
  });

  it('closes the list with how many parts of each kind arrived and how much text they carried', async () => {
    debugging();
    const parts = [partOfText('{"":"'), partOfText('}')];
    setModel(createModel({ answer: '{"":"}', parts, id: 'normal', name: 'Normal Model' }));

    await runProbe();

    expect(tallyOfRequest(0)).toBe(expectedTally(['text', 'text'], '{"":"}'));
  });

  it('caps an unknown part inspection at the excerpt cap and says on the line that it was cut', async () => {
    debugging();
    // An unknown part carrying a document: the cap is what keeps the channel
    // readable, and the `, cut` note is what keeps it from reading as short.
    const long = { data: 'a'.repeat(AI_PRE_REVIEW_ANSWER_EXCERPT_LENGTH + 400) };
    const raw = JSON.stringify(long);
    const parts = [partOfUnknown(long)];
    setModel(createModel({ answer: '', parts, id: 'normal', name: 'Normal Model' }));

    await runProbe();

    const line = partsOfRequest(0, 1)[0] ?? '';
    expect(line).toContain(`kind=unknown (Object, typeof=object), length=${raw.length}`);
    expect(line).toContain(`, inspection cut from ${raw.length} characters`);
    expect(line).toContain(JSON.stringify(raw.slice(0, AI_PRE_REVIEW_ANSWER_EXCERPT_LENGTH)));
    expect(line).not.toContain('a'.repeat(AI_PRE_REVIEW_ANSWER_EXCERPT_LENGTH + 1));
  });

  it('escapes a quote, a backslash, a newline and a tab onto one line', async () => {
    debugging();
    const value = 'first\n"quoted"\\backslash\ttab';
    const parts = [partOfUnknown({ value }), partOfText(value)];
    setModel(createModel({ answer: value, parts, id: 'normal', name: 'Normal Model' }));

    await runProbe();

    expect(partsOfRequest(0, 2)).toEqual([
      expectedUnknownLine(1, { value }, 'unknown (Object, typeof=object)'),
      expectedTextPartLine(2, value),
    ]);
    // Not one of the logged lines holds a real newline or a real tab: the escape
    // is what keeps a provider's own text from splitting the log line apart.
    for (const line of loggedLines()) {
      expect(line).not.toContain('\n');
      expect(line).not.toContain('\t');
    }
  });

  it('never puts the prompt, the brief or the diff on a part line', async () => {
    debugging();
    // The diff-body switch is on, so the request the probe sends is not the only
    // text in the process: the lines describe the answer and may not carry either.
    state.settings.aiPreReviewPromptScope = 'full-diff';
    const parts = [partOfText('{"":"'), partOfUnknown({ note: 'x' })];
    setModel(createModel({ answer: '{"":"}', parts, id: 'normal', name: 'Normal Model' }));

    await runProbe();

    const lines = [...partLines(), ...tallyLines()];
    expect(lines.length).toBeGreaterThan(1);
    for (const line of lines) {
      expect(line).not.toContain(AI_PRE_REVIEW_SYSTEM_PROMPT);
      expect(line).not.toContain(AI_PRE_REVIEW_PROBE_PROMPT);
      expect(line).not.toContain(AI_PRE_REVIEW_PROBE_ECHO_PROMPT);
      expect(line).not.toContain('[changed-files]');
      expect(line).not.toContain("console.log('hello')");
      expect(line).not.toContain(MOCK_DIFF);
      expect(line).not.toContain('demo-repo');
    }
  });

  it('logs no part line and no tally at all while debug is off', async () => {
    // The suite's `beforeEach` leaves debug off; this is the default path. The
    // response carries a tool call precisely so a stray line would be loud.
    const parts = [partOfToolCall('forgejo_review', { comments: [] }), partOfText('{}')];
    setModel(createModel({ answer: '{}', parts, id: 'normal', name: 'Normal Model' }));

    await runProbe();

    expect(partLines()).toEqual([]);
    expect(tallyLines()).toEqual([]);
    for (const surface of [
      ...vi.mocked(vscode.window.showInformationMessage).mock.calls,
      ...vi.mocked(vscode.window.showWarningMessage).mock.calls,
      ...vi.mocked(vscode.window.showErrorMessage).mock.calls,
    ]) {
      expect(String(surface[0])).not.toContain('part #');
      expect(String(surface[0])).not.toContain('part stream summary');
    }
  });

  it('leaves the answer the run parses exactly as it was when parts are inspected', async () => {
    // The one guarantee that matters for the fix: the stream view is read once and
    // the answer is one of its candidate channels, so a run whose parts spell the
    // contract out still parses it. The response's `stream` is a tool call
    // followed by two text parts — the answer, split — and the run takes it from
    // the **text candidate** rather than from the `text` projection beside it.
    state.settings.aiPreReview = true;
    state.settings.aiPreReviewPromptScope = 'full-diff';
    debugging();
    const answer = '{"comments":[]}';
    const parts = [
      partOfToolCall('forgejo_review', { path: 'src/index.ts' }),
      partOfText('{"comments"'),
      partOfText(':[]}'),
    ];
    setModel(createModel({ answer, parts }));

    await runAiPreReview(config, undefined, controller, params(), testHost());

    const summaries = loggedLines().filter((line) => line.startsWith('AI pre-review: answer stream summary: '));
    // Two parts, two fragments: the transport record describes the channel the
    // answer came from, and that channel is the parts.
    expect(summaries[0]).toBe(
      `AI pre-review: answer stream summary: 2 fragment(s), ${answer.length} character(s), excerpt=${JSON.stringify(
        answer,
      )}`,
    );
    // And the tool call really was inspected beside it: the parts pass ran, and
    // the parsed answer above is the text candidate's.
    expect(partLines().some((line) => line.includes('kind=tool-call'))).toBe(true);
    expect(
      loggedLines().some((line) =>
        line.includes('answer stream: using the text candidate (the text candidate was preferred'),
      ),
    ).toBe(true);
  });

  it('consumes the response once, and never reads the `text` projection beside a candidate stream', async () => {
    debugging();
    // The hazard the whole change removes: a second consumer on one response. The
    // fake throws on a second projection read (and on reading `text` at all), so a
    // run that read both — as the previous shape did — would fail loudly here
    // instead of quietly parsing whichever projection it happened to drain first.
    const parts = [partOfText('{}')];
    setModel(
      createModel({
        answer: '{}',
        parts,
        singleReadStream: true,
        forbidTextProjection: true,
        id: 'normal',
        name: 'Normal Model',
      }),
    );

    await runProbe();

    // The parts were read, the answer came from them, and no request failed: the
    // one-pass rule held for every call the probe made.
    expect(partLines().some((line) => line.includes('kind=text'))).toBe(true);
    expect(
      vi
        .mocked(vscode.window.showInformationMessage)
        .mock.calls.some((call) => String(call[0]).includes('model call failed')),
    ).toBe(false);
  });
});

/**
 * The **candidate streams** of one response and how the contract arbitrates them:
 * the fix the ninth investigation's real-machine data asked for.
 *
 * Measured on the maintainer's machine, `LanguageModelChatResponse.text` did not
 * carry the answer at all — it projected the model's reasoning token stream —
 * while the response's **text parts** concatenated to the exact expected literal.
 * The response arrived as RPC-serialised plain objects (`{"$mid":n,"value":…}`),
 * so the classification rules are exercised here on **both** of their shapes: the
 * classes the API declares and the measured envelope. The numbers themselves are
 * not the rule (they are editor internals): an envelope whose `$mid` this build
 * does not know stays a data part and the answer falls back to `text`.
 *
 * Every case drives the run or the probe, because the arbitration lives in the two
 * places that own a contract: the run's JSON contract and the probe's shape
 * verdict.
 */
describe('the candidate streams of a response and the contract that arbitrates them', () => {
  /**
   * The exact bytes the maintainer's machine produced, verbatim: the text parts
   * concatenate to the probe's expected literal (27 characters, valid JSON), and
   * the reasoning stream is the mangled `{"":",cdef12`.
   */
  const MEASURED_TEXT_ANSWER = '{"a":"b,c\\"d\\\\e","f":[1,2]}';
  const MEASURED_REASONING_TEXT = '{"":",cdef12';
  const MEASURED_TEXT_MID = 21;
  const MEASURED_REASONING_MID = 22;
  const MEASURED_DATA_MID = 24;

  /** One RPC-serialised text part, the shape the maintainer's machine showed. */
  function rpcText(value: string): unknown {
    return { $mid: MEASURED_TEXT_MID, value };
  }

  /** One RPC-serialised reasoning part. */
  function rpcReasoning(value: string): unknown {
    return { $mid: MEASURED_REASONING_MID, value };
  }

  /** One RPC-serialised data part (`usage`, `stateful_marker`): no `value` at all. */
  function rpcData(mimeType: string): unknown {
    return { $mid: MEASURED_DATA_MID, mimeType };
  }

  /** The arbitration debug line for the stream that was used. */
  function selectionLine(): string {
    return loggedLines().find((line) => line.includes('answer stream: ')) ?? '';
  }

  /**
   * The arbitration debug line of the **reasoning** selection, when one happened.
   * The probe asks its shapes in order, so "the first selection line" is the
   * control shape's — a case about the echo has to say which one it means.
   */
  function reasoningSelectionLine(): string {
    return loggedLines().find((line) => line.includes('answer stream: using the reasoning candidate')) ?? '';
  }

  /**
   * The probe's own echo verdict, read out of the diagnostics dump: the verdict is
   * written to the file (and to the dump's `outcome:` line), not to the channel.
   */
  function echoBlock(dumpText: string): string {
    const label = aiPreReviewProbeShapes().find((shape) => shape.exactAnswer !== undefined)?.label;
    const start = dumpText.indexOf(`--- probe "${String(label)}" ---`);
    if (start < 0) {
      throw new Error('the diagnostics dump holds no echo block');
    }
    return dumpText.slice(start);
  }

  /** Runs the probe with a real log directory, as it requires, and returns the dump. */
  async function probeDump(): Promise<string> {
    state.settings.aiPreReview = true;
    state.settings.aiPreReviewModel = 'fake/normal';
    const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ai-pre-review-candidates-'));
    logDirs.push(directory);
    await probeAiPreReviewChatModels({ logUri: { fsPath: directory } as unknown as vscode.Uri });
    return await fs.promises.readFile(path.join(directory, AI_PRE_REVIEW_DIAGNOSTICS_FILE_NAME), 'utf8');
  }

  it('reads the answer out of the text parts and never touches `text`', async () => {
    state.settings.aiPreReview = true;
    debugging();
    const parts = [rpcText('{"comments"'), rpcText(':[]}')];
    setModel(createModel({ answer: 'ignored', parts, forbidTextProjection: true, singleReadStream: true }));

    await runAiPreReview(config, undefined, controller, params(), testHost());

    // The run got the contracted JSON out of the parts, and the projection that
    // used to be the only answer channel was never even read.
    expect(selectionLine()).toContain('answer stream: using the text candidate');
    expect(selectionLine()).toContain('the text candidate was preferred');
    expect(loggedLines()).not.toContain(expect.stringContaining('contract violation'));
  });

  it('uses the text parts on the measured fixture and gets the exact expected literal', async () => {
    debugging();
    // The real bytes: the parts are the RPC text flavour and the reasoning stream
    // is the mangled answer the maintainer saw. The probe's echo verdict is a
    // boolean, and it is `true` because the parts channel carried the literal.
    const parts = [rpcText('{"a":"b,c'), rpcText('\\"d\\\\e","f":[1,2]}'), rpcReasoning(MEASURED_REASONING_TEXT)];
    setModel(createModel({ answer: MEASURED_REASONING_TEXT, parts, forbidTextProjection: true, id: 'normal' }));

    const dump = await probeDump();
    const echo = echoBlock(dump);

    // The verdict and the raw answer beside it: the dump's own `answer chars` line
    // proves the probe judged the 27-character literal, not the reasoning stream.
    expect(echo).toContain('answered the echo exactly as asked: true');
    expect(echo).toContain('from the text candidate');
    expect(echo).toContain(`answer chars: ${MEASURED_TEXT_ANSWER.length}`);
    expect(echo).toContain(MEASURED_TEXT_ANSWER);
    expect(selectionLine()).toContain('the text candidate was preferred');
  });

  it('falls back to the reasoning candidate only when the text candidate fails, and says so at debug', async () => {
    state.settings.aiPreReview = true;
    state.settings.aiPreReviewModel = 'fake/normal';
    debugging();
    // `text` carries prose, the reasoning stream carries the answer: the contract
    // picks the second candidate and the log names it and the reason.
    const parts = [partOfText('Sure! Here is the JSON you asked for.'), rpcReasoning('{"comments":[]}')];
    setModel(createModel({ answer: 'ignored', parts, forbidTextProjection: true, id: 'normal' }));

    await runAiPreReview(config, undefined, controller, params(), testHost());

    expect(selectionLine()).toContain('answer stream: using the reasoning candidate');
    expect(selectionLine()).toContain('was used because the text candidate did not satisfy the contract');
    // And the answer really was the reasoning one: no contract failure was logged.
    expect(loggedLines().some((line) => line.includes('returned an answer that is not JSON'))).toBe(false);
  });

  it('uses the reasoning candidate for the probe verdict too, and says which stream it judged', async () => {
    debugging();
    // The echo shape's exact literal arrives on the reasoning channel while the
    // text channel carries something else: the probe's own contract — the shape's
    // exact answer — is what arbitrates, and the verdict names the stream.
    const parts = [partOfText('not the literal'), rpcReasoning(AI_PRE_REVIEW_PROBE_ECHO_ANSWER)];
    setModel(createModel({ answer: 'ignored', parts, forbidTextProjection: true, id: 'normal' }));

    const echo = echoBlock(await probeDump());

    expect(echo).toContain('answered the echo exactly as asked: true');
    expect(echo).toContain('from the reasoning candidate');
    expect(reasoningSelectionLine()).toContain('answer stream: using the reasoning candidate');
    expect(reasoningSelectionLine()).toContain('was used because the text candidate did not satisfy the contract');
  });

  it('fails exactly as before when neither candidate is the contracted JSON, and creates nothing', async () => {
    state.settings.aiPreReview = true;
    state.settings.aiPreReviewPromptScope = 'full-diff';
    debugging();
    // Both channels carry something, neither is JSON, and the `text` projection is
    // forbidden: the run must fail with the preferred candidate's excerpt rather
    // than concatenate the two, retry another model or guess.
    const prose = 'I reviewed the diff and it looks fine.';
    const parts = [partOfText(prose), rpcReasoning('still not json')];
    const model = createModel({ answer: 'ignored', parts, forbidTextProjection: true, id: 'normal' });
    setModel(model);

    await runAiPreReview(config, undefined, controller, params(), testHost());

    expect(selectionLine()).toContain('no candidate satisfied the contract');
    expect(selectionLine()).toContain('preferred the text candidate');
    const failure = loggedLines().find((line) => line.includes('returned an answer that is not JSON')) ?? '';
    // The bounded excerpt is the candidate that was examined, not a concatenation.
    expect(failure).toContain(`the answer is ${prose.length} character(s)`);
    expect(failure).toContain(JSON.stringify(prose.slice(0, AI_PRE_REVIEW_ANSWER_EXCERPT_LENGTH)));
    // The bounded retry, and only of that one model: two calls, nothing created.
    expect(model.sendRequest).toHaveBeenCalledTimes(2);
    expect(await postedBodies('/reviews')).toEqual([]);
  });

  it('falls back to the `text` projection when the response has no candidate parts at all', async () => {
    state.settings.aiPreReview = true;
    debugging();
    // `projectionOnly` gives the response no `stream` iterable at all, which is the
    // older editor shape and the only way no candidate stream can exist. The
    // projection is then the only channel left, and it is judged by the same
    // contract as any other candidate.
    setModel(createModel({ answer: '{"comments":[]}', projectionOnly: true }));

    await runAiPreReview(config, undefined, controller, params(), testHost());

    expect(selectionLine()).toContain('answer stream: using the `text` projection');
    expect(selectionLine()).toContain('the `text` projection was preferred');
  });

  it('keeps an unrecognised RPC `$mid` out of the answer and falls back to `text`', async () => {
    debugging();
    // The rule is not the number: an envelope this build does not know — here one
    // that looks like a result rather than a sample — stays a data part, the log
    // still names its number, and the answer degrades to the projection instead of
    // to a guess.
    const parts = [{ $mid: 7, value: '{"comments":[]}' }, rpcData('usage')];
    setModel(createModel({ answer: 'the projection', parts, id: 'normal' }));

    const dump = await probeDump();

    const unknownLine = loggedLines().find((line) => line.includes('kind=unknown ($mid=7')) ?? '';
    expect(unknownLine).toContain('inspection=');
    // The unknown flavour never became a candidate, so the echo verdict judged the
    // projection — and says which stream it came from.
    expect(echoBlock(dump)).toContain('from the `text` projection');
  });

  it('records both candidate streams, labelled, in the diagnostics dump', async () => {
    debugging();
    const parts = [partOfText('prose answer'), rpcReasoning(MEASURED_TEXT_ANSWER)];
    setModel(createModel({ answer: 'projection', parts, id: 'normal', name: 'Normal Model' }));

    const text = await probeDump();

    // Both channels are in the file with their own label, their own count and the
    // text between markers — which is the evidence the arbitration needs when the
    // two disagree.
    expect(text).toContain(`candidate 1 of 2 (text parts): ${'prose answer'.length} chars`);
    expect(text).toContain('--- candidate 1 text begin');
    expect(text).toContain('prose answer');
    expect(text).toContain(`candidate 2 of 2 (reasoning parts): ${MEASURED_TEXT_ANSWER.length} chars`);
    expect(text).toContain(MEASURED_TEXT_ANSWER);
    // The dump still holds the answer the probe actually judged, under the same
    // markers the rest of this suite reads.
    expect(text).toContain('outcome: answered the echo exactly as asked:');
  });

  it('labels the `text` projection as the fallback when that is the only channel', async () => {
    debugging();
    setModel(createModel({ answer: '{"comments":[]}', projectionOnly: true, id: 'normal', name: 'Normal Model' }));

    const text = await probeDump();

    expect(text).toContain('candidate 1 of 1 (the `text` projection (fallback)):');
    expect(text).toContain('{"comments":[]}');
  });

  it('logs no part, fragment, candidate or selection line at all while debug is off', async () => {
    // The suite's `beforeEach` leaves debug off; this is the default path. The
    // response carries a text part, a reasoning part and a data part precisely so
    // a stray line would be loud.
    state.settings.aiPreReview = true;
    const parts = [rpcText('{"comments":[]}'), rpcReasoning('thinking'), rpcData('usage')];
    setModel(createModel({ answer: 'ignored', parts, id: 'normal' }));

    await runAiPreReview(config, undefined, controller, params(), testHost());

    const lines = loggedLines();
    expect(lines.filter((line) => line.includes('in the stream: kind='))).toEqual([]);
    expect(lines.filter((line) => line.includes('part stream summary'))).toEqual([]);
    expect(lines.filter((line) => line.includes('answer fragment '))).toEqual([]);
    expect(lines.filter((line) => line.includes('answer stream summary'))).toEqual([]);
    expect(lines.filter((line) => line.includes('answer stream: '))).toEqual([]);
    // And no user-visible surface mentions them either.
    for (const surface of [
      ...vi.mocked(vscode.window.showInformationMessage).mock.calls,
      ...vi.mocked(vscode.window.showWarningMessage).mock.calls,
      ...vi.mocked(vscode.window.showErrorMessage).mock.calls,
    ]) {
      expect(String(surface[0])).not.toContain('candidate');
      expect(String(surface[0])).not.toContain('answer stream');
    }
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

  /**
   * A model that answers `{}` to every shape that asks for it and `answer` to
   * the punctuation-sensitive echo, which is the last shape. Derived from the
   * module's own shape list so adding a shape cannot silently shift which answer
   * the echo gets. With `fragments` the stream itself is what the case is about,
   * so that text is streamed for every shape instead.
   */
  function echoingModel(answer: string, id: string, fragments?: readonly string[]): ReturnType<typeof createModel> {
    return createModel({
      ...(fragments === undefined
        ? {
            answers: [
              ...aiPreReviewProbeShapes()
                .slice(0, -1)
                .map(() => '{}'),
              answer,
            ],
          }
        : { fragments }),
      id,
    });
  }

  /** The dump from the echo shape's block header onwards, so verdicts are read in place. */
  function echoBlock(text: string): string {
    const label = aiPreReviewProbeShapes().find((shape) => shape.exactAnswer !== undefined)?.label;
    // Pinned: this string is how the maintainer finds the block in the file.
    expect(label).toBe('echo: one user message, punctuation-sensitive');
    const start = text.indexOf(`--- probe "${label}" ---`);
    if (start < 0) {
      throw new Error('the diagnostics dump holds no echo block');
    }
    return text.slice(start);
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

  it('asks the chosen model with every shape and writes the question and the answers', async () => {
    state.settings.aiPreReview = true;
    // The probe is about the model the user chose, so the setting names it —
    // exactly what the picker writes.
    state.settings.aiPreReviewModel = 'fake/normal';
    debugging();
    // Answers differ per model so the dump can be read as a comparison.
    const normal = createModel({ answer: '{}', id: 'normal', name: 'Normal Model' });
    const notChosen = createModel({ answer: 'comments[]', id: 'not-chosen', name: 'Not Chosen Model' });
    setModels(normal, notChosen);
    const { logUri, directory } = await logDirectory();

    await probeAiPreReviewChatModels({ logUri });

    const shapes = aiPreReviewProbeShapes();
    expect(normal.sendRequest).toHaveBeenCalledTimes(shapes.length);
    // The survey of every provider is gone: the one model the user did not
    // choose is never called, however many are offered.
    expect(notChosen.sendRequest).not.toHaveBeenCalled();
    // The trivial question is the whole request: no repository, no pull request.
    for (const [messages] of (normal.sendRequest as unknown as SendRequestMock).mock.calls) {
      expect(messages.length).toBeGreaterThan(0);
      expect(messages.every((message) => message.role === 'user')).toBe(true);
    }
    const text = await fs.promises.readFile(path.join(directory, AI_PRE_REVIEW_DIAGNOSTICS_FILE_NAME), 'utf8');
    expect(text).toContain('[probe] started=');
    // The header names the model that was asked and why, so the dump is
    // self-describing rather than leaving the selection rule to be inferred.
    expect(text).toContain('models asked by this probe: Normal Model (vendor=fake, family=fake, id=normal)');
    expect(text).toContain('why these models: the chosen model');
    expect(text).toContain('shapes asked of each model named above: 4');
    expect(text).toContain(`question: ${JSON.stringify(AI_PRE_REVIEW_PROBE_PROMPT)}`);
    expect(text).toContain(`echo question: ${JSON.stringify(AI_PRE_REVIEW_PROBE_ECHO_PROMPT)}`);
    expect(text).toContain('control: one user message, no instructions');
    expect(text).toContain('two user messages: instructions, then the request');
    expect(text).toContain('one user message: instructions then the request');
    expect(text).toContain('echo: one user message, punctuation-sensitive');
    expect(text).toContain(`a faithful answer is exactly ${AI_PRE_REVIEW_PROBE_ECHO_ANSWER}`);
    expect(text).toContain('id=normal');
    // The verdict the maintainer reads first: the chosen model answered.
    expect(text).toContain('answered exactly "{}" as asked');
    // Neither of these two answered the echo, and `{}` is not accepted as one:
    // the echo verdict is a boolean of its own.
    expect(text).toContain('answered the echo exactly as asked: false');
    expect(vi.mocked(vscode.window.showInformationMessage)).toHaveBeenCalledWith(
      expect.stringContaining('made 4 model call(s)'),
    );
  });

  it('sends nothing and lists the offered models while no model is chosen', async () => {
    // The setting is empty, which means "ask me" for the run — not a licence to
    // survey every provider the editor offers. The probe refuses and says how to
    // make the choice, instead of picking a model for the user.
    state.settings.aiPreReview = true;
    debugging();
    const normal = createModel({ answer: '{}', id: 'normal' });
    const other = createModel({ answer: '{}', id: 'other' });
    setModels(normal, other);
    const { logUri, directory } = await logDirectory();

    await probeAiPreReviewChatModels({ logUri });

    expect(normal.sendRequest).not.toHaveBeenCalled();
    expect(other.sendRequest).not.toHaveBeenCalled();
    const warning = vi
      .mocked(vscode.window.showWarningMessage)
      .mock.calls.map((call) => String(call[0]))
      .join('\n');
    expect(warning).toContain('the setting "forgejoToolkit.aiPreReviewModel" is empty');
    // The offered list travels with the refusal, so the value can be set.
    expect(warning).toContain('id=normal');
    expect(warning).toContain('id=other');
    // Nothing was written: a refused probe has no evidence to report.
    await expect(
      fs.promises.readFile(path.join(directory, AI_PRE_REVIEW_DIAGNOSTICS_FILE_NAME), 'utf8'),
    ).rejects.toThrow();
    expect(vi.mocked(vscode.window.showInformationMessage)).not.toHaveBeenCalled();
  });

  it('sends nothing when the configured value names no offered model', async () => {
    // An explicit value that matches nothing is a typo to report — the same
    // refusal the run makes — never a reason to spend calls on other models.
    state.settings.aiPreReview = true;
    state.settings.aiPreReviewModel = 'fake/typo';
    debugging();
    const normal = createModel({ answer: '{}', id: 'normal' });
    setModels(normal);
    const { logUri, directory } = await logDirectory();

    await probeAiPreReviewChatModels({ logUri });

    expect(normal.sendRequest).not.toHaveBeenCalled();
    const warning = vi
      .mocked(vscode.window.showWarningMessage)
      .mock.calls.map((call) => String(call[0]))
      .join('\n');
    expect(warning).toContain('"fake/typo"');
    expect(warning).toContain('names no offered chat model');
    expect(warning).toContain('id=normal');
    await expect(
      fs.promises.readFile(path.join(directory, AI_PRE_REVIEW_DIAGNOSTICS_FILE_NAME), 'utf8'),
    ).rejects.toThrow();
  });

  it('records "answered the echo exactly as asked: true" when the punctuation comes back unchanged', async () => {
    state.settings.aiPreReview = true;
    state.settings.aiPreReviewModel = 'fake/faithful';
    debugging();
    // Streamed in fragments whose boundaries fall inside the JSON string, around
    // the escaped quote and around the escaped backslash: `true` here therefore
    // also says the probe's own accumulation kept every one of them.
    const fragments = ['{"a":"b', ',c\\"d', '\\\\e","f":[1,', '2]}'];
    expect(fragments.join('')).toBe(AI_PRE_REVIEW_PROBE_ECHO_ANSWER);
    setModel(echoingModel(AI_PRE_REVIEW_PROBE_ECHO_ANSWER, 'faithful', fragments));
    const { logUri, directory } = await logDirectory();

    await probeAiPreReviewChatModels({ logUri });

    const text = await fs.promises.readFile(path.join(directory, AI_PRE_REVIEW_DIAGNOSTICS_FILE_NAME), 'utf8');
    // The prompt and the expected answer travel in the file with the block, so
    // it is self-describing: a reader compares the raw answer to this line.
    expect(text).toContain(`echo question: ${JSON.stringify(AI_PRE_REVIEW_PROBE_ECHO_PROMPT)}`);
    expect(text).toContain(`a faithful answer is exactly ${AI_PRE_REVIEW_PROBE_ECHO_ANSWER}`);
    expect(text).toContain('answered the echo exactly as asked: true');
    const block = echoBlock(text);
    // The request really is the punctuation-sensitive sentence, and the raw
    // answer beside the verdict is the expected literal, verbatim.
    expect(block).toContain(AI_PRE_REVIEW_PROBE_ECHO_PROMPT);
    expect(recordedAnswer(block)).toBe(AI_PRE_REVIEW_PROBE_ECHO_ANSWER);
  });

  it('records "answered the echo exactly as asked: false" and keeps the mangled answer', async () => {
    state.settings.aiPreReview = true;
    state.settings.aiPreReviewModel = 'fake/mangling';
    debugging();
    // The failure the shape exists for: the literal comes back with its quotes
    // and commas eaten. That is not the same outcome as a model that answered
    // something else, and the raw answer beside the verdict says which it was.
    const mangled = AI_PRE_REVIEW_PROBE_ECHO_ANSWER.replace(/["]/g, '').replace(/,/g, '');
    expect(mangled).not.toBe(AI_PRE_REVIEW_PROBE_ECHO_ANSWER);
    setModel(echoingModel(mangled, 'mangling'));
    const { logUri, directory } = await logDirectory();

    await probeAiPreReviewChatModels({ logUri });

    const text = await fs.promises.readFile(path.join(directory, AI_PRE_REVIEW_DIAGNOSTICS_FILE_NAME), 'utf8');
    const block = echoBlock(text);
    expect(block).toContain('answered the echo exactly as asked: false');
    expect(recordedAnswer(block)).toBe(mangled);
    expect(text).not.toContain('answered the echo exactly as asked: true');
  });

  it('stops asking when consent is declined instead of re-asking every model', async () => {
    state.settings.aiPreReview = true;
    state.settings.aiPreReviewModel = 'fake/declined';
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
    // The setting follows the failing model, so the failing call is what the
    // probe is measuring rather than something it skipped.
    state.settings.aiPreReviewModel = 'fake/broken';
    debugging();
    const failing = createModel({ failWith: new Error('provider said no'), id: 'broken' });
    const working = createModel({ answer: '{}', id: 'working' });
    setModels(failing, working);
    const { logUri, directory } = await logDirectory();

    await probeAiPreReviewChatModels({ logUri });

    // Every shape was still asked of the model it did ask.
    expect(failing.sendRequest).toHaveBeenCalledTimes(aiPreReviewProbeShapes().length);
    expect(working.sendRequest).not.toHaveBeenCalled();
    const text = await fs.promises.readFile(path.join(directory, AI_PRE_REVIEW_DIAGNOSTICS_FILE_NAME), 'utf8');
    expect(text).toContain('outcome: model call failed: provider said no');
    expect(text).toContain('answer chars: 0');
    expect(vi.mocked(vscode.window.showInformationMessage)).toHaveBeenCalled();
  });

  it('reports "no chat model is available" without opening a dump when the editor offers none', async () => {
    state.settings.aiPreReview = true;
    debugging();
    setModels();
    const { logUri, directory } = await logDirectory();

    await probeAiPreReviewChatModels({ logUri });

    expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(expect.stringContaining('No chat model is available'));
    await expect(
      fs.promises.readFile(path.join(directory, AI_PRE_REVIEW_DIAGNOSTICS_FILE_NAME), 'utf8'),
    ).rejects.toThrow();
    expect(vi.mocked(vscode.window.showInformationMessage)).not.toHaveBeenCalled();
  });

  it('is registered as a command, and contributed behind the debug setting', () => {
    const context = { subscriptions: [] as { dispose: () => void }[] } as unknown as vscode.ExtensionContext;
    // A view provider is required: registering the commands is also what hands
    // the provider the run the pull request detail page's button reaches
    // (`setAiPreReviewRunner`). This case is about the contributions, so the
    // provider is the smallest thing that accepts the handover.
    const { provider, registeredRunner } = viewProviderWithRunner();
    registerAiPreReviewCommand(context, config, provider, controller);
    // One implementation, two entries: the pull request detail page's button and
    // the editor title button reach the same function.
    expect(registeredRunner()).toBeTypeOf('function');

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
    // Both conditions the handler enforces, spelled out so a future edit cannot
    // quietly drop one: `probeAiPreReviewChatModels` sends nothing while either
    // setting is off ("sends nothing while the feature switch is off, whatever
    // debug says" and "sends nothing while forgejoToolkit.debug is off" above),
    // so an affordance gated on debug alone was offered only to be refused.
    expect(palette?.when).toBe('config.forgejoToolkit.debug && config.forgejoToolkit.aiPreReview');
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

  it('offers the run action only while the feature switch is on, and leaves the chooser ungated', () => {
    // The switch promises that with it off nothing is sent and nothing is
    // created. The editor title entry was contributed on the diff context key
    // alone, so the button appeared and only refused once clicked — the
    // maintainer saw exactly that. A context key is an affordance, not the gate:
    // the refusal in `runAiPreReview` stays, and it is asserted by "refuses,
    // sends nothing and never touches the model when it is off" above.
    const packageJson = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'package.json'), 'utf8')) as {
      contributes: {
        menus: Record<string, { command: string; when?: string }[]>;
      };
    };
    const title = packageJson.contributes.menus['editor/title'].find((item) => item.command === COMMAND_AI_PRE_REVIEW);
    expect(title?.when).toBe('forgejoToolkit.inPullRequestDiff && config.forgejoToolkit.aiPreReview');
    // The palette contribution is unchanged: the command is still hidden there.
    const palette = packageJson.contributes.menus.commandPalette.find((item) => item.command === COMMAND_AI_PRE_REVIEW);
    expect(palette?.when).toBe('false');
    // Choosing a model is configuration and sends nothing, so no menu may gate it
    // on the switch: the run's refusal messages point at it as the way out.
    const gatingTheChooser = Object.entries(packageJson.contributes.menus)
      .flatMap(([menu, entries]) => entries.map((entry) => ({ menu, ...entry })))
      .filter((entry) => entry.command === COMMAND_AI_PRE_REVIEW_CHOOSE_MODEL && entry.when !== undefined);
    expect(gatingTheChooser).toEqual([]);
  });

  it('no longer offers the run from a file’s context menu, because a run covers the whole pull request', () => {
    // The maintainer's finding: the entry lived in a **file's** context menu while
    // the run fetches every changed file and the whole diff, so the offer and the
    // scope did not match. The decision was to move the entry to the pull request
    // detail page and drop this contribution, and to keep the `editor/title`
    // button, which is the fast path out of an open diff.
    //
    // Asserted in both directions on purpose: an entry that comes back would be a
    // silent drift, and it would be the very mismatch this change removed.
    const packageJson = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'package.json'), 'utf8')) as {
      contributes: {
        menus: Record<string, { command: string; when?: string; group?: string }[]>;
      };
    };
    const contextEntries = packageJson.contributes.menus['editor/context'].filter(
      (item) => item.command === COMMAND_AI_PRE_REVIEW,
    );
    expect(contextEntries).toEqual([]);
    // The neighbouring per-file action is untouched: adding a review comment to
    // one line of one file is exactly a file-scoped action.
    const addComment = packageJson.contributes.menus['editor/context'].find(
      (item) => item.command === 'forgejoToolkit.addPullReviewComment',
    );
    expect(addComment?.when).toBe('forgejoToolkit.inPullRequestDiff');
    // The title button stays, and stays gated on the feature switch.
    const titleEntries = packageJson.contributes.menus['editor/title'].filter(
      (item) => item.command === COMMAND_AI_PRE_REVIEW,
    );
    expect(titleEntries).toHaveLength(1);
    expect(titleEntries[0]?.when).toBe('forgejoToolkit.inPullRequestDiff && config.forgejoToolkit.aiPreReview');
  });
});

/**
 * The command that opens the diagnostics dump. The failure message points at the
 * channel for the bounded excerpt and at this command for the full prompt and
 * answer, so the command has to work in both states a user can be in: a dump that
 * exists (debug was on for a run) and a machine where the file was never written
 * (debug was never on) — where it must name the setting that creates one rather
 * than fail or open nothing.
 *
 * It is deliberately not gated on the feature switch: reading a local diagnostic
 * file sends nothing, which is the same reason the model chooser is ungated.
 */
describe('the diagnostics-file command', () => {
  /** A real log directory, cleaned up by the suite's `afterEach`. */
  async function logDirectory(): Promise<{ logUri: vscode.Uri; directory: string }> {
    const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ai-pre-review-open-'));
    logDirs.push(directory);
    return { logUri: { fsPath: directory } as unknown as vscode.Uri, directory };
  }

  it('opens the dump in the editor when it exists', async () => {
    // The feature switch is off on purpose: opening a file is not "using" the
    // feature, and the command may not be gated on that switch.
    const { logUri, directory } = await logDirectory();
    const file = path.join(directory, AI_PRE_REVIEW_DIAGNOSTICS_FILE_NAME);
    await fs.promises.writeFile(file, 'a recorded run', 'utf8');

    await openAiPreReviewDiagnostics({ logUri });

    expect(vscode.workspace.openTextDocument).toHaveBeenCalledTimes(1);
    const opened = vi.mocked(vscode.workspace.openTextDocument).mock.calls[0]?.[0] as { fsPath?: string } | undefined;
    expect(opened?.fsPath).toBe(file);
    expect(vscode.window.showTextDocument).toHaveBeenCalledTimes(1);
    expect(vscode.window.showWarningMessage).not.toHaveBeenCalled();
  });

  it('says the file is not there yet and names the setting that creates one', async () => {
    const { logUri, directory } = await logDirectory();

    await openAiPreReviewDiagnostics({ logUri });

    expect(vscode.workspace.openTextDocument).not.toHaveBeenCalled();
    expect(vscode.window.showTextDocument).not.toHaveBeenCalled();
    const message = String(vi.mocked(vscode.window.showWarningMessage).mock.calls[0]?.[0]);
    // It says where the missing file would be and which setting makes it appear.
    expect(message).toContain(path.join(directory, AI_PRE_REVIEW_DIAGNOSTICS_FILE_NAME));
    expect(message).toContain('forgejoToolkit.debug');
  });

  it('says so on a host with no log directory instead of throwing', async () => {
    await expect(openAiPreReviewDiagnostics({})).resolves.toBeUndefined();

    expect(vscode.workspace.openTextDocument).not.toHaveBeenCalled();
    expect(vscode.window.showWarningMessage).toHaveBeenCalledWith(
      expect.stringContaining('no extension log directory'),
    );
  });

  it('is registered, contributed with a bilingual title, and gated on nothing', () => {
    const context = {
      subscriptions: [] as { dispose: () => void }[],
      logUri: { fsPath: 'ignored' } as unknown as vscode.Uri,
    } as unknown as vscode.ExtensionContext;
    const { provider, registeredRunner } = viewProviderWithRunner();
    registerAiPreReviewCommand(context, config, provider, controller);
    expect(registeredRunner()).toBeTypeOf('function');

    expect(state.registeredCommands.has(COMMAND_AI_PRE_REVIEW_OPEN_DIAGNOSTICS)).toBe(true);
    expect(COMMAND_AI_PRE_REVIEW_OPEN_DIAGNOSTICS).toBe('forgejoToolkit.aiPreReviewOpenDiagnostics');

    const packageJson = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'package.json'), 'utf8')) as {
      contributes: {
        commands: { command: string; title: string }[];
        menus: Record<string, { command: string; when?: string }[]>;
      };
    };
    const command = packageJson.contributes.commands.find(
      (entry) => entry.command === COMMAND_AI_PRE_REVIEW_OPEN_DIAGNOSTICS,
    );
    expect(command?.title).toBe('%command.aiPreReviewOpenDiagnostics.title%');
    // Contributing the command without a `commandPalette` entry means the palette
    // offers it by default; no menu may name it with a `when`, because a gate
    // would be exactly the "only offered to be refused" shape this change is not
    // allowed to introduce (the switch may be off while the dump exists).
    const gated = Object.entries(packageJson.contributes.menus)
      .flatMap(([menu, entries]) => entries.map((entry) => ({ menu, ...entry })))
      .filter((entry) => entry.command === COMMAND_AI_PRE_REVIEW_OPEN_DIAGNOSTICS && entry.when !== undefined);
    expect(gated).toEqual([]);
    for (const file of ['package.nls.json', 'package.nls.zh-cn.json']) {
      const bundle = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', file), 'utf8')) as Record<
        string,
        string
      >;
      expect((bundle['command.aiPreReviewOpenDiagnostics.title'] ?? '').trim()).not.toBe('');
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

    await runAiPreReview(config, undefined, controller, params(), testHost());

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

    await runAiPreReview(config, undefined, controller, params(), testHost());

    const options = (model.sendRequest as unknown as { mock: { calls: Array<[unknown, { justification?: string }]> } })
      .mock.calls[0]?.[1];
    expect(options?.justification).toContain('AI pre-review');
  });
});
