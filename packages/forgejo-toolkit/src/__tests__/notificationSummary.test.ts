import { describe, it, expect, vi, beforeEach, afterEach, beforeAll, afterAll, type Mock } from 'vitest';

/**
 * The host half of "summarise the discussion behind a notification".
 *
 * The model transport is faked (through `selectedModelFor`) rather than reached over
 * HTTP, because what these cases are about is the run's **decisions**: whether anything
 * was read or requested before the consent question was answered, what the chosen tier
 * put into the prompt, and what each failure arm became. The reads go through the real
 * client against the shared mock handlers, so "zero requests" is measured on a real
 * request path — and every case that must send nothing installs a catch-all recorder, so
 * **any** request, from any transport, would be visible rather than assumed absent.
 */

const state = vi.hoisted(() => ({
  /** Configuration values, keyed by the setting name without its section. */
  settings: {} as Record<string, unknown>,
  /** The one write the run may make: the consent answer, at global scope. */
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
  ViewColumn: { Active: -1, Beside: 2, One: 1, Two: 2 },
  window: {
    showErrorMessage: vi.fn(),
    showInformationMessage: vi.fn(),
    showWarningMessage: vi.fn(),
    showQuickPick: vi.fn(),
    withProgress: vi.fn(async (_options: unknown, task: (progress: unknown, token: unknown) => unknown) =>
      task({ report: vi.fn() }, { isCancellationRequested: false, onCancellationRequested: vi.fn() }),
    ),
    createOutputChannel: vi.fn(() => ({ appendLine: vi.fn(), show: vi.fn(), dispose: vi.fn() })),
    createWebviewPanel: vi.fn(),
    state: { focused: true },
    onDidChangeWindowState: vi.fn(() => ({ dispose: vi.fn() })),
    onDidChangeActiveTextEditor: vi.fn(() => ({ dispose: vi.fn() })),
  },
  workspace: {
    getConfiguration: vi.fn(() => ({
      get: vi.fn((key: string, fallback?: unknown) => (key in state.settings ? state.settings[key] : fallback)),
      update: vi.fn(async (key: string, value: unknown, target?: unknown) => {
        state.settingUpdates.push({ key, value, target });
        state.settings[key] = value;
      }),
      inspect: vi.fn(),
    })),
    onDidChangeConfiguration: vi.fn(() => ({ dispose: vi.fn() })),
  },
  ConfigurationTarget: { Global: 1, Workspace: 2, WorkspaceFolder: 3 },
  commands: { registerCommand: vi.fn(() => ({ dispose: vi.fn() })), executeCommand: vi.fn() },
  Uri: { file: vi.fn((fsPath: string) => ({ fsPath, scheme: 'file' })), joinPath: vi.fn() },
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
import { mockServer, startMockServer, stopMockServer, clearUnhandledRequests } from '../test/mocks/server';
import { mockInstance } from '../test/mocks/data/instances';
import { logger } from '../logger';
import type { ConfigManager } from '../config';
import type { AiCompletionResult, AiModelInfo, AiModelTransport } from '../ai/transport';
import type { AiTransportSelection } from '../ai/modelSelection';
import { OpenAiCompatibleTransport } from '../ai/openAiCompatibleTransport';
import type { AiProviderConfig } from '../ai/modelSettings';
import {
  NOTIFICATION_SUMMARY_MAX_CHARACTERS,
  NOTIFICATION_SUMMARY_SCOPE_BUTTON_BODY_ONLY,
  NOTIFICATION_SUMMARY_SCOPE_BUTTON_CANCEL,
  NOTIFICATION_SUMMARY_SCOPE_BUTTON_COMMENTS,
  NOTIFICATION_SUMMARY_SCOPE_BUTTON_EVENTS,
  buildNotificationSummarySystemPrompt,
  summarizeNotification,
} from '../notificationSummary';
import {
  isNotificationSummaryEnabled,
  notificationSummaryPromptScopeSettingValue,
  writeNotificationSummaryPromptScopeSetting,
} from '../notificationSummarySettings';

beforeAll(async () => {
  await startMockServer();
});

afterAll(() => {
  stopMockServer();
});

const config = { getInstances: () => [mockInstance] } as unknown as ConfigManager;

/** The target every case submits: one issue of the mock instance. */
function target(overrides: Record<string, unknown> = {}) {
  return {
    instanceId: mockInstance.id,
    owner: 'demo-user',
    repo: 'demo-repo',
    index: 1,
    type: 'issue' as const,
    ...overrides,
  };
}

const EDITOR_MODEL: AiModelInfo = { vendor: 'copilot', id: 'gpt-4o', name: 'GPT-4o' };

interface FakeTransport extends AiModelTransport {
  availability: Mock<AiModelTransport['availability']>;
  listModels: Mock<AiModelTransport['listModels']>;
  countTokens: Mock<AiModelTransport['countTokens']>;
  complete: Mock<AiModelTransport['complete']>;
}

function fakeTransport(options: {
  text?: string;
  parts?: AiCompletionResult['parts'];
  completeError?: unknown;
  truncated?: boolean;
  countTokensError?: unknown;
}): FakeTransport {
  return {
    id: 'vscode.lm',
    availability: vi.fn<AiModelTransport['availability']>(async () => ({ usable: true as const })),
    listModels: vi.fn<AiModelTransport['listModels']>(async () => [EDITOR_MODEL]),
    countTokens: vi.fn<AiModelTransport['countTokens']>(async () => {
      if (options.countTokensError !== undefined) {
        throw options.countTokensError;
      }
      return undefined;
    }),
    complete: vi.fn<AiModelTransport['complete']>(async (model) => {
      if (options.completeError !== undefined) {
        throw options.completeError;
      }
      const parts = options.parts ?? [
        { kind: 'text' as const, text: options.text ?? 'The discussion settled on a fix.' },
      ];
      return { model, parts, ...(options.truncated === true ? { truncated: true } : {}) };
    }),
  };
}

function editorSelection(transport: FakeTransport): AiTransportSelection {
  return { kind: 'vscode-lm', transport, reason: 'the editor offers models' };
}

/** A configured endpoint with no credentials, for the cases that pin the direct path. */
const DIRECT_PROVIDER: AiProviderConfig = {
  id: 'local-gateway',
  name: 'Local Gateway',
  baseUrl: 'http://localhost:11434/v1',
  models: [{ id: 'qwen3', name: 'Qwen3' }],
  auth: 'none',
  headers: [],
};

const NO_SECRETS = {
  get: async () => undefined,
  store: async () => undefined,
  delete: async () => undefined,
};

/**
 * A catch-all recorder: **every** request that reaches the mock server is pushed here
 * (and answered with a failure, so a run that made one could not continue as if it had
 * succeeded). Handlers installed after it win for their own path and record there too,
 * so "nothing left the machine" is provable from both directions.
 */
function recordEveryRequest(): string[] {
  const seen: string[] = [];
  mockServer.use(
    http.all('*://*/*', ({ request }) => {
      seen.push(`${request.method} ${new URL(request.url).pathname}`);
      return new HttpResponse(null, { status: 500 });
    }),
  );
  return seen;
}

/** The timeline the run reads, with the request recorded. */
function serveTimeline(rows: unknown[], seen?: string[]): void {
  mockServer.use(
    http.get('*://*/api/v1/repos/:owner/:repo/issues/:index/timeline', ({ request }) => {
      seen?.push(new URL(request.url).pathname);
      return HttpResponse.json(rows as never);
    }),
  );
}

/** The issue/pull-request record the skeleton and the first body come from. */
function serveRecord(record: unknown, seen?: string[]): void {
  mockServer.use(
    http.get('*://*/api/v1/repos/:owner/:repo/issues/:index', ({ request }) => {
      seen?.push(new URL(request.url).pathname);
      return HttpResponse.json(record as never);
    }),
  );
}

const ISSUE = {
  id: 1,
  number: 1,
  title: 'Fix login bug',
  state: 'open',
  body: 'Users cannot log in when 2FA is enabled.',
  created_at: '2026-08-15T10:00:00Z',
  updated_at: '2026-08-17T10:00:00Z',
};

const COMMENT_ROW = {
  id: 50,
  type: 'comment',
  body: 'This belongs to the token refresh path.',
  user: { login: 'other-user' },
  created_at: '2026-08-17T09:00:00Z',
};

const EVENT_ROW = {
  id: 51,
  user: { login: 'maintainer' },
  label: { name: 'bug' },
  created_at: '2026-08-17T10:00:00Z',
};

/** Everything the logger was handed, so a run's own account of itself is readable. */
function loggedText(): string {
  return [logger.debug, logger.info, logger.error]
    .flatMap((method) => vi.mocked(method).mock.calls.map((call) => String(call[0])))
    .join('\n');
}

/**
 * Installs the progress runner the run works inside.
 *
 * Re-installed for every case (not only in the module factory) because a case that
 * overrides the token would otherwise leave its implementation in place for the next.
 */
function useProgressToken(isCancellationRequested: boolean): void {
  vi.mocked(vscode.window.withProgress).mockImplementation(((
    _options: unknown,
    run: (progress: unknown, token: unknown) => unknown,
  ) => run({ report: vi.fn() }, { isCancellationRequested, onCancellationRequested: vi.fn() })) as never);
}

beforeEach(() => {
  state.settings = {};
  state.settingUpdates = [];
  state.selectionCalls = [];
  state.selection = undefined;
  clearUnhandledRequests();
  vi.clearAllMocks();
  vi.spyOn(logger, 'debug');
  vi.spyOn(logger, 'info');
  vi.spyOn(logger, 'error');
  state.settings['notificationSummary'] = true;
  state.settings['notificationSummaryPromptScope'] = 'body-and-comments';
  vi.mocked(vscode.window.showInformationMessage).mockResolvedValue(undefined as never);
  useProgressToken(false);
  vi.mocked(vscode.window.showQuickPick).mockImplementation(async (items) => {
    const list = items as unknown as Array<{ model?: unknown }>;
    return list[0] as never;
  });
});

afterEach(() => {
  mockServer.resetHandlers();
  vi.restoreAllMocks();
});

describe('the notification-summary settings', () => {
  it('reads the feature switch as off unless it is explicitly true', () => {
    // The shared `beforeEach` installs this feature's switch so the run cases do not have
    // to; this case is about the reader, so it starts from nothing configured.
    state.settings = {};
    expect(isNotificationSummaryEnabled()).toBe(false);
    for (const value of [true, 1, 'true', {}, []]) {
      state.settings['notificationSummary'] = value;
      expect(isNotificationSummaryEnabled(), String(value)).toBe(value === true);
    }
  });

  it('reads the scope as ask unless it is one of the contributed values', () => {
    state.settings = {};
    expect(notificationSummaryPromptScopeSettingValue()).toBe('ask');
    for (const value of ['nonsense', '', 42, undefined, {}]) {
      state.settings['notificationSummaryPromptScope'] = value;
      expect(notificationSummaryPromptScopeSettingValue(), String(value)).toBe('ask');
    }
    state.settings['notificationSummaryPromptScope'] = '  Body-Only ';
    expect(notificationSummaryPromptScopeSettingValue()).toBe('body-only');
    state.settings['notificationSummaryPromptScope'] = 'body-comments-and-events';
    expect(notificationSummaryPromptScopeSettingValue()).toBe('body-comments-and-events');
  });

  it('writes a stated scope at global scope, so every later run finds the answer', async () => {
    await writeNotificationSummaryPromptScopeSetting('body-and-comments');

    expect(state.settingUpdates).toEqual([
      {
        key: 'notificationSummaryPromptScope',
        value: 'body-and-comments',
        target: vscode.ConfigurationTarget.Global,
      },
    ]);
  });
});

describe('the notification-summary run fail-closed gates', () => {
  it('reads nothing, requests nothing and writes nothing while the consent question is unanswered', async () => {
    // The design's fail-closed arm (§5): with the setting still the question and the
    // modal dismissed, the run ends with **zero** reads — not just zero model calls.
    state.settings['notificationSummaryPromptScope'] = 'ask';
    const requests = recordEveryRequest();
    const timelineReads: string[] = [];
    const recordReads: string[] = [];
    serveTimeline([COMMENT_ROW], timelineReads);
    serveRecord(ISSUE, recordReads);
    const transport = fakeTransport({});
    state.selection = editorSelection(transport);
    vi.mocked(vscode.window.showInformationMessage).mockResolvedValue(undefined as never);

    const payload = await summarizeNotification(config, target(), {});

    expect(payload.outcome).toBe('no-scope');
    // No request of any kind: the catch-all records every transport's path, and the two
    // readings the run would have made are installed behind it.
    expect(requests).toEqual([]);
    expect(recordReads).toEqual([]);
    expect(timelineReads).toEqual([]);
    expect(transport.complete).not.toHaveBeenCalled();
    expect(transport.countTokens).not.toHaveBeenCalled();
    // The model was chosen before the question — that is what lets the question name the
    // destination — and the editor's own model list is a lookup, not a request.
    expect(state.selectionCalls.map((call) => call.feature)).toEqual(['notificationSummary']);
    expect(transport.listModels).toHaveBeenCalledTimes(1);
    // An unanswered question is not an answer.
    expect(state.settingUpdates).toEqual([]);
    expect(loggedText()).toContain('was not answered');
    // Nothing about a run that never started is asserted to the panel.
    expect(payload.scope).toBeUndefined();
    expect(payload.model).toBeUndefined();
    expect(payload.transport).toBeUndefined();
    expect(payload.answer).toBeUndefined();
  });

  it('treats the cancel button exactly like a dismissed modal', async () => {
    state.settings['notificationSummaryPromptScope'] = 'ask';
    const requests = recordEveryRequest();
    const transport = fakeTransport({});
    state.selection = editorSelection(transport);
    vi.mocked(vscode.window.showInformationMessage).mockResolvedValue(
      NOTIFICATION_SUMMARY_SCOPE_BUTTON_CANCEL as never,
    );

    const payload = await summarizeNotification(config, target(), {});

    expect(payload.outcome).toBe('no-scope');
    expect(requests).toEqual([]);
    expect(transport.complete).not.toHaveBeenCalled();
    expect(state.settingUpdates).toEqual([]);
  });

  it('never asks an endpoint for anything before the answer, not even its model list', async () => {
    // The record's §7.2 rule for the direct path, measured on a **real** transport: the
    // binding names the model, so §7.1's sentence is written from settings and the run
    // must not reach for `/models` or `/chat/completions` before consent.
    state.settings['notificationSummaryPromptScope'] = 'ask';
    state.settings['aiProviders'] = [DIRECT_PROVIDER];
    const requests = recordEveryRequest();
    const transport = new OpenAiCompatibleTransport({ provider: DIRECT_PROVIDER, secrets: NO_SECRETS });
    const complete = vi.spyOn(transport, 'complete');
    const listModels = vi.spyOn(transport, 'listModels');
    state.selection = {
      kind: 'openai-compatible',
      transport,
      model: { vendor: DIRECT_PROVIDER.id, id: 'qwen3', name: 'Qwen3' },
      reason: 'bound',
    } satisfies AiTransportSelection;

    const payload = await summarizeNotification(config, target(), {});

    expect(payload.outcome).toBe('no-scope');
    expect(requests).toEqual([]);
    expect(complete).not.toHaveBeenCalled();
    expect(listModels).not.toHaveBeenCalled();
  });

  it('refuses before reading anything while the feature switch is off', async () => {
    state.settings['notificationSummary'] = false;
    const requests = recordEveryRequest();
    const timelineReads: string[] = [];
    serveTimeline([COMMENT_ROW], timelineReads);
    const transport = fakeTransport({});
    state.selection = editorSelection(transport);

    const payload = await summarizeNotification(config, target(), {});

    expect(payload.outcome).toBe('unavailable');
    expect(payload.failure).toContain('forgejoToolkit.notificationSummary');
    // Off means off: not even the model is chosen, and nothing is read or requested.
    expect(state.selectionCalls).toEqual([]);
    expect(transport.complete).not.toHaveBeenCalled();
    expect(requests).toEqual([]);
    expect(timelineReads).toEqual([]);
    expect(state.settingUpdates).toEqual([]);
  });

  it('reads nothing and requests nothing when no model is available', async () => {
    const requests = recordEveryRequest();
    const timelineReads: string[] = [];
    serveTimeline([COMMENT_ROW], timelineReads);
    state.selection = { kind: 'unavailable', code: 'no-model', reason: 'the editor offers no chat model' };

    const payload = await summarizeNotification(config, target(), {});

    expect(payload.outcome).toBe('unavailable');
    expect(payload.failure).toContain('the editor offers no chat model');
    // The whole point of the arm: a pointer to the page that can fix it.
    expect(payload.failure).toContain('Settings');
    expect(requests).toEqual([]);
    expect(timelineReads).toEqual([]);
    expect(state.settingUpdates).toEqual([]);
  });

  it('reports an editor that lists no model without reading anything', async () => {
    const requests = recordEveryRequest();
    const timelineReads: string[] = [];
    serveTimeline([COMMENT_ROW], timelineReads);
    const transport = fakeTransport({});
    transport.listModels.mockResolvedValue([]);
    state.selection = editorSelection(transport);

    const payload = await summarizeNotification(config, target(), {});

    expect(payload.outcome).toBe('unavailable');
    expect(payload.failure).toContain('no chat model');
    expect(requests).toEqual([]);
    expect(timelineReads).toEqual([]);
    expect(transport.complete).not.toHaveBeenCalled();
  });

  it('treats a dismissed model picker as a cancelled run', async () => {
    const requests = recordEveryRequest();
    const timelineReads: string[] = [];
    serveTimeline([COMMENT_ROW], timelineReads);
    const transport = fakeTransport({});
    state.selection = editorSelection(transport);
    vi.mocked(vscode.window.showQuickPick).mockResolvedValue(undefined as never);

    const payload = await summarizeNotification(config, target(), {});

    expect(payload.outcome).toBe('cancelled');
    expect(requests).toEqual([]);
    expect(timelineReads).toEqual([]);
    // The picker is not the consent question: nothing is written for a dismissed pick.
    expect(state.settingUpdates).toEqual([]);
  });

  it('reports a missing instance without reading or requesting anything', async () => {
    const requests = recordEveryRequest();
    const transport = fakeTransport({});
    state.selection = editorSelection(transport);

    const payload = await summarizeNotification(config, target({ instanceId: 'no-such-instance' }), {});

    expect(payload.outcome).toBe('unavailable');
    expect(payload.failure).toContain('Forgejo instance not found');
    expect(state.selectionCalls).toEqual([]);
    expect(requests).toEqual([]);
  });
});

describe('the notification-summary run material', () => {
  it('calls no model when the timeline is empty', async () => {
    // §7: an empty timeline is "there is no discussion to summarise", not "ask the model
    // about the first post" — the panel says so and no model is called.
    const timelineReads: string[] = [];
    serveRecord(ISSUE);
    serveTimeline([], timelineReads);
    const transport = fakeTransport({});
    state.selection = editorSelection(transport);

    const payload = await summarizeNotification(config, target(), {});

    expect(payload.outcome).toBe('empty');
    // The timeline endpoint is paged until an empty page arrives, so the same path may be
    // requested more than once; what matters is that it was the discussion read.
    expect(new Set(timelineReads)).toEqual(new Set(['/api/v1/repos/demo-user/demo-repo/issues/1/timeline']));
    expect(transport.complete).not.toHaveBeenCalled();
    expect(transport.countTokens).not.toHaveBeenCalled();
    expect(payload.answer).toBeUndefined();
  });

  it('calls no model when the chosen tier has nothing sendable in it', async () => {
    // `body-only` sends the first post and nothing from the timeline: with no first post
    // and an events-only timeline there is nothing to send, so the run stops before the
    // model rather than sending a prompt about nothing.
    serveRecord({ ...ISSUE, body: '' });
    serveTimeline([EVENT_ROW]);
    const transport = fakeTransport({});
    state.selection = editorSelection(transport);
    state.settings['notificationSummaryPromptScope'] = 'body-only';

    const payload = await summarizeNotification(config, target(), {});

    expect(payload.outcome).toBe('empty');
    expect(payload.failure).toContain('body-only');
    expect(transport.complete).not.toHaveBeenCalled();
  });

  it('calls no model when a comments tier has only events and no first post', async () => {
    serveRecord({ ...ISSUE, body: '' });
    serveTimeline([EVENT_ROW]);
    const transport = fakeTransport({});
    state.selection = editorSelection(transport);
    state.settings['notificationSummaryPromptScope'] = 'body-and-comments';

    const payload = await summarizeNotification(config, target(), {});

    expect(payload.outcome).toBe('empty');
    expect(transport.complete).not.toHaveBeenCalled();
  });

  it('sends the first post and the skeleton under body-only, and no comment', async () => {
    serveRecord(ISSUE);
    serveTimeline([COMMENT_ROW, EVENT_ROW]);
    const transport = fakeTransport({ text: 'A short summary.' });
    state.selection = editorSelection(transport);
    state.settings['notificationSummaryPromptScope'] = 'body-only';

    const payload = await summarizeNotification(config, target(), {});

    expect(payload.outcome).toBe('answer');
    expect(payload.answer).toBe('A short summary.');
    expect(payload.scope).toBe('body-only');
    expect(payload.truncated).toBe(false);
    const request = transport.complete.mock.calls[0]?.[1];
    expect(request?.messages[0]?.text).toContain('Users cannot log in when 2FA is enabled.');
    expect(request?.messages[0]?.text).not.toContain('This belongs to the token refresh path.');
    // The skeleton the design names: repository, type and number, title, state, update.
    expect(request?.messages[0]?.text).toContain('Repository: demo-user/demo-repo');
    expect(request?.messages[0]?.text).toContain('Kind: issue #1');
    expect(request?.messages[0]?.text).toContain('Title: Fix login bug');
    expect(request?.messages[0]?.text).toContain('State: open');
    expect(request?.messages[0]?.text).toContain('Updated: 2026-08-17T10:00:00Z');
  });

  it('adds the comments under the recommended tier, and the events only under the widest', async () => {
    serveRecord(ISSUE);
    serveTimeline([COMMENT_ROW, EVENT_ROW]);
    const transport = fakeTransport({});
    state.selection = editorSelection(transport);
    state.settings['notificationSummaryPromptScope'] = 'body-comments-and-events';

    const payload = await summarizeNotification(config, target(), {});

    expect(payload.outcome).toBe('answer');
    const request = transport.complete.mock.calls[0]?.[1];
    expect(request?.messages[0]?.text).toContain('This belongs to the token refresh path.');
    expect(request?.messages[0]?.text).toContain('added the label "bug"');
  });

  it('says so in the prompt and in the header when the material had to be cut', async () => {
    serveRecord(ISSUE);
    // Thirty entries at the per-entry cap: the head and the tail cannot both hold them,
    // so the middle really is omitted and the prompt has to say so (§3.3).
    serveTimeline(
      Array.from({ length: 30 }, (_, index) => ({
        id: 100 + index,
        type: 'comment',
        body: `comment-${index} ${'x'.repeat(980)}`,
        user: { login: `user-${index}` },
        created_at: '2026-08-17T09:00:00Z',
      })),
    );
    const transport = fakeTransport({});
    state.selection = editorSelection(transport);
    state.settings['notificationSummaryPromptScope'] = 'body-comments-and-events';

    const payload = await summarizeNotification(config, target(), {});

    expect(payload.outcome).toBe('answer');
    expect(payload.truncated).toBe(true);
    expect(transport.complete.mock.calls[0]?.[1].messages[0]?.text).toMatch(/entries between these two parts/);
  });

  it('has the first body read from the record, and reports a record that could not be read', async () => {
    mockServer.use(
      http.get('*://*/api/v1/repos/:owner/:repo/issues/:index', () => new HttpResponse(null, { status: 500 })),
    );
    const timelineReads: string[] = [];
    serveTimeline([COMMENT_ROW], timelineReads);
    const transport = fakeTransport({});
    state.selection = editorSelection(transport);

    const payload = await summarizeNotification(config, target(), {});

    expect(payload.outcome).toBe('read-failed');
    expect(payload.failure).toContain('could not be read');
    expect(transport.complete).not.toHaveBeenCalled();
  });

  it('reports a timeline read that threw, with zero model calls', async () => {
    serveRecord(ISSUE);
    mockServer.use(
      http.get('*://*/api/v1/repos/:owner/:repo/issues/:index/timeline', () => new HttpResponse(null, { status: 500 })),
    );
    const transport = fakeTransport({});
    state.selection = editorSelection(transport);

    const payload = await summarizeNotification(config, target(), {});

    expect(payload.outcome).toBe('read-failed');
    expect(payload.failure).toContain('could not be read');
    expect(transport.complete).not.toHaveBeenCalled();
    expect(transport.countTokens).not.toHaveBeenCalled();
    expect(payload.scope).toBe('body-and-comments');
  });
});

describe('the notification-summary run answer', () => {
  it('refuses an answer longer than the cap instead of trimming it', async () => {
    serveRecord(ISSUE);
    serveTimeline([COMMENT_ROW]);
    const overLong = 'x'.repeat(NOTIFICATION_SUMMARY_MAX_CHARACTERS + 1);
    const transport = fakeTransport({ text: overLong });
    state.selection = editorSelection(transport);

    const payload = await summarizeNotification(config, target(), {});

    expect(payload.outcome).toBe('too-long');
    // Refused, not trimmed: the over-long prose is nowhere in the payload, and no
    // shortened version of it is passed off as a summary.
    expect(payload.answer ?? '').toBe('');
    expect(JSON.stringify(payload)).not.toContain(overLong.slice(0, 200));
    expect(payload.failure).toContain(String(NOTIFICATION_SUMMARY_MAX_CHARACTERS));
    expect(transport.complete).toHaveBeenCalledTimes(1);
  });

  it('accepts an answer exactly at the cap', async () => {
    serveRecord(ISSUE);
    serveTimeline([COMMENT_ROW]);
    const transport = fakeTransport({ text: 'y'.repeat(NOTIFICATION_SUMMARY_MAX_CHARACTERS) });
    state.selection = editorSelection(transport);

    const payload = await summarizeNotification(config, target(), {});

    expect(payload.outcome).toBe('answer');
    expect(payload.answer).toHaveLength(NOTIFICATION_SUMMARY_MAX_CHARACTERS);
  });

  it('reports an endpoint that stopped the answer at its own output limit', async () => {
    serveRecord(ISSUE);
    serveTimeline([COMMENT_ROW]);
    const transport = fakeTransport({ text: 'A partial answer', truncated: true });
    state.selection = editorSelection(transport);

    const payload = await summarizeNotification(config, target(), {});

    expect(payload.outcome).toBe('answer');
    expect(payload.answer).toBe('A partial answer');
    // The panel header and the body both say the answer may be incomplete.
    expect(payload.truncated).toBe(true);
    expect(payload.model).toEqual({ name: 'GPT-4o', vendor: 'copilot', id: 'gpt-4o' });
    expect(payload.transport).toMatchObject({ kind: 'vscode.lm', provider: 'copilot' });
  });

  it('prefers the first candidate stream that carries text, and never joins two', async () => {
    serveRecord(ISSUE);
    serveTimeline([COMMENT_ROW]);
    const transport = fakeTransport({
      parts: [
        { kind: 'text', text: '   ' },
        { kind: 'reasoning', text: 'The reasoning stream holds the summary.' },
      ],
    });
    state.selection = editorSelection(transport);

    const payload = await summarizeNotification(config, target(), {});

    expect(payload.answer).toBe('The reasoning stream holds the summary.');
  });

  it('refuses to present an answer no stream carried any text for', async () => {
    serveRecord(ISSUE);
    serveTimeline([COMMENT_ROW]);
    const transport = fakeTransport({ parts: [{ kind: 'text', text: '  ' }] });
    state.selection = editorSelection(transport);

    const payload = await summarizeNotification(config, target(), {});

    expect(payload.outcome).toBe('refused');
    expect(payload.answer).toBeUndefined();
    expect(payload.failure).toContain('nothing');
  });

  it('reports a refused chat model in its own words, without switching or retrying', async () => {
    serveRecord(ISSUE);
    serveTimeline([COMMENT_ROW]);
    const transport = fakeTransport({ completeError: new Error('NoPermissions') });
    state.selection = editorSelection(transport);

    const payload = await summarizeNotification(config, target(), {});

    expect(payload.outcome).toBe('refused');
    expect(payload.failure).toContain('Permission to use the chat model was not granted');
    expect(transport.complete).toHaveBeenCalledTimes(1);
  });

  it('reports an endpoint failure by name and tries nothing else', async () => {
    serveRecord(ISSUE);
    serveTimeline([COMMENT_ROW]);
    const transport = fakeTransport({ completeError: new Error('the endpoint refused the request') });
    state.selection = editorSelection(transport);

    const payload = await summarizeNotification(config, target(), {});

    expect(payload.outcome).toBe('refused');
    expect(payload.failure).toContain('the endpoint refused the request');
    expect(transport.complete).toHaveBeenCalledTimes(1);
  });

  it('reports a cancelled model call as cancelled', async () => {
    serveRecord(ISSUE);
    serveTimeline([COMMENT_ROW]);
    const cancelled = Object.assign(new Error('cancelled'), { name: 'AbortError' });
    const transport = fakeTransport({ completeError: cancelled });
    state.selection = editorSelection(transport);

    const payload = await summarizeNotification(config, target(), {});

    expect(payload.outcome).toBe('cancelled');
    expect(transport.complete).toHaveBeenCalledTimes(1);
    // A model was asked, so the header names it — and the page's standing sentence
    // ("cancelled before anything was read") would be false here, so the run states
    // where it stopped instead.
    expect(payload.model).toEqual({ name: 'GPT-4o', vendor: 'copilot', id: 'gpt-4o' });
    expect(payload.failure).toContain('answering');
  });

  it('stops at a cancelled progress token without calling a model', async () => {
    serveRecord(ISSUE);
    serveTimeline([COMMENT_ROW]);
    const transport = fakeTransport({});
    state.selection = editorSelection(transport);
    useProgressToken(true);

    const payload = await summarizeNotification(config, target(), {});

    expect(payload.outcome).toBe('cancelled');
    expect(transport.complete).not.toHaveBeenCalled();
    // The reads had already happened by the time the token was seen, so the run says so
    // rather than letting the panel claim nothing had been read.
    expect(payload.scope).toBe('body-and-comments');
    expect(payload.failure).toContain('before the model was called');
  });

  it('refuses the run when the prompt cannot be measured', async () => {
    serveRecord(ISSUE);
    serveTimeline([COMMENT_ROW]);
    const transport = fakeTransport({ countTokensError: new Error('no tokenizer here') });
    state.selection = editorSelection(transport);

    const payload = await summarizeNotification(config, target(), {});

    expect(payload.outcome).toBe('refused');
    expect(payload.failure).toContain('would not measure');
    expect(transport.complete).not.toHaveBeenCalled();
  });

  it('refuses the run when the prompt does not fit the model input budget', async () => {
    serveRecord(ISSUE);
    serveTimeline([COMMENT_ROW]);
    const transport = fakeTransport({});
    transport.listModels.mockResolvedValue([{ ...EDITOR_MODEL, maxInputTokens: 1_000 }]);
    transport.countTokens.mockResolvedValue(2_000);
    state.selection = editorSelection(transport);

    const payload = await summarizeNotification(config, target(), {});

    expect(payload.outcome).toBe('refused');
    expect(payload.failure).toContain('input budget');
    expect(transport.complete).not.toHaveBeenCalled();
  });
});

describe('the notification-summary consent question', () => {
  it('writes the answered scope back and runs with it', async () => {
    state.settings['notificationSummaryPromptScope'] = 'ask';
    serveRecord(ISSUE);
    serveTimeline([COMMENT_ROW]);
    const transport = fakeTransport({});
    state.selection = editorSelection(transport);
    vi.mocked(vscode.window.showInformationMessage).mockResolvedValue(
      NOTIFICATION_SUMMARY_SCOPE_BUTTON_COMMENTS as never,
    );

    const payload = await summarizeNotification(config, target(), {});

    expect(state.settingUpdates).toEqual([
      { key: 'notificationSummaryPromptScope', value: 'body-and-comments', target: vscode.ConfigurationTarget.Global },
    ]);
    expect(payload.outcome).toBe('answer');
    expect(payload.scope).toBe('body-and-comments');
    expect(transport.complete.mock.calls[0]?.[1].messages[0]?.text).toContain(
      'This belongs to the token refresh path.',
    );
  });

  it('asks once, offering every tier and a cancel, and naming each answer', async () => {
    state.settings['notificationSummaryPromptScope'] = 'ask';
    serveRecord(ISSUE);
    serveTimeline([COMMENT_ROW]);
    const transport = fakeTransport({});
    state.selection = editorSelection(transport);
    vi.mocked(vscode.window.showInformationMessage).mockResolvedValue(
      NOTIFICATION_SUMMARY_SCOPE_BUTTON_BODY_ONLY as never,
    );

    await summarizeNotification(config, target(), {});

    const call = vi.mocked(vscode.window.showInformationMessage).mock.calls[0] as unknown as [
      string,
      unknown,
      ...string[],
    ];
    expect(call[1]).toEqual({ modal: true });
    expect(call.slice(2)).toEqual([
      NOTIFICATION_SUMMARY_SCOPE_BUTTON_BODY_ONLY,
      NOTIFICATION_SUMMARY_SCOPE_BUTTON_COMMENTS,
      NOTIFICATION_SUMMARY_SCOPE_BUTTON_EVENTS,
      NOTIFICATION_SUMMARY_SCOPE_BUTTON_CANCEL,
    ]);
    const message = call[0];
    // Every tier says what it would send, by its own button wording.
    expect(message).toContain(NOTIFICATION_SUMMARY_SCOPE_BUTTON_BODY_ONLY);
    expect(message).toContain(NOTIFICATION_SUMMARY_SCOPE_BUTTON_COMMENTS);
    expect(message).toContain(NOTIFICATION_SUMMARY_SCOPE_BUTTON_EVENTS);
    expect(message).toContain('the text of the first post');
    expect(message).toContain('the body of every comment');
    expect(message).toContain('one line of metadata per timeline event');
    // It says what is never sent, and where the answer is remembered.
    expect(message).toContain('access token');
    expect(message).toContain('URL or host name');
    expect(message).toContain('forgejoToolkit.notificationSummaryPromptScope');
    // The one thing this feature must say out loud: the material is not the reader's own.
    expect(message).toContain('not your own writing');
    expect(message).toContain('written by other people');
    // And the fail-closed promise.
    expect(message).toContain('cancelling sends nothing');
  });

  it('names a configured endpoint with its display name and address', async () => {
    state.settings['notificationSummaryPromptScope'] = 'ask';
    state.settings['aiProviders'] = [DIRECT_PROVIDER];
    serveRecord(ISSUE);
    serveTimeline([COMMENT_ROW]);
    const transport = new OpenAiCompatibleTransport({ provider: DIRECT_PROVIDER, secrets: NO_SECRETS });
    // The question this case is about is the modal's wording; the run continues to the
    // model afterwards, so the endpoint is answered in-process rather than reached.
    vi.spyOn(transport, 'complete').mockResolvedValue({
      model: { vendor: DIRECT_PROVIDER.id, id: 'qwen3', name: 'Qwen3' },
      parts: [{ kind: 'text', text: 'A local answer.' }],
    });
    state.selection = {
      kind: 'openai-compatible',
      transport,
      model: { vendor: DIRECT_PROVIDER.id, id: 'qwen3', name: 'Qwen3' },
      reason: 'bound',
    } satisfies AiTransportSelection;
    vi.mocked(vscode.window.showInformationMessage).mockResolvedValue(
      NOTIFICATION_SUMMARY_SCOPE_BUTTON_COMMENTS as never,
    );

    await summarizeNotification(config, target(), {});

    const message = String(vi.mocked(vscode.window.showInformationMessage).mock.calls[0]?.[0]);
    // §7.1's direct-path sentence: the display name **and** the address, both local data.
    expect(message).toContain('Local Gateway');
    expect(message).toContain('localhost:11434');
  });
});

describe('the notification-summary answer language', () => {
  it('asks for the answer in the language it is given, and changes nothing else', () => {
    // The rule is explicit in the block (`aiPreReviewCommentBodyLanguage` decides which
    // name goes in), and the language name is the **only** thing the parameter moves:
    // nothing else in the prompt follows the reader's locale.
    const english = buildNotificationSummarySystemPrompt('en');
    const chinese = buildNotificationSummarySystemPrompt('zh');

    expect(english.replace('English', '简体中文')).toBe(chinese);
    expect(english).not.toBe(chinese);
    expect(english).toMatch(/^.*Write the summary in English, whatever language the discussion is written in\..*$/m);
    expect(chinese).toMatch(/^.*Write the summary in 简体中文, whatever language the discussion is written in\..*$/m);
  });

  it('passes the resolved language into the request, from the setting and otherwise the editor', async () => {
    // The same resolution the pre-review and the description draft use: an explicit
    // `forgejoToolkit.locale` wins, and an unstated one falls to the editor's display
    // language (English in this suite's `vscode` mock).
    serveRecord(ISSUE);
    serveTimeline([COMMENT_ROW]);
    const transport = fakeTransport({});
    state.selection = editorSelection(transport);

    state.settings['locale'] = 'zh';
    await summarizeNotification(config, target(), {});
    expect(transport.complete.mock.calls[0]?.[1].system).toContain('Write the summary in 简体中文');

    delete state.settings['locale'];
    await summarizeNotification(config, target(), {});
    expect(transport.complete.mock.calls[1]?.[1].system).toContain('Write the summary in English');
    expect(transport.complete.mock.calls[1]?.[1].system).not.toContain('简体中文');
  });
});

describe('the notification-summary truncation reason', () => {
  // Thirty entries at the per-entry cap: the clipper cannot hold them all between the head
  // and the tail, so the **material** is genuinely cut (a small timeline never triggers it).
  const longTimeline = () =>
    Array.from({ length: 30 }, (_, index) => ({
      id: 200 + index,
      type: 'comment',
      body: `comment-${index} ${'x'.repeat(980)}`,
      user: { login: `user-${index}` },
      created_at: '2026-08-17T09:00:00Z',
    }));

  it('says the material was cut when only the discussion was trimmed', async () => {
    serveRecord(ISSUE);
    serveTimeline(longTimeline());
    const transport = fakeTransport({ text: 'A complete answer.' });
    state.selection = editorSelection(transport);

    const payload = await summarizeNotification(config, target(), {});

    expect(payload.outcome).toBe('answer');
    expect(payload.truncated).toBe(true);
    // The answer arrived whole — the endpoint reported no output-limit stop — so the panel
    // must not promise an incomplete summary.
    expect(payload.truncationReason).toBe('material');
    expect(transport.complete.mock.calls[0]?.[1].messages[0]?.text).toMatch(/entries between these two parts/);
  });

  it('says the answer was cut when only the endpoint stopped it', async () => {
    serveRecord(ISSUE);
    serveTimeline([COMMENT_ROW]);
    const transport = fakeTransport({ text: 'A partial answer', truncated: true });
    state.selection = editorSelection(transport);

    const payload = await summarizeNotification(config, target(), {});

    expect(payload.outcome).toBe('answer');
    expect(payload.truncated).toBe(true);
    expect(payload.truncationReason).toBe('answer');
  });

  it('says both when both were cut', async () => {
    serveRecord(ISSUE);
    serveTimeline(longTimeline());
    const transport = fakeTransport({ text: 'A partial answer', truncated: true });
    state.selection = editorSelection(transport);

    const payload = await summarizeNotification(config, target(), {});

    expect(payload.outcome).toBe('answer');
    expect(payload.truncated).toBe(true);
    expect(payload.truncationReason).toBe('material-and-answer');
  });

  it('leaves the reason absent when nothing was cut', async () => {
    serveRecord(ISSUE);
    serveTimeline([COMMENT_ROW]);
    const transport = fakeTransport({ text: 'A complete answer.' });
    state.selection = editorSelection(transport);

    const payload = await summarizeNotification(config, target(), {});

    expect(payload.outcome).toBe('answer');
    expect(payload.truncated).toBe(false);
    // Absent is the third state: "no run claimed a cut" and "a run claimed no cut" must not
    // be rendered as the same fact.
    expect(payload).not.toHaveProperty('truncationReason');
  });
});
