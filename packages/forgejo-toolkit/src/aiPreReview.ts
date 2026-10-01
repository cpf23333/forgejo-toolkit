import * as vscode from 'vscode';
import { ForgejoClient } from './api/client';
import { ConfigManager } from './config';
import { userFacingErrorMessage } from './api/errors';
import { ForgejoToolkitViewProvider } from './webview/viewProvider';
import { PullReviewCommentController } from './comments/pullReviewCommentController';
import { parseForgejoPrUri, type ForgejoPrUriParams } from './prFileSystemProvider';
import { logger } from './logger';
import { isAiPreReviewEnabled, isAiPreReviewIncludeDiffEnabled } from './aiPreReviewSettings';
import {
  AI_PRE_REVIEW_SYSTEM_PROMPT,
  buildAiPreReviewBrief,
  buildAiPreReviewUserPrompt,
  describeAiPreReviewAnswerShape,
  formatCandidateLabel,
  parseAiPreReviewResponse,
  validatePreReviewComments,
  type AiPreReviewBrief,
  type AiPreReviewBriefFile,
  type AiPreReviewCandidate,
  type AiPreReviewContractFailure,
  type AiPreReviewDrop,
  type AiPreReviewDropReason,
  type AiPreReviewExistingReview,
} from './aiPreReviewBrief';
import type { CreatePullReviewComment } from '@cpf23333-forgejo-toolkit/api';

/**
 * The AI pre-review command: read a pull request, ask a chat model for
 * line-level comments, let the user confirm each one, and turn only the
 * confirmed ones into pending-review drafts.
 *
 * The design record is `docs/design/ai-prereview.md`; the three properties this
 * file exists to guarantee are:
 *
 * 1. **draft-only.** Nothing here calls `submitPullReview`. A generated comment
 *    becomes a server-side PENDING comment, and the existing "submit review"
 *    button in the review-comment panel remains the only way anything becomes
 *    public.
 * 2. **nothing leaves the machine unasked.** Two window-scoped switches, both off
 *    by default. With the feature switch off the command refuses before it reads
 *    anything: no model call, no HTTP request, not even a diff fetch.
 * 3. **nothing is written unconfirmed.** The confirmation list starts with
 *    nothing selected, an empty selection writes nothing, and the run reports
 *    how many candidates were dropped and why.
 *
 * Every anchor is validated by the pure validator in `aiPreReviewBrief.ts`; this
 * module never moves a line, flips a side or clamps a range. Deleting a draft
 * after a partial failure is deliberately not done: the record's §6.4 explains
 * that a rollback would be an irreversible second write to a state the user may
 * already have read.
 *
 * On top of those three, one run may now ask **more than one model**: the
 * answer contract is a serialization demand some models simply do not meet, and
 * a run that gave up on the first prose answer left the user with "try again"
 * when the extension could try the next offered model itself (§7.2). The retry
 * is bounded, no model is asked twice, and it only ever follows a contract
 * violation — never a real model failure, never a cancellation, and never an
 * answer that parsed but whose anchors were all dropped.
 */

/** The command id, contributed in `package.json` and public once released. */
export const COMMAND_AI_PRE_REVIEW = 'forgejoToolkit.aiPreReviewPullRequest';

/**
 * Runs in flight, keyed by `instanceId:owner/repo#index` (§6.2). Module-level
 * and window-scoped, the same single-flight shape
 * `src/commands/index.ts` uses for its publish and create-PR flows, but keyed
 * because two different pull requests may legitimately be reviewed at once.
 */
const runsInFlight = new Set<string>();

function runKey(params: { instanceId: string; owner: string; repo: string; index: number }): string {
  return `${params.instanceId}:${params.owner}/${params.repo}#${params.index}`;
}

/**
 * Resolves the pull request a command invocation refers to from a `forgejo-pr`
 * diff document, taking the identified editor when the invocation names one and
 * falling back to the active editor.
 *
 * A diff editor is two editors, so `activeTextEditor` alone is not trustworthy
 * (the same reason `COMMAND_ADD_COMMENT` resolves by URI first); the URI is what
 * the command's menu argument carries.
 */
export function resolveAiPreReviewTarget(
  first: unknown,
  fallbackEditor: vscode.TextEditor | undefined,
): { editor: vscode.TextEditor; params: ForgejoPrUriParams } | undefined {
  const uri = uriArgumentOf(first);
  const byUri = uri
    ? (vscode.window.visibleTextEditors ?? []).find((candidate) => sameDocumentUri(candidate.document.uri, uri))
    : undefined;
  const editor = byUri ?? fallbackEditor;
  if (!editor) {
    return undefined;
  }
  const params = parseForgejoPrUri(editor.document.uri);
  return params ? { editor, params } : undefined;
}

/** Same contract as `src/commands/index.ts`'s `uriArgumentOf`. */
function uriArgumentOf(value: unknown): unknown {
  if (!value || typeof value !== 'object') {
    return undefined;
  }
  const candidate = value as { scheme?: unknown; uri?: unknown };
  if (typeof candidate.scheme === 'string') {
    return candidate;
  }
  return candidate.uri;
}

/** Same contract as `src/commands/index.ts`'s `sameDocumentUri`. */
function sameDocumentUri(a: vscode.Uri, b: unknown): boolean {
  if (!b || typeof b !== 'object') {
    return false;
  }
  const candidate = b as Partial<vscode.Uri>;
  if (typeof candidate.scheme !== 'string' || candidate.scheme !== a.scheme) {
    return false;
  }
  const path = typeof candidate.path === 'string' ? candidate.path : candidate.fsPath;
  return typeof path === 'string' && (path === a.path || path === a.fsPath);
}

/**
 * Registers the command. Kept in its own module rather than inline in
 * `src/commands/index.ts` because the handler owns a whole flow (fetch, model,
 * confirm, write) and the file has to stay readable.
 */
export function registerAiPreReviewCommand(
  context: vscode.ExtensionContext,
  config: ConfigManager,
  viewProvider: ForgejoToolkitViewProvider,
  pullReviewCommentController: PullReviewCommentController,
): void {
  context.subscriptions.push(
    vscode.commands.registerCommand(COMMAND_AI_PRE_REVIEW, (first?: unknown) => {
      const target = resolveAiPreReviewTarget(first, vscode.window.activeTextEditor);
      if (!target) {
        void vscode.window.showWarningMessage(vscode.l10n.t('No Forgejo PR diff file is active'));
        return;
      }
      runAiPreReview(config, viewProvider, pullReviewCommentController, target.params).catch((error: unknown) => {
        const err = userFacingErrorMessage(error);
        logger.error(`[aiPreReview] ${err}`);
      });
    }),
  );
}

/**
 * One chat model the run may use, with the instruction prompt already measured
 * in that model's own tokenizer (§7.2). The measurement travels with the model
 * because every later comparison for this run compares against the same number.
 */
export interface AiPreReviewModelCandidate {
  model: vscode.LanguageModelChat;
  /** Tokens the fixed instruction prompt costs this model. */
  instructionTokens: number;
}

/**
 * What the editor offered, which is what a budget failure has to tell the user.
 * Kept as data rather than folded into a message so both failure paths report
 * the same facts and the tests can read them.
 */
export interface AiPreReviewModelBudget {
  /** How many chat models `selectChatModels()` returned. */
  offered: number;
  /** The largest `maxInputTokens` among them; `0` when none was offered. */
  largestMaxInputTokens: number;
}

/** The two numbers a request that does not fit reports (§7.2). */
export interface AiPreReviewBudgetFailure {
  /** Tokens the shortest prompt for this pull request still needs. */
  neededTokens: number;
  /** The chosen model's `maxInputTokens`. */
  availableTokens: number;
}

/** A prompt cut to the chosen model's budget, or the numbers it missed by. */
type PreparedPrompt = { kind: 'ready'; userPrompt: string } | { kind: 'budget'; failure: AiPreReviewBudgetFailure };

/**
 * How many models one run may ask (§7.2). Three is the record's bound: the
 * first attempt is the most plausible model, and two further ones cover a
 * machine that offers a family of models of which only some follow the
 * contract. The bound is also what keeps a run's cost and latency predictable
 * — the record's §6.5 still holds, in that no model is asked a second question
 * and no run ever holds a conversation.
 */
export const AI_PRE_REVIEW_MAX_MODEL_ATTEMPTS = 3;

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

/** Reads the identity fields off a model, tolerating a provider that omits one. */
export function aiPreReviewModelIdentity(model: vscode.LanguageModelChat): AiPreReviewModelIdentity {
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

/** The shorter form used in the diagnostics of the budget helpers. */
function modelLabel(model: vscode.LanguageModelChat): string {
  return formatAiPreReviewModelIdentity(aiPreReviewModelIdentity(model));
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
    // A provider that omits the id leaves nothing stable to remember; treating
    // the whole identity as the key at least keeps two distinct models apart.
    return `unidentified:${identity.vendor}/${identity.family}/${identity.name}`;
  }
  return `${identity.vendor}/${identity.id}`;
}

/**
 * The models that satisfied the answer contract earlier in **this window**,
 * most recent last.
 *
 * The record's §7.2 refuses to point users at one provider, so there is no
 * vendor or family this feature may legitimately prefer — and `@types/vscode`
 * 1.102 exposes no signal for "the model the user last picked": `ChatRequest.model`
 * is documented as "the model that is currently selected in the UI", but a
 * `ChatRequest` only exists inside a chat participant's request handler, and
 * `LanguageModelAccessInformation` answers consent, not preference. The one
 * honest ordering signal left is this extension's own history, recorded
 * per window and discarded when it closes.
 *
 * This is deliberately not persisted: it is a hint about the machine's current
 * providers and their current state, and a model that answered last week says
 * little about today's quota or network.
 */
const contractSatisfyingModelKeys: string[] = [];

/** How many models the window's history remembers before the oldest is dropped. */
export const AI_PRE_REVIEW_CONTRACT_MEMORY_LIMIT = 8;

/** Records that one model's answer satisfied the contract, as the most recent. */
export function rememberAiPreReviewContractSatisfyingModel(model: vscode.LanguageModelChat): void {
  const key = aiPreReviewModelKey(model);
  const existing = contractSatisfyingModelKeys.indexOf(key);
  if (existing >= 0) {
    contractSatisfyingModelKeys.splice(existing, 1);
  }
  contractSatisfyingModelKeys.push(key);
  while (contractSatisfyingModelKeys.length > AI_PRE_REVIEW_CONTRACT_MEMORY_LIMIT) {
    contractSatisfyingModelKeys.shift();
  }
}

/** The remembered models, most recently successful first. */
export function preferredAiPreReviewModelKeys(): readonly string[] {
  return [...contractSatisfyingModelKeys].reverse();
}

/**
 * Forgets the window's contract history.
 *
 * Exported for the tests and used by nothing else: the history is module-level
 * window state, and one test file is one window, so a case that records a
 * success would otherwise reorder a later case's candidates.
 */
export function resetAiPreReviewModelMemory(): void {
  contractSatisfyingModelKeys.length = 0;
}

/**
 * Orders one run's candidates for its attempt sequence (§7.2): the models whose
 * answers satisfied the contract earlier in this window come first, most
 * recently successful first, and everything else keeps the budget order
 * `affordableAiPreReviewModels` produced (largest `maxInputTokens` first).
 *
 * The budget remains the primary signal for a machine with no history — it is
 * the only thing that says whether a candidate can take the request at all —
 * while a remembered model is the only defensible preference on a machine where
 * several models exist and some of them do not answer in JSON. Models the
 * editor lists twice are collapsed to one entry, because the attempt bound
 * promises that no model is asked twice.
 *
 * The sort is stable and `Array.prototype.filter` preserves order, so both
 * groups keep the order they arrived in; only the partition is new.
 */
export function orderAiPreReviewCandidates(
  candidates: readonly AiPreReviewModelCandidate[],
  preferredKeys: readonly string[],
): AiPreReviewModelCandidate[] {
  const seen = new Set<string>();
  const unique: AiPreReviewModelCandidate[] = [];
  for (const candidate of candidates) {
    const key = aiPreReviewModelKey(candidate.model);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    unique.push(candidate);
  }
  const rank = new Map(preferredKeys.map((key, index) => [key, index]));
  const preferred = unique
    .filter((candidate) => rank.has(aiPreReviewModelKey(candidate.model)))
    .sort((a, b) => (rank.get(aiPreReviewModelKey(a.model)) ?? 0) - (rank.get(aiPreReviewModelKey(b.model)) ?? 0));
  const rest = unique.filter((candidate) => !rank.has(aiPreReviewModelKey(candidate.model)));
  return [...preferred, ...rest];
}

/**
 * One model's attempt against the contract, kept so the failure report can name
 * every model the run asked and how each one fell short (§7.2).
 */
export interface AiPreReviewModelAttempt {
  /** The model as the API exposes it. */
  model: AiPreReviewModelIdentity;
  /** Why that model's answer was not the contracted JSON object. */
  failure: AiPreReviewContractFailure;
}

/**
 * What the cancellable phase produced. Each arm is reported to the user exactly
 * once by the caller, and none of them has written anything.
 */
type GatheredPreReview =
  | {
      kind: 'parsed';
      /** The `comments` array of the answer that satisfied the contract. */
      comments: unknown[];
      brief: AiPreReviewBrief;
    }
  | { kind: 'cancelled' }
  | { kind: 'budget'; failure: AiPreReviewBudgetFailure }
  /** Every asked model failed the contract; `attempts` names them all. */
  | { kind: 'unparsed'; attempts: AiPreReviewModelAttempt[] }
  /** The model call itself failed; `reported` says whether it was already shown. */
  | { kind: 'failed'; error: string; reported: boolean };

/**
 * The whole run. Returns after reporting to the user; never throws for an
 * expected failure (those are reported in place), so the command registration
 * only has to guard against a genuinely unexpected error.
 *
 * Everything between the first request and the model's answer runs inside one
 * cancellable progress notification, and cancelling it is the same outcome as
 * declining the confirmation list: one sentence, nothing written (§6.4).
 */
export async function runAiPreReview(
  config: ConfigManager,
  viewProvider: ForgejoToolkitViewProvider | undefined,
  pullReviewCommentController: PullReviewCommentController,
  params: ForgejoPrUriParams,
): Promise<void> {
  // The feature switch is checked first and answers with a pointer to the
  // setting. Nothing below this line may run while it is off: the tests assert
  // zero requests and zero model calls on this path, not just zero writes.
  if (!isAiPreReviewEnabled()) {
    void vscode.window.showWarningMessage(
      vscode.l10n.t('The AI pre-review is off. Enable the setting "forgejoToolkit.aiPreReview" to use it.'),
    );
    return;
  }

  const instance = config.getInstances().find((candidate) => candidate.id === params.instanceId);
  if (!instance) {
    void vscode.window.showErrorMessage(vscode.l10n.t('Forgejo instance not found'));
    return;
  }

  const key = runKey(params);
  if (runsInFlight.has(key)) {
    void vscode.window.showWarningMessage(vscode.l10n.t('An AI pre-review of this pull request is already running.'));
    return;
  }
  runsInFlight.add(key);

  try {
    const client = new ForgejoClient(instance.url, instance.token, logger, instance.syncApiUrlsToInstanceUrl);

    const models = await listAiPreReviewModels();
    if (!models) {
      return;
    }

    // The instruction half is a constant, so "could any model take this run at
    // all" is answered before the first request goes out: a machine whose models
    // cannot hold it gets the precise budget message and **no** HTTP traffic.
    const affordable = await affordableAiPreReviewModels(models, AI_PRE_REVIEW_SYSTEM_PROMPT);
    if (affordable.candidates.length === 0) {
      reportInstructionBudgetFailure(affordable.budget);
      return;
    }

    // Everything from the first request to the model's answer runs under one
    // cancellable notification (§6.2): the model call is the only slow step, and
    // cancelling it must leave the server untouched.
    const gathered = await vscode.window.withProgress(
      {
        // Notifications are the only location that shows a cancel button, which
        // is why this one is a notification rather than a window progress bar.
        location: vscode.ProgressLocation.Notification,
        title: vscode.l10n.t('AI pre-review'),
        cancellable: true,
      },
      (progress, token) => gatherPreReviewRequest(client, params, affordable.candidates, progress, token),
    );

    if (gathered.kind === 'cancelled') {
      reportCancelled();
      return;
    }
    if (gathered.kind === 'budget') {
      reportRequestBudgetFailure(gathered.failure, affordable.budget);
      return;
    }
    if (gathered.kind === 'failed') {
      if (!gathered.reported) {
        logger.error(`AI pre-review model call failed: ${gathered.error}`);
        void vscode.window.showErrorMessage(
          vscode.l10n.t(
            'The AI pre-review could not be completed: {0}. This does not affect your review — nothing was created.',
            gathered.error,
          ),
        );
      }
      return;
    }
    if (gathered.kind === 'unparsed') {
      reportContractFailures(gathered.attempts);
      return;
    }

    const { accepted, dropped } = validatePreReviewComments(gathered.brief, { comments: gathered.comments });
    if (accepted.length === 0) {
      void vscode.window.showInformationMessage(
        vscode.l10n.t(
          'The AI pre-review produced no usable comments ({0}). Nothing was created.',
          describeDrops(dropped),
        ),
      );
      return;
    }

    const confirmed = await confirmCandidates(accepted);
    if (confirmed.length === 0) {
      reportCancelled();
      return;
    }

    await writeConfirmedDrafts(config, pullReviewCommentController, viewProvider, params, confirmed, dropped);
  } finally {
    runsInFlight.delete(key);
  }
}

/**
 * "Nothing can take even the instructions" (§7.2). Names how many models were
 * offered and the largest budget among them, because on a machine where this
 * fires the user's next move depends on both: the count says whether a provider
 * is installed at all, and the budget says whether any of them is usable for
 * this feature. The remedies are the two that can actually change the outcome —
 * a model with a larger budget, or a provider that offers one — plus the one
 * that cannot, said out loud so nobody spends a run finding that out.
 */
function reportInstructionBudgetFailure(budget: AiPreReviewModelBudget): void {
  void vscode.window.showErrorMessage(
    vscode.l10n.t(
      'AI pre-review: none of the {0} chat model(s) VS Code offered can take its instructions — the largest input budget is {1} tokens. Nothing was sent and nothing was created. Choose a model with a larger input budget in the chat model picker, or install and sign in to a chat model provider whose model takes more input. (Turning off "forgejoToolkit.aiPreReviewIncludeDiff" shrinks the request but not the instructions, so it cannot help here.)',
      budget.offered,
      budget.largestMaxInputTokens,
    ),
  );
}

/**
 * "The request does not fit the model it chose" (§7.2). Reports both numbers and
 * the same offered-models facts, then the two remedies that shrink the request
 * or enlarge the budget. Turning the diff-body switch off is named first because
 * it is the one the user can do without leaving the editor.
 */
function reportRequestBudgetFailure(failure: AiPreReviewBudgetFailure, budget: AiPreReviewModelBudget): void {
  void vscode.window.showErrorMessage(
    vscode.l10n.t(
      'The AI pre-review could not fit this pull request into the input budget of the chat model it chose ({0} tokens needed, {1} available; the largest budget among the {2} model(s) offered is {3}). Nothing was sent and nothing was created. Turn off the setting "forgejoToolkit.aiPreReviewIncludeDiff" to send a smaller request, or pick a model with a larger input budget and try again.',
      failure.neededTokens,
      failure.availableTokens,
      budget.offered,
      budget.largestMaxInputTokens,
    ),
  );
}

/**
 * "Every model the run could ask answered something that is not the contracted
 * JSON object" (§6.4's parse row, §7.2's bound).
 *
 * The message names each model and how it failed, because the three contract
 * failures mean different things — an empty answer and a prose answer are
 * different problems, and a JSON answer missing `comments` is a third — and
 * because a user who sees three models named can tell whether the feature tried
 * the models they care about. There is deliberately no "try again": the retry
 * the extension could do itself has already happened, up to the bound the
 * message states. Nothing about the answers themselves is quoted here — only
 * the bounded shape description goes to the log, at debug level.
 */
function reportContractFailures(attempts: readonly AiPreReviewModelAttempt[]): void {
  const tried = attempts
    .map((attempt) => `${formatAiPreReviewModelIdentity(attempt.model)} — ${describeContractFailure(attempt.failure)}`)
    .join('; ');
  void vscode.window.showErrorMessage(
    vscode.l10n.t(
      'The AI pre-review asked {0} chat model(s) (at most {1} per run, each model only once) and none returned the JSON it needs, so no comments were created. Tried: {2}. Nothing was created; you can review the pull request by hand.',
      attempts.length,
      AI_PRE_REVIEW_MAX_MODEL_ATTEMPTS,
      tried,
    ),
  );
}

/**
 * The user-facing label of one contract failure. Every branch returns a literal,
 * like `describeDropReason`, so the i18n parity test's "every literal key used
 * in the source exists in the bundle" check can read it.
 */
function describeContractFailure(failure: AiPreReviewContractFailure): string {
  switch (failure.kind) {
    case 'empty':
      return vscode.l10n.t('the answer was empty');
    case 'not-json':
      return vscode.l10n.t('the answer was not JSON');
    case 'wrong-shape':
      return failure.field === 'root'
        ? vscode.l10n.t('the answer is JSON but its top level is not an object')
        : vscode.l10n.t('the answer is JSON but its "comments" field is missing or not an array');
  }
}

/**
 * The log line for one failed attempt. Distinct per failure kind — that is the
 * point of the split — and it names the model that produced the answer, which
 * is the line a bug report needs. Plain text rather than `l10n.t`: log lines are
 * never shown in the UI (AGENTS.md, i18n).
 */
function contractFailureLogLine(model: AiPreReviewModelIdentity, failure: AiPreReviewContractFailure): string {
  const identity = formatAiPreReviewModelIdentity(model);
  switch (failure.kind) {
    case 'empty':
      return `AI pre-review: ${identity} returned an empty answer`;
    case 'not-json':
      return `AI pre-review: ${identity} returned an answer that is not JSON`;
    case 'wrong-shape':
      return failure.field === 'root'
        ? `AI pre-review: ${identity} returned JSON whose top level is not an object`
        : `AI pre-review: ${identity} returned JSON whose "comments" field is missing or not an array`;
  }
}

/** The one sentence every cancelled arm shows (§6.4). */
function reportCancelled(): void {
  void vscode.window.showInformationMessage(
    vscode.l10n.t('The AI pre-review was cancelled. No comments were created.'),
  );
}

/**
 * Every chat model the editor offers, or `undefined` after reporting why there
 * are none. Two degradation layers, as the record's §9.2 and §9.3 require: an
 * editor without the API at all, and an editor with the API but no usable model
 * (not installed, not signed in, no subscription, disabled by policy, or the
 * user declining the consent dialog — the last one only surfaces at
 * `sendRequest` time).
 *
 * There is deliberately no third layer that falls back to heuristics: without a
 * model this feature does not exist, and pretending otherwise would produce
 * review comments attributed to a machine that never read anything. Which of the
 * offered models a run then tries, in which order, is answered by
 * `affordableAiPreReviewModels`, `orderAiPreReviewCandidates` and
 * `selectAiPreReviewModel` below — the last two now also shape the retry.
 */
async function listAiPreReviewModels(): Promise<vscode.LanguageModelChat[] | undefined> {
  // Read the optional API off the namespace before testing it, the same shape
  // `src/mcpServerProvider.ts` uses for its own optional surface: an editor that
  // does not implement it must lose this one feature, never fail activation.
  const select = vscode.lm?.selectChatModels as typeof vscode.lm.selectChatModels | undefined;
  if (typeof select !== 'function') {
    logger.info('This editor provides no language model API; the AI pre-review cannot run.');
    void vscode.window.showErrorMessage(
      vscode.l10n.t(
        'This VS Code build has no language model API, so the AI pre-review cannot run. Everything else keeps working.',
      ),
    );
    return undefined;
  }
  try {
    // No selector on purpose: a `vendor`/`family` hint would name one provider's
    // model, and the record's §9.3 refuses to point at one provider. The offered
    // list is what the budget choice below is made from instead.
    const models = await select.call(vscode.lm);
    if (!models || models.length === 0 || !models[0]) {
      void vscode.window.showErrorMessage(
        vscode.l10n.t(
          'No chat model is available: install and sign in to a chat model provider (for example GitHub Copilot), then try again. The AI pre-review is not broken — this feature cannot run without one.',
        ),
      );
      return undefined;
    }
    return models.filter((model): model is vscode.LanguageModelChat => Boolean(model));
  } catch (error) {
    logger.error(`AI pre-review could not list chat models: ${userFacingErrorMessage(error)}`);
    void vscode.window.showErrorMessage(
      vscode.l10n.t('No chat model is available. The AI pre-review was not started; nothing was created.'),
    );
    return undefined;
  }
}

/**
 * Narrows the offered models to the ones whose input budget can hold the fixed
 * instructions, largest budget first (§7.2).
 *
 * The old shape of this choice — take `models[0]` — is what made the feature
 * unusable on a machine whose first offered model was smaller than the
 * instruction prompt: the run then failed the budget guard before it had read
 * anything. Measuring each candidate with its own `countTokens` is the honest
 * version, because the same text costs different token counts per tokenizer.
 *
 * A model whose tokenizer throws is skipped rather than assumed to fit. The
 * returned `budget` names what the editor offered, which is what the failure
 * message has to tell the user when literally nothing fits.
 */
export async function affordableAiPreReviewModels(
  models: readonly vscode.LanguageModelChat[],
  instructions: string,
): Promise<{ candidates: AiPreReviewModelCandidate[]; budget: AiPreReviewModelBudget }> {
  const budget: AiPreReviewModelBudget = {
    offered: models.length,
    largestMaxInputTokens: models.reduce((largest, model) => Math.max(largest, maxInputTokensOf(model)), 0),
  };
  const candidates: AiPreReviewModelCandidate[] = [];
  for (const model of models) {
    let instructionTokens: number;
    try {
      instructionTokens = await countTokens(model, instructions);
    } catch (error) {
      logger.debug(
        `AI pre-review: could not count the instructions for ${modelLabel(model)} (${userFacingErrorMessage(error)}), so it is not considered`,
      );
      continue;
    }
    if (instructionTokens < maxInputTokensOf(model)) {
      candidates.push({ model, instructionTokens });
    }
  }
  // Descending budget, and `sort` is stable, so equal budgets keep the editor's
  // own order. No other ranking here: the smallest sufficient model is not
  // better or worse by budget alone, and the user's own picker order is not ours
  // to second-guess. `orderAiPreReviewCandidates` later puts the models whose
  // answers satisfied the contract earlier in this window in front of this
  // order, and that is the only preference this feature applies (§7.2).
  candidates.sort((a, b) => maxInputTokensOf(b.model) - maxInputTokensOf(a.model));
  if (candidates.length === 0) {
    logger.error(
      `AI pre-review: the instruction prompt needs more input tokens than any of the ${budget.offered} offered chat model(s); the largest maxInputTokens is ${budget.largestMaxInputTokens}`,
    );
  }
  return { candidates, budget };
}

/**
 * The model the **first** attempt of one run uses (§7.2).
 *
 * The candidates arrive in the caller's attempt order — remembered models
 * first, then by descending budget — so the first one that can hold the whole
 * request is the most plausible such model: a run prefers a model it can hand
 * the entire brief to, because a model shown part of the diff is answering a
 * different question and its contract history may not transfer to it.
 *
 * When no candidate can take the request whole, the fallback is the candidate
 * with the **largest** budget rather than the first one in the list: with the
 * preference ordering in place the first candidate may be a remembered model
 * with a small budget, and the run's best remaining chance is the model with
 * the most room, which then drops whole files from the brief until it fits.
 * `fitsRequest` says which of the two happened, so the caller can log the
 * fallback instead of hiding it.
 *
 * The caller guarantees a non-empty list: it stops the run when no offered model
 * can hold the instructions at all.
 */
export async function selectAiPreReviewModel(
  candidates: readonly AiPreReviewModelCandidate[],
  userPrompt: string,
): Promise<{ candidate: AiPreReviewModelCandidate; fitsRequest: boolean }> {
  for (const candidate of candidates) {
    let total: number;
    try {
      total = candidate.instructionTokens + (await countTokens(candidate.model, userPrompt));
    } catch (error) {
      logger.debug(
        `AI pre-review: could not count the request for ${modelLabel(candidate.model)} (${userFacingErrorMessage(error)}), so it is not considered`,
      );
      continue;
    }
    if (total <= maxInputTokensOf(candidate.model)) {
      return { candidate, fitsRequest: true };
    }
  }
  const mostRoom = candidates.reduce((best, candidate) =>
    maxInputTokensOf(candidate.model) > maxInputTokensOf(best.model) ? candidate : best,
  );
  return { candidate: mostRoom, fitsRequest: false };
}

/**
 * `maxInputTokens` as a number this module can compare against.
 *
 * The API declares it as a number, but a provider hands the extension host
 * whatever it likes, and a `NaN`/`undefined`/negative budget would make every
 * comparison false — which would silently turn into "does not fit" rather than
 * "unknown". Treating it as 0 keeps that direction, and the failure message then
 * reports the 0 it actually saw.
 */
function maxInputTokensOf(model: vscode.LanguageModelChat): number {
  const budget = model?.maxInputTokens;
  return typeof budget === 'number' && Number.isFinite(budget) && budget > 0 ? budget : 0;
}

/** One existing comment's metadata — never its body (§7.1, §13.5). */
function reviewCommentSide(comment: { position?: number; original_position?: number }): 'new' | 'old' | undefined {
  if (typeof comment.position === 'number' && comment.position > 0) {
    return 'new';
  }
  if (typeof comment.original_position === 'number' && comment.original_position > 0) {
    return 'old';
  }
  return undefined;
}

/**
 * Reads the review comments for their metadata only. A review whose comments
 * cannot be read contributes its own state and author with no comment rows: the
 * model is told less, never something wrong.
 *
 * This is one request per review, which the client can only do that way (there
 * is no endpoint that lists a pull request's inline comments in one page); the
 * fan-out stays bounded like the interactive controller's own.
 */
async function collectExistingReviewMetadata(
  client: ForgejoClient,
  params: { owner: string; repo: string; index: number },
  reviews: readonly { id?: number; state?: string; user?: { login?: string } }[],
): Promise<AiPreReviewExistingReview[]> {
  const out: AiPreReviewExistingReview[] = [];
  for (const review of reviews) {
    const entry: AiPreReviewExistingReview = { state: review.state, author: review.user?.login, comments: [] };
    if (typeof review.id === 'number') {
      try {
        const comments = await client.getPullReviewComments(params.owner, params.repo, params.index, review.id);
        entry.comments = comments.map((comment) => ({
          path: comment.path,
          line: reviewCommentSide(comment) === 'old' ? comment.original_position : comment.position,
          side: reviewCommentSide(comment),
          author: comment.user?.login,
        }));
      } catch (error) {
        logger.debug(
          `AI pre-review: review ${review.id}'s comments could not be read (${userFacingErrorMessage(error)}); the brief lists the review without them`,
        );
      }
    }
    out.push(entry);
  }
  return out;
}

/**
 * The cancellable half of the run (§6.2): read, assemble, ask — and, when an
 * answer is not the contracted JSON, ask the next candidate (§7.2). It writes
 * nothing, and none of its arms leaves anything behind — the caller reports one
 * message per arm.
 *
 * The attempt order is `orderAiPreReviewCandidates`' (§7.2): models whose
 * answers satisfied the contract earlier in this window first, then descending
 * budget. The **first** attempt still prefers a candidate that can take the
 * whole request (see `selectAiPreReviewModel`); the retry then walks the same
 * order, which is what makes a remembered model the second attempt when a
 * larger model was asked first.
 *
 * The retry happens only for a contract violation — the three cases
 * `parseAiPreReviewResponse` distinguishes. A real model failure (`Blocked`,
 * `NotFound`, …) and a cancellation end the run, because those are not
 * properties of the answer's shape; an answer that parsed but whose anchors were
 * all dropped also ends it, because that is a content outcome for the user to
 * see rather than a reason to spend another model's request. No model is asked
 * twice, and the bound is `AI_PRE_REVIEW_MAX_MODEL_ATTEMPTS`, because a retry
 * that cannot end is a cost the user did not agree to.
 *
 * The cancellation token is checked after every await that can be slow, and it
 * is handed to `sendRequest` so the provider stops the stream itself. A run
 * cancelled here can therefore never reach the confirmation list, let alone the
 * write loop.
 */
async function gatherPreReviewRequest(
  client: ForgejoClient,
  params: ForgejoPrUriParams,
  candidates: readonly AiPreReviewModelCandidate[],
  progress: vscode.Progress<{ message?: string; increment?: number }>,
  token: vscode.CancellationToken,
): Promise<GatheredPreReview> {
  progress.report({ message: vscode.l10n.t('Reading the pull request…') });

  // The diff is fetched whether or not its body may be sent: it is what
  // supplies the per-file line tables every anchor is validated against, so a
  // brief-only run still refuses to guess where a line is.
  const [pullRequest, changedFiles, reviews, diffText] = await Promise.all([
    client.getPullRequest(params.owner, params.repo, params.index),
    client.getPullRequestFiles(params.owner, params.repo, params.index),
    client.listPullReviews(params.owner, params.repo, params.index),
    client.getPullRequestDiff(params.owner, params.repo, params.index),
  ]);

  const existingReviews = await collectExistingReviewMetadata(client, params, reviews);
  if (token.isCancellationRequested) {
    return { kind: 'cancelled' };
  }

  const brief = buildAiPreReviewBrief({
    pullRequest: {
      number: pullRequest.number,
      title: pullRequest.title,
      baseBranch: pullRequest.base?.ref,
      headBranch: pullRequest.head?.ref,
    },
    changedFiles,
    diffText,
    existingReviews,
  });

  const includeDiffBody = isAiPreReviewIncludeDiffEnabled();
  const diffForPrompt = includeDiffBody ? diffText : undefined;
  const promptOptions = diffForPrompt === undefined ? {} : { diffText: diffForPrompt };

  const ordered = orderAiPreReviewCandidates(candidates, preferredAiPreReviewModelKeys());
  const selected = await selectAiPreReviewModel(ordered, buildAiPreReviewUserPrompt(brief, promptOptions));
  if (!selected.fitsRequest) {
    // Not an error yet: the file-granularity drop below may still make it fit.
    // The line exists so a run that had to fall back says so in the log.
    logger.info(
      `AI pre-review: no offered chat model can take the whole request; using ${modelLabel(selected.candidate.model)} and dropping files until it fits`,
    );
  }
  if (token.isCancellationRequested) {
    return { kind: 'cancelled' };
  }

  // The first attempt is the selection above; the rest of the run's attempts
  // follow the same order, with the selected candidate not repeated.
  const attemptOrder = [selected.candidate, ...ordered.filter((candidate) => candidate !== selected.candidate)];
  const failedAttempts: AiPreReviewModelAttempt[] = [];
  const budgetFailures: AiPreReviewBudgetFailure[] = [];
  let requested = 0;

  for (const candidate of attemptOrder) {
    if (requested >= AI_PRE_REVIEW_MAX_MODEL_ATTEMPTS) {
      break;
    }
    const prepared = await preparePrompt(brief, candidate, diffForPrompt);
    if (token.isCancellationRequested) {
      return { kind: 'cancelled' };
    }
    if (prepared.kind === 'budget') {
      // Nothing was sent to this model, so this does not consume an attempt: a
      // later candidate may have more room, and the run's bound is about model
      // calls, not about looking at the offered list.
      budgetFailures.push(prepared.failure);
      continue;
    }

    requested += 1;
    progress.report({ message: vscode.l10n.t('Asking the chat model for review comments…') });
    const answer = await requestPreReviewComments(candidate.model, prepared.userPrompt, token);
    if (answer.kind === 'cancelled') {
      return { kind: 'cancelled' };
    }
    if (answer.kind === 'failed') {
      // A failing model call is not a shape problem, so it does not start a
      // retry: the caller reports the reason it already classified (§9.3).
      return answer;
    }

    const parsed = parseAiPreReviewResponse(answer.text);
    const identity = aiPreReviewModelIdentity(candidate.model);
    if (parsed.kind === 'ok') {
      rememberAiPreReviewContractSatisfyingModel(candidate.model);
      const identityLabel = formatAiPreReviewModelIdentity(identity);
      if (failedAttempts.length > 0) {
        // The line that says a retry happened and which model finally answered:
        // the confirmation list looks the same either way, so the log is where
        // the next diagnosis starts.
        logger.info(
          `AI pre-review: ${failedAttempts.length} earlier chat model(s) did not return the contracted JSON; ${identityLabel} did`,
        );
      }
      logger.debug(
        `AI pre-review: ${identityLabel} answered with the contracted JSON (${parsed.comments.length} proposed comment(s))`,
      );
      return { kind: 'parsed', comments: parsed.comments, brief };
    }

    // One distinct log line per failure kind, each naming the model, plus the
    // bounded shape description at debug level. The answer itself, the prompt
    // and the diff are never logged: the output channel is user-visible and the
    // answer is model output that may quote the repository.
    logger.error(contractFailureLogLine(identity, parsed));
    logger.debug(
      `AI pre-review: ${formatAiPreReviewModelIdentity(identity)} answer shape: ${describeAiPreReviewAnswerShape(answer.text)}`,
    );
    failedAttempts.push({ model: identity, failure: parsed });
  }

  if (failedAttempts.length > 0) {
    return { kind: 'unparsed', attempts: failedAttempts };
  }
  return { kind: 'budget', failure: bestBudgetFailure(budgetFailures) };
}

/**
 * The budget failure a run reports when no candidate could take the request:
 * the one from the candidate with the most room, because "even the largest
 * model needed this much / had this much" is the honest summary and the largest
 * number is the one a remedy has to beat.
 */
function bestBudgetFailure(failures: readonly AiPreReviewBudgetFailure[]): AiPreReviewBudgetFailure {
  if (failures.length === 0) {
    // Unreachable while the attempt bound is positive and the candidate list is
    // non-empty (the caller guarantees the latter). Returning zeroes keeps the
    // failure arm total instead of throwing out of a reporting path.
    return { neededTokens: 0, availableTokens: 0 };
  }
  return failures.reduce((best, failure) =>
    failure.availableTokens > best.availableTokens ||
    (failure.availableTokens === best.availableTokens && failure.neededTokens < best.neededTokens)
      ? failure
      : best,
  );
}

/**
 * Builds the prompt and cuts it to the chosen model's input budget (§7.2).
 *
 * A prompt that does not fit is reduced by **file granularity**: whole files
 * (their line of the changed-file table and, when the diff body is on, their
 * diff block) are dropped from the end until `countTokens` says it fits. The
 * brief's own truncation note then says so, because a model that is shown part
 * of a change must know it is part of a change.
 *
 * Reports `budget` when even the single-file prompt does not fit, with both
 * numbers, so the caller can say what was needed and what was available rather
 * than only that it did not fit. The chosen model is guaranteed to hold the
 * fixed instructions (that is how it was chosen), so this is the only remaining
 * way to miss.
 */
async function preparePrompt(
  brief: AiPreReviewBrief,
  candidate: AiPreReviewModelCandidate,
  diffText: string | undefined,
): Promise<PreparedPrompt> {
  const available = maxInputTokensOf(candidate.model);
  const options = diffText === undefined ? {} : { diffText };
  const needed = async (prompt: string): Promise<number> =>
    candidate.instructionTokens + (await countTokens(candidate.model, prompt));

  let files: AiPreReviewBriefFile[] = brief.files;
  let current = buildAiPreReviewUserPrompt({ ...brief, files, truncatedBy: undefined }, options);
  let total = await needed(current);

  // Dropped from the end. The list order is the server's, not a ranking of
  // importance, so dropping from either end is arbitrary; the end is chosen
  // because it is stable and the note says exactly how many were dropped.
  while (total > available && files.length > 1) {
    files = files.slice(0, files.length - 1);
    current = buildAiPreReviewUserPrompt({ ...brief, files, truncatedBy: 'token-budget' }, options);
    total = await needed(current);
  }
  if (total > available) {
    // Everything left still does not fit: the run reports the budget failure
    // honestly instead of sending an oversized request.
    logger.error(
      `AI pre-review: the shortest prompt for this pull request needs ${total} tokens but the chosen model's input budget is ${available}`,
    );
    return { kind: 'budget', failure: { neededTokens: total, availableTokens: available } };
  }
  return { kind: 'ready', userPrompt: current };
}

async function countTokens(model: vscode.LanguageModelChat, text: string): Promise<number> {
  return await model.countTokens(text);
}

/** What one model call produced. Every arm is reported to the user exactly once. */
type ModelAnswer =
  | { kind: 'text'; text: string }
  | { kind: 'cancelled' }
  | { kind: 'failed'; error: string; reported: boolean };

/**
 * Sends the single request this feature makes (§6.5: one round, no tools, no
 * follow-up) and accumulates the streamed text.
 *
 * Cancellation stops the accumulation and reports "cancelled" — the caller then
 * writes nothing, so a cancelled run cannot leave half a draft behind. The token
 * is handed to `sendRequest` as well, so the provider stops producing rather
 * than this loop only discarding what it already produced. A `LanguageModelError`
 * is classified by its `code` rather than by `instanceof`: the extension host can
 * hand over an object from another realm, and the code names are the documented
 * contract.
 */
async function requestPreReviewComments(
  model: vscode.LanguageModelChat,
  userPrompt: string,
  token?: vscode.CancellationToken,
): Promise<ModelAnswer> {
  const messages: vscode.LanguageModelChatMessage[] = [
    vscode.LanguageModelChatMessage.User(AI_PRE_REVIEW_SYSTEM_PROMPT),
    vscode.LanguageModelChatMessage.User(userPrompt),
  ];
  try {
    const response = await model.sendRequest(
      messages,
      {
        justification: vscode.l10n.t(
          "The AI pre-review sends this pull request's metadata (and, only if you turned it on, the changed lines) to the model to draft line-level review comments for you to confirm.",
        ),
      },
      token,
    );
    if (!response?.text) {
      return { kind: 'failed', error: 'the model returned no response stream', reported: false };
    }
    let text = '';
    for await (const chunk of response.text) {
      if (token?.isCancellationRequested) {
        return { kind: 'cancelled' };
      }
      text += chunk;
    }
    if (token?.isCancellationRequested) {
      return { kind: 'cancelled' };
    }
    return { kind: 'text', text };
  } catch (error) {
    return classifyModelError(error);
  }
}

/** Maps a failed model call to the user-visible arm (§9.3). */
function classifyModelError(error: unknown): ModelAnswer {
  const code = (error as { code?: unknown } | null)?.code;
  const name = (error as { name?: unknown } | null)?.name;
  if (code === 'NoPermissions' || name === 'NoPermissions') {
    // The consent dialog was declined. Deliberately not retried: `sendRequest`
    // may only be called in response to a user action, and the user can simply
    // run the command again.
    logger.info('AI pre-review: the user did not grant permission to use the chat model.');
    void vscode.window.showErrorMessage(
      vscode.l10n.t(
        'Permission to use the chat model was not granted, so no AI pre-review was made. Run the command again if you change your mind; nothing was created.',
      ),
    );
    return { kind: 'failed', error: 'NoPermissions', reported: true };
  }
  if (isCancellation(error)) {
    return { kind: 'cancelled' };
  }
  // Blocked / NotFound / anything else: one log line for diagnosis, one generic
  // error for the user, and never a heuristic substitute for the model.
  return { kind: 'failed', error: userFacingErrorMessage(error), reported: false };
}

function isCancellation(error: unknown): boolean {
  const candidate = error as { name?: unknown; code?: unknown; message?: unknown } | null;
  if (!candidate) {
    return false;
  }
  if (candidate.name === 'AbortError' || candidate.name === 'Canceled' || candidate.name === 'CancellationError') {
    return true;
  }
  if (candidate.code === 'Canceled' || candidate.code === 'CanceledError') {
    return true;
  }
  return typeof candidate.message === 'string' && /cancel/i.test(candidate.message) && candidate.name === 'Error';
}

/**
 * The human confirmation step (§5): one multi-select list, **nothing
 * pre-selected**, no "accept all", and dismissing it means "write nothing".
 *
 * The list is the run's only write gate. It is deliberately a QuickPick rather
 * than anything richer: the record asks for a list a person reads one item at a
 * time, and the preview is capped so the reading is about the comment's
 * location and gist, with the full body visible on the draft afterwards.
 */
async function confirmCandidates(candidates: readonly AiPreReviewCandidate[]): Promise<AiPreReviewCandidate[]> {
  const items: (vscode.QuickPickItem & { candidate: AiPreReviewCandidate })[] = candidates.map((candidate) => ({
    label: formatCandidateLabel(candidate),
    candidate,
    // No `picked` field: nothing is selected by default, so confirming is an
    // act of reading rather than an act of not-unchecking.
    description: undefined,
  }));
  const picked = await vscode.window.showQuickPick(items, {
    canPickMany: true,
    title: vscode.l10n.t('AI pre-review: pick the comments to add as drafts'),
    placeHolder: vscode.l10n.t(
      'Nothing is selected. Only the comments you pick are created, as pending review drafts.',
    ),
    ignoreFocusOut: true,
  });
  return picked?.map((item) => item.candidate) ?? [];
}

/**
 * The result of the write loop, kept as data so the reporting around it is
 * testable and so the failure text can name how many drafts already exist.
 */
interface WriteOutcome {
  written: number;
  /** Set when the run stopped early; `reason` is already user-facing. */
  failure?: { reason: string };
}

/**
 * Writes the confirmed comments as pending-review drafts (§6.4, §4.2).
 *
 * The first comment either reuses the user's existing PENDING review or creates
 * one (`createPendingPullReview`, whose placeholder body the draft carries until
 * the user submits — that is the existing interactive path's behaviour, not
 * something this feature adds); the rest are appended. A failure part-way
 * through stops the run and **keeps** what was already written, because those
 * are real server objects and deleting them would be an irreversible second
 * write.
 *
 * Exported as a pure-ish seam: it takes the pending review id it must act on
 * rather than looking it up, so the append and create branches can be exercised
 * without a VS Code comments controller.
 */
export async function writePreReviewDrafts(
  client: Pick<ForgejoClient, 'createPendingPullReview' | 'addPullReviewComment'>,
  target: { owner: string; repo: string; index: number },
  pendingReviewId: number | undefined,
  confirmed: readonly AiPreReviewCandidate[],
): Promise<WriteOutcome> {
  let reviewId = pendingReviewId;
  let written = 0;
  for (const candidate of confirmed) {
    try {
      const comment = toCreateComment(candidate);
      if (typeof reviewId === 'number') {
        await client.addPullReviewComment(target.owner, target.repo, target.index, reviewId, comment);
        written += 1;
        continue;
      }
      const review = await client.createPendingPullReview(target.owner, target.repo, target.index, comment);
      reviewId = typeof review.id === 'number' ? review.id : undefined;
      written += 1;
      if (reviewId === undefined) {
        // Without the new review's id the remaining comments could not be
        // appended; keeping the one that exists and saying so is the honest
        // outcome (the record's §6.4 "partial failure" row).
        return { written, failure: { reason: 'the server did not return the new review id' } };
      }
    } catch (error) {
      return { written, failure: { reason: userFacingErrorMessage(error) } };
    }
  }
  return { written };
}

/**
 * Looks the pending review up, writes the drafts and reports what happened.
 *
 * The lookup deliberately fails closed: a lookup error means "we do not know
 * whether a draft exists", and starting a second one would violate Forgejo's
 * one-pending-review-per-user rule, so the run stops and says so rather than
 * guessing.
 */
async function writeConfirmedDrafts(
  config: ConfigManager,
  pullReviewCommentController: PullReviewCommentController,
  viewProvider: ForgejoToolkitViewProvider | undefined,
  params: ForgejoPrUriParams,
  confirmed: readonly AiPreReviewCandidate[],
  dropped: readonly AiPreReviewDrop[],
): Promise<void> {
  const instance = config.getInstances().find((candidate) => candidate.id === params.instanceId);
  if (!instance) {
    void vscode.window.showErrorMessage(vscode.l10n.t('Forgejo instance not found'));
    return;
  }
  const client = new ForgejoClient(instance.url, instance.token, logger, instance.syncApiUrlsToInstanceUrl);

  let pendingReviewId: number | undefined;
  try {
    pendingReviewId = await pullReviewCommentController.findPendingReview(params);
  } catch (error) {
    const err = userFacingErrorMessage(error);
    logger.error(`AI pre-review could not look up the existing pending review: ${err}`);
    void vscode.window.showErrorMessage(
      vscode.l10n.t('The AI pre-review could not check for an existing pending review: {0}. Nothing was created.', err),
    );
    return;
  }

  const appendedToExisting = typeof pendingReviewId === 'number';
  if (appendedToExisting) {
    logger.info(`AI pre-review will append to the existing pending review #${pendingReviewId}`);
  }

  const outcome = await writePreReviewDrafts(client, params, pendingReviewId, confirmed);
  if (outcome.failure) {
    logger.error(`AI pre-review failed to write draft comment ${outcome.written + 1}: ${outcome.failure.reason}`);
    reportWriteFailure(outcome.written, outcome.failure.reason);
    await refreshAfterWrites(pullReviewCommentController, viewProvider, params);
    return;
  }

  await refreshAfterWrites(pullReviewCommentController, viewProvider, params);
  const drops = describeDrops(dropped);
  if (appendedToExisting) {
    void vscode.window.showInformationMessage(
      vscode.l10n.t(
        'Added {0} comment(s) to the existing pending review #{1} as drafts. Read them before you submit the review. Dropped: {2}.',
        outcome.written,
        pendingReviewId ?? 0,
        drops,
      ),
    );
  } else {
    void vscode.window.showInformationMessage(
      vscode.l10n.t(
        'Started a pending review with {0} draft comment(s). Review each one, then submit the review yourself. Dropped: {1}.',
        outcome.written,
        drops,
      ),
    );
  }
}

/** One confirmed candidate as the request body Forgejo expects. */
function toCreateComment(candidate: AiPreReviewCandidate): CreatePullReviewComment {
  const comment: CreatePullReviewComment = { body: candidate.body, path: candidate.path };
  if (candidate.side === 'base') {
    comment.old_position = candidate.line;
  } else {
    comment.new_position = candidate.line;
  }
  if (candidate.extraLines > 0) {
    comment.extra_lines_count = candidate.extraLines;
  }
  return comment;
}

function reportWriteFailure(written: number, reason: string): void {
  if (written === 0) {
    void vscode.window.showErrorMessage(
      vscode.l10n.t('No AI pre-review comment could be created: {0}. Nothing was written.', reason),
    );
    return;
  }
  // Deliberately no rollback: the record's §6.4 explains that deleting the
  // drafts already created would be an irreversible second write against
  // comments the user may already have read.
  void vscode.window.showErrorMessage(
    vscode.l10n.t('{0} draft comment(s) were already created and were kept; the rest failed: {1}.', written, reason),
  );
}

/** Re-renders the pull request's review threads so the new drafts appear. */
async function refreshAfterWrites(
  pullReviewCommentController: PullReviewCommentController,
  viewProvider: ForgejoToolkitViewProvider | undefined,
  params: ForgejoPrUriParams,
): Promise<void> {
  viewProvider?.notifyPullRequestReviewSubmitted({
    instanceId: params.instanceId,
    owner: params.owner,
    repo: params.repo,
    index: params.index,
  });
  try {
    await pullReviewCommentController.refreshPullRequestComments(params);
  } catch (error) {
    // The drafts exist; only the refresh failed. Warn without rewriting the
    // outcome the write path just reported.
    const err = userFacingErrorMessage(error);
    logger.error(`AI pre-review could not refresh the review threads: ${err}`);
    void vscode.window.showWarningMessage(
      vscode.l10n.t('The drafts were created, but refreshing the review threads failed: {0}', err),
    );
  }
}

/**
 * The user-facing reason breakdown of a run's drops (§5.4).
 */
function describeDrops(dropped: readonly AiPreReviewDrop[]): string {
  if (dropped.length === 0) {
    return vscode.l10n.t('none');
  }
  return dropped.map((entry) => `${vscode.l10n.t(describeDropReason(entry.reason))} x${entry.count}`).join(', ');
}

/**
 * The catalog key for one drop reason. Every branch returns a literal, which is
 * what the i18n parity test's "every literal key used in the source exists"
 * check reads; a computed key could not be verified statically.
 */
function describeDropReason(reason: AiPreReviewDropReason | 'candidates-dropped'): string {
  switch (reason) {
    case 'comment-limit':
      return 'over the comment cap';
    case 'duplicate-anchor':
      return 'duplicate anchor';
    case 'invalid-body':
      return 'empty body';
    case 'invalid-extra-lines':
      return 'invalid line range';
    case 'invalid-shape':
      return 'malformed entry';
    case 'invalid-side':
      return 'invalid side';
    case 'line-outside-diff':
      return 'line not in the diff';
    case 'missing-path':
      return 'missing path';
    case 'path-not-in-changed-files':
      return 'path not in the changed files';
    case 'unsafe-path':
      return 'unsafe path';
    case 'candidates-dropped':
      return 'over the candidate cap';
  }
}
