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
import { selectedModelFor } from './ai/modelSelection';
import { aiPreReviewModelIdentity, maxInputTokensOf } from './aiPreReviewModels';
import type { AiCompletionRequest, AiModelInfo, AiModelTransport } from './ai/transport';
import {
  ISSUE_TRIAGE_PROMPT_SCOPE_SETTING,
  ISSUE_TRIAGE_SETTING,
  isIssueTriageEnabled,
  issueTriagePromptScopeSettingValue,
  issueTriageScopeHonourableOn,
  issueTriageScopesForSurface,
  writeIssueTriagePromptScopeSetting,
  type IssueTriageStatedScope,
  type IssueTriageSurface,
} from './issueTriageSettings';
import {
  buildIssueTriageBrief,
  buildIssueTriagePromptText,
  buildIssueTriageSystemPrompt,
  parseIssueTriageAnswer,
  suggestableLabels,
  validateIssueTriageAnswer,
  type IssueTriageCandidateLabel,
  type IssueTriageComment,
  type IssueTriageContractFailure,
} from './issueTriageBrief';
import type { IssueTriageSuggestionSet } from '@cpf23333-forgejo-toolkit/shared/webview/messages';

/**
 * "Suggest labels for an issue": read one issue and its repository's own label list,
 * ask a chat model which of them apply, and hand the answer back as a list of
 * suggestions the user may act on by themselves.
 *
 * The design record is `docs/design/issue-triage.md`; the consent, egress and
 * degradation disciplines it inherits are `docs/design/ai-model-transport.md` §7 and
 * §9. The properties this file exists to guarantee:
 *
 * 1. **The extension writes nothing.** The whole product of a run is a list of
 *    suggestions, and applying one stays the user's own save through the issue's
 *    existing edit form. There is no code path here that touches an issue.
 * 2. **Nothing leaves the machine unasked.** A feature switch (off by default) and a
 *    prompt scope whose default is the **question**. With the switch off the run
 *    refuses before it reads the issue; with the scope at `ask` the run's first act
 *    after the model is known is one modal naming who would receive the content and
 *    what each answer would send, and a dismissed modal ends the run with nothing
 *    read and nothing sent.
 * 3. **A suggestion is only ever a real one.** Every entry the model proposes is
 *    resolved against the very lists this run read, and everything that does not
 *    resolve is dropped and counted (`docs/design/issue-triage.md` §5); an answer
 *    that cannot be read as the contracted JSON is a failure, not an empty list.
 *
 * The order is the one every AI feature here uses: the global `aiEnabled` switch is
 * answered by `selectedModelFor` before any branch (§8.3), then this feature's own
 * switch, then whether the configured scope can be honoured on this surface, then the
 * model, then the one consent question, then the reads.
 */

/**
 * The `ExtensionContext` fields one run reads: the secret store a configured
 * endpoint's credential lives in. The same shape the other features' runs take, so
 * every entry can hand its own context along.
 */
export type IssueTriageRunHost = Pick<AiPreReviewRunHost, 'secrets'>;

/** What one triage request names: the issue to read. */
export interface IssueTriageTarget {
  instanceId: string;
  owner: string;
  repo: string;
  index: number;
}

/**
 * What one run produced.
 *
 * The three arms are the three things the caller can say: suggestions, "the user
 * cancelled", and a failure with one already-user-facing sentence. Every arm has
 * written nothing anywhere — the only write is the consent answer, and only when the
 * modal was the thing that produced it.
 */
export type IssueTriageRunResult =
  | { kind: 'ok'; suggestions: IssueTriageSuggestionSet }
  | { kind: 'cancelled' }
  | { kind: 'failed'; error: string };

/**
 * The consent modal's answers, as the buttons the user reads.
 *
 * Exported so the tests can press the exact label the modal offers, the way
 * `AI_PRE_REVIEW_SCOPE_BUTTON_*` is. The cancel label is the one the other features
 * already use: "cancel sends nothing" is the same sentence in all three.
 */
export const ISSUE_TRIAGE_SCOPE_BUTTON_ISSUE_ONLY = vscode.l10n.t('Send the issue and the repository label list');
export const ISSUE_TRIAGE_SCOPE_BUTTON_COMMENTS = vscode.l10n.t('Also send the discussion');
export const ISSUE_TRIAGE_SCOPE_BUTTON_CANCEL = vscode.l10n.t('Cancel — send nothing');

/**
 * The sentence that names the destination, for the modal (§7.1).
 *
 * Its own string rather than a shared one: each feature names itself, and a
 * configured endpoint's modal has to say which run is asking.
 */
function consentDestinationSentence(destination: AiPreReviewConsentDestination): string | undefined {
  if (destination.address === undefined) {
    return undefined;
  }
  return vscode.l10n.t(
    'The issue triage run would send this to the provider you configured, "{0}" at {1}.',
    destination.name,
    destination.address,
  );
}

/**
 * The sentence the one-time consent modal shows (§7.1's wording rules, §7.6's
 * scope).
 *
 * It names the destination first, then exactly what leaves the machine under each
 * answer, then the setting the answer is written to and the fact that nothing is
 * requested or sent before the answer. Two things are stated because a person has to
 * know them to answer honestly: the **label list** is content this run sends that no
 * other feature does, and the discussion answer is the only one under which anything
 * other than the issue's own text leaves the machine.
 *
 * It names the issue's text and the label list, and **nothing else about the
 * repository**: an earlier version also promised the list of assignable logins, which
 * this feature no longer reads or sends (`docs/design/issue-triage.md` §2).
 *
 * Both answers are named because the only surface this feature has can serve both
 * (`issueTriageScopesForSurface`); a surface that could not would need a sentence of
 * its own rather than a button quietly missing.
 */
export function issueTriagePromptScopeMessage(destination: AiPreReviewConsentDestination): string {
  const body = vscode.l10n.t(
    'Before the issue triage run sends anything: the chat model you chose belongs to the "{0}" provider. Choose what it may carry. "Send the issue and the repository label list" sends the title and body of this issue, and the repository label list (the name and description of each label, with archived labels left out) — no discussion comment, so the model sees the issue as written and nothing anyone has said about it. "Also send the discussion" adds the comments with their authors and dates, which is the most content and the only answer under which the model can take the existing discussion into account. No answer sends an access token, URL or host name. Set the setting "forgejoToolkit.issueTriagePromptScope" by hand instead if you would rather not be asked. Nothing is requested or sent before you answer, cancelling sends nothing, and your answer is written into that setting so this question is asked only once.',
    destination.name,
  );
  const prefix = consentDestinationSentence(destination);
  return prefix === undefined ? body : `${prefix} ${body}`;
}

/**
 * Asks the one question this feature asks about egress, as a **modal**.
 *
 * The answers offered are the scopes this surface can honour, in the enumeration's
 * order, plus cancel: an answer the run would have to refuse is not offered. A
 * dismissed modal is `undefined` for every "not answered" case — the explicit cancel
 * button, the platform close control, and Escape — and the caller turns that into a
 * cancelled run, because an unanswered consent question is not consent.
 */
async function askIssueTriagePromptScope(
  destination: AiPreReviewConsentDestination,
  scopes: readonly IssueTriageStatedScope[],
): Promise<IssueTriageStatedScope | undefined> {
  const buttons: string[] = [];
  if (scopes.includes('issue-only')) {
    buttons.push(ISSUE_TRIAGE_SCOPE_BUTTON_ISSUE_ONLY);
  }
  if (scopes.includes('issue-and-comments')) {
    buttons.push(ISSUE_TRIAGE_SCOPE_BUTTON_COMMENTS);
  }
  buttons.push(ISSUE_TRIAGE_SCOPE_BUTTON_CANCEL);
  const picked = await vscode.window.showInformationMessage(
    issueTriagePromptScopeMessage(destination),
    { modal: true },
    ...buttons,
  );
  if (picked === ISSUE_TRIAGE_SCOPE_BUTTON_ISSUE_ONLY) {
    return 'issue-only';
  }
  if (picked === ISSUE_TRIAGE_SCOPE_BUTTON_COMMENTS) {
    return 'issue-and-comments';
  }
  return undefined;
}

/**
 * What this run's prompt may carry, resolved before anything is read.
 *
 * A **stated** scope is used as it is, with no question: the setting is the source of
 * truth, so the question is asked once per choice rather than once per run. Which
 * stated scopes are honourable on this surface is checked by the caller **before** the
 * model is chosen, so a configured scope that this surface cannot serve fails by name
 * rather than turning into a question here.
 *
 * `ask` shows the modal and returns **nothing** when it is not answered, and an
 * answered modal writes the answer into the setting first (best effort — a failed
 * write changes where the answer is remembered, never what this run sends).
 */
async function resolveIssueTriagePromptScope(
  destination: AiPreReviewConsentDestination,
  surface: IssueTriageSurface,
): Promise<IssueTriageStatedScope | undefined> {
  const configured = issueTriagePromptScopeSettingValue();
  const scopes = issueTriageScopesForSurface(surface);
  if (configured !== 'ask') {
    logger.info(
      `Issue triage: prompt scope: the setting "${ISSUE_TRIAGE_PROMPT_SCOPE_SETTING}" = "${configured}"; no question was shown`,
    );
    return configured;
  }
  const answered = await askIssueTriagePromptScope(destination, scopes);
  if (answered === undefined) {
    logger.info(
      `Issue triage: the question about what may be sent (the setting "${ISSUE_TRIAGE_PROMPT_SCOPE_SETTING}") was not answered, so nothing was read, nothing was requested and nothing was sent`,
    );
    return undefined;
  }
  await rememberChosenIssueTriagePromptScope(answered);
  return answered;
}

/**
 * Stores the scope the user just chose in `forgejoToolkit.issueTriagePromptScope` and
 * says so.
 *
 * Best-effort in exactly one direction, like the other features': a failed write
 * changes where the answer is remembered, never what this run sends.
 */
async function rememberChosenIssueTriagePromptScope(scope: IssueTriageStatedScope): Promise<void> {
  try {
    await writeIssueTriagePromptScopeSetting(scope);
  } catch (error) {
    logger.error(
      `Issue triage: the chosen prompt scope could not be written to "${ISSUE_TRIAGE_PROMPT_SCOPE_SETTING}" (${userFacingErrorMessage(error)}); this run still uses "${scope}"`,
    );
    return;
  }
  logger.info(
    `Issue triage: prompt scope: "${ISSUE_TRIAGE_PROMPT_SCOPE_SETTING}" = "${scope}" was written, so later runs use it without asking`,
  );
}

/** The sentence for a stated scope this surface cannot honour. */
function unsupportedScopeMessage(scope: IssueTriageStatedScope): string {
  return vscode.l10n.t(
    'Issue triage was not started: this page cannot honour the prompt scope "{0}". Nothing was read, nothing was sent, and no other scope was used instead.',
    scope,
  );
}

/** The sentence for a contract failure, so the reader knows which part of the answer was wrong. */
function describeIssueTriageContractFailure(failure: IssueTriageContractFailure): string {
  switch (failure.kind) {
    case 'empty':
      return vscode.l10n.t('the answer was empty');
    case 'not-json':
      return vscode.l10n.t('the answer was not JSON');
    case 'wrong-shape':
      return vscode.l10n.t('the answer did not have the shape this feature asks for');
  }
}

/**
 * What one prompt costs this run, by the measure the run is in — the other features'
 * rule, applied to this feature's own prompt.
 *
 * The text measured is the exact text the request will carry, the instruction half
 * included, so "what we counted" and "what we sent" cannot drift.
 */
async function countIssueTriageTokens(
  transport: AiModelTransport,
  model: AiModelInfo,
  systemPrompt: string,
  briefText: string,
  mode: AiPreReviewBudgetMode,
): Promise<number | undefined> {
  const text = buildIssueTriagePromptText(systemPrompt, briefText);
  if (mode === 'estimated') {
    return estimateAiPreReviewTokens(text);
  }
  return await transport.countTokens(model, text);
}

/**
 * Asks which model suggests the labels, offering every model the editor has in the
 * shape the other features' pickers use — display name, `vendor/family`, the id, and
 * who would receive the content — so no two features present one editor's models two
 * different ways.
 *
 * This feature has **no model setting**, like the description feature: the editor
 * path asks every time, and an endpoint is pinned with `forgejoToolkit.aiModelBindings`.
 *
 * A dismissed pick is `undefined`, and the caller turns that into a cancelled run
 * with nothing sent.
 */
async function pickIssueTriageModel(offered: readonly AiModelInfo[]): Promise<AiModelInfo | undefined> {
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
        'The suggestions would come from the "{0}" provider. maxInputTokens={1}',
        vendor,
        String(maxInputTokensOf(model)),
      ),
      model,
    };
  });
  const picked = await vscode.window.showQuickPick(items, {
    title: vscode.l10n.t('Which chat model should suggest labels?'),
    placeHolder: vscode.l10n.t(
      'The issue and the repository label list are sent to the provider named under the model you pick, and — under the "issue-and-comments" scope — the discussion as well. To pin an endpoint and model instead, use the setting "forgejoToolkit.aiModelBindings".',
    ),
    ignoreFocusOut: true,
  });
  return picked?.model;
}

/**
 * The repository's labels, as candidates a suggestion may resolve to.
 *
 * Archived labels are left out: Forgejo keeps them for existing issues but does not
 * offer them for new ones, so suggesting one would be suggesting something the user
 * cannot pick. An entry without an id is left out too — there would be nothing to
 * apply — and neither omission is silent: both are logged with counts.
 */
function candidateLabels(
  labels: readonly { id?: number; name?: string; description?: string; color?: string; is_archived?: boolean }[],
): IssueTriageCandidateLabel[] {
  const { labels: candidates, archived, unidentifiable } = suggestableLabels(labels);
  logger.debug(
    `Issue triage: ${candidates.length} label(s) can be suggested (${archived} archived and ${unidentifiable} without an id or name were left out)`,
  );
  return candidates;
}

/**
 * The discussion, as the brief may carry it: the rows that are a comment, with their
 * author and date.
 *
 * A timeline row with no body is an event (a close, a label change, an assignment),
 * not something anybody said, and it is skipped. The rows arrive oldest first as the
 * server lists them, which is the order the brief keeps.
 */
function timelineComments(
  rows: readonly { body?: string; created_at?: string; user?: { login?: string; full_name?: string } }[],
): IssueTriageComment[] {
  const comments: IssueTriageComment[] = [];
  for (const row of rows) {
    const body = (row.body ?? '').trim();
    if (body === '') {
      continue;
    }
    const author = row.user?.login ?? row.user?.full_name;
    comments.push({
      body,
      ...(author === undefined || author === '' ? {} : { author }),
      ...(row.created_at === undefined ? {} : { date: row.created_at }),
    });
  }
  return comments;
}

/**
 * Runs one triage request.
 *
 * Nothing before the consent answer reads the issue or touches a model, and every arm
 * below has written nothing but the consent answer itself.
 */
export async function suggestIssueTriage(
  config: ConfigManager,
  target: IssueTriageTarget,
  host: IssueTriageRunHost,
): Promise<IssueTriageRunResult> {
  // The feature switch is checked first and answers with a pointer to the setting.
  // Nothing below this line may run while it is off.
  if (!isIssueTriageEnabled()) {
    const error = vscode.l10n.t('Issue triage is off. Enable the setting "forgejoToolkit.issueTriage" to use it.');
    logger.info(`Issue triage: refused because "${ISSUE_TRIAGE_SETTING}" is off; nothing was read or sent`);
    void vscode.window.showWarningMessage(error);
    return { kind: 'failed', error };
  }

  const instance = config.getInstances().find((candidate) => candidate.id === target.instanceId);
  if (!instance) {
    const error = vscode.l10n.t('Forgejo instance not found');
    void vscode.window.showErrorMessage(error);
    return { kind: 'failed', error };
  }

  // Which surface this run is on decides which scopes can be honoured, and a stated
  // scope outside that set is refused **by name** before the model is chosen: the run
  // never substitutes another tier, and it never re-asks, because `ask` is the
  // setting's spelling of "not answered yet" rather than a fallback.
  const surface: IssueTriageSurface = 'issue-detail';
  const configuredScope = issueTriagePromptScopeSettingValue();
  if (configuredScope !== 'ask' && !issueTriageScopeHonourableOn(surface, configuredScope)) {
    const error = unsupportedScopeMessage(configuredScope);
    logger.info(
      `Issue triage: refused because "${ISSUE_TRIAGE_PROMPT_SCOPE_SETTING}" = "${configuredScope}" cannot be honoured on "${surface}"; nothing was read or sent`,
    );
    void vscode.window.showWarningMessage(error);
    return { kind: 'failed', error };
  }

  const client = new ForgejoClient(instance.url, instance.token, logger, instance.syncApiUrlsToInstanceUrl);

  // **Which transport and which model serve this run** is settled before anything is
  // read. Every read the selection makes is a lookup, so "nothing leaves the machine
  // before the consent question is answered" stays true by construction; a selection
  // that comes back `unavailable` ends the run here rather than falling back (§7.5).
  const selection = await selectedModelFor('issueTriage', { secrets: hostSecrets(host) });
  if (selection.kind === 'unavailable') {
    logger.info(`Issue triage: no model is available for this run (${selection.code}); nothing was read or sent`);
    const error = vscode.l10n.t(
      "No AI model is available to suggest labels, so nothing was sent. The extension's Settings page explains what to do about it. Reason: {0}",
      selection.reason,
    );
    void vscode.window.showWarningMessage(error);
    return { kind: 'failed', error };
  }
  const transport = selection.transport;

  /** The model this run uses. On the direct path the user already named it. */
  let chosen: AiModelInfo;
  if (selection.kind === 'openai-compatible') {
    chosen = selection.model;
    logger.info(
      `Issue triage: model choice: ${transport.id} serves this run with ${modelLabel(chosen)} (${selection.reason}); no pick was shown`,
    );
  } else {
    const offered = await transport.listModels();
    if (offered.length === 0) {
      const error = vscode.l10n.t('The editor provides no chat model, so nothing was sent.');
      void vscode.window.showErrorMessage(error);
      return { kind: 'failed', error };
    }
    const picked = await pickIssueTriageModel(offered);
    if (!picked) {
      const error = vscode.l10n.t('No chat model was chosen, so nothing was sent and nothing was written.');
      logger.info('Issue triage: the model picker was dismissed; nothing was read or sent');
      void vscode.window.showInformationMessage(error);
      return { kind: 'cancelled' };
    }
    chosen = picked;
  }

  const servedBy = aiPreReviewServedBy(transport.id, selection.kind, chosen);
  logger.info(`Issue triage: this run is served by ${formatAiPreReviewServedBy(servedBy, chosen)}`);

  // What the prompt may carry is settled before this run reads anything: with the
  // setting at `ask` the modal is the only thing that happens, and a dismissed modal
  // returns from here with zero reads, zero requests and zero writes of its own.
  const destination = aiConsentDestinationFor(chosen);
  const scope = await resolveIssueTriagePromptScope(destination, surface);
  if (scope === undefined) {
    const error = vscode.l10n.t(
      'The issue triage run did not start: no answer was given to the question about what may be sent, so nothing was requested, nothing was sent and nothing was written. Take the action again and answer it, or set "forgejoToolkit.issueTriagePromptScope" by hand — "issue-only" or "issue-and-comments".',
    );
    void vscode.window.showInformationMessage(error);
    return { kind: 'cancelled' };
  }

  // Everything from the first read to the model's answer runs under one cancellable
  // notification: the reads and the model call are the slow steps, and cancelling
  // leaves nothing behind (there is nothing to leave).
  return await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: vscode.l10n.t('Suggesting labels'),
      cancellable: true,
    },
    async (progress, token) => {
      progress.report({ message: vscode.l10n.t('Reading the issue…') });
      let issue;
      try {
        issue = await client.getIssueDetail(target.owner, target.repo, target.index);
      } catch (error) {
        const err = userFacingErrorMessage(error);
        logger.error(
          `Issue triage: issue #${target.index} of ${instance.name}/${target.owner}/${target.repo} could not be read: ${err}. Nothing was sent to a model.`,
        );
        return {
          kind: 'failed',
          error: vscode.l10n.t(
            'The issue could not be read, so no triage suggestions were drafted and nothing was sent to a model: {0}',
            err,
          ),
        };
      }
      if (token.isCancellationRequested) {
        return { kind: 'cancelled' };
      }

      progress.report({ message: vscode.l10n.t("Reading the repository's labels…") });
      let repositoryLabels;
      try {
        repositoryLabels = await client.getRepoLabels(target.owner, target.repo);
      } catch (error) {
        const err = userFacingErrorMessage(error);
        logger.error(
          `Issue triage: the label list of ${instance.name}/${target.owner}/${target.repo} could not be read: ${err}. Nothing was sent to a model.`,
        );
        return {
          kind: 'failed',
          error: vscode.l10n.t(
            "The repository's labels could not be read, so no triage suggestions were drafted and nothing was sent to a model: {0}",
            err,
          ),
        };
      }
      if (token.isCancellationRequested) {
        return { kind: 'cancelled' };
      }

      // The discussion is read only under the scope that promises it: under
      // `issue-only` the run does not even fetch the comments, so their content
      // cannot reach the prompt by accident.
      let comments: IssueTriageComment[] | undefined;
      if (scope === 'issue-and-comments') {
        progress.report({ message: vscode.l10n.t('Reading the discussion…') });
        try {
          const timeline = await client.getPullRequestCommentsAndTimeline(target.owner, target.repo, target.index);
          comments = timelineComments(timeline);
        } catch (error) {
          const err = userFacingErrorMessage(error);
          logger.error(
            `Issue triage: the discussion of issue #${target.index} could not be read: ${err}. Nothing was sent to a model.`,
          );
          return {
            kind: 'failed',
            error: vscode.l10n.t(
              'The discussion could not be read, so no triage suggestions were drafted and nothing was sent to a model: {0}',
              err,
            ),
          };
        }
        if (token.isCancellationRequested) {
          return { kind: 'cancelled' };
        }
      }

      // **The run-side guard for a repository that declares no label.** The page hides
      // the action long before this (the host reads the same list when the issue view
      // opens and pushes the answer, §3.2), so reaching this with an empty list means a
      // view that was rendered before the repository lost its labels — and the honest
      // answer there is to say so, not to send a prompt with an empty candidate set.
      const labels = candidateLabels(repositoryLabels);
      if (labels.length === 0) {
        logger.info(
          `Issue triage: ${instance.name}/${target.owner}/${target.repo} declares no label, so there is nothing to suggest; nothing was sent`,
        );
        return {
          kind: 'failed',
          error: vscode.l10n.t(
            'This repository declares no label, so there is nothing to suggest. Nothing was sent to a model.',
          ),
        };
      }

      const brief = buildIssueTriageBrief({
        repository: `${target.owner}/${target.repo}`,
        issueNumber: target.index,
        title: issue.title ?? '',
        body: issue.body ?? '',
        labels,
        ...(comments === undefined ? {} : { comments }),
      });
      logger.debug(
        `Issue triage: the prompt carries ${brief.labelsShown} of ${brief.labelsTotal} label(s) and ${brief.commentsShown} of ${brief.commentsTotal} comment(s)${
          brief.truncatedBy === undefined ? '' : ` (truncatedBy=${brief.truncatedBy})`
        }`,
      );

      const systemPrompt = buildIssueTriageSystemPrompt();
      const declaredBudget = chosen.maxInputTokens ?? 0;
      let measured: number | undefined;
      try {
        measured = await transport.countTokens(chosen, systemPrompt);
      } catch (error) {
        logger.debug(
          `Issue triage: could not count the instructions for ${modelLabel(chosen)} (${userFacingErrorMessage(error)})`,
        );
        const failure = vscode.l10n.t(
          'The issue triage run was not started: the chat model it would use, {0}, would not measure its instruction prompt, so the run could not check that the prompt fits. Nothing was sent and no other model was substituted.',
          modelLabel(chosen),
        );
        void vscode.window.showErrorMessage(failure);
        return { kind: 'failed', error: failure };
      }
      const mode = aiPreReviewBudgetMode(measured, declaredBudget);
      const availableTokens = aiPreReviewAvailableTokens(mode, declaredBudget);
      const neededTokens = await countIssueTriageTokens(transport, chosen, systemPrompt, brief.text, mode);
      if (neededTokens !== undefined && neededTokens >= availableTokens) {
        logger.error(
          `Issue triage: the prompt needs ${neededTokens} token(s) but ${formatAiPreReviewServedBy(servedBy, chosen)} has an input budget of ${availableTokens}; nothing was sent`,
        );
        const failure = vscode.l10n.t(
          'The issue triage prompt could not be fitted into the input budget of the chat model you chose, {0} ({1} tokens needed, {2} available). Nothing was sent, and no other model was substituted. Use the "issue-only" scope to send less, or use a model with a larger input budget.',
          modelLabel(chosen),
          neededTokens,
          availableTokens,
        );
        void vscode.window.showErrorMessage(failure);
        return { kind: 'failed', error: failure };
      }
      if (mode === 'estimated') {
        logger.info(
          `Issue triage: ${formatAiPreReviewServedBy(servedBy, chosen)} has no tokenizer, so this run estimates ${AI_PRE_REVIEW_ESTIMATED_BYTES_PER_TOKEN} UTF-8 bytes per token: the prompt is about ${neededTokens} token(s) against an assumed input budget of ${availableTokens}`,
        );
      }

      if (token.isCancellationRequested) {
        return { kind: 'cancelled' };
      }

      // The seam request keeps the instruction block and the brief **apart**: joining
      // them is the transport's own business — the OpenAI-compatible one sends
      // `system` as its own message, the editor's one prepends it to the single user
      // message (`aiPreReviewPromptText`). Handing the joined text in here put the
      // instructions on the wire **twice** while `countIssueTriageTokens` measured
      // them once, so a model whose declared budget fell between the two numbers
      // passed a check it could not fit (the pre-review's request is the shape this
      // copies, and `prDescription.ts` had the same defect).
      const request: AiCompletionRequest = {
        system: systemPrompt,
        messages: [{ role: 'user', text: brief.text }],
        // The editor's own consent-dialog text, which is why it names the scope
        // setting rather than restating every scope (§5.3).
        purpose: vscode.l10n.t(
          'The issue triage run sends this issue and the repository label list, and — under the "issue-and-comments" scope — the discussion, to the model, to suggest labels that you then review and apply yourself.',
        ),
        signal: abortSignalForToken(token),
      };

      progress.report({ message: vscode.l10n.t('Asking the chat model for suggestions…') });
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
            ? vscode.l10n.t('Permission to use the chat model was not granted, so no triage suggestions were drafted.')
            : classified.kind === 'failed'
              ? classified.error
              : userFacingErrorMessage(error);
        logger.error(
          `Issue triage: the model call failed (${formatAiPreReviewServedBy(servedBy, chosen)}): ${err}. Nothing was written.`,
        );
        const failure = vscode.l10n.t(
          'The triage suggestions could not be drafted: {0}. Nothing was written, and no other model was tried.',
          err,
        );
        void vscode.window.showErrorMessage(failure);
        return { kind: 'failed', error: failure };
      }

      // The contract arbitrates, exactly as in the other features: the candidates are
      // tried in preference order and each is judged on its own bytes, so a reasoning
      // stream that happens to hold the JSON is used when the text stream does not.
      // No concatenation, no repair, no second model.
      const arbitration = pickResponseCandidate(
        result.parts,
        (candidate) => parseIssueTriageAnswer(candidate.text).kind === 'ok',
      );
      const answer = parseIssueTriageAnswer(arbitration.candidate?.text ?? '');
      if (answer.kind !== 'ok') {
        const detail = describeIssueTriageContractFailure(answer);
        logger.error(
          `Issue triage: ${formatAiPreReviewServedBy(servedBy, chosen)} answered something this run cannot use (${detail}); nothing was written`,
        );
        const truncatedNote =
          result.truncated === true
            ? ` ${vscode.l10n.t('The AI endpoint "{0}" stopped the answer at its own output limit (finish_reason=length), so the answer is incomplete.', modelLabel(chosen))}`
            : '';
        const failure = vscode.l10n.t(
          'The triage suggestions could not be drafted: the model answered something this run cannot use ({0}). Nothing was written, and no other model was tried.',
          detail,
        );
        void vscode.window.showErrorMessage(`${failure}${truncatedNote}`);
        return { kind: 'failed', error: `${failure}${truncatedNote}` };
      }

      const accepted = validateIssueTriageAnswer(brief, answer);
      logger.info(
        `Issue triage: ${formatAiPreReviewServedBy(servedBy, chosen)} proposed ${accepted.labels.length} label(s) this run could resolve${
          accepted.dropped.length === 0
            ? ''
            : `; dropped ${accepted.dropped.map((entry) => `${entry.count} ${entry.reason}`).join(', ')}`
        }; the user still applies anything themselves`,
      );
      return {
        kind: 'ok',
        suggestions: {
          labels: accepted.labels,
          dropped: accepted.dropped,
          servedBy: formatAiPreReviewServedBy(servedBy, chosen),
          scope,
          ...(result.truncated === true ? { truncated: true } : {}),
        },
      };
    },
  );
}

/**
 * Hands the view provider the function the `suggestIssueTriage` message runs.
 *
 * One entry point rather than two: this feature has no command of its own, because
 * the action needs an issue to name and only the page knows which one is open (the
 * other features' commands exist to give a palette entry to an action that resolves
 * its own target from a diff document or a form).
 */
export function registerIssueTriage(
  context: vscode.ExtensionContext,
  config: ConfigManager,
  viewProvider: ForgejoToolkitViewProvider,
): void {
  viewProvider.setIssueTriageRunner((target) => suggestIssueTriage(config, target, context));
}
