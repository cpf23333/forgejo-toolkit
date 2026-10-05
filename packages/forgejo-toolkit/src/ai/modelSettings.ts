import * as vscode from 'vscode';

/**
 * The host-side settings of the direct (OpenAI-compatible) model transport: the
 * provider list, the two switches that gate egress, the transport choice, the
 * per-feature bindings and the timeout — all read in one module so the readers
 * cannot drift apart.
 *
 * `docs/design/ai-model-transport.md` §8 is the decision record for every id,
 * default and validation rule below. Three of its decisions are the reason this
 * file looks the way it does:
 *
 * 1. **Every setting is `machine`-scoped** (§8.3). A workspace-level value could
 *    point a repository's content at an address the user never configured, so
 *    `scope: "machine"` is the implementation of "user-level only" (the
 *    `package.json` side of that lives in the manifest, and
 *    `src/__tests__/aiModelSettings.test.ts` asserts it from there).
 * 2. **The reading discipline is `src/aiPreReviewSettings.ts`'s and
 *    `src/mcpWriteSettings.ts`'s** (§8.3): a hand-edited `settings.json` can hold
 *    any JSON type under a key, a read that throws must read as "not configured"
 *    rather than failing activation, and only an explicit `true` may open a
 *    switch. Every default below therefore falls on the side that sends nothing.
 * 3. **What belongs in settings and what belongs in `SecretStorage`** (§8.2) is a
 *    hard boundary, and this module is the settings half of it: a provider's `id`,
 *    display name, base URL, declared models, auth *style* and header *names* live
 *    here, while the API key and every custom header **value** live in
 *    `src/ai/providerSecrets.ts`. A `value` field written into a header
 *    declaration by hand is **dropped** here rather than honoured, so a secret
 *    cannot be smuggled into `settings.json` and still be sent (see
 *    `parseAiProviderHeader`).
 *
 * Two validation questions are deliberately answered in two different places, and
 * the split is not an accident:
 *
 * - **Shape** is answered here. A provider whose `id` is not a legal segment, whose
 *   `name` is missing, whose `auth` is not one of the three contributed values, or
 *   whose model/header entries are not objects cannot be turned into a provider at
 *   all, and the reading keeps the reason so the surface above can name the entry
 *   that was refused.
 * - **Whether the address is usable** is answered by
 *   `inspectAiProviderBaseUrl` — used by the transport, which is the thing that
 *   would send to it — because a URL is opaque text: `file:`, a `data:` document
 *   and a URL carrying credentials are all *strings* a provider entry can hold,
 *   and only the request layer knows that none of them can be a model endpoint.
 */

/** The settings section every key of this extension lives under. */
const SETTINGS_SECTION = 'forgejoToolkit';

/** The configured providers. An empty array means "there is no direct endpoint". */
export const AI_PROVIDERS_SETTING = `${SETTINGS_SECTION}.aiProviders`;

/**
 * Whether any AI feature may send content through a direct endpoint. The second,
 * independent gate: a configured endpoint is **not** enabled by configuration
 * alone (§8.4, §9.3), and this setting is where that is decided.
 */
export const AI_PROVIDERS_ENABLED_SETTING = `${SETTINGS_SECTION}.aiProvidersEnabled`;

/** Which transport serves a feature that has no binding of its own (§8.4). */
export const AI_TRANSPORT_SETTING = `${SETTINGS_SECTION}.aiTransport`;

/** The per-feature `{ feature, providerId, modelId }` bindings. */
export const AI_MODEL_BINDINGS_SETTING = `${SETTINGS_SECTION}.aiModelBindings`;

/** Whether a direct endpoint must resolve to the local machine or a private network. */
export const AI_LOCAL_ONLY_SETTING = `${SETTINGS_SECTION}.aiLocalOnly`;

/** The idle-watchdog window (and, times {@link AI_MODEL_REQUEST_TOTAL_TIMEOUT_FACTOR}, the total cap). */
export const AI_MODEL_REQUEST_TIMEOUT_SETTING = `${SETTINGS_SECTION}.aiModelRequestTimeoutMs`;

/** The keys above without their section, for the `getConfiguration` reads. */
const AI_PROVIDERS_KEY = 'aiProviders';
const AI_PROVIDERS_ENABLED_KEY = 'aiProvidersEnabled';
const AI_TRANSPORT_KEY = 'aiTransport';
const AI_MODEL_BINDINGS_KEY = 'aiModelBindings';
const AI_LOCAL_ONLY_KEY = 'aiLocalOnly';
const AI_MODEL_REQUEST_TIMEOUT_KEY = 'aiModelRequestTimeoutMs';

/**
 * The default idle window, matching the manifest's own default. 30 s is the
 * shared request layer's `API_REQUEST_TIMEOUT_MS`, reused as the **idle** window
 * rather than as a total cap for the reason §8.6 gives: a model answer routinely
 * takes longer than 30 s in total, but an endpoint that has sent nothing for 30 s
 * is the failure the watchdog exists for.
 */
export const AI_MODEL_REQUEST_TIMEOUT_DEFAULT_MS = 30_000;

/** The smallest window the reader will honour; below it a stream is not a stream. */
export const AI_MODEL_REQUEST_TIMEOUT_MIN_MS = 1_000;

/** The largest window the reader will honour, so a typo cannot mean "never". */
export const AI_MODEL_REQUEST_TIMEOUT_MAX_MS = 600_000;

/**
 * How much wider the **total** request cap is than the idle window (§8.6). The
 * idle watchdog alone would let a stream that dribbles one byte forever hold the
 * window open, so the whole request is bounded too — at a multiple, not at the
 * idle window itself, because the point of the idle window is to allow a long
 * answer.
 */
export const AI_MODEL_REQUEST_TOTAL_TIMEOUT_FACTOR = 10;

/**
 * The provider-id / header-name character class, the base-URL verdict and the
 * local-only host rule are defined once, in the shared package, because the
 * settings page needs the same three answers this host does and must not have a
 * second copy of them (`docs/design/settings-page.md` §5.1, §7.3). Imported and
 * re-exported here so every host-side caller has one import site.
 */
import {
  AI_PROVIDER_SEGMENT_PATTERN,
  isAiProviderSegment,
  inspectAiProviderBaseUrl,
  isLocalAiEndpointHost,
  type AiProviderBaseUrlVerdict,
} from '@cpf23333-forgejo-toolkit/shared/ai/providerPolicy';

export {
  AI_PROVIDER_SEGMENT_PATTERN,
  isAiProviderSegment,
  inspectAiProviderBaseUrl,
  isLocalAiEndpointHost,
  type AiProviderBaseUrlVerdict,
};

/** How a provider authenticates one request (§8.5). */
export type AiProviderAuth = 'bearer' | 'api-key-header' | 'none';

/** The three values of `auth`, in the order the manifest's dropdown shows them. */
export const AI_PROVIDER_AUTHS: readonly AiProviderAuth[] = ['bearer', 'api-key-header', 'none'];

/**
 * One custom header a provider needs, as settings may hold it.
 *
 * The **name** is here and the **value** is not: it lives in `SecretStorage` under
 * `forgejoToolkit.aiProviderHeader.<providerId>.<name>` (`src/ai/providerSecrets.ts`).
 * `valueSecret` is the marker the export keeps so a receiver knows a value exists
 * without being given it (§10.2); it carries nothing itself.
 */
export interface AiProviderHeaderDeclaration {
  name: string;
  valueSecret: true;
}

/** One model a provider declares, as settings may hold it. */
export interface AiProviderModelDeclaration {
  id: string;
  name: string;
}

/**
 * One configured provider (§8.1).
 *
 * `models` is a **declaration**, not a whitelist: the model id a binding names is
 * free text, and an empty list is a legal answer (the endpoint's own `/models` is
 * only used to prefill the settings page, §9.1). A provider with no declared
 * model is therefore still usable, and `complete()` does not require a request's
 * model to appear here — see the transport's own note.
 */
export interface AiProviderConfig {
  id: string;
  /** The display name, used by the consent sentence, the log and the settings page. */
  name: string;
  /** Used verbatim; the transport trims trailing slashes and appends the path (§6.2). */
  baseUrl: string;
  models: AiProviderModelDeclaration[];
  auth: AiProviderAuth;
  headers: AiProviderHeaderDeclaration[];
  /** This provider's own "local machine only" promise, independent of the global policy. */
  localOnly: boolean;
}

/**
 * The AI features a binding may name. Extended one feature at a time, and each
 * one has to be a host-side run that reaches its model through
 * `selectedModelFor(feature)` (`src/ai/modelSelection.ts`) — a name in this list
 * is what lets `forgejoToolkit.aiModelBindings` point that run at a configured
 * endpoint instead of the editor's own models.
 */
export const AI_FEATURES = ['aiPreReview', 'prDescription'] as const;

/** One feature id a binding may name. */
export type AiFeature = (typeof AI_FEATURES)[number];

/** Whether the text is a feature this build knows. */
export function isAiFeature(value: string): value is AiFeature {
  return (AI_FEATURES as readonly string[]).includes(value);
}

/**
 * One per-feature binding (§8.1).
 *
 * An array rather than an object, for the reason §8.4 gives: hand-editing
 * `settings.json` merges arrays predictably, and it matches the instance list.
 */
export interface AiModelBinding {
  feature: AiFeature;
  providerId: string;
  modelId: string;
}

/** The three values of `forgejoToolkit.aiTransport` (§8.4). */
export type AiTransportChoice = 'auto' | 'vscode-lm' | 'openai-compatible';

/** The three values, in the order the manifest's dropdown shows them. */
export const AI_TRANSPORT_CHOICES: readonly AiTransportChoice[] = ['auto', 'vscode-lm', 'openai-compatible'];

/**
 * The providers that could be read, plus the entries that could not.
 *
 * Both halves are kept because they answer different questions: the list is what
 * the selection chooses from, and the rejections are what a surface has to be able
 * to *name* — a provider silently vanishing from the list is exactly the
 * undiagnosable state the settings page exists to prevent (§8.5, §9.3).
 */
export interface AiProviderSettingsReading {
  providers: AiProviderConfig[];
  rejected: Array<{ index: number; reason: string }>;
}

/** Reads one setting, answering `undefined` for anything that throws. */
function readSettingValue(key: string): unknown {
  try {
    return vscode.workspace.getConfiguration(SETTINGS_SECTION).get<unknown>(key);
  } catch {
    // A configuration read that throws must read as "not configured", never as a
    // failed activation.
    return undefined;
  }
}

/** Reads one boolean switch, treating anything but an explicit `true` as off. */
function readBooleanSwitch(key: string): boolean {
  return readSettingValue(key) === true;
}

/** Whether the window allows any direct request at all (§8.3). */
export function aiProvidersEnabledSettingValue(): boolean {
  return readBooleanSwitch(AI_PROVIDERS_ENABLED_KEY);
}

/**
 * The configured transport choice, or `auto` when nothing usable is configured.
 *
 * `auto` is the reading for every "we do not know": an absent value, a value the
 * manifest does not contribute, a non-string, and a read that throws. That is the
 * fail-closed direction here even though it is spelled like "decide for me",
 * because `auto` only reaches a direct endpoint when a provider is configured
 * **and** {@link aiProvidersEnabledSettingValue} is on (§8.4).
 */
export function aiTransportSettingValue(): AiTransportChoice {
  const value = readSettingValue(AI_TRANSPORT_KEY);
  const text = typeof value === 'string' ? value.trim().toLowerCase() : '';
  return (AI_TRANSPORT_CHOICES as readonly string[]).includes(text) ? (text as AiTransportChoice) : 'auto';
}

/** Whether a direct endpoint must resolve to the local machine or a private network. */
export function aiLocalOnlySettingValue(): boolean {
  return readBooleanSwitch(AI_LOCAL_ONLY_KEY);
}

/**
 * The idle-watchdog window in milliseconds.
 *
 * A hand-edited value that is not a finite number, or one outside
 * {@link AI_MODEL_REQUEST_TIMEOUT_MIN_MS}–{@link AI_MODEL_REQUEST_TIMEOUT_MAX_MS},
 * reads as the default rather than being honoured: `0` would abort every request
 * before it started, and a negative number is not a duration at all, so neither
 * can be allowed to mean "the feature is broken now".
 */
export function aiModelRequestTimeoutMsSettingValue(): number {
  const value = readSettingValue(AI_MODEL_REQUEST_TIMEOUT_KEY);
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return AI_MODEL_REQUEST_TIMEOUT_DEFAULT_MS;
  }
  if (value < AI_MODEL_REQUEST_TIMEOUT_MIN_MS || value > AI_MODEL_REQUEST_TIMEOUT_MAX_MS) {
    return AI_MODEL_REQUEST_TIMEOUT_DEFAULT_MS;
  }
  return value;
}

/** The total cap for one direct request, derived from the idle window (§8.6). */
export function aiModelRequestTotalTimeoutMs(idleWindowMs: number): number {
  return idleWindowMs * AI_MODEL_REQUEST_TOTAL_TIMEOUT_FACTOR;
}

/** One model declaration, or `undefined` when the entry is not one. */
function parseAiProviderModel(value: unknown): AiProviderModelDeclaration | undefined {
  if (typeof value !== 'object' || value === null) {
    return undefined;
  }
  const entry = value as { id?: unknown; name?: unknown };
  if (typeof entry.id !== 'string' || entry.id.trim() === '') {
    return undefined;
  }
  const id = entry.id.trim();
  // The display name falls back to the id: a model with no name is not a reason to
  // lose the model, and the id is what a binding has to name anyway.
  const name = typeof entry.name === 'string' && entry.name.trim() !== '' ? entry.name.trim() : id;
  return { id, name };
}

/**
 * One header declaration, or `undefined` when the entry is not one.
 *
 * The returned object carries **only** the name. A `value` field in the stored
 * entry — written by hand, by an older build, or by an import from somewhere that
 * kept secrets in settings — is dropped here and never reaches a request: the one
 * place a header value may live is `SecretStorage` (§8.2), and honouring a value
 * found in settings would make that boundary optional in exactly the case it
 * exists for.
 */
function parseAiProviderHeader(value: unknown): AiProviderHeaderDeclaration | undefined {
  if (typeof value !== 'object' || value === null) {
    return undefined;
  }
  const entry = value as { name?: unknown };
  if (typeof entry.name !== 'string') {
    return undefined;
  }
  const name = entry.name.trim();
  if (!isAiProviderSegment(name)) {
    return undefined;
  }
  return { name, valueSecret: true };
}

/** Whether the text is one of the three contributed auth values. */
export function isAiProviderAuth(value: string): value is AiProviderAuth {
  return (AI_PROVIDER_AUTHS as readonly string[]).includes(value);
}

/**
 * One provider entry, or the reason it is not one.
 *
 * A missing or illegal `id`, a missing display name, a missing base URL, an
 * `auth` the manifest does not contribute, or a model/header list that is not a
 * list of the right shapes are all refusals, because none of them can be
 * interpreted into a provider: there is no sensible default for "where do I send
 * this", and guessing one is the failure the whole setting exists to prevent.
 */
export function parseAiProviderConfig(value: unknown): { provider: AiProviderConfig } | { reason: string } {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return { reason: 'it is not an object' };
  }
  const entry = value as Record<string, unknown>;
  const id = typeof entry.id === 'string' ? entry.id.trim() : '';
  if (id === '') {
    return { reason: 'it has no "id"' };
  }
  if (!isAiProviderSegment(id)) {
    return {
      reason: `its "id" is not a legal provider id (letters, digits, "_" and "-" only, because the id is part of a secret key)`,
    };
  }
  const name = typeof entry.name === 'string' ? entry.name.trim() : '';
  if (name === '') {
    return { reason: `provider "${id}" has no display name` };
  }
  const baseUrl = typeof entry.baseUrl === 'string' ? entry.baseUrl.trim() : '';
  if (baseUrl === '') {
    return { reason: `provider "${id}" has no "baseUrl"` };
  }
  const authText = typeof entry.auth === 'string' ? entry.auth.trim() : '';
  if (!isAiProviderAuth(authText)) {
    return {
      reason: `provider "${id}" has an "auth" this extension does not contribute (use "bearer", "api-key-header" or "none")`,
    };
  }
  const rawModels = entry.models;
  const models: AiProviderModelDeclaration[] = [];
  if (rawModels !== undefined) {
    if (!Array.isArray(rawModels)) {
      return { reason: `provider "${id}" has a "models" that is not a list` };
    }
    for (const candidate of rawModels) {
      const model = parseAiProviderModel(candidate);
      if (!model) {
        return { reason: `provider "${id}" has a model entry that is not a model` };
      }
      models.push(model);
    }
  }
  const rawHeaders = entry.headers;
  const headers: AiProviderHeaderDeclaration[] = [];
  if (rawHeaders !== undefined) {
    if (!Array.isArray(rawHeaders)) {
      return { reason: `provider "${id}" has a "headers" that is not a list` };
    }
    for (const candidate of rawHeaders) {
      const header = parseAiProviderHeader(candidate);
      if (!header) {
        return {
          reason: `provider "${id}" has a header whose name is missing or is not a legal header name (letters, digits, "_" and "-" only)`,
        };
      }
      headers.push(header);
    }
  }
  return {
    provider: {
      id,
      name,
      baseUrl,
      models,
      auth: authText,
      headers,
      // Only a provider that says `true` promises to be local; anything else is
      // the ordinary case, which the global policy then decides.
      localOnly: entry.localOnly === true,
    },
  };
}

/**
 * The provider list, with the entries that could not be read kept beside it.
 *
 * An absent value, a non-array, and a read that throws are all "no providers
 * configured" — the direction that sends nothing.
 */
export function aiProviderSettingsReading(): AiProviderSettingsReading {
  const raw = readSettingValue(AI_PROVIDERS_KEY);
  if (!Array.isArray(raw)) {
    return { providers: [], rejected: [] };
  }
  const providers: AiProviderConfig[] = [];
  const rejected: Array<{ index: number; reason: string }> = [];
  raw.forEach((entry, index) => {
    const parsed = parseAiProviderConfig(entry);
    if ('provider' in parsed) {
      providers.push(parsed.provider);
    } else {
      rejected.push({ index, reason: parsed.reason });
    }
  });
  return { providers, rejected };
}

/** The configured providers, without the rejections. */
export function aiProviderConfigsSettingValue(): AiProviderConfig[] {
  return aiProviderSettingsReading().providers;
}

/** One binding, or `undefined` when the entry is not one this build can honour. */
export function parseAiModelBinding(value: unknown): AiModelBinding | undefined {
  if (typeof value !== 'object' || value === null) {
    return undefined;
  }
  const entry = value as { feature?: unknown; providerId?: unknown; modelId?: unknown };
  const feature = typeof entry.feature === 'string' ? entry.feature.trim() : '';
  const providerId = typeof entry.providerId === 'string' ? entry.providerId.trim() : '';
  const modelId = typeof entry.modelId === 'string' ? entry.modelId.trim() : '';
  if (!isAiFeature(feature) || providerId === '' || modelId === '') {
    return undefined;
  }
  return { feature, providerId, modelId };
}

/**
 * The configured bindings.
 *
 * An entry naming a **feature this build does not know** is dropped rather than
 * refused, and that is the decision `docs/design/ai-model-transport.md` §13 leaves
 * to the implementation. Dropping it cannot send anything anywhere — the feature it
 * names has no code to reach a transport — while refusing the whole array would
 * discard the bindings of the features that do exist. An entry whose *feature* is
 * known but whose `providerId` names no configured provider is kept: that is a
 * real binding with a real problem, and §8.4 requires it to fail by name rather
 * than be resolved to a neighbour.
 */
export function aiModelBindingsSettingValue(): AiModelBinding[] {
  const raw = readSettingValue(AI_MODEL_BINDINGS_KEY);
  if (!Array.isArray(raw)) {
    return [];
  }
  const bindings: AiModelBinding[] = [];
  for (const entry of raw) {
    const binding = parseAiModelBinding(entry);
    if (binding) {
      bindings.push(binding);
    }
  }
  return bindings;
}

/** The binding that names this feature, or `undefined` when there is none. */
export function aiModelBindingFor(feature: AiFeature): AiModelBinding | undefined {
  return aiModelBindingsSettingValue().find((binding) => binding.feature === feature);
}
