import { describe, it, expect, vi, beforeEach, afterEach, beforeAll, afterAll } from 'vitest';
import { http, HttpResponse } from 'msw';
import type { AiProviderDraftProbe } from '@cpf23333-forgejo-toolkit/shared/webview/messages';

/**
 * The **draft** model probe (`docs/design/settings-page.md` §4.2–§4.4): the
 * settings page's endpoint editor asking one un-saved endpoint which models it
 * reports.
 *
 * This is the first path in the extension that sends a request without a click,
 * and the record's §8.1 states the cost of it plainly: a user who typed a wrong
 * address and then a credential will send one `GET /models` there. What this file
 * pins is therefore the narrow shape that makes the path acceptable at all:
 *
 * 1. **`GET /models` only.** The minimal completion stays behind the explicit
 *    test-connection button, so the automatic path carries no content.
 * 2. **Local refusals come first, before any byte** — the same three the clicked
 *    probe makes (the global AI switch, the address, the credential).
 * 3. **Nothing is saved.** The typed key and header values are read for that one
 *    request through a read-through overlay: no setting is written, and the secret
 *    store is never touched. The store's `store`/`delete` reject if anything tries.
 * 4. **A 404/405/501 is an answer, not a failure**: plenty of endpoints have no
 *    model list, and the report says the models have to be declared by hand.
 * 5. **No credential in the report**, in the log or in the failure sentence.
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
    state: { focused: true },
    onDidChangeWindowState: vi.fn(() => ({ dispose: vi.fn() })),
  },
  commands: { registerCommand: vi.fn(() => ({ dispose: vi.fn() })), executeCommand: vi.fn() },
  ConfigurationTarget: { Global: 1, Workspace: 2, WorkspaceFolder: 3 },
  env: { language: 'en' },
  l10n: {
    t: vi.fn((message: string, ...args: unknown[]) =>
      message.replace(/\{([^{}]+)\}/g, (placeholder, key: string) => {
        const value = args[Number(key)];
        return value === undefined ? placeholder : String(value);
      }),
    ),
  },
}));

import { mockServer, startMockServer, stopMockServer, unhandledRequests } from '../test/mocks/server';
import { logger } from '../logger';
import { aiProviderDraftTestReport } from '../ai/testProvider';
import { aiProviderHeaderSecretKey, aiProviderKeySecretKey, type AiSecretStore } from '../ai/providerSecrets';

const BASE_URL = 'http://localhost:11434/v1';
const MODELS_URL = `${BASE_URL}/models`;
const CHAT_URL = `${BASE_URL}/chat/completions`;
const TYPED_KEY = 'sk-draft-probe-key-0123456789';
const HEADER_VALUE = 'draft-probe-header-value';

/** The addresses any request this file sends was sent to. */
let endpointRequests: string[] = [];
/** The Authorization header of every request, so "was the typed key used" is checkable. */
let authorizationHeaders: Array<string | null> = [];

/** A store that records every call, so "the probe touched nothing" is assertable. */
function secretStore(): AiSecretStore & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    get: async (key: string) => {
      calls.push(`get:${key}`);
      return undefined;
    },
    store: async (key: string) => {
      calls.push(`store:${key}`);
    },
    delete: async (key: string) => {
      calls.push(`delete:${key}`);
    },
  };
}

function draft(overrides: Partial<AiProviderDraftProbe> = {}): AiProviderDraftProbe {
  return {
    id: 'draft-endpoint',
    name: 'Draft endpoint',
    baseUrl: BASE_URL,
    auth: 'bearer',
    key: TYPED_KEY,
    headers: [],
    ...overrides,
  };
}

/** Everything the logger was handed, so a leak has somewhere to show up. */
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
  authorizationHeaders = [];
  state.settings = {};
  vi.clearAllMocks();
  vi.spyOn(logger, 'debug');
  vi.spyOn(logger, 'info');
  vi.spyOn(logger, 'error');
});

afterEach(() => {
  mockServer.resetHandlers();
  mockServer.events.removeAllListeners();
});

describe('the draft probe: what it asks for', () => {
  it('asks for the model list and never for a completion', async () => {
    mockServer.use(
      http.get(MODELS_URL, ({ request }) => {
        endpointRequests.push(request.url);
        authorizationHeaders.push(request.headers.get('authorization'));
        return new HttpResponse(JSON.stringify({ data: [{ id: 'qwen3:8b' }, { id: 'llama3:8b' }] }), {
          headers: { 'content-type': 'application/json' },
        });
      }),
      http.post(CHAT_URL, ({ request }) => {
        endpointRequests.push(request.url);
        return new HttpResponse('{}', { headers: { 'content-type': 'application/json' } });
      }),
    );

    const report = await aiProviderDraftTestReport(draft(), { secrets: secretStore() });

    expect(report.ok).toBe(true);
    expect(report.models).toEqual(['qwen3:8b', 'llama3:8b']);
    expect(report.summary).toContain('reported 2 model(s)');
    expect(endpointRequests).toHaveLength(1);
    expect(endpointRequests[0]).toContain('/models');
    expect(JSON.stringify(report)).not.toContain(TYPED_KEY);
  });

  it('sends the key typed in the editor, which no setting or secret store holds', async () => {
    mockServer.use(
      http.get(MODELS_URL, ({ request }) => {
        authorizationHeaders.push(request.headers.get('authorization'));
        return new HttpResponse(JSON.stringify({ data: [] }), { headers: { 'content-type': 'application/json' } });
      }),
    );
    const store = secretStore();

    const report = await aiProviderDraftTestReport(draft(), { secrets: store });

    expect(authorizationHeaders).toEqual([`Bearer ${TYPED_KEY}`]);
    expect(report.ok).toBe(true);
    // The store was asked for nothing: the typed key is the credential, and the
    // probe may not read or write one (the record's §4.2 "nothing is saved").
    expect(store.calls).toEqual([]);
  });

  it('sends a typed header value, api-version included as a query parameter', async () => {
    let seenUrl = '';
    let seenVersion: string | null = null;
    mockServer.use(
      http.get(MODELS_URL, ({ request }) => {
        seenUrl = request.url;
        seenVersion = request.headers.get('api-version');
        return new HttpResponse(JSON.stringify({ data: [] }), { headers: { 'content-type': 'application/json' } });
      }),
    );

    await aiProviderDraftTestReport(draft({ headers: [{ name: 'api-version', value: HEADER_VALUE }] }), {
      secrets: secretStore(),
    });

    expect(seenUrl).toContain(`api-version=${HEADER_VALUE}`);
    // It travels as a parameter, not as a header (the transport's own rule).
    expect(seenVersion).toBeNull();
  });

  it('uses a placeholder identity when the typed id cannot be a secret key segment', async () => {
    mockServer.use(
      http.get(MODELS_URL, ({ request }) => {
        authorizationHeaders.push(request.headers.get('authorization'));
        return new HttpResponse(JSON.stringify({ data: [] }), { headers: { 'content-type': 'application/json' } });
      }),
    );

    const report = await aiProviderDraftTestReport(draft({ id: 'not a legal segment' }), { secrets: secretStore() });

    // The credential is what the user just typed and asked to try: a half-typed
    // id must not silently drop it.
    expect(authorizationHeaders).toEqual([`Bearer ${TYPED_KEY}`]);
    expect(report.ok).toBe(true);
  });

  it('needs no key at all for an endpoint that sends no credential', async () => {
    mockServer.use(
      http.get(MODELS_URL, ({ request }) => {
        authorizationHeaders.push(request.headers.get('authorization'));
        return new HttpResponse(JSON.stringify({ data: [] }), { headers: { 'content-type': 'application/json' } });
      }),
    );

    const report = await aiProviderDraftTestReport(draft({ auth: 'none', key: '' }), { secrets: secretStore() });

    expect(report.ok).toBe(true);
    expect(authorizationHeaders).toEqual([null]);
  });

  it('names the draft in the report, falling back to the id and then the address', async () => {
    mockServer.use(
      http.get(
        MODELS_URL,
        () => new HttpResponse(JSON.stringify({ data: [] }), { headers: { 'content-type': 'application/json' } }),
      ),
    );

    expect((await aiProviderDraftTestReport(draft(), { secrets: secretStore() })).providerName).toBe('Draft endpoint');
    expect((await aiProviderDraftTestReport(draft({ name: '' }), { secrets: secretStore() })).providerName).toBe(
      'draft-endpoint',
    );
    expect(
      (await aiProviderDraftTestReport(draft({ name: '', id: '' }), { secrets: secretStore() })).providerName,
    ).toBe('localhost:11434');
  });
});

describe('the draft probe: what it refuses to send', () => {
  it('refuses an unusable address locally, before any request', async () => {
    const report = await aiProviderDraftTestReport(draft({ baseUrl: 'file:///tmp/v1' }), {
      secrets: secretStore(),
    });

    expect(report.ok).toBe(false);
    expect(report.ran).toBe(false);
    expect(report.reason).toContain('file:');
    expect(endpointRequests).toEqual([]);
    expect(unhandledRequests()).toEqual([]);
  });

  it('refuses locally, without a byte, while the global AI switch is off', async () => {
    // The automatic path must not be the one that keeps presenting a typed
    // credential to an endpoint after the user said not to use AI at all.
    state.settings['aiEnabled'] = false;

    const report = await aiProviderDraftTestReport(draft({ baseUrl: 'https://models.example.com/v1' }), {
      secrets: secretStore(),
    });

    expect(report.ok).toBe(false);
    expect(report.ran).toBe(false);
    expect(report.reason).toContain('forgejoToolkit.aiEnabled');
    expect(endpointRequests).toEqual([]);
    expect(unhandledRequests()).toEqual([]);
  });

  it('refuses a credential-less draft locally when the auth style needs one', async () => {
    const report = await aiProviderDraftTestReport(draft({ key: '' }), { secrets: secretStore() });

    expect(report.ok).toBe(false);
    expect(report.ran).toBe(false);
    expect(report.reason).toContain('No API key is stored');
    expect(endpointRequests).toEqual([]);
  });
});

describe('the draft probe: an endpoint without a model list', () => {
  it('reads a 404 as "declare the models by hand", not as a failure', async () => {
    mockServer.use(
      http.get(
        MODELS_URL,
        () =>
          new HttpResponse('{"error":{"message":"no such path"}}', {
            status: 404,
            headers: { 'content-type': 'application/json' },
          }),
      ),
      http.post(CHAT_URL, ({ request }) => {
        endpointRequests.push(request.url);
        return new HttpResponse('{}', { headers: { 'content-type': 'application/json' } });
      }),
    );

    const report = await aiProviderDraftTestReport(draft(), { secrets: secretStore() });

    expect(report.ok).toBe(true);
    expect(report.ran).toBe(true);
    expect(report.status).toBe(404);
    expect(report.models).toEqual([]);
    expect(report.summary).toContain('have to be declared by hand');
    // The completion is the explicit test's; the automatic path never sends one.
    expect(endpointRequests).toEqual([]);
  });

  it('reports an empty model list as an answer, not as a failure', async () => {
    mockServer.use(
      http.get(
        MODELS_URL,
        () => new HttpResponse(JSON.stringify({ data: [] }), { headers: { 'content-type': 'application/json' } }),
      ),
    );

    const report = await aiProviderDraftTestReport(draft(), { secrets: secretStore() });

    expect(report.ok).toBe(true);
    expect(report.models).toEqual([]);
    expect(report.summary).toContain('that is not a failure');
  });

  it('renders a real failure the way the transport does, without blocking anything', async () => {
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

    const report = await aiProviderDraftTestReport(draft(), { secrets: secretStore() });

    expect(report.ok).toBe(false);
    expect(report.ran).toBe(true);
    expect(report.reason).toContain('rejected the credential (HTTP 401)');
    expect(report.reason).not.toContain(TYPED_KEY);
    expect(report.address).toBe(BASE_URL);
    expect(loggedText().join('\n')).not.toContain(TYPED_KEY);
  });

  it('never puts a header value into the report or the log', async () => {
    mockServer.use(
      http.get(
        MODELS_URL,
        () =>
          new HttpResponse(JSON.stringify({ data: [{ id: 'qwen3:8b' }] }), {
            headers: { 'content-type': 'application/json' },
          }),
      ),
    );

    const report = await aiProviderDraftTestReport(draft({ headers: [{ name: 'x-api-token', value: HEADER_VALUE }] }), {
      secrets: secretStore(),
    });

    expect(JSON.stringify(report)).not.toContain(HEADER_VALUE);
    expect(loggedText().join('\n')).not.toContain(HEADER_VALUE);
  });
});

describe('the draft probe against a read-through secret store', () => {
  it('falls back to the stored value only for a header the draft did not type', async () => {
    // The overlay is a read-through store, not a copy: an endpoint being edited
    // may already have a stored header value, and the probe may use it.
    const stored: Record<string, string> = {
      [aiProviderHeaderSecretKey('draft-endpoint', 'x-team') ?? '']: 'stored-team-value',
      [aiProviderKeySecretKey('draft-endpoint')]: 'stored-key-value',
    };
    const base: AiSecretStore = {
      get: async (key: string) => stored[key],
      store: async () => undefined,
      delete: async () => undefined,
    };
    let teamHeader: string | null = null;
    mockServer.use(
      http.get(MODELS_URL, ({ request }) => {
        teamHeader = request.headers.get('x-team');
        return new HttpResponse(JSON.stringify({ data: [] }), { headers: { 'content-type': 'application/json' } });
      }),
    );

    await aiProviderDraftTestReport(draft({ headers: [{ name: 'x-team', value: '' }] }), { secrets: base });

    expect(teamHeader).toBe('stored-team-value');
  });
});
