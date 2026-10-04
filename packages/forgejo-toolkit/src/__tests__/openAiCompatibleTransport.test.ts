import { describe, it, expect, vi, beforeEach, afterEach, beforeAll, afterAll } from 'vitest';
import { http, HttpResponse } from 'msw';

/**
 * The OpenAI-compatible transport: `src/ai/openAiCompatibleTransport.ts`
 * (`docs/design/ai-model-transport.md` §6) and every item §11.2 requires it to
 * prove.
 *
 * The carrier is `msw/node`, the suite's existing in-process interceptor, and that
 * was a **measurement** rather than an assumption: the record's §13 question 2
 * calls SSE the design's largest unknown, and a probe of the installed
 * `msw` 2.15 showed a `ReadableStream` body arriving in genuinely separate chunks
 * (four writes 60 ms apart were observed at 72 / 134 / 195 / 257 ms, so nothing
 * buffered the stream). The SSE cases below depend on that: the idle-watchdog case
 * needs a body that really stops mid-stream, and the "long answer" case needs
 * chunks to keep arriving across several windows.
 *
 * What this suite is careful about, because the record is:
 *
 * - **The request is exactly the three fields §6.3 allows.** The captured body is
 *   asserted field by field, including the fields that must *not* be there.
 * - **The two candidate streams never touch.** A response carrying both channels
 *   has to come back as two candidates with their own bytes.
 * - **No secret reaches a log line or a message.** One key and one custom header
 *   value are seeded into the secret store, and every assertion about an error
 *   path ends with a scan of everything the logger was handed.
 * - **The watchdog is an idle window, not a total cap.** The long-answer case runs
 *   for longer than the window and must survive; the stalling case must not.
 */

const state = vi.hoisted(() => ({
  /** Configuration values, keyed by the setting name without its section. */
  settings: {} as Record<string, unknown>,
}));

vi.mock('vscode', () => ({
  window: {
    showErrorMessage: vi.fn(),
    showInformationMessage: vi.fn(),
    showWarningMessage: vi.fn(),
    showQuickPick: vi.fn(),
    showInputBox: vi.fn(),
    withProgress: vi.fn(async (_options: unknown, task: (progress: unknown, token: unknown) => unknown) =>
      task({ report: vi.fn() }, { isCancellationRequested: false, onCancellationRequested: vi.fn() }),
    ),
    createOutputChannel: vi.fn(() => ({ appendLine: vi.fn(), show: vi.fn(), dispose: vi.fn() })),
    activeTextEditor: undefined,
    visibleTextEditors: [],
    state: { focused: true },
    onDidChangeActiveTextEditor: vi.fn(() => ({ dispose: vi.fn() })),
    onDidChangeWindowState: vi.fn(() => ({ dispose: vi.fn() })),
  },
  workspace: {
    getConfiguration: vi.fn(() => ({
      get: vi.fn((key: string, fallback?: unknown) => (key in state.settings ? state.settings[key] : fallback)),
      update: vi.fn(),
      has: vi.fn(() => false),
      inspect: vi.fn(),
    })),
    onDidChangeConfiguration: vi.fn(() => ({ dispose: vi.fn() })),
    onDidChangeWorkspaceFolders: vi.fn(() => ({ dispose: vi.fn() })),
    workspaceFolders: [],
    textDocuments: [],
  },
  commands: { executeCommand: vi.fn(), registerCommand: vi.fn(() => ({ dispose: vi.fn() })) },
  ConfigurationTarget: { Global: 1, Workspace: 2, WorkspaceFolder: 3 },
  Uri: {
    file: vi.fn((fsPath: string) => ({ fsPath, scheme: 'file' })),
    parse: vi.fn((value: string) => ({ fsPath: value, scheme: value.split(':')[0] ?? '', toString: () => value })),
    joinPath: vi.fn((...args: unknown[]) => ({ fsPath: args.join('/'), scheme: 'file' })),
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
}));

import { mockServer, startMockServer, stopMockServer } from '../test/mocks/server';
import { logger } from '../logger';
import {
  CHAT_COMPLETIONS_PATH,
  OpenAiCompatibleTransport,
  openAiEndpointDisplayUrl,
  openAiEndpointFailure,
  openAiEndpointUrl,
  openAiRequestAuth,
} from '../ai/openAiCompatibleTransport';
import type { AiCompletionRequest, AiModelInfo } from '../ai/transport';
import type { AiProviderConfig } from '../ai/modelSettings';
import { aiProviderHeaderSecretKey, aiProviderKeySecretKey, type AiSecretStore } from '../ai/providerSecrets';

const BASE_URL = 'http://localhost:11434/v1';
const CHAT_URL = `${BASE_URL}/chat/completions`;

/** The one credential every case seeds, so a leak has exactly one spelling to look for. */
const API_KEY = 'sk-test-key-do-not-log-0123456789';
/** The custom header's value, protected like the key (§8.2). */
const HEADER_VALUE = 'test-api-version-value-do-not-log';

const MODEL: AiModelInfo = { vendor: 'local-gateway', id: 'qwen3:8b', name: 'Qwen3 8B' };

/** One recording secret store, with the two entries a configured endpoint needs. */
function secretStore(): AiSecretStore & { values: Record<string, string> } {
  const values: Record<string, string> = {
    [aiProviderKeySecretKey('local-gateway')]: API_KEY,
    [aiProviderHeaderSecretKey('local-gateway', 'api-version') ?? '']: HEADER_VALUE,
  };
  return {
    values,
    get: async (key: string) => values[key],
    store: async (key: string, value: string) => {
      values[key] = value;
    },
    delete: async (key: string) => {
      delete values[key];
    },
  };
}

/** One provider in the shape the settings reader produces. */
function provider(overrides: Partial<AiProviderConfig> = {}): AiProviderConfig {
  return {
    id: 'local-gateway',
    name: 'Local Gateway',
    baseUrl: BASE_URL,
    models: [{ id: 'qwen3:8b', name: 'Qwen3 8B' }],
    auth: 'bearer',
    headers: [{ name: 'api-version', valueSecret: true }],
    localOnly: false,
    ...overrides,
  };
}

function transport(
  overrides: Partial<AiProviderConfig> = {},
  options: { localOnly?: boolean; requestTimeoutMs?: number; secrets?: AiSecretStore } = {},
): OpenAiCompatibleTransport {
  return new OpenAiCompatibleTransport({
    provider: provider(overrides),
    secrets: options.secrets ?? secretStore(),
    localOnly: options.localOnly,
    requestTimeoutMs: options.requestTimeoutMs,
    // No proxy is installed in this suite; the pair is read from the module that
    // activation installs, so the test exercises the production path.
  });
}

function request(overrides: Partial<AiCompletionRequest> = {}): AiCompletionRequest {
  return {
    system: 'the instructions',
    messages: [{ role: 'user', text: 'the request' }],
    purpose: 'why this request is being made',
    ...overrides,
  };
}

/** One `data:` chunk with a choice delta. */
function sseDelta(delta: Record<string, unknown>, extra: Record<string, unknown> = {}): string {
  return `data: ${JSON.stringify({ choices: [{ index: 0, delta, ...extra }] })}\n\n`;
}

/** The `[DONE]` terminator. */
const SSE_DONE = 'data: [DONE]\n\n';

interface Write {
  text: string;
  delayMs?: number;
}

/**
 * A streaming SSE response.
 *
 * `close: false` leaves the body open on purpose: that is the stalling endpoint the
 * idle watchdog and the total cap exist for, and it is the only way to reach those
 * arms from a test.
 */
function sseResponse(options: { writes: Write[]; done?: boolean; close?: boolean }): Response {
  const encoder = new TextEncoder();
  const close = options.close ?? true;
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      for (const write of options.writes) {
        if (write.delayMs) {
          await new Promise((resolve) => setTimeout(resolve, write.delayMs));
        }
        try {
          controller.enqueue(encoder.encode(write.text));
        } catch {
          // The client went away (an abort, or the watchdog): stop writing.
          return;
        }
      }
      if (options.done ?? true) {
        try {
          controller.enqueue(encoder.encode(SSE_DONE));
        } catch {
          return;
        }
      }
      if (close) {
        try {
          controller.close();
        } catch {
          // Already closed or cancelled.
        }
      }
    },
  });
  return new HttpResponse(stream, { headers: { 'content-type': 'text/event-stream' } });
}

/** Every captured request, so a case can assert on the wire shape. */
interface CapturedRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: Record<string, unknown> | undefined;
}

let captured: CapturedRequest[] = [];

/** Registers the one handler every case needs, capturing the request as it arrives. */
function captureRequest(response: () => Response | Promise<Response>): void {
  mockServer.use(
    http.post(CHAT_URL, async ({ request: incoming }) => {
      const headers: Record<string, string> = {};
      incoming.headers.forEach((value, name) => {
        headers[name.toLowerCase()] = value;
      });
      let body: Record<string, unknown> | undefined;
      try {
        body = (await incoming.json()) as Record<string, unknown>;
      } catch {
        body = undefined;
      }
      captured.push({ url: incoming.url, method: incoming.method, headers, body });
      return await response();
    }),
  );
}

/** The `chat/completions` request the last case made. */
function lastRequest(): CapturedRequest {
  const entry = captured[captured.length - 1];
  if (entry === undefined) {
    throw new Error('no request reached the endpoint');
  }
  return entry;
}

/**
 * Awaits a call that is expected to fail and hands the failure back as an `Error`.
 *
 * `.catch((error: unknown) => error as Error)` reads the same but types the result
 * as `AiCompletionResult | Error`, which forces every assertion on the message
 * through a cast. This keeps the narrowing honest: a call that **resolves** is a
 * test failure, not a silently passing case.
 */
async function failed(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (error) {
    return error as Error;
  }
  throw new Error('the call was expected to fail, but it resolved');
}

/** Everything the logger was handed, so a case can scan it for a secret. */
function loggedText(): string[] {
  return [logger.debug, logger.info, logger.error].flatMap((method) =>
    vi.mocked(method).mock.calls.map((call) => String(call[0])),
  );
}

/** Asserts that neither credential appears in any log line. */
function expectNoSecretInLogs(): void {
  for (const line of loggedText()) {
    expect(line).not.toContain(API_KEY);
    expect(line).not.toContain(HEADER_VALUE);
  }
}

/** Turns the debug gate on for one case. */
function debugging(): void {
  vi.mocked(logger.isDebugEnabled).mockReturnValue(true);
}

beforeAll(async () => {
  await startMockServer();
});

afterAll(() => {
  stopMockServer();
});

beforeEach(() => {
  captured = [];
  state.settings = {};
  vi.clearAllMocks();
  vi.spyOn(logger, 'debug');
  vi.spyOn(logger, 'info');
  vi.spyOn(logger, 'error');
  vi.spyOn(logger, 'isDebugEnabled').mockReturnValue(false);
});

afterEach(() => {
  mockServer.resetHandlers();
  mockServer.events.removeAllListeners();
});

describe('the OpenAI-compatible transport: the wire shape', () => {
  it('sends exactly the three fields the record allows, with the system block first', async () => {
    captureRequest(() => sseResponse({ writes: [{ text: sseDelta({ content: '{}' }) }] }));

    await transport().complete(MODEL, request({ messages: [{ role: 'user', text: 'the request' }] }));

    const sent = lastRequest();
    expect(sent.method).toBe('POST');
    // The path is the base URL with the one documented path appended; the query
    // carries the `api-version` this fixture stores, and nothing else (§6.2).
    expect(new URL(sent.url).pathname).toBe('/v1/chat/completions');
    expect(new URL(sent.url).searchParams.get('api-version')).toBe(HEADER_VALUE);
    expect([...new URL(sent.url).searchParams.keys()]).toEqual(['api-version']);
    expect(sent.body).toEqual({
      model: 'qwen3:8b',
      messages: [
        { role: 'system', content: 'the instructions' },
        { role: 'user', content: 'the request' },
      ],
      stream: true,
    });
    // Named one by one because each is a deliberate decision (§6.3): every one of
    // them has an endpoint-specific default, and sending one would be a bet.
    for (const forbidden of ['temperature', 'top_p', 'max_tokens', 'response_format', 'tools', 'stream_options']) {
      expect(Object.keys(sent.body ?? {})).not.toContain(forbidden);
    }
    expect(sent.headers['accept']).toBe('text/event-stream');
    expect(sent.headers['content-type']).toBe('application/json');
  });

  it('uses the base URL as given, appending neither /v1 nor a second slash', async () => {
    captureRequest(() => sseResponse({ writes: [] }));

    await transport({ baseUrl: `${BASE_URL}/`, headers: [] }).complete(MODEL, request());

    expect(lastRequest().url).toBe(CHAT_URL);
    expect(openAiEndpointUrl(BASE_URL, CHAT_COMPLETIONS_PATH)).toBe(CHAT_URL);
    expect(openAiEndpointUrl(`${BASE_URL}//`, CHAT_COMPLETIONS_PATH)).toBe(CHAT_URL);
    // The base URL is used as it was written; only the trailing slash goes.
    expect(openAiEndpointUrl('https://models.example.com/openai/v1', CHAT_COMPLETIONS_PATH)).toBe(
      'https://models.example.com/openai/v1/chat/completions',
    );
  });

  it('sends the API key as the bearer credential, and never as a logged value', async () => {
    captureRequest(() => sseResponse({ writes: [] }));
    debugging();

    await transport().complete(MODEL, request());

    expect(lastRequest().headers['authorization']).toBe(`Bearer ${API_KEY}`);
    expectNoSecretInLogs();
  });

  it('sends the api-key header style for Azure, and no Authorization header', async () => {
    captureRequest(() => sseResponse({ writes: [] }));

    await transport({ auth: 'api-key-header', headers: [] }).complete(MODEL, request());

    const sent = lastRequest();
    expect(sent.headers['api-key']).toBe(API_KEY);
    expect(sent.headers['authorization']).toBeUndefined();
  });

  it('sends no credential at all when the auth style is none', async () => {
    captureRequest(() => sseResponse({ writes: [] }));

    await transport({ auth: 'none', headers: [] }).complete(MODEL, request());

    expect(lastRequest().headers['authorization']).toBeUndefined();
    expect(lastRequest().headers['api-key']).toBeUndefined();
  });

  it('carries a custom header value from the secret store, and api-version as a query parameter', async () => {
    captureRequest(() => sseResponse({ writes: [] }));
    const secrets = secretStore();
    secrets.values[aiProviderHeaderSecretKey('local-gateway', 'x-tenant') ?? ''] = HEADER_VALUE;

    await transport(
      {
        headers: [
          { name: 'api-version', valueSecret: true },
          { name: 'x-tenant', valueSecret: true },
        ],
      },
      { secrets },
    ).complete(MODEL, request());

    const sent = lastRequest();
    expect(sent.headers['x-tenant']).toBe(HEADER_VALUE);
    // §6.1/§6.2: Azure's `api-version` is a **query parameter**, so it must not also
    // be a header, and it must not appear in the display URL a log line uses.
    expect(sent.headers['api-version']).toBeUndefined();
    expect(sent.url).toContain('api-version=');
    expect(openAiEndpointDisplayUrl(sent.url)).toBe(CHAT_URL);
  });

  it('lets the auth style win over a declared header it owns, and says so without the value', async () => {
    captureRequest(() => sseResponse({ writes: [] }));

    const secrets = secretStore();
    secrets.values[aiProviderHeaderSecretKey('local-gateway', 'Authorization') ?? ''] = 'Bearer from-a-header';
    const auth = await openAiRequestAuth(
      provider({ headers: [{ name: 'Authorization', valueSecret: true }] }),
      secrets,
    );

    expect(auth.shadowed).toEqual(['Authorization']);
    expect(auth.headers['Authorization']).toBe(`Bearer ${API_KEY}`);
    expect(JSON.stringify(auth)).not.toContain('Bearer from-a-header');
  });

  it('accepts a model the provider does not declare, because the declaration is not a whitelist', async () => {
    captureRequest(() => sseResponse({ writes: [] }));

    await transport().complete({ vendor: 'local-gateway', id: 'hand-typed-model', name: 'Hand typed' }, request());

    expect(lastRequest().body?.['model']).toBe('hand-typed-model');
  });

  it('refuses a model that belongs to another provider instead of sending it here', async () => {
    captureRequest(() => sseResponse({ writes: [] }));

    const failure = await failed(
      transport().complete({ vendor: 'other-provider', id: 'qwen3:8b', name: 'Elsewhere' }, request()),
    );

    expect(failure.message).toContain('cannot use the model');
    expect(captured).toHaveLength(0);
  });

  it('lists the provider declaration without sending anything', async () => {
    const listed = await transport().listModels();

    expect(listed).toEqual([{ vendor: 'local-gateway', id: 'qwen3:8b', name: 'Qwen3 8B' }]);
    expect(captured).toHaveLength(0);
    expect(await transport().countTokens()).toBeUndefined();
  });
});

describe('the OpenAI-compatible transport: the streaming answer', () => {
  it('joins the data blocks in order and stops at [DONE]', async () => {
    captureRequest(() =>
      sseResponse({
        // The terminator is spelled out here rather than appended by the helper, so
        // this case can prove that what arrives **after** it is never read.
        done: false,
        writes: [
          { text: sseDelta({ content: '{"com' }) },
          { text: ': a comment line to ignore\n\n' },
          { text: sseDelta({ content: 'ments":' }) },
          { text: '\n' },
          { text: sseDelta({ content: '[]}' }) },
          { text: SSE_DONE },
          { text: sseDelta({ content: 'IGNORED' }) },
        ],
      }),
    );

    const result = await transport().complete(MODEL, request());

    expect(result.parts).toEqual([{ kind: 'text', text: '{"comments":[]}' }]);
    expect(result.fragments).toEqual(['{"com', 'ments":', '[]}']);
    expect(result.model).toBe(MODEL);
    expect(result.truncated).toBe(false);
  });

  it('skips a data line that is not JSON, counts it, and still answers', async () => {
    captureRequest(() =>
      sseResponse({
        writes: [{ text: 'data: {this is not json\n\n' }, { text: sseDelta({ content: 'the answer' }) }],
      }),
    );
    debugging();

    const result = await transport().complete(MODEL, request());

    expect(result.parts).toEqual([{ kind: 'text', text: 'the answer' }]);
    expect(loggedText().join('\n')).toContain('skipped 1 data line(s) that did not parse as JSON');
  });

  it('reads a complete JSON body as the text candidate when the endpoint ignores stream:true', async () => {
    captureRequest(
      () =>
        new HttpResponse(
          JSON.stringify({
            choices: [{ index: 0, message: { role: 'assistant', content: '{"comments":[]}' }, finish_reason: 'stop' }],
          }),
          { headers: { 'content-type': 'application/json' } },
        ),
    );

    const result = await transport().complete(MODEL, request());

    expect(result.parts).toEqual([{ kind: 'text', text: '{"comments":[]}' }]);
    expect(result.truncated).toBe(false);
  });

  it('reads a single data line with no trailing newline', async () => {
    captureRequest(() =>
      sseResponse({
        writes: [{ text: `data: ${JSON.stringify({ choices: [{ delta: { content: 'one' } }] })}` }],
        done: false,
      }),
    );

    const result = await transport().complete(MODEL, request());

    expect(result.parts).toEqual([{ kind: 'text', text: 'one' }]);
  });

  it('keeps the reasoning channel separate from the text channel', async () => {
    captureRequest(() =>
      sseResponse({
        writes: [
          { text: sseDelta({ reasoning_content: 'thinking about it. ' }) },
          { text: sseDelta({ reasoning: 'still thinking.' }) },
          { text: sseDelta({ content: '{"comments":[]}' }) },
        ],
      }),
    );

    const result = await transport().complete(MODEL, request());

    expect(result.parts).toEqual([
      { kind: 'text', text: '{"comments":[]}' },
      { kind: 'reasoning', text: 'thinking about it. still thinking.' },
    ]);
    // The two candidates are never concatenated, and the reasoning text is not
    // inside the text candidate's bytes (§6.4 item 4).
    expect(result.parts[0]?.text).not.toContain('thinking');
    expect(result.fragments).toEqual(['{"comments":[]}']);
  });

  it('returns only the reasoning candidate when the endpoint sent no text at all', async () => {
    captureRequest(() => sseResponse({ writes: [{ text: sseDelta({ reasoning_content: 'only reasoning' }) }] }));

    const result = await transport().complete(MODEL, request());

    expect(result.parts).toEqual([{ kind: 'reasoning', text: 'only reasoning' }]);
  });

  it('reports finish_reason=length as a truncated answer', async () => {
    captureRequest(() =>
      sseResponse({
        writes: [
          { text: sseDelta({ content: '{"comments":[{"body":"a very long' }) },
          { text: sseDelta({}, { finish_reason: 'length' }) },
        ],
      }),
    );

    const result = await transport().complete(MODEL, request());

    expect(result.truncated).toBe(true);
    expect(result.parts).toEqual([{ kind: 'text', text: '{"comments":[{"body":"a very long' }]);
    expect(loggedText().join('\n')).toContain('finish_reason=length');
  });

  it('answers with an empty text candidate when the endpoint streamed nothing', async () => {
    captureRequest(() => sseResponse({ writes: [] }));

    const result = await transport().complete(MODEL, request());

    expect(result.parts).toEqual([{ kind: 'text', text: '' }]);
    expect(result.fragments).toBeUndefined();
  });

  it('reports an error object the endpoint sent in place of an answer', async () => {
    captureRequest(() =>
      sseResponse({ writes: [{ text: `data: ${JSON.stringify({ error: { message: 'model not loaded' } })}\n\n` }] }),
    );

    const failure = await failed(transport().complete(MODEL, request()));

    expect(failure.message).toContain('reported an error instead of an answer');
    expect(failure.message).toContain('model not loaded');
  });

  it('reports a response body that is neither SSE nor readable JSON, without quoting it', async () => {
    captureRequest(() => new HttpResponse('<html>a proxy page</html>', { headers: { 'content-type': 'text/html' } }));

    const failure = await failed(transport().complete(MODEL, request()));

    expect(failure.message).toContain('cannot read');
    expect(failure.message).not.toContain('proxy page');
  });

  it('reports a JSON body with no choices', async () => {
    captureRequest(
      () =>
        new HttpResponse(JSON.stringify({ id: 'x', object: 'chat.completion' }), {
          headers: { 'content-type': 'application/json' },
        }),
    );

    const failure = await failed(transport().complete(MODEL, request()));

    expect(failure.message).toContain('JSON: object with no choices');
  });
});

describe('the OpenAI-compatible transport: cancellation and the idle watchdog', () => {
  it('throws a cancellation when the signal is already aborted, and sends nothing', async () => {
    captureRequest(() => sseResponse({ writes: [] }));
    const controller = new AbortController();
    controller.abort();

    const failure = await failed(transport().complete(MODEL, request({ signal: controller.signal })));

    expect(failure.name).toBe('AbortError');
    expect(captured).toHaveLength(0);
  });

  it('stops mid-stream on abort, hands back no answer, and writes nothing', async () => {
    let writes = 0;
    const encoder = new TextEncoder();
    mockServer.use(
      http.post(CHAT_URL, () => {
        const stream = new ReadableStream<Uint8Array>({
          async start(streamController) {
            // The first chunk goes out immediately; the second only after a pause
            // the caller's abort has to cut short.
            try {
              streamController.enqueue(encoder.encode(sseDelta({ content: 'half an answer' })));
            } catch {
              return;
            }
            writes += 1;
            await new Promise((resolve) => setTimeout(resolve, 300));
            try {
              streamController.enqueue(encoder.encode(sseDelta({ content: 'never seen' })));
              writes += 1;
              streamController.close();
            } catch {
              // Cancelled by the client: nothing more is written.
            }
          },
        });
        return new HttpResponse(stream, { headers: { 'content-type': 'text/event-stream' } });
      }),
    );

    const controller = new AbortController();
    const pending = transport().complete(MODEL, request({ signal: controller.signal }));
    // Wait for the first chunk to have been read before aborting, so the case is
    // about stopping **mid-stream** rather than about a request that never started.
    for (let attempt = 0; attempt < 200 && writes === 0; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect(writes).toBe(1);
    controller.abort();
    const failure = await failed(pending);

    // A cancellation is an `AbortError` by name, the shape the feature reads, and it
    // is **not** an answer: there is no partial candidate a caller could write.
    expect(failure.name).toBe('AbortError');
    expect(failure).not.toHaveProperty('parts');
    expect(writes).toBe(1);
  });

  it('aborts an endpoint that stops sending data, and says which window expired', async () => {
    captureRequest(() =>
      sseResponse({ writes: [{ text: sseDelta({ content: 'the start' }) }], done: false, close: false }),
    );

    const started = Date.now();
    const failure = await failed(transport({}, { requestTimeoutMs: 200 }).complete(MODEL, request()));

    expect(failure.message).toContain('stopped sending data');
    expect(failure.message).toContain('1 second(s)');
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it('lets a long answer finish, because the window is idle time and not a total cap', async () => {
    // Twelve chunks 40 ms apart take far longer than the 200 ms window and far
    // longer than the 1 s the record's total cap would have been at 30 s/10 — the
    // case the whole setting exists for (§8.6).
    const writes: Write[] = [];
    for (let index = 0; index < 12; index += 1) {
      writes.push({ text: sseDelta({ content: `part${index} ` }), delayMs: index === 0 ? 0 : 40 });
    }
    captureRequest(() => sseResponse({ writes }));

    const started = Date.now();
    const result = await transport({}, { requestTimeoutMs: 200 }).complete(MODEL, request());
    const elapsed = Date.now() - started;

    expect(elapsed).toBeGreaterThan(200);
    expect(result.parts).toEqual([{ kind: 'text', text: writes.map((_, index) => `part${index} `).join('') }]);
    expect(result.fragments).toHaveLength(12);
  });

  it('stops a stream that dribbles forever at the wider total cap', async () => {
    const writes: Write[] = [];
    // Well past the 1.2 s total cap (a 120 ms idle window × 10); the idle window
    // alone would never fire, because a byte keeps arriving.
    for (let index = 0; index < 80; index += 1) {
      writes.push({ text: sseDelta({ content: `${index} ` }), delayMs: 50 });
    }
    captureRequest(() => sseResponse({ writes, done: false, close: false }));

    const started = Date.now();
    const failure = await failed(transport({}, { requestTimeoutMs: 120 }).complete(MODEL, request()));

    expect(failure.message).toContain('still streaming after');
    expect(Date.now() - started).toBeLessThan(5_000);
  });
});

describe('the OpenAI-compatible transport: the error surface', () => {
  const rows: Array<{ status: number; body: string; contentType?: string; expect: string }> = [
    { status: 401, body: '{"error":{"message":"bad key"}}', expect: 'rejected the credential (HTTP 401)' },
    { status: 403, body: '{"error":{"message":"forbidden"}}', expect: 'rejected the credential (HTTP 403)' },
    { status: 404, body: '{"error":{"message":"no such path"}}', expect: 'no chat-completions path' },
    { status: 429, body: '{"error":{"message":"slow down"}}', expect: 'rate limiting the request (HTTP 429)' },
    { status: 500, body: '{"error":{"message":"the model is overloaded"}}', expect: 'the model is overloaded' },
    { status: 503, body: '{"error":{"message":"no capacity right now"}}', expect: 'no capacity right now' },
  ];

  for (const row of rows) {
    it(`renders HTTP ${row.status} as the endpoint's own error, without the key`, async () => {
      captureRequest(
        () =>
          new HttpResponse(row.body, {
            status: row.status,
            headers: { 'content-type': row.contentType ?? 'application/json' },
          }),
      );
      debugging();

      const failure = await failed(transport().complete(MODEL, request()));

      expect(failure.message).toContain(row.expect);
      // The message never blames Forgejo (§6.5) and never carries a credential.
      expect(failure.message).not.toContain('Forgejo API error');
      expect(failure.message).not.toContain(API_KEY);
      expect(failure.message).not.toContain(HEADER_VALUE);
      if (row.status === 404) {
        expect(failure.message).toContain('/v1');
      }
      expectNoSecretInLogs();
    });
  }

  it('renders a connection failure as a reachability problem naming the endpoint', async () => {
    captureRequest(() => HttpResponse.error());
    debugging();

    const failure = await failed(transport().complete(MODEL, request()));

    expect(failure.message).toContain('Could not reach the AI endpoint "Local Gateway"');
    expect(failure.message).toContain(CHAT_URL);
    expect(failure.message).not.toContain('Forgejo API error');
    expectNoSecretInLogs();
  });

  it('adds the proxy sentence only when a proxy is installed', () => {
    const error = new Error('fetch failed');
    const withProxy = openAiEndpointFailure(error, {
      provider: provider(),
      endpoint: CHAT_URL,
      viaProxy: true,
    });
    const withoutProxy = openAiEndpointFailure(error, {
      provider: provider(),
      endpoint: CHAT_URL,
      viaProxy: false,
    });

    expect(withProxy.message).toContain('check the proxy setting');
    expect(withoutProxy.message).not.toContain('check the proxy setting');
  });

  it('never quotes a raw body on a 5xx, only a bounded excerpt', async () => {
    captureRequest(
      () =>
        new HttpResponse(`{"error":{"message":"${'x'.repeat(5_000)}"}}`, {
          status: 500,
          headers: { 'content-type': 'application/json' },
        }),
    );

    const failure = await failed(transport().complete(MODEL, request()));

    expect(failure.message.length).toBeLessThan(400);
  });
});

describe('the OpenAI-compatible transport: availability and the base URL rules', () => {
  it('reports a URL whose scheme is not http(s) as unusable, naming the scheme', async () => {
    const availability = await transport({ baseUrl: 'file:///tmp/models/v1' }).availability();

    expect(availability.usable).toBe(false);
    expect(availability.usable === false ? availability.reason : '').toContain('file:');
  });

  it('refuses a URL that carries credentials', async () => {
    const availability = await transport({ baseUrl: 'https://user:token@models.example.com/v1' }).availability();

    expect(availability.usable).toBe(false);
    expect(availability.usable === false ? availability.reason : '').toContain('credentials in the URL');
  });

  it('refuses a URL that is not absolute', async () => {
    const availability = await transport({ baseUrl: 'models.example.com/v1' }).availability();

    expect(availability.usable).toBe(false);
  });

  it('allows plain http:// but says so whenever a request goes to it', async () => {
    captureRequest(() => sseResponse({ writes: [{ text: sseDelta({ content: 'ok' }) }] }));

    const availability = await transport().availability();
    await transport().complete(MODEL, request());

    expect(availability).toEqual({ usable: true });
    expect(loggedText().join('\n')).toContain('plain http:// rather than https://');
  });

  it('reports a provider with no stored key as unusable without sending anything', async () => {
    const empty: AiSecretStore = {
      get: async () => undefined,
      store: async () => undefined,
      delete: async () => undefined,
    };

    const availability = await transport({}, { secrets: empty }).availability();

    expect(availability.usable).toBe(false);
    expect(availability.usable === false ? availability.reason : '').toContain('No API key is stored');
    expect(captured).toHaveLength(0);
  });

  it('refuses to send to a non-local endpoint while the local-only policy is on', async () => {
    captureRequest(() => sseResponse({ writes: [] }));

    const policy = transport({ baseUrl: 'https://models.example.com/v1' }, { localOnly: true });
    const availability = await policy.availability();
    const failure = await failed(
      policy.complete({ vendor: 'local-gateway', id: 'qwen3:8b', name: 'Qwen3 8B' }, request()),
    );

    expect(availability.usable).toBe(false);
    expect(availability.usable === false ? availability.reason : '').toContain('forgejoToolkit.aiLocalOnly');
    expect(failure.message).toContain('forgejoToolkit.aiLocalOnly');
    expect(captured).toHaveLength(0);
  });

  it('allows a loopback or private endpoint while the local-only policy is on', async () => {
    captureRequest(() => sseResponse({ writes: [] }));

    for (const baseUrl of ['http://localhost:11434/v1', 'http://127.0.0.1:11434/v1', 'http://gateway.local/v1']) {
      const availability = await transport({ baseUrl }, { localOnly: true }).availability();
      expect(availability, baseUrl).toEqual({ usable: true });
    }
  });

  it('names the header conflict in the log without the value', async () => {
    captureRequest(() => sseResponse({ writes: [] }));
    const secrets = secretStore();
    secrets.values[aiProviderHeaderSecretKey('local-gateway', 'api-key') ?? ''] = 'header-owned-secret';

    await transport({ auth: 'bearer', headers: [{ name: 'api-key', valueSecret: true }] }, { secrets }).complete(
      MODEL,
      request(),
    );

    const lines = loggedText().join('\n');
    expect(lines).toContain('"api-key"');
    expect(lines).not.toContain('header-owned-secret');
  });

  it('does not carry a value that was written into a header declaration by hand', async () => {
    captureRequest(() => sseResponse({ writes: [] }));
    // The declaration is parsed by the settings reader, which drops any `value`
    // (`src/ai/modelSettings.ts`); a value that survives it in a hand-built object
    // must still not be sent, because the only place a header value may live is the
    // secret store (§8.2).
    const handBuilt = {
      ...provider({ headers: [] }),
      headers: [{ name: 'x-hand-edited', valueSecret: true, value: 'a-secret-in-settings' }],
    } as unknown as AiProviderConfig;

    await new OpenAiCompatibleTransport({ provider: handBuilt, secrets: secretStore() }).complete(MODEL, request());

    expect(lastRequest().headers['x-hand-edited']).toBeUndefined();
    expect(JSON.stringify(captured)).not.toContain('a-secret-in-settings');
    expect(loggedText().join('\n')).not.toContain('a-secret-in-settings');
  });
});
