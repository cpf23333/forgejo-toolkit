import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * The host side of the settings page's AI endpoint surface
 * (`docs/design/ai-model-transport.md` §8) — the module that enforces the three
 * boundaries the record draws for it:
 *
 * 1. **What is configuration and what is a secret** (§8.2). Nothing this module
 *    writes into `forgejoToolkit.aiProviders` can carry an API key or a header
 *    value, and the snapshot it builds reports only *whether* a secret is stored.
 *    The tests assert both halves from the stored settings and the secret store
 *    rather than from the reply alone.
 * 2. **A reading never fails activation** (§8.3). An entry a hand-edit broke is
 *    kept in the array and named in `rejected`, and an edit to another endpoint
 *    leaves it exactly as it was — a read-modify-write of the *parsed* list would
 *    silently delete it.
 * 3. **Reading sends nothing** (§7.2). `readAiProviderSettings` answers the §9.3
 *    capability question through `selectedModelFor`, which only lists models and
 *    reads secrets; the one probe that sends a request is reached from exactly one
 *    explicit click, and its report is asserted to carry no credential.
 *
 * `vscode` is mocked the same way `aiTestProvider.test.ts` mocks it: a settings
 * record the readers and the writers share, an l10n `t` that substitutes its
 * placeholders, and no editor of its own.
 */

const state = vi.hoisted(() => ({
  settings: {} as Record<string, unknown>,
  updates: [] as Array<{ key: string; value: unknown }>,
  secrets: new Map<string, string>(),
}));

vi.mock('vscode', () => ({
  workspace: {
    getConfiguration: vi.fn(() => ({
      get: vi.fn((key: string) => state.settings[key]),
      update: vi.fn(async (key: string, value: unknown) => {
        state.settings[key] = value;
        state.updates.push({ key, value });
      }),
    })),
    onDidChangeConfiguration: vi.fn(() => ({ dispose: vi.fn() })),
  },
  window: {
    createOutputChannel: vi.fn(() => ({ appendLine: vi.fn(), show: vi.fn(), dispose: vi.fn() })),
    showErrorMessage: vi.fn(),
    showInformationMessage: vi.fn(),
    showWarningMessage: vi.fn(),
    state: { focused: true },
    onDidChangeWindowState: vi.fn(() => ({ dispose: vi.fn() })),
  },
  commands: { registerCommand: vi.fn(() => ({ dispose: vi.fn() })), executeCommand: vi.fn() },
  ConfigurationTarget: { Global: 1, Workspace: 2, WorkspaceFolder: 3 },
  Uri: { file: vi.fn((fsPath: string) => ({ fsPath, scheme: 'file' })) },
  env: { language: 'en', openExternal: vi.fn() },
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

import { logger } from '../logger';
import {
  readAiProviderSettings,
  removeAiProvider,
  saveAiProvider,
  testAiProvider,
  validateAiProviderDraft,
  writeAiDefaultModel,
  writeAiModelBinding,
  writeAiModelPolicy,
  writeAiProviderSecret,
  type AiProviderSettingsDeps,
} from '../webview/aiProviderSettings';
import { aiProviderHeaderSecretKey, aiProviderKeySecretKey, type AiSecretStore } from '../ai/providerSecrets';
import type { AiModelInfo, AiModelTransport } from '../ai/transport';

const FIRST_ENTRY = {
  id: 'ollama-local',
  name: 'Ollama (this machine)',
  baseUrl: 'http://localhost:11434/v1',
  models: [{ id: 'qwen3:8b', name: 'Qwen3 8B' }],
  auth: 'bearer',
  headers: [{ name: 'api-version', valueSecret: true }],
};

/** A transport double, so the capability question needs no editor of its own. */
function editorTransport(models: AiModelInfo[]): AiModelTransport {
  return {
    id: 'vscode.lm',
    availability: async () => ({ usable: true }),
    listModels: async () => models,
    countTokens: async () => undefined,
    complete: async () => {
      throw new Error('not used');
    },
  };
}

const OFFERED_MODEL: AiModelInfo = { vendor: 'fake', id: 'fake-model', name: 'Fake Model', maxInputTokens: 128_000 };

function secretStore(entries: Record<string, string> = {}): AiSecretStore {
  const values = new Map(Object.entries(entries));
  state.secrets = values;
  return {
    get: async (key: string) => values.get(key),
    store: async (key: string, value: string) => {
      values.set(key, value);
    },
    delete: async (key: string) => {
      values.delete(key);
    },
  };
}

function deps(overrides: Partial<AiProviderSettingsDeps> = {}): AiProviderSettingsDeps {
  return {
    secrets: overrides.secrets ?? secretStore(),
    vscodeLm: overrides.vscodeLm ?? editorTransport([OFFERED_MODEL]),
  };
}

beforeEach(() => {
  state.settings = {};
  state.updates = [];
  state.secrets = new Map();
  vi.clearAllMocks();
  vi.spyOn(logger, 'debug').mockImplementation(() => undefined);
  vi.spyOn(logger, 'info').mockImplementation(() => undefined);
  vi.spyOn(logger, 'error').mockImplementation(() => undefined);
});

describe('the endpoint snapshot', () => {
  it('reports the stored-or-not state of every secret and never a value', async () => {
    state.settings['aiProviders'] = [FIRST_ENTRY];
    const secrets = secretStore({
      [aiProviderKeySecretKey('ollama-local')]: 'sk-a-real-key',
      [aiProviderHeaderSecretKey('ollama-local', 'api-version') ?? '']: '2024-10-21',
    });

    const snapshot = await readAiProviderSettings(deps({ secrets }));

    expect(snapshot.providers).toHaveLength(1);
    const entry = snapshot.providers[0]!;
    expect(entry.keySet).toBe(true);
    expect(entry.headers).toEqual([{ name: 'api-version', set: true, shadowed: false, queryCarried: true }]);
    // The address is rendered without its query string: `api-version`'s value is a
    // secret, and it is the one parameter this transport can add.
    expect(entry.address).toBe('http://localhost:11434/v1');
    expect(JSON.stringify(snapshot)).not.toContain('sk-a-real-key');
    expect(JSON.stringify(snapshot)).not.toContain('2024-10-21');
  });

  it('marks a header the auth style owns as shadowed, by name', async () => {
    state.settings['aiProviders'] = [{ ...FIRST_ENTRY, headers: [{ name: 'Authorization', valueSecret: true }] }];

    const snapshot = await readAiProviderSettings(deps());

    expect(snapshot.providers[0]?.headers[0]?.shadowed).toBe(true);
    expect(snapshot.providers[0]?.headers[0]?.set).toBe(false);
  });

  it('names an unreadable entry with its reason instead of dropping it', async () => {
    state.settings['aiProviders'] = [
      { id: 'broken entry', name: 'Broken', baseUrl: 'https://models.example.com/v1', auth: 'bearer' },
      { id: 'no-name', baseUrl: 'https://models.example.com/v1', auth: 'bearer' },
      { name: 'nameless-entry' },
    ];

    const snapshot = await readAiProviderSettings(deps());

    expect(snapshot.providers).toEqual([]);
    expect(snapshot.rejected.map((entry) => entry.index)).toEqual([0, 1, 2]);
    expect(snapshot.rejected[0]?.id).toBe('broken entry');
    expect(snapshot.rejected[0]?.reason).toContain('not a legal provider id');
    expect(snapshot.rejected[1]?.reason).toContain('no display name');
    // An entry that cannot even name itself is still named by its position.
    expect(snapshot.rejected[2]?.id).toBeUndefined();
  });

  it('marks the states a row has to warn about: insecure and refused', async () => {
    state.settings['aiProviders'] = [
      { ...FIRST_ENTRY, id: 'plain-http', baseUrl: 'http://models.example.com/v1' },
      { ...FIRST_ENTRY, id: 'not-a-url', baseUrl: 'file:///tmp/v1' },
    ];

    const snapshot = await readAiProviderSettings(deps());

    expect(snapshot.providers[0]?.insecure).toBe(true);
    expect(snapshot.providers[0]?.addressError).toBeUndefined();
    expect(snapshot.providers[1]?.addressError).toContain('file:');
    expect(snapshot.providers[1]?.insecure).toBe(false);
  });

  it('answers the capability question with the discriminator the page branches on', async () => {
    // The editor offers a model: available, and the path that answered is named so
    // the page can say what a request would use right now.
    await expect(readAiProviderSettings(deps())).resolves.toMatchObject({
      capability: { available: true },
      selection: 'editor',
    });

    // Nothing to offer and nothing configured: the two absences together.
    const emptyEditor = await readAiProviderSettings(deps({ vscodeLm: editorTransport([]) }));
    expect(emptyEditor.capability).toMatchObject({ available: false, code: 'no-model' });
    // An unavailable answer names no path, because none was selected.
    expect(emptyEditor.selection).toBe('none');

    // The global AI switch is off: nothing is asked for anything, and the answer
    // says so before any route of the table is consulted.
    state.settings['aiProviders'] = [FIRST_ENTRY];
    state.settings['aiEnabled'] = false;
    const switchedOff = await readAiProviderSettings(deps({ vscodeLm: editorTransport([]) }));
    expect(switchedOff.capability).toMatchObject({ available: false, code: 'ai-off' });

    // Two endpoints and no binding: which one would receive the content is exactly
    // the ambiguity a binding exists to remove.
    state.settings['aiEnabled'] = true;
    state.settings['aiProviders'] = [FIRST_ENTRY, { ...FIRST_ENTRY, id: 'second' }];
    const ambiguous = await readAiProviderSettings(deps({ vscodeLm: editorTransport([]) }));
    expect(ambiguous.capability).toMatchObject({ available: false, code: 'bind' });
  });

  it('reports the default destination, and names the direct path when it is the one that answers', async () => {
    // No default configured: the pair is empty, which is what a fresh install and
    // every configuration written before the pair existed report. The selection then
    // falls back to the single-endpoint rule, which is the behaviour it had before.
    const withoutDefault = await readAiProviderSettings(deps({ vscodeLm: editorTransport([]) }));
    expect(withoutDefault.defaultModel).toEqual({ providerId: '', modelId: '' });
    expect(withoutDefault.selection).toBe('none');

    state.settings['aiProviders'] = [FIRST_ENTRY];
    state.settings['aiDefaultProvider'] = 'ollama-local';
    state.settings['aiDefaultModel'] = 'qwen3:8b';

    // The endpoint's key is stored, so the direct route can actually serve the run.
    const secrets = secretStore({ [aiProviderKeySecretKey('ollama-local')]: 'sk-a-real-key' });
    const snapshot = await readAiProviderSettings(deps({ secrets, vscodeLm: editorTransport([]) }));

    expect(snapshot.defaultModel).toEqual({ providerId: 'ollama-local', modelId: 'qwen3:8b' });
    expect(snapshot.capability).toEqual({ available: true });
    expect(snapshot.selection).toBe('configured-endpoint');
  });

  it('reads a half-configured default as no default rather than inventing the missing half', async () => {
    // A hand-edited `settings.json` can hold one key without the other; the direct
    // path may not guess a model for an endpoint (§8.4), so the pair reads as absent
    // and the feature falls back to the rules it used before the pair existed.
    state.settings['aiDefaultProvider'] = 'ollama-local';
    await expect(readAiProviderSettings(deps())).resolves.toMatchObject({
      defaultModel: { providerId: '', modelId: '' },
    });

    state.settings = { aiDefaultModel: 'qwen3:8b' };
    await expect(readAiProviderSettings(deps())).resolves.toMatchObject({
      defaultModel: { providerId: '', modelId: '' },
    });
  });
});

describe('saving one endpoint', () => {
  it('stores the configuration and no secret at all', async () => {
    const secrets = secretStore();
    const result = await saveAiProvider(deps({ secrets }), {
      id: 'ollama-local',
      name: '  Ollama (this machine)  ',
      baseUrl: ' http://localhost:11434/v1 ',
      models: [{ id: 'qwen3:8b', name: '' }],
      auth: 'bearer',
      headers: ['api-version'],
    });

    expect(result).toEqual({ ok: true });
    expect(state.settings['aiProviders']).toEqual([
      {
        id: 'ollama-local',
        name: 'Ollama (this machine)',
        baseUrl: 'http://localhost:11434/v1',
        // A model with no display name keeps the id rather than losing the model.
        models: [{ id: 'qwen3:8b', name: 'qwen3:8b' }],
        auth: 'bearer',
        // Only the name is configuration; the marker is what a receiver of an
        // unencrypted export is told (§10.2).
        headers: [{ name: 'api-version', valueSecret: true }],
      },
    ]);
    expect(state.secrets.size).toBe(0);
  });

  it('replaces the entry with the same id and leaves an unreadable entry alone', async () => {
    state.settings['aiProviders'] = [
      { id: 'broken entry', name: 'Broken', baseUrl: 'https://models.example.com/v1', auth: 'bearer' },
      FIRST_ENTRY,
    ];

    const result = await saveAiProvider(deps(), {
      id: 'ollama-local',
      name: 'Renamed',
      baseUrl: 'https://codeberg.org/v1',
      models: [],
      auth: 'none',
      headers: [],
    });

    expect(result).toEqual({ ok: true });
    const stored = state.settings['aiProviders'] as unknown[];
    expect(stored).toHaveLength(2);
    // The entry this build cannot read is untouched: an edit elsewhere in the list
    // must not delete a hand-written entry.
    expect(stored[0]).toMatchObject({ id: 'broken entry' });
    expect(stored[1]).toMatchObject({ id: 'ollama-local', name: 'Renamed', auth: 'none' });
  });

  it('drops a header value a payload tries to smuggle into settings', async () => {
    await saveAiProvider(deps(), {
      id: 'sneaky',
      name: 'Sneaky',
      baseUrl: 'https://models.example.com/v1',
      models: [],
      auth: 'bearer',
      // The typed payload carries names; a compromised webview could send objects.
      headers: [{ name: 'api-version', value: 'sk-smuggled' }] as unknown as string[],
    });

    expect(JSON.stringify(state.settings['aiProviders'])).not.toContain('sk-smuggled');
  });

  it('refuses the drafts the reader would refuse', () => {
    const base = {
      id: 'good-id',
      name: 'Name',
      baseUrl: 'https://models.example.com/v1',
      models: [{ id: 'm', name: '' }],
      auth: 'bearer',
      headers: ['api-version'],
    };
    expect(validateAiProviderDraft(base)).toBeUndefined();
    expect(validateAiProviderDraft({ ...base, id: '' })).toContain('id is required');
    expect(validateAiProviderDraft({ ...base, id: 'has space' })).toContain('letters, digits');
    expect(validateAiProviderDraft({ ...base, name: '  ' })).toContain('display name is required');
    expect(validateAiProviderDraft({ ...base, baseUrl: '' })).toContain('base URL is required');
    expect(validateAiProviderDraft({ ...base, baseUrl: 'javascript:alert(1)' })).toContain(
      'endpoint base URL cannot be used',
    );
    expect(validateAiProviderDraft({ ...base, auth: 'basic' })).toContain('authentication style');
    expect(validateAiProviderDraft({ ...base, models: [{ id: '', name: '' }] })).toContain('model needs an id');
    expect(
      validateAiProviderDraft({
        ...base,
        models: [
          { id: 'm', name: '' },
          { id: 'm', name: 'again' },
        ],
      }),
    ).toContain('declared twice');
    expect(validateAiProviderDraft({ ...base, headers: ['api-version', 'api-version'] })).toContain('declared twice');
    expect(validateAiProviderDraft({ ...base, headers: ['bad name'] })).toContain('header name may use');
  });
});

describe('storing one secret', () => {
  beforeEach(() => {
    state.settings['aiProviders'] = [FIRST_ENTRY];
  });

  it('stores and clears the API key without touching settings', async () => {
    const secrets = secretStore();

    expect(await writeAiProviderSecret(deps({ secrets }), 'ollama-local', undefined, 'sk-key')).toEqual({
      ok: true,
      set: true,
    });
    expect(state.secrets.get(aiProviderKeySecretKey('ollama-local'))).toBe('sk-key');
    expect(state.updates).toEqual([]);

    expect(await writeAiProviderSecret(deps({ secrets }), 'ollama-local', undefined, '')).toEqual({
      ok: true,
      set: false,
    });
    expect(state.secrets.get(aiProviderKeySecretKey('ollama-local'))).toBeUndefined();
  });

  it('stores a declared header value and refuses an undeclared one', async () => {
    const secrets = secretStore();

    expect(await writeAiProviderSecret(deps({ secrets }), 'ollama-local', 'api-version', '2024-10-21')).toEqual({
      ok: true,
      set: true,
    });
    expect(state.secrets.get(aiProviderHeaderSecretKey('ollama-local', 'api-version') ?? '')).toBe('2024-10-21');

    const refused = await writeAiProviderSecret(deps({ secrets }), 'ollama-local', 'x-not-declared', 'v');
    expect(refused).toMatchObject({ ok: false });
    expect(refused.ok === false && refused.error).toContain('does not declare a header');
  });

  it('refuses an orphan secret for an endpoint that is not configured', async () => {
    const result = await writeAiProviderSecret(deps(), 'gone', undefined, 'sk-key');
    expect(result).toMatchObject({ ok: false });
    expect(result.ok === false && result.error).toContain('No AI endpoint with the id "gone" is configured');
  });
});

describe('removing one endpoint', () => {
  it('removes the entry and forgets every secret stored for it', async () => {
    state.settings['aiProviders'] = [FIRST_ENTRY, { ...FIRST_ENTRY, id: 'other' }];
    const secrets = secretStore({
      [aiProviderKeySecretKey('ollama-local')]: 'sk-a',
      [aiProviderHeaderSecretKey('ollama-local', 'api-version') ?? '']: 'v',
      [aiProviderKeySecretKey('other')]: 'sk-b',
    });

    expect(await removeAiProvider(deps({ secrets }), 'ollama-local')).toEqual({ ok: true });

    expect(state.settings['aiProviders']).toEqual([{ ...FIRST_ENTRY, id: 'other' }]);
    expect(state.secrets.get(aiProviderKeySecretKey('ollama-local'))).toBeUndefined();
    expect(state.secrets.get(aiProviderHeaderSecretKey('ollama-local', 'api-version') ?? '')).toBeUndefined();
    // Another endpoint's credential is not touched.
    expect(state.secrets.get(aiProviderKeySecretKey('other'))).toBe('sk-b');
  });

  it('refuses an id that is not configured, and leaves the bindings alone', async () => {
    state.settings['aiProviders'] = [FIRST_ENTRY];
    state.settings['aiModelBindings'] = [{ feature: 'aiPreReview', providerId: 'ollama-local', modelId: 'qwen3:8b' }];

    expect(await removeAiProvider(deps(), 'ollama-local')).toEqual({ ok: true });
    // The binding is not rewritten: §8.4 requires a run to fail by name rather than
    // be resolved to a neighbour, and a silently dropped binding would hide that.
    expect(state.settings['aiModelBindings']).toEqual([
      { feature: 'aiPreReview', providerId: 'ollama-local', modelId: 'qwen3:8b' },
    ]);

    const again = await removeAiProvider(deps(), 'ollama-local');
    expect(again).toMatchObject({ ok: false });
  });
});

describe('the model policy', () => {
  it('writes only the values that differ, at global scope', async () => {
    state.settings['aiTransport'] = 'auto';
    state.settings['aiModelRequestTimeoutMs'] = 30_000;

    const result = await writeAiModelPolicy(deps(), {
      transport: 'openai-compatible',
      requestTimeoutMs: 45_000,
    });

    expect(result).toEqual({ ok: true });
    expect(state.updates).toEqual([
      { key: 'aiTransport', value: 'openai-compatible' },
      { key: 'aiModelRequestTimeoutMs', value: 45_000 },
    ]);
  });

  it('writes nothing when the values already match', async () => {
    state.settings['aiTransport'] = 'auto';
    state.settings['aiModelRequestTimeoutMs'] = 30_000;

    expect(await writeAiModelPolicy(deps(), { transport: 'auto', requestTimeoutMs: 30_000 })).toEqual({ ok: true });
    expect(state.updates).toEqual([]);
  });

  it('refuses a transport the manifest does not contribute and a timeout out of range', async () => {
    const badTransport = await writeAiModelPolicy(deps(), {
      transport: 'anthropic',
      requestTimeoutMs: 30_000,
    });
    expect(badTransport).toMatchObject({ ok: false });

    const badTimeout = await writeAiModelPolicy(deps(), {
      transport: 'auto',
      requestTimeoutMs: 0,
    });
    expect(badTimeout).toMatchObject({ ok: false });
    expect(badTimeout.ok === false && badTimeout.error).toContain('1000');
    expect(state.updates).toEqual([]);
  });
});

describe('the per-feature bindings', () => {
  beforeEach(() => {
    state.settings['aiProviders'] = [FIRST_ENTRY];
  });

  it('stores a binding, clears it, and keeps an unknown feature verbatim', async () => {
    state.settings['aiModelBindings'] = [{ feature: 'fromANewerBuild', providerId: 'x', modelId: 'y' }];

    expect(
      await writeAiModelBinding(deps(), { feature: 'aiPreReview', providerId: 'ollama-local', modelId: 'qwen3:8b' }),
    ).toEqual({ ok: true });
    expect(state.settings['aiModelBindings']).toEqual([
      { feature: 'fromANewerBuild', providerId: 'x', modelId: 'y' },
      { feature: 'aiPreReview', providerId: 'ollama-local', modelId: 'qwen3:8b' },
    ]);

    expect(await writeAiModelBinding(deps(), { feature: 'aiPreReview', providerId: '', modelId: '' })).toEqual({
      ok: true,
    });
    expect(state.settings['aiModelBindings']).toEqual([{ feature: 'fromANewerBuild', providerId: 'x', modelId: 'y' }]);
  });

  it('refuses an unknown feature, an unconfigured endpoint and a missing model', async () => {
    expect((await writeAiModelBinding(deps(), { feature: 'nope', providerId: 'ollama-local', modelId: 'm' })).ok).toBe(
      false,
    );
    expect((await writeAiModelBinding(deps(), { feature: 'aiPreReview', providerId: 'gone', modelId: 'm' })).ok).toBe(
      false,
    );
    const noModel = await writeAiModelBinding(deps(), {
      feature: 'aiPreReview',
      providerId: 'ollama-local',
      modelId: '',
    });
    expect(noModel).toMatchObject({ ok: false });
    expect(state.settings['aiModelBindings']).toBeUndefined();
  });
});

describe('the default destination', () => {
  beforeEach(() => {
    state.settings['aiProviders'] = [FIRST_ENTRY];
  });

  it('stores the pair as its own two settings, and clears both', async () => {
    expect(await writeAiDefaultModel(deps(), { providerId: 'ollama-local', modelId: 'qwen3:8b' })).toEqual({
      ok: true,
    });
    // Two flat keys, not an entry in the bindings array: the default is the thing
    // the per-feature overrides sit on top of, and a pseudo-feature inside that
    // array would make `feature` mean two things at once (§8.4).
    expect(state.updates).toEqual([
      { key: 'aiDefaultProvider', value: 'ollama-local' },
      { key: 'aiDefaultModel', value: 'qwen3:8b' },
    ]);
    expect(state.settings['aiModelBindings']).toBeUndefined();

    state.updates = [];
    expect(await writeAiDefaultModel(deps(), { providerId: '', modelId: '' })).toEqual({ ok: true });
    expect(state.updates).toEqual([
      { key: 'aiDefaultProvider', value: '' },
      { key: 'aiDefaultModel', value: '' },
    ]);
  });

  it('refuses a half-configured pair instead of guessing the other half', async () => {
    const withoutModel = await writeAiDefaultModel(deps(), { providerId: 'ollama-local', modelId: '' });
    expect(withoutModel).toMatchObject({ ok: false });
    expect(withoutModel.ok === false && withoutModel.error).toContain('both');

    const withoutProvider = await writeAiDefaultModel(deps(), { providerId: '', modelId: 'qwen3:8b' });
    expect(withoutProvider).toMatchObject({ ok: false });
    // Nothing was written at all: a refused default is not a half-written one.
    expect(state.updates).toEqual([]);
  });

  it('fails by name when the default names an endpoint that is not configured', async () => {
    const refused = await writeAiDefaultModel(deps(), { providerId: 'deleted-gateway', modelId: 'qwen3:8b' });

    expect(refused).toMatchObject({ ok: false });
    expect(refused.ok === false && refused.error).toContain('deleted-gateway');
    expect(state.updates).toEqual([]);
  });
});

describe('the endpoint probe', () => {
  it('answers nothing for an id that is not configured, so the caller can say so', async () => {
    await expect(testAiProvider(deps(), 'gone')).resolves.toBeUndefined();
  });

  it('reports a local validation refusal without sending anything', async () => {
    state.settings['aiProviders'] = [{ ...FIRST_ENTRY, baseUrl: 'file:///tmp/v1' }];

    const report = await testAiProvider(deps(), 'ollama-local');

    expect(report).toMatchObject({ ok: false, ran: false, providerId: 'ollama-local' });
    expect(report?.reason).toContain('file:');
    expect(report?.shadowed).toEqual([]);
    // The address is still named: "nothing was sent" is only useful with the place
    // it was not sent to.
    expect(report?.address).toBe('file:///tmp/v1');
  });

  it('names the headers the auth style shadows, without their values', async () => {
    state.settings['aiProviders'] = [
      {
        ...FIRST_ENTRY,
        headers: [
          { name: 'api-version', valueSecret: true },
          { name: 'authorization', valueSecret: true },
        ],
      },
    ];
    const secrets = secretStore({
      [aiProviderKeySecretKey('ollama-local')]: 'sk-key',
      [aiProviderHeaderSecretKey('ollama-local', 'api-version') ?? '']: 'secret-version',
      [aiProviderHeaderSecretKey('ollama-local', 'authorization') ?? '']: 'secret-auth',
    });

    const report = await testAiProvider(deps({ secrets }), 'ollama-local');

    // The mocked editor has no endpoint: the probe fails to reach it, which is the
    // failure this case is not about — the shadowed names and the absent secrets are.
    expect(report?.shadowed).toEqual(['authorization']);
    expect(JSON.stringify(report)).not.toContain('sk-key');
    expect(JSON.stringify(report)).not.toContain('secret-version');
    expect(JSON.stringify(report)).not.toContain('secret-auth');
  });
});
