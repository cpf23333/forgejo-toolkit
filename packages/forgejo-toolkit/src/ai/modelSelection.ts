import * as vscode from 'vscode';
import type { RequestFetch } from '@cpf23333-forgejo-toolkit/shared/request';
import { logger } from '../logger';
import { vscodeLmTransport } from './vscodeLmTransport';
import { openAiCompatibleTransportFor } from './openAiCompatibleTransport';
import type { AiModelInfo, AiModelTransport } from './transport';
import {
  aiModelBindingFor,
  aiProviderSettingsReading,
  aiProvidersEnabledSettingValue,
  aiTransportSettingValue,
  isAiFeature,
  type AiFeature,
  type AiProviderConfig,
} from './modelSettings';
import type { AiSecretStore } from './providerSecrets';

/**
 * The one place that decides which transport serves a feature, and with which
 * model (`docs/design/ai-model-transport.md` §8.4).
 *
 * It exists so that "which endpoint does this content go to" is answerable in one
 * function rather than distributed across the features, and so that the two things
 * the record forbids are impossible by construction:
 *
 * - **No fallback between transports** (§7.5). A binding that cannot be honoured is
 *   a failure, a direct endpoint that is unavailable is a failure, and an editor
 *   that cannot serve a request is a failure. No branch here substitutes one for
 *   another, and the `unavailable` arm carries the sentence that says why.
 * - **No "configured therefore enabled"** (§7.3). A provider is reached only when
 *   `forgejoToolkit.aiProvidersEnabled` is on **and** this feature names it (or
 *   `auto` can determine exactly one endpoint). Configuration alone never opens
 *   egress.
 *
 * It answers **by capability, never by brand** (§9.1): the `vscode.lm` question is
 * "does the API exist and does it list a model", which is why a VSCodium with no
 * model provider and a VS Code with Copilot signed out take the same branch. No
 * `vscode.env.appName` / `uriScheme` / `appHost` / `remoteName` is read anywhere in
 * this module directory — `src/__tests__/aiModelSettings.test.ts` asserts that.
 *
 * Nothing here sends anything: `availability()`, `listModels()` and a secret read
 * are all lookups, which is what keeps "nothing leaves the machine before the
 * consent question is answered" true however the choice comes out (§7.2).
 */

/** Why no transport could be selected. The setting page branches on this; the sentence explains it. */
export type AiUnavailableCode =
  /** Nothing is offered and nothing is configured. */
  | 'no-model'
  /** No endpoint is configured at all. */
  | 'configure'
  /** An endpoint is configured but nothing says which one to use. */
  | 'bind'
  /** The egress switch (`forgejoToolkit.aiProvidersEnabled`) is off. */
  | 'disabled'
  /** A named endpoint exists but cannot be used (URL, local-only policy, missing key). */
  | 'endpoint-unusable'
  /** The editor's own model API is absent or failed. */
  | 'editor-unusable';

/** Which transport serves a feature, and why — the debug line §8.4 requires. */
export type AiTransportSelection =
  | { kind: 'vscode-lm'; transport: AiModelTransport; reason: string }
  | { kind: 'openai-compatible'; transport: AiModelTransport; model: AiModelInfo; reason: string }
  | {
      kind: 'unavailable';
      code: AiUnavailableCode;
      reason: string;
      /**
       * The configured-endpoint route's own reading, present only when the selector
       * consulted it **and** the run still could not be served by the editor's
       * models (§8.4 row 5, whose failure is the general `no-model` one).
       *
       * It is carried so the surface above can state every reason it has rather than
       * only the last one: §9.3 asks the degraded surface to give the user **both**
       * ways out, and "this editor lists no model" alone does not say whether an
       * endpoint is configured, disabled, ambiguous or unusable. Nothing branches on
       * it — it is the reason, not a second decision — and the arm stays final: a
       * selection that ends `unavailable` never continues on to another route.
       */
      direct?: AiUnavailableRoute;
    };

/** One route the selection could not use, with the sentence that says why. */
export interface AiUnavailableRoute {
  code: AiUnavailableCode;
  reason: string;
}

/** What one selection needs. */
export interface AiTransportSelectionDeps {
  secrets: AiSecretStore;
  /** Overridable so a test can prove a branch without the editor's own models. */
  vscodeLm?: AiModelTransport;
  /** Overridable so a test can select without the activation-time proxy install. */
  dispatcherPair?: () => { dispatcher?: unknown; fetchImpl?: RequestFetch };
}

/** The l10n sentence for a binding whose endpoint is switched off. */
function bindingDisabledMessage(providerId: string): string {
  return vscode.l10n.t(
    'The AI endpoint "{0}" is selected by "forgejoToolkit.aiModelBindings" for this feature, but "forgejoToolkit.aiProvidersEnabled" is off, so nothing was sent. Turn that setting on to use the configured endpoint.',
    providerId,
  );
}

/** The l10n sentence for a binding that names an endpoint which is not configured. */
function bindingUnknownProviderMessage(providerId: string): string {
  return vscode.l10n.t(
    '"forgejoToolkit.aiModelBindings" names the endpoint "{0}", which is not configured under "forgejoToolkit.aiProviders". Nothing was sent.',
    providerId,
  );
}

/** The l10n sentence for a direct-only choice with no endpoint configured. */
function noEndpointConfiguredMessage(switchReason: string, rejection: string | undefined): string {
  const base = vscode.l10n.t(
    '{0}, but no AI endpoint is configured under "forgejoToolkit.aiProviders", so no configured endpoint can serve this run. Nothing was sent.',
    switchReason,
  );
  if (rejection === undefined) {
    return base;
  }
  return `${base} ${unreadableProviderMessage(rejection)}`;
}

/** The l10n sentence for a direct choice the egress switch refuses. */
function providersDisabledMessage(): string {
  return vscode.l10n.t(
    '"forgejoToolkit.aiProvidersEnabled" is off, so the configured AI endpoint is not used. Nothing was sent.',
  );
}

/** The l10n sentence for "there is an endpoint but nothing says which one to use". */
function noDeterminableModelMessage(): string {
  return vscode.l10n.t(
    'No AI model is available: no endpoint is bound to this feature. Add an entry to "forgejoToolkit.aiModelBindings" naming the endpoint and the model to use. Nothing was sent.',
  );
}

/** The l10n sentence for "this editor offers no model and no endpoint is configured". */
function noModelAtAllMessage(): string {
  return vscode.l10n.t(
    'No AI model is available: this editor provides no chat model (the language model API lists none), and no AI endpoint is configured. Install an extension that contributes a chat model, or configure an endpoint under "forgejoToolkit.aiProviders". Nothing was sent.',
  );
}

/** The l10n sentence for a configured entry the settings reader could not read. */
function unreadableProviderMessage(reason: string): string {
  return vscode.l10n.t('One configured entry could not be read: {0}', reason);
}

/**
 * The transport for one configured provider, with the policies read fresh.
 *
 * Exported because the test-connection command needs the same construction and must
 * not build a second one with different rules.
 */
export function directTransportFor(
  provider: AiProviderConfig,
  deps: Pick<AiTransportSelectionDeps, 'secrets' | 'dispatcherPair'>,
): AiModelTransport {
  return openAiCompatibleTransportFor(provider, deps.secrets, { dispatcherPair: deps.dispatcherPair });
}

/** The `vscode.lm` branch: usable only when the editor's own list is non-empty. */
async function selectVscodeLm(transport: AiModelTransport): Promise<AiTransportSelection> {
  const availability = await transport.availability();
  if (!availability.usable) {
    // "No language model API" and "listing the models threw" are both the editor
    // being unable to serve a request, and both keep their own sentence from the
    // transport that produced it.
    return { kind: 'unavailable', code: 'editor-unusable', reason: availability.reason };
  }
  const models = await transport.listModels();
  if (models.length === 0) {
    // "The editor offers nothing" is the list's own reading and is deliberately
    // distinct from "listing failed" (which `availability()` answers): §9.1 asks
    // for the capability, and an empty list is the capability being absent.
    return { kind: 'unavailable', code: 'no-model', reason: noModelAtAllMessage() };
  }
  return {
    kind: 'vscode-lm',
    transport,
    reason: `"forgejoToolkit.aiTransport" selects the editor models, and the editor offers ${models.length} of them`,
  };
}

/**
 * The direct branch when **no binding** names an endpoint: the record's rules 3 and
 * 5.
 *
 * "Can determine one endpoint" is read strictly, and that is the point: exactly one
 * provider must be readable, and it must declare at least one model. Anything else
 * — two providers, an unreadable entry, a provider with no declared model — is the
 * ambiguous case, and §8.4 requires it to fail rather than to "pick the nearest
 * one". The model used is the **first** the provider declares: that declaration is
 * the user's own order, and it is the only place a direct model can come from when
 * no binding names one.
 */
async function selectDirectWithoutBinding(
  deps: AiTransportSelectionDeps,
  switchReason: string,
): Promise<AiTransportSelection> {
  // The provider list is read first so the sentence names the fact the user has to
  // act on: with nothing configured, "no endpoint is configured" is useful and "the
  // egress switch is off" is a second thing they have not reached yet.
  const reading = aiProviderSettingsReading();
  if (reading.providers.length === 0) {
    const rejection = reading.rejected[0];
    return {
      kind: 'unavailable',
      code: 'configure',
      reason: noEndpointConfiguredMessage(switchReason, rejection === undefined ? undefined : rejection.reason),
    };
  }
  if (!aiProvidersEnabledSettingValue()) {
    return { kind: 'unavailable', code: 'disabled', reason: providersDisabledMessage() };
  }
  if (reading.providers.length > 1 || reading.rejected.length > 0) {
    // Several endpoints, or an entry that could not be read: which one receives the
    // content is exactly the ambiguity a binding exists to remove.
    return { kind: 'unavailable', code: 'bind', reason: noDeterminableModelMessage() };
  }
  const provider = reading.providers[0] as AiProviderConfig;
  const declared = provider.models[0];
  if (declared === undefined) {
    return { kind: 'unavailable', code: 'bind', reason: noDeterminableModelMessage() };
  }
  const transport = directTransportFor(provider, deps);
  const availability = await transport.availability();
  if (!availability.usable) {
    // A configured endpoint that cannot be used is a failure, not a reason to send
    // the content to the editor's models instead.
    return { kind: 'unavailable', code: 'endpoint-unusable', reason: availability.reason };
  }
  return {
    kind: 'openai-compatible',
    transport,
    model: { vendor: provider.id, id: declared.id, name: declared.name },
    reason: `${switchReason}, and "${provider.id}" is the only configured endpoint`,
  };
}

/** Rules 1–3: a binding, or an explicit transport choice, decides outright. */
async function selectExplicit(
  feature: AiFeature,
  deps: AiTransportSelectionDeps,
  editorTransport: AiModelTransport,
  choice: ReturnType<typeof aiTransportSettingValue>,
  binding: ReturnType<typeof aiModelBindingFor>,
): Promise<AiTransportSelection | undefined> {
  if (binding !== undefined) {
    // Rule 1: a binding is the user naming an endpoint **and** a model for this
    // feature, so it is the most specific statement there is — and it is still
    // subject to the egress switch (§7.3). A binding that cannot be honoured fails
    // by name rather than being resolved to a neighbour.
    if (!aiProvidersEnabledSettingValue()) {
      return { kind: 'unavailable', code: 'disabled', reason: bindingDisabledMessage(binding.providerId) };
    }
    const reading = aiProviderSettingsReading();
    const provider = reading.providers.find((candidate) => candidate.id === binding.providerId);
    if (provider === undefined) {
      const rejection = reading.rejected.find((candidate) => candidate.reason.includes(`"${binding.providerId}"`));
      return {
        kind: 'unavailable',
        code: 'endpoint-unusable',
        reason:
          rejection === undefined
            ? bindingUnknownProviderMessage(binding.providerId)
            : unreadableProviderMessage(rejection.reason),
      };
    }
    const transport = directTransportFor(provider, deps);
    const availability = await transport.availability();
    if (!availability.usable) {
      return { kind: 'unavailable', code: 'endpoint-unusable', reason: availability.reason };
    }
    const declared = provider.models.find((model) => model.id === binding.modelId);
    return {
      kind: 'openai-compatible',
      transport,
      model: {
        vendor: provider.id,
        id: binding.modelId,
        // The declared display name when the provider declares this model, and the
        // id otherwise: an undeclared model is legal (§8.1 — the declaration is not
        // a whitelist), and the id is what the user typed.
        name: declared?.name ?? binding.modelId,
      },
      reason: `"forgejoToolkit.aiModelBindings" binds "${feature}" to "${binding.providerId}/${binding.modelId}"`,
    };
  }
  if (choice === 'vscode-lm') {
    // Rule 2: the user asked for the editor models outright.
    return await selectVscodeLm(editorTransport);
  }
  if (choice === 'openai-compatible') {
    // Rule 3: the user asked for a configured endpoint outright, and there is no
    // fallback to the editor models when none can be determined (§8.4).
    return await selectDirectWithoutBinding(deps, '"forgejoToolkit.aiTransport" is set to "openai-compatible"');
  }
  return undefined;
}

/**
 * Which transport and model serve this feature, and the sentence explaining the
 * choice in the debug log.
 *
 * The order is the record's §8.4 table, and each row's failure is final: the
 * function never continues past a branch that named an endpoint in order to ask a
 * different one (§7.5).
 *
 * One boundary worth stating, because `auto` is the only branch that reaches a
 * direct endpoint without the user having named it: `auto` tries the editor models
 * first and considers a configured endpoint when the editor **cannot serve a
 * request** — no language model API, a listing that failed, or an empty list. That
 * is the record's "`vscode.lm` has no usable model" read as a capability question
 * (§9.1), and it is still gated twice: `aiProvidersEnabled` must be on and exactly
 * one endpoint must be determinable. An explicit `vscode-lm` choice never reaches
 * the direct branch at all, which is the half of §7.5 that has to hold even when
 * the editor is broken.
 */
export async function selectedModelFor(
  feature: AiFeature,
  deps: AiTransportSelectionDeps,
): Promise<AiTransportSelection> {
  const outcome = isAiFeature(feature)
    ? await resolveSelection(feature, deps)
    : { kind: 'unavailable' as const, code: 'configure' as const, reason: noDeterminableModelMessage() };
  // §8.4: the choice of `auto` has to be explainable, so every arm writes one line
  // saying which transport it picked and why.
  logger.debug(
    `AI model transport for "${feature}": ${outcome.kind} — ${
      outcome.kind === 'unavailable' ? `unavailable (${outcome.code}): ${outcome.reason}` : outcome.reason
    }`,
  );
  return outcome;
}

async function resolveSelection(feature: AiFeature, deps: AiTransportSelectionDeps): Promise<AiTransportSelection> {
  const editorTransport = deps.vscodeLm ?? vscodeLmTransport;
  const explicit = await selectExplicit(
    feature,
    deps,
    editorTransport,
    aiTransportSettingValue(),
    aiModelBindingFor(feature),
  );
  if (explicit !== undefined) {
    return explicit;
  }
  // Rules 4 and 5: `auto` prefers the editor models when the editor has any and
  // only then considers a configured endpoint.
  const editor = await selectVscodeLm(editorTransport);
  if (editor.kind !== 'unavailable') {
    return editor;
  }
  const direct = await selectDirectWithoutBinding(
    deps,
    '"forgejoToolkit.aiTransport" is "auto" and the editor lists no model',
  );
  if (direct.kind !== 'unavailable') {
    return direct;
  }
  // Rule 6: nothing is usable. Report the more specific fact — a backend that
  // failed (the editor's API), a decision the configuration needs, or the two
  // absences together.
  if (editor.code === 'editor-unusable') {
    return editor;
  }
  if (direct.code === 'disabled' || direct.code === 'endpoint-unusable' || direct.code === 'bind') {
    return direct;
  }
  return {
    kind: 'unavailable',
    code: 'no-model',
    reason: noModelAtAllMessage(),
    // The endpoint route was consulted and its answer was "nothing is configured",
    // which is the one direct reading the general `no-model` sentence above does not
    // already carry (it carries the editor half). It travels so the run can state
    // both absences in its own wording rather than only the editor's.
    direct: { code: direct.code, reason: direct.reason },
  };
}
