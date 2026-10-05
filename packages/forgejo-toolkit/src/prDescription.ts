import * as vscode from 'vscode';
import { ForgejoClient } from './api/client';
import { userFacingErrorMessage } from './api/errors';
import type { ConfigManager } from './config';
import type { ForgejoToolkitViewProvider } from './webview/viewProvider';
import { logger } from './logger';
import {
  AI_PRE_REVIEW_ESTIMATED_BYTES_PER_TOKEN,
  abortSignalForToken,
  aiConsentDestinationFor,
  aiPreReviewAvailableTokens,
  aiPreReviewBudgetMode,
  aiPreReviewServedBy,
  classifyModelErrorSilently,
  estimateAiPreReviewTokens,
  formatAiPreReviewServedBy,
  hostSecrets,
  modelLabel,
  pickResponseCandidate,
  type AiPreReviewBudgetMode,
  type AiPreReviewConsentDestination,
  type AiPreReviewRunHost,
} from './aiPreReview';
import { aiPreReviewCommentBodyLanguage } from './aiPreReviewSettings';
import { selectedModelFor } from './ai/modelSelection';
import { aiPreReviewModelIdentity, maxInputTokensOf } from './aiPreReviewModels';
import type { AiCompletionRequest, AiModelInfo, AiModelTransport } from './ai/transport';
import {
  PR_DESCRIPTION_PROMPT_SCOPE_SETTING,
  PR_DESCRIPTION_SETTING,
  isPrDescriptionEnabled,
  prDescriptionPromptScopeSettingValue,
  writePrDescriptionPromptScopeSetting,
  type PrDescriptionStatedScope,
} from './prDescriptionSettings';
import {
  buildPrDescriptionBrief,
  buildPrDescriptionFileContents,
  buildPrDescriptionPromptMessages,
  buildPrDescriptionPromptText,
  buildPrDescriptionSystemPrompt,
  parsePrDescriptionAnswer,
  renderPrDescriptionFileContents,
  type PrDescriptionAnswerFailure,
} from './prDescriptionBrief';
import { AI_PRE_REVIEW_MAX_CONTENT_FILES, type AiPreReviewFileContents } from './aiPreReviewBrief';

/**
 * "Generate a pull request description": draft the description of a pull request
 * **from what the user is about to submit**, and hand it back to the
 * create-pull-request form as an editable body.
 *
 * The design record for the consent, egress and degradation decisions is
 * `docs/design/ai-model-transport.md` §7.6 (its §7.5, §8 and §9 apply unchanged);
 * the user-visible feature is `FEATURES.md`'s PR Review section. The three
 * properties this file exists to guarantee:
 *
 * 1. **The user submits.** Nothing here creates, edits or submits a pull request,
 *    and no message this module accepts can make it: the whole product of a run is
 *    the text it returns, which the form puts into its body field. Crossing that
 *    line would mean the extension opened pull requests on a user's behalf.
 * 2. **Nothing leaves the machine unasked.** A feature switch (off by default) and
 *    a prompt scope whose default is the **question**. With the switch off the run
 *    refuses before it reads the comparison. With the scope at `ask` the run's
 *    first act after the model is known is one modal naming who would receive the
 *    content and what each answer would send; a dismissed modal ends the run with
 *    nothing sent (§7.2: an unanswered consent question is not consent). The
 *    answer is written into the setting at global scope, so the question is asked
 *    once and the choice stays visible and editable in Settings.
 * 3. **The model is the user's choice, and there is no second path.** The run asks
 *    `selectedModelFor('prDescription', …)` (`src/ai/modelSelection.ts`) which
 *    transport and model serve it — the editor's own models, or a configured
 *    OpenAI-compatible endpoint — and then lists, measures and asks through
 *    `AiModelTransport` (`src/ai/transport.ts`). This module never touches
 *    `vscode.lm` directly. The seam carries no fallback between transports (§7.5):
 *    a transport that cannot serve the run reports why, and the run refuses rather
 *    than quietly reaching for the other one. A configured endpoint is **not**
 *    consent (§7.3): this feature's own switch, the global AI switch and the `ask`
 *    scope are three separate answers.
 *
 * The failure discipline is the pre-review's: every arm reports what happened,
 * nothing is written on the way to a failure, and a failure never falls back to
 * another transport or another model. The one thing that differs is what a
 * failure can leave behind — nothing at all, because unlike the pre-review this
 * run has no server-side object to keep or roll back.
 */

/** The command id, contributed in `package.json` and public once released. */
export const COMMAND_GENERATE_PR_DESCRIPTION = 'forgejoToolkit.generatePrDescription';

/**
 * The `ExtensionContext` fields one run reads: the secret store a configured
 * endpoint's credential lives in. The same shape the pre-review's run takes, so
 * both entries can hand their own context along.
 */
export type PrDescriptionRunHost = Pick<AiPreReviewRunHost, 'secrets'>;

/** What one generate request names: the comparison the form is about to submit. */
export interface PrDescriptionTarget {
  instanceId: string;
  owner: string;
  repo: string;
  base: string;
  head: string;
  /** The title the user has typed, when they have typed one. */
  title?: string;
}

/**
 * What one run produced.
 *
 * The three arms are the three things the caller can say: a draft, "you
 * cancelled", and a failure with one already-user-facing sentence. Every arm has
 * written nothing anywhere — not a file, not a pull request, and no setting it did
 * not have to (the consent answer is the one write, and only when the modal was
 * the thing that produced it).
 */
export type PrDescriptionRunResult =
  | { kind: 'ok'; description: string }
  | { kind: 'cancelled' }
  | { kind: 'failed'; error: string };

/**
 * The consent modal's two answers, as the buttons the user reads.
 *
 * Exported so the tests can press the exact label the modal offers, the way
 * `AI_PRE_REVIEW_SCOPE_BUTTON_*` is.
 */
export const PR_DESCRIPTION_SCOPE_BUTTON_COMMITS = vscode.l10n.t('Send the commits and the changed-file list');
export const PR_DESCRIPTION_SCOPE_BUTTON_FILES = vscode.l10n.t('Also send the changed files');
export const PR_DESCRIPTION_SCOPE_BUTTON_CANCEL = vscode.l10n.t('Cancel — send nothing');

/**
 * The sentence the one-time consent modal shows for one destination (§7.1's
 * wording rules, §7.6's scope).
 *
 * It names the destination first, then exactly what leaves the machine under each
 * answer, then the setting the answer is written to and the fact that nothing is
 * requested or sent before the answer — the same four things the pre-review's
 * modal states, because they are what a person has to know to answer honestly.
 *
 * It deliberately does **not** promise a diff: the comparison endpoint this
 * feature reads reports the commits and the changed files, not their hunks
 * (`docs/api-verification-checklist.md`, the `repoCompareDiff` entry), so a
 * sentence about "the whole diff" would be a lie about the egress. §7.6 records
 * that narrowing.
 */
export function prDescriptionPromptScopeMessage(destination: AiPreReviewConsentDestination): string {
  const body = vscode.l10n.t(
    'Before this pull request description sends anything: the chat model you chose belongs to the "{0}" provider. Choose what it may carry. "Send the commits and the changed-file list" sends the base and head branch names, your typed title if there is one, the commit shas with their subjects, bodies, authors and dates, and the path and status of every changed file — no file content. "Also send the changed files" adds the text of the changed files at the head branch, which is the most content and the only answer under which the model can read the code a change touches. In neither answer is an access token, a URL or host name ever sent. Set the setting "forgejoToolkit.prDescriptionPromptScope" by hand instead if you would rather not be asked. Nothing is requested or sent before you answer, cancelling sends nothing, and your answer is written into that setting so this question is asked only once.',
    destination.name,
  );
  if (destination.address === undefined) {
    return body;
  }
  return `${vscode.l10n.t(
    'The AI pre-review would send this to the provider you configured, "{0}" at {1}.',
    destination.name,
    destination.address,
  )} ${body}`;
}

/**
 * Asks the one question this feature asks about egress, as a **modal**.
 *
 * Modal for the reason the pre-review's is (§7.1): the answer decides whether the
 * user's own commits and files leave the machine, and the platform's modal is the
 * only VS Code message that blocks the window until it is answered. `undefined`
 * covers every "not answered" case — the explicit cancel button, the platform's
 * close control, and Escape — and the caller turns it into a cancelled run,
 * because an unanswered consent question is not consent.
 */
async function askPrDescriptionPromptScope(
  destination: AiPreReviewConsentDestination,
): Promise<PrDescriptionStatedScope | undefined> {
  const picked = await vscode.window.showInformationMessage(
    prDescriptionPromptScopeMessage(destination),
    { modal: true },
    PR_DESCRIPTION_SCOPE_BUTTON_COMMITS,
    PR_DESCRIPTION_SCOPE_BUTTON_FILES,
    PR_DESCRIPTION_SCOPE_BUTTON_CANCEL,
  );
  if (picked === PR_DESCRIPTION_SCOPE_BUTTON_COMMITS) {
    return 'commits-only';
  }
  if (picked === PR_DESCRIPTION_SCOPE_BUTTON_FILES) {
    return 'commits-and-files';
  }
  return undefined;
}

/**
 * What this run's prompt may carry, resolved before anything is read.
 *
 * Three paths, and each one's ordering matters, exactly as in the pre-review:
 * a stated scope is used as it is with no question (the setting is the source of
 * truth, so the question is asked once per choice rather than once per run);
 * `ask` shows the modal and returns **nothing** when it is not answered, so the
 * caller reports that and stops; and an answered modal writes the answer into the
 * setting first (best effort — a failed write changes where the answer is
 * remembered, never what this run sends) and the run then uses it.
 */
async function resolvePrDescriptionPromptScope(
  destination: AiPreReviewConsentDestination,
): Promise<PrDescriptionStatedScope | undefined> {
  const configured = prDescriptionPromptScopeSettingValue();
  if (configured !== 'ask') {
    logger.info(
      `PR description: prompt scope: the setting "${PR_DESCRIPTION_PROMPT_SCOPE_SETTING}" = "${configured}"; no question was shown`,
    );
    return configured;
  }
  const answered = await askPrDescriptionPromptScope(destination);
  if (answered === undefined) {
    logger.info(
      `PR description: the question about what may be sent (the setting "${PR_DESCRIPTION_PROMPT_SCOPE_SETTING}") was not answered, so nothing was requested, nothing was sent and nothing was written`,
    );
    return undefined;
  }
  await rememberChosenPrDescriptionPromptScope(answered);
  return answered;
}

/**
 * Stores the scope the user just chose in
 * `forgejoToolkit.prDescriptionPromptScope` and says so.
 *
 * Best-effort in exactly one direction, like the pre-review's: a failed write
 * changes where the answer is remembered, never what this run sends — the user
 * answered, and the run uses the answer either way. The log line is what makes the
 * write auditable; the answer is also visible in the Settings UI under a name the
 * user just read in the modal.
 */
async function rememberChosenPrDescriptionPromptScope(scope: PrDescriptionStatedScope): Promise<void> {
  try {
    await writePrDescriptionPromptScopeSetting(scope);
  } catch (error) {
    logger.error(
      `PR description: the chosen prompt scope could not be written to "${PR_DESCRIPTION_PROMPT_SCOPE_SETTING}" (${userFacingErrorMessage(error)}); this run still uses "${scope}"`,
    );
    return;
  }
  logger.info(
    `PR description: prompt scope: "${PR_DESCRIPTION_PROMPT_SCOPE_SETTING}" = "${scope}" was written, so later runs use it without asking`,
  );
}

/**
 * What one prompt costs this run, by the measure the run is in — the pre-review's
 * rule, applied to this feature's own prompt.
 *
 * The text measured is the exact text the request will carry
 * (`buildPrDescriptionPromptText`), the instruction half included, so "what we
 * counted" and "what we sent" cannot drift. In `'estimated'` mode the transport is
 * not asked: a transport with no tokenizer would answer `undefined` again.
 */
async function countPrDescriptionTokens(
  transport: AiModelTransport,
  model: AiModelInfo,
  systemPrompt: string,
  briefText: string,
  fileContents: AiPreReviewFileContents | undefined,
  mode: AiPreReviewBudgetMode,
): Promise<number | undefined> {
  const text = buildPrDescriptionPromptText(systemPrompt, briefText, fileContents);
  if (mode === 'estimated') {
    return estimateAiPreReviewTokens(text);
  }
  return await transport.countTokens(model, text);
}

/**
 * Reads the changed files' text at the head branch, for the `commits-and-files`
 * scope.
 *
 * Only the files the comparison already listed are read, and at most
 * `AI_PRE_REVIEW_MAX_CONTENT_FILES` of them: that cap is the pre-review's, and
 * reusing it is the decision (the two features must not disagree about how many
 * files one request may carry — `buildPrDescriptionFileContents` is the same
 * builder for the same reason).
 *
 * The `ref` is the **head branch**, which is what the form is about to submit.
 * A file that cannot be read — deleted between the branches, a binary, a path the
 * contents API refuses — is counted as `unavailable` and left out; fewer files
 * shown is the honest failure, and a text that is not the head version would be a
 * wrong one.
 */
async function collectPrDescriptionFileTexts(
  client: ForgejoClient,
  target: PrDescriptionTarget,
  paths: readonly string[],
  token: vscode.CancellationToken,
  signal: AbortSignal | undefined,
): Promise<AiPreReviewFileContents> {
  const texts = new Map<string, string>();
  for (const path of paths) {
    if (token.isCancellationRequested || signal?.aborted === true) {
      break;
    }
    try {
      const result = await client.getFileContentResult(target.owner, target.repo, path, target.head);
      if (result.kind === 'file') {
        texts.set(path, result.text);
      } else {
        logger.debug(
          `PR description: ${path} is not a regular file at "${target.head}" (${result.kind}), so it is left out of the file contents`,
        );
      }
    } catch (error) {
      logger.debug(
        `PR description: ${path} could not be read at "${target.head}" (${userFacingErrorMessage(error)}), so it is left out of the file contents`,
      );
    }
  }
  return buildPrDescriptionFileContents({ paths, texts });
}

/**
 * One line saying why an answer is not a description, for the log and the message.
 *
 * The three reasons are different problems and are named as such: an empty answer
 * is a provider that produced nothing, a fenced one is a model that ignored the
 * "no fence" rule, and an over-long one is a model that ignored the cap. None of
 * them is retried or trimmed — see `parsePrDescriptionAnswer`.
 */
function describePrDescriptionFailure(reason: PrDescriptionAnswerFailure, characterCount: number): string {
  switch (reason) {
    case 'empty':
      return vscode.l10n.t('the answer was empty');
    case 'code-fence':
      return vscode.l10n.t('the answer was a Markdown code fence and nothing else');
    case 'too-long':
      return vscode.l10n.t('the answer was {0} characters long', characterCount);
  }
}

/**
 * Asks which model drafts descriptions, offering every model the editor has in
 * the shape the pre-review's picker uses — display name, `vendor/family`, the id,
 * and who would receive the content — so the two features cannot present one
 * editor's models two different ways.
 *
 * The one deliberate difference is the placeholder: the pre-review writes the
 * answer into a setting of its own (`forgejoToolkit.aiPreReviewModel`), while this
 * feature has **no model setting** — the editor path asks every time, and an
 * endpoint is pinned with `forgejoToolkit.aiModelBindings` — so the sentence says
 * what is true here rather than borrowing that one.
 *
 * A dismissed pick is `undefined`, and the caller turns that into a cancelled run
 * with nothing sent: choosing is not consent, and not choosing is not a failure.
 */
async function pickPrDescriptionModel(offered: readonly AiModelInfo[]): Promise<AiModelInfo | undefined> {
  const items: (vscode.QuickPickItem & { model: AiModelInfo })[] = offered.map((model) => {
    const identity = aiPreReviewModelIdentity(model);
    const name = identity.name.trim() !== '' ? identity.name : identity.id || 'unknown model';
    const vendor = identity.vendor || 'unknown';
    const family = identity.family || 'unknown';
    const id = identity.id || 'unknown';
    return {
      label: `${name} — ${vendor}/${family}`,
      description: `id: ${id}`,
      detail: vscode.l10n.t(
        'The draft would be sent to the "{0}" provider. maxInputTokens={1}',
        vendor,
        String(maxInputTokensOf(model)),
      ),
      model,
    };
  });
  const picked = await vscode.window.showQuickPick(items, {
    title: vscode.l10n.t('Which chat model should draft the pull request description?'),
    placeHolder: vscode.l10n.t(
      'The commits and the changed-file list are sent to the provider named under the model you pick. To pin an endpoint and model instead, use the setting "forgejoToolkit.aiModelBindings".',
    ),
    ignoreFocusOut: true,
  });
  return picked?.model;
}

/**
 * Runs one generate request.
 *
 * The order is the pre-review's: the feature switch, the model, then the one
 * consent question, then the reads, then the budget, then the request. Nothing
 * before the consent answer reads the comparison or touches a model, and every arm
 * below has written nothing.
 */
export async function generatePrDescription(
  config: ConfigManager,
  target: PrDescriptionTarget,
  host: PrDescriptionRunHost,
): Promise<PrDescriptionRunResult> {
  // The feature switch is checked first and answers with a pointer to the setting.
  // Nothing below this line may run while it is off: with it off the action does
  // not read the comparison and does not ask a model for anything.
  if (!isPrDescriptionEnabled()) {
    const error = vscode.l10n.t(
      'The PR-description draft is off. Enable the setting "forgejoToolkit.prDescription" to use it.',
    );
    logger.info(`PR description: refused because "${PR_DESCRIPTION_SETTING}" is off; nothing was read or sent`);
    void vscode.window.showWarningMessage(error);
    return { kind: 'failed', error };
  }

  const instance = config.getInstances().find((candidate) => candidate.id === target.instanceId);
  if (!instance) {
    const error = vscode.l10n.t('Forgejo instance not found');
    void vscode.window.showErrorMessage(error);
    return { kind: 'failed', error };
  }

  const client = new ForgejoClient(instance.url, instance.token, logger, instance.syncApiUrlsToInstanceUrl);

  // **Which transport and which model serve this run** is settled before anything
  // is read (§8.4). Every read the selection makes is a lookup — `availability()`,
  // `listModels()`, the settings and the secrets — so "nothing leaves the machine
  // before the consent question is answered" stays true by construction (§7.2).
  // It is deliberately not a fallback layer: a selection that comes back
  // `unavailable` ends the run here (§7.5).
  const selection = await selectedModelFor('prDescription', { secrets: hostSecrets(host) });
  if (selection.kind === 'unavailable') {
    logger.info(`PR description: no model is available for this run (${selection.code}); nothing was read or sent`);
    const error = vscode.l10n.t(
      "No AI model is available to draft a pull request description, so nothing was sent. The extension's Settings page explains what to do about it. Reason: {0}",
      selection.reason,
    );
    // A warning rather than an error: "no model is configured" is a state the
    // settings page already explains, not a failure of this action. §9.3 asks the
    // page to carry the two ways out rather than every surface restating them.
    void vscode.window.showWarningMessage(error);
    return { kind: 'failed', error };
  }
  const transport = selection.transport;

  /** The model this run uses. On the direct path the user already named it. */
  let chosen: AiModelInfo;
  if (selection.kind === 'openai-compatible') {
    chosen = selection.model;
    logger.info(
      `PR description: model choice: ${transport.id} serves this run with ${modelLabel(chosen)} (${selection.reason}); no pick was shown`,
    );
  } else {
    // The editor's own models: which one drafts the description is the user's own
    // choice, asked here rather than read from a setting this feature does not own.
    const offered = await transport.listModels();
    if (offered.length === 0) {
      const error = vscode.l10n.t('The editor provides no chat model, so nothing was sent.');
      void vscode.window.showErrorMessage(error);
      return { kind: 'failed', error };
    }
    const picked = await pickPrDescriptionModel(offered);
    if (!picked) {
      const error = vscode.l10n.t('No chat model was chosen, so nothing was sent and nothing was written.');
      logger.info('PR description: the model picker was dismissed; nothing was read or sent');
      void vscode.window.showInformationMessage(error);
      return { kind: 'cancelled' };
    }
    chosen = picked;
  }

  // Where this run's content goes, named once and carried everywhere it is
  // reported: the log and the consent modal say the same facts, so a user can tell
  // an editor model's answer from a configured endpoint's.
  const servedBy = aiPreReviewServedBy(transport.id, selection.kind, chosen);
  logger.info(`PR description: this run is served by ${formatAiPreReviewServedBy(servedBy, chosen)}`);

  // What the prompt may carry is settled next, and it is settled **before** this
  // run reads anything: with the setting at `ask` the modal is the only thing that
  // happens, and a dismissed modal returns from here — zero reads, zero requests,
  // zero writes of its own. The model is why this question comes after the model
  // choice: the modal has to name who would receive the content (§7.1).
  const destination = aiConsentDestinationFor(chosen);
  const scope = await resolvePrDescriptionPromptScope(destination);
  if (scope === undefined) {
    const error = vscode.l10n.t(
      'The PR-description draft did not start: no answer was given to the question about what may be sent, so nothing was requested, nothing was sent and nothing was written. Take the action again and answer it, or set "forgejoToolkit.prDescriptionPromptScope" by hand — "commits-only" or "commits-and-files".',
    );
    void vscode.window.showInformationMessage(error);
    return { kind: 'cancelled' };
  }

  // Everything from the first read to the model's answer runs under one
  // cancellable notification: the comparison read and the model call are the slow
  // steps, and cancelling leaves nothing behind (there is nothing to leave).
  return await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: vscode.l10n.t('Drafting the pull request description'),
      cancellable: true,
    },
    async (progress, token) => {
      progress.report({ message: vscode.l10n.t('Reading the comparison between the two branches…') });
      let commits;
      let changedFiles;
      try {
        [commits, changedFiles] = await Promise.all([
          client.getCompareCommits(target.owner, target.repo, target.base, target.head),
          client.getPullRequestFilesFromCompare(target.owner, target.repo, target.base, target.head),
        ]);
      } catch (error) {
        const err = userFacingErrorMessage(error);
        logger.error(
          `PR description: the comparison "${target.base}...${target.head}" of ${instance.name}/${target.owner}/${target.repo} could not be read: ${err}. Nothing was sent to a model.`,
        );
        return {
          kind: 'failed',
          error: vscode.l10n.t(
            'The comparison between "{0}" and "{1}" could not be read, so no description was drafted and nothing was sent to a model: {2}',
            target.base,
            target.head,
            err,
          ),
        };
      }
      if (token.isCancellationRequested) {
        return { kind: 'cancelled' };
      }

      const brief = buildPrDescriptionBrief({
        repository: `${target.owner}/${target.repo}`,
        baseBranch: target.base,
        headBranch: target.head,
        ...(target.title === undefined ? {} : { title: target.title }),
        commits,
        files: changedFiles.map((file) => ({
          path: file.filename ?? '',
          ...(file.status === undefined ? {} : { status: file.status }),
        })),
      });
      logger.debug(
        `PR description: the comparison has ${brief.commitsShown} of ${brief.commitsTotal} commit(s) and ${brief.filesShown} of ${brief.filesTotal} changed file(s) in the prompt${
          brief.truncatedBy === undefined ? '' : ` (truncatedBy=${brief.truncatedBy})`
        }`,
      );

      // The scope, as the prompt's own sections: no code at all for `commits-only`,
      // the changed files' head text for `commits-and-files`. Nothing else is
      // reachable from here.
      const signal = abortSignalForToken(token);
      let fileContents: AiPreReviewFileContents | undefined;
      if (scope === 'commits-and-files') {
        progress.report({ message: vscode.l10n.t('Reading the changed files…') });
        const paths = changedFiles
          .slice(0, AI_PRE_REVIEW_MAX_CONTENT_FILES)
          .map((file) => file.filename ?? '')
          .filter((path) => path !== '');
        fileContents = await collectPrDescriptionFileTexts(client, target, paths, token, signal);
      }
      if (token.isCancellationRequested) {
        return { kind: 'cancelled' };
      }

      // The language is settled once for the whole run and the instruction block is
      // built from it right away: the same bytes are then what the token counter
      // measures and what the request carries. It is read after the scope question
      // so a run the user declines never even reads a setting it will not use.
      const systemPrompt = buildPrDescriptionSystemPrompt(aiPreReviewCommentBodyLanguage());
      const declaredBudget = chosen.maxInputTokens ?? 0;
      let measured: number | undefined;
      try {
        measured = await transport.countTokens(chosen, systemPrompt);
      } catch (error) {
        logger.debug(
          `PR description: could not count the instructions for ${modelLabel(chosen)} (${userFacingErrorMessage(error)})`,
        );
        const failure = vscode.l10n.t(
          'The PR-description draft was not started: the chat model it would use, {0}, would not measure its instruction prompt, so the draft could not check that the prompt fits. Nothing was sent and no other model was substituted.',
          modelLabel(chosen),
        );
        void vscode.window.showErrorMessage(failure);
        return { kind: 'failed', error: failure };
      }
      const mode = aiPreReviewBudgetMode(measured, declaredBudget);
      const availableTokens = aiPreReviewAvailableTokens(mode, declaredBudget);
      const neededTokens = await countPrDescriptionTokens(
        transport,
        chosen,
        systemPrompt,
        brief.text,
        fileContents,
        mode,
      );
      if (neededTokens !== undefined && neededTokens >= availableTokens) {
        logger.error(
          `PR description: the prompt needs ${neededTokens} token(s) but ${formatAiPreReviewServedBy(servedBy, chosen)} has an input budget of ${availableTokens}; nothing was sent`,
        );
        const failure = vscode.l10n.t(
          'The PR-description draft could not be fitted into the input budget of the chat model you chose, {0} ({1} tokens needed, {2} available). Nothing was sent, and no other model was substituted. Choose the "commits-only" scope to send less, or use a model with a larger input budget.',
          modelLabel(chosen),
          neededTokens,
          availableTokens,
        );
        void vscode.window.showErrorMessage(failure);
        return { kind: 'failed', error: failure };
      }
      if (mode === 'estimated') {
        logger.info(
          `PR description: ${formatAiPreReviewServedBy(servedBy, chosen)} has no tokenizer, so this run estimates ${AI_PRE_REVIEW_ESTIMATED_BYTES_PER_TOKEN} UTF-8 bytes per token: the prompt is about ${neededTokens} token(s) against an assumed input budget of ${availableTokens}`,
        );
      }

      if (token.isCancellationRequested) {
        return { kind: 'cancelled' };
      }

      // The messages are built once and handed to the transport, so "what the run
      // measured" and "what the request carried" are the same bytes.
      const userPrompt =
        fileContents === undefined ? brief.text : `${brief.text}\n\n${renderPrDescriptionFileContents(fileContents)}`;
      const request: AiCompletionRequest = {
        system: systemPrompt,
        messages: buildPrDescriptionPromptMessages(systemPrompt, userPrompt).map((message) => ({
          role: message.role,
          text: message.text,
        })),
        // The editor's own consent-dialog text, which is why it names the scope
        // setting rather than restating every scope (§5.3).
        purpose: vscode.l10n.t(
          'The PR-description draft sends the commits and the changed-file list between the two branches, and — depending on the prompt scope you chose in "forgejoToolkit.prDescriptionPromptScope" — the text of the changed files, to the model, to draft a description you then edit and submit yourself.',
        ),
        signal,
      };

      progress.report({ message: vscode.l10n.t('Asking the chat model for a description…') });
      let result;
      try {
        result = await transport.complete(chosen, request);
      } catch (error) {
        const classified = classifyModelErrorSilently(error);
        if (classified.kind === 'cancelled') {
          return { kind: 'cancelled' };
        }
        const err =
          classified.kind === 'failed' && classified.error === 'NoPermissions'
            ? vscode.l10n.t('Permission to use the chat model was not granted, so no description was drafted.')
            : classified.kind === 'failed'
              ? classified.error
              : userFacingErrorMessage(error);
        logger.error(
          `PR description: the model call failed (${formatAiPreReviewServedBy(servedBy, chosen)}): ${err}. Nothing was written.`,
        );
        const failure = vscode.l10n.t(
          'The description could not be drafted: {0}. The body was left exactly as you wrote it, and no other model was tried.',
          err,
        );
        void vscode.window.showErrorMessage(failure);
        return { kind: 'failed', error: failure };
      }

      // The contract arbitrates, exactly as in the pre-review: the candidates are
      // tried in preference order and each is judged on its own bytes, so a
      // reasoning stream that happens to hold the description is used when the text
      // stream does not. No concatenation, no repair, no second model.
      const arbitration = pickResponseCandidate(
        result.parts,
        (candidate) => parsePrDescriptionAnswer(candidate.text).kind === 'ok',
      );
      const answer = parsePrDescriptionAnswer(arbitration.candidate?.text ?? '');
      if (answer.kind === 'failed') {
        const detail = describePrDescriptionFailure(answer.reason, answer.characterCount);
        logger.error(
          `PR description: ${formatAiPreReviewServedBy(servedBy, chosen)} answered something that is not a description (${detail}); nothing was written`,
        );
        const failure = vscode.l10n.t(
          'The description could not be drafted: the model answered something that is not a usable body ({0}). The body was left exactly as you wrote it, and no other model was tried.',
          detail,
        );
        void vscode.window.showErrorMessage(failure);
        return { kind: 'failed', error: failure };
      }

      logger.info(
        `PR description: drafted ${answer.description.length} character(s) with ${formatAiPreReviewServedBy(servedBy, chosen)}; the user submits the pull request`,
      );
      return { kind: 'ok', description: answer.description };
    },
  );
}

/**
 * Registers this feature's command and hands the view provider the function the
 * `generatePrDescription` message runs.
 *
 * Both entries go through `generatePrDescription`, the same way the pre-review's
 * two entries share `runAiPreReview`. Neither can create or submit a pull request:
 * the run's whole product is text.
 *
 * The command itself has no comparison to resolve — that exists only while the
 * form is open — so it points at the button rather than guessing a branch pair.
 */
export function registerPrDescriptionCommand(
  context: vscode.ExtensionContext,
  config: ConfigManager,
  viewProvider: ForgejoToolkitViewProvider,
): void {
  context.subscriptions.push(
    vscode.commands.registerCommand(COMMAND_GENERATE_PR_DESCRIPTION, () => {
      void vscode.window.showInformationMessage(
        vscode.l10n.t(
          'Open the create-pull-request form and use its "Generate description" button: the draft is written from the comparison that form is about to submit.',
        ),
      );
    }),
  );

  viewProvider.setPrDescriptionRunner((target) => generatePrDescription(config, target, context));
}
