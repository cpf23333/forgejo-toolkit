import * as vscode from 'vscode';
import type {
  AiImportPreviewProvider,
  ExportAiConfig,
  ExportAiProvider,
  ExportAiSecrets,
  HostToWebviewMessage,
  ImportAiConflictStrategy,
} from '@cpf23333-forgejo-toolkit/shared/webview/messages';
import { logger } from '../logger';
import {
  aiLocalOnlySettingValue,
  aiModelBindingsSettingValue,
  aiProviderSettingsReading,
  aiTransportSettingValue,
  inspectAiProviderBaseUrl,
  isAiProviderSegment,
  parseAiModelBinding,
  parseAiProviderConfig,
  type AiModelBinding,
  type AiProviderConfig,
  type AiTransportChoice,
} from '../ai/modelSettings';
import {
  readAiProviderHeaderValue,
  readAiProviderKey,
  storeAiProviderHeaderValue,
  storeAiProviderKey,
  type AiSecretStore,
} from '../ai/providerSecrets';
import { saveAiProvider, validateAiProviderDraft, writeSettingValue } from './aiProviderSettings';

/**
 * The AI endpoint half of export and import (`docs/design/ai-model-transport.md`
 * §10), for the same file the instance list already uses.
 *
 * Five rules shape this module, and every one of them is a rule the record
 * decided rather than a preference of the implementation:
 *
 * 1. **Non-secret configuration round-trips; secrets do not, unless the export is
 *    encrypted** (§10.2). {@link readAiConfigForExport} reads the provider list,
 *    the per-feature bindings, the transport value and the local-only policy from
 *    settings — and the API key and every custom header **value** from
 *    `SecretStorage`. The two halves are returned separately so the export can put
 *    the secrets only into the encrypted wrapper, exactly where the instance
 *    tokens already go.
 * 2. **The file's AI section is untrusted input** (§10.1). It is rebuilt field by
 *    field into fresh objects, so an unknown key is *dropped* rather than carried
 *    into `settings.json`; an entry that is not a provider at all is refused rather
 *    than guessed at. Ids and URLs go through the very validators the settings
 *    editor uses (`parseAiProviderConfig`, `validateAiProviderDraft`), so an
 *    imported endpoint cannot be accepted by a rule the page would have refused.
 * 3. **Importing never turns egress on** (§10.3, §7.4). {@link applyAiImport}
 *    writes the provider list, the bindings and a *restricting* local-only policy —
 *    and never `forgejoToolkit.aiProvidersEnabled`, `forgejoToolkit.aiPreReview` or
 *    `forgejoToolkit.aiPreReviewPromptScope`, which are the keys that change what
 *    leaves the machine. The transport value is shown in the preview but not
 *    applied, for the reason §7.4 gives: the opposite value on the receiving
 *    machine may be a working setup, and a file is the wrong thing to walk back.
 * 4. **A secret lands in `SecretStorage`, never in settings** (§8.2). The values
 *    travel inside the encrypted payload only and are written through
 *    `src/ai/providerSecrets.ts` — the same accessors the settings page uses, which
 *    is what makes a hand-written `value` field unable to smuggle one into
 *    `settings.json`.
 * 5. **A preview says what the file carries before anything is written** (§10.1,
 *    §10.3). {@link buildAiImportPreview} answers the conflict question for each
 *    provider the file declares, flags a plain-`http://` address, and states
 *    whether secrets came with the file at all.
 */

/**
 * The version the export writes into its envelope (§10.1). `2` was the version
 * before the `ai` section existed; the reader stays version-tolerant (see
 * `readExportDataFromUri`), so a `2` payload still imports.
 */
export const EXPORT_PAYLOAD_VERSION = 3;

/** A trimmed non-empty string, or `undefined`. */
function nonEmpty(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
}

/** A string that is a legal `.`-separated secret-key segment, or `undefined`. */
function asSegment(value: unknown): string | undefined {
  const text = nonEmpty(value);
  return text !== undefined && isAiProviderSegment(text) ? text : undefined;
}

/**
 * One provider entry as the export writes it.
 *
 * The shape is the settings shape (§8.1) with the header values left out: a
 * declared header exports as `{ name, valueSecret: true }`, the receiver's marker
 * that a value exists without being given it. A `value` field found in the stored
 * declaration is **not** copied — the reader drops one, and the only place a
 * header value may live is `SecretStorage` (§8.2).
 */
function toExportProvider(provider: AiProviderConfig): ExportAiProvider {
  return {
    id: provider.id,
    name: provider.name,
    baseUrl: provider.baseUrl,
    models: provider.models.map((model) => ({ id: model.id, name: model.name })),
    auth: provider.auth,
    headers: provider.headers.map((declaration) => ({ name: declaration.name, valueSecret: true })),
    localOnly: provider.localOnly,
  };
}

/** What one export writes: the non-secret `ai` section, plus the secrets it must not. */
export interface AiExportReading {
  ai: ExportAiConfig;
  secrets: ExportAiSecrets;
}

/**
 * Reads the AI configuration for an export (§10.1) and the credentials that may
 * only travel inside its encrypted wrapper (§10.2).
 *
 * Both halves are always computed: the caller decides whether it is encrypting,
 * and a plaintext export simply writes `ai` without `secrets` — which is the
 * structural reason a key or a header value cannot reach an unencrypted file. The
 * secrets are read for every configured provider, keyed by the provider id and by
 * the header's own name, so the receiver's write can go through the very accessors
 * that own those keys.
 */
export async function readAiConfigForExport(secrets: AiSecretStore): Promise<AiExportReading> {
  const providers = aiProviderSettingsReading().providers.map(toExportProvider);
  const keys: Record<string, string> = {};
  const headerValues: Record<string, Record<string, string>> = {};
  for (const provider of providers) {
    const key = await readAiProviderKey(secrets, provider.id);
    if (key !== undefined) {
      keys[provider.id] = key;
    }
    for (const declaration of provider.headers) {
      const value = await readAiProviderHeaderValue(secrets, provider.id, declaration.name);
      if (value !== undefined) {
        headerValues[provider.id] = { ...(headerValues[provider.id] ?? {}), [declaration.name]: value };
      }
    }
  }
  return {
    ai: {
      providers,
      bindings: aiModelBindingsSettingValue().map((binding) => ({ ...binding })),
      transport: aiTransportSettingValue(),
      localOnly: aiLocalOnlySettingValue(),
    },
    secrets: { keys, headerValues },
  };
}

/**
 * True when an `ai` section has anything to apply.
 *
 * §10.1 shows the section as part of the `version: 3` payload and does not make it
 * conditional, so the section itself is always written. This predicate only
 * decides whether the *reading* has something to say: a machine with no endpoints
 * and default policy exports an empty section, which imports as "nothing to do"
 * rather than as a settings rewrite.
 */
export function aiConfigHasContent(ai: ExportAiConfig): boolean {
  return ai.providers.length > 0 || ai.bindings.length > 0 || ai.localOnly;
}

/** One model declaration of an imported provider, or `undefined` when it is not one. */
function parseImportedModel(value: unknown): { id: string; name: string } | undefined {
  if (typeof value !== 'object' || value === null) {
    return undefined;
  }
  const entry = value as { id?: unknown; name?: unknown };
  const id = nonEmpty(entry.id);
  if (id === undefined) {
    return undefined;
  }
  // The display name falls back to the id, the way the settings reader does: a
  // model with no name is not a reason to lose the model.
  return { id, name: nonEmpty(entry.name) ?? id };
}

/** One header declaration of an imported provider, or `undefined` when it is not one. */
function parseImportedHeader(value: unknown): { name: string; valueSecret: true } | undefined {
  if (typeof value !== 'object' || value === null) {
    return undefined;
  }
  const name = asSegment((value as { name?: unknown }).name);
  return name === undefined ? undefined : { name, valueSecret: true };
}

/**
 * The parsed providers of an `ai` section as the host's own provider type.
 *
 * The entries have already been rebuilt field by field by
 * {@link parseAiImportedAiConfig}, so this is a re-typing rather than a second
 * validation: `parseAiProviderConfig` is the parser every other host path reads
 * settings through, and running it here is what makes an imported provider and a
 * configured one the same kind of thing (including its `valueSecret` marker, which
 * is dropped-in-shape from a file that wrote one). An entry it refuses is left out,
 * which cannot lose anything a preview did not already show.
 */
export function parsedAiProviderConfigs(parsed: ParsedAiSection): AiProviderConfig[] {
  const providers: AiProviderConfig[] = [];
  for (const entry of parsed.config.providers) {
    const result = parseAiProviderConfig(entry);
    if ('provider' in result) {
      providers.push(result.provider);
    }
  }
  return providers;
}

/** The `ai` section of an import file, with its secrets kept apart. */
export interface ParsedAiSection {
  config: ExportAiConfig;
  /** The file's own claim that the `secrets` block was present (i.e. it was encrypted). */
  secretsIncluded: boolean;
  secrets: ExportAiSecrets;
}

/**
 * Parses the `ai` section of an import file into the export shape.
 *
 * Every field is rebuilt from what it is, never asserted: a `models` entry that is
 * not a model, a header whose name cannot be part of a secret key, an `auth` this
 * build does not contribute, or a `transport` that is not one of the three values
 * all mean the section is not usable, and the answer is `undefined` rather than a
 * guessed default. `undefined` is also what a file with no `ai` section answers,
 * which is what keeps a `version: 2` payload importable.
 *
 * `secretsIncluded` is the block's presence, reported next to the values rather
 * than inferred from them, because the preview has to be able to say "this file
 * carried no secrets" for a plaintext export whose section is otherwise complete.
 */
export function parseAiImportedAiConfig(value: unknown): ParsedAiSection | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return undefined;
  }
  const raw = value as Record<string, unknown>;

  const providers: ExportAiProvider[] = [];
  if (raw.providers !== undefined) {
    if (!Array.isArray(raw.providers)) {
      return undefined;
    }
    for (const candidate of raw.providers) {
      const provider = parseImportedProvider(candidate);
      if (provider === undefined) {
        return undefined;
      }
      providers.push(provider);
    }
  }

  const bindings: AiModelBinding[] = [];
  if (raw.bindings !== undefined) {
    if (!Array.isArray(raw.bindings)) {
      return undefined;
    }
    for (const candidate of raw.bindings) {
      const binding = parseAiModelBinding(candidate);
      if (binding === undefined) {
        // An unknown feature id, a missing provider or a missing model: the
        // array's own reader drops these, and so does this one (§13 question 6).
        continue;
      }
      bindings.push(binding);
    }
  }

  const transport = raw.transport;
  if (transport !== undefined && !isAiTransportChoice(transport)) {
    return undefined;
  }

  const secrets = parseAiImportedSecrets(raw.secrets);
  return {
    config: {
      providers,
      bindings,
      transport: transport === undefined ? 'auto' : transport,
      localOnly: raw.localOnly === true,
    },
    secretsIncluded: secrets !== undefined,
    secrets: secrets ?? { keys: {}, headerValues: {} },
  };
}

/** One imported provider entry, or `undefined` when it is not usable as one. */
function parseImportedProvider(candidate: unknown): ExportAiProvider | undefined {
  if (typeof candidate !== 'object' || candidate === null || Array.isArray(candidate)) {
    return undefined;
  }
  const entry = candidate as Record<string, unknown>;
  const id = asSegment(entry.id);
  const name = nonEmpty(entry.name);
  const baseUrl = nonEmpty(entry.baseUrl);
  if (id === undefined || name === undefined || baseUrl === undefined) {
    return undefined;
  }
  if (!isAiProviderAuthValue(entry.auth)) {
    return undefined;
  }
  const models: ExportAiProvider['models'] = [];
  if (entry.models !== undefined) {
    if (!Array.isArray(entry.models)) {
      return undefined;
    }
    for (const rawModel of entry.models) {
      const model = parseImportedModel(rawModel);
      if (model === undefined) {
        return undefined;
      }
      models.push(model);
    }
  }
  const headers: ExportAiProvider['headers'] = [];
  if (entry.headers !== undefined) {
    if (!Array.isArray(entry.headers)) {
      return undefined;
    }
    for (const rawHeader of entry.headers) {
      const header = parseImportedHeader(rawHeader);
      if (header === undefined) {
        return undefined;
      }
      headers.push(header);
    }
  }
  return {
    id,
    name,
    baseUrl,
    models,
    auth: entry.auth,
    headers,
    // Anything but an explicit `true` is "no per-endpoint promise", the reading
    // the settings parser itself takes.
    localOnly: entry.localOnly === true,
  };
}

/** Whether the value is one of the three `auth` styles (§8.5). */
function isAiProviderAuthValue(value: unknown): value is ExportAiProvider['auth'] {
  return value === 'bearer' || value === 'api-key-header' || value === 'none';
}

/** Whether the value is one of the three `aiTransport` values (§8.4). */
function isAiTransportChoice(value: unknown): value is AiTransportChoice {
  return value === 'auto' || value === 'vscode-lm' || value === 'openai-compatible';
}

/**
 * Parses the `secrets` block an **encrypted** export carries (§10.2).
 *
 * A provider id or header name that could not be part of a `SecretStorage` key is
 * dropped rather than repaired, for the reason `aiProviderHeaderSecretKey` refuses
 * one: a name that does not round-trip could address another provider's secret.
 */
function parseAiImportedSecrets(value: unknown): ExportAiSecrets | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return undefined;
  }
  const raw = value as Record<string, unknown>;
  const keys: Record<string, string> = {};
  if (typeof raw.keys === 'object' && raw.keys !== null && !Array.isArray(raw.keys)) {
    for (const [providerId, secret] of Object.entries(raw.keys as Record<string, unknown>)) {
      if (isAiProviderSegment(providerId) && typeof secret === 'string' && secret !== '') {
        keys[providerId] = secret;
      }
    }
  }
  const headerValues: Record<string, Record<string, string>> = {};
  if (typeof raw.headerValues === 'object' && raw.headerValues !== null && !Array.isArray(raw.headerValues)) {
    for (const [providerId, headers] of Object.entries(raw.headerValues as Record<string, unknown>)) {
      if (
        !isAiProviderSegment(providerId) ||
        typeof headers !== 'object' ||
        headers === null ||
        Array.isArray(headers)
      ) {
        continue;
      }
      const kept: Record<string, string> = {};
      for (const [headerName, secret] of Object.entries(headers as Record<string, unknown>)) {
        if (isAiProviderSegment(headerName) && typeof secret === 'string' && secret !== '') {
          kept[headerName] = secret;
        }
      }
      if (Object.keys(kept).length > 0) {
        headerValues[providerId] = kept;
      }
    }
  }
  return { keys, headerValues };
}

/**
 * A collision-free id for an imported provider, close to the one the file named.
 *
 * The suffix form follows the settings page's own id-collision discipline: the
 * declared id is kept when it is free, and a numeric suffix is added when it is
 * not, so the entry is still recognisable as the one the file declared.
 */
export function uniqueImportedProviderId(declared: string, taken: readonly string[]): string {
  const used = new Set(taken);
  if (!used.has(declared)) {
    return declared;
  }
  for (let suffix = 2; suffix < 1000; suffix += 1) {
    const candidate = `${declared}-${suffix}`;
    if (!used.has(candidate)) {
      return candidate;
    }
  }
  return `${declared}-${used.size}`;
}

/** What one previewed provider is, before the user has chosen anything. */
export interface AiImportProviderPreview {
  provider: AiProviderConfig;
  preview: AiImportPreviewProvider;
}

/** The preview plus the plan a later confirmation resolves against. */
export interface AiImportPreview {
  ai: NonNullable<Extract<HostToWebviewMessage, { command: 'importInstancesPreview' }>['ai']>;
  previews: AiImportProviderPreview[];
}

/** The draft shape the settings validator takes, built from one parsed provider. */
function toDraft(provider: AiProviderConfig) {
  return {
    id: provider.id,
    name: provider.name,
    baseUrl: provider.baseUrl,
    models: provider.models.map((model) => ({ id: model.id, name: model.name })),
    auth: provider.auth,
    headers: provider.headers.map((declaration) => declaration.name),
    localOnly: provider.localOnly,
  };
}

/** Everything one already-parsed provider needs decided before it is offered. */
function describeImportedProvider(provider: AiProviderConfig, existing: boolean): AiImportProviderPreview {
  const refusal = validateAiProviderDraft(toDraft(provider));
  const verdict = inspectAiProviderBaseUrl(provider.baseUrl);
  return {
    provider,
    preview: {
      id: provider.id,
      name: provider.name,
      baseUrl: provider.baseUrl,
      auth: provider.auth,
      models: provider.models.map((model) => model.id),
      headers: provider.headers.map((declaration) => declaration.name),
      localOnly: provider.localOnly,
      existing,
      // Only meaningful for an entry that will be offered: an address the editor
      // refuses is already unusable, and warning about its encryption is noise.
      ...(refusal === undefined && verdict.ok && verdict.insecure ? { insecure: true } : {}),
      ...(refusal === undefined ? {} : { unusable: refusal }),
    },
  };
}

/**
 * Builds the AI half of the import preview (§10.1, §10.3).
 *
 * Each provider is checked here, **before** the user is offered it, because the
 * preview is the surface that decides whether an import is acceptable: an id
 * collision is a choice (rename / keep / replace, the same three the instance
 * preview offers), a plain-`http://` address is flagged here rather than only at
 * run time (importing is itself the act that points content at an address), and an
 * address the editor would refuse is reported as unusable instead of being offered
 * as importable.
 *
 * `taken` is the set of ids already configured — including entries this build
 * cannot read, which are not offered for collision resolution but still own their
 * ids, exactly as they keep their place in the array on any settings write.
 */
export function buildAiImportPreview(parsed: ParsedAiSection, taken: readonly string[]): AiImportPreview {
  const takenIds = new Set(taken);
  const previews = parsed.config.providers.map((provider) =>
    describeImportedProvider(provider, takenIds.has(provider.id)),
  );
  return {
    previews,
    ai: {
      providers: previews.map((entry) => entry.preview),
      bindings: parsed.config.bindings.map((binding) => ({ ...binding })),
      transport: parsed.config.transport,
      localOnly: parsed.config.localOnly,
      secretsIncluded: parsed.secretsIncluded,
    },
  };
}

/** One provider's resolved destination. */
export interface AiImportResolvedProvider {
  /** The id the file declared. */
  id: string;
  /** The id the entry will occupy (the declared one, or a collision-free sibling). */
  targetId: string;
  /**
   * How it got there. `add` is the no-collision case: the id was free, so nothing
   * had to be decided. The other three are the user's answer to a collision.
   */
  mode: 'add' | ImportAiConflictStrategy;
}

/** The per-provider collision strategy the preview confirmation carries. */
export type AiImportConflictChoices = Record<string, ImportAiConflictStrategy>;

/** What a confirmation resolves into. */
export interface AiImportResolution {
  resolved: AiImportResolvedProvider[];
  /** Declared ids that will not be written, so a binding may not name them. */
  unavailable: Set<string>;
}

/**
 * Resolves the chosen collision strategy into the id each provider will occupy.
 *
 * `keep` follows the answer the settings reader already gives for an id that is
 * present twice: the stored entry wins, so the file's entry is not written. Every
 * declared id is named in the result — including the ones that will not be written
 * — so the caller can decide what a binding may still refer to.
 */
export function resolveAiImportProviders(
  previews: readonly AiImportProviderPreview[],
  choices: AiImportConflictChoices,
  taken: readonly string[],
): AiImportResolution {
  const resolved: AiImportResolvedProvider[] = [];
  const unavailable = new Set<string>();
  const used = [...taken];
  for (const entry of previews) {
    const declared = entry.provider.id;
    if (entry.preview.unusable !== undefined) {
      // Never offered, so never written: an address the editor refuses cannot
      // become a destination by being imported.
      unavailable.add(declared);
      continue;
    }
    if (!entry.preview.existing) {
      used.push(declared);
      resolved.push({ id: declared, targetId: declared, mode: 'add' });
      continue;
    }
    const strategy = choices[declared] ?? 'keep';
    if (strategy === 'keep') {
      unavailable.add(declared);
      continue;
    }
    if (strategy === 'replace') {
      used.push(declared);
      resolved.push({ id: declared, targetId: declared, mode: strategy });
      continue;
    }
    if (strategy !== 'rename') {
      // Anything else is a value this build does not know, and the reading is the
      // fail-closed one: the stored entry stays and the file's entry is not
      // written, which is the same answer an absent choice gets.
      unavailable.add(declared);
      continue;
    }
    const targetId = uniqueImportedProviderId(declared, used);
    used.push(targetId);
    resolved.push({ id: declared, targetId, mode: strategy });
  }
  return { resolved, unavailable };
}

/** Everything the host keeps between a preview and the import it confirms. */
export interface AiImportPlan {
  config: ExportAiConfig;
  /** True when the file's `ai` section actually carried secrets (i.e. it was encrypted). */
  secretsIncluded: boolean;
  secrets: ExportAiSecrets;
  /** The parsed providers, in file order, for the resolver. */
  providers: AiProviderConfig[];
}

/**
 * Writes the confirmed AI configuration: the providers and bindings into
 * settings, the credentials into `SecretStorage`, and nothing else.
 *
 * The order is: providers first, then their secrets, then the bindings. A failed
 * settings write therefore leaves no secret behind for an entry that does not
 * exist (an orphan secret would be invisible in every surface and would still be
 * sent if an entry with that id were ever configured again), and the bindings go
 * last because a binding may only name a provider that is now configured — a
 * binding this import cannot honour is dropped and its declared id reported, rather
 * than written as a dangling reference.
 *
 * **Nothing here writes `forgejoToolkit.aiProvidersEnabled`,
 * `forgejoToolkit.aiPreReview` or `forgejoToolkit.aiPreReviewPromptScope`.** That
 * is how "the import must not silently enable egress" is guaranteed: the only keys
 * this function touches are the provider list (through `saveAiProvider`, the same
 * writer the settings page uses), the bindings, and the local-only policy — and the
 * local-only policy is only ever written as `true`, the restricting value, so no
 * file can relax the receiving machine's posture.
 */
export async function applyAiImport(
  plan: AiImportPlan,
  choices: AiImportConflictChoices,
  secrets: AiSecretStore,
): Promise<{ applied: number; skippedBindings: string[] }> {
  const taken = configuredAiProviderIds();
  // The collision question is answered against the ids that are **configured**,
  // not against the declared list: a provider whose id is free is written under it,
  // and one whose id is taken needs the user's decision — the same question the
  // preview asked, so a confirmation cannot resolve an entry differently from what
  // it showed.
  const previews = plan.providers.map((provider) => describeImportedProvider(provider, taken.includes(provider.id)));
  const { resolved, unavailable } = resolveAiImportProviders(previews, choices, taken);
  // Resolved entries are read **in order**, and an entry whose resolved id is
  // already taken is dropped: a file may declare one id twice, and the resolver
  // cannot rename without asking a question the preview never put to the user. Two
  // entries with the same id cannot both be stored anyway — the settings writer is an
  // upsert by id — so the honest outcome is to write the first, drop the second and
  // name it, rather than let the second silently become the first.
  let nextResolved = 0;
  const appliedIds = new Set<string>();
  for (const provider of plan.providers) {
    const entry = resolved[nextResolved];
    if (entry === undefined || entry.id !== provider.id) {
      continue;
    }
    nextResolved += 1;
    if (appliedIds.has(entry.targetId)) {
      unavailable.add(provider.id);
      logger.error(
        `AI endpoints: the import file declares the endpoint id "${provider.id}" more than once, so only the first entry was written`,
      );
      continue;
    }
    const result = await saveAiProvider({ secrets }, { ...toDraft(provider), id: entry.targetId });
    if (!result.ok) {
      // A refusal here is the settings writer's own verdict on an entry the
      // preview had accepted: the entry is dropped and named rather than
      // half-imported.
      unavailable.add(entry.id);
      logger.error(`AI endpoints: the imported endpoint "${entry.targetId}" was refused: ${result.error}`);
      continue;
    }
    appliedIds.add(entry.targetId);
    const key = plan.secrets.keys[entry.id];
    if (key !== undefined) {
      await storeAiProviderKey(secrets, entry.targetId, key).catch(() => {
        logger.error(`AI endpoints: the imported key for "${entry.targetId}" could not be stored`);
      });
    }
    for (const declaration of provider.headers) {
      const value = plan.secrets.headerValues[entry.id]?.[declaration.name];
      if (value === undefined) {
        continue;
      }
      await storeAiProviderHeaderValue(secrets, entry.targetId, declaration.name, value).catch(() => undefined);
    }
  }

  const skippedBindings: string[] = [];
  const replacedFeatures = new Set(plan.config.bindings.map((binding) => binding.feature));
  // Entries this build cannot read are kept verbatim, the same reason the settings
  // page edits the raw array rather than the parsed list.
  const next = readRawBindings().filter((entry) => {
    const binding = parseAiModelBinding(entry);
    return binding === undefined ? true : !replacedFeatures.has(binding.feature);
  });
  const writtenBindings: unknown[] = [];
  for (const binding of plan.config.bindings) {
    const targetId = resolved.find((entry) => entry.id === binding.providerId)?.targetId;
    if (targetId === undefined || !appliedIds.has(targetId)) {
      skippedBindings.push(binding.providerId);
      continue;
    }
    writtenBindings.push({ feature: binding.feature, providerId: targetId, modelId: binding.modelId });
  }
  // Only when something survives: writing the filtered array with nothing added
  // would *remove* the receiving machine's binding for a feature the file named,
  // which is a change no confirmation asked for.
  if (writtenBindings.length > 0) {
    await writeSettingValue('aiModelBindings', [...next, ...writtenBindings]);
  }
  if (plan.config.localOnly && !aiLocalOnlySettingValue()) {
    await writeSettingValue('aiLocalOnly', true);
  }
  return { applied: appliedIds.size, skippedBindings };
}

/** The stored bindings, raw, so an entry this build cannot read survives a write. */
function readRawBindings(): unknown[] {
  try {
    const raw = vscode.workspace.getConfiguration('forgejoToolkit').get<unknown>('aiModelBindings');
    return Array.isArray(raw) ? [...raw] : [];
  } catch {
    return [];
  }
}

/**
 * The configured provider ids, including entries this build cannot read.
 *
 * Read from the raw setting, not from the parsed list, because an unreadable entry
 * still owns its id: the settings writer replaces by id and would otherwise be
 * handed an id a stored entry already holds.
 */
export function configuredAiProviderIds(): string[] {
  let raw: unknown;
  try {
    raw = vscode.workspace.getConfiguration('forgejoToolkit').get<unknown>('aiProviders');
  } catch {
    return [];
  }
  if (!Array.isArray(raw)) {
    return [];
  }
  const ids: string[] = [];
  for (const entry of raw) {
    if (typeof entry !== 'object' || entry === null) {
      continue;
    }
    const id = asSegment((entry as { id?: unknown }).id);
    if (id !== undefined) {
      ids.push(id);
    }
  }
  return ids;
}
