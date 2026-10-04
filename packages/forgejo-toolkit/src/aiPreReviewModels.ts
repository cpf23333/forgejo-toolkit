import * as vscode from 'vscode';
import { userFacingErrorMessage } from './api/errors';
import { logger } from './logger';
import {
  aiPreReviewModelSettingValue,
  formatAiPreReviewModelSettingValue,
  parseAiPreReviewModelSelector,
} from './aiPreReviewSettings';
import type { AiPreReviewChatModelOption } from '@cpf23333-forgejo-toolkit/shared/webview/messages';

/**
 * The vocabulary of "a chat model VS Code offers": how one model is read, named,
 * keyed and listed.
 *
 * It lives on its own because three surfaces need exactly the same reading and
 * must not drift apart: the run's validation and refusal messages
 * (`aiPreReview.ts`), the QuickPick that changes the choice, and the Settings
 * page's chooser (`webview/viewProvider.ts`, which cannot import
 * `aiPreReview.ts` without a cycle — that module imports the provider). What a
 * model's `vendor`/`family`/`id` are, and whether the setting can name it at
 * all, is one answer for all three.
 *
 * Nothing here sends anything to a provider: `selectChatModels()` is a lookup,
 * and this module never calls `sendRequest`.
 */

/**
 * One model as the API exposes it. The record's §7.2 asks the log to name the
 * model that was chosen; `name` is the readable one, and `vendor`/`family`/`id`
 * are the identifiers a bug report needs, because two providers can both offer
 * a model called "GPT-4o".
 */
export interface AiPreReviewModelIdentity {
  name: string;
  vendor: string;
  family: string;
  id: string;
}

/**
 * Reads the identity fields off a model, tolerating a provider that omits one.
 *
 * The parameter is the identity **shape** rather than `vscode.LanguageModelChat`
 * because two kinds of value are read through it now: the editor's own chat model
 * (the Settings page's chooser, the debug probe) and the seam's `AiModelInfo`
 * (`src/ai/transport.ts`), which the AI pre-review's run holds. Both carry the
 * same four fields, and the field-by-field `typeof` checks below are what make
 * the read total for either.
 */
export function aiPreReviewModelIdentity(model: {
  name?: unknown;
  vendor?: unknown;
  family?: unknown;
  id?: unknown;
}): AiPreReviewModelIdentity {
  return {
    name: typeof model?.name === 'string' ? model.name : '',
    vendor: typeof model?.vendor === 'string' ? model.vendor : '',
    family: typeof model?.family === 'string' ? model.family : '',
    id: typeof model?.id === 'string' ? model.id : '',
  };
}

/** One identity as a log line or a failure message names it. */
export function formatAiPreReviewModelIdentity(identity: AiPreReviewModelIdentity): string {
  const name = identity.name.trim() !== '' ? identity.name : identity.id.trim() !== '' ? identity.id : 'unknown model';
  return `${name} (vendor=${identity.vendor || 'unknown'}, family=${identity.family || 'unknown'}, id=${identity.id || 'unknown'})`;
}

/**
 * The identity of one model as a map key. `vendor`/`id` is the pair the API
 * promises stability for (`id` is the opaque identifier; `vendor` keeps two
 * providers' coincidentally equal ids apart); `family` is explicitly
 * "subject to change" and `name` is a display string, so neither is used.
 */
export function aiPreReviewModelKey(model: vscode.LanguageModelChat): string {
  const identity = aiPreReviewModelIdentity(model);
  if (identity.id.trim() === '') {
    // A provider that omits the id leaves nothing stable to key on; treating
    // the whole identity as the key at least keeps two distinct models apart.
    return `unidentified:${identity.vendor}/${identity.family}/${identity.name}`;
  }
  return `${identity.vendor}/${identity.id}`;
}

/**
 * The offered models with the editor's duplicates collapsed, keeping the order
 * `selectChatModels()` returned.
 *
 * A picker has to list one row per model: the same model listed twice would be a
 * question with two identical answers, and the row a user picks would be
 * indistinguishable from the row beside it. The order is otherwise left alone —
 * the editor's order is not a preference of ours to re-sort, which is the whole
 * reason the run no longer ranks candidates at all.
 */
export function uniqueAiPreReviewModels(models: readonly vscode.LanguageModelChat[]): vscode.LanguageModelChat[] {
  const seen = new Set<string>();
  const unique: vscode.LanguageModelChat[] = [];
  for (const model of models) {
    const key = aiPreReviewModelKey(model);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    unique.push(model);
  }
  return unique;
}

/**
 * `maxInputTokens` as a number this module can compare against.
 *
 * The API declares it as a number, but a provider hands the extension host
 * whatever it likes, and a `NaN`/`undefined`/negative budget would make every
 * comparison false — which would silently turn into "does not fit" rather than
 * "unknown". Treating it as 0 keeps that direction, and the failure message then
 * reports the 0 it actually saw.
 *
 * The parameter is the budget **shape** for the same reason
 * `aiPreReviewModelIdentity`'s is: the seam's `AiModelInfo` may report no budget
 * at all (`maxInputTokens?: number`), and an unknown budget reads as 0 here,
 * which is the fail-closed direction.
 */
export function maxInputTokensOf(model: { maxInputTokens?: unknown }): number {
  const budget = model?.maxInputTokens;
  return typeof budget === 'number' && Number.isFinite(budget) && budget > 0 ? budget : 0;
}

/**
 * What asking the editor for its chat models produced, with no reporting of its
 * own: the three outcomes are the caller's to turn into a message, because the
 * run refuses with a dialog while the Settings page answers with a `reason` and
 * must not pop anything at the user.
 */
export type AiPreReviewChatModelQuery =
  | { status: 'ok'; models: vscode.LanguageModelChat[] }
  | { status: 'no-api' }
  | { status: 'failed'; error: unknown };

/**
 * Every chat model the editor offers, or the reason it could not be asked.
 *
 * The call names **no selector**: a chooser has to offer everything the editor
 * has, and a configured value is matched against that full list by
 * `findOfferedAiPreReviewModel` instead. Narrowing the call by the setting would
 * make a provider that ignores selectors look like a machine with one model, and
 * a mistake in the value look like "no models at all". An **empty** list is an
 * `ok` result: "the editor offers nothing" is a different outcome from "the
 * listing failed", and the two need different words.
 *
 * The optional API is read off the namespace before it is tested, the same shape
 * `src/mcpServerProvider.ts` uses for its own optional surface: an editor that
 * does not implement it must lose this one feature, never fail activation.
 */
export async function queryAiPreReviewChatModels(): Promise<AiPreReviewChatModelQuery> {
  const select = vscode.lm?.selectChatModels as typeof vscode.lm.selectChatModels | undefined;
  if (typeof select !== 'function') {
    return { status: 'no-api' };
  }
  try {
    const models = await select.call(vscode.lm);
    return {
      status: 'ok',
      models: (models ?? []).filter((model): model is vscode.LanguageModelChat => Boolean(model)),
    };
  } catch (error) {
    return { status: 'failed', error };
  }
}

/** One model as the Settings page's chooser needs it, with the value it would be stored as. */
function toAiPreReviewChatModelOption(model: vscode.LanguageModelChat): AiPreReviewChatModelOption {
  const identity = aiPreReviewModelIdentity(model);
  const value = formatAiPreReviewModelSettingValue(identity);
  return {
    ...identity,
    maxInputTokens: maxInputTokensOf(model),
    ...(value !== undefined ? { value } : {}),
  };
}

/**
 * The offered models, in the shape the Settings page's chooser shows: every
 * model the editor offers with its display name, `vendor`, `family`, `id` and
 * `maxInputTokens`, plus the form `forgejoToolkit.aiPreReviewModel` would store
 * for it (preferring `vendor/id`, so two models sharing a family cannot be
 * confused), together with the value the setting holds right now.
 *
 * A `reason` is set instead of an empty list with no explanation when there is
 * nothing to offer — no language model API, a listing that threw, or no chat
 * model at all — and it is localized here, where `vscode.l10n.t` lives. It is
 * **not** an error dialog: a host-side toast for something the user is looking
 * at inside the panel would be noise, and the panel has a line for it.
 *
 * Nothing here reads the feature switches and nothing is sent anywhere: with
 * `forgejoToolkit.aiPreReview` off, choosing a model is still pure
 * configuration, and this function behaves identically.
 */
export async function listAiPreReviewChatModelChoices(): Promise<{
  models: AiPreReviewChatModelOption[];
  configured: string;
  reason?: string;
}> {
  const configured = aiPreReviewModelSettingValue();
  const query = await queryAiPreReviewChatModels();
  if (query.status === 'no-api') {
    logger.info('This editor provides no language model API, so no chat model can be listed for the settings page.');
    return {
      models: [],
      configured,
      reason: vscode.l10n.t(
        'This VS Code build has no language model API, so the chat models cannot be listed. The AI pre-review cannot run here either.',
      ),
    };
  }
  if (query.status === 'failed') {
    const error = userFacingErrorMessage(query.error);
    logger.error(`Listing the chat models for the settings page failed: ${error}`);
    return {
      models: [],
      configured,
      reason: vscode.l10n.t('The chat models VS Code offers could not be listed: {0}', error),
    };
  }
  const offered = uniqueAiPreReviewModels(query.models);
  if (offered.length === 0) {
    logger.info('No chat model is available, so the settings page has no model to offer.');
    return {
      models: [],
      configured,
      reason: vscode.l10n.t(
        'No chat model is available: install and sign in to a chat model provider (for example GitHub Copilot), then refresh this list.',
      ),
    };
  }
  return { models: offered.map(toAiPreReviewChatModelOption), configured };
}

/**
 * Whether a value may be written into `forgejoToolkit.aiPreReviewModel`.
 *
 * The empty string is the setting's own "ask me" default, and anything else has
 * to be one of the two accepted forms — the same test a hand-typed value gets,
 * so the webview can no more store an unrunnable value here than a user can by
 * typing one.
 */
export function isStorableAiPreReviewModelSettingValue(value: string): boolean {
  return value === '' || parseAiPreReviewModelSelector(value) !== undefined;
}
