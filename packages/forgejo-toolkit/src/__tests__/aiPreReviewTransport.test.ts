import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { http, HttpResponse } from 'msw';

/**
 * Stage 3: the AI pre-review **wired to the transport seam**
 * (`docs/design/ai-model-transport.md` §11.3), on both transports.
 *
 * The suite exists to prove the five things §11.3 asks for, and each of them is a
 * case below:
 *
 * 1. **The same flow completes on either transport.** The editor's own models
 *    (`vscode.lm`) and a configured OpenAI-compatible endpoint run the *same*
 *    fixture: read the pull request, ask, arbitrate the answer against the JSON
 *    contract, validate every anchor, and write the confirmed candidates as pending
 *    drafts. The two cases assert through **one shared function**
 *    (`expectSameRunObservable`), so "equivalent" is a comparison rather than two
 *    hand-written lists that agree by accident.
 * 2. **Nothing is sent while the consent question is unanswered.** With
 *    `forgejoToolkit.aiPreReviewPromptScope` still at `ask`, a run on either
 *    transport makes **zero** requests — no pull request, no endpoint, no model
 *    call — which is §7.2's hard rule read through the new selection point.
 * 3. **A transport with no tokenizer still has a budget policy.** §13 question 3 is
 *    decided in `src/aiPreReview.ts`: a conservative estimate (2 UTF-8 bytes per
 *    token) against an assumed budget, instead of skipping the check. The boundary
 *    cases pin the estimate, the three budget modes, the file-granularity cut it
 *    drives, and the refusal it produces when even the shortest prompt misses.
 * 4. **No fallback between the transports.** A bound endpoint that fails is a
 *    failure and never becomes an editor-model call; an unusable editor never
 *    becomes an endpoint request. Both directions are asserted by watching the
 *    other side.
 * 5. **The run says which transport, provider and model served it** — in the log,
 *    in the confirmation panel's payload and in the debug diagnostics dump.
 *
 * A sixth group belongs to the same stage but not to §11.3's list: **an answer the
 * endpoint reported as cut off is reported as cut off** (§9.2), which only the direct
 * transport can see and only the run can tell the user about.
 *
 * The carrier is the suite's existing `msw/node` interceptor, as in
 * `src/__tests__/openAiCompatibleTransport.test.ts`: the endpoint is a mock served
 * over the real `fetch` path, and the pull request comes from the shared Forgejo
 * handlers. **No real endpoint and no real credential are involved**: the key the
 * cases seed is a local test literal, and every request it authorises is answered by
 * a handler in this file.
 */

const state = vi.hoisted(() => ({
  /** Configuration values, keyed by the setting name without its section. */
  settings: {} as Record<string, unknown>,
  /** Whether the progress notification's cancellation token starts out cancelled. */
  cancelRequested: false,
}));

/**
 * The confirmation panel, as the run sees it: the payload of every run, and the
 * answer each case installs. The panel's own behaviour has its own suites
 * (`src/__tests__/aiPreReviewPanel.test.ts` and the webview component test), and
 * what this file reads from the payload is the served-by block.
 */
const panelState = vi.hoisted(() => ({
  createOrShow: vi.fn(),
  payloads: [] as Array<Record<string, unknown>>,
  disposed: 0,
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
    // The part classes the run's own reader names. The editor model this file
    // offers answers with the **RPC envelope** flavour instead of instances
    // (`{$mid: 21, value}`), which is the shape the maintainer's machine measured
    // and the one `classifyResponsePart` recognises by shape; the classes are still
    // declared because the production classifier tests for them first.
    LanguageModelTextPart: class LanguageModelTextPart {
      constructor(public value: string) {}
    },
    ProgressLocation: { SourceControl: 1, Window: 10, Notification: 15 },
    window: {
      showErrorMessage: vi.fn(),
      showInformationMessage: vi.fn(async () => undefined),
      showWarningMessage: vi.fn(async () => undefined),
      showQuickPick: vi.fn(),
      showInputBox: vi.fn(),
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
        update: vi.fn(),
      })),
      openTextDocument: vi.fn(async (uri: unknown) => ({ uri })),
      onDidChangeConfiguration: vi.fn(() => ({ dispose: vi.fn() })),
      onDidChangeWorkspaceFolders: vi.fn(() => ({ dispose: vi.fn() })),
      workspaceFolders: [],
      textDocuments: [],
    },
    ConfigurationTarget: { Global: 1, Workspace: 2, WorkspaceFolder: 3 },
    commands: { executeCommand: vi.fn(), registerCommand: vi.fn(() => ({ dispose: vi.fn() })) },
    Uri: {
      file: vi.fn((path: string) => makeUri('file', path)),
      parse: vi.fn((url: string) => makeUri(url.split(':')[0] ?? '', url)),
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
import { mockServer, startMockServer, stopMockServer, unhandledRequests } from '../test/mocks/server';
import { resetMockState } from '../test/mocks/handlers';
import { mockInstance } from '../test/mocks/data/instances';
import { mockPullRequestDiff as MOCK_DIFF } from '../test/mocks/data/pullRequestExtras';
import {
  AI_PRE_REVIEW_ASSUMED_INPUT_TOKENS,
  AI_PRE_REVIEW_ESTIMATED_BYTES_PER_TOKEN,
  aiPreReviewAvailableTokens,
  aiPreReviewBudgetMode,
  estimateAiPreReviewTokens,
  runAiPreReview,
} from '../aiPreReview';
import { AI_PRE_REVIEW_DIAGNOSTICS_FILE_NAME } from '../aiPreReviewDiagnostics';
import {
  aiPreReviewPromptText,
  buildAiPreReviewBrief,
  buildAiPreReviewSystemPrompt,
  buildAiPreReviewUserPrompt,
} from '../aiPreReviewBrief';
import { logger } from '../logger';
import { aiProviderKeySecretKey, type AiSecretStore } from '../ai/providerSecrets';
import type { AiProviderConfig } from '../ai/modelSettings';
import type { ForgejoPrUriParams } from '../prFileSystemProvider';
import type { ConfigManager } from '../config';
import type { PullReviewCommentController } from '../comments/pullReviewCommentController';
import { removeTempDirSync } from './tempDir';

const ENDPOINT_BASE = 'http://localhost:11434/v1';
const ENDPOINT_CHAT = `${ENDPOINT_BASE}/chat/completions`;
const PROVIDER_ID = 'local-gateway';
const PROVIDER_NAME = 'Local Gateway';
/** A local test literal: no real credential exists anywhere in this repository. */
const API_KEY = 'sk-stage-3-test-key-0123456789';
const ANSWER_BODY = 'This logs on every call.';
const VALID_ANSWER = JSON.stringify({
  comments: [{ path: 'src/index.ts', line: 2, side: 'head', extraLines: 0, body: ANSWER_BODY }],
});

/** One provider entry in the shape the settings reader produces (§8.1). */
function provider(overrides: Partial<AiProviderConfig> = {}): AiProviderConfig {
  return {
    id: PROVIDER_ID,
    name: PROVIDER_NAME,
    baseUrl: ENDPOINT_BASE,
    models: [{ id: 'qwen3:8b', name: 'Qwen3 8B' }],
    auth: 'bearer',
    headers: [],
    localOnly: false,
    ...overrides,
  };
}

/** A secret store holding exactly the one key this suite's endpoint needs. */
function secretStore(): AiSecretStore {
  const values: Record<string, string> = { [aiProviderKeySecretKey(PROVIDER_ID)]: API_KEY };
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

/** Every request the model endpoint received, so "zero requests" can be asserted. */
let endpointRequests: string[] = [];
/** The body of every request the model endpoint received. */
let endpointBodies: Array<Record<string, unknown>> = [];

/**
 * The endpoint's answer as one SSE event stream: the primary path a real
 * OpenAI-compatible endpoint takes (§6.4), and the one this suite's endpoint serves
 * unless a case says otherwise.
 */
function sseBody(answer: string): string {
  return `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: answer } }] })}\n\ndata: [DONE]\n\n`;
}

/** Serves the endpoint with one SSE answer. */
function serveEndpoint(answer: string): void {
  mockServer.use(
    http.post(ENDPOINT_CHAT, async ({ request }) => {
      endpointRequests.push(request.url);
      endpointBodies.push((await request.json()) as Record<string, unknown>);
      return new HttpResponse(sseBody(answer), { headers: { 'content-type': 'text/event-stream' } });
    }),
  );
}

/**
 * The endpoint's answer as one SSE stream that **ends at the endpoint's own output
 * limit**: the content arrives, and then a final event carries
 * `finish_reason: 'length'` and no content of its own. That is the wire shape §6.4
 * item 5 names, and the one `src/__tests__/openAiCompatibleTransport.test.ts`
 * measured — the endpoint saying, in its own words, that the answer is incomplete.
 */
function truncatedSseBody(answer: string): string {
  return `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: answer } }] })}\n\ndata: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'length' }] })}\n\ndata: [DONE]\n\n`;
}

/** Serves the endpoint with one SSE answer the endpoint itself reports as cut off. */
function serveTruncatedEndpoint(answer: string): void {
  mockServer.use(
    http.post(ENDPOINT_CHAT, async ({ request }) => {
      endpointRequests.push(request.url);
      endpointBodies.push((await request.json()) as Record<string, unknown>);
      return new HttpResponse(truncatedSseBody(answer), { headers: { 'content-type': 'text/event-stream' } });
    }),
  );
}

/**
 * An editor model, in the shape `vscode.lm` hands one over and the `vscode.lm`
 * transport reads: `countTokens` measures, and `sendRequest` answers with one RPC
 * text envelope — the flavour the maintainer's machine measured.
 */
function editorModel(options: { answer?: string; maxInputTokens?: number; tokens?: number } = {}) {
  const answer = options.answer ?? VALID_ANSWER;
  return {
    name: 'Editor Model',
    id: 'editor-model',
    vendor: 'editor-vendor',
    family: 'editor-family',
    version: '1',
    maxInputTokens: options.maxInputTokens ?? 128_000,
    countTokens: vi.fn(async () => options.tokens ?? 10),
    sendRequest: vi.fn(async () => ({
      stream: (async function* () {
        yield { $mid: 21, value: answer };
      })(),
      text: (async function* () {
        yield answer;
      })(),
    })),
  };
}

function offerEditorModel(model: ReturnType<typeof editorModel>): void {
  vi.mocked(vscode.lm.selectChatModels).mockImplementation(async () => [model] as never[]);
}

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

/** What one intercepted Forgejo request carried. */
interface CapturedRequest {
  method: string;
  path: string;
  body: string;
}

const captured: CapturedRequest[] = [];
const pendingReads: Promise<void>[] = [];
const logDirs: string[] = [];

/** The `ExtensionContext` fields the run reads, with the store this suite's endpoint needs. */
function testHost(extra: { logUri?: vscode.Uri } = {}): {
  extensionUri: vscode.Uri;
  logUri?: vscode.Uri;
  secrets: AiSecretStore;
} {
  return { extensionUri: vscode.Uri.file('/ext') as vscode.Uri, secrets: secretStore(), ...extra };
}

/**
 * The confirmation panel's default answer: the user checked the first card and left
 * the model's wording in it, which is what makes the draft body the model's own.
 */
function installPanel(): void {
  panelState.createOrShow.mockImplementation((_extensionUri: unknown, payload: unknown) => {
    const asPayload = payload as Record<string, unknown>;
    panelState.payloads.push(asPayload);
    const first = (asPayload.candidates as Array<{ index: number; body: string }>)[0];
    const decision =
      first === undefined
        ? { kind: 'cancel' }
        : { kind: 'create', entries: [{ index: first.index, body: first.body }] };
    return {
      decision: Promise.resolve(decision),
      reportResult: vi.fn(),
      dispose: vi.fn(() => {
        panelState.disposed += 1;
      }),
    };
  });
}

/** The payload the last run handed the panel. */
function panelPayload(): Record<string, unknown> {
  const payload = panelState.payloads.at(-1);
  if (!payload) {
    throw new Error('the run did not open the confirmation panel');
  }
  return payload;
}

/** The request bodies of every `POST` the run issued, in order. */
async function postedBodies(pathSuffix: string): Promise<Record<string, unknown>[]> {
  await Promise.all(pendingReads.splice(0));
  return captured
    .filter((entry) => entry.method === 'POST' && entry.path.endsWith(pathSuffix))
    .map((entry) => JSON.parse(entry.body) as Record<string, unknown>);
}

/** Every line the Output Channel was handed. */
function loggedLines(): string[] {
  return [logger.debug, logger.info, logger.error].flatMap((method) =>
    vi.mocked(method).mock.calls.map((call) => String(call[0])),
  );
}

/** The one sentence a case expects in a message, with every argument already filled in. */
function messageText(mock: unknown): string {
  const calls = (mock as { mock: { calls: unknown[][] } }).mock.calls;
  return calls.map(([message]) => String(message)).join('\n');
}

/**
 * The facts both transport cases assert, so "the same flow on either transport" is
 * one comparison rather than two lists.
 *
 * The draft's anchor and body, the panel's own header facts and the pull request it
 * names are the run's observable outcome; nothing here says which transport produced
 * it, which is exactly the point — the transport is asserted separately, from the
 * served-by block and the log line.
 */
async function expectSameRunObservable(): Promise<void> {
  const drafts = await postedBodies('/reviews');
  expect(drafts).toHaveLength(1);
  // The pending-review body the client sends for the first confirmed candidate: a
  // `PENDING` review carrying exactly that one comment, with the placeholder body
  // Forgejo requires (it is replaced when the user submits the review themselves).
  expect(drafts[0]).toEqual({
    event: 'PENDING',
    body: '.',
    comments: [{ body: ANSWER_BODY, path: 'src/index.ts', new_position: 2 }],
  });

  const payload = panelPayload();
  expect(payload.scope).toBe('metadata-only');
  expect(payload.candidateCount).toBe(1);
  expect(payload.drops).toEqual([]);
  expect(payload.changedFileCount).toBe(1);
  expect(payload).toMatchObject({ owner: 'demo-user', repo: 'demo-repo', index: 2 });
}

beforeEach(async () => {
  state.settings = {};
  state.cancelRequested = false;
  endpointRequests = [];
  endpointBodies = [];
  captured.length = 0;
  pendingReads.length = 0;
  panelState.payloads.length = 0;
  panelState.disposed = 0;
  vi.clearAllMocks();
  resetMockState();
  vi.spyOn(logger, 'debug');
  vi.spyOn(logger, 'info');
  vi.spyOn(logger, 'error');
  vi.spyOn(logger, 'isDebugEnabled').mockReturnValue(false);
  vi.mocked(controller.findPendingReview).mockResolvedValue(undefined);
  vi.mocked(vscode.window.showInformationMessage).mockResolvedValue(undefined);
  installPanel();
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
  mockServer.resetHandlers();
  mockServer.events.removeAllListeners();
  vi.clearAllMocks();
  for (const directory of logDirs.splice(0)) {
    removeTempDirSync(directory);
  }
});

/** The settings a run needs before the transport question is even asked. */
function baseSettings(extra: Record<string, unknown>): void {
  state.settings = {
    aiPreReview: true,
    aiPreReviewPromptScope: 'metadata-only',
    ...extra,
  };
}

describe('the same pre-review on both transports (§11.3)', () => {
  it('completes through the editor models, and says so', async () => {
    baseSettings({
      // An endpoint is configured **and enabled**, and the user asked for the editor
      // models: the two halves of "no fallback" in one case — the endpoint is
      // reachable and still receives nothing.
      aiTransport: 'vscode-lm',
      aiProviders: [provider()],
      aiProvidersEnabled: true,
      aiPreReviewModel: 'editor-vendor/editor-model',
    });
    const editor = editorModel();
    offerEditorModel(editor);

    await runAiPreReview(config, undefined, controller, params, testHost());

    await expectSameRunObservable();
    expect(editor.sendRequest).toHaveBeenCalledTimes(1);
    expect(endpointRequests).toEqual([]);
    // The served-by facts: the transport's own id, its branch, and the vendor that
    // received the content — no address, because the editor's models have none.
    expect(panelPayload().transport).toEqual({ id: 'vscode.lm', kind: 'vscode.lm', provider: 'editor-vendor' });
    expect(loggedLines()).toContainEqual(
      expect.stringContaining(
        'AI pre-review: this run is served by transport=vscode.lm, provider="editor-vendor", model=Editor Model',
      ),
    );
  });

  it('completes through the configured endpoint, and says where it went', async () => {
    baseSettings({
      aiProviders: [provider()],
      aiProvidersEnabled: true,
      aiModelBindings: [{ feature: 'aiPreReview', providerId: PROVIDER_ID, modelId: 'qwen3:8b' }],
      // A model setting for the editor path is deliberately present and ignored: the
      // direct choice is the binding's, and the run must not ask the editor anything.
      aiPreReviewModel: 'editor-vendor/editor-model',
    });
    const editor = editorModel();
    offerEditorModel(editor);
    serveEndpoint(VALID_ANSWER);

    await runAiPreReview(config, undefined, controller, params, testHost());

    await expectSameRunObservable();
    // The request's own shape (§6.3): the instructions as a `system` message and the
    // request as one `user` message — the direct transport's mapping, which the
    // editor API cannot express.
    expect(endpointBodies).toHaveLength(1);
    const sent = endpointBodies[0] as { model: string; stream: boolean; messages: Array<{ role: string }> };
    expect(sent.model).toBe('qwen3:8b');
    expect(sent.stream).toBe(true);
    expect(sent.messages.map((message) => message.role)).toEqual(['system', 'user']);
    // No fallback, in the other direction: the editor's models were never listed and
    // never asked, even though the setting names one.
    expect(vscode.lm.selectChatModels).not.toHaveBeenCalled();
    expect(editor.sendRequest).not.toHaveBeenCalled();
    expect(vscode.window.showQuickPick).not.toHaveBeenCalled();
    // The served-by facts, with the address the content went to: exactly what the
    // consent modal names (§7.1) and what the panel has to keep saying afterwards.
    expect(panelPayload().transport).toEqual({
      id: `openai-compatible:${PROVIDER_ID}`,
      kind: 'openai-compatible',
      provider: PROVIDER_NAME,
      address: ENDPOINT_BASE,
    });
    expect(loggedLines()).toContainEqual(
      expect.stringContaining(
        `AI pre-review: this run is served by transport=openai-compatible:${PROVIDER_ID}, provider="${PROVIDER_NAME}" at ${ENDPOINT_BASE}, model=Qwen3 8B`,
      ),
    );
  });

  it('writes the same served-by facts into the debug diagnostics dump', async () => {
    baseSettings({
      aiProviders: [provider()],
      aiProvidersEnabled: true,
      aiModelBindings: [{ feature: 'aiPreReview', providerId: PROVIDER_ID, modelId: 'qwen3:8b' }],
    });
    serveEndpoint(VALID_ANSWER);
    const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ai-pre-review-transport-'));
    logDirs.push(directory);
    vi.spyOn(logger, 'isDebugEnabled').mockReturnValue(true);

    await runAiPreReview(config, undefined, controller, params, testHost({ logUri: { fsPath: directory } as never }));

    const dump = await fs.promises.readFile(path.join(directory, AI_PRE_REVIEW_DIAGNOSTICS_FILE_NAME), 'utf8');
    expect(dump).toContain(
      `served by: transport=openai-compatible:${PROVIDER_ID}, provider="${PROVIDER_NAME}" at ${ENDPOINT_BASE}`,
    );
    // The budget this run used, said as what it is: an estimate against an assumed
    // budget, not a count the endpoint reported (§13 question 3).
    expect(dump).toContain('it has no tokenizer, so the run estimates');
    expect(dump).toContain(`the assumed input budget of ${AI_PRE_REVIEW_ASSUMED_INPUT_TOKENS} token(s)`);
    expect(dump).toContain('a `system` message carrying the fixed instructions');
  });
});

/**
 * An answer the endpoint cut off is reported **as** cut off (§9.2).
 *
 * The defect these cases exist for: a truncated answer is a prefix, and a prefix of a
 * JSON document fails the contract exactly like prose does — so the run used to say
 * "the answer was not JSON" and stop, leaving the user with nothing to act on while
 * the endpoint had already said why. The three cases pin the three arms this has to
 * have: the endpoint's reading reaches the report, a complete answer never gains the
 * sentence, and the editor's own models — which report no `finish_reason` at all —
 * cannot gain it even when their answer fails the same contract.
 */
describe('an answer the endpoint truncated is reported as truncated (§9.2)', () => {
  it('says the endpoint cut its answer off, and how to stop that happening', async () => {
    baseSettings({
      aiProviders: [provider()],
      aiProvidersEnabled: true,
      aiModelBindings: [{ feature: 'aiPreReview', providerId: PROVIDER_ID, modelId: 'qwen3:8b' }],
    });
    // A JSON answer stopped mid-object, which is what a real `finish_reason=length`
    // produces and what used to read as an ordinary "not JSON".
    serveTruncatedEndpoint('{"comments":[{"path":"src/index.ts","line":2,"side":"head","body":"a very long');

    await runAiPreReview(config, undefined, controller, params, testHost());

    // The retry is unchanged: a contract violation is what it exists for, so the one
    // chosen model was asked twice and the endpoint's own limit stopped both.
    expect(endpointBodies).toHaveLength(2);
    const messages = messageText(vscode.window.showErrorMessage);
    // The failure sentence the run always gave is still there, word for word …
    expect(messages).toContain('the answer was not JSON');
    // … and now the endpoint's own reading is beside it, named with the endpoint the
    // consent modal named …
    expect(messages).toContain(
      `The AI endpoint "${PROVIDER_NAME}" reported that it hit its own output limit (finish_reason=length)`,
    );
    // … and the remedy §9.2 asks for, rather than a dead end.
    expect(messages).toContain(
      'Raise the output limit configured on the endpoint, or choose a model that respects the instruction and answers within it.',
    );
    // Said once for the run, not once per attempt: two of them would read as two
    // problems when there is one.
    expect(messages.split('finish_reason=length').length - 1).toBe(1);
    // Nothing was created, exactly as before the report learned to say this.
    expect(await postedBodies('/reviews')).toEqual([]);
    expect(panelState.payloads).toEqual([]);
  });

  it('adds nothing about an output limit to an answer that was complete', async () => {
    baseSettings({
      aiProviders: [provider()],
      aiProvidersEnabled: true,
      aiModelBindings: [{ feature: 'aiPreReview', providerId: PROVIDER_ID, modelId: 'qwen3:8b' }],
    });
    // The same endpoint, answering the same request with a complete JSON object and
    // no `finish_reason` of its own: the ordinary run, which must stay word for word
    // what it was.
    serveEndpoint(VALID_ANSWER);

    await runAiPreReview(config, undefined, controller, params, testHost());

    await expectSameRunObservable();
    expect(messageText(vscode.window.showErrorMessage)).not.toContain('output limit');
  });

  it('says nothing about an endpoint when an editor model answers something that is not JSON', async () => {
    baseSettings({ aiTransport: 'vscode-lm', aiPreReviewModel: 'editor-vendor/editor-model' });
    const editor = editorModel({ answer: 'The diff looks good to me.' });
    offerEditorModel(editor);

    await runAiPreReview(config, undefined, controller, params, testHost());

    const messages = messageText(vscode.window.showErrorMessage);
    // The same contract failure, reported exactly as it always was …
    expect(messages).toContain('the answer was not JSON');
    // … and no sentence about an endpoint's limits: `vscode.lm` reports no
    // `finish_reason`, so its transport never sets the truncation reading, and a
    // truncated **editor** answer cannot gain an endpoint's remedy (§11.3).
    expect(messages).not.toContain('output limit');
    expect(messages).not.toContain('AI endpoint');
    expect(endpointRequests).toEqual([]);
  });

  it('records the truncation in the debug dump beside the contract violation', async () => {
    baseSettings({
      aiProviders: [provider()],
      aiProvidersEnabled: true,
      aiModelBindings: [{ feature: 'aiPreReview', providerId: PROVIDER_ID, modelId: 'qwen3:8b' }],
    });
    serveTruncatedEndpoint('{"comments":[{"path":"src/index.ts","line":2,"side":"head","body":"a very long');
    vi.spyOn(logger, 'isDebugEnabled').mockReturnValue(true);
    const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ai-pre-review-truncated-'));
    logDirs.push(directory);

    await runAiPreReview(config, undefined, controller, params, testHost({ logUri: { fsPath: directory } as never }));

    const dump = await fs.promises.readFile(path.join(directory, AI_PRE_REVIEW_DIAGNOSTICS_FILE_NAME), 'utf8');
    // The run's own record carries the fact the failure line does not: without it, a
    // reader of the dump cannot tell a truncated JSON prefix from a model that simply
    // answered prose.
    expect(dump).toContain(
      'the endpoint reported finish_reason=length, so this answer was cut off before it was complete',
    );
    expect(dump).toContain('outcome: contract violation: the answer is not JSON');
  });
});

describe('the consent question still comes first (§7.2)', () => {
  /** Every request the same fixture produced, on either transport. */
  async function runWithScopeAsk(configure: () => ReturnType<typeof editorModel> | undefined): Promise<void> {
    state.settings = {
      aiPreReview: true,
      // The question has not been answered: `ask` is the question, not consent.
      aiPreReviewPromptScope: 'ask',
      ...(configure() === undefined
        ? {}
        : {
            aiProviders: [provider()],
            aiProvidersEnabled: true,
            aiModelBindings: [{ feature: 'aiPreReview', providerId: PROVIDER_ID, modelId: 'qwen3:8b' }],
          }),
    };
    // A dismissed modal: `showInformationMessage` resolves `undefined` for the
    // explicit cancel button, the close control and Escape alike.
    vi.mocked(vscode.window.showInformationMessage).mockResolvedValue(undefined);

    await runAiPreReview(config, undefined, controller, params, testHost());
  }

  it('sends nothing through the editor models while the answer is still ask', async () => {
    const editor = editorModel();
    offerEditorModel(editor);

    await runWithScopeAsk(() => undefined);

    expect(vscode.lm.selectChatModels).toHaveBeenCalled();
    expect(editor.sendRequest).not.toHaveBeenCalled();
    expect(captured).toEqual([]);
    expect(endpointRequests).toEqual([]);
    expect(unhandledRequests()).toEqual([]);
    expect(panelState.payloads).toEqual([]);
    // The modal was shown, and the run ended on "not answered".
    expect(vscode.window.showInformationMessage).toHaveBeenCalled();
    expect(await postedBodies('/reviews')).toEqual([]);
  });

  it('sends nothing to the configured endpoint while the answer is still ask', async () => {
    serveEndpoint(VALID_ANSWER);

    await runWithScopeAsk(() => editorModel());

    expect(endpointRequests).toEqual([]);
    expect(captured).toEqual([]);
    expect(unhandledRequests()).toEqual([]);
    expect(panelState.payloads).toEqual([]);
    expect(await postedBodies('/reviews')).toEqual([]);
  });
});

describe('the budget policy of a transport with no tokenizer (§13 question 3)', () => {
  it('estimates from UTF-8 bytes, with the ceiling and the multibyte cases pinned', () => {
    expect(AI_PRE_REVIEW_ESTIMATED_BYTES_PER_TOKEN).toBe(2);
    expect(estimateAiPreReviewTokens('')).toBe(0);
    expect(estimateAiPreReviewTokens('ab')).toBe(1);
    // The ceiling, not the floor: a prompt that costs a fraction of a token would
    // otherwise be counted as free.
    expect(estimateAiPreReviewTokens('abc')).toBe(2);
    expect(estimateAiPreReviewTokens('abcd')).toBe(2);
    expect(estimateAiPreReviewTokens('abcde')).toBe(3);
    // A Han character is 3 UTF-8 bytes and one UTF-16 code unit: counting
    // `text.length` would report 1 byte's worth where it costs 3.
    expect(estimateAiPreReviewTokens('中')).toBe(2);
    // An astral character is 4 bytes and two code units.
    expect(estimateAiPreReviewTokens('𝄞')).toBe(2);
  });

  it('decides the three budget modes from the measurement and the declared budget', () => {
    // A tokenizer answered: the model's own numbers, whatever it declared.
    expect(aiPreReviewBudgetMode(7, 128_000)).toBe('measured');
    expect(aiPreReviewBudgetMode(7, 0)).toBe('measured');
    // No answer and no declared budget: the direct endpoint's ordinary state, and the
    // one the conservative estimate exists for.
    expect(aiPreReviewBudgetMode(undefined, 0)).toBe('estimated');
    // No answer but a declared budget: a provider contradicting its own declaration,
    // which the pre-seam reading left without a comparison.
    expect(aiPreReviewBudgetMode(undefined, 8_192)).toBe('unmeasured');
    // The budget each mode compares against.
    expect(aiPreReviewAvailableTokens('measured', 128_000)).toBe(128_000);
    expect(aiPreReviewAvailableTokens('unmeasured', 8_192)).toBe(8_192);
    expect(aiPreReviewAvailableTokens('estimated', 0)).toBe(AI_PRE_REVIEW_ASSUMED_INPUT_TOKENS);
  });

  it('is conservative on the prompt shapes this feature actually builds', () => {
    // The measurement behind the margin, taken on this feature's own shapes rather
    // than on prose: the instruction block plus a brief for the fixture pull request.
    // They are code, paths, JSON and diff markers — all ASCII — where a tokenizer
    // spends about four characters per token. `estimate` counts two bytes per token,
    // so it is at least twice the prose rule of thumb, and the cut or the refusal
    // happens early rather than late.
    const brief = buildAiPreReviewBrief({
      pullRequest: { number: 2, title: 'Add logging', baseBranch: 'main', headBranch: 'feature' },
      changedFiles: [{ filename: 'src/index.ts', status: 'modified', additions: 1, deletions: 0, changes: 1 }],
      diffText: MOCK_DIFF,
      existingReviews: [],
    });
    const prompt = aiPreReviewPromptText(
      buildAiPreReviewSystemPrompt('en'),
      buildAiPreReviewUserPrompt(brief, { diffText: MOCK_DIFF, diffBody: 'full' }),
    );
    // The shapes are ASCII bar a couple of em dashes in the instruction block, so the
    // byte count and the character count agree to within a fraction of a percent —
    // which is what makes a bytes-per-token rule the same rule as a characters-per-token
    // one here, and what the two assertions below measure.
    const bytes = Buffer.byteLength(prompt, 'utf8');
    expect(bytes / prompt.length).toBeLessThan(1.01);
    expect(estimateAiPreReviewTokens(prompt)).toBe(Math.ceil(bytes / AI_PRE_REVIEW_ESTIMATED_BYTES_PER_TOKEN));
    // At two bytes per token the estimate is at least twice the prose rule of thumb
    // (four characters per token), so it cuts early rather than late on this shape.
    expect(estimateAiPreReviewTokens(prompt)).toBeGreaterThanOrEqual(Math.ceil(prompt.length / 4));

    // The densest text a pull request can carry, and the reason the estimate counts
    // bytes rather than UTF-16 code units: a Han character is 3 UTF-8 bytes and one
    // code unit, and real tokenizers spend roughly one token on it. The estimate has
    // to reach that, and does — one token per character is 1.5 tokens per character's
    // worth of bytes at this ratio.
    const cjk = '这是一段用来测量字节密度的中文说明文字。'.repeat(200);
    expect(Buffer.byteLength(cjk, 'utf8') / cjk.length).toBeGreaterThan(2.9);
    expect(estimateAiPreReviewTokens(cjk)).toBeGreaterThanOrEqual([...cjk].length);
  });

  /** A synthetic unified diff: one file, `lines` added lines of fixed width. */
  function diffBlock(file: string, lines: number): string {
    const body = Array.from(
      { length: lines },
      (_unused, index) => `+const value${index} = 'padding-padding-padding';`,
    ).join('\n');
    return `diff --git a/${file} b/${file}
index 1111111..2222222 100644
--- a/${file}
+++ b/${file}
@@ -1,1 +1,${lines} @@
 const head = 1;
${body}
`;
  }

  /** Serves a two- or one-file pull request whose diff is exactly these blocks. */
  function serveBigPullRequest(blocks: Array<{ file: string; lines: number }>): void {
    const diff = blocks.map((block) => diffBlock(block.file, block.lines)).join('');
    mockServer.use(
      http.get('https://*/api/v1/repos/:owner/:repo/pulls/:index/files', ({ request }) => {
        const url = new URL(request.url);
        const page = Math.max(1, Number(url.searchParams.get('page')) || 1);
        const items = blocks.map((block) => ({
          filename: block.file,
          status: 'modified',
          additions: block.lines,
          deletions: 0,
          changes: block.lines,
        }));
        return HttpResponse.json(page === 1 ? items : []);
      }),
      http.get('https://*/api/v1/repos/:owner/:repo/pulls/:index.diff', () =>
        HttpResponse.text(diff, { headers: { 'Content-Type': 'text/plain' } }),
      ),
    );
  }

  it('cuts whole files to the estimate instead of skipping the check', async () => {
    baseSettings({
      aiPreReviewPromptScope: 'full-diff',
      aiProviders: [provider()],
      aiProvidersEnabled: true,
      aiModelBindings: [{ feature: 'aiPreReview', providerId: PROVIDER_ID, modelId: 'qwen3:8b' }],
    });
    // Two files whose diff is over the assumed budget together and under it once the
    // second one is dropped: 400 lines ≈ 13 KB and 1800 lines ≈ 58 KB, against
    // 32,768 estimated tokens = 65,536 UTF-8 bytes.
    serveBigPullRequest([
      { file: 'src/first.ts', lines: 400 },
      { file: 'src/second.ts', lines: 1_800 },
    ]);
    serveEndpoint(JSON.stringify({ comments: [] }));

    await runAiPreReview(config, undefined, controller, params, testHost());

    expect(endpointBodies).toHaveLength(1);
    const prompt = JSON.stringify(endpointBodies[0]);
    // The cut happened, by file granularity, and the prompt says so to the model.
    expect(prompt).toContain('truncatedBy=token-budget');
    expect(prompt).toContain('src/first.ts');
    expect(prompt).not.toContain('src/second.ts');
  });

  it('refuses with the estimated numbers when even the shortest prompt misses', async () => {
    baseSettings({
      aiPreReviewPromptScope: 'full-diff',
      aiProviders: [provider()],
      aiProvidersEnabled: true,
      aiModelBindings: [{ feature: 'aiPreReview', providerId: PROVIDER_ID, modelId: 'qwen3:8b' }],
    });
    // One file, far past the assumed budget: there is no file left to drop, so the
    // run refuses instead of sending a request the endpoint would reject.
    serveBigPullRequest([{ file: 'src/huge.ts', lines: 4_000 }]);
    serveEndpoint(JSON.stringify({ comments: [] }));

    await runAiPreReview(config, undefined, controller, params, testHost());

    expect(endpointRequests).toEqual([]);
    expect(await postedBodies('/reviews')).toEqual([]);
    const messages = messageText(vscode.window.showErrorMessage);
    expect(messages).toContain('could not fit the whole pull request');
    expect(messages).toContain(`available)`);
    expect(messages).toContain(String(AI_PRE_REVIEW_ASSUMED_INPUT_TOKENS));
    // And the numbers are said to be estimates rather than counts, so nobody reads
    // the assumed budget as the endpoint's own.
    expect(messageText(vscode.window.showInformationMessage)).toContain(
      `${AI_PRE_REVIEW_ESTIMATED_BYTES_PER_TOKEN} UTF-8 bytes per token`,
    );
    expect(loggedLines()).toContainEqual(
      expect.stringContaining('a conservative estimate, because this transport has no tokenizer'),
    );
  });

  it('sends the very same prompt through the editor models, whose tokenizer measures it', async () => {
    // The same oversized diff, on the transport that **can** measure it: the refusal
    // above is the estimate's, not the prompt's size — the editor path sends the whole
    // thing, because its model reports a budget and a count.
    baseSettings({
      aiPreReviewPromptScope: 'full-diff',
      aiTransport: 'vscode-lm',
      aiPreReviewModel: 'editor-vendor/editor-model',
    });
    serveBigPullRequest([{ file: 'src/huge.ts', lines: 4_000 }]);
    const editor = editorModel({ answer: JSON.stringify({ comments: [] }) });
    // A tokenizer that charges a small constant for any text: `maxInputTokens` is what
    // decides here, and it is the model's own declared number.
    editor.countTokens = vi.fn(async () => 10) as never;
    offerEditorModel(editor);

    await runAiPreReview(config, undefined, controller, params, testHost());

    expect(editor.sendRequest).toHaveBeenCalledTimes(1);
    expect(vscode.window.showErrorMessage).not.toHaveBeenCalled();
  });
});

describe('no fallback between the transports (§7.5)', () => {
  it('fails on a bound endpoint that rejects the request, without asking the editor', async () => {
    baseSettings({
      aiProviders: [provider()],
      aiProvidersEnabled: true,
      aiModelBindings: [{ feature: 'aiPreReview', providerId: PROVIDER_ID, modelId: 'qwen3:8b' }],
      aiPreReviewModel: 'editor-vendor/editor-model',
    });
    mockServer.use(
      http.post(ENDPOINT_CHAT, ({ request }) => {
        endpointRequests.push(request.url);
        return new HttpResponse('{"error":{"message":"bad key"}}', { status: 401 });
      }),
    );
    const editor = editorModel();
    offerEditorModel(editor);

    await runAiPreReview(config, undefined, controller, params, testHost());

    // One request, one failure, and the editor's models were never consulted — not
    // listed, not asked, not offered as a substitute.
    expect(endpointRequests).toHaveLength(1);
    expect(vscode.lm.selectChatModels).not.toHaveBeenCalled();
    expect(editor.sendRequest).not.toHaveBeenCalled();
    expect(messageText(vscode.window.showErrorMessage)).toContain('could not be completed');
    expect(await postedBodies('/reviews')).toEqual([]);
  });

  it('fails on an unusable editor without reaching the configured endpoint', async () => {
    baseSettings({
      // The user asked for the editor models outright, so a configured endpoint must
      // not become the answer even though it is configured, enabled and reachable.
      aiTransport: 'vscode-lm',
      aiProviders: [provider()],
      aiProvidersEnabled: true,
    });
    vi.mocked(vscode.lm.selectChatModels).mockRejectedValue(new Error('the editor cannot list models'));
    serveEndpoint(VALID_ANSWER);

    await runAiPreReview(config, undefined, controller, params, testHost());

    expect(endpointRequests).toEqual([]);
    expect(unhandledRequests()).toEqual([]);
    expect(messageText(vscode.window.showErrorMessage)).toContain('No chat model is available');
    expect(panelState.payloads).toEqual([]);
  });

  it('reports both routes when neither can serve the run, and never switches', async () => {
    baseSettings({
      // `auto`, no editor model, and no endpoint configured: the run must say what it
      // found on both routes rather than picking one for the user.
      aiTransport: 'auto',
    });
    vi.mocked(vscode.lm.selectChatModels).mockResolvedValue([] as never[]);
    const editor = editorModel();

    await runAiPreReview(config, undefined, controller, params, testHost());

    const messages = messageText(vscode.window.showErrorMessage);
    // The editor half keeps the run's own sentence (§9.3)…
    expect(messages).toContain('No chat model is available: install and sign in to a chat model provider');
    // …and the configured-endpoint half's own reason is added to it.
    expect(messages).toContain('cannot serve this run either');
    expect(messages).toContain('no AI endpoint is configured under "forgejoToolkit.aiProviders"');
    expect(endpointRequests).toEqual([]);
    expect(editor.sendRequest).not.toHaveBeenCalled();
  });
});
