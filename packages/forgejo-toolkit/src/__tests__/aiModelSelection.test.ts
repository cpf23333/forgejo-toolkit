import { describe, it, expect, vi, beforeEach, afterEach, beforeAll, afterAll, type Mock } from 'vitest';
import { http, HttpResponse } from 'msw';

/**
 * `selectedModelFor` — the one place that decides which transport serves a feature
 * (`docs/design/ai-model-transport.md` §8.4) — and the three properties §9 and §11.2
 * ask it to prove:
 *
 * 1. **Capability, not brand.** The editor question is answered by
 *    `availability()`/`listModels()` and nothing else; an editor with no language
 *    model API and an editor whose provider lists nothing take the same branch.
 *    (`src/__tests__/aiModelSettings.test.ts` proves the mechanism half: no
 *    `src/ai/` module reads an editor-identity field.)
 * 2. **No fallback in either direction.** A chosen direct endpoint that fails is a
 *    failure and never becomes a `vscode.lm` call; a chosen `vscode.lm` run never
 *    becomes a request to a configured endpoint. Both directions are asserted by
 *    watching the other side, not by reading the returned kind.
 * 3. **Configuration is not consent.** A configured endpoint with a stored key is
 *    not reached while `forgejoToolkit.aiProvidersEnabled` is off, and choosing a
 *    transport at all sends **zero** requests — that is the structural premise the
 *    record's "nothing leaves the machine before the consent question is answered"
 *    rests on (§7.2). The feature-level consent modal itself is wired in stage 3,
 *    so what is provable here is exactly that premise: the direct endpoint receives
 *    no request while the prompt scope is still `ask`.
 */

const state = vi.hoisted(() => ({
  settings: {} as Record<string, unknown>,
}));

vi.mock('vscode', () => ({
  workspace: {
    getConfiguration: vi.fn(() => ({
      get: vi.fn((key: string, fallback?: unknown) => (key in state.settings ? state.settings[key] : fallback)),
      update: vi.fn(),
    })),
    onDidChangeConfiguration: vi.fn(() => ({ dispose: vi.fn() })),
  },
  window: {
    createOutputChannel: vi.fn(() => ({ appendLine: vi.fn(), show: vi.fn(), dispose: vi.fn() })),
    showErrorMessage: vi.fn(),
    showInformationMessage: vi.fn(),
    showWarningMessage: vi.fn(),
    showQuickPick: vi.fn(),
    state: { focused: true },
    onDidChangeWindowState: vi.fn(() => ({ dispose: vi.fn() })),
  },
  commands: { registerCommand: vi.fn(() => ({ dispose: vi.fn() })), executeCommand: vi.fn() },
  ConfigurationTarget: { Global: 1, Workspace: 2, WorkspaceFolder: 3 },
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

import { mockServer, startMockServer, stopMockServer, unhandledRequests } from '../test/mocks/server';
import { logger } from '../logger';
import { selectedModelFor, type AiTransportSelectionDeps } from '../ai/modelSelection';
import type { AiModelInfo, AiModelTransport } from '../ai/transport';
import { aiProviderHeaderSecretKey, aiProviderKeySecretKey, type AiSecretStore } from '../ai/providerSecrets';

const BASE_URL = 'http://localhost:11434/v1';
const CHAT_URL = `${BASE_URL}/chat/completions`;
const MODELS_URL = `${BASE_URL}/models`;
const API_KEY = 'sk-selection-test-key-0123456789';

const PROVIDER = {
  id: 'local-gateway',
  name: 'Local Gateway',
  baseUrl: BASE_URL,
  models: [{ id: 'qwen3:8b', name: 'Qwen3 8B' }],
  auth: 'bearer' as const,
  headers: [] as Array<{ name: string; valueSecret: true }>,
  localOnly: false,
};

/** Every request the configured endpoint received, so "zero requests" can be asserted. */
let endpointRequests: string[] = [];

function secretStore(): AiSecretStore {
  const values: Record<string, string> = {
    [aiProviderKeySecretKey('local-gateway')]: API_KEY,
    [aiProviderHeaderSecretKey('local-gateway', 'api-version') ?? '']: 'a-header-value',
  };
  return {
    get: async (key: string) => values[key],
    store: async (key: string, value: string) => {
      values[key] = value;
    },
    delete: async (key: string) => {
      delete values[key];
    },
  };
}

interface EditorTransport extends AiModelTransport {
  availability: Mock<AiModelTransport['availability']>;
  listModels: Mock<AiModelTransport['listModels']>;
  countTokens: Mock<AiModelTransport['countTokens']>;
  complete: Mock<AiModelTransport['complete']>;
}

/** The editor's own models, as `vscode.lm` would answer. */
function editorTransport(options: { usable?: boolean; models?: AiModelInfo[]; reason?: string } = {}): EditorTransport {
  return {
    id: 'vscode.lm',
    availability: vi.fn<AiModelTransport['availability']>(async () =>
      options.usable === false
        ? { usable: false as const, reason: options.reason ?? 'no language model API here' }
        : { usable: true as const },
    ),
    listModels: vi.fn<AiModelTransport['listModels']>(async () => options.models ?? []),
    countTokens: vi.fn<AiModelTransport['countTokens']>(async () => undefined),
    complete: vi.fn<AiModelTransport['complete']>(async () => {
      throw new Error('the selection must not complete anything');
    }),
  };
}

const EDITOR_MODEL: AiModelInfo = { vendor: 'copilot', id: 'gpt-4o', name: 'GPT-4o' };

function deps(editor: EditorTransport): AiTransportSelectionDeps {
  return { secrets: secretStore(), vscodeLm: editor };
}

/** Everything the logger was handed. */
function loggedText(): string[] {
  return [logger.debug, logger.info, logger.error].flatMap((method) =>
    vi.mocked(method).mock.calls.map((call) => String(call[0])),
  );
}

beforeAll(async () => {
  await startMockServer();
});

afterAll(() => {
  stopMockServer();
});

beforeEach(() => {
  endpointRequests = [];
  state.settings = {};
  vi.clearAllMocks();
  vi.spyOn(logger, 'debug');
  vi.spyOn(logger, 'info');
  vi.spyOn(logger, 'error');
  // The endpoint answers nothing useful on purpose: these cases are about whether a
  // request is made at all, not about what comes back.
  mockServer.use(
    http.post(CHAT_URL, ({ request }) => {
      endpointRequests.push(request.url);
      return new HttpResponse('{"choices":[]}', { headers: { 'content-type': 'application/json' } });
    }),
    http.get(MODELS_URL, ({ request }) => {
      endpointRequests.push(request.url);
      return new HttpResponse('{"data":[]}', { headers: { 'content-type': 'application/json' } });
    }),
  );
});

afterEach(() => {
  mockServer.resetHandlers();
  mockServer.events.removeAllListeners();
});

describe('the selection rules (§8.4)', () => {
  it('binds a feature to a named endpoint and model', async () => {
    state.settings = {
      aiProviders: [PROVIDER],
      aiProvidersEnabled: true,
      aiModelBindings: [{ feature: 'aiPreReview', providerId: 'local-gateway', modelId: 'qwen3:8b' }],
      aiTransport: 'vscode-lm',
    };

    const outcome = await selectedModelFor('aiPreReview', deps(editorTransport({ models: [EDITOR_MODEL] })));

    // A binding outranks the transport choice: it names the destination.
    expect(outcome.kind).toBe('openai-compatible');
    expect(outcome.kind === 'openai-compatible' && outcome.transport.id).toBe('openai-compatible:local-gateway');
    expect(outcome.kind === 'openai-compatible' && outcome.model).toEqual({
      vendor: 'local-gateway',
      id: 'qwen3:8b',
      name: 'Qwen3 8B',
    });
    expect(loggedText().join('\n')).toContain('"forgejoToolkit.aiModelBindings" binds "aiPreReview"');
  });

  it('prefers an editor model in auto, and considers a configured endpoint only without one', async () => {
    state.settings = {
      aiProviders: [PROVIDER],
      aiProvidersEnabled: true,
      aiTransport: 'auto',
    };

    const withEditor = await selectedModelFor('aiPreReview', deps(editorTransport({ models: [EDITOR_MODEL] })));
    const withoutEditor = await selectedModelFor('aiPreReview', deps(editorTransport({ models: [] })));

    expect(withEditor.kind).toBe('vscode-lm');
    expect(withoutEditor.kind).toBe('openai-compatible');
    expect(withoutEditor.kind === 'openai-compatible' && withoutEditor.model.id).toBe('qwen3:8b');
  });

  it('refuses to guess between two configured endpoints', async () => {
    state.settings = {
      aiProviders: [PROVIDER, { ...PROVIDER, id: 'second-gateway', name: 'Second' }],
      aiProvidersEnabled: true,
      aiTransport: 'auto',
    };

    const outcome = await selectedModelFor('aiPreReview', deps(editorTransport({ models: [] })));

    expect(outcome.kind).toBe('unavailable');
    expect(outcome.kind === 'unavailable' && outcome.code).toBe('bind');
    expect(outcome.kind === 'unavailable' && outcome.reason).toContain('aiModelBindings');
  });

  it('fails by name when the bound endpoint is not configured, and does not resolve to a neighbour', async () => {
    state.settings = {
      aiProviders: [PROVIDER],
      aiProvidersEnabled: true,
      aiModelBindings: [{ feature: 'aiPreReview', providerId: 'deleted-gateway', modelId: 'qwen3:8b' }],
    };

    const outcome = await selectedModelFor('aiPreReview', deps(editorTransport({ models: [EDITOR_MODEL] })));

    expect(outcome.kind).toBe('unavailable');
    expect(outcome.kind === 'unavailable' && outcome.reason).toContain('deleted-gateway');
    expect(endpointRequests).toEqual([]);
  });

  it('binds the PR-description feature to its own endpoint and model', async () => {
    // The second feature on the seam (`docs/design/ai-pr-description.md` §5): it
    // reaches the same selection point with its own feature id, and a binding that
    // names `prDescription` decides it exactly as `aiPreReview` decides the
    // pre-review. Two features, one selector, and no path of their own.
    state.settings = {
      aiProviders: [PROVIDER],
      aiProvidersEnabled: true,
      aiModelBindings: [{ feature: 'prDescription', providerId: 'local-gateway', modelId: 'qwen3:8b' }],
    };

    const outcome = await selectedModelFor('prDescription', deps(editorTransport({ models: [EDITOR_MODEL] })));

    expect(outcome.kind).toBe('openai-compatible');
    expect(outcome.kind === 'openai-compatible' && outcome.model.id).toBe('qwen3:8b');
    expect(loggedText().join('\n')).toContain('"forgejoToolkit.aiModelBindings" binds "prDescription"');
  });

  it('refuses a feature id this build does not know, without sending anything', async () => {
    const outcome = await selectedModelFor(
      'notAFeature' as unknown as 'aiPreReview',
      deps(editorTransport({ models: [EDITOR_MODEL] })),
    );

    expect(outcome.kind).toBe('unavailable');
    expect(endpointRequests).toEqual([]);
  });
});

describe('no fallback between the two transports (§7.5)', () => {
  it('does not ask the editor models when the bound endpoint fails', async () => {
    state.settings = {
      aiProviders: [PROVIDER],
      aiProvidersEnabled: true,
      aiModelBindings: [{ feature: 'aiPreReview', providerId: 'local-gateway', modelId: 'qwen3:8b' }],
    };
    const editor = editorTransport({ models: [EDITOR_MODEL] });
    // The bound endpoint cannot be used at all (its stored key is gone).
    const withoutKey: AiSecretStore = {
      get: async () => undefined,
      store: async () => undefined,
      delete: async () => undefined,
    };

    const outcome = await selectedModelFor('aiPreReview', { secrets: withoutKey, vscodeLm: editor });

    expect(outcome.kind).toBe('unavailable');
    expect(outcome.kind === 'unavailable' && outcome.code).toBe('endpoint-unusable');
    // The other direction of the rule: not one editor call was made to cover for it.
    expect(editor.availability).not.toHaveBeenCalled();
    expect(editor.listModels).not.toHaveBeenCalled();
    expect(editor.complete).not.toHaveBeenCalled();
  });

  it('does not send anything to a configured endpoint when vscode-lm is chosen', async () => {
    state.settings = {
      aiProviders: [PROVIDER],
      aiProvidersEnabled: true,
      aiTransport: 'vscode-lm',
      aiModelBindings: [],
    };

    const outcome = await selectedModelFor('aiPreReview', deps(editorTransport({ models: [EDITOR_MODEL] })));

    expect(outcome.kind).toBe('vscode-lm');
    expect(endpointRequests).toEqual([]);
    expect(unhandledRequests()).toEqual([]);
  });

  it('reports an unusable editor rather than reaching for a configured endpoint', async () => {
    state.settings = {
      aiProviders: [PROVIDER],
      aiProvidersEnabled: true,
      aiTransport: 'vscode-lm',
    };

    const outcome = await selectedModelFor(
      'aiPreReview',
      deps(editorTransport({ usable: false, reason: 'editor API is broken' })),
    );

    expect(outcome.kind).toBe('unavailable');
    expect(outcome.kind === 'unavailable' && outcome.code).toBe('editor-unusable');
    expect(outcome.kind === 'unavailable' && outcome.reason).toContain('editor API is broken');
    expect(endpointRequests).toEqual([]);
  });
});

describe('configuration is not consent (§7.3, §7.2)', () => {
  it('does not use a configured endpoint while the egress switch is off', async () => {
    state.settings = {
      aiProviders: [PROVIDER],
      aiProvidersEnabled: false,
      aiModelBindings: [{ feature: 'aiPreReview', providerId: 'local-gateway', modelId: 'qwen3:8b' }],
    };
    const editor = editorTransport({ models: [EDITOR_MODEL] });

    const outcome = await selectedModelFor('aiPreReview', deps(editor));

    expect(outcome.kind).toBe('unavailable');
    expect(outcome.kind === 'unavailable' && outcome.code).toBe('disabled');
    expect(outcome.kind === 'unavailable' && outcome.reason).toContain('forgejoToolkit.aiProvidersEnabled');
    // A configured endpoint and a stored key still send nothing, and they do not
    // become an editor call either.
    expect(endpointRequests).toEqual([]);
    expect(editor.availability).not.toHaveBeenCalled();
  });

  it('sends nothing while the prompt scope is still ask, whatever else is configured', async () => {
    state.settings = {
      // The consent question has not been answered: `ask` is the question, not an
      // answer, and the record's hard rule is that nothing leaves the machine before
      // it is answered. Everything a direct request would need is configured.
      aiPreReviewPromptScope: 'ask',
      aiProviders: [PROVIDER],
      aiProvidersEnabled: true,
      aiTransport: 'openai-compatible',
      aiModelBindings: [{ feature: 'aiPreReview', providerId: 'local-gateway', modelId: 'qwen3:8b' }],
    };

    const outcome = await selectedModelFor('aiPreReview', deps(editorTransport({ models: [] })));
    // Choosing a transport is a lookup: it can be done before the answer, and doing
    // it must not send anything.
    if (outcome.kind === 'openai-compatible') {
      await outcome.transport.availability();
      await outcome.transport.listModels();
      await outcome.transport.countTokens(outcome.model, 'some text');
    }

    expect(endpointRequests).toEqual([]);
    expect(unhandledRequests()).toEqual([]);
  });

  it('refuses a non-local endpoint while the local-only policy is on', async () => {
    state.settings = {
      aiProviders: [{ ...PROVIDER, baseUrl: 'https://models.example.com/v1' }],
      aiProvidersEnabled: true,
      aiLocalOnly: true,
      aiTransport: 'openai-compatible',
    };

    const outcome = await selectedModelFor('aiPreReview', deps(editorTransport({ models: [] })));

    expect(outcome.kind).toBe('unavailable');
    expect(outcome.kind === 'unavailable' && outcome.reason).toContain('forgejoToolkit.aiLocalOnly');
    expect(endpointRequests).toEqual([]);
  });

  it('refuses a bound endpoint the settings reader could not read, naming the reason', async () => {
    state.settings = {
      aiProviders: [{ id: 'local-gateway', name: 'Local Gateway', baseUrl: BASE_URL, auth: 'token' }],
      aiProvidersEnabled: true,
      aiModelBindings: [{ feature: 'aiPreReview', providerId: 'local-gateway', modelId: 'qwen3:8b' }],
    };

    const outcome = await selectedModelFor('aiPreReview', deps(editorTransport({ models: [] })));

    expect(outcome.kind).toBe('unavailable');
    expect(outcome.kind === 'unavailable' && outcome.reason).toContain('could not be read');
    expect(endpointRequests).toEqual([]);
  });

  it('reports both absences together when nothing can serve the feature', async () => {
    state.settings = { aiTransport: 'auto' };

    const outcome = await selectedModelFor('aiPreReview', deps(editorTransport({ models: [] })));

    expect(outcome.kind).toBe('unavailable');
    expect(outcome.kind === 'unavailable' && outcome.code).toBe('no-model');
    expect(outcome.kind === 'unavailable' && outcome.reason).toContain(
      'Install an extension that contributes a chat model',
    );
    expect(endpointRequests).toEqual([]);
  });
});
