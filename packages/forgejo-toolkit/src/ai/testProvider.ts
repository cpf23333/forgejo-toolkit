import * as vscode from 'vscode';
import type { RequestFetch } from '@cpf23333-forgejo-toolkit/shared/request';
import type { AiProviderTestReport } from '@cpf23333-forgejo-toolkit/shared/webview/messages';
import { logger } from '../logger';
import { getProxyFetch } from '../api/proxy';
import { aiPreReviewAnswerExcerpt } from '../aiPreReviewBrief';
import {
  CHAT_COMPLETIONS_PATH,
  MODELS_PATH,
  openAiEndpointDisplayUrl,
  openAiEndpointFailure,
  openAiEndpointUnusableMessage,
  openAiEndpointUrl,
  openAiLocalOnlyMessage,
  openAiMissingKeyMessage,
  openAiRequestAuth,
  openAiRequestStatus,
  openAiUnreadableResponseMessage,
  sendOpenAiRequest,
  type OpenAiFailureContext,
} from './openAiCompatibleTransport';
import {
  aiLocalOnlySettingValue,
  aiProviderSettingsReading,
  inspectAiProviderBaseUrl,
  isLocalAiEndpointHost,
  type AiProviderConfig,
} from './modelSettings';
import type { AiSecretStore } from './providerSecrets';

/**
 * The `forgejoToolkit.aiTestProvider` command: one endpoint, one click, and a
 * report that says what came back and where it went
 * (`docs/design/ai-model-transport.md` §8.7).
 *
 * The order the record requires, and the reason for each step:
 *
 * 1. **Validate first, locally.** The id, the URL scheme, the local-only policy
 *    and the stored credential are all checked before a byte leaves the machine,
 *    so a mistake in the settings costs nothing and produces a sentence that names
 *    what to fix rather than a transport error.
 * 2. `GET <base>/models` is best effort. A 404 or an empty list is **not** a
 *    failure — plenty of endpoints have no model list — and the probe then sends
 *    the one request that does carry content: a minimal
 *    `POST <base>/chat/completions` asking for a single character. That is the only
 *    automatic action in this extension that sends content, and it happens only
 *    because the user clicked.
 * 3. The report names the **address** the request went to, the HTTP status, how
 *    long it took, and either the model count or a bounded excerpt of the answer.
 *    It never echoes the key or any custom header value: the values are not
 *    arguments of any function below, and the address is rendered through
 *    `openAiEndpointDisplayUrl` (no query string, no userinfo).
 *
 * The command is registered and never called from anywhere else — §7.2 is explicit
 * that it must not be reachable from an automatic path and that it must not be
 * treated as evidence of consent to send anything.
 */

/** The command id, as the manifest contributes it. */
export const COMMAND_AI_TEST_PROVIDER = 'forgejoToolkit.aiTestProvider';

/** What one probe needs, beyond the provider it is aimed at. */
export interface AiProviderTestDeps {
  secrets: AiSecretStore;
  /** Overrides `forgejoToolkit.aiLocalOnly`; the policy is read fresh in production. */
  localOnly?: boolean;
  /** Overridable so a test can run without the activation-time proxy install. */
  dispatcherPair?: () => { dispatcher?: unknown; fetchImpl?: RequestFetch };
}

/**
 * What one probe found.
 *
 * `ran` separates "the request failed" from "no request was made": the first has a
 * status and a failed round trip to talk about, the second is a configuration
 * answer that cost nothing, and the record's own wording differs between them
 * ("was not run" against "failed").
 */
export type AiProviderTestOutcome =
  | { ok: true; status: number; elapsedMs: number; summary: string; models?: string[] }
  | { ok: false; ran: boolean; reason: string };

/** The model ids of an OpenAI-shaped `/models` answer, or `undefined` when it has none. */
function modelIdsOf(payload: unknown): string[] | undefined {
  const entries = Array.isArray(payload)
    ? payload
    : typeof payload === 'object' && payload !== null && Array.isArray((payload as { data?: unknown }).data)
      ? (payload as { data: unknown[] }).data
      : undefined;
  if (entries === undefined) {
    return undefined;
  }
  const ids: string[] = [];
  for (const entry of entries) {
    if (typeof entry === 'string' && entry !== '') {
      ids.push(entry);
      continue;
    }
    if (typeof entry === 'object' && entry !== null) {
      const id = (entry as { id?: unknown }).id;
      if (typeof id === 'string' && id !== '') {
        ids.push(id);
      }
    }
  }
  return ids;
}

/** The `choices[0].message.content` of a complete answer, or `undefined` when the shape has none. */
function completionContentOf(payload: unknown): string | undefined {
  if (typeof payload !== 'object' || payload === null) {
    return undefined;
  }
  const choices = (payload as { choices?: unknown }).choices;
  if (!Array.isArray(choices) || choices.length === 0) {
    return undefined;
  }
  const message = (choices[0] as { message?: unknown } | null)?.message;
  if (typeof message !== 'object' || message === null) {
    return undefined;
  }
  const content = (message as { content?: unknown }).content;
  return typeof content === 'string' ? content : undefined;
}

/**
 * One endpoint test, without any user interface: validate, probe, report.
 *
 * The two requests are the only ones this function makes, and each goes through
 * `sendOpenAiRequest` — the same shared client and the same proxy dispatcher pair
 * the transport uses, so the probe cannot disagree with the transport about how a
 * configured endpoint behaves.
 */
export async function runAiProviderTest(
  provider: AiProviderConfig,
  deps: AiProviderTestDeps,
): Promise<AiProviderTestOutcome> {
  const verdict = inspectAiProviderBaseUrl(provider.baseUrl);
  if (!verdict.ok) {
    return { ok: false, ran: false, reason: openAiEndpointUnusableMessage(provider, verdict.reason) };
  }
  const localOnly = deps.localOnly ?? aiLocalOnlySettingValue();
  if ((localOnly || provider.localOnly) && !isLocalAiEndpointHost(verdict.url.hostname)) {
    return {
      ok: false,
      ran: false,
      reason: openAiLocalOnlyMessage(provider, `${verdict.url.protocol}//${verdict.url.host}`),
    };
  }
  const auth = await openAiRequestAuth(provider, deps.secrets);
  if (!auth.keyPresent) {
    return { ok: false, ran: false, reason: openAiMissingKeyMessage(provider) };
  }

  const context: OpenAiFailureContext = {
    provider,
    endpoint: openAiEndpointDisplayUrl(openAiEndpointUrl(provider.baseUrl, CHAT_COMPLETIONS_PATH, auth.query)),
    // The probe makes the same kind of request the transport does, so a connection
    // failure means the same thing — including "this may be the proxy".
    viaProxy: Boolean(getProxyFetch()),
  };
  const started = Date.now();
  let modelsStatus: number | undefined;
  let modelIds: string[] | undefined;
  try {
    const response = await sendOpenAiRequest({
      url: openAiEndpointUrl(provider.baseUrl, MODELS_PATH, auth.query),
      method: 'GET',
      headers: auth.headers,
      responseType: 'json',
      dispatcherPair: deps.dispatcherPair,
    });
    modelsStatus = response.status;
    modelIds = modelIdsOf(response.data);
  } catch (error) {
    const status = openAiRequestStatus(error);
    if (status !== 404 && status !== 405 && status !== 501) {
      // Anything but "this endpoint has no model list" is a real failure and is
      // rendered the way the transport renders it: the same 401 / 429 / 5xx
      // sentences, so the probe and a run never disagree.
      return { ok: false, ran: true, reason: openAiEndpointFailure(error, context).message };
    }
    modelIds = [];
  }
  if (modelIds !== undefined && modelIds.length > 0) {
    return {
      ok: true,
      status: modelsStatus ?? 200,
      elapsedMs: Date.now() - started,
      summary: vscode.l10n.t('The endpoint reported {0} model(s) from "/models".', modelIds.length),
      // Carried so a surface can prefill the endpoint's model declaration from the
      // list the endpoint itself reported (§8.7 step 2); the declaration is not a
      // whitelist, so the caller is free to use or ignore it.
      models: modelIds,
    };
  }

  // The model to ask about: the provider's own declaration first (that is what a
  // binding would name), then whatever `/models` happened to list.
  const modelId = provider.models[0]?.id ?? modelIds?.[0];
  if (modelId === undefined) {
    return {
      ok: true,
      status: modelsStatus ?? 200,
      elapsedMs: Date.now() - started,
      summary: vscode.l10n.t('The endpoint reported no models from "/models" (that is not a failure).'),
      models: [],
    };
  }
  try {
    const response = await sendOpenAiRequest({
      url: openAiEndpointUrl(provider.baseUrl, CHAT_COMPLETIONS_PATH, auth.query),
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...auth.headers },
      // The minimal request §8.7 asks for: no `temperature`, no `max_tokens`, no
      // `response_format`, no `stream` — the endpoint's own defaults, which is the
      // same discipline the transport follows (§6.3).
      body: { model: modelId, messages: [{ role: 'user', content: 'Reply with a single character.' }] },
      responseType: 'json',
      dispatcherPair: deps.dispatcherPair,
    });
    const content = completionContentOf(response.data);
    if (content === undefined) {
      return {
        ok: false,
        ran: true,
        reason: openAiUnreadableResponseMessage(provider, 0, 'it has no choices with a message'),
      };
    }
    return {
      ok: true,
      status: response.status,
      elapsedMs: Date.now() - started,
      summary: vscode.l10n.t(
        'The endpoint reported no models from "/models" (that is not a failure), and it answered a minimal chat request with "{0}".',
        aiPreReviewAnswerExcerpt(content),
      ),
      models: modelIds ?? [],
    };
  } catch (error) {
    return { ok: false, ran: true, reason: openAiEndpointFailure(error, context).message };
  }
}

/**
 * The base address one probe is aimed at, as a human may see it: no query
 * string (it can carry the `api-version` secret, §8.5) and no userinfo.
 *
 * Exported because the settings page's report and the command's toast have to
 * name the same address, and a second rendering would be a second chance to
 * print a query parameter.
 */
export function aiProviderTestAddress(provider: AiProviderConfig): string {
  return openAiEndpointDisplayUrl(openAiEndpointUrl(provider.baseUrl, ''));
}

/**
 * The declared header names the `auth` style shadows, so they are not sent
 * (§8.5).
 *
 * Reported by name only, and computed through the same `openAiRequestAuth` the
 * transport uses: the settings page explains the conflict with the transport's
 * own reading rather than re-deriving it.
 */
async function shadowedHeaderNames(provider: AiProviderConfig, secrets: AiSecretStore): Promise<string[]> {
  try {
    const auth = await openAiRequestAuth(provider, secrets);
    return auth.shadowed;
  } catch {
    // A credential read that throws is "nothing is shadowed that we can name";
    // the probe below reports the failure itself, with its own sentence.
    return [];
  }
}

/**
 * One probe, as structured data: the same run `probeAndReport` performs, plus
 * the address and the suppressed header names, for a surface that renders the
 * report as fields rather than as one sentence (§8.7).
 *
 * Nothing in the returned shape can carry a credential: the reason strings come
 * from the transport's own error renderers (which never print a key), the
 * address is rendered without its query string, and `shadowed` holds names.
 */
export async function aiProviderTestReport(
  provider: AiProviderConfig,
  deps: AiProviderTestDeps,
): Promise<AiProviderTestReport> {
  const address = aiProviderTestAddress(provider);
  const shadowed = await shadowedHeaderNames(provider, deps.secrets);
  const outcome = await runAiProviderTest(provider, deps);
  if (!outcome.ok) {
    return {
      providerId: provider.id,
      providerName: provider.name,
      address,
      ok: false,
      ran: outcome.ran,
      reason: outcome.reason,
      shadowed,
    };
  }
  return {
    providerId: provider.id,
    providerName: provider.name,
    address,
    ok: true,
    ran: true,
    status: outcome.status,
    elapsedMs: outcome.elapsedMs,
    summary: outcome.summary,
    ...(outcome.models === undefined ? {} : { models: outcome.models }),
    shadowed,
  };
}

/**
 * Runs one probe and reports it: the status, the elapsed time, the answer summary
 * and the address, in one sentence.
 *
 * The same sentence goes to the output channel, so a user who wants the detail
 * after dismissing the toast still has it.
 */
async function probeAndReport(provider: AiProviderConfig, secrets: AiSecretStore): Promise<void> {
  const report = await aiProviderTestReport(provider, { secrets });
  if (!report.ok) {
    const reason = report.reason ?? '';
    const message = report.ran
      ? vscode.l10n.t('The AI endpoint test for "{0}" failed: {1}', provider.name, reason)
      : vscode.l10n.t('The AI endpoint test for "{0}" was not run: {1}', provider.name, reason);
    logger.error(`[aiTestProvider] ${message}`);
    void vscode.window.showErrorMessage(message);
    return;
  }
  const message = vscode.l10n.t(
    'The AI endpoint "{0}" at {1} answered HTTP {2} in {3} ms: {4}',
    provider.name,
    report.address,
    report.status ?? 0,
    report.elapsedMs ?? 0,
    report.summary ?? '',
  );
  logger.info(`[aiTestProvider] ${message}`);
  void vscode.window.showInformationMessage(message);
}

/**
 * The command handler.
 *
 * With a provider id (what the settings page passes once it has a button) it tests
 * that endpoint; without one it asks which to test. A dismissed picker sends
 * nothing and says nothing, because the user answered "not now" rather than
 * "something is wrong".
 */
export async function aiTestProviderCommand(secrets: AiSecretStore, first?: unknown): Promise<void> {
  const reading = aiProviderSettingsReading();
  const requested = typeof first === 'string' && first.trim() !== '' ? first.trim() : undefined;
  if (requested !== undefined) {
    const provider = reading.providers.find((candidate) => candidate.id === requested);
    if (provider === undefined) {
      void vscode.window.showErrorMessage(vscode.l10n.t('No AI endpoint named "{0}" is configured.', requested));
      return;
    }
    await probeAndReport(provider, secrets);
    return;
  }
  if (reading.providers.length === 0) {
    const rejection = reading.rejected[0];
    const base = vscode.l10n.t('No AI endpoints are configured. Add one under "forgejoToolkit.aiProviders" first.');
    const message =
      rejection === undefined
        ? base
        : `${base} ${vscode.l10n.t('One configured entry could not be read: {0}', rejection.reason)}`;
    void vscode.window.showErrorMessage(message);
    return;
  }
  const picked = await vscode.window.showQuickPick(
    reading.providers.map((provider) => ({ label: provider.name, description: provider.baseUrl, id: provider.id })),
    { title: vscode.l10n.t('Select an AI endpoint to test') },
  );
  if (picked === undefined) {
    return;
  }
  const provider = reading.providers.find((candidate) => candidate.id === picked.id);
  if (provider === undefined) {
    return;
  }
  await probeAndReport(provider, secrets);
}

/**
 * Registers the command. Kept beside the probe rather than inline in
 * `src/commands/index.ts`, for the reason the AI pre-review keeps its own: the
 * handler owns a whole flow, and that file has to stay readable.
 */
export function registerAiTestProviderCommand(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.commands.registerCommand(COMMAND_AI_TEST_PROVIDER, (first?: unknown) => {
      aiTestProviderCommand(context.secrets, first).catch((error: unknown) => {
        const reason = error instanceof Error ? error.message : String(error);
        logger.error(`[aiTestProvider] the endpoint test failed unexpectedly: ${reason}`);
      });
    }),
  );
}
