import { describe, it, expect, vi, beforeEach, afterEach, beforeAll, afterAll } from 'vitest';
import { http, HttpResponse } from 'msw';

/**
 * The `forgejoToolkit.aiTestProvider` command and its probe
 * (`docs/design/ai-model-transport.md` §8.7), plus the one rule that makes it safe
 * to offer at all: it is the only automatic path in this extension that sends
 * content, so it must validate **locally** first and it must report the address it
 * reached without ever echoing a credential.
 *
 * The three things the record asks this command to prove:
 *
 * 1. A configuration mistake fails before a byte is sent (`ran: false`), with a
 *    sentence naming what to fix.
 * 2. `GET /models` is best effort — a 404 or an empty list is not a failure and the
 *    probe then sends one minimal completion — while any other status is a real
 *    failure rendered exactly as the transport renders it.
 * 3. The report carries the HTTP status, the elapsed time, the model count or a
 *    bounded answer excerpt, and the **address**; it never carries the key or a
 *    custom header value, and the display address never carries the query string
 *    that holds `api-version`.
 */

const state = vi.hoisted(() => ({
  settings: {} as Record<string, unknown>,
  quickPick: undefined as unknown,
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
    showQuickPick: vi.fn(async () => state.quickPick),
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

import * as vscode from 'vscode';
import { mockServer, startMockServer, stopMockServer, unhandledRequests } from '../test/mocks/server';
import { logger } from '../logger';
import {
  COMMAND_AI_TEST_PROVIDER,
  aiTestProviderCommand,
  registerAiTestProviderCommand,
  runAiProviderTest,
} from '../ai/testProvider';
import type { AiProviderConfig } from '../ai/modelSettings';
import { aiProviderHeaderSecretKey, aiProviderKeySecretKey, type AiSecretStore } from '../ai/providerSecrets';

const BASE_URL = 'http://localhost:11434/v1';
const CHAT_URL = `${BASE_URL}/chat/completions`;
const MODELS_URL = `${BASE_URL}/models`;
const API_KEY = 'sk-endpoint-test-key-0123456789';
const HEADER_VALUE = 'endpoint-test-header-value';

const PROVIDER: AiProviderConfig = {
  id: 'local-gateway',
  name: 'Local Gateway',
  baseUrl: BASE_URL,
  models: [{ id: 'qwen3:8b', name: 'Qwen3 8B' }],
  auth: 'bearer',
  headers: [{ name: 'api-version', valueSecret: true }],
  localOnly: false,
};

let endpointRequests: string[] = [];

function secretStore(extra: Record<string, string> = {}): AiSecretStore {
  const values: Record<string, string> = {
    [aiProviderKeySecretKey('local-gateway')]: API_KEY,
    [aiProviderHeaderSecretKey('local-gateway', 'api-version') ?? '']: HEADER_VALUE,
    ...extra,
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

const EMPTY_STORE: AiSecretStore = {
  get: async () => undefined,
  store: async () => undefined,
  delete: async () => undefined,
};

/** Everything the logger was handed, so a leak has somewhere to show up. */
function loggedText(): string[] {
  return [logger.debug, logger.info, logger.error].flatMap((method) =>
    vi.mocked(method).mock.calls.map((call) => String(call[0])),
  );
}

/** The messages the command showed the user, of either severity. */
function shownMessages(): string[] {
  return [
    ...vi.mocked(vscode.window.showInformationMessage).mock.calls,
    ...vi.mocked(vscode.window.showErrorMessage).mock.calls,
  ].map((call) => String(call[0]));
}

function expectNoSecret(text: string[]): void {
  for (const line of text) {
    expect(line).not.toContain(API_KEY);
    expect(line).not.toContain(HEADER_VALUE);
  }
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
  state.quickPick = undefined;
  vi.clearAllMocks();
  vi.spyOn(logger, 'debug');
  vi.spyOn(logger, 'info');
  vi.spyOn(logger, 'error');
});

afterEach(() => {
  mockServer.resetHandlers();
  mockServer.events.removeAllListeners();
});

describe('the endpoint probe: what it sends', () => {
  it('reports the model count from /models and sends no completion', async () => {
    mockServer.use(
      http.get(MODELS_URL, ({ request }) => {
        endpointRequests.push(request.url);
        return new HttpResponse(JSON.stringify({ data: [{ id: 'qwen3:8b' }, { id: 'llama3:8b' }] }), {
          headers: { 'content-type': 'application/json' },
        });
      }),
      http.post(CHAT_URL, ({ request }) => {
        endpointRequests.push(request.url);
        return new HttpResponse('{}', { headers: { 'content-type': 'application/json' } });
      }),
    );

    const outcome = await runAiProviderTest(PROVIDER, { secrets: secretStore() });

    expect(outcome.ok).toBe(true);
    expect(outcome.ok && outcome.summary).toContain('reported 2 model(s) from "/models"');
    expect(endpointRequests).toHaveLength(1);
    expect(endpointRequests[0]).toContain('/models');
  });

  it('falls back to one minimal completion when /models is missing, and asks for one character', async () => {
    mockServer.use(
      http.get(MODELS_URL, ({ request }) => {
        endpointRequests.push(request.url);
        return new HttpResponse('{"error":{"message":"no such path"}}', {
          status: 404,
          headers: { 'content-type': 'application/json' },
        });
      }),
      http.post(CHAT_URL, async ({ request }) => {
        endpointRequests.push(request.url);
        const body = (await request.json()) as Record<string, unknown>;
        expect(body['model']).toBe('qwen3:8b');
        expect(body['stream']).toBeUndefined();
        for (const forbidden of ['temperature', 'max_tokens', 'response_format', 'tools']) {
          expect(Object.keys(body)).not.toContain(forbidden);
        }
        const messages = body['messages'] as Array<{ role: string; content: string }>;
        expect(messages[0]?.content).toContain('single character');
        return new HttpResponse(JSON.stringify({ choices: [{ message: { content: '1' } }] }), {
          headers: { 'content-type': 'application/json' },
        });
      }),
    );

    const outcome = await runAiProviderTest(PROVIDER, { secrets: secretStore() });

    expect(outcome.ok).toBe(true);
    expect(outcome.ok && outcome.summary).toContain('answered a minimal chat request with "1"');
    expect(endpointRequests).toHaveLength(2);
  });

  it('treats an empty /models list the same way, and reports it as not a failure', async () => {
    mockServer.use(
      http.get(
        MODELS_URL,
        () => new HttpResponse(JSON.stringify({ data: [] }), { headers: { 'content-type': 'application/json' } }),
      ),
      http.post(
        CHAT_URL,
        () =>
          new HttpResponse(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }), {
            headers: { 'content-type': 'application/json' },
          }),
      ),
    );

    const outcome = await runAiProviderTest(PROVIDER, { secrets: secretStore() });

    expect(outcome.ok).toBe(true);
    expect(outcome.ok && outcome.summary).toContain('that is not a failure');
  });

  it('reports an endpoint that has no model list and no declared model without sending a completion', async () => {
    mockServer.use(
      http.get(
        MODELS_URL,
        () => new HttpResponse('{}', { status: 404, headers: { 'content-type': 'application/json' } }),
      ),
      http.post(CHAT_URL, ({ request }) => {
        endpointRequests.push(request.url);
        return new HttpResponse('{}', { headers: { 'content-type': 'application/json' } });
      }),
    );

    const outcome = await runAiProviderTest({ ...PROVIDER, models: [] }, { secrets: secretStore() });

    expect(outcome.ok).toBe(true);
    expect(outcome.ok && outcome.summary).toBe(
      'The endpoint reported no models from "/models" (that is not a failure).',
    );
    expect(endpointRequests).toEqual([]);
  });

  it('carries the model ids the endpoint reported, for a surface that prefills from them', async () => {
    // §8.7 step 2: the model list `/models` answers with is used to prefill the
    // endpoint's own declaration, so the ids have to survive the probe's report.
    mockServer.use(
      http.get(
        MODELS_URL,
        () =>
          new HttpResponse(JSON.stringify({ data: [{ id: 'qwen3:8b' }, { id: 'llama3:8b' }] }), {
            headers: { 'content-type': 'application/json' },
          }),
      ),
    );

    const outcome = await runAiProviderTest(PROVIDER, { secrets: secretStore() });

    expect(outcome.ok && outcome.models).toEqual(['qwen3:8b', 'llama3:8b']);
  });

  it('reports an empty model list rather than nothing when the endpoint has none', async () => {
    mockServer.use(
      http.get(
        MODELS_URL,
        () => new HttpResponse('{}', { status: 404, headers: { 'content-type': 'application/json' } }),
      ),
    );

    const outcome = await runAiProviderTest({ ...PROVIDER, models: [] }, { secrets: secretStore() });

    // "The endpoint reported no models" is an answer, and it is not a failure: a
    // surface must be able to tell it from "no list was read at all".
    expect(outcome.ok && outcome.models).toEqual([]);
  });

  it('carries the api-version query parameter and keeps the header value out of every report', async () => {
    mockServer.use(
      http.get(
        MODELS_URL,
        () =>
          new HttpResponse(JSON.stringify({ data: [{ id: 'qwen3:8b' }] }), {
            headers: { 'content-type': 'application/json' },
          }),
      ),
    );

    const outcome = await runAiProviderTest(PROVIDER, { secrets: secretStore() });

    expect(outcome.ok).toBe(true);
    expect(JSON.stringify(outcome)).not.toContain(HEADER_VALUE);
    expect(JSON.stringify(outcome)).not.toContain(API_KEY);
  });
});

describe('the endpoint probe: what it refuses to send', () => {
  it('fails a file: URL locally, before any request', async () => {
    const outcome = await runAiProviderTest({ ...PROVIDER, baseUrl: 'file:///tmp/v1' }, { secrets: secretStore() });

    expect(outcome).toEqual({ ok: false, ran: false, reason: expect.stringContaining('file:') });
    expect(endpointRequests).toEqual([]);
  });

  it('fails a URL carrying credentials locally', async () => {
    const outcome = await runAiProviderTest(
      { ...PROVIDER, baseUrl: 'https://user:token@models.example.com/v1' },
      { secrets: secretStore() },
    );

    expect(outcome.ok).toBe(false);
    expect(outcome.ok === false && outcome.ran).toBe(false);
    expect(endpointRequests).toEqual([]);
  });

  it('fails a provider with no stored key locally', async () => {
    const outcome = await runAiProviderTest(PROVIDER, { secrets: EMPTY_STORE });

    expect(outcome).toEqual({ ok: false, ran: false, reason: expect.stringContaining('No API key is stored') });
    expect(endpointRequests).toEqual([]);
  });

  it('fails a non-local endpoint under the local-only policy, naming the setting', async () => {
    const outcome = await runAiProviderTest(
      { ...PROVIDER, baseUrl: 'https://models.example.com/v1' },
      { secrets: secretStore(), localOnly: true },
    );

    expect(outcome.ok).toBe(false);
    expect(outcome.ok === false && outcome.reason).toContain('forgejoToolkit.aiLocalOnly');
    expect(outcome.ok === false && outcome.ran).toBe(false);
    expect(endpointRequests).toEqual([]);
  });

  it('renders a rejected credential the way the transport does, and marks the probe as having run', async () => {
    mockServer.use(
      http.get(
        MODELS_URL,
        () =>
          new HttpResponse('{"error":{"message":"bad key"}}', {
            status: 401,
            headers: { 'content-type': 'application/json' },
          }),
      ),
    );

    const outcome = await runAiProviderTest(PROVIDER, { secrets: secretStore() });

    expect(outcome.ok).toBe(false);
    expect(outcome.ok === false && outcome.ran).toBe(true);
    expect(outcome.ok === false && outcome.reason).toContain('rejected the credential (HTTP 401)');
    expect(outcome.ok === false && outcome.reason).not.toContain(API_KEY);
  });

  it('renders a connection failure as a reachability problem', async () => {
    mockServer.use(http.get(MODELS_URL, () => HttpResponse.error()));

    const outcome = await runAiProviderTest(PROVIDER, { secrets: secretStore() });

    expect(outcome.ok).toBe(false);
    expect(outcome.ok === false && outcome.reason).toContain('Could not reach the AI endpoint "Local Gateway"');
  });

  it('fails a 200 completion whose shape has no message', async () => {
    mockServer.use(
      http.get(
        MODELS_URL,
        () => new HttpResponse('{}', { status: 404, headers: { 'content-type': 'application/json' } }),
      ),
      http.post(
        CHAT_URL,
        () => new HttpResponse(JSON.stringify({ id: 'x' }), { headers: { 'content-type': 'application/json' } }),
      ),
    );

    const outcome = await runAiProviderTest(PROVIDER, { secrets: secretStore() });

    expect(outcome.ok).toBe(false);
    expect(outcome.ok === false && outcome.reason).toContain('cannot read');
  });
});

describe('the command', () => {
  beforeEach(() => {
    state.settings = { aiProviders: [PROVIDER] };
  });

  it('runs the probe for the endpoint it was given and reports the address, not the query', async () => {
    mockServer.use(
      http.get(
        MODELS_URL,
        () =>
          new HttpResponse(JSON.stringify({ data: [{ id: 'qwen3:8b' }] }), {
            headers: { 'content-type': 'application/json' },
          }),
      ),
    );

    await aiTestProviderCommand(secretStore(), 'local-gateway');

    expect(vscode.window.showInformationMessage).toHaveBeenCalledTimes(1);
    const [message] = shownMessages();
    expect(message).toContain('AI endpoint "Local Gateway" at http://localhost:11434/v1 answered HTTP 200');
    expect(message).toContain('reported 1 model(s)');
    expect(message).not.toContain('api-version=');
    expect(message).not.toContain(API_KEY);
    expect(message).not.toContain(HEADER_VALUE);
    expectNoSecret(loggedText());
    expect(vscode.window.showErrorMessage).not.toHaveBeenCalled();
  });

  it('says it was not run when the validation fails, and names the endpoint', async () => {
    state.settings = { aiProviders: [{ ...PROVIDER, baseUrl: 'file:///tmp/v1' }] };

    await aiTestProviderCommand(secretStore(), 'local-gateway');

    const [message] = vi.mocked(vscode.window.showErrorMessage).mock.calls.map((call) => String(call[0]));
    expect(message).toContain('was not run');
    expect(message).toContain('Local Gateway');
    expect(endpointRequests).toEqual([]);
  });

  it('refuses an endpoint id that is not configured', async () => {
    await aiTestProviderCommand(secretStore(), 'gone-gateway');

    const [message] = vi.mocked(vscode.window.showErrorMessage).mock.calls.map((call) => String(call[0]));
    expect(message).toContain('No AI endpoint named "gone-gateway" is configured');
    expect(endpointRequests).toEqual([]);
  });

  it('with no configured endpoint says so and sends nothing', async () => {
    state.settings = {};

    await aiTestProviderCommand(secretStore(), undefined);

    const [message] = vi.mocked(vscode.window.showErrorMessage).mock.calls.map((call) => String(call[0]));
    expect(message).toContain('No AI endpoints are configured');
    expect(vscode.window.showQuickPick).not.toHaveBeenCalled();
    expect(endpointRequests).toEqual([]);
  });

  it('asks which endpoint to test, and a dismissed picker sends nothing', async () => {
    state.quickPick = undefined;

    await aiTestProviderCommand(secretStore(), undefined);

    expect(vscode.window.showQuickPick).toHaveBeenCalledTimes(1);
    expect(vscode.window.showErrorMessage).not.toHaveBeenCalled();
    expect(vscode.window.showInformationMessage).not.toHaveBeenCalled();
    expect(endpointRequests).toEqual([]);
    expect(unhandledRequests()).toEqual([]);
  });

  it('tests the endpoint the picker chose', async () => {
    state.quickPick = { label: 'Local Gateway', description: BASE_URL, id: 'local-gateway' };
    mockServer.use(
      http.get(
        MODELS_URL,
        () =>
          new HttpResponse(JSON.stringify({ data: [{ id: 'qwen3:8b' }] }), {
            headers: { 'content-type': 'application/json' },
          }),
      ),
    );

    await aiTestProviderCommand(secretStore(), undefined);

    expect(vscode.window.showInformationMessage).toHaveBeenCalledTimes(1);
  });

  it('registers itself under the contributed command id', () => {
    const context = { subscriptions: [] as unknown[], secrets: secretStore() };
    registerAiTestProviderCommand(context as unknown as vscode.ExtensionContext);

    expect(vscode.commands.registerCommand).toHaveBeenCalledWith(COMMAND_AI_TEST_PROVIDER, expect.any(Function));
    expect(COMMAND_AI_TEST_PROVIDER).toBe('forgejoToolkit.aiTestProvider');
    expect(context.subscriptions).toHaveLength(1);
  });
});
