import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * The AI model transport seam's `vscode.lm` implementation
 * (`docs/design/ai-model-transport.md` §5) and the two things stage 1 has to
 * prove about it:
 *
 * 1. **It ignores the provider settings entirely** (§5.5, §11.1 item 4). The
 *    "no fallback between transports" rule is half a mechanism and half an
 *    implementation detail, and this is the mechanism half: a full provider
 *    configuration is seeded into the mock settings — providers, the egress
 *    switch, the transport choice, a binding for this feature, the local-only
 *    policy and the timeout — and the same calls are run with and without it. The
 *    observations have to come out identical, and the test asserts the mock
 *    really was handing those values over, so it cannot pass vacuously.
 * 2. **The seam's own contract**, as §5 implies it: what `availability()`,
 *    `listModels()` and `countTokens()` do without sending anything, how one
 *    request is shaped (one `User` message, no `modelOptions`, `purpose` as the
 *    consent dialog's `justification`), how the response's candidate streams map
 *    onto `parts`, and how cancellation and a broken stream surface. The run's two
 *    "no number from the token counter" arms — `undefined` versus a throw — are
 *    driven end to end, because that difference is a behaviour of the moved code.
 *
 * The `vscode` mock is hand-written for the reason `aiPreReview.test.ts` gives:
 * the shared setup file has no `lm` field, so "the editor has no language model
 * API" is the default environment and a case has to install what it needs.
 */

const state = vi.hoisted(() => ({
  /** Configuration values, keyed by the setting name without its section. */
  settings: {} as Record<string, unknown>,
  /** Every configuration write the code under test made. */
  settingUpdates: [] as Array<{ key: string; value: unknown; target?: unknown }>,
  /** What `lm.selectChatModels()` answers next. */
  offered: [] as unknown[],
  /** When set, `lm.selectChatModels()` rejects with this. */
  listFails: undefined as unknown,
}));

vi.mock('../aiPreReviewPanel', () => ({
  AiPreReviewPanel: { createOrShow: vi.fn() },
}));

vi.mock('vscode', () => {
  const makeUri = (scheme: string, path: string) => ({
    scheme,
    path,
    fsPath: path,
    toString: () => `${scheme}:${path}`,
  });
  return {
    lm: {
      selectChatModels: vi.fn(async () => {
        if (state.listFails) {
          throw state.listFails;
        }
        return state.offered;
      }),
    },
    LanguageModelChatMessage: {
      User: vi.fn((content: string) => ({ role: 'user', content })),
    },
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
      // The run wraps its model call in one cancellable notification.
      withProgress: vi.fn(async (_options: unknown, task: (progress: unknown, token: unknown) => unknown) =>
        task(
          { report: vi.fn() },
          {
            isCancellationRequested: false,
            onCancellationRequested: vi.fn(() => ({ dispose: vi.fn() })),
          },
        ),
      ),
      activeTextEditor: undefined,
      visibleTextEditors: [],
      showTextDocument: vi.fn(async () => ({})),
      createOutputChannel: vi.fn(() => ({ appendLine: vi.fn(), show: vi.fn(), dispose: vi.fn() })),
      onDidChangeActiveTextEditor: vi.fn(() => ({ dispose: vi.fn() })),
      onDidChangeWindowState: vi.fn(() => ({ dispose: vi.fn() })),
      state: { focused: true },
    },
    workspace: {
      getConfiguration: vi.fn(() => ({
        get: vi.fn((key: string, fallback?: unknown) => (key in state.settings ? state.settings[key] : fallback)),
        update: vi.fn(async (key: string, value: unknown, target?: unknown) => {
          state.settingUpdates.push({ key, value, target });
          state.settings[key] = value;
        }),
      })),
      openTextDocument: vi.fn(async (uri: unknown) => ({ uri })),
      onDidChangeConfiguration: vi.fn(() => ({ dispose: vi.fn() })),
      onDidChangeWorkspaceFolders: vi.fn(() => ({ dispose: vi.fn() })),
      textDocuments: [],
      workspaceFolders: [],
    },
    ConfigurationTarget: { Global: 1, Workspace: 2, WorkspaceFolder: 3 },
    commands: {
      executeCommand: vi.fn(),
      registerCommand: vi.fn(() => ({ dispose: vi.fn() })),
    },
    Uri: {
      file: vi.fn((path: string) => makeUri('file', path)),
      parse: vi.fn((url: string) => makeUri(url.split(':')[0] ?? '', url)),
      from: vi.fn((components: { scheme: string; path: string }) => makeUri(components.scheme, components.path)),
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
  };
});

import * as vscode from 'vscode';
import { mockServer, startMockServer, stopMockServer } from '../test/mocks/server';
import { resetMockState } from '../test/mocks/handlers';
import { mockInstance } from '../test/mocks/data/instances';
import { runAiPreReview } from '../aiPreReview';
import { VscodeLmTransport, vscodeLmChatModelOf, vscodeLmTransport } from '../ai/vscodeLmTransport';
import type { AiCompletionRequest, AiModelInfo } from '../ai/transport';
import type { ConfigManager } from '../config';
import type { PullReviewCommentController } from '../comments/pullReviewCommentController';
import type { ForgejoPrUriParams } from '../prFileSystemProvider';

const DEFAULT_ANSWER = '{"comments":[]}';

/** The listing that failed, as the editor hands the failure over. */
const LISTING_FAILURE = new Error('model listing failed');

/**
 * A provider configuration in the shape the record's §8.1 describes, seeded into
 * the mock settings as the **unprefixed** keys `getConfiguration('forgejoToolkit')`
 * reads. None of these settings exists in `package.json` yet (that is stage 2);
 * what this file proves is that the `vscode.lm` transport behaves the same
 * whether or not they are there.
 */
const PROVIDER_SETTINGS: Record<string, unknown> = {
  aiProviders: [
    {
      id: 'ollama-local',
      name: 'Ollama (this machine)',
      baseUrl: 'http://127.0.0.1:11434/v1',
      models: [{ id: 'qwen3:8b', name: 'Qwen3 8B' }],
      auth: 'bearer',
      headers: [{ name: 'api-version', valueSecret: true }],
      localOnly: false,
    },
  ],
  aiProvidersEnabled: true,
  aiTransport: 'openai-compatible',
  aiModelBindings: [{ feature: 'aiPreReview', providerId: 'ollama-local', modelId: 'qwen3:8b' }],
  aiLocalOnly: false,
  aiModelRequestTimeoutMs: 30_000,
};

/** One response stream from a fixed list, optionally acting before the first part. */
function asyncIterableOf<T>(items: readonly T[], beforeFirst?: () => void): AsyncIterable<T> {
  return {
    [Symbol.asyncIterator]() {
      let index = 0;
      return {
        next: async (): Promise<IteratorResult<T>> => {
          if (index === 0) {
            beforeFirst?.();
          }
          if (index >= items.length) {
            return { done: true, value: undefined as never };
          }
          const value = items[index] as T;
          index += 1;
          return { done: false, value };
        },
      };
    },
  };
}

/** One `LanguageModelTextPart`, built from the mocked class a provider would instantiate. */
function textPart(value: string): unknown {
  return new (vscode as unknown as { LanguageModelTextPart: new (value: string) => unknown }).LanguageModelTextPart(
    value,
  );
}

/** One RPC-serialised reasoning part, the measured `$mid=22` flavour. */
function reasoningPart(value: string): unknown {
  return { $mid: 22, value };
}

function isTextPart(value: unknown): value is { value: string } {
  const ctor = (vscode as unknown as { LanguageModelTextPart?: new (...args: never[]) => unknown })
    .LanguageModelTextPart;
  return typeof ctor === 'function' && value instanceof ctor;
}

interface ModelOptions {
  answer?: string;
  /** One response part per entry; a response with none carries a single text part of `answer`. */
  parts?: readonly unknown[];
  /** The chunks the `text` projection yields. */
  textChunks?: readonly string[];
  /** The response carries no `stream` at all: the older editor shape and the pure `text` fallback. */
  projectionOnly?: boolean;
  /** Reading the `text` property throws, so a parts answer can prove it never touched it. */
  forbidTextProjection?: boolean;
  /** Runs before the first `stream` part, which is how a mid-stream cancellation is produced. */
  beforeFirstPart?: () => void;
  /** The model's own token counter; absent, it answers `tokens` (10 by default). */
  tokenizer?: () => Promise<number | undefined>;
  tokens?: number | undefined;
  name?: string;
  id?: string;
  vendor?: string;
  family?: string;
  maxInputTokens?: number;
}

/**
 * A fake `LanguageModelChat`: the identity fields, a tokenizer and `sendRequest`,
 * which answers a response built from the options above.
 */
function createModel(options: ModelOptions = {}) {
  const answer = options.answer ?? DEFAULT_ANSWER;
  const parts = options.parts ?? [textPart(answer)];
  const textParts = parts.filter(isTextPart).map((part) => part.value);
  const response: Record<string, unknown> = {};
  if (!options.projectionOnly) {
    response.stream = asyncIterableOf(parts, options.beforeFirstPart);
  }
  if (options.forbidTextProjection) {
    Object.defineProperty(response, 'text', {
      get() {
        throw new Error('the `text` projection was read although a candidate stream carried the answer');
      },
    });
  } else {
    response.text = asyncIterableOf(options.textChunks ?? (textParts.length > 0 ? textParts : [answer]));
  }
  return {
    name: options.name ?? 'Fake Model',
    id: options.id ?? 'fake-model',
    vendor: options.vendor ?? 'fake',
    family: options.family ?? 'fake',
    version: '1',
    maxInputTokens: options.maxInputTokens ?? 128_000,
    countTokens: vi.fn(options.tokenizer ?? (async () => options.tokens ?? 10)),
    sendRequest: vi.fn(async () => response),
  };
}

/** The models `lm.selectChatModels()` answers with, in the editor's order. */
function offer(...models: ReturnType<typeof createModel>[]): void {
  state.offered = models;
}

/** The transport under test, freshly built so no case can inherit state. */
function transport(): VscodeLmTransport {
  return new VscodeLmTransport();
}

/**
 * The mock's argument list. The fake's own signature takes nothing, so the calls
 * are read through this narrower shape — the same trick `aiPreReview.test.ts`
 * uses for the same reason.
 */
type SendRequestMock = {
  mock: { calls: Array<[Array<{ role: string; content: string }>, Record<string, unknown>]> };
};

/** The messages of the first `sendRequest`, as the transport handed them over. */
function sentMessages(model: ReturnType<typeof createModel>): Array<{ role: string; content: string }> {
  return (model.sendRequest as unknown as SendRequestMock).mock.calls[0]?.[0] ?? [];
}

/** The options of the first `sendRequest`. */
function sentOptions(model: ReturnType<typeof createModel>): Record<string, unknown> {
  return (model.sendRequest as unknown as SendRequestMock).mock.calls[0]?.[1] ?? {};
}

function request(overrides: Partial<AiCompletionRequest> = {}): AiCompletionRequest {
  return {
    system: 'the instructions',
    messages: [{ role: 'user', text: 'the request' }],
    purpose: 'why this request is being made',
    ...overrides,
  };
}

beforeEach(() => {
  state.settings = {};
  state.settingUpdates = [];
  state.offered = [];
  state.listFails = undefined;
  vi.clearAllMocks();
  resetMockState();
});

afterEach(() => {
  mockServer.resetHandlers();
  mockServer.events.removeAllListeners();
  vi.clearAllMocks();
});

describe('the vscode.lm transport: availability and listing', () => {
  it('reports an editor with no language model API as unusable, with the sentence to show', async () => {
    const original = vscode.lm;
    (vscode as { lm?: unknown }).lm = undefined;
    try {
      const availability = await transport().availability();

      expect(availability).toEqual({
        usable: false,
        reason: expect.stringContaining('no language model API'),
      });
    } finally {
      (vscode as { lm?: unknown }).lm = original;
    }
  });

  it('reports a listing that threw as unusable, distinctly from an empty list', async () => {
    state.listFails = LISTING_FAILURE;
    const failed = await transport().availability();

    state.listFails = undefined;
    offer();
    const empty = await transport().availability();

    expect(failed.usable).toBe(false);
    expect(failed).toMatchObject({ reason: expect.stringContaining('The AI pre-review was not started') });
    // "The editor offers nothing" is the list's own answer, not the API's: the
    // transport still calls itself usable, and the feature reports the empty list.
    expect(empty).toEqual({ usable: true });
  });

  it('shows no message of its own while it lists', async () => {
    const model = createModel();
    offer(model, createModel({ id: 'second', name: 'Second' }));

    const availability = await transport().availability();
    const listed = await transport().listModels();

    expect(availability).toEqual({ usable: true });
    expect(listed).toHaveLength(2);
    expect(vscode.window.showErrorMessage).not.toHaveBeenCalled();
    expect(vscode.window.showWarningMessage).not.toHaveBeenCalled();
    expect(model.sendRequest).not.toHaveBeenCalled();
  });

  it('lists the editor models in the editor order, with duplicates collapsed', async () => {
    const first = createModel({ id: 'first', name: 'First' });
    const second = createModel({ id: 'second', name: 'Second' });
    offer(second, first, second);

    const listed = await transport().listModels();

    expect(listed.map((model) => model.id)).toEqual(['second', 'first']);
  });

  it('lists nothing when the listing threw, rather than throwing itself', async () => {
    state.listFails = LISTING_FAILURE;

    await expect(transport().listModels()).resolves.toEqual([]);
  });

  it('lists the editor’s own model objects, so a listed model is the model a request can use', async () => {
    const model = createModel();
    offer(model);

    const listed = await transport().listModels();

    expect(vscodeLmChatModelOf(listed[0] as AiModelInfo)).toBe(model);
    expect(vscodeLmTransport.id).toBe('vscode.lm');
  });
});

describe('the vscode.lm transport: measuring', () => {
  it('measures with the model’s own tokenizer, and passes an absent measurement through as undefined', async () => {
    const counting = createModel({ tokens: 42 });
    const silent = createModel({ id: 'silent', tokenizer: async () => undefined });
    offer(counting, silent);
    const listed = await transport().listModels();

    const transportUnderTest = transport();
    await expect(transportUnderTest.countTokens(listed[0] as AiModelInfo, 'text')).resolves.toBe(42);
    await expect(transportUnderTest.countTokens(listed[1] as AiModelInfo, 'text')).resolves.toBeUndefined();
  });

  it('lets a failing tokenizer throw, so "no tokenizer" and "the measurement broke" stay distinct', async () => {
    const broken = createModel({
      tokenizer: async () => {
        throw new Error('no tokenizer here');
      },
    });
    offer(broken);
    const listed = await transport().listModels();

    await expect(transport().countTokens(listed[0] as AiModelInfo, 'text')).rejects.toThrow('no tokenizer here');
  });

  it('refuses a model it did not list instead of failing later with an undefined', async () => {
    const foreign: AiModelInfo = { vendor: 'elsewhere', id: 'some-model', name: 'Some Model' };

    await expect(transport().countTokens(foreign, 'text')).rejects.toThrow('which it did not list');
  });
});

describe('the vscode.lm transport: one request', () => {
  it('sends one User message carrying the instructions and then the request, and no modelOptions', async () => {
    const model = createModel();
    offer(model);
    const listed = await transport().listModels();

    await transport().complete(listed[0] as AiModelInfo, request());

    const messages = sentMessages(model);
    expect(messages).toHaveLength(1);
    expect(messages[0]?.role).toBe('user');
    expect(messages[0]?.content).toBe('the instructions\n\nthe request');
    // The API documents `modelOptions` as provider-specific, which is why the
    // moved code never sent it and why the seam has no field for it (§5.2).
    expect(sentOptions(model)).not.toHaveProperty('modelOptions');
  });

  it('passes the request’s purpose to the consent dialog as its justification', async () => {
    const model = createModel();
    offer(model);
    const listed = await transport().listModels();

    await transport().complete(listed[0] as AiModelInfo, request({ purpose: 'the AI pre-review needs a model' }));

    expect(sentOptions(model)['justification']).toBe('the AI pre-review needs a model');
  });

  it('maps the text parts first and the reasoning parts second, and never reads the projection', async () => {
    const parts = [textPart('{"comments"'), reasoningPart('thinking'), textPart(':[]}')];
    const model = createModel({ parts, forbidTextProjection: true });
    offer(model);
    const listed = await transport().listModels();

    const result = await transport().complete(listed[0] as AiModelInfo, request());

    expect(result.parts).toEqual([
      { kind: 'text', text: '{"comments":[]}' },
      { kind: 'reasoning', text: 'thinking' },
    ]);
    // The fragments are the text parts, in order: the transport record of the
    // stream the answer can come from.
    expect(result.fragments).toEqual(['{"comments"', ':[]}']);
    expect(result.model).toBe(listed[0]);
  });

  it('reads the `text` projection only when no part carried text, and marks it as that channel', async () => {
    const toolCall = new (
      vscode as unknown as { LanguageModelToolCallPart: new (id: string, name: string, input: object) => unknown }
    ).LanguageModelToolCallPart('call-1', 'forgejo_review', {});
    const model = createModel({ parts: [toolCall], textChunks: ['{"comments"', ':[]}'] });
    offer(model);
    const listed = await transport().listModels();

    const result = await transport().complete(listed[0] as AiModelInfo, request());

    expect(result.parts).toEqual([{ kind: 'text-projection', text: '{"comments":[]}' }]);
    // The projection is one fragment, which is the channel's own boundary.
    expect(result.fragments).toEqual(['{"comments":[]}']);
  });

  it('falls back to the `text` projection when the response carries no stream at all', async () => {
    // The older editor shape: no `stream` iterable, so the projection is the only
    // channel there is, and it is read once.
    const model = createModel({ projectionOnly: true, textChunks: ['{"comments"', ':[]}'] });
    offer(model);
    const listed = await transport().listModels();

    const result = await transport().complete(listed[0] as AiModelInfo, request());

    expect(result.parts).toEqual([{ kind: 'text-projection', text: '{"comments":[]}' }]);
    expect(result.fragments).toEqual(['{"comments":[]}']);
  });

  it('rejects a response with no readable stream', async () => {
    const model = createModel();
    model.sendRequest = vi.fn(async () => ({}) as never);
    offer(model);
    const listed = await transport().listModels();

    await expect(transport().complete(listed[0] as AiModelInfo, request())).rejects.toThrow(
      'the model returned no response stream',
    );
  });

  it('throws a cancellation — not an answer — when the signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    const model = createModel();
    offer(model);
    const listed = await transport().listModels();

    const failure = await transport()
      .complete(listed[0] as AiModelInfo, request({ signal: controller.signal }))
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).name).toBe('AbortError');
  });

  it('stops reading when the signal aborts mid-stream and throws a cancellation', async () => {
    const controller = new AbortController();
    let partsRead = 0;
    const model = createModel({
      parts: [textPart('first'), textPart('second')],
      forbidTextProjection: true,
      beforeFirstPart: () => {
        partsRead += 1;
        controller.abort();
      },
    });
    offer(model);
    const listed = await transport().listModels();

    const failure = await transport()
      .complete(listed[0] as AiModelInfo, request({ signal: controller.signal }))
      .catch((error: unknown) => error);

    // The sweep stopped at its own check rather than draining the stream, and the
    // cancellation is what the feature's `isCancellation` reads.
    expect(partsRead).toBe(1);
    expect((failure as Error).name).toBe('AbortError');
  });

  it('rethrows a stream that broke, for the feature to classify', async () => {
    const model = createModel();
    // The response's `stream` itself throws on its first step: a provider abort,
    // which is a failed call rather than an answer.
    model.sendRequest = vi.fn(async () => ({
      stream: {
        [Symbol.asyncIterator]() {
          return {
            next: async (): Promise<IteratorResult<unknown>> => {
              throw Object.assign(new Error('cancelled'), { name: 'AbortError' });
            },
          };
        },
      },
    })) as never;
    offer(model);
    const listed = await transport().listModels();

    const failure = await transport()
      .complete(listed[0] as AiModelInfo, request())
      .catch((error: unknown) => error);

    expect((failure as Error).name).toBe('AbortError');
  });
});

describe('the vscode.lm transport does not read a provider configuration (§5.5)', () => {
  /**
   * One pass over the whole seam with one model: what the transport answers, what
   * the model was asked for, and the request's bytes. Plain data, so two runs can
   * be compared field by field.
   */
  async function observe(): Promise<Record<string, unknown>> {
    // Each pass starts from an empty call history, so the two observations are
    // comparable field by field (the implementation is left in place).
    vi.mocked(vscode.lm.selectChatModels).mockClear();
    const model = createModel({
      answer: 'the answer',
      parts: [textPart('{"comments":[]}'), reasoningPart('thinking')],
      tokens: 7,
      id: 'observed',
      name: 'Observed',
      vendor: 'fake',
      family: 'observed',
    });
    offer(model);
    const transportUnderTest = transport();

    const availability = await transportUnderTest.availability();
    const listed = await transportUnderTest.listModels();
    const chosen = listed[0] as AiModelInfo;
    const tokens = await transportUnderTest.countTokens(chosen, 'some text');
    const result = await transportUnderTest.complete(chosen, request());

    return {
      availability,
      listed: listed.map((entry) => ({
        name: entry.name,
        vendor: entry.vendor,
        family: entry.family,
        id: entry.id,
        maxInputTokens: entry.maxInputTokens,
      })),
      tokens,
      parts: result.parts,
      fragments: result.fragments,
      model: { vendor: result.model.vendor, id: result.model.id },
      messages: sentMessages(model),
      options: sentOptions(model),
      calls: {
        sendRequest: model.sendRequest.mock.calls.length,
        countTokens: model.countTokens.mock.calls.length,
        selectChatModels: vi.mocked(vscode.lm.selectChatModels).mock.calls.length,
      },
    };
  }

  it('behaves identically with a provider configuration present', async () => {
    const without = await observe();

    // The settings are seeded and readable: a transport that started consulting
    // them would see them here, which is what gives this case its teeth.
    Object.assign(state.settings, PROVIDER_SETTINGS);
    expect(vscode.workspace.getConfiguration('forgejoToolkit').get('aiProviders')).toEqual(
      PROVIDER_SETTINGS['aiProviders'],
    );

    const withProviders = await observe();

    expect(withProviders).toEqual(without);
    // And the configuration really was in play for the second pass: the settings
    // stayed where they were put.
    expect(state.settings['aiTransport']).toBe('openai-compatible');
  });
});

/**
 * The run through the seam, on the default mocked pull request. These cases are
 * the end-to-end half of the contract: they use the same `runAiPreReview` the
 * existing suite drives, so a change in how the seam's answers are treated shows
 * up here as well as there.
 */
describe('the run through the seam', () => {
  const params: ForgejoPrUriParams = {
    instanceId: mockInstance.id,
    owner: 'demo-user',
    repo: 'demo-repo',
    index: 2,
    ref: 'def456',
    path: 'src/index.ts',
    isBase: false,
  };

  const config = { getInstances: () => [mockInstance] } as unknown as ConfigManager;
  const controller = {
    findPendingReview: vi.fn(async () => undefined),
    refreshPullRequestComments: vi.fn(async () => undefined),
  } as unknown as PullReviewCommentController;
  const host = { extensionUri: vscode.Uri.file('/ext') };

  beforeEach(async () => {
    await startMockServer();
  });

  afterEach(() => {
    // Only this describe starts interception; a transport-level case never opens a
    // socket, and stopping a server that was never started is not this test's job.
    stopMockServer();
  });

  async function runWithModel(model: ReturnType<typeof createModel>): Promise<void> {
    offer(model);
    await runAiPreReview(config, undefined, controller, params, host);
  }

  it('asks the one configured model and nothing else, with a full provider configuration present', async () => {
    state.settings = {
      aiPreReview: true,
      aiPreReviewPromptScope: 'metadata-only',
      aiPreReviewModel: 'fake/only',
      ...PROVIDER_SETTINGS,
    };
    const model = createModel({ answer: DEFAULT_ANSWER, id: 'only', family: 'only' });

    await runWithModel(model);

    // Nothing about the configured endpoint moved the run onto it: the seam's one
    // implementation asked the `vscode.lm` model the setting names, exactly once,
    // with the prompt a provider-less run would send.
    expect(model.sendRequest).toHaveBeenCalledTimes(1);
    expect(sentMessages(model)[0]?.content).toContain('[changed-files]');
    expect(vscode.window.showErrorMessage).not.toHaveBeenCalled();
  });

  it('treats "this model has no tokenizer" as no measurement rather than as a budget failure', async () => {
    state.settings = {
      aiPreReview: true,
      aiPreReviewPromptScope: 'metadata-only',
      aiPreReviewModel: 'fake/blind',
    };
    // A tokenizer that answers nothing, against a budget no prompt could fit: the
    // seam's `undefined` arm is not a budget failure, so the run proceeds and
    // sends the whole brief — which is what the old `undefined >= budget`
    // comparison did before the seam existed.
    const model = createModel({ answer: DEFAULT_ANSWER, id: 'blind', family: 'blind', maxInputTokens: 1 });
    model.countTokens = vi.fn(async () => undefined) as never;

    await runWithModel(model);

    expect(model.sendRequest).toHaveBeenCalledTimes(1);
    expect(sentMessages(model)[0]?.content).toContain('[changed-files]');
    expect(vscode.window.showErrorMessage).not.toHaveBeenCalled();
  });

  it('refuses the run before any request when the tokenizer throws', async () => {
    state.settings = {
      aiPreReview: true,
      aiPreReviewPromptScope: 'metadata-only',
      aiPreReviewModel: 'fake/broken',
    };
    const model = createModel({ answer: DEFAULT_ANSWER, id: 'broken', family: 'broken' });
    model.countTokens = vi.fn(async () => {
      throw new Error('no tokenizer here');
    }) as never;

    await runWithModel(model);

    // The other arm of the same distinction: a measurement that broke is reported
    // as "could not measure" and nothing is sent.
    expect(model.sendRequest).not.toHaveBeenCalled();
    expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
      expect.stringContaining('would not measure its fixed instruction prompt'),
    );
  });

  it('does not list, measure or ask anything while the feature switch is off', async () => {
    state.settings = { aiPreReview: false, ...PROVIDER_SETTINGS };
    const model = createModel({ id: 'unused' });

    await runWithModel(model);

    expect(model.sendRequest).not.toHaveBeenCalled();
    expect(model.countTokens).not.toHaveBeenCalled();
    expect(vscode.lm.selectChatModels).not.toHaveBeenCalled();
  });
});
