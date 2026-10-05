import { readFileSync, readdirSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * The settings and secret surface of the direct model transport
 * (`docs/design/ai-model-transport.md` §8), and the two things it is easy to get
 * subtly wrong:
 *
 * 1. **Every new setting is `machine`-scoped**, asserted from `package.json`
 *    itself. The record's risk table names this explicitly: a setting whose
 *    `scope` was forgotten can be overridden by a repository's
 *    `.vscode/settings.json`, which would let a checkout decide where content
 *    goes (§8.3).
 * 2. **Capability is answered without reading a brand.** The `src/ai/` modules are
 *    scanned for the four `vscode.env` fields that would name the editor; §9.1
 *    forbids letting any of them steer a branch, so the guard is mechanical rather
 *    than a promise.
 *
 * The reading discipline is asserted the way it is written: a read that throws, a
 * value of the wrong JSON type, and an unknown enum value all have to land on the
 * side that sends nothing.
 */

const state = vi.hoisted(() => ({
  settings: {} as Record<string, unknown>,
  throws: false,
}));

vi.mock('vscode', () => ({
  workspace: {
    getConfiguration: vi.fn(() => ({
      get: vi.fn((key: string, fallback?: unknown) => {
        if (state.throws) {
          throw new Error('the configuration is unreadable');
        }
        return key in state.settings ? state.settings[key] : fallback;
      }),
      update: vi.fn(),
    })),
    onDidChangeConfiguration: vi.fn(() => ({ dispose: vi.fn() })),
  },
  l10n: { t: vi.fn((message: string) => message) },
  window: { createOutputChannel: vi.fn(() => ({ appendLine: vi.fn(), show: vi.fn(), dispose: vi.fn() })) },
}));

import {
  AI_FEATURES,
  AI_MODEL_REQUEST_TIMEOUT_DEFAULT_MS,
  AI_MODEL_REQUEST_TIMEOUT_MAX_MS,
  AI_MODEL_REQUEST_TIMEOUT_MIN_MS,
  AI_MODEL_REQUEST_TOTAL_TIMEOUT_FACTOR,
  aiLocalOnlySettingValue,
  aiModelBindingFor,
  aiModelBindingsSettingValue,
  aiModelRequestTimeoutMsSettingValue,
  aiModelRequestTotalTimeoutMs,
  aiProviderConfigsSettingValue,
  aiProviderSettingsReading,
  aiProvidersEnabledSettingValue,
  aiTransportSettingValue,
  inspectAiProviderBaseUrl,
  isAiProviderSegment,
  isLocalAiEndpointHost,
  parseAiProviderConfig,
} from '../ai/modelSettings';
import {
  AI_PROVIDER_HEADER_SECRET_PREFIX,
  AI_PROVIDER_KEY_SECRET_PREFIX,
  aiProviderHeaderSecretKey,
  aiProviderKeySecretKey,
  deleteAiProviderHeaderValue,
  deleteAiProviderKey,
  isAuthOwnedHeaderName,
  isQueryCarriedHeaderName,
  readAiProviderHeaderValue,
  readAiProviderKey,
  storeAiProviderHeaderValue,
  storeAiProviderKey,
  type AiSecretStore,
} from '../ai/providerSecrets';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const manifest = JSON.parse(readFileSync(path.join(packageRoot, 'package.json'), 'utf8')) as {
  contributes: { configuration: { properties: Record<string, { scope?: string; default?: unknown }> } };
};

/** One recording secret store. */
function secretStore(initial: Record<string, string> = {}): AiSecretStore & { values: Record<string, string> } {
  const values: Record<string, string> = { ...initial };
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

beforeEach(() => {
  state.settings = {};
  state.throws = false;
  vi.clearAllMocks();
});

describe('the direct model settings as the manifest contributes them', () => {
  const settings = {
    'forgejoToolkit.aiProviders': [],
    'forgejoToolkit.aiProvidersEnabled': false,
    'forgejoToolkit.aiTransport': 'auto',
    'forgejoToolkit.aiModelBindings': [],
    'forgejoToolkit.aiLocalOnly': false,
    'forgejoToolkit.aiModelRequestTimeoutMs': 30_000,
  } as const;

  it('scopes every one of them to machine, so only the user can set it', () => {
    // `scope: "machine"` is how "user-level only" is implemented: a workspace-level
    // value could point a repository's content at an address the user never
    // configured (§8.3), and omitting `scope` defaults to `window`, which
    // `.vscode/settings.json` can override.
    for (const [id, fallback] of Object.entries(settings)) {
      const property = manifest.contributes.configuration.properties[id];
      expect(property, id).toBeDefined();
      expect(property?.scope, id).toBe('machine');
      expect(property?.default, id).toEqual(fallback);
    }
  });

  it('contributes the endpoint test command', () => {
    const raw = readFileSync(path.join(packageRoot, 'package.json'), 'utf8');
    expect(raw).toContain('forgejoToolkit.aiTestProvider');
  });
});

describe('reading the provider list', () => {
  const valid = {
    id: 'ollama-local',
    name: 'Ollama (this machine)',
    baseUrl: 'http://localhost:11434/v1',
    models: [{ id: 'qwen3:8b', name: 'Qwen3 8B' }],
    auth: 'bearer',
    headers: [{ name: 'api-version' }],
    localOnly: true,
  };

  it('reads a well-formed entry into a provider', () => {
    state.settings = { aiProviders: [valid] };

    expect(aiProviderConfigsSettingValue()).toEqual([
      {
        id: 'ollama-local',
        name: 'Ollama (this machine)',
        baseUrl: 'http://localhost:11434/v1',
        models: [{ id: 'qwen3:8b', name: 'Qwen3 8B' }],
        auth: 'bearer',
        headers: [{ name: 'api-version', valueSecret: true }],
        localOnly: true,
      },
    ]);
  });

  it('drops a header value written into the declaration, keeping only its name', () => {
    // §8.2: the value may only live in `SecretStorage`. A hand-edited settings file
    // that carries one must not make the boundary optional.
    state.settings = { aiProviders: [{ ...valid, headers: [{ name: 'api-version', value: 'a-secret' }] }] };

    const [provider] = aiProviderConfigsSettingValue();

    expect(provider?.headers).toEqual([{ name: 'api-version', valueSecret: true }]);
    expect(JSON.stringify(provider)).not.toContain('a-secret');
  });

  it('answers "nothing configured" for every unusable shape', () => {
    for (const value of [undefined, null, 'not a list', { id: 'x' }, 42]) {
      state.settings = { aiProviders: value };
      expect(aiProviderConfigsSettingValue(), JSON.stringify(value)).toEqual([]);
    }
  });

  it('reads a throwing configuration as "nothing configured"', () => {
    state.throws = true;

    expect(aiProviderSettingsReading()).toEqual({ providers: [], rejected: [] });
    expect(aiProvidersEnabledSettingValue()).toBe(false);
    expect(aiTransportSettingValue()).toBe('auto');
    expect(aiLocalOnlySettingValue()).toBe(false);
    expect(aiModelBindingsSettingValue()).toEqual([]);
    expect(aiModelRequestTimeoutMsSettingValue()).toBe(AI_MODEL_REQUEST_TIMEOUT_DEFAULT_MS);
  });

  it('keeps the reason for each entry it refuses, instead of losing the entry', () => {
    state.settings = {
      aiProviders: [
        valid,
        { name: 'No id', baseUrl: 'http://localhost:1/v1', auth: 'none' },
        { id: 'has.dot', name: 'Bad id', baseUrl: 'http://localhost:1/v1', auth: 'none' },
        { id: 'no-name', baseUrl: 'http://localhost:1/v1', auth: 'none' },
        { id: 'no-url', name: 'No URL', auth: 'none' },
        { id: 'bad-auth', name: 'Bad auth', baseUrl: 'http://localhost:1/v1', auth: 'token' },
        { ...valid, id: 'bad-models', models: [{ name: 'no id' }] },
        { ...valid, id: 'bad-headers', headers: [{ name: 'has space' }] },
      ],
    };

    const reading = aiProviderSettingsReading();

    expect(reading.providers.map((entry) => entry.id)).toEqual(['ollama-local']);
    expect(reading.rejected).toHaveLength(7);
    expect(reading.rejected.map((entry) => entry.index)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(reading.rejected.map((entry) => entry.reason).join('\n')).toContain('"bad-auth"');
    expect(reading.rejected.map((entry) => entry.reason).join('\n')).toContain('legal header name');
  });

  it('refuses a provider whose auth is not one of the three contributed values', () => {
    const parsed = parseAiProviderConfig({ ...valid, auth: 'oauth' });

    expect('reason' in parsed && parsed.reason).toContain('does not contribute');
  });

  it('accepts a provider with no declared model, because the declaration is not a whitelist', () => {
    const parsed = parseAiProviderConfig({ id: 'bare', name: 'Bare', baseUrl: 'http://localhost:1/v1', auth: 'none' });

    expect('provider' in parsed && parsed.provider.models).toEqual([]);
  });
});

describe('reading the switches and the timeout', () => {
  it('opens the egress switch only for an explicit true', () => {
    for (const value of [undefined, false, 'true', 1, {}, []]) {
      state.settings = { aiProvidersEnabled: value };
      expect(aiProvidersEnabledSettingValue(), JSON.stringify(value)).toBe(false);
    }
    state.settings = { aiProvidersEnabled: true };
    expect(aiProvidersEnabledSettingValue()).toBe(true);
  });

  it('reads an unknown transport value as auto, which is the fail-closed arm', () => {
    state.settings = { aiTransport: 'openai' };
    expect(aiTransportSettingValue()).toBe('auto');
    state.settings = { aiTransport: 'OpenAI-Compatible' };
    expect(aiTransportSettingValue()).toBe('openai-compatible');
    state.settings = { aiTransport: 7 };
    expect(aiTransportSettingValue()).toBe('auto');
  });

  it('opens the local-only policy only for an explicit true', () => {
    state.settings = { aiLocalOnly: 'yes' };
    expect(aiLocalOnlySettingValue()).toBe(false);
    state.settings = { aiLocalOnly: true };
    expect(aiLocalOnlySettingValue()).toBe(true);
  });

  it('honours a timeout inside the contributed range and falls back outside it', () => {
    state.settings = { aiModelRequestTimeoutMs: 60_000 };
    expect(aiModelRequestTimeoutMsSettingValue()).toBe(60_000);

    for (const value of [
      0,
      -1,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      '30000',
      null,
      AI_MODEL_REQUEST_TIMEOUT_MIN_MS - 1,
      AI_MODEL_REQUEST_TIMEOUT_MAX_MS + 1,
    ]) {
      state.settings = { aiModelRequestTimeoutMs: value };
      expect(aiModelRequestTimeoutMsSettingValue(), String(value)).toBe(AI_MODEL_REQUEST_TIMEOUT_DEFAULT_MS);
    }

    state.settings = { aiModelRequestTimeoutMs: AI_MODEL_REQUEST_TIMEOUT_MIN_MS };
    expect(aiModelRequestTimeoutMsSettingValue()).toBe(AI_MODEL_REQUEST_TIMEOUT_MIN_MS);
  });

  it('derives the wider total cap from the idle window', () => {
    // §8.6: the idle window is what stops a silent endpoint; the total cap exists so
    // a stream that dribbles forever cannot hold the window open.
    expect(aiModelRequestTotalTimeoutMs(30_000)).toBe(30_000 * AI_MODEL_REQUEST_TOTAL_TIMEOUT_FACTOR);
    expect(aiModelRequestTotalTimeoutMs(1_000)).toBeGreaterThan(1_000);
  });
});

describe('reading the bindings', () => {
  it('keeps a known feature binding, including one that names an unknown endpoint', () => {
    state.settings = {
      aiModelBindings: [
        { feature: 'aiPreReview', providerId: 'ollama-local', modelId: 'qwen3:8b' },
        { feature: 'aiPreReview', providerId: 'gone', modelId: 'x' },
      ],
    };

    expect(aiModelBindingsSettingValue()).toEqual([
      { feature: 'aiPreReview', providerId: 'ollama-local', modelId: 'qwen3:8b' },
      { feature: 'aiPreReview', providerId: 'gone', modelId: 'x' },
    ]);
    expect(aiModelBindingFor('aiPreReview')?.providerId).toBe('ollama-local');
  });

  it('ignores an entry naming a feature this build does not know', () => {
    // The decision §13 leaves to the implementation: an unknown feature id is
    // dropped rather than refused, because it cannot send anything anywhere while
    // refusing it would discard the bindings of the features that do exist. Both
    // known features are kept beside it, so the case cannot pass by dropping
    // everything (`prDescription` is the second one, `docs/design/ai-pr-description.md` §5).
    state.settings = {
      aiModelBindings: [
        { feature: 'notAFeature', providerId: 'ollama-local', modelId: 'qwen3:8b' },
        { feature: 'aiPreReview', providerId: 'ollama-local', modelId: 'qwen3:8b' },
        { feature: 'prDescription', providerId: 'ollama-local', modelId: 'qwen3:8b' },
      ],
    };

    expect(aiModelBindingsSettingValue().map((binding) => binding.feature)).toEqual(['aiPreReview', 'prDescription']);
  });

  it('drops an entry that is missing a part of its shape', () => {
    state.settings = {
      aiModelBindings: [
        { feature: 'aiPreReview', providerId: 'a' },
        { providerId: 'a', modelId: 'b' },
        'not an object',
        { feature: 'aiPreReview', providerId: '  ', modelId: 'b' },
      ],
    };

    expect(aiModelBindingsSettingValue()).toEqual([]);
  });

  it('is the list the ui-review harness seeds a binding for', () => {
    // The harness's `--ai-mock` launch writes one binding per AI feature into the
    // isolated profile, and it reads this list out of `src/ai/modelSettings.ts`
    // (it cannot import this module: plain Node cannot resolve `vscode`). A feature
    // added here and not seen there would draft nothing until someone edited the
    // profile by hand — which is exactly what happened when `prDescription` was
    // added. The harness side additionally pins its own reading
    // (`tools/ui-review/src/config.test.ts`); this is the other direction, so the
    // two cannot drift apart silently.
    const harnessConfig = readFileSync(
      path.join(packageRoot, '..', '..', 'tools', 'ui-review', 'src', 'config.ts'),
      'utf8',
    );
    const fallback = /AI_FEATURES_FALLBACK[^=]*=\s*\[([^\]]*)\]/.exec(harnessConfig);
    expect(fallback, 'the harness seed must name a last-resort feature list').not.toBeNull();
    const seeded = [...(fallback?.[1] ?? '').matchAll(/'([^']+)'/g)].map((match) => match[1]);
    expect(seeded).toEqual([...AI_FEATURES]);
    // And the path the harness reads is this one, so a moved file fails here.
    expect(harnessConfig).toContain('packages/forgejo-toolkit/src/ai/modelSettings.ts');
  });
});

describe('the base URL verdict', () => {
  it('accepts https', () => {
    const verdict = inspectAiProviderBaseUrl('https://models.example.com/v1');
    expect(verdict.ok).toBe(true);
    expect(verdict.ok && verdict.insecure).toBe(false);
  });

  it('accepts http:// but marks it insecure', () => {
    const verdict = inspectAiProviderBaseUrl('http://localhost:11434/v1');
    expect(verdict.ok).toBe(true);
    expect(verdict.ok && verdict.insecure).toBe(true);
  });

  it('refuses every scheme that cannot be a model endpoint', () => {
    for (const url of [
      'file:///tmp/v1',
      'data:application/json,{}',
      'javascript:alert(1)',
      'ftp://models.example.com/v1',
      'models.example.com/v1',
      '',
    ]) {
      expect(inspectAiProviderBaseUrl(url).ok, url).toBe(false);
    }
  });

  it('refuses a URL that carries credentials', () => {
    for (const url of ['https://user:token@models.example.com/v1', 'https://token@models.example.com/v1']) {
      const verdict = inspectAiProviderBaseUrl(url);
      expect(verdict.ok, url).toBe(false);
      expect(verdict.ok === false && verdict.reason, url).toContain('credentials in the URL');
    }
  });
});

describe('the local-only host policy', () => {
  it('treats loopback, the .local suffix and the private ranges as local', () => {
    for (const host of [
      'localhost',
      'LOCALHOST',
      '127.0.0.1',
      '127.1.2.3',
      '::1',
      '[::1]',
      'gateway.local',
      '10.0.0.5',
      '172.16.0.1',
      '172.31.255.255',
      '192.168.1.10',
      'fd00::1',
      'fc00::1',
    ]) {
      expect(isLocalAiEndpointHost(host), host).toBe(true);
    }
  });

  it('treats a public address, a near-miss range and anything unreadable as not local', () => {
    for (const host of [
      'models.example.com',
      '172.15.0.1',
      '172.32.0.1',
      '192.169.1.1',
      '11.0.0.1',
      '999.1.1.1',
      '2001:db8::1',
      '',
      '  ',
    ]) {
      expect(isLocalAiEndpointHost(host), host).toBe(false);
    }
  });
});

describe('where the credentials live', () => {
  it('builds the two documented key shapes', () => {
    expect(aiProviderKeySecretKey('ollama-local')).toBe(`${AI_PROVIDER_KEY_SECRET_PREFIX}ollama-local`);
    expect(aiProviderHeaderSecretKey('ollama-local', 'api-version')).toBe(
      `${AI_PROVIDER_HEADER_SECRET_PREFIX}ollama-local.api-version`,
    );
  });

  it('refuses a segment that would make a key ambiguous', () => {
    expect(aiProviderHeaderSecretKey('ollama-local', 'api.version')).toBeUndefined();
    expect(aiProviderHeaderSecretKey('ollama local', 'api-version')).toBeUndefined();
    expect(aiProviderHeaderSecretKey('ollama-local', 'api version')).toBeUndefined();
    expect(isAiProviderSegment('ollama-local')).toBe(true);
    expect(isAiProviderSegment('a.b')).toBe(false);
  });

  it('round-trips a key and a header value, and forgets them on delete', async () => {
    const secrets = secretStore();

    await storeAiProviderKey(secrets, 'ollama-local', 'the-key');
    await storeAiProviderHeaderValue(secrets, 'ollama-local', 'x-tenant', 'the-value');

    expect(await readAiProviderKey(secrets, 'ollama-local')).toBe('the-key');
    expect(await readAiProviderHeaderValue(secrets, 'ollama-local', 'x-tenant')).toBe('the-value');
    expect(secrets.values[aiProviderKeySecretKey('ollama-local')]).toBe('the-key');

    await deleteAiProviderKey(secrets, 'ollama-local');
    await deleteAiProviderHeaderValue(secrets, 'ollama-local', 'x-tenant');
    expect(await readAiProviderKey(secrets, 'ollama-local')).toBeUndefined();
    expect(await readAiProviderHeaderValue(secrets, 'ollama-local', 'x-tenant')).toBeUndefined();
  });

  it('refuses to store a header value under a name that cannot be part of a key', async () => {
    await expect(storeAiProviderHeaderValue(secretStore(), 'ollama-local', 'has.dot', 'v')).rejects.toThrow(
      /cannot be a header name/,
    );
  });

  it('reads an empty stored value as no value, and a throwing store as no value', async () => {
    const secrets = secretStore({ [aiProviderKeySecretKey('a')]: '' });
    expect(await readAiProviderKey(secrets, 'a')).toBeUndefined();

    const broken: AiSecretStore = {
      get: async () => {
        throw new Error('the secret store is unavailable');
      },
      store: async () => undefined,
      delete: async () => undefined,
    };
    expect(await readAiProviderKey(broken, 'a')).toBeUndefined();
    expect(await readAiProviderHeaderValue(broken, 'a', 'x')).toBeUndefined();
  });

  it('names the auth-owned and query-carried header names', () => {
    expect(isAuthOwnedHeaderName('Authorization')).toBe(true);
    expect(isAuthOwnedHeaderName('API-KEY')).toBe(true);
    expect(isAuthOwnedHeaderName('x-tenant')).toBe(false);
    expect(isQueryCarriedHeaderName('api-version')).toBe(true);
    expect(isQueryCarriedHeaderName('x-tenant')).toBe(false);
  });
});

describe('capability is answered without a brand (§9.1)', () => {
  const aiDirectory = path.join(packageRoot, 'src', 'ai');

  /**
   * A source file with its comments removed.
   *
   * The guard is about what the **code** reads. These modules document the rule by
   * naming the fields they must not read, so a scan of the raw text would fail on
   * the very comments that state it — and a scan that had to avoid that would be a
   * scan nobody could keep accurate. The `[^:]` before `//` is what keeps a URL in
   * a string literal (`http://…`) from being mistaken for a comment.
   */
  function stripComments(source: string): string {
    return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
  }

  const sources = readdirSync(aiDirectory)
    .filter((entry) => entry.endsWith('.ts') && !entry.endsWith('.test.ts'))
    .map((entry) => ({ name: entry, text: stripComments(readFileSync(path.join(aiDirectory, entry), 'utf8')) }));

  it('never reads the four vscode.env fields that would name the editor', () => {
    // The record's checklist says these four are unread anywhere in the repository
    // today; this keeps it that way for the module that chooses a transport, because
    // "detected a fork, so enable the direct endpoint" is explicitly forbidden.
    for (const source of sources) {
      for (const field of ['appName', 'uriScheme', 'appHost', 'remoteName']) {
        expect(source.text, `${source.name} reads vscode.env.${field}`).not.toMatch(
          new RegExp(`env\\s*\\??\\.\\s*${field}\\b`),
        );
      }
      expect(source.text, `${source.name} touches vscode.env`).not.toMatch(/vscode\.env\b/);
    }
  });

  it('scans the modules that exist, so the guard cannot pass vacuously', () => {
    expect(sources.map((source) => source.name).sort()).toEqual([
      'modelSelection.ts',
      'modelSettings.ts',
      'openAiCompatibleTransport.ts',
      'providerSecrets.ts',
      'testProvider.ts',
      'transport.ts',
      'vscodeLmTransport.ts',
    ]);
  });
});
