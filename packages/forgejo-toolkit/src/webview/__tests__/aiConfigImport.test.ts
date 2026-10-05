import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ExportAiConfig } from '@cpf23333-forgejo-toolkit/shared/webview/messages';

/**
 * The AI half of export/import (`docs/design/ai-model-transport.md` §10).
 *
 * The two halves of this module answer two different questions and are tested for
 * both:
 *
 * 1. **What the file may carry.** `parseAiImportedAiConfig` is a whitelist: every
 *    field is rebuilt from what it is, an unknown key is dropped rather than
 *    forwarded into `settings.json`, and an entry that is not a provider at all is
 *    refused. The secrets block is parsed just as strictly, because the id and the
 *    header name in it become parts of a `SecretStorage` key.
 * 2. **What an import may change.** Every test here drives a *synthetic* credential
 *    through the module and asserts it reaches `SecretStorage` and nothing else —
 *    the values never appear in `settings`, and they are never written to the log.
 *
 * The end-to-end half (the export writing a file, the preview reading it back, and
 * the confirmation applying it) is in `viewProviderDispatch.test.ts`, where both
 * halves meet.
 */

const state = vi.hoisted(() => ({
  settings: {} as Record<string, unknown>,
  writes: [] as Array<{ key: string; value: unknown }>,
  logged: [] as string[],
}));

vi.mock('vscode', () => ({
  workspace: {
    getConfiguration: vi.fn(() => ({
      get: vi.fn((key: string, fallback?: unknown) => (key in state.settings ? state.settings[key] : fallback)),
      update: vi.fn(async (key: string, value: unknown) => {
        state.settings[key] = value;
        state.writes.push({ key, value });
      }),
    })),
    onDidChangeConfiguration: vi.fn(() => ({ dispose: vi.fn() })),
  },
  window: {
    createOutputChannel: vi.fn(() => ({
      appendLine: (line: string) => state.logged.push(line),
      show: vi.fn(),
      dispose: vi.fn(),
    })),
    showErrorMessage: vi.fn(),
    showWarningMessage: vi.fn(),
  },
  ConfigurationTarget: { Global: 1, Workspace: 2, WorkspaceFolder: 3 },
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

import {
  aiConfigHasContent,
  applyAiImport,
  buildAiImportPreview,
  configuredAiProviderIds,
  EXPORT_PAYLOAD_VERSION,
  parsedAiProviderConfigs,
  parseAiImportedAiConfig,
  readAiConfigForExport,
  resolveAiImportProviders,
  uniqueImportedProviderId,
  type AiImportPlan,
} from '../aiConfigImport';
import { aiProviderHeaderSecretKey, aiProviderKeySecretKey, type AiSecretStore } from '../../ai/providerSecrets';

/** A synthetic credential: shaped like one, belonging to nothing. */
const EXPORT_KEY = 'sk-ai-import-test-key-0001';
const HEADER_VALUE = 'header-value-under-test-1';
const IMPORT_KEY = 'sk-ai-import-file-key-0002';
const IMPORT_HEADER_VALUE = 'header-value-from-the-file';
const SYNTHETIC_VALUES = [EXPORT_KEY, HEADER_VALUE, IMPORT_KEY, IMPORT_HEADER_VALUE];

const PROVIDER = {
  id: 'ollama-local',
  name: 'Ollama (this machine)',
  baseUrl: 'http://localhost:11434/v1',
  models: [{ id: 'qwen3:8b', name: 'Qwen3 8B' }],
  auth: 'bearer' as const,
  headers: [{ name: 'api-version', valueSecret: true as const }],
};

/** A secret store whose values are visible only to the test. */
function secretStore(seed: Record<string, string> = {}) {
  const values: Record<string, string> = { ...seed };
  const store: AiSecretStore = {
    get: async (key: string) => values[key],
    store: async (key: string, value: string) => {
      values[key] = value;
    },
    delete: async (key: string) => {
      delete values[key];
    },
  };
  return { store, values };
}

function json<T>(value: unknown): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

beforeEach(() => {
  state.settings = {};
  state.writes = [];
  state.logged = [];
});

describe('readAiConfigForExport', () => {
  it('reads the non-secret configuration and keeps the secrets in their own half', async () => {
    state.settings['aiProviders'] = [PROVIDER];
    state.settings['aiModelBindings'] = [{ feature: 'aiPreReview', providerId: 'ollama-local', modelId: 'qwen3:8b' }];
    state.settings['aiTransport'] = 'openai-compatible';
    const { store } = secretStore({
      [aiProviderKeySecretKey('ollama-local')]: EXPORT_KEY,
      [aiProviderHeaderSecretKey('ollama-local', 'api-version') ?? '']: HEADER_VALUE,
    });

    const reading = await readAiConfigForExport(store);

    expect(reading.ai).toEqual({
      providers: [
        {
          id: 'ollama-local',
          name: 'Ollama (this machine)',
          baseUrl: 'http://localhost:11434/v1',
          models: [{ id: 'qwen3:8b', name: 'Qwen3 8B' }],
          auth: 'bearer',
          // The value is not here, and the marker says one exists — this is the
          // shape §10.2 requires of a plaintext export.
          headers: [{ name: 'api-version', valueSecret: true }],
        },
      ],
      bindings: [{ feature: 'aiPreReview', providerId: 'ollama-local', modelId: 'qwen3:8b' }],
      transport: 'openai-compatible',
    });
    expect(reading.secrets).toEqual({
      keys: { 'ollama-local': EXPORT_KEY },
      headerValues: { 'ollama-local': { 'api-version': HEADER_VALUE } },
    });
    // The non-secret half is what a plaintext export writes; the values must not
    // be anywhere inside it.
    const serialized = JSON.stringify(reading.ai);
    expect(serialized).not.toContain(EXPORT_KEY);
    expect(serialized).not.toContain(HEADER_VALUE);
    expect(state.logged.join('\n')).not.toContain(EXPORT_KEY);
  });

  it('never exports the settings that decide whether content may leave the machine', async () => {
    // The keys of §7.4 are not part of the export shape at all. This asserts the
    // mechanism, not just the shape: whatever is configured under them must not turn
    // up in the reading.
    state.settings['aiProviders'] = [PROVIDER];
    state.settings['aiEnabled'] = false;
    state.settings['aiPreReview'] = true;
    state.settings['aiPreReviewPromptScope'] = 'full-diff';
    state.settings['aiModelRequestTimeoutMs'] = 45_000;
    const { store } = secretStore();

    const reading = await readAiConfigForExport(store);

    const serialized = JSON.stringify(reading.ai);
    expect(serialized).not.toContain('aiEnabled');
    expect(serialized).not.toContain('aiPreReview');
    expect(serialized).not.toContain('full-diff');
    expect(serialized).not.toContain('45000');
    expect(Object.keys(reading.ai).sort()).toEqual(['bindings', 'providers', 'transport']);
  });

  it('reads an empty configuration as an empty section rather than failing', async () => {
    const { store } = secretStore();
    const reading = await readAiConfigForExport(store);
    expect(reading.ai).toEqual({ providers: [], bindings: [], transport: 'auto' });
    expect(aiConfigHasContent(reading.ai)).toBe(false);
  });
});

describe('parseAiImportedAiConfig', () => {
  const SECTION: ExportAiConfig = {
    providers: [PROVIDER],
    bindings: [{ feature: 'aiPreReview', providerId: 'ollama-local', modelId: 'qwen3:8b' }],
    transport: 'openai-compatible',
  };

  it('reads the version 3 AI section', () => {
    const parsed = parseAiImportedAiConfig({ ...SECTION, secrets: { keys: { 'ollama-local': IMPORT_KEY } } });

    expect(parsed?.config).toEqual(SECTION);
    expect(parsed?.secretsIncluded).toBe(true);
    expect(parsed?.secrets.keys).toEqual({ 'ollama-local': IMPORT_KEY });
  });

  it('reports a section with no secrets block as carrying none', () => {
    const parsed = parseAiImportedAiConfig(SECTION);

    expect(parsed?.config).toEqual(SECTION);
    expect(parsed?.secretsIncluded).toBe(false);
    expect(parsed?.secrets).toEqual({ keys: {}, headerValues: {} });
  });

  it('drops unknown fields instead of forwarding them into settings', () => {
    const parsed = parseAiImportedAiConfig({
      ...SECTION,
      somethingNew: true,
      providers: [{ ...PROVIDER, apiKey: IMPORT_KEY, unknownField: 'x' }],
      bindings: [{ feature: 'aiPreReview', providerId: 'ollama-local', modelId: 'qwen3:8b', extra: 1 }],
    });

    expect(parsed?.config.providers[0]).toEqual(PROVIDER);
    // The smuggled key is gone, not carried: a value found in a file must not be
    // able to enter settings through the import either.
    expect(JSON.stringify(parsed?.config)).not.toContain(IMPORT_KEY);
    const first = parsed?.config.providers[0] as unknown as Record<string, unknown>;
    expect('apiKey' in first).toBe(false);
    expect(parsed?.config.bindings[0]).toEqual({
      feature: 'aiPreReview',
      providerId: 'ollama-local',
      modelId: 'qwen3:8b',
    });
  });

  it('answers undefined for a file with no AI section, which is what keeps version 2 importable', () => {
    expect(parseAiImportedAiConfig(undefined)).toBeUndefined();
    expect(parseAiImportedAiConfig(null)).toBeUndefined();
    expect(parseAiImportedAiConfig([])).toBeUndefined();
    expect(parseAiImportedAiConfig('ai')).toBeUndefined();
  });

  // The record's discipline for every other importer applies here too: an entry
  // that cannot be interpreted is refused rather than guessed at, because there is
  // no sensible default for "where do I send this".
  const refusals: Array<[string, unknown]> = [
    ['a provider with no id', { providers: [{ ...PROVIDER, id: undefined }] }],
    ['a provider id with a dot in it', { providers: [{ ...PROVIDER, id: 'ollama.local' }] }],
    ['a provider with no display name', { providers: [{ ...PROVIDER, name: '  ' }] }],
    ['a provider with no base URL', { providers: [{ ...PROVIDER, baseUrl: '' }] }],
    ['an auth style this build does not contribute', { providers: [{ ...PROVIDER, auth: 'token' }] }],
    ['a provider that is not an object', { providers: ['ollama-local'] }],
    ['a models value that is not a list', { providers: [{ ...PROVIDER, models: 'qwen3:8b' }] }],
    ['a model entry that is not a model', { providers: [{ ...PROVIDER, models: [{ name: 'no id' }] }] }],
    ['a headers value that is not a list', { providers: [{ ...PROVIDER, headers: 'api-version' }] }],
    [
      'a header name that cannot be part of a secret key',
      { providers: [{ ...PROVIDER, headers: [{ name: 'api.version' }] }] },
    ],
    ['a providers value that is not a list', { providers: 'ollama-local' }],
    ['a bindings value that is not a list', { ...SECTION, bindings: { feature: 'aiPreReview' } }],
    ['a transport this build does not contribute', { ...SECTION, transport: 'openai' }],
  ];
  it.each(refusals)('refuses %s', (_name, value) => {
    expect(parseAiImportedAiConfig(value)).toBeUndefined();
  });

  it('drops a binding whose feature this build does not know, keeping the rest', () => {
    // The array's own reader drops an unknown feature (§13 question 6), and the
    // file must not be refused wholesale for it: the bindings it does name still
    // describe what should happen.
    const parsed = parseAiImportedAiConfig({
      ...SECTION,
      bindings: [
        { feature: 'fromANewerBuild', providerId: 'ollama-local', modelId: 'qwen3:8b' },
        { feature: 'aiPreReview', providerId: 'ollama-local', modelId: 'qwen3:8b' },
      ],
    });

    expect(parsed?.config.bindings).toEqual([
      { feature: 'aiPreReview', providerId: 'ollama-local', modelId: 'qwen3:8b' },
    ]);
  });

  it('drops secret entries whose key segment cannot address a secret', () => {
    const parsed = parseAiImportedAiConfig({
      ...SECTION,
      secrets: {
        keys: { 'ollama-local': IMPORT_KEY, 'bad.id': 'sk-other', '': 'sk-empty' },
        headerValues: {
          'ollama-local': { 'api-version': IMPORT_HEADER_VALUE, 'bad.name': 'x', empty: '' },
          'bad.id': { 'api-version': 'y' },
        },
      },
    });

    expect(parsed?.secrets).toEqual({
      keys: { 'ollama-local': IMPORT_KEY },
      headerValues: { 'ollama-local': { 'api-version': IMPORT_HEADER_VALUE } },
    });
  });
});

describe('buildAiImportPreview', () => {
  it('flags an id that is already configured and an http:// address', () => {
    const parsed = parseAiImportedAiConfig({
      providers: [PROVIDER],
      bindings: [],
      transport: 'auto',
    });

    const preview = buildAiImportPreview(parsed as never, ['ollama-local']);

    expect(preview.ai.providers).toEqual([
      {
        id: 'ollama-local',
        name: 'Ollama (this machine)',
        baseUrl: 'http://localhost:11434/v1',
        auth: 'bearer',
        models: ['qwen3:8b'],
        headers: ['api-version'],
        existing: true,
        insecure: true,
      },
    ]);
    expect(preview.ai.secretsIncluded).toBe(false);
    // The preview carries the transport value so the view can show it, and the
    // host does not apply it (§10.3 rule 1) — the two are different facts.
    expect(preview.ai.transport).toBe('auto');
  });

  it('reports an address the settings editor refuses as unusable instead of offering it', () => {
    const parsed = parseAiImportedAiConfig({
      providers: [
        { ...PROVIDER, id: 'file-endpoint', baseUrl: 'file:///tmp/v1' },
        { ...PROVIDER, id: 'no-scheme', baseUrl: 'not a url' },
        { ...PROVIDER, id: 'with-userinfo', baseUrl: 'https://alice:secret@models.example.com/v1' },
      ],
      bindings: [],
      transport: 'auto',
    });

    const preview = buildAiImportPreview(parsed as never, []);

    for (const provider of preview.ai.providers) {
      expect(provider.unusable, provider.id).toBeTruthy();
      // Never both: an unusable entry is not warned about for its encryption.
      expect(provider.insecure, provider.id).toBeUndefined();
    }
    expect(preview.ai.providers.map((provider) => provider.unusable)).toEqual([
      'The endpoint base URL cannot be used: its scheme is "file:", and only http: and https: can be a model endpoint',
      'The endpoint base URL cannot be used: it is not an absolute URL',
      "The endpoint base URL cannot be used: it carries credentials in the URL, and a credential belongs in the extension's secret storage rather than in a setting",
    ]);
  });

  it('does not flag an https address', () => {
    const parsed = parseAiImportedAiConfig({
      providers: [{ ...PROVIDER, baseUrl: 'https://models.example.com/v1' }],
      bindings: [],
      transport: 'auto',
    });

    expect(buildAiImportPreview(parsed as never, []).ai.providers[0].insecure).toBeUndefined();
  });
});

describe('resolveAiImportProviders', () => {
  function previewsFor(providers: unknown[], taken: string[]) {
    const parsed = parseAiImportedAiConfig({ providers, bindings: [], transport: 'auto' });
    return buildAiImportPreview(parsed as never, taken).previews;
  }

  it('keeps the stored endpoint when the strategy is keep, the fail-closed default', () => {
    const previews = previewsFor([PROVIDER], ['ollama-local']);

    const { resolved, unavailable } = resolveAiImportProviders(previews, {}, ['ollama-local']);

    expect(resolved).toEqual([]);
    expect([...unavailable]).toEqual(['ollama-local']);
  });

  it('writes the file entry under a sibling id when the strategy is rename', () => {
    const previews = previewsFor([PROVIDER], ['ollama-local', 'ollama-local-2']);

    const { resolved } = resolveAiImportProviders(previews, { 'ollama-local': 'rename' }, [
      'ollama-local',
      'ollama-local-2',
    ]);

    expect(resolved).toEqual([{ id: 'ollama-local', targetId: 'ollama-local-3', mode: 'rename' }]);
  });

  it('overwrites the stored id when the strategy is replace', () => {
    const previews = previewsFor([PROVIDER], ['ollama-local']);

    const { resolved } = resolveAiImportProviders(previews, { 'ollama-local': 'replace' }, ['ollama-local']);

    expect(resolved).toEqual([{ id: 'ollama-local', targetId: 'ollama-local', mode: 'replace' }]);
  });

  it('adds an entry whose id is free without asking anything', () => {
    const previews = previewsFor([PROVIDER], []);

    // No collision, so there is nothing to decide and the choice map is not read.
    const { resolved, unavailable } = resolveAiImportProviders(previews, {}, []);

    expect(resolved).toEqual([{ id: 'ollama-local', targetId: 'ollama-local', mode: 'add' }]);
    expect([...unavailable]).toEqual([]);
  });

  it('ignores an unknown strategy rather than guessing', () => {
    const previews = previewsFor([PROVIDER], ['ollama-local']);

    const { resolved } = resolveAiImportProviders(previews, { 'ollama-local': 'overwrite' as never }, ['ollama-local']);

    expect(resolved).toEqual([]);
  });

  it('never writes an entry whose address the editor refuses', () => {
    const previews = previewsFor([{ ...PROVIDER, id: 'file-endpoint', baseUrl: 'file:///tmp/v1' }], []);

    const { resolved, unavailable } = resolveAiImportProviders(previews, {}, []);

    expect(resolved).toEqual([]);
    expect([...unavailable]).toEqual(['file-endpoint']);
  });

  it('names a collision-free id without touching the set it was given', () => {
    expect(uniqueImportedProviderId('endpoint', [])).toBe('endpoint');
    expect(uniqueImportedProviderId('endpoint', ['endpoint'])).toBe('endpoint-2');
    expect(uniqueImportedProviderId('endpoint', ['endpoint', 'endpoint-2'])).toBe('endpoint-3');
  });
});

describe('applyAiImport', () => {
  function planFrom(section: unknown): AiImportPlan {
    const parsed = parseAiImportedAiConfig(section);
    if (parsed === undefined) {
      throw new Error('the test section did not parse');
    }
    return {
      config: parsed.config,
      secretsIncluded: parsed.secretsIncluded,
      secrets: parsed.secrets,
      providers: parsedAiProviderConfigs(parsed),
    };
  }

  it('writes the providers into settings and their credentials into the secret store', async () => {
    const { store, values } = secretStore();
    const plan = planFrom({
      providers: [PROVIDER],
      bindings: [{ feature: 'aiPreReview', providerId: 'ollama-local', modelId: 'qwen3:8b' }],
      transport: 'vscode-lm',
      secrets: {
        keys: { 'ollama-local': IMPORT_KEY },
        headerValues: { 'ollama-local': { 'api-version': IMPORT_HEADER_VALUE } },
      },
    });

    const result = await applyAiImport(plan, {}, store);

    expect(result).toEqual({ applied: 1, skippedBindings: [] });
    // Settings get the declaration, with the header value still absent and its
    // marker intact.
    expect(state.settings['aiProviders']).toEqual([PROVIDER]);
    expect(state.settings['aiModelBindings']).toEqual([
      { feature: 'aiPreReview', providerId: 'ollama-local', modelId: 'qwen3:8b' },
    ]);
    expect(JSON.stringify(state.settings)).not.toContain(IMPORT_KEY);
    expect(JSON.stringify(state.settings)).not.toContain(IMPORT_HEADER_VALUE);
    // The credentials are in the secret store, under the keys §8.2 defines.
    expect(values[aiProviderKeySecretKey('ollama-local')]).toBe(IMPORT_KEY);
    expect(values[aiProviderHeaderSecretKey('ollama-local', 'api-version') ?? '']).toBe(IMPORT_HEADER_VALUE);
  });

  it('never turns AI on, whatever the file asked for', async () => {
    const { store } = secretStore();
    const plan = planFrom({
      providers: [PROVIDER],
      bindings: [{ feature: 'aiPreReview', providerId: 'ollama-local', modelId: 'qwen3:8b' }],
      transport: 'openai-compatible',
      // A file may name these keys; the import has nowhere to put them.
      aiEnabled: false,
      aiPreReview: true,
      aiPreReviewPromptScope: 'full-diff',
    });

    await applyAiImport(plan, {}, store);

    const written = state.writes.map((entry) => entry.key);
    expect(written).toContain('aiProviders');
    expect(written).toContain('aiModelBindings');
    expect(written).not.toContain('aiEnabled');
    expect(written).not.toContain('aiPreReview');
    expect(written).not.toContain('aiPreReviewPromptScope');
    // The transport value is not applied either: the opposite value on this
    // machine may be a working setup, and a file is the wrong thing to walk back.
    expect(written).not.toContain('aiTransport');
    // Nothing that was already off has been turned on, and a file that says AI is
    // off does not turn it off on the receiving machine either.
    expect(state.settings['aiEnabled']).toBeUndefined();
    expect(state.settings['aiPreReview']).toBeUndefined();
    expect(state.settings['aiPreReviewPromptScope']).toBeUndefined();
    expect(state.settings['aiTransport']).toBeUndefined();
  });

  it('drops a binding whose endpoint the import did not write, and names it', async () => {
    state.settings['aiProviders'] = [{ ...PROVIDER, name: 'already here' }];
    const { store } = secretStore();
    const plan = planFrom({
      providers: [{ ...PROVIDER, name: 'from the file' }],
      bindings: [{ feature: 'aiPreReview', providerId: 'ollama-local', modelId: 'qwen3:8b' }],
      transport: 'auto',
    });

    // `keep`: the stored entry wins, so the binding has nothing to point at.
    const result = await applyAiImport(plan, { 'ollama-local': 'keep' }, store);

    expect(result).toEqual({ applied: 0, skippedBindings: ['ollama-local'] });
    expect(state.settings['aiProviders']).toEqual([{ ...PROVIDER, name: 'already here' }]);
    // The binding was not written as a dangling reference.
    expect(state.writes.map((entry) => entry.key)).not.toContain('aiModelBindings');
  });

  it('points a binding at the renamed id when the strategy is rename', async () => {
    state.settings['aiProviders'] = [{ ...PROVIDER, name: 'already here' }];
    const { store } = secretStore();
    const plan = planFrom({
      providers: [{ ...PROVIDER, name: 'from the file' }],
      bindings: [{ feature: 'aiPreReview', providerId: 'ollama-local', modelId: 'qwen3:8b' }],
      transport: 'auto',
    });

    const result = await applyAiImport(plan, { 'ollama-local': 'rename' }, store);

    expect(result).toEqual({ applied: 1, skippedBindings: [] });
    const renamedId = (state.settings['aiModelBindings'] as Array<{ providerId: string }>)[0]?.providerId;
    // The entry landed under a sibling id, and the binding follows it rather than
    // being left pointing at the stored entry the rename kept away from.
    expect(renamedId).toBeDefined();
    expect(renamedId).not.toBe('ollama-local');
    expect((state.settings['aiProviders'] as Array<{ id: string }>).map((entry) => entry.id)).toEqual([
      'ollama-local',
      renamedId,
    ]);
  });

  it('keeps a binding of a feature this build does not know', async () => {
    state.settings['aiModelBindings'] = [
      { feature: 'fromANewerBuild', providerId: 'other', modelId: 'm' },
      { feature: 'aiPreReview', providerId: 'old', modelId: 'old-model' },
    ];
    const { store } = secretStore();
    const plan = planFrom({
      providers: [PROVIDER],
      bindings: [{ feature: 'aiPreReview', providerId: 'ollama-local', modelId: 'qwen3:8b' }],
      transport: 'auto',
    });

    await applyAiImport(plan, {}, store);

    expect(state.settings['aiModelBindings']).toEqual([
      { feature: 'fromANewerBuild', providerId: 'other', modelId: 'm' },
      { feature: 'aiPreReview', providerId: 'ollama-local', modelId: 'qwen3:8b' },
    ]);
  });

  it('writes only the first of two entries that declare the same id', async () => {
    const { store } = secretStore();
    const plan = planFrom({
      providers: [
        { ...PROVIDER, name: 'first' },
        { ...PROVIDER, name: 'second' },
      ],
      bindings: [],
      transport: 'auto',
    });

    const result = await applyAiImport(plan, {}, store);

    // The settings writer is an upsert by id, so the second entry could only
    // overwrite the first — with a name the user never saw resolved. The first is
    // written and the duplicate is dropped, not silently mistaken for it.
    expect(result).toEqual({ applied: 1, skippedBindings: [] });
    expect(state.settings['aiProviders']).toEqual([{ ...PROVIDER, name: 'first' }]);
  });

  it('leaves no credential behind when nothing was applied', async () => {
    state.settings['aiProviders'] = [{ ...PROVIDER, name: 'already here' }];
    const { store, values } = secretStore();
    const plan = planFrom({
      providers: [PROVIDER],
      bindings: [],
      transport: 'auto',
      secrets: { keys: { 'ollama-local': IMPORT_KEY } },
    });

    // An orphan secret would be invisible in every surface and would still be sent
    // if an entry with that id were ever configured again.
    await applyAiImport(plan, { 'ollama-local': 'keep' }, store);

    expect(values[aiProviderKeySecretKey('ollama-local')]).toBeUndefined();
  });

  it('never writes a credential into the log', async () => {
    const { store } = secretStore();
    const plan = planFrom({
      providers: [PROVIDER],
      bindings: [{ feature: 'aiPreReview', providerId: 'ollama-local', modelId: 'qwen3:8b' }],
      transport: 'auto',
      secrets: {
        keys: { 'ollama-local': IMPORT_KEY },
        headerValues: { 'ollama-local': { 'api-version': IMPORT_HEADER_VALUE } },
      },
    });

    await applyAiImport(plan, {}, store);

    const log = state.logged.join('\n');
    expect(log).not.toBe('');
    for (const value of SYNTHETIC_VALUES) {
      expect(log, value).not.toContain(value);
    }
  });
});

describe('configuredAiProviderIds', () => {
  it('names the ids of entries this build cannot read as well', () => {
    // An unreadable entry keeps its place in the array, so it still owns its id:
    // offering the file's entry that id for "replace" would hand the settings
    // writer an id a stored entry already holds.
    state.settings['aiProviders'] = [PROVIDER, { id: 'broken-entry' }, 'not-an-object', { name: 'no id' }];

    expect(configuredAiProviderIds()).toEqual(['ollama-local', 'broken-entry']);
  });

  it('answers an empty list when the setting holds something that is not a list', () => {
    state.settings['aiProviders'] = 'ollama-local';
    expect(configuredAiProviderIds()).toEqual([]);
  });
});

describe('the export payload version', () => {
  it('is the version this stage writes', () => {
    // The reader is deliberately version-tolerant, so this pins what the writer
    // emits: a change here has to be a decision, not a drift.
    expect(EXPORT_PAYLOAD_VERSION).toBe(3);
  });

  it('survives a JSON round trip as the AI section the reader accepts', () => {
    const section: ExportAiConfig = {
      providers: [PROVIDER],
      bindings: [{ feature: 'aiPreReview', providerId: 'ollama-local', modelId: 'qwen3:8b' }],
      transport: 'auto',
    };
    const payload = {
      version: EXPORT_PAYLOAD_VERSION,
      instances: [],
      ai: { ...section, secrets: { keys: { 'ollama-local': IMPORT_KEY } } },
    };

    const parsed = parseAiImportedAiConfig(json<{ ai: unknown }>(payload).ai);

    expect(parsed?.config).toEqual(section);
    expect(parsed?.secretsIncluded).toBe(true);
  });
});
