import * as vscode from 'vscode';
import { ForgejoClient } from './api/client';
import { ConfigManager } from './config';
import { userFacingErrorMessage } from './api/errors';
import { ForgejoToolkitViewProvider } from './webview/viewProvider';
import { PullReviewCommentController } from './comments/pullReviewCommentController';
import { parseForgejoPrUri, type ForgejoPrUriParams } from './prFileSystemProvider';
import { logger } from './logger';
import {
  AI_PRE_REVIEW_INCLUDE_DIFF_SETTING,
  AI_PRE_REVIEW_MODEL_SETTING,
  AI_PRE_REVIEW_SETTING,
  aiPreReviewModelSettingValue,
  formatAiPreReviewModelSettingValue,
  isAiPreReviewEnabled,
  isAiPreReviewIncludeDiffEnabled,
  matchesAiPreReviewModelSelector,
  parseAiPreReviewModelSelector,
  writeAiPreReviewModelSetting,
} from './aiPreReviewSettings';
import {
  AI_PRE_REVIEW_SYSTEM_PROMPT,
  aiPreReviewPromptText,
  buildAiPreReviewBrief,
  buildAiPreReviewPromptMessages,
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
  type AiPreReviewPromptMessage,
} from './aiPreReviewBrief';
import { createAiPreReviewDiagnostics, type AiPreReviewDiagnostics } from './aiPreReviewDiagnostics';
import {
  aiPreReviewModelIdentity,
  formatAiPreReviewModelIdentity,
  maxInputTokensOf,
  queryAiPreReviewChatModels,
  uniqueAiPreReviewModels,
  type AiPreReviewModelIdentity,
} from './aiPreReviewModels';
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
 * **Which model reviews the pull request is the user's choice, and the choice is
 * the source of truth** (§7.2). The extension never picks a model for the user
 * and never rotates between models: `forgejoToolkit.aiPreReviewModel` names the
 * one model a run uses, and when it is empty the run **asks** with a picker
 * listing every model `vscode.lm.selectChatModels()` offers — then writes the
 * answer into that setting, so the same model is used next time and the user can
 * see and edit the choice in the Settings UI. The command
 * `COMMAND_AI_PRE_REVIEW_CHOOSE_MODEL` changes it later on demand. A dismissed
 * pick cancels the run with nothing sent and nothing created.
 *
 * The only automatic machinery left around the model is **validation**, and it
 * never substitutes: a configured value that names no offered model refuses the
 * run and lists what is offered, and a chosen model that cannot hold the fixed
 * instruction prompt refuses with both numbers. Nothing else may change the
 * model mid-run.
 *
 * The **retry** is bounded and stays on that one model: the probe evidence
 * (§7.2) says a provider's failures are per call rather than per model — one
 * real run failed 3/3 on 5–10 character fragments while the same provider
 * answered other calls, and only 6 of 36 probe calls returned anything at all —
 * so asking the same model the same prompt again is worth up to
 * `AI_PRE_REVIEW_MAX_ATTEMPTS_PER_MODEL` asks. It only ever follows a contract
 * violation: never a real model failure, never a cancellation, and never an
 * answer that parsed but whose anchors were all dropped.
 *
 * The file also owns the feature's **debug-only diagnostics**
 * (`src/aiPreReviewDiagnostics.ts`): with `forgejoToolkit.debug` on, a run
 * writes the exact messages it sent and every raw answer it received to a file
 * under the extension's log directory, and the probe command
 * (`COMMAND_AI_PRE_REVIEW_PROBE`) asks every offered model the same trivial
 * question with each request shape so "our prompt is wrong" and "these models
 * cannot answer at all" can be told apart. Both are off unless debug is on, and
 * neither ever puts prompt or answer text on the Output Channel — the channel
 * keeps its bounded shape line and, in debug mode, the path of the dump.
 */

/**
 * The command id, contributed in `package.json` and public once released.
 */
export const COMMAND_AI_PRE_REVIEW = 'forgejoToolkit.aiPreReviewPullRequest';

/**
 * The command that changes which chat model reviews pull requests: it lists the
 * models VS Code offers, asks which one to use, and writes the answer into
 * `forgejoToolkit.aiPreReviewModel`.
 *
 * It exists because the setting — not a window-scoped memory — is where the
 * choice lives: a user who wants a different model after a run should not have
 * to hand-edit `settings.json`, and a run whose configured model no longer
 * works has to be able to point at a real action rather than only at a setting
 * key. It is contributed as an ordinary command, so it is reachable from the
 * palette whether or not the feature switch is on (choosing is configuration,
 * and it sends nothing).
 */
export const COMMAND_AI_PRE_REVIEW_CHOOSE_MODEL = 'forgejoToolkit.aiPreReviewChooseModel';

/**
 * The debug-only probe command id, contributed in `package.json` behind a
 * `config.forgejoToolkit.debug` gate. It is a diagnostic, not a feature: it
 * sends no pull request content, and it exists because a machine where every
 * offered model answers the same degenerate fragment cannot be diagnosed from
 * the feature's own run alone.
 */
export const COMMAND_AI_PRE_REVIEW_PROBE = 'forgejoToolkit.aiPreReviewProbeChatModels';

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
 * Registers the feature's three commands: the run itself, the model chooser,
 * and the debug-only probe. All are kept in this module rather than inline in
 * `src/commands/index.ts` because the handlers own whole flows (fetch, model,
 * confirm, write) and that file has to stay readable.
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
      runAiPreReview(config, viewProvider, pullReviewCommentController, target.params, context).catch(
        (error: unknown) => {
          const err = userFacingErrorMessage(error);
          logger.error(`[aiPreReview] ${err}`);
        },
      );
    }),
    vscode.commands.registerCommand(COMMAND_AI_PRE_REVIEW_CHOOSE_MODEL, () => {
      chooseAiPreReviewModel().catch((error: unknown) => {
        const err = userFacingErrorMessage(error);
        logger.error(`[aiPreReview] choosing a chat model failed: ${err}`);
      });
    }),
    vscode.commands.registerCommand(COMMAND_AI_PRE_REVIEW_PROBE, () => {
      probeAiPreReviewChatModels(context).catch((error: unknown) => {
        const err = userFacingErrorMessage(error);
        logger.error(`[aiPreReview] probe failed: ${err}`);
      });
    }),
  );
}

/**
 * The chat model one run uses — the model the user chose — with the fixed
 * instruction prompt already measured in that model's own tokenizer (§7.2).
 * The measurement travels with the model because every later comparison for
 * this run compares against the same number.
 *
 * A run has exactly one of these. There is no list to rank and no second model
 * to move to: ranking candidates is choosing for the user, and choosing for the
 * user is what the maintainer rejected.
 */
export interface AiPreReviewChosenModel {
  model: vscode.LanguageModelChat;
  /** Tokens the fixed instruction prompt costs this model. */
  instructionTokens: number;
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
 * How many times one run may ask its **one** chosen model (§7.2). This is the
 * whole of the run's call bound: one model, asked at most twice, so at most
 * **2 model calls per run**.
 *
 * Why a second ask of the same model is the only retry the evidence supports. A
 * diagnostic probe on the maintainer's machine (12 offered chat models × 3
 * request shapes = 36 calls, dumped by `COMMAND_AI_PRE_REVIEW_PROBE`) found that
 * **shape is not the variable**: the old two-message shape and the new
 * one-message shape each succeeded on some models and failed on others. A
 * follow-up real run then failed 3/3 with fragments of 5–10 characters, while
 * other runs against the same provider answered — the provider (one `deepseek`
 * vendor here) returns an empty stream roughly two calls in three and a fragment
 * otherwise, independently of what is sent, and only 6 of the 36 probe calls
 * returned anything at all (each a bare `{}`, itself a contract violation). The
 * failures are therefore **per call, not per model**: the same model that fails
 * one call can answer the next.
 *
 * That evidence is also why the retry does **not** move to another model: the
 * maintainer's requirement is that the extension never picks a model for the
 * user, so the answer to a flaky provider is one bounded repeat of the model the
 * user chose, never a rotation the user did not ask for. Two is the smallest
 * number that makes "flaky" different from "cannot": one retry doubles a call's
 * chance of landing on a good sample, and anything more spends the user's quota
 * on a model that has already failed twice.
 *
 * The record's §6.5 still holds: every attempt is the same single question to
 * the same model — one round, no tools, no follow-up, no conversation.
 */
export const AI_PRE_REVIEW_MAX_ATTEMPTS_PER_MODEL = 2;

/**
 * How a model is read, named, keyed and listed lives in
 * `src/aiPreReviewModels.ts`: the Settings page's chooser needs exactly the same
 * answer and can reach that module without the cycle this one would create (this
 * module imports the view provider).
 */

/** One identity as a log line, a picker title or a failure message names it. */
function modelLabel(model: vscode.LanguageModelChat): string {
  return formatAiPreReviewModelIdentity(aiPreReviewModelIdentity(model));
}

/**
 * The model the configured value names, or `undefined` when the value is not an
 * accepted form or names none of the offered models.
 *
 * This is the whole of the "automatic" handling that is left: the setting is an
 * instruction, and either an offered model satisfies it or the run refuses. No
 * candidate is substituted, no other model is tried, and the caller reports the
 * refusal with the offered list so the user can correct the value.
 */
export function findOfferedAiPreReviewModel(
  configured: string,
  offered: readonly vscode.LanguageModelChat[],
): vscode.LanguageModelChat | undefined {
  const selector = parseAiPreReviewModelSelector(configured);
  if (selector === undefined) {
    return undefined;
  }
  return offered.find((model) => matchesAiPreReviewModelSelector(selector, model));
}

/**
 * One **failed** attempt of the run's chosen model against the contract, kept so
 * the failure report can say how many times that model was asked and how each
 * answer fell short (§7.2).
 *
 * One entry per model call that ended in a contract violation, so the chosen
 * model that failed both of its attempts has two entries — `attempt` is what
 * tells them apart, and it is the number the message renders as "attempt 1 of 2".
 * The model identity is carried on every entry even though one run has one
 * model, because the report has to name the thing that failed without the caller
 * holding a second reference to it.
 */
export interface AiPreReviewModelAttempt {
  /** The model as the API exposes it. */
  model: AiPreReviewModelIdentity;
  /** Which ask of that model this was, counting from 1. */
  attempt: number;
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
  /** Every attempt the run made failed the contract; `attempts` lists them. */
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
 *
 * `host` is only read for `logUri`: with `forgejoToolkit.debug` on, the run
 * appends what it sent and what came back to the diagnostics dump there. The
 * parameter is optional so the tests (and any future caller) can run the flow
 * without an `ExtensionContext`; without it the dump is simply off.
 */
export async function runAiPreReview(
  config: ConfigManager,
  viewProvider: ForgejoToolkitViewProvider | undefined,
  pullReviewCommentController: PullReviewCommentController,
  params: ForgejoPrUriParams,
  host?: { logUri?: vscode.Uri },
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

    // Which model reviews this pull request is settled **before** anything is
    // read: the setting if it names one, otherwise the user's answer to the
    // picker. No HTTP request and no model call can happen on a path that
    // returns from this block, which is what makes "a dismissed pick creates
    // nothing" true by construction rather than by remembering to check.
    const listed = await listAiPreReviewModels();
    if (!listed) {
      return;
    }
    const offered = uniqueAiPreReviewModels(listed);
    if (offered.length === 0) {
      reportNoChatModel();
      return;
    }

    const configured = aiPreReviewModelSettingValue();
    let chosen: vscode.LanguageModelChat;
    if (configured === '') {
      // Nothing configured: the run has to ask. The picker lists every model the
      // editor offers — not only the ones some heuristic would have approved —
      // and its answer is written into the setting, so this question is asked
      // once per choice rather than once per run.
      const picked = await pickAiPreReviewModel(offered);
      if (!picked) {
        reportModelChoiceDismissed();
        return;
      }
      chosen = picked;
      await rememberChosenAiPreReviewModel(picked);
    } else {
      // A configured value that is not one of the accepted forms, or that names
      // none of the offered models, refuses the run instead of being silently
      // ignored or replaced: the whole point of the setting is that the choice
      // is the user's, and a silent substitution would send the brief to a
      // provider the user did not name.
      const match = findOfferedAiPreReviewModel(configured, offered);
      if (!match) {
        reportAiPreReviewModelRefusal({ configured, offered: describeOfferedAiPreReviewModels(offered) });
        return;
      }
      chosen = match;
      logger.info(
        `AI pre-review: model choice: the setting "${AI_PRE_REVIEW_MODEL_SETTING}" = "${configured}" names ${modelLabel(chosen)}; no pick was shown`,
      );
    }

    // Validation, and only validation: the fixed instruction prompt is a
    // constant, so whether the chosen model can hold it is answered before the
    // first request goes out — and a model that cannot hold it refuses the run
    // rather than being swapped for a larger one.
    const chosenModel = await validateChosenAiPreReviewModel(chosen);
    if (!chosenModel) {
      return;
    }

    const diagnostics = await createRunDiagnostics(host, params, offered, chosenModel, configured);

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
      (progress, token) => gatherPreReviewRequest(client, params, chosenModel, progress, token, diagnostics),
    );

    if (gathered.kind === 'cancelled') {
      reportCancelled();
      return;
    }
    if (gathered.kind === 'budget') {
      reportRequestBudgetFailure(gathered.failure, chosenModel.model);
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
 * The diagnostics sink for one run, plus the section header that says what the
 * run is looking at.
 *
 * This is the only place the dump is turned on, and it is turned on by exactly
 * one thing: `forgejoToolkit.debug` (through `logger.isDebugEnabled()`, the gate
 * `Logger.debug` itself uses). With debug off the sink has no file path, so
 * "off" is enforced by construction — there is nowhere for a later call to
 * write even by mistake — and the Output Channel gets nothing but the run's own
 * lines. With debug on the channel gets one extra line naming the file, never
 * its content.
 *
 * The header carries the facts a reader would otherwise have to reconstruct
 * from a bug report: which pull request, which switches were on, which model the
 * run is using and where that choice came from, which models the editor offered
 * with their input budgets, and the shape of the request. The answer never
 * appears here — only in the per-attempt blocks below.
 */
async function createRunDiagnostics(
  host: { logUri?: vscode.Uri } | undefined,
  params: ForgejoPrUriParams,
  models: readonly vscode.LanguageModelChat[],
  candidate: AiPreReviewChosenModel,
  configured: string,
): Promise<AiPreReviewDiagnostics> {
  const diagnostics = createAiPreReviewDiagnostics({
    directory: host?.logUri?.fsPath,
    enabled: logger.isDebugEnabled(),
    onError: (message) => logger.error(message),
  });
  if (!diagnostics.filePath) {
    return diagnostics;
  }
  logger.info(
    `AI pre-review diagnostics ("forgejoToolkit.debug" is on): the prompts sent and the raw answers received are written to ${diagnostics.filePath}`,
  );
  const origin =
    configured === ''
      ? 'the model the user picked just now (written into the setting)'
      : `the setting "${AI_PRE_REVIEW_MODEL_SETTING}" = "${configured}"`;
  await diagnostics.section({
    kind: 'run',
    startedAt: new Date(),
    facts: [
      `target: ${runKey(params)}`,
      `settings: ${AI_PRE_REVIEW_SETTING}=true, ${AI_PRE_REVIEW_INCLUDE_DIFF_SETTING}=${isAiPreReviewIncludeDiffEnabled()}, ${AI_PRE_REVIEW_MODEL_SETTING}="${configured}"`,
      `chat models offered by vscode.lm.selectChatModels(): ${models.length}`,
      ...models.map(
        (model, index) => `  model ${index + 1}: ${modelLabel(model)} maxInputTokens=${maxInputTokensOf(model)}`,
      ),
      `model used by this run: ${modelLabel(candidate.model)} maxInputTokens=${maxInputTokensOf(candidate.model)}, its tokenizer charges ${candidate.instructionTokens} token(s) for the fixed instructions; chosen from ${origin}`,
      `attempt bound: at most ${AI_PRE_REVIEW_MAX_ATTEMPTS_PER_MODEL} model call(s) per run — one chosen model, asked again only after a contract violation; no other model is ever called`,
      'request shape: one User message carrying the fixed instructions and then the request (this API has no system role)',
    ],
  });
  return diagnostics;
}

/**
 * One trivial instruction shape the probe sends, so the dump can be read as a
 * comparison rather than as a loose pile of answers.
 */
export interface AiPreReviewProbeShape {
  /** Short label naming the shape in the dump. */
  label: string;
  /** The messages this shape sends, in order. */
  messages: readonly AiPreReviewPromptMessage[];
}

/**
 * The trivial question every probe sends. It asks for a two-character answer
 * that is derivable from the instruction alone, so a normal answer and a
 * degenerate one cannot be confused: any model that can answer at all can answer
 * `{}`.
 *
 * Deliberately content-free — no repository, no pull request, no diff — so a
 * probe run sends nothing that the feature's own switches are there to protect.
 */
export const AI_PRE_REVIEW_PROBE_PROMPT = 'Reply with exactly {} and nothing else.';

/**
 * The shapes the probe asks with, in the order the dump lists them.
 *
 * Three shapes, one question each, because the machines this exists for fail in
 * ways that need telling apart:
 *
 * 1. **one user message, no instructions** — the control. If this does not come
 *    back as `{}`, the models (or the provider in front of them) cannot answer
 *    an extension's request at all, and no wording of ours is at fault.
 * 2. **instructions and request as two `User` messages** — the shape the run
 *    used before this change, and the shape the API guide's own example uses.
 *    If (1) answers and this one does not, a provider is mishandling
 *    multi-message input, and the run's switch to one message is the fix.
 * 3. **instructions and request in one `User` message** — the shape the run uses
 *    now, so the dump holds a direct before/after rather than an inference.
 */
export function aiPreReviewProbeShapes(): AiPreReviewProbeShape[] {
  return [
    {
      label: 'control: one user message, no instructions',
      messages: [{ role: 'user', text: AI_PRE_REVIEW_PROBE_PROMPT }],
    },
    {
      label: 'two user messages: instructions, then the request',
      messages: [
        { role: 'user', text: AI_PRE_REVIEW_SYSTEM_PROMPT },
        { role: 'user', text: AI_PRE_REVIEW_PROBE_PROMPT },
      ],
    },
    {
      label: 'one user message: instructions then the request',
      messages: [{ role: 'user', text: aiPreReviewPromptText(AI_PRE_REVIEW_PROBE_PROMPT) }],
    },
  ];
}

/**
 * The debug-only probe: asks **every** model the editor offers the same trivial
 * question with each shape above, and writes the prompts and the raw answers to
 * the diagnostics dump.
 *
 * This is the second half of the diagnosis the feature could not do on its own.
 * A run tells you that every offered model answered a fragment; it cannot tell
 * you whether those models are unable to answer an extension at all, or whether
 * our request is what they are choking on. A two-character question answers that
 * in one pass, and the dump puts the evidence next to the run's own blocks.
 *
 * Gated twice on purpose, and it sends nothing unless both hold:
 *
 * - `forgejoToolkit.aiPreReview` must be on, because the promise that switch
 *   makes is "with this off, nothing is sent to a model provider" — including
 *   from a diagnostic command.
 * - `forgejoToolkit.debug` must be on, because the point of the probe is the
 *   file it writes, and that file holds prompts and model output.
 *
 * Every offered model is asked, not only the ones a run could use: a model whose
 * input budget cannot hold the feature's instructions is exactly the kind of
 * thing a diagnosis wants to see, and the probe's request is far below any
 * offered budget anyway.
 */
export async function probeAiPreReviewChatModels(host?: { logUri?: vscode.Uri }): Promise<void> {
  if (!isAiPreReviewEnabled()) {
    void vscode.window.showWarningMessage(
      vscode.l10n.t('The AI pre-review is off. Enable the setting "forgejoToolkit.aiPreReview" to use it.'),
    );
    return;
  }
  if (!logger.isDebugEnabled()) {
    void vscode.window.showWarningMessage(
      vscode.l10n.t(
        'The chat model probe runs only while the setting "forgejoToolkit.debug" is on, because it writes the prompts it sends and the raw answers it receives to a diagnostics file. Nothing was sent; enable that setting and run it again.',
      ),
    );
    return;
  }

  const models = await listAiPreReviewModels();
  if (!models) {
    return;
  }

  const diagnostics = createAiPreReviewDiagnostics({
    directory: host?.logUri?.fsPath,
    enabled: true,
    onError: (message) => logger.error(message),
  });
  if (!diagnostics.filePath) {
    // Sending without recording would answer nothing: the probe exists to
    // produce the file. Say so instead of spending the requests.
    void vscode.window.showWarningMessage(
      vscode.l10n.t(
        'The chat model probe found no log directory to write its prompts and answers to, so it sent nothing. This VS Code host does not provide the extension log directory.',
      ),
    );
    return;
  }

  const shapes = aiPreReviewProbeShapes();
  logger.info(`AI pre-review model probe: prompts and raw answers are written to ${diagnostics.filePath}`);
  await diagnostics.section({
    kind: 'probe',
    startedAt: new Date(),
    facts: [
      `chat models offered by vscode.lm.selectChatModels(): ${models.length}`,
      ...models.map(
        (model, index) => `  model ${index + 1}: ${modelLabel(model)} maxInputTokens=${maxInputTokensOf(model)}`,
      ),
      `shapes asked of every model: ${shapes.length}`,
      ...shapes.map((shape, index) => `  shape ${index + 1}: ${shape.label} (${shape.messages.length} message(s))`),
      `question: ${JSON.stringify(AI_PRE_REVIEW_PROBE_PROMPT)}`,
    ],
  });

  let asked = 0;
  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: vscode.l10n.t('Chat model probe'),
      cancellable: true,
    },
    async (progress, token) => {
      for (const model of models) {
        for (const shape of shapes) {
          if (token.isCancellationRequested) {
            return;
          }
          progress.report({ message: vscode.l10n.t('Asking every offered chat model the same trivial question…') });
          const startedAt = new Date();
          const outcome = await sendProbeRequest(model, shape, token);
          await diagnostics.attempt({
            label: `probe "${shape.label}"`,
            model: aiPreReviewModelIdentity(model),
            messages: shape.messages,
            startedAt,
            finishedAt: new Date(),
            answer: outcome.answer,
            outcome: outcome.outcome,
          });
          asked += 1;
          if (outcome.stop) {
            // Consent was declined (or the call was cancelled): asking the same
            // question of the next model would produce the same outcome, so the
            // probe stops with what it has. `classifyModelError` already showed
            // the user the one message that explains it.
            return;
          }
        }
      }
    },
  );

  void vscode.window.showInformationMessage(
    vscode.l10n.t(
      'The chat model probe made {0} model call(s) and wrote the prompts and the raw answers to {1}. Nothing from your repository was sent: the probe sends one trivial sentence and never reads a pull request.',
      asked,
      diagnostics.filePath,
    ),
  );
}

/**
 * One probe call. Never throws: a failing call is an outcome the dump records,
 * because "this model cannot answer" is a result, not an error to abort on. The
 * one exception is `stop`, which says the failure is about consent or
 * cancellation rather than about the model, and so applies to every later call
 * as well.
 */
async function sendProbeRequest(
  model: vscode.LanguageModelChat,
  shape: AiPreReviewProbeShape,
  token?: vscode.CancellationToken,
): Promise<{ answer: string; outcome: string; stop?: boolean }> {
  try {
    const response = await model.sendRequest(
      shape.messages.map((message) => vscode.LanguageModelChatMessage.User(message.text)),
      {
        justification: vscode.l10n.t(
          'The AI pre-review model probe sends one trivial sentence to every chat model VS Code offers and writes their answers to a diagnostics file, to find out whether those models can answer an extension at all.',
        ),
      },
      token,
    );
    if (!response?.text) {
      return { answer: '', outcome: 'the model returned no response stream' };
    }
    let text = '';
    for await (const chunk of response.text) {
      text += chunk;
    }
    if (token?.isCancellationRequested) {
      return { answer: text, outcome: 'cancelled; the answer above may be partial', stop: true };
    }
    return { answer: text, outcome: describeProbeAnswer(text) };
  } catch (error) {
    // Reused from the run so the consent dialog's outcome is reported the same
    // way (and so a declined consent is not re-asked of every later model).
    const classified = classifyModelError(error);
    if (classified.kind === 'cancelled') {
      return { answer: '', outcome: 'cancelled', stop: true };
    }
    const reason = classified.kind === 'failed' ? classified.error : 'unknown failure';
    return { answer: '', outcome: `model call failed: ${reason}`, stop: reason === 'NoPermissions' };
  }
}

/**
 * What the probe makes of one answer: the whole point of the exercise is the
 * first clause, so it is stated as a verdict and followed by the same bounded
 * shape the Output Channel uses — the answer itself is in the dump above it.
 */
function describeProbeAnswer(text: string): string {
  const verdict = text.trim() === '{}' ? 'answered exactly "{}" as asked' : 'did NOT answer the requested "{}"';
  return `${verdict} (${describeAiPreReviewAnswerShape(text)})`;
}

/**
 * The sentence every message whose remedy is "use a different model" ends with:
 * the command that changes the stored choice.
 *
 * It names the command id literally because the API version this extension
 * targets has no way to attach a command to a message button (`MessageItem`
 * carries only a title), so the pointer has to be text. Keeping it in one
 * function keeps that promise — every refusal offers the same way out — in one
 * place, and keeps the literal reachable for the l10n parity test.
 */
function chooseModelActionHint(): string {
  return vscode.l10n.t(
    'To use a different model, run the command "AI Pre-Review: Choose Chat Model" ("forgejoToolkit.aiPreReviewChooseModel").',
  );
}

/**
 * "The model you chose cannot hold the fixed instruction prompt" (§7.2).
 *
 * This is validation, not selection: the run names the chosen model and both
 * numbers, says outright that no other model was substituted, and points at the
 * command that changes the choice. The diff-body switch is named only to say it
 * cannot help, so nobody spends a run finding that out.
 */
function reportInstructionBudgetFailure(chosen: {
  model: AiPreReviewModelIdentity;
  neededTokens: number;
  availableTokens: number;
}): void {
  logger.error(
    `AI pre-review: the chosen chat model ${formatAiPreReviewModelIdentity(chosen.model)} cannot hold the fixed instruction prompt (${chosen.neededTokens} tokens needed, ${chosen.availableTokens} available); nothing was sent and no other model was substituted`,
  );
  void vscode.window.showErrorMessage(
    vscode.l10n.t(
      'The AI pre-review was not started: the chat model you chose, {0}, cannot hold its fixed instruction prompt — {1} tokens are needed and its input budget is {2}. Nothing was sent, nothing was created, and no other model was substituted. {3} (Turning off "forgejoToolkit.aiPreReviewIncludeDiff" shrinks the request but not the instructions, so it cannot help here.)',
      formatAiPreReviewModelIdentity(chosen.model),
      chosen.neededTokens,
      chosen.availableTokens,
      chooseModelActionHint(),
    ),
  );
}

/**
 * "The chosen model's tokenizer would not measure the instructions" (§7.2).
 *
 * The measurement failing is not the same as the prompt not fitting, so it gets
 * its own sentence: guessing here would either refuse a usable model or send an
 * oversized request, and both are worse than asking the user to choose again.
 */
function reportChosenModelNotMeasurable(model: AiPreReviewModelIdentity): void {
  logger.error(
    `AI pre-review: ${formatAiPreReviewModelIdentity(model)} would not measure the fixed instruction prompt with countTokens, so the run was not started`,
  );
  void vscode.window.showErrorMessage(
    vscode.l10n.t(
      'The AI pre-review was not started: the chat model you chose, {0}, would not measure its fixed instruction prompt, so the run could not check that the prompt fits. Nothing was sent and nothing was created, and no other model was substituted. {1}',
      formatAiPreReviewModelIdentity(model),
      chooseModelActionHint(),
    ),
  );
}

/**
 * "The request does not fit the model the user chose" (§7.2). Reports both
 * numbers and the model by name, then the two remedies that shrink the request
 * or change the model — never a third one that swaps the model behind the user's
 * back.
 */
function reportRequestBudgetFailure(failure: AiPreReviewBudgetFailure, model: vscode.LanguageModelChat): void {
  logger.error(
    `AI pre-review: the shortest prompt for this pull request needs ${failure.neededTokens} tokens but the chosen model ${modelLabel(model)} has an input budget of ${failure.availableTokens}; nothing was sent`,
  );
  void vscode.window.showErrorMessage(
    vscode.l10n.t(
      'The AI pre-review could not fit this pull request into the input budget of the chat model you chose, {0} ({1} tokens needed, {2} available). Nothing was sent and nothing was created, and no other model was substituted. Turn off the setting "forgejoToolkit.aiPreReviewIncludeDiff" to send a smaller request, or use a model with a larger input budget. {3}',
      modelLabel(model),
      failure.neededTokens,
      failure.availableTokens,
      chooseModelActionHint(),
    ),
  );
}

/**
 * "Every attempt the run could make answered something that is not the
 * contracted JSON object" (§6.4's parse row, §7.2's bound).
 *
 * The message names the one model, how many times it was asked and how each of
 * its answers fell short, because the three contract failures mean different
 * things — an empty answer and a prose answer are different problems, and a JSON
 * answer missing `comments` is a third — and because a user who sees the model
 * and the attempt count can tell how much of their quota the run spent. The
 * bound is stated as the one number it now is: {2} attempts of the chosen model.
 * There is deliberately no "try again" — the retry the extension could do has
 * already happened — but there is the command that changes the model, because
 * that is the user's decision to make. Nothing about the answers themselves is
 * quoted here — only the bounded shape description goes to the log, at debug
 * level.
 */
function reportContractFailures(attempts: readonly AiPreReviewModelAttempt[]): void {
  const tried = describeFailedAttempts(attempts);
  const model = attempts[0]?.model;
  const label = model ? formatAiPreReviewModelIdentity(model) : 'the chosen chat model';
  logger.error(
    `AI pre-review: ${label} did not return the contracted JSON on any of its ${attempts.length} attempt(s); the bound is ${AI_PRE_REVIEW_MAX_ATTEMPTS_PER_MODEL} attempt(s) of the one chosen model, and no other model was called`,
  );
  void vscode.window.showErrorMessage(
    vscode.l10n.t(
      'The AI pre-review asked the chat model you chose, {0}, the same question {1} time(s) — its bound is {2} attempt(s) per run, and no other model was called — and none of the answers was the JSON it needs, so no comments were created. Tried: {3}. Nothing was created; you can review the pull request by hand. {4}',
      label,
      attempts.length,
      AI_PRE_REVIEW_MAX_ATTEMPTS_PER_MODEL,
      tried,
      chooseModelActionHint(),
    ),
  );
}

/**
 * The failed attempts of the run's one model as one sentence: a single failure
 * stays as short as it was before the retry existed (`the answer was empty`),
 * and only a run that spent both of its attempts gets the labels, so the common
 * one-attempt message does not grow.
 *
 * The model is deliberately not repeated here — the message around this clause
 * already names it — and neither is any other model, because no other model can
 * appear in one of these attempts.
 */
function describeFailedAttempts(attempts: readonly AiPreReviewModelAttempt[]): string {
  const only = attempts[0];
  if (attempts.length === 1 && only) {
    return describeContractFailure(only.failure);
  }
  return attempts
    .map(
      (attempt) =>
        `attempt ${attempt.attempt} of ${AI_PRE_REVIEW_MAX_ATTEMPTS_PER_MODEL}: ${describeContractFailure(attempt.failure)}`,
    )
    .join('; ');
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
 * The same three failures in plain English, for the debug dump.
 *
 * Deliberately not `describeContractFailure`: that one goes through `l10n.t`
 * because a user reads it, while the dump is a diagnostic artifact handed to a
 * maintainer, and a translated line there would be harder to match against the
 * three cases the code distinguishes. Plain text, like every other log line.
 */
function describeContractFailurePlainly(failure: AiPreReviewContractFailure): string {
  switch (failure.kind) {
    case 'empty':
      return 'the answer was empty';
    case 'not-json':
      return 'the answer is not JSON';
    case 'wrong-shape':
      return failure.field === 'root'
        ? 'the JSON top level is not an object'
        : 'the JSON "comments" field is missing or not an array';
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
 * Every chat model the editor offers, or `undefined` after reporting a genuine
 * failure — an editor without the API at all, or a listing that threw. An
 * **empty** list is returned as an empty array: "the editor offers nothing" is a
 * different outcome from "the listing failed", and the caller has to tell them
 * apart to report the right thing (§9.2, §9.3).
 *
 * Only this caller reports with a dialog; the listing itself is
 * `queryAiPreReviewChatModels`, shared with the Settings page's chooser, which
 * answers with a line of text instead of a toast because the user is already
 * looking at the panel.
 *
 * There is deliberately no fallback layer that substitutes heuristics: without a
 * model this feature does not exist, and pretending otherwise would produce
 * review comments attributed to a machine that never read anything.
 */
async function listAiPreReviewModels(): Promise<vscode.LanguageModelChat[] | undefined> {
  const query = await queryAiPreReviewChatModels();
  if (query.status === 'no-api') {
    logger.info('This editor provides no language model API; the AI pre-review cannot run.');
    void vscode.window.showErrorMessage(
      vscode.l10n.t(
        'This VS Code build has no language model API, so the AI pre-review cannot run. Everything else keeps working.',
      ),
    );
    return undefined;
  }
  if (query.status === 'failed') {
    logger.error(`AI pre-review could not list chat models: ${userFacingErrorMessage(query.error)}`);
    void vscode.window.showErrorMessage(
      vscode.l10n.t('No chat model is available. The AI pre-review was not started; nothing was created.'),
    );
    return undefined;
  }
  return query.models;
}

/** "The editor offers no chat model at all" (§9.3). */
function reportNoChatModel(): void {
  logger.error('AI pre-review: vscode.lm.selectChatModels() returned no chat model.');
  void vscode.window.showErrorMessage(
    vscode.l10n.t(
      'No chat model is available: install and sign in to a chat model provider (for example GitHub Copilot), then try again. The AI pre-review is not broken — this feature cannot run without one.',
    ),
  );
}

/**
 * The offered models, each as one line of a message: display name, the
 * `vendor/family` a user can type into the setting, the `id` when it differs,
 * and the model's own `maxInputTokens`.
 *
 * `name` is what the editor shows in its picker, `vendor/family` is what this
 * setting accepts, and `maxInputTokens` is what decides whether a run can be
 * afforded at all — the three facts someone reading a refusal needs in order to
 * correct the setting. Not localized: it is a data list, and the sentence
 * around it carries the translation.
 */
export function describeOfferedAiPreReviewModels(models: readonly vscode.LanguageModelChat[]): string {
  return models
    .map((model) => {
      const identity = aiPreReviewModelIdentity(model);
      const vendorFamily = `${identity.vendor || 'unknown'}/${identity.family || 'unknown'}`;
      const id = identity.id.trim() !== '' && identity.id !== identity.family ? `, id=${identity.id}` : '';
      return `${identity.name || identity.id || 'unknown model'} (${vendorFamily}${id}, maxInputTokens=${maxInputTokensOf(model)})`;
    })
    .join('; ');
}

/** The refused run's two facts: what was asked for, and what is on offer. */
export interface AiPreReviewModelRefusal {
  /** The configured value exactly as the user typed it. */
  configured: string;
  /** Every model VS Code offered, described by `describeOfferedAiPreReviewModels`. */
  offered: string;
}

/**
 * The refusal for a setting that names a model the run cannot use: a value that
 * is not an accepted form at all, or one that matches none of the offered
 * models.
 *
 * The message carries the three things the user needs — the exact configured
 * text, every offered model with the `vendor/family` the setting accepts and the
 * `maxInputTokens` that says whether it can take a request at all, and the
 * command that writes a valid choice for them — because the correction is a
 * setting edit and the extension is the only place that knows what is on offer.
 * It never falls back silently: a value that names nothing refuses the run
 * rather than sending the brief to whichever model happened to be listed first.
 *
 * It is an error, not a warning: the user asked for something and the run did
 * not happen, which is a different outcome from "the feature is off".
 */
export function reportAiPreReviewModelRefusal(refusal: AiPreReviewModelRefusal): void {
  logger.error(
    `AI pre-review: "${AI_PRE_REVIEW_MODEL_SETTING}" is set to "${refusal.configured}", which names no offered chat model; the run was refused before reading anything. Offered: ${refusal.offered}`,
  );
  void vscode.window.showErrorMessage(
    vscode.l10n.t(
      'The AI pre-review was not started: the setting "forgejoToolkit.aiPreReviewModel" is "{0}", which names no chat model VS Code offers. Nothing was sent and nothing was created. Set it to a vendor/family (or vendor/id) form, for example "deepseek/deepseek-flash", or leave it empty and answer the picker the next run shows. {1} The chat models offered here are: {2}',
      refusal.configured,
      chooseModelActionHint(),
      refusal.offered,
    ),
  );
}

/**
 * The sentence a dismissed model pick shows, the same outcome as declining the
 * confirmation list: one message, nothing sent, nothing created (§6.4).
 *
 * It names both ways to answer the question next time — the setting, and the
 * command that writes it — because a dismissed pick is an answer of "not now",
 * and the run deliberately stores nothing for it.
 */
function reportModelChoiceDismissed(): void {
  void vscode.window.showInformationMessage(
    vscode.l10n.t(
      'The AI pre-review did not start: no chat model was chosen, so the setting "forgejoToolkit.aiPreReviewModel" was left unchanged. Nothing was sent and nothing was created. Run the command again to pick one, or set that setting by hand.',
    ),
  );
}

/**
 * The model picker: one item per offered model, naming the model and — because
 * this feature's privacy story is "the user decides what leaves the machine" —
 * naming the provider that would receive the brief, unmistakably and in the
 * item itself.
 *
 * Every fact a chooser needs is on the row: the display name and
 * `vendor/family` in the label (so the same model name from two providers cannot
 * be confused), the model `id` in the description, and the provider plus
 * `maxInputTokens` in the detail. It lists **every** offered model, including
 * ones whose input budget cannot hold the instructions: filtering the list by a
 * guess about affordability would be the extension choosing again, and the
 * placeholder says the choice is stored, so the user knows this is not a
 * throwaway answer.
 *
 * Nothing is pre-selected, `ignoreFocusOut` is on so a click outside the list
 * does not silently answer it, and a dismissed pick is `undefined` — the caller
 * turns that into a cancelled run rather than a default, because "the user did
 * not choose" is not "the extension chooses for them".
 */
async function pickAiPreReviewModel(
  offered: readonly vscode.LanguageModelChat[],
): Promise<vscode.LanguageModelChat | undefined> {
  const items: (vscode.QuickPickItem & { model: vscode.LanguageModelChat })[] = offered.map((model) => {
    const identity = aiPreReviewModelIdentity(model);
    const name = identity.name.trim() !== '' ? identity.name : identity.id || 'unknown model';
    const vendor = identity.vendor || 'unknown';
    const family = identity.family || 'unknown';
    const id = identity.id || 'unknown';
    return {
      label: `${name} — ${vendor}/${family}`,
      description: `id: ${id}`,
      detail: `The brief would be sent to the "${vendor}" provider. maxInputTokens=${maxInputTokensOf(model)}`,
      model,
    };
  });
  const picked = await vscode.window.showQuickPick(items, {
    title: vscode.l10n.t('AI pre-review: which chat model should review this pull request?'),
    placeHolder: vscode.l10n.t(
      'The pull request is sent to the provider named under the model you pick. The choice is written to the setting "forgejoToolkit.aiPreReviewModel", so every later run uses it until you change it.',
    ),
    ignoreFocusOut: true,
  });
  return picked?.model;
}

/**
 * Stores the model the user just picked in `forgejoToolkit.aiPreReviewModel` and
 * says so on the channel.
 *
 * The write is best-effort in exactly one direction: a failure changes where the
 * choice is remembered, never which model reviews this pull request — the run
 * asked the user and uses the answer either way. A value that no accepted form
 * can express (a provider that omits `vendor`, or a family and id that both
 * contain a `/` or an `@`) is reported instead of being stored as something that
 * would not match the same model next time.
 */
async function rememberChosenAiPreReviewModel(model: vscode.LanguageModelChat): Promise<void> {
  const value = formatAiPreReviewModelSettingValue(aiPreReviewModelIdentity(model));
  if (value === undefined) {
    logger.error(
      `AI pre-review: ${modelLabel(model)} has no vendor/family (or vendor/id) form the setting "${AI_PRE_REVIEW_MODEL_SETTING}" can hold, so the choice was not stored; this run still uses it`,
    );
    void vscode.window.showWarningMessage(
      vscode.l10n.t(
        'The AI pre-review will use {0} for this run, but that model has no vendor/family (or vendor/id) form the setting "forgejoToolkit.aiPreReviewModel" can store, so it was not written down and the next run will ask again.',
        modelLabel(model),
      ),
    );
    return;
  }
  try {
    await writeAiPreReviewModelSetting(value);
  } catch (error) {
    logger.error(
      `AI pre-review: the chosen model could not be written to "${AI_PRE_REVIEW_MODEL_SETTING}" (${userFacingErrorMessage(error)}); this run still uses ${modelLabel(model)}`,
    );
    void vscode.window.showWarningMessage(
      vscode.l10n.t(
        'The AI pre-review will use {0} for this run, but writing the choice to the setting "forgejoToolkit.aiPreReviewModel" failed: {1}. Set it by hand to keep the choice.',
        modelLabel(model),
        userFacingErrorMessage(error),
      ),
    );
    return;
  }
  logger.info(
    `AI pre-review: model choice: "${AI_PRE_REVIEW_MODEL_SETTING}" = "${value}" was written for ${modelLabel(model)}, so later runs use it without asking`,
  );
}

/**
 * The command body behind `COMMAND_AI_PRE_REVIEW_CHOOSE_MODEL`: list, ask,
 * store. It sends no request and reads no pull request, so it works with the
 * feature switch off — choosing a model is configuration, not use — and it is
 * the action every refusal message points at.
 *
 * A dismissed pick changes nothing: this command's whole job is the answer, so
 * there is nothing to cancel and nothing to report beyond saying so.
 */
export async function chooseAiPreReviewModel(): Promise<void> {
  const listed = await listAiPreReviewModels();
  if (!listed) {
    return;
  }
  const offered = uniqueAiPreReviewModels(listed);
  if (offered.length === 0) {
    reportNoChatModel();
    return;
  }
  const picked = await pickAiPreReviewModel(offered);
  if (!picked) {
    reportModelChoiceDismissed();
    return;
  }
  await rememberChosenAiPreReviewModel(picked);
  const value = formatAiPreReviewModelSettingValue(aiPreReviewModelIdentity(picked));
  if (value !== undefined) {
    void vscode.window.showInformationMessage(
      vscode.l10n.t(
        'The AI pre-review will use {0}. The setting "forgejoToolkit.aiPreReviewModel" is now "{1}", so every later run uses that model without asking.',
        modelLabel(picked),
        value,
      ),
    );
  }
}

/**
 * The run's **validation** of the model the user chose (§7.2): measure the fixed
 * instruction prompt in that model's own tokenizer and refuse the run when it
 * cannot hold it.
 *
 * This is the only thing left that looks at a model automatically, and it
 * deliberately has only two outcomes: the candidate, or a refusal that names the
 * model and the numbers. It never returns a different model — a model swapped in
 * here would be exactly the automatic selection the maintainer rejected — and a
 * tokenizer that throws is reported as "could not measure" rather than treated
 * as a fit or a miss.
 *
 * The check runs before the first HTTP request, so a refusal here leaves the
 * server untouched.
 */
async function validateChosenAiPreReviewModel(
  model: vscode.LanguageModelChat,
): Promise<AiPreReviewChosenModel | undefined> {
  const identity = aiPreReviewModelIdentity(model);
  const availableTokens = maxInputTokensOf(model);
  let instructionTokens: number;
  try {
    instructionTokens = await countTokens(model, AI_PRE_REVIEW_SYSTEM_PROMPT);
  } catch (error) {
    logger.debug(
      `AI pre-review: could not count the instructions for ${modelLabel(model)} (${userFacingErrorMessage(error)})`,
    );
    reportChosenModelNotMeasurable(identity);
    return undefined;
  }
  if (instructionTokens >= availableTokens) {
    reportInstructionBudgetFailure({ model: identity, neededTokens: instructionTokens, availableTokens });
    return undefined;
  }
  logger.debug(
    `AI pre-review: the fixed instruction prompt costs ${instructionTokens} token(s) for ${modelLabel(model)}, whose input budget is ${availableTokens}`,
  );
  return { model, instructionTokens };
}

/**
 * What one model's tokenizer charges for the request this run would send: the
 * exact text of the single message (`aiPreReviewPromptText`), instructions
 * included.
 *
 * Not the sum of two separate `countTokens` calls, which is how the request used
 * to be measured when it was two messages: the request is one string now, and
 * the number the budget failure reports has to be the number the model is
 * actually handed, or the guidance that message gives is off by whatever the
 * two halves cost together rather than apart.
 */
async function countRequestTokens(model: vscode.LanguageModelChat, userPrompt: string): Promise<number> {
  return await countTokens(model, aiPreReviewPromptText(userPrompt));
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
 * answer is not the contracted JSON, ask that same model again (§7.2). It writes
 * nothing, and none of its arms leaves anything behind — the caller reports one
 * message per arm.
 *
 * The run has **exactly one model** — the one the user chose — so there is no
 * attempt order to decide and no second candidate to move to: the only loop here
 * re-asks that model up to `AI_PRE_REVIEW_MAX_ATTEMPTS_PER_MODEL` times. The
 * prompt is built once, outside the loop, so "the same model, the same prompt"
 * means the same bytes rather than a reconstruction.
 *
 * The retry happens only for a contract violation — the three cases
 * `parseAiPreReviewResponse` distinguishes. A real model failure (`Blocked`,
 * `NotFound`, …) and a cancellation end the run, because those are not
 * properties of the answer's shape; an answer that parsed but whose anchors were
 * all dropped also ends it, because that is a content outcome for the user to
 * see rather than a reason to spend another request. A retry that cannot end
 * would be a cost the user did not agree to.
 *
 * The cancellation token is checked after every await that can be slow, and it
 * is handed to `sendRequest` so the provider stops the stream itself. A run
 * cancelled here can therefore never reach the confirmation list, let alone the
 * write loop.
 *
 * `diagnostics` receives one block per model call — the messages that went out
 * and the whole answer that came back — and is a no-op unless
 * `forgejoToolkit.debug` is on (see `createRunDiagnostics`). It is written
 * *before* each arm returns, so a run that ends at the first attempt still
 * leaves the evidence behind.
 */
async function gatherPreReviewRequest(
  client: ForgejoClient,
  params: ForgejoPrUriParams,
  candidate: AiPreReviewChosenModel,
  progress: vscode.Progress<{ message?: string; increment?: number }>,
  token: vscode.CancellationToken,
  diagnostics: AiPreReviewDiagnostics,
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

  const identity = aiPreReviewModelIdentity(candidate.model);
  const identityLabel = formatAiPreReviewModelIdentity(identity);
  // The prompt is prepared **once** for the whole run: every attempt asks the
  // same model the same question, so the messages have to be the same bytes for
  // "same model, same prompt" to mean what the record says it means.
  const prepared = await preparePrompt(brief, candidate, diffForPrompt);
  if (token.isCancellationRequested) {
    return { kind: 'cancelled' };
  }
  if (prepared.kind === 'budget') {
    // Nothing was sent: this run's one model cannot take even the shortest
    // prompt, and the caller reports both numbers rather than substituting a
    // model the user did not choose.
    return { kind: 'budget', failure: prepared.failure };
  }

  // The messages are built once and handed to both the provider and the dump, so
  // "what the dump shows" is the request itself and not a reconstruction of it
  // that could drift from the real thing. Every attempt hands over this array.
  const messages = buildAiPreReviewPromptMessages(prepared.userPrompt);
  const failedAttempts: AiPreReviewModelAttempt[] = [];
  /** How many model calls the run has spent; bounded by the loop below. */
  let calls = 0;

  // The bound: the same one model, asked at most
  // `AI_PRE_REVIEW_MAX_ATTEMPTS_PER_MODEL` times. A model that answers something
  // other than the contracted JSON is asked again, because the probe evidence
  // says those failures are per call rather than per model (§7.2). Every other
  // outcome returns out of this loop.
  for (let attempt = 1; attempt <= AI_PRE_REVIEW_MAX_ATTEMPTS_PER_MODEL; attempt += 1) {
    calls += 1;
    progress.report({ message: vscode.l10n.t('Asking the chat model for review comments…') });
    const startedAt = new Date();
    const answer = await requestPreReviewComments(candidate.model, messages, token);
    const finishedAt = new Date();
    const recorded = {
      // Both counts are here, because the dump has to be able to tell two asks of
      // the same model apart: which ask of this model it was, and which call of
      // the whole run. The model's identity is the next line of the block, so it
      // is not repeated here.
      label: `attempt ${attempt}/${AI_PRE_REVIEW_MAX_ATTEMPTS_PER_MODEL} for the chosen model (call ${calls} of at most ${AI_PRE_REVIEW_MAX_ATTEMPTS_PER_MODEL} in this run)`,
      model: identity,
      messages,
      startedAt,
      finishedAt,
    };

    if (answer.kind === 'cancelled') {
      await diagnostics.attempt({ ...recorded, answer: '', outcome: 'cancelled; nothing was sent to the server' });
      return { kind: 'cancelled' };
    }
    if (answer.kind === 'failed') {
      await diagnostics.attempt({ ...recorded, answer: '', outcome: `model call failed: ${answer.error}` });
      // A failing model call is not a shape problem, so it does not start a
      // retry — not of this model and, now, not of any other one either: the
      // caller reports the reason it already classified (§9.3).
      return answer;
    }

    const parsed = parseAiPreReviewResponse(answer.text);
    if (parsed.kind === 'ok') {
      await diagnostics.attempt({
        ...recorded,
        answer: answer.text,
        outcome: `the contracted JSON, with ${parsed.comments.length} proposed comment(s)`,
      });
      if (failedAttempts.length > 0) {
        // The line that says a retry happened, which model finally answered, and
        // how many asks that took: the confirmation list looks the same either
        // way, so the log is where the next diagnosis starts.
        logger.info(
          `AI pre-review: ${failedAttempts.length} earlier answer(s) did not return the contracted JSON; ${identityLabel} did, on attempt ${attempt} of ${AI_PRE_REVIEW_MAX_ATTEMPTS_PER_MODEL} for the chosen model (${calls} call(s) spent this run)`,
        );
      }
      logger.debug(
        `AI pre-review: ${identityLabel} answered with the contracted JSON on attempt ${attempt} (${parsed.comments.length} proposed comment(s))`,
      );
      return { kind: 'parsed', comments: parsed.comments, brief };
    }

    // One distinct log line per failure kind, each naming the model and which
    // ask of it this was, plus the bounded shape description at debug level.
    // The answer itself, the prompt and the diff are never logged: the output
    // channel is user-visible and the answer is model output that may quote the
    // repository. The dump (debug only, a file rather than the channel) is where
    // the answer itself goes.
    logger.error(
      `${contractFailureLogLine(identity, parsed)} (attempt ${attempt} of ${AI_PRE_REVIEW_MAX_ATTEMPTS_PER_MODEL} for the chosen model)`,
    );
    const shape = describeAiPreReviewAnswerShape(answer.text);
    logger.debug(`AI pre-review: ${identityLabel} answer shape: ${shape}`);
    await diagnostics.attempt({
      ...recorded,
      answer: answer.text,
      outcome: `contract violation: ${describeContractFailurePlainly(parsed)}`,
      notes: [`answer shape: ${shape}`],
    });
    failedAttempts.push({ model: identity, attempt, failure: parsed });
  }

  return { kind: 'unparsed', attempts: failedAttempts };
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
 * Every measurement is of the exact text the request would carry
 * (`countRequestTokens`), so the number this function compares with
 * `maxInputTokens` is the number the model is handed.
 *
 * Reports `budget` when even the single-file prompt does not fit, with both
 * numbers, so the caller can say what was needed and what was available rather
 * than only that it did not fit. The chosen model is guaranteed to hold the
 * fixed instructions (that is how it was chosen), so this is the only remaining
 * way to miss.
 */
async function preparePrompt(
  brief: AiPreReviewBrief,
  candidate: AiPreReviewChosenModel,
  diffText: string | undefined,
): Promise<PreparedPrompt> {
  const available = maxInputTokensOf(candidate.model);
  const options = diffText === undefined ? {} : { diffText };
  const needed = async (prompt: string): Promise<number> => await countRequestTokens(candidate.model, prompt);

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
 * The messages arrive already built (`buildAiPreReviewPromptMessages`) so the
 * caller can record the very same values in the debug dump: this function maps
 * them to `vscode.LanguageModelChatMessage` and does nothing else with them.
 * Only `User` messages exist in this API version (`LanguageModelChatMessageRole`
 * declares `User` and `Assistant`; `LanguageModelChatMessage` has no `System`
 * factory, and the API guide states that system messages are not supported), so
 * the mapping is total for the shape the builder returns.
 *
 * Cancellation stops the accumulation and reports "cancelled" — the caller then
 * writes nothing, so a cancelled run cannot leave half a draft behind. The token
 * is handed to `sendRequest` as well, so the provider stops producing rather
 * than this loop only discarding what it already produced. A `LanguageModelError`
 * is classified by its `code` rather than by `instanceof`: the extension host can
 * hand over an object from another realm, and the code names are the documented
 * contract.
 *
 * `modelOptions` is deliberately not sent: the API documents it as
 * provider-specific ("need to be looked up in the respective documentation"), so
 * any value here would be a guess about a vendor's option names — which is the
 * same reason the run does not name a vendor to select a model. `justification`
 * is the API's own consent-dialog text and is kept.
 */
async function requestPreReviewComments(
  model: vscode.LanguageModelChat,
  promptMessages: readonly AiPreReviewPromptMessage[],
  token?: vscode.CancellationToken,
): Promise<ModelAnswer> {
  const messages = promptMessages.map((message) => vscode.LanguageModelChatMessage.User(message.text));
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
