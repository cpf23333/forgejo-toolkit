import { describe, it, expect, vi, beforeEach, afterEach, beforeAll, afterAll, type Mock } from 'vitest';

/**
 * The host half of the "generate a pull request description" run.
 *
 * The model transport is faked (through `selectedModelFor`) rather than reached
 * over HTTP, because what these cases are about is the run's **decisions**: which
 * transport served it, whether the comparison was read at all before the consent
 * question was answered, and what one failure leaves on the user's screen. The
 * comparison itself is read through the real client against the shared mock
 * handlers, so "zero requests" is measured on a real request path rather than on
 * a mock's call count.
 *
 * Four properties have a case each, and they are the ones `docs/design/ai-model-transport.md`
 * §7.2, §7.3 and §7.5 and the feature's own honest-failure rule ask for:
 * 1. consent still pending means **zero** requests and zero model calls;
 * 2. a configured endpoint can serve the draft (the seam's second transport);
 * 3. a failure reports a sentence and produces no text — which is what "the body
 *    was left untouched" means for a caller that fills a field only from a
 *    successful answer;
 * 4. no usable model means no request and no model call, with the settings page
 *    named as where the remedies are.
 */

const state = vi.hoisted(() => ({
  /** Configuration values, keyed by the setting name without its section. */
  settings: {} as Record<string, unknown>,
  /** The write the run may make: the consent answer, at global scope. */
  settingUpdates: [] as Array<{ key: string; value: unknown; target?: unknown }>,
  /** The selection the seam answers with, installed by each case. */
  selection: undefined as unknown,
  /** Every `selectedModelFor` call, so "asked for the right feature" is provable. */
  selectionCalls: [] as Array<{ feature: string; deps: unknown }>,
}));

vi.mock('../ai/modelSelection', () => ({
  selectedModelFor: vi.fn(async (feature: string, deps: unknown) => {
    state.selectionCalls.push({ feature, deps });
    return state.selection;
  }),
}));

vi.mock('vscode', () => ({
  ProgressLocation: { SourceControl: 1, Window: 10, Notification: 15 },
  window: {
    showErrorMessage: vi.fn(),
    showInformationMessage: vi.fn(),
    showWarningMessage: vi.fn(),
    showQuickPick: vi.fn(),
    withProgress: vi.fn(async (_options: unknown, task: (progress: unknown, token: unknown) => unknown) =>
      task({ report: vi.fn() }, { isCancellationRequested: false, onCancellationRequested: vi.fn() }),
    ),
    createOutputChannel: vi.fn(() => ({ appendLine: vi.fn(), show: vi.fn(), dispose: vi.fn() })),
    state: { focused: true },
    onDidChangeWindowState: vi.fn(() => ({ dispose: vi.fn() })),
  },
  workspace: {
    getConfiguration: vi.fn(() => ({
      get: vi.fn((key: string, fallback?: unknown) => (key in state.settings ? state.settings[key] : fallback)),
      update: vi.fn(async (key: string, value: unknown, target?: unknown) => {
        state.settingUpdates.push({ key, value, target });
        state.settings[key] = value;
      }),
    })),
    onDidChangeConfiguration: vi.fn(() => ({ dispose: vi.fn() })),
  },
  ConfigurationTarget: { Global: 1, Workspace: 2, WorkspaceFolder: 3 },
  commands: { registerCommand: vi.fn(() => ({ dispose: vi.fn() })), executeCommand: vi.fn() },
  Uri: { file: vi.fn((fsPath: string) => ({ fsPath, scheme: 'file' })) },
  env: { language: 'en' },
  l10n: {
    t: vi.fn((message: string, ...args: unknown[]) =>
      message.replace(/\{([^{}]+)\}/g, (placeholder, key: string) => {
        const value = args[Number(key)];
        return value === undefined ? placeholder : String(value);
      }),
    ),
  },
  Disposable: { from: vi.fn() },
}));

import * as vscode from 'vscode';
import { http, HttpResponse } from 'msw';
import {
  mockServer,
  startMockServer,
  stopMockServer,
  unhandledRequests,
  clearUnhandledRequests,
} from '../test/mocks/server';
import { mockInstance } from '../test/mocks/data/instances';
import { logger } from '../logger';
import type { ConfigManager } from '../config';
import type { ForgejoToolkitViewProvider } from '../webview/viewProvider';
import type { AiCompletionResult, AiModelInfo, AiModelTransport } from '../ai/transport';
import type { AiTransportSelection } from '../ai/modelSelection';
import {
  COMMAND_GENERATE_PR_DESCRIPTION,
  PR_DESCRIPTION_SCOPE_BUTTON_COMMITS,
  generatePrDescription,
  registerPrDescriptionCommand,
} from '../prDescription';

beforeAll(async () => {
  await startMockServer();
});

afterAll(() => {
  stopMockServer();
});

/** The run's own view provider handover, as `registerPrDescriptionCommand` needs it. */
function viewProviderWithRunner(): {
  provider: ForgejoToolkitViewProvider;
  runner: () => ((target: unknown) => Promise<unknown>) | undefined;
} {
  let installed: ((target: unknown) => Promise<unknown>) | undefined;
  const provider = {
    setPrDescriptionRunner(next: (target: unknown) => Promise<unknown>) {
      installed = next;
    },
  } as unknown as ForgejoToolkitViewProvider;
  return { provider, runner: () => installed };
}

const config = { getInstances: () => [mockInstance] } as unknown as ConfigManager;

/** The target every case submits: the comparison the form would hold. */
function target(overrides: Record<string, unknown> = {}) {
  return {
    instanceId: mockInstance.id,
    owner: 'demo-user',
    repo: 'demo-repo',
    base: 'main',
    head: 'feature',
    ...overrides,
  };
}

const EDITOR_MODEL: AiModelInfo = { vendor: 'copilot', id: 'gpt-4o', name: 'GPT-4o' };

const PROVIDER = {
  id: 'local-gateway',
  name: 'Local Gateway',
  baseUrl: 'http://localhost:11434/v1',
  models: [{ id: 'qwen3:8b', name: 'Qwen3 8B' }],
  auth: 'bearer' as const,
  headers: [] as Array<{ name: string; valueSecret: true }>,
  localOnly: false,
};

interface FakeTransport extends AiModelTransport {
  availability: Mock<AiModelTransport['availability']>;
  listModels: Mock<AiModelTransport['listModels']>;
  countTokens: Mock<AiModelTransport['countTokens']>;
  complete: Mock<AiModelTransport['complete']>;
}

/**
 * One transport, with every call recorded.
 *
 * `complete` answers whatever the case installed, or throws it: a rejected call
 * and an unusable answer are different code paths, so both are reachable here.
 */
function fakeTransport(options: {
  id?: string;
  models?: AiModelInfo[];
  answer?: string;
  parts?: AiCompletionResult['parts'];
  completeError?: unknown;
}): FakeTransport {
  const id = options.id ?? 'vscode.lm';
  return {
    id,
    availability: vi.fn<AiModelTransport['availability']>(async () => ({ usable: true as const })),
    listModels: vi.fn<AiModelTransport['listModels']>(async () => options.models ?? [EDITOR_MODEL]),
    countTokens: vi.fn<AiModelTransport['countTokens']>(async () => undefined),
    complete: vi.fn<AiModelTransport['complete']>(async (model) => {
      if (options.completeError !== undefined) {
        throw options.completeError;
      }
      const parts = options.parts ?? [{ kind: 'text' as const, text: options.answer ?? 'A drafted description.' }];
      return { model, parts };
    }),
  };
}

/** The selection a case installs for a `vscode.lm` run. */
function editorSelection(transport: FakeTransport): AiTransportSelection {
  return { kind: 'vscode-lm', transport, reason: 'the editor offers models' };
}

/** The selection a case installs for a configured-endpoint run. */
function directSelection(transport: FakeTransport, model: AiModelInfo): AiTransportSelection {
  return { kind: 'openai-compatible', transport, model, reason: 'a binding names this endpoint' };
}

/** Everything the logger was handed, so a run's own account of itself is readable. */
function loggedText(): string {
  return [logger.debug, logger.info, logger.error]
    .flatMap((method) => vi.mocked(method).mock.calls.map((call) => String(call[0])))
    .join('\n');
}

beforeEach(() => {
  state.settings = {};
  state.settingUpdates = [];
  state.selectionCalls = [];
  state.selection = undefined;
  clearUnhandledRequests();
  // `clearAllMocks` drops every implementation, so it has to run **before** the
  // two defaults below: a default installed before it is wiped, and the run then
  // reads a dismissed picker as "the user cancelled" — which is exactly the
  // failure this ordering was found by.
  vi.clearAllMocks();
  vi.spyOn(logger, 'debug');
  vi.spyOn(logger, 'info');
  vi.spyOn(logger, 'error');
  // There is no model setting of this feature's own: on the editor path the run
  // asks every time, and this answers with **whatever row it was offered**, so the
  // case cannot pass by agreeing with a label the picker would never have shown.
  vi.mocked(vscode.window.showQuickPick).mockImplementation(async (items) => {
    const list = items as unknown as Array<{ model?: unknown }>;
    return list[0] as never;
  });
  // The consent modal is **not** defaulted to an answer: a case that expects a run
  // to proceed states the scope in the settings, and a case that is about consent
  // installs its own answer. Defaulting it here would let a run answer a question
  // no case asked, which is the failure one of the cases below exists to catch.
  vi.mocked(vscode.window.showInformationMessage).mockResolvedValue(undefined as never);
});

afterEach(() => {
  mockServer.resetHandlers();
  vi.restoreAllMocks();
});

describe('the PR-description run', () => {
  it('reads nothing and calls no model while the consent question is unanswered', async () => {
    // The record's §7.2, as a measurement: the scope is still the question, the
    // user dismisses the modal, and the run ends with **zero** requests — not "no
    // model call" alone. The comparison read is the one request this feature makes
    // before the model, so it is what "nothing leaves the machine" is measured on.
    state.settings['prDescription'] = true;
    state.settings['prDescriptionPromptScope'] = 'ask';
    const transport = fakeTransport({});
    state.selection = editorSelection(transport);
    vi.mocked(vscode.window.showInformationMessage).mockResolvedValue(undefined as never);

    const outcome = await generatePrDescription(config, target(), {});

    expect(outcome).toEqual({ kind: 'cancelled' });
    expect(transport.complete).not.toHaveBeenCalled();
    expect(transport.countTokens).not.toHaveBeenCalled();
    expect(unhandledRequests()).toEqual([]);
    // The setting is left as the question: an unanswered consent question is
    // neither consent nor an answer.
    expect(state.settingUpdates).toEqual([]);
    // The run says which arm it ended in: "the question was not answered" is a
    // different fact from "no model was available", and the channel is where a
    // user looks when the modal is gone.
    expect(loggedText()).toContain('was not answered, so nothing was requested');
    expect(unhandledRequests()).toEqual([]);
  });

  it('writes the answer into the setting and then reads the comparison', async () => {
    // The answered-modal path: the answer is stored first (the setting is the
    // source of truth, so the question is asked once per choice), and only then is
    // the comparison read.
    state.settings['prDescription'] = true;
    state.settings['prDescriptionPromptScope'] = 'ask';
    const transport = fakeTransport({ answer: 'Adds the retry helper.' });
    state.selection = editorSelection(transport);
    vi.mocked(vscode.window.showInformationMessage).mockResolvedValue(PR_DESCRIPTION_SCOPE_BUTTON_COMMITS as never);

    const outcome = await generatePrDescription(config, target(), {});

    expect(outcome).toEqual({ kind: 'ok', description: 'Adds the retry helper.' });
    expect(state.settingUpdates).toEqual([
      { key: 'prDescriptionPromptScope', value: 'commits-only', target: vscode.ConfigurationTarget.Global },
    ]);
    expect(transport.complete).toHaveBeenCalledTimes(1);
    expect(unhandledRequests()).toEqual([]);
  });

  it('asks the comparison endpoint for the merge-base range, once per half', async () => {
    // The two halves of the comparison are two requests to one endpoint, and each
    // one has to ask for `base...head` (merge base to head) rather than
    // `base..head`: the latter also lists every commit the base branch gained since
    // the fork point as if it were part of the change. Pinned on the URL the mock
    // server actually received, because the separator is exactly the kind of detail
    // an assembler can quietly drop — which is what this case found: the two halves
    // disagreed about it until both were routed through one method.
    const asked: string[] = [];
    mockServer.use(
      http.get('*://*/api/v1/repos/:owner/:repo/compare/:basehead', ({ request }) => {
        asked.push(new URL(request.url).pathname);
        return HttpResponse.json({ total_commits: 0, commits: [], files: [] });
      }),
    );
    state.settings['prDescription'] = true;
    state.settings['prDescriptionPromptScope'] = 'commits-only';
    const transport = fakeTransport({ answer: 'Empty comparison.' });
    state.selection = editorSelection(transport);

    const outcome = await generatePrDescription(config, target(), {});

    expect(outcome).toEqual({ kind: 'ok', description: 'Empty comparison.' });
    expect(asked).toHaveLength(2);
    for (const path of asked) {
      expect(path.endsWith('/compare/main...feature')).toBe(true);
    }
  });

  it('serves the draft from a configured endpoint, through the same selection point', async () => {
    // The second transport, and the only way it can be reached: the feature asks
    // `selectedModelFor('prDescription', …)` and uses whatever it answers with, so
    // a configured endpoint needs no code of its own in this feature.
    state.settings['prDescription'] = true;
    state.settings['prDescriptionPromptScope'] = 'commits-only';
    state.settings['aiProviders'] = [PROVIDER];
    state.settings['aiProvidersEnabled'] = true;
    state.settings['aiModelBindings'] = [
      { feature: 'prDescription', providerId: 'local-gateway', modelId: 'qwen3:8b' },
    ];
    const transport = fakeTransport({ id: 'openai-compatible:local-gateway', answer: 'From the endpoint.' });
    state.selection = directSelection(transport, { vendor: 'local-gateway', id: 'qwen3:8b', name: 'Qwen3 8B' });

    const outcome = await generatePrDescription(config, target(), {});

    expect(outcome).toEqual({ kind: 'ok', description: 'From the endpoint.' });
    expect(state.selectionCalls.map((call) => call.feature)).toEqual(['prDescription']);
    // A direct run shows no picker: the user already named the model in the
    // binding, so the editor's own list is never consulted.
    expect(vscode.window.showQuickPick).not.toHaveBeenCalled();
    // The consent question is not asked again once answered, and the run reports
    // which transport and endpoint served it.
    expect(vscode.window.showInformationMessage).not.toHaveBeenCalled();
    expect(loggedText()).toContain('openai-compatible:local-gateway');
  });

  it('reports a failed model call and produces no text', async () => {
    state.settings['prDescription'] = true;
    state.settings['prDescriptionPromptScope'] = 'commits-only';
    const transport = fakeTransport({ completeError: new Error('the endpoint refused the connection') });
    state.selection = editorSelection(transport);

    const outcome = await generatePrDescription(config, target(), {});

    // No text at all: the caller fills its body field only from a successful
    // answer, so "no text" **is** "the body was left untouched".
    expect(outcome.kind).toBe('failed');
    expect(outcome).not.toHaveProperty('description');
    const error = (outcome as { error: string }).error;
    expect(error).toContain('the endpoint refused the connection');
    expect(error).toContain('no other model was tried');
    expect(vscode.window.showErrorMessage).toHaveBeenCalledTimes(1);
    // One model, one call: a failure is reported, never retried on another model.
    expect(transport.complete).toHaveBeenCalledTimes(1);
    expect(loggedText()).toContain('Nothing was written');
  });

  it('reports an answer that is not a usable body without producing one', async () => {
    state.settings['prDescription'] = true;
    state.settings['prDescriptionPromptScope'] = 'commits-only';
    const transport = fakeTransport({ parts: [{ kind: 'text', text: '   ' }] });
    state.selection = editorSelection(transport);

    const outcome = await generatePrDescription(config, target(), {});

    expect(outcome.kind).toBe('failed');
    expect((outcome as { error: string }).error).toContain('the answer was empty');
    expect(transport.complete).toHaveBeenCalledTimes(1);
  });

  it('makes no request and calls no model when no model is available', async () => {
    state.settings['prDescription'] = true;
    state.settings['prDescriptionPromptScope'] = 'commits-only';
    state.selection = { kind: 'unavailable', code: 'no-model', reason: 'the editor offers no chat model' };

    const outcome = await generatePrDescription(config, target(), {});

    expect(outcome.kind).toBe('failed');
    // §9.3: the settings page is where the two ways out are explained, so the
    // sentence points there rather than restating them in a toast nobody can act
    // on.
    const error = (outcome as { error: string }).error;
    expect(error).toContain('Settings page');
    expect(error).toContain('the editor offers no chat model');
    expect(unhandledRequests()).toEqual([]);
    expect(vscode.window.showWarningMessage).toHaveBeenCalledTimes(1);
  });

  it('refuses before reading anything while the feature switch is off', async () => {
    // `forgejoToolkit.prDescription` defaults to off, and with it off the action
    // must not reach the comparison endpoint at all.
    state.settings['prDescription'] = false;
    state.settings['prDescriptionPromptScope'] = 'commits-only';
    const transport = fakeTransport({});
    state.selection = editorSelection(transport);

    const outcome = await generatePrDescription(config, target(), {});

    expect(outcome.kind).toBe('failed');
    expect((outcome as { error: string }).error).toContain('forgejoToolkit.prDescription');
    // Not even the model selection is asked: the switch is the first act.
    expect(state.selectionCalls).toEqual([]);
    expect(transport.complete).not.toHaveBeenCalled();
    expect(unhandledRequests()).toEqual([]);
  });

  it('reads the changed files only under the scope that promises them', async () => {
    state.settings['prDescription'] = true;
    state.settings['prDescriptionPromptScope'] = 'commits-and-files';
    const transport = fakeTransport({ answer: 'With file text.' });
    state.selection = editorSelection(transport);

    const outcome = await generatePrDescription(config, target(), {});

    expect(outcome).toEqual({ kind: 'ok', description: 'With file text.' });
    // The file-content read is a real request to the contents API, which the mock
    // handler answers; the prompt the model received carries the section it bought
    // and the comparison it is about.
    const request = transport.complete.mock.calls[0]?.[1];
    expect(request?.messages[0]?.text).toContain('[changed-file-contents]');
    expect(request?.messages[0]?.text).toContain('[commits]');
    expect(request?.messages[0]?.text).toContain('--- src/index.ts ---');
    expect(unhandledRequests()).toEqual([]);
  });

  it('registers the command and hands the view provider the same run', () => {
    const { provider, runner } = viewProviderWithRunner();
    const context = { subscriptions: [] as Array<{ dispose: () => void }> };
    registerPrDescriptionCommand(
      context as unknown as Parameters<typeof registerPrDescriptionCommand>[0],
      config,
      provider,
    );
    const registered = vi.mocked(vscode.commands.registerCommand).mock.calls.map((call) => String(call[0]));
    expect(registered).toContain(COMMAND_GENERATE_PR_DESCRIPTION);
    expect(context.subscriptions).toHaveLength(1);
    // The create-pull-request form's message and the command reach one
    // implementation, the same way the pre-review's two entries do.
    expect(runner()).toBeTypeOf('function');
  });
});
