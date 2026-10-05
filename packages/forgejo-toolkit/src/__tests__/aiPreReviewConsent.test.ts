import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * The destination sentence of the one-time consent question
 * (`docs/design/ai-model-transport.md` §7.1).
 *
 * The record's judged property is that the sentence names **both** the display name
 * and the address when the content goes to a configured endpoint, and that the
 * `vscode.lm` wording is unchanged — a run that always went to a model the editor
 * offers must not start claiming an address it cannot know. Both halves are pinned
 * here through the two exported pieces the run is built from: the destination
 * derived from the chosen model, and the sentence composed from it.
 *
 * `vscode` is mocked with a settings record and an l10n `t` that substitutes its
 * placeholders, so the assertions read the composed sentence rather than the
 * bundle.
 */

const state = vi.hoisted(() => ({ settings: {} as Record<string, unknown> }));

vi.mock('vscode', () => ({
  workspace: {
    getConfiguration: vi.fn(() => ({
      get: vi.fn((key: string) => state.settings[key]),
      update: vi.fn(),
    })),
    onDidChangeConfiguration: vi.fn(() => ({ dispose: vi.fn() })),
  },
  window: {
    createOutputChannel: vi.fn(() => ({ appendLine: vi.fn(), show: vi.fn(), dispose: vi.fn() })),
    showInformationMessage: vi.fn(),
    showErrorMessage: vi.fn(),
    showWarningMessage: vi.fn(),
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

import { aiPreReviewConsentDestination, aiPreReviewPromptScopeMessage } from '../aiPreReview';
import type { AiModelInfo } from '../ai/transport';

const EDITOR_MODEL: AiModelInfo = { vendor: 'copilot', id: 'gpt-4o', name: 'GPT-4o', maxInputTokens: 128_000 };

beforeEach(() => {
  state.settings = {};
  vi.clearAllMocks();
});

describe('the consent destination', () => {
  it('keeps the editor model vendor and claims no address', () => {
    const destination = aiPreReviewConsentDestination(EDITOR_MODEL);

    expect(destination).toEqual({ name: 'copilot' });
    expect(destination.address).toBeUndefined();
  });

  it('names a configured endpoint display name and its address for a direct model', () => {
    // The seam builds a direct endpoint's models with `vendor` = the provider's id
    // (`src/ai/modelSelection.ts`), which is what makes this derivation exact.
    state.settings['aiProviders'] = [
      {
        id: 'ollama-local',
        name: 'Ollama (this machine)',
        baseUrl: 'http://localhost:11434/v1',
        models: [{ id: 'qwen3:8b', name: 'Qwen3 8B' }],
        auth: 'bearer',
        headers: [],
      },
    ];

    const destination = aiPreReviewConsentDestination({ vendor: 'ollama-local', id: 'qwen3:8b', name: 'Qwen3 8B' });

    expect(destination).toEqual({ name: 'Ollama (this machine)', address: 'http://localhost:11434/v1' });
  });

  it('renders the address without its query string, which can carry a secret', () => {
    state.settings['aiProviders'] = [
      {
        id: 'azure',
        name: 'Azure OpenAI',
        baseUrl: 'https://models.example.com/openai/v1?api-version=2024-10-21',
        models: [],
        auth: 'api-key-header',
        headers: [],
      },
    ];

    const destination = aiPreReviewConsentDestination({ vendor: 'azure', id: 'gpt-4o', name: 'gpt-4o' });

    expect(destination.address).toBe('https://models.example.com/openai/v1');
    expect(destination.address).not.toContain('2024-10-21');
  });

  it('answers "unknown" for a model that cannot name its provider', () => {
    expect(aiPreReviewConsentDestination({ vendor: '  ', id: 'x', name: '' })).toEqual({ name: 'unknown' });
  });
});

describe('the consent sentence', () => {
  it('is the editor wording alone when there is no address', () => {
    const message = aiPreReviewPromptScopeMessage({ name: 'copilot' });

    expect(
      message.startsWith(
        'Before this AI pre-review sends anything: the chat model you chose belongs to the "copilot" provider',
      ),
    ).toBe(true);
    // No address claim, and no second sentence about a configured endpoint.
    expect(message).not.toContain('would send this to the provider you configured');
    // The four things the question has to state are still there.
    expect(message).toContain('the prompt is the only thing that leaves this machine');
    expect(message).toContain('Nothing is requested or sent before you answer');
    expect(message).toContain('your answer is written into that setting so this question is asked only once');
  });

  it('leads with the provider and the address for a configured endpoint', () => {
    const message = aiPreReviewPromptScopeMessage({
      name: 'Ollama (this machine)',
      address: 'http://localhost:11434/v1',
    });

    expect(
      message.startsWith(
        'The AI pre-review would send this to the provider you configured, "Ollama (this machine)" at http://localhost:11434/v1.',
      ),
    ).toBe(true);
    // The destination is *added to* the body, not substituted for it: the scopes and
    // the fail-closed promise are the same words either way.
    expect(message).toContain(
      'Before this AI pre-review sends anything: the chat model you chose belongs to the "Ollama (this machine)" provider',
    );
    expect(message).toContain('"Send the changed files" sends the pull request title and branch names');
    expect(message).toContain('cancelling sends nothing and creates nothing');
  });
});
