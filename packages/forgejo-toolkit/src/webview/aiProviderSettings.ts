import * as vscode from 'vscode';
import type { RequestFetch } from '@cpf23333-forgejo-toolkit/shared/request';
import type {
  AiModelBindingDraft,
  AiProviderEditorEntry,
  AiProviderRejection,
  AiProviderSettingsSnapshot,
  AiProviderTestReport,
} from '@cpf23333-forgejo-toolkit/shared/webview/messages';
import { logger } from '../logger';
import {
  AI_FEATURES,
  AI_MODEL_REQUEST_TIMEOUT_MAX_MS,
  AI_MODEL_REQUEST_TIMEOUT_MIN_MS,
  AI_PROVIDERS_SETTING,
  AI_TRANSPORT_CHOICES,
  aiDefaultModelSettingValue,
  aiModelRequestTimeoutMsSettingValue,
  aiProviderSettingsReading,
  aiTransportSettingValue,
  inspectAiProviderBaseUrl,
  isAiFeature,
  isAiProviderAuth,
  isAiProviderSegment,
  parseAiModelBinding,
  type AiProviderConfig,
} from '../ai/modelSettings';
import {
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
import { openAiEndpointDisplayUrl, openAiEndpointUrl } from '../ai/openAiCompatibleTransport';
import { selectedModelFor } from '../ai/modelSelection';
import { aiProviderTestReport } from '../ai/testProvider';
import type { AiModelTransport } from '../ai/transport';

/**
 * The host side of the settings page's AI endpoint (provider) surface
 * (`docs/design/ai-model-transport.md` §8, §9.3).
 *
 * The module exists so the three boundaries §8.2 draws are enforced in one place
 * rather than by whichever message handler happens to be closest:
 *
 * 1. **The split between settings and `SecretStorage` is per kind of data, not per
 *    field name.** An endpoint's `id`, display name, base URL, declared models,
 *    auth *style* and header *names* are configuration and are written to
 *    `forgejoToolkit.aiProviders`; the API key and every custom header **value**
 *    are written to the editor's secret store and never into a setting. The
 *    snapshot this module builds is the other half of that rule: it reports
 *    whether a secret is stored and never its value, so the webview cannot echo
 *    one back even by accident.
 * 2. **A failed read is never a failed activation** (§8.3). Every settings read
 *    goes through the readers in `src/ai/modelSettings.ts`, which answer
 *    "not configured" for anything that throws, and this module never writes back
 *    the *parsed* provider list — it edits the raw array, so a hand-edited entry
 *    this build cannot read survives an unrelated edit instead of being silently
 *    deleted by it.
 * 3. **Reading sends nothing** (§7.2). `readAiProviderSettings` lists models,
 *    reads secrets and asks `selectedModelFor` which transport *would* serve the
 *    feature; only `runConfiguredProviderTest` sends a request, and it is reached
 *    from exactly one explicit click in the page.
 *
 * The settings this module writes are the ones a plain Settings entry is not
 * enough for: the provider list, the default destination, the per-feature
 * overrides, and the two policy values the page has to present beside the
 * endpoints they act on (`aiProviders`, `aiDefaultProvider`, `aiDefaultModel`,
 * `aiModelBindings`, `aiTransport`, `aiModelRequestTimeoutMs`). The global AI
 * switch (`forgejoToolkit.aiEnabled`) and the per-feature switches are read and
 * written by the page's own settings surface (`src/webview/settingsSurface.ts`),
 * which is where the page's *settings* — as opposed to its endpoint editors —
 * live. Every write goes to **global** scope, matching the manifest's own
 * `machine` scope (§8.3): a workspace-level value could point a repository's
 * content at an address the user never configured.
 */

/** The settings section every key of this extension lives under. */
const SETTINGS_SECTION = 'forgejoToolkit';

/**
 * The bare keys, for the `getConfiguration(section)` reads and writes.
 *
 * The full ids live in `src/ai/modelSettings.ts` (`AI_PROVIDERS_SETTING` and
 * friends) and are the names a user sees; the API splits the section from the key,
 * so both spellings are needed and neither is derived from the other by string
 * surgery.
 */
const AI_PROVIDERS_KEY = 'aiProviders';
const AI_MODEL_BINDINGS_KEY = 'aiModelBindings';
const AI_DEFAULT_PROVIDER_KEY = 'aiDefaultProvider';
const AI_DEFAULT_MODEL_KEY = 'aiDefaultModel';
const AI_TRANSPORT_KEY = 'aiTransport';
const AI_MODEL_REQUEST_TIMEOUT_KEY = 'aiModelRequestTimeoutMs';

/** What one host-side operation needs. */
export interface AiProviderSettingsDeps {
  secrets: AiSecretStore;
  /** Overridable so a test can answer the capability question without the editor's own models. */
  vscodeLm?: AiModelTransport;
  /** Overridable so a test can probe without the activation-time proxy install. */
  dispatcherPair?: () => { dispatcher?: unknown; fetchImpl?: RequestFetch };
}

/** One provider as the settings page submits it: configuration, plus header names only. */
export interface AiProviderConfigDraft {
  id: string;
  name: string;
  baseUrl: string;
  models: Array<{ id: string; name: string }>;
  auth: string;
  headers: string[];
}

/** The result of a write that has nothing else to say. */
export type AiProviderWriteResult = { ok: true } | { ok: false; error: string };

/** Reads one setting, answering `undefined` for anything that throws (§8.3). */
function readSettingValue(key: string): unknown {
  try {
    return vscode.workspace.getConfiguration(SETTINGS_SECTION).get<unknown>(key);
  } catch {
    return undefined;
  }
}

/** Writes one setting at global scope. */
export async function writeSettingValue(key: string, value: unknown): Promise<void> {
  await vscode.workspace.getConfiguration(SETTINGS_SECTION).update(key, value, vscode.ConfigurationTarget.Global);
}

/** The raw provider array, or `[]` when the setting holds anything else. */
function rawProviderArray(): unknown[] {
  const raw = readSettingValue(AI_PROVIDERS_KEY);
  return Array.isArray(raw) ? [...raw] : [];
}

/** The raw binding array, or `[]` when the setting holds anything else. */
function rawBindingArray(): unknown[] {
  const raw = readSettingValue(AI_MODEL_BINDINGS_KEY);
  return Array.isArray(raw) ? [...raw] : [];
}

/** The `id` a raw provider entry declares, when it declares a string one. */
function rawProviderId(entry: unknown): string | undefined {
  if (typeof entry !== 'object' || entry === null) {
    return undefined;
  }
  const id = (entry as { id?: unknown }).id;
  return typeof id === 'string' && id.trim() !== '' ? id.trim() : undefined;
}

/** The `api-version` header name, whose value travels as a query parameter (§6.2). */
function headerReadings(provider: AiProviderConfig, deps: AiProviderSettingsDeps) {
  return Promise.all(
    provider.headers.map(async (declaration) => ({
      name: declaration.name,
      set: (await readAiProviderHeaderValue(deps.secrets, provider.id, declaration.name)) !== undefined,
      shadowed: isAuthOwnedHeaderName(declaration.name),
      queryCarried: isQueryCarriedHeaderName(declaration.name),
    })),
  );
}

/**
 * One configured provider plus what is stored for it, as the page renders it.
 *
 * The address is computed here rather than in the webview for the same reason the
 * transport renders it that way: it is the one place that knows to drop the query
 * string (`api-version`'s value is a secret, §8.5) and the userinfo.
 */
async function describeProvider(
  provider: AiProviderConfig,
  deps: AiProviderSettingsDeps,
): Promise<AiProviderEditorEntry> {
  const verdict = inspectAiProviderBaseUrl(provider.baseUrl);
  const address = verdict.ok
    ? openAiEndpointDisplayUrl(openAiEndpointUrl(provider.baseUrl, ''))
    : provider.baseUrl.trim();
  return {
    id: provider.id,
    name: provider.name,
    baseUrl: provider.baseUrl,
    models: provider.models.map((model) => ({ id: model.id, name: model.name })),
    auth: provider.auth,
    headers: await headerReadings(provider, deps),
    // An endpoint with `auth: 'none'` needs no key, so "no key stored" is not a
    // state the page should warn about there; anything else is the §8.7 "the key
    // is the thing to add next" case.
    keySet: provider.auth !== 'none' && (await readAiProviderKey(deps.secrets, provider.id)) !== undefined,
    address,
    ...(verdict.ok ? {} : { addressError: verdict.reason }),
    insecure: verdict.ok && verdict.insecure,
  };
}

/**
 * Everything the provider section of the settings page renders, in one reading.
 *
 * `capability` is `selectedModelFor`'s own answer for the one AI feature this
 * build has (§9.3), reduced to the discriminator and its sentence: the page
 * branches on the code and never on which editor is open, which is what keeps the
 * "no usable model" block honest.
 */
export async function readAiProviderSettings(deps: AiProviderSettingsDeps): Promise<AiProviderSettingsSnapshot> {
  const reading = aiProviderSettingsReading();
  const providers: AiProviderEditorEntry[] = [];
  for (const provider of reading.providers) {
    providers.push(await describeProvider(provider, deps));
  }
  const raw = rawProviderArray();
  const rejected: AiProviderRejection[] = reading.rejected.map((entry) => {
    const id = rawProviderId(raw[entry.index]);
    return id === undefined
      ? { index: entry.index, reason: entry.reason }
      : { index: entry.index, reason: entry.reason, id };
  });
  const selection = await selectedModelFor('aiPreReview', deps);
  return {
    providers,
    rejected,
    transport: aiTransportSettingValue(),
    requestTimeoutMs: aiModelRequestTimeoutMsSettingValue(),
    defaultModel: aiDefaultModelSettingValue() ?? { providerId: '', modelId: '' },
    bindings: readBindings(),
    features: [...AI_FEATURES],
    selection:
      selection.kind === 'unavailable' ? 'none' : selection.kind === 'vscode-lm' ? 'editor' : 'configured-endpoint',
    capability:
      selection.kind === 'unavailable'
        ? { available: false, code: selection.code, reason: selection.reason }
        : { available: true },
  };
}

/** The configured bindings, as the page edits them. */
function readBindings(): AiModelBindingDraft[] {
  return rawBindingArray().flatMap((entry) => {
    const binding = parseAiModelBinding(entry);
    return binding === undefined
      ? []
      : [{ feature: binding.feature, providerId: binding.providerId, modelId: binding.modelId }];
  });
}

/**
 * The base URL's verdict as a message, or `undefined` when it can be a request's
 * target.
 *
 * The engine's own reason is interpolated rather than restated (§6.2 owns the
 * three refusals), the way `aiModelSelection` frames the reader's rejections.
 */
function baseUrlRefusal(baseUrl: string): string | undefined {
  const verdict = inspectAiProviderBaseUrl(baseUrl);
  if (verdict.ok) {
    return undefined;
  }
  return vscode.l10n.t('The endpoint base URL cannot be used: {0}', verdict.reason);
}

/**
 * One submitted provider entry, coerced from the webview's untrusted payload.
 *
 * Every field is read through a type check rather than asserted, because the
 * dispatcher's types describe what this extension sends, not what a compromised
 * webview may send: a number where a string belongs would otherwise throw inside
 * `.trim()` and reach the user as an internal error instead of a sentence.
 * Whatever survives the coercion is then validated by
 * {@link validateAiProviderDraft}.
 */
export function sanitizeAiProviderDraft(value: unknown): AiProviderConfigDraft {
  const entry = (typeof value === 'object' && value !== null ? value : {}) as Record<string, unknown>;
  const asString = (candidate: unknown): string => (typeof candidate === 'string' ? candidate : '');
  return {
    id: asString(entry['id']),
    name: asString(entry['name']),
    baseUrl: asString(entry['baseUrl']),
    models: (Array.isArray(entry['models']) ? entry['models'] : []).flatMap((model) => {
      if (typeof model !== 'object' || model === null) {
        return [];
      }
      const record = model as Record<string, unknown>;
      return [{ id: asString(record['id']), name: asString(record['name']) }];
    }),
    auth: asString(entry['auth']),
    headers: (Array.isArray(entry['headers']) ? entry['headers'] : []).filter(
      (name): name is string => typeof name === 'string',
    ),
  };
}

/**
 * Validates one submitted provider entry and answers the reason it cannot be
 * stored, or `undefined` when it can.
 *
 * The webview is untrusted input, so this repeats every check the page makes: the
 * id and every header name have to be a legal `SecretStorage` key segment (§8.2),
 * the display name and base URL have to be there, `auth` has to be one of the
 * three contributed values, and the URL has to be one `inspectAiProviderBaseUrl`
 * accepts. Duplicate declarations are refused rather than deduplicated, because a
 * second entry with the same name silently shadowing the first is exactly the
 * undiagnosable state §8.5 exists to prevent.
 */
export function validateAiProviderDraft(draft: AiProviderConfigDraft): string | undefined {
  const id = draft.id.trim();
  if (id === '') {
    return vscode.l10n.t('The endpoint id is required.');
  }
  if (!isAiProviderSegment(id)) {
    return vscode.l10n.t('The endpoint id may use letters, digits, "_" and "-" only.');
  }
  if (draft.name.trim() === '') {
    return vscode.l10n.t('The display name is required.');
  }
  if (draft.baseUrl.trim() === '') {
    return vscode.l10n.t('The base URL is required.');
  }
  const urlRefusal = baseUrlRefusal(draft.baseUrl.trim());
  if (urlRefusal !== undefined) {
    return urlRefusal;
  }
  if (!isAiProviderAuth(draft.auth)) {
    return vscode.l10n.t('The authentication style has to be "bearer", "api-key-header" or "none".');
  }
  const modelIds = new Set<string>();
  for (const model of draft.models) {
    if (model.id.trim() === '') {
      return vscode.l10n.t('Every model needs an id.');
    }
    if (modelIds.has(model.id.trim())) {
      return vscode.l10n.t('The model id "{0}" is declared twice.', model.id.trim());
    }
    modelIds.add(model.id.trim());
  }
  const headerNames = new Set<string>();
  for (const name of draft.headers) {
    if (!isAiProviderSegment(name.trim())) {
      return vscode.l10n.t('A header name may use letters, digits, "_" and "-" only.');
    }
    if (headerNames.has(name.trim())) {
      return vscode.l10n.t('The header name "{0}" is declared twice.', name.trim());
    }
    headerNames.add(name.trim());
  }
  return undefined;
}

/**
 * Stores one provider entry, replacing an entry that already uses the id.
 *
 * It is an **upsert** rather than an insert, because an entry with an existing id
 * is the entry being edited: the id is part of the key its secrets are stored
 * under (§8.2), so a second entry with the same id could only mean one of them
 * silently owns the other's credential. An entry this build cannot read keeps its
 * place in the array — only the matching index is replaced.
 *
 * Secrets are deliberately **not** touched here. A save may add or rename a model
 * or a header, and deleting a value the user did not clear would turn a rename
 * into data loss; a header value is cleared by submitting an empty value through
 * {@link writeAiProviderSecret}, and every secret of an endpoint is deleted by
 * {@link removeAiProvider}.
 */
export async function saveAiProvider(_deps: AiProviderSettingsDeps, value: unknown): Promise<AiProviderWriteResult> {
  const draft = sanitizeAiProviderDraft(value);
  const refusal = validateAiProviderDraft(draft);
  if (refusal !== undefined) {
    return { ok: false, error: refusal };
  }
  const id = draft.id.trim();
  const entry = {
    id,
    name: draft.name.trim(),
    baseUrl: draft.baseUrl.trim(),
    models: draft.models.map((model) => ({
      id: model.id.trim(),
      name: model.name.trim() === '' ? model.id.trim() : model.name.trim(),
    })),
    auth: draft.auth,
    // Only the **name** is stored, and the marker §10.2 keeps for a receiver that
    // was not given the value: a `value` field cannot be written into settings by
    // this path, and the reader drops one found there.
    headers: draft.headers.map((name) => ({ name: name.trim(), valueSecret: true })),
  };
  const raw = rawProviderArray();
  const index = raw.findIndex((candidate) => rawProviderId(candidate) === id);
  if (index >= 0) {
    raw[index] = entry;
  } else {
    raw.push(entry);
  }
  try {
    await writeSettingValue(AI_PROVIDERS_KEY, raw);
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
  logger.info(`AI endpoints: the settings page stored the endpoint "${id}" in "${AI_PROVIDERS_SETTING}"`);
  return { ok: true };
}

/**
 * Removes one provider entry and forgets every secret stored for it.
 *
 * The per-feature bindings are **not** rewritten: a binding that names the removed
 * endpoint is a real binding with a real problem, and §8.4 requires a run to fail
 * by name rather than be resolved to a neighbour — silently dropping the binding
 * would hide that. The page shows the binding as naming a missing endpoint.
 */
export async function removeAiProvider(deps: AiProviderSettingsDeps, value: unknown): Promise<AiProviderWriteResult> {
  const id = typeof value === 'string' ? value.trim() : '';
  const target = aiProviderSettingsReading().providers.find((provider) => provider.id === id);
  const raw = rawProviderArray();
  const next = raw.filter((candidate) => rawProviderId(candidate) !== id);
  if (next.length === raw.length) {
    return { ok: false, error: vscode.l10n.t('No AI endpoint with the id "{0}" is configured.', id) };
  }
  try {
    await writeSettingValue(AI_PROVIDERS_KEY, next);
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
  // The secrets go last: an entry that was removed from settings but whose secrets
  // survived is invisible, while a delete that succeeded before a failed write
  // would leave an endpoint whose credential is gone with no way to tell that it
  // once had one (the page reports "no key stored" either way, so the order that
  // cannot lose a working endpoint is the one where the configuration is what
  // changes first).
  await deleteAiProviderKey(deps.secrets, id).catch(() => undefined);
  for (const declaration of target?.headers ?? []) {
    await deleteAiProviderHeaderValue(deps.secrets, id, declaration.name).catch(() => undefined);
  }
  logger.info(`AI endpoints: the settings page removed the endpoint "${id}" and forgot its stored secrets`);
  return { ok: true };
}

/**
 * Stores (or clears) one secret of one configured endpoint.
 *
 * `headerName` absent means the API key; present, that declared header's value.
 * An empty `value` **clears** the secret, which is the only way to unset one: the
 * value itself is never read back into the webview (§8.2), so "set" and "not set"
 * are the only two states the page can show and clearing has to be an explicit act.
 *
 * The endpoint has to exist before a secret can be stored for it — an orphan
 * secret would be invisible in every surface and would still be sent if an entry
 * with that id were ever configured again.
 */
export async function writeAiProviderSecret(
  deps: AiProviderSettingsDeps,
  rawId: unknown,
  rawHeaderName: unknown,
  rawValue: unknown,
): Promise<{ ok: true; set: boolean } | { ok: false; error: string }> {
  const id = typeof rawId === 'string' ? rawId.trim() : '';
  const value = typeof rawValue === 'string' ? rawValue : '';
  if (!isAiProviderSegment(id)) {
    return { ok: false, error: vscode.l10n.t('The endpoint id may use letters, digits, "_" and "-" only.') };
  }
  const provider = aiProviderSettingsReading().providers.find((candidate) => candidate.id === id);
  if (provider === undefined) {
    return { ok: false, error: vscode.l10n.t('No AI endpoint with the id "{0}" is configured.', id) };
  }
  if (rawHeaderName === undefined) {
    if (value === '') {
      await deleteAiProviderKey(deps.secrets, id);
      return { ok: true, set: false };
    }
    await storeAiProviderKey(deps.secrets, id, value);
    return { ok: true, set: true };
  }
  const name = typeof rawHeaderName === 'string' ? rawHeaderName.trim() : '';
  if (!isAiProviderSegment(name)) {
    return { ok: false, error: vscode.l10n.t('A header name may use letters, digits, "_" and "-" only.') };
  }
  if (!provider.headers.some((declaration) => declaration.name === name)) {
    return {
      ok: false,
      error: vscode.l10n.t('The endpoint "{0}" does not declare a header named "{1}".', id, name),
    };
  }
  if (value === '') {
    await deleteAiProviderHeaderValue(deps.secrets, id, name);
    return { ok: true, set: false };
  }
  await storeAiProviderHeaderValue(deps.secrets, id, name, value);
  return { ok: true, set: true };
}

/**
 * Writes the model policy the settings page presents, at global scope (§8.3).
 *
 * Only the fields that differ from what is configured are written. The page always
 * submits its whole state, and a blind write of both would revert a change the user
 * made in VS Code's own Settings UI between opening the page and pressing the
 * control.
 */
export async function writeAiModelPolicy(
  _deps: AiProviderSettingsDeps,
  rawPolicy: unknown,
): Promise<AiProviderWriteResult> {
  const policy = (typeof rawPolicy === 'object' && rawPolicy !== null ? rawPolicy : {}) as Record<string, unknown>;
  const transport = typeof policy['transport'] === 'string' ? policy['transport'].trim().toLowerCase() : '';
  if (!(AI_TRANSPORT_CHOICES as readonly string[]).includes(transport)) {
    return { ok: false, error: vscode.l10n.t('The transport has to be "auto", "vscode-lm" or "openai-compatible".') };
  }
  const timeout = typeof policy['requestTimeoutMs'] === 'number' ? policy['requestTimeoutMs'] : Number.NaN;
  if (
    !Number.isFinite(timeout) ||
    Math.trunc(timeout) !== timeout ||
    timeout < AI_MODEL_REQUEST_TIMEOUT_MIN_MS ||
    timeout > AI_MODEL_REQUEST_TIMEOUT_MAX_MS
  ) {
    return {
      ok: false,
      error: vscode.l10n.t(
        'The request timeout has to be a whole number of milliseconds between {0} and {1}.',
        AI_MODEL_REQUEST_TIMEOUT_MIN_MS,
        AI_MODEL_REQUEST_TIMEOUT_MAX_MS,
      ),
    };
  }
  const writes: Array<Promise<void>> = [];
  if (transport !== aiTransportSettingValue()) {
    writes.push(writeSettingValue(AI_TRANSPORT_KEY, transport));
  }
  if (timeout !== aiModelRequestTimeoutMsSettingValue()) {
    writes.push(writeSettingValue(AI_MODEL_REQUEST_TIMEOUT_KEY, timeout));
  }
  try {
    await Promise.all(writes);
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
  logger.info(`AI endpoints: the settings page wrote the model policy (transport=${transport}, timeoutMs=${timeout})`);
  return { ok: true };
}

/**
 * Stores or clears one feature's binding (§8.4).
 *
 * `providerId` empty is the "no binding" state — the feature goes back to
 * `forgejoToolkit.aiTransport` — and the binding is then removed rather than kept
 * with an empty provider. Entries for features this build does not know are
 * preserved verbatim, which is the reading the array's own reader takes (§13
 * question 6): dropping them here would let one edit of the only known feature
 * discard a newer build's bindings.
 */
export async function writeAiModelBinding(
  _deps: AiProviderSettingsDeps,
  rawDraft: unknown,
): Promise<AiProviderWriteResult> {
  const record = (typeof rawDraft === 'object' && rawDraft !== null ? rawDraft : {}) as Record<string, unknown>;
  const feature = typeof record['feature'] === 'string' ? record['feature'].trim() : '';
  const providerId = typeof record['providerId'] === 'string' ? record['providerId'].trim() : '';
  const modelId = typeof record['modelId'] === 'string' ? record['modelId'].trim() : '';
  if (!isAiFeature(feature)) {
    return { ok: false, error: vscode.l10n.t('"{0}" is not an AI feature this build knows.', feature) };
  }
  if (providerId !== '') {
    const configured = aiProviderSettingsReading().providers.some((provider) => provider.id === providerId);
    if (!configured) {
      return {
        ok: false,
        error: vscode.l10n.t(
          'No AI endpoint with the id "{0}" is configured, so nothing can be bound to it.',
          providerId,
        ),
      };
    }
    if (modelId === '') {
      return { ok: false, error: vscode.l10n.t('A binding needs the model id to ask the endpoint for.') };
    }
  }
  const kept = rawBindingArray().filter((entry) => parseAiModelBinding(entry)?.feature !== feature);
  const next = providerId === '' ? kept : [...kept, { feature, providerId, modelId }];
  try {
    await writeSettingValue(AI_MODEL_BINDINGS_KEY, next);
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
  logger.info(
    `AI endpoints: the settings page wrote the binding for "${feature}" as "${providerId || '(none)'}/${modelId}"`,
  );
  return { ok: true };
}

/**
 * Stores or clears the **default** destination a direct request falls back to
 * (`docs/design/ai-model-transport.md` §8.4).
 *
 * The pair is validated the way a binding's endpoint is, and for the same reason:
 * a default that names a provider which is not configured is a real default with a
 * real problem, and §8.4 requires a run to fail by name rather than be resolved to
 * a neighbour. Both fields empty clears the default — the state every
 * configuration written before this pair existed reports — and a **half**-filled
 * pair is refused outright: there is no sensible model to invent for a provider id
 * on its own, and the direct path is not allowed to guess one.
 */
export async function writeAiDefaultModel(
  _deps: AiProviderSettingsDeps,
  rawDraft: unknown,
): Promise<AiProviderWriteResult> {
  const record = (typeof rawDraft === 'object' && rawDraft !== null ? rawDraft : {}) as Record<string, unknown>;
  const providerId = typeof record['providerId'] === 'string' ? record['providerId'].trim() : '';
  const modelId = typeof record['modelId'] === 'string' ? record['modelId'].trim() : '';
  if (providerId === '' && modelId === '') {
    try {
      await Promise.all([writeSettingValue(AI_DEFAULT_PROVIDER_KEY, ''), writeSettingValue(AI_DEFAULT_MODEL_KEY, '')]);
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
    logger.info('AI endpoints: the settings page cleared the default AI endpoint and model');
    return { ok: true };
  }
  if (providerId === '' || modelId === '') {
    return {
      ok: false,
      error: vscode.l10n.t(
        'The default needs both an endpoint and the model to ask it for: a model cannot be chosen on its own, and no model is guessed for an endpoint.',
      ),
    };
  }
  if (!aiProviderSettingsReading().providers.some((provider) => provider.id === providerId)) {
    return {
      ok: false,
      error: vscode.l10n.t('No AI endpoint with the id "{0}" is configured, so it cannot be the default.', providerId),
    };
  }
  try {
    await Promise.all([
      writeSettingValue(AI_DEFAULT_PROVIDER_KEY, providerId),
      writeSettingValue(AI_DEFAULT_MODEL_KEY, modelId),
    ]);
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
  logger.info(`AI endpoints: the settings page wrote the default endpoint and model as "${providerId}/${modelId}"`);
  return { ok: true };
}

/**
 * Runs the §8.7 probe for one configured endpoint, as a structured report.
 *
 * `undefined` means no endpoint with that id is configured; the caller answers
 * that itself, because only it knows whether it was a page click or the palette
 * command that asked.
 */
export async function testAiProvider(
  deps: AiProviderSettingsDeps,
  rawId: unknown,
): Promise<AiProviderTestReport | undefined> {
  const id = typeof rawId === 'string' ? rawId.trim() : '';
  const provider = aiProviderSettingsReading().providers.find((candidate) => candidate.id === id);
  if (provider === undefined) {
    return undefined;
  }
  return await aiProviderTestReport(provider, {
    secrets: deps.secrets,
    ...(deps.dispatcherPair ? { dispatcherPair: deps.dispatcherPair } : {}),
  });
}
