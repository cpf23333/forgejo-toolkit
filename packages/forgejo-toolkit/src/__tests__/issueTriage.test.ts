import { describe, it, expect, vi, beforeEach, afterEach, beforeAll, afterAll, type Mock } from 'vitest';

/**
 * The host half of "suggest labels for an issue".
 *
 * The model transport is faked (through `selectedModelFor`) rather than reached over
 * HTTP, because what these cases are about is the run's **decisions**: whether the
 * issue was read at all before the consent question was answered, which scope's
 * material was fetched, and what the answer became once it was resolved against the
 * repository's own lists. The reads go through the real client against the shared
 * mock handlers, so "zero requests" is measured on a real request path.
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
import { mockLabel } from '../test/mocks/data/issueExtras';
import { logger } from '../logger';
import type { ConfigManager } from '../config';
import type { AiCompletionResult, AiModelInfo, AiModelTransport } from '../ai/transport';
import type { AiTransportSelection } from '../ai/modelSelection';
import { aiPreReviewPromptText } from '../aiPreReviewBrief';
import {
  ISSUE_TRIAGE_SCOPE_BUTTON_COMMENTS,
  ISSUE_TRIAGE_SCOPE_BUTTON_ISSUE_ONLY,
  suggestIssueTriage,
} from '../issueTriage';
import {
  issueTriagePromptScopeSettingValue,
  issueTriageScopeHonourableOn,
  issueTriageScopesForSurface,
  isIssueTriageEnabled,
} from '../issueTriageSettings';

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
  answer?: string;
  parts?: AiCompletionResult['parts'];
  completeError?: unknown;
  truncated?: boolean;
}): FakeTransport {
  return {
    id: 'vscode.lm',
    availability: vi.fn<AiModelTransport['availability']>(async () => ({ usable: true as const })),
    listModels: vi.fn<AiModelTransport['listModels']>(async () => [EDITOR_MODEL]),
    countTokens: vi.fn<AiModelTransport['countTokens']>(async () => undefined),
    complete: vi.fn<AiModelTransport['complete']>(async (model) => {
      if (options.completeError !== undefined) {
        throw options.completeError;
      }
      const parts = options.parts ?? [{ kind: 'text' as const, text: options.answer ?? '{"labels": []}' }];
      return { model, parts, ...(options.truncated === true ? { truncated: true } : {}) };
    }),
  };
}

function editorSelection(transport: FakeTransport): AiTransportSelection {
  return { kind: 'vscode-lm', transport, reason: 'the editor offers models' };
}

/** A JSON answer the contract accepts, resolved against the shared mock fixtures. */
const ANSWER = '{"labels": ["bug"]}';

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
  vi.clearAllMocks();
  vi.spyOn(logger, 'debug');
  vi.spyOn(logger, 'info');
  vi.spyOn(logger, 'error');
  vi.mocked(vscode.window.showQuickPick).mockImplementation(async (items) => {
    const list = items as unknown as Array<{ model?: unknown }>;
    return list[0] as never;
  });
  // The consent modal is not defaulted to an answer: a case that expects a run to
  // proceed states the scope in the settings, and a case that is about consent
  // installs its own answer.
  vi.mocked(vscode.window.showInformationMessage).mockResolvedValue(undefined as never);
});

afterEach(() => {
  mockServer.resetHandlers();
  vi.restoreAllMocks();
});

describe('the issue-triage settings', () => {
  it('reads the feature switch as off unless it is explicitly true', () => {
    expect(isIssueTriageEnabled()).toBe(false);
    for (const value of [true, 1, 'true', {}, []]) {
      state.settings['issueTriage'] = value;
      expect(isIssueTriageEnabled(), String(value)).toBe(value === true);
    }
  });

  it('reads the scope as ask unless it is one of the contributed values', () => {
    expect(issueTriagePromptScopeSettingValue()).toBe('ask');
    for (const value of ['nonsense', '', 42, undefined, {}]) {
      state.settings['issueTriagePromptScope'] = value;
      expect(issueTriagePromptScopeSettingValue(), String(value)).toBe('ask');
    }
    state.settings['issueTriagePromptScope'] = '  Issue-Only ';
    expect(issueTriagePromptScopeSettingValue()).toBe('issue-only');
    state.settings['issueTriagePromptScope'] = 'issue-and-comments';
    expect(issueTriagePromptScopeSettingValue()).toBe('issue-and-comments');
  });

  it('states which scopes the one surface can honour', () => {
    // The predicate the consent modal and the run both read: a stated scope outside
    // this set fails by name rather than running with less than the user chose.
    expect(issueTriageScopesForSurface('issue-detail')).toEqual(['issue-only', 'issue-and-comments']);
    expect(issueTriageScopeHonourableOn('issue-detail', 'issue-only')).toBe(true);
    expect(issueTriageScopeHonourableOn('issue-detail', 'issue-and-comments')).toBe(true);
  });
});

describe('the issue-triage run', () => {
  it('refuses before reading anything while the feature switch is off', async () => {
    state.settings['issueTriage'] = false;
    const asked: string[] = [];
    mockServer.use(
      http.get('*://*/api/v1/repos/:owner/:repo/issues/:index', ({ request }) => {
        asked.push(new URL(request.url).pathname);
        return HttpResponse.json({});
      }),
    );
    const transport = fakeTransport({});
    state.selection = editorSelection(transport);

    const outcome = await suggestIssueTriage(config, target(), {});

    expect(outcome.kind).toBe('failed');
    expect((outcome as { error: string }).error).toContain('forgejoToolkit.issueTriage');
    expect(state.selectionCalls).toEqual([]);
    expect(transport.complete).not.toHaveBeenCalled();
    expect(asked).toEqual([]);
  });

  it('reads nothing and calls no model while the consent question is unanswered', async () => {
    // The record's §4: with the scope still the question and the modal dismissed,
    // the run ends with **zero** reads — not just zero model calls.
    state.settings['issueTriage'] = true;
    state.settings['issueTriagePromptScope'] = 'ask';
    const asked: string[] = [];
    mockServer.use(
      http.get('*://*/api/v1/repos/:owner/:repo/issues/:index', ({ request }) => {
        asked.push(new URL(request.url).pathname);
        return HttpResponse.json({});
      }),
    );
    const transport = fakeTransport({});
    state.selection = editorSelection(transport);
    vi.mocked(vscode.window.showInformationMessage).mockResolvedValue(undefined as never);

    const outcome = await suggestIssueTriage(config, target(), {});

    expect(outcome).toEqual({ kind: 'cancelled' });
    expect(asked).toEqual([]);
    expect(transport.complete).not.toHaveBeenCalled();
    expect(transport.countTokens).not.toHaveBeenCalled();
    // The setting is left as the question: an unanswered question is not an answer.
    expect(state.settingUpdates).toEqual([]);
    expect(loggedText()).toContain('was not answered');
    expect(unhandledRequests()).toEqual([]);
  });

  it('writes the answered scope back, then reads the issue and the label list', async () => {
    state.settings['issueTriage'] = true;
    state.settings['issueTriagePromptScope'] = 'ask';
    const asked: string[] = [];
    // The recorded wrapper answers with the shared fixture, so the run resolves the
    // answer onto a real candidate while the case can still see which endpoints were
    // read.
    mockServer.use(
      http.get('*://*/api/v1/repos/:owner/:repo/labels', ({ request }) => {
        asked.push(new URL(request.url).pathname);
        return HttpResponse.json([mockLabel]);
      }),
    );
    const transport = fakeTransport({ answer: ANSWER });
    state.selection = editorSelection(transport);
    vi.mocked(vscode.window.showInformationMessage).mockResolvedValue(ISSUE_TRIAGE_SCOPE_BUTTON_ISSUE_ONLY as never);

    const outcome = await suggestIssueTriage(config, target(), {});

    expect(state.settingUpdates).toEqual([
      { key: 'issueTriagePromptScope', value: 'issue-only', target: vscode.ConfigurationTarget.Global },
    ]);
    // The label list was read (a paged list may be requested more than once) and
    // **nothing else**: the assignable logins are not part of this feature any more.
    expect(new Set(asked)).toEqual(new Set(['/api/v1/repos/demo-user/demo-repo/labels']));
    // The answer resolves onto the repository's own fixture: the label the mock declares
    // (id 1, "bug").
    expect(outcome).toEqual({
      kind: 'ok',
      suggestions: expect.objectContaining({
        labels: [{ id: 1, name: 'bug', color: 'ff0000' }],
        dropped: [],
        scope: 'issue-only',
      }),
    });
    const request = transport.complete.mock.calls[0]?.[1];
    expect(request?.messages[0]?.text).toContain('[labels]');
    expect(request?.messages[0]?.text).not.toContain('[assignees]');
    expect(request?.messages[0]?.text).not.toContain('[discussion]');
    expect(unhandledRequests()).toEqual([]);
  });

  it('sends the instruction block once, and measures exactly what it sends', async () => {
    // 2026-10-06, found by the verifier's loopback capture: the seam request used to
    // carry the joined text as its user message *and* the instruction block as `system`,
    // so both transports put the instructions on the wire twice while the budget was
    // measured on one copy. The run must hand the transport the two parts apart — joining
    // them is the transport's own business — and the text it measured has to be the text
    // the transport renders from those parts.
    state.settings['issueTriage'] = true;
    state.settings['issueTriagePromptScope'] = 'issue-only';
    // A model with an input budget and a tokenizer, so the run takes the `exact` path and
    // really measures the text it is about to send (the estimated path counts UTF-8 bytes
    // of the same string, which is a different assertion about a different helper).
    const transport = fakeTransport({ answer: ANSWER });
    transport.countTokens.mockResolvedValue(500);
    transport.listModels.mockResolvedValue([{ ...EDITOR_MODEL, maxInputTokens: 8_000 }]);
    state.selection = editorSelection(transport);

    await suggestIssueTriage(config, target(), {});

    const request = transport.complete.mock.calls[0]?.[1];
    expect(request?.system).toBeTruthy();
    // The user message is the brief alone: the instruction block is not repeated inside
    // it. (`[labels]` is the brief's own section header, not the instructions.)
    expect(request?.messages).toHaveLength(1);
    expect(request?.messages[0]?.text).not.toContain('Answer with one JSON object');

    // What the editor transport renders from those two parts — the same joining rule the
    // OpenAI-compatible transport applies by sending `system` as its own message.
    const block = String(request?.system);
    const effective = aiPreReviewPromptText(block, request?.messages.map((message) => message.text).join('\n\n') ?? '');
    expect(effective.split(block)).toHaveLength(2);
    // And the budget was measured on exactly that text, not on something shorter. The
    // run measures the instruction block first (to pick a budget mode) and the whole
    // text second, so the second call is the one that decides.
    const measured = transport.countTokens.mock.calls.map((call) => call[1]);
    expect(measured).toContain(effective);
    expect(measured.at(-1)).toBe(effective);
  });

  it('reads the discussion only under the scope that promises it', async () => {
    state.settings['issueTriage'] = true;
    state.settings['issueTriagePromptScope'] = 'issue-and-comments';
    const asked: string[] = [];
    mockServer.use(
      http.get('*://*/api/v1/repos/:owner/:repo/issues/:index/timeline', ({ request }) => {
        asked.push(new URL(request.url).pathname);
        return HttpResponse.json([
          {
            id: 50,
            type: 'comment',
            body: 'Thanks for the report, this is a duplicate.',
            user: { login: 'other-user' },
            created_at: '2026-08-17T09:00:00Z',
          },
        ]);
      }),
    );
    const transport = fakeTransport({ answer: '{"labels": []}' });
    state.selection = editorSelection(transport);

    const outcome = await suggestIssueTriage(config, target(), {});

    expect(outcome.kind).toBe('ok');
    // The timeline endpoint is paged until an empty page arrives, so the same path
    // is requested more than once; what matters is that it was the discussion read
    // and nothing else.
    expect(new Set(asked)).toEqual(new Set(['/api/v1/repos/demo-user/demo-repo/issues/1/timeline']));
    const request = transport.complete.mock.calls[0]?.[1];
    expect(request?.messages[0]?.text).toContain('[discussion]');
    expect(request?.messages[0]?.text).toContain('Thanks for the report, this is a duplicate.');
    expect(request?.messages[0]?.text).toContain('@other-user');
    expect(unhandledRequests()).toEqual([]);
  });

  it('does not fetch the discussion under issue-only', async () => {
    state.settings['issueTriage'] = true;
    state.settings['issueTriagePromptScope'] = 'issue-only';
    const asked: string[] = [];
    mockServer.use(
      http.get('*://*/api/v1/repos/:owner/:repo/issues/:index/timeline', ({ request }) => {
        asked.push(new URL(request.url).pathname);
        return HttpResponse.json([]);
      }),
    );
    const transport = fakeTransport({ answer: '{"labels": []}' });
    state.selection = editorSelection(transport);

    await suggestIssueTriage(config, target(), {});

    expect(asked).toEqual([]);
    expect(unhandledRequests()).toEqual([]);
  });

  it('makes no request and calls no model when no model is available', async () => {
    state.settings['issueTriage'] = true;
    state.settings['issueTriagePromptScope'] = 'issue-only';
    state.selection = { kind: 'unavailable', code: 'no-model', reason: 'the editor offers no chat model' };

    const outcome = await suggestIssueTriage(config, target(), {});

    expect(outcome.kind).toBe('failed');
    const error = (outcome as { error: string }).error;
    expect(error).toContain('Settings page');
    expect(error).toContain('the editor offers no chat model');
    expect(unhandledRequests()).toEqual([]);
    expect(vscode.window.showWarningMessage).toHaveBeenCalledTimes(1);
  });

  it('reports an answer that is not the contracted JSON without producing suggestions', async () => {
    state.settings['issueTriage'] = true;
    state.settings['issueTriagePromptScope'] = 'issue-only';
    const transport = fakeTransport({ answer: 'Sure! Here are the labels you asked for.' });
    state.selection = editorSelection(transport);

    const outcome = await suggestIssueTriage(config, target(), {});

    expect(outcome.kind).toBe('failed');
    const error = (outcome as { error: string }).error;
    expect(error).toContain('the answer was not JSON');
    expect(error).toContain('no other model was tried');
    expect(transport.complete).toHaveBeenCalledTimes(1);
    expect(loggedText()).toContain('nothing was written');
  });

  it('reports a truncated endpoint answer alongside the contract failure', async () => {
    state.settings['issueTriage'] = true;
    state.settings['issueTriagePromptScope'] = 'issue-only';
    const transport = fakeTransport({ answer: '{"labels": ["bug"]', truncated: true });
    state.selection = editorSelection(transport);

    const outcome = await suggestIssueTriage(config, target(), {});

    expect(outcome.kind).toBe('failed');
    expect((outcome as { error: string }).error).toContain('output limit');
  });

  it('returns only what resolves, with the refusals counted', async () => {
    state.settings['issueTriage'] = true;
    state.settings['issueTriagePromptScope'] = 'issue-only';
    const transport = fakeTransport({ answer: '{"labels": ["bug", "Bug", "not-a-label"]}' });
    state.selection = editorSelection(transport);

    const outcome = await suggestIssueTriage(config, target(), {});

    expect(outcome.kind).toBe('ok');
    const suggestions = (outcome as { suggestions: { labels: unknown[]; dropped: unknown[] } }).suggestions;
    expect(suggestions.labels).toEqual([{ id: 1, name: 'bug', color: 'ff0000' }]);
    expect(suggestions.dropped).toEqual([{ reason: 'label-not-in-repository', count: 2 }]);
  });

  it('refuses in its own words when the repository declares no label at all', async () => {
    // The page hides the action for such a repository (§3.2), so this is the guard for a
    // view rendered before the repository lost its labels: it must say so and send
    // nothing, never prompt a model with an empty candidate set.
    state.settings['issueTriage'] = true;
    state.settings['issueTriagePromptScope'] = 'issue-only';
    mockServer.use(http.get('*://*/api/v1/repos/:owner/:repo/labels', () => HttpResponse.json([])));
    const transport = fakeTransport({ answer: '{"labels": ["bug"]}' });
    state.selection = editorSelection(transport);

    const outcome = await suggestIssueTriage(config, target(), {});

    expect(outcome.kind).toBe('failed');
    expect((outcome as { error: string }).error).toContain('declares no label');
    expect(transport.complete).not.toHaveBeenCalled();
    expect(transport.countTokens).not.toHaveBeenCalled();
    expect(loggedText()).toContain('nothing to suggest');
  });

  it('reports the label list that could not be read, without calling a model', async () => {
    state.settings['issueTriage'] = true;
    state.settings['issueTriagePromptScope'] = 'issue-only';
    mockServer.use(http.get('*://*/api/v1/repos/:owner/:repo/labels', () => new HttpResponse('nope', { status: 500 })));
    const transport = fakeTransport({});
    state.selection = editorSelection(transport);

    const outcome = await suggestIssueTriage(config, target(), {});

    expect(outcome.kind).toBe('failed');
    expect((outcome as { error: string }).error).toContain('labels could not be read');
    expect(transport.complete).not.toHaveBeenCalled();
    expect(unhandledRequests()).toEqual([]);
  });

  it('reports a refused chat model in its own words', async () => {
    state.settings['issueTriage'] = true;
    state.settings['issueTriagePromptScope'] = 'issue-only';
    const transport = fakeTransport({ completeError: new Error('NoPermissions') });
    state.selection = editorSelection(transport);

    const outcome = await suggestIssueTriage(config, target(), {});

    expect(outcome.kind).toBe('failed');
    expect((outcome as { error: string }).error).toContain('Permission to use the chat model was not granted');
    expect(transport.complete).toHaveBeenCalledTimes(1);
  });

  it('uses a reasoning candidate that holds the contracted JSON', async () => {
    state.settings['issueTriage'] = true;
    state.settings['issueTriagePromptScope'] = 'issue-only';
    const transport = fakeTransport({
      parts: [
        { kind: 'text', text: 'I will now decide.' },
        { kind: 'reasoning', text: ANSWER },
      ],
    });
    state.selection = editorSelection(transport);

    const outcome = await suggestIssueTriage(config, target(), {});

    expect(outcome.kind).toBe('ok');
    expect((outcome as { suggestions: { labels: unknown[] } }).suggestions.labels).toEqual([
      { id: 1, name: 'bug', color: 'ff0000' },
    ]);
  });

  it('offers exactly the answers the surface can serve', async () => {
    state.settings['issueTriage'] = true;
    state.settings['issueTriagePromptScope'] = 'ask';
    const transport = fakeTransport({ answer: ANSWER });
    state.selection = editorSelection(transport);
    vi.mocked(vscode.window.showInformationMessage).mockResolvedValue(ISSUE_TRIAGE_SCOPE_BUTTON_COMMENTS as never);

    const outcome = await suggestIssueTriage(config, target(), {});

    expect(outcome.kind).toBe('ok');
    const call = vi.mocked(vscode.window.showInformationMessage).mock.calls[0] as unknown as [
      string,
      unknown,
      ...string[],
    ];
    expect(call[1]).toEqual({ modal: true });
    expect(call.slice(2)).toEqual([
      ISSUE_TRIAGE_SCOPE_BUTTON_ISSUE_ONLY,
      ISSUE_TRIAGE_SCOPE_BUTTON_COMMENTS,
      'Cancel — send nothing',
    ]);
    // The sentence has to name the label list, the discussion and the destination — and
    // must **not** promise the list of assignable logins, which this feature no longer
    // reads or sends.
    expect(call[0]).toContain('repository label list');
    expect(call[0]).toContain('Also send the discussion');
    expect(call[0]).toContain('access token');
    expect(call[0]).not.toContain('logins');
    expect(call[0]).not.toContain('assigned');
  });
});
