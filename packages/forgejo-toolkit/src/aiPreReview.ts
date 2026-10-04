import * as fs from 'fs';
import * as vscode from 'vscode';
import { ForgejoClient } from './api/client';
import { ConfigManager } from './config';
import { userFacingErrorMessage } from './api/errors';
import { ForgejoToolkitViewProvider } from './webview/viewProvider';
import { PullReviewCommentController } from './comments/pullReviewCommentController';
import { parseForgejoPrUri, type ForgejoPrUriParams } from './prFileSystemProvider';
import type { PullRequestTarget } from './webview/repoIdentity';
import { logger } from './logger';
import {
  AI_PRE_REVIEW_MODEL_SETTING,
  AI_PRE_REVIEW_PROMPT_SCOPE_SETTING,
  AI_PRE_REVIEW_SETTING,
  aiPreReviewCommentBodyLanguage,
  aiPreReviewModelSettingValue,
  aiPreReviewPromptScopeSettingValue,
  formatAiPreReviewModelSettingValue,
  isAiPreReviewEnabled,
  matchesAiPreReviewModelSelector,
  parseAiPreReviewModelSelector,
  writeAiPreReviewModelSetting,
  writeAiPreReviewPromptScopeSetting,
  type AiPreReviewPromptScope,
  type AiPreReviewStatedScope,
} from './aiPreReviewSettings';
import {
  AI_PRE_REVIEW_MAX_CONTENT_FILES,
  AI_PRE_REVIEW_SYSTEM_PROMPT,
  aiPreReviewAnswerExcerpt,
  aiPreReviewBodyLanguageName,
  aiPreReviewPromptText,
  buildAiPreReviewBrief,
  buildAiPreReviewFileContents,
  buildAiPreReviewPromptMessages,
  buildAiPreReviewSystemPrompt,
  buildAiPreReviewUserPrompt,
  describeAiPreReviewAnswerShape,
  parseAiPreReviewResponse,
  validatePreReviewComments,
  type AiPreReviewBrief,
  type AiPreReviewBriefFile,
  type AiPreReviewCandidate,
  type AiPreReviewContractFailure,
  type AiPreReviewDiffBodyMode,
  type AiPreReviewDrop,
  type AiPreReviewDropReason,
  type AiPreReviewExistingReview,
  type AiPreReviewFileContents,
  type AiPreReviewPromptMessage,
} from './aiPreReviewBrief';
import { AiPreReviewPanel } from './aiPreReviewPanel';
import {
  aiPreReviewDiagnosticsFilePath,
  createAiPreReviewDiagnostics,
  type AiPreReviewDiagnostics,
} from './aiPreReviewDiagnostics';
import {
  aiPreReviewModelIdentity,
  formatAiPreReviewModelIdentity,
  maxInputTokensOf,
  type AiPreReviewModelIdentity,
} from './aiPreReviewModels';
import {
  isAsyncIterable,
  readResponseCandidates,
  vscodeLmChatModelOf,
  vscodeLmTransport,
} from './ai/vscodeLmTransport';
import type { AiCompletionRequest, AiCompletionResult, AiModelInfo, AiModelTransport } from './ai/transport';
import type { CreatePullReviewComment } from '@cpf23333-forgejo-toolkit/api';
import type { ForgejoChangedFile, ForgejoPullRequestDetail } from './api/types';

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
 * 2. **nothing leaves the machine unasked.** A window-scoped feature switch
 *    (off by default) and a window-scoped prompt scope whose default is the
 *    **question**, not an answer. With the feature switch off the command refuses
 *    before it reads anything: no model call, no HTTP request, not even a diff
 *    fetch. With the scope at `ask` the run's first act after the model is known
 *    is one modal naming the provider that would receive the content and what
 *    each answer would send; nothing is requested, sent or written before it is
 *    answered, and dismissing it ends the run with nothing sent and nothing
 *    created. The answer is written into the setting (global scope, the same way
 *    the model choice is), so the question is asked once and the choice stays
 *    visible and editable in Settings.
 * 3. **nothing is written unconfirmed.** The confirmation list starts with
 *    nothing selected, an empty selection writes nothing, and the run reports
 *    how many candidates were dropped and why.
 *
 * **Model access goes through one seam.** This module never touches
 * `vscode.lm`'s `sendRequest` or `countTokens`: the run lists models, measures a
 * prompt and runs a request through `AiModelTransport`
 * (`src/ai/transport.ts`), whose one implementation today is the `vscode.lm`
 * transport (`src/ai/vscodeLmTransport.ts`) — the code that used to live here,
 * moved (`docs/design/ai-model-transport.md` §5.1). The seam exists so a second
 * transport (a user-configured OpenAI-compatible endpoint) can be added without
 * touching this feature, and it deliberately carries no fallback between
 * transports: a transport that cannot serve the run reports why, and this module
 * refuses rather than quietly reaching for another one. The one surface that
 * still speaks to `vscode.lm` directly is the debug-only model probe below,
 * because one of its four shapes is a deliberately two-message request the
 * `vscode.lm` transport flattens into one.
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
 * (`COMMAND_AI_PRE_REVIEW_PROBE`) asks **the chosen model** — the one
 * `forgejoToolkit.aiPreReviewModel` names — the same trivial question with each
 * request shape so "our prompt is wrong" and "this model cannot answer at all"
 * can be told apart. One of those shapes is a
 * punctuation-sensitive echo whose literal answer tells a further pair apart: a
 * provider that mangles text in transit returns it with punctuation missing,
 * while a model that cannot follow the instruction answers something else
 * entirely. Both are off unless debug is on, and
 * neither puts prompt text on the Output Channel: the channel keeps its bounded
 * shape line, in debug mode the path of the dump, and — on a contract violation
 * only, never on success — the answer's bounded excerpt. With debug on, the
 * channel additionally gets the answer **fragment by fragment** and then a
 * summary line with the totals and the bounded beginning of the answer
 * (`logAnswerFragments`): the dump holds the concatenation, and only the
 * fragments show where the provider's boundaries fell, which is what tells a
 * corrupt provider apart from a corrupt accumulation. Those lines are
 * `logger.debug`, so they exist only while the debug switch is on and never on a
 * message, a toast or a notification; a stream that was cancelled or aborted
 * logs none of them, because a half-read stream has no honest totals.
 *
 * The same gate opens a second, deeper diagnostic (`logResponseStreamParts`, in
 * `src/ai/vscodeLmTransport.ts`):
 * the **parts** of the response, read from `LanguageModelChatResponse.stream`
 * rather than from its text projection, each logged with its runtime class name
 * and content and closing with a tally of the kinds that arrived. It exists
 * because `text` is documented as the text parts filtered out of `stream`, so a
 * mangled text path beside an intact tool-call part — whose input arrives as a
 * structured object, not as text — is a real fix (use the tool channel) rather
 * than a workaround, and only the parts list can tell the two apart.
 *
 * That diagnostic answered its question on a real machine (2026-10-01, "ninth
 * investigation", `docs/design/ai-prereview.md`), and the answer changed the
 * answer path itself: no tool-call part ever arrived, and `text` turned out **not**
 * to be the text parts' projection at all — it delivered the model's reasoning
 * token stream, while the stream's text parts concatenated to the exact expected
 * answer. The response arrived as RPC-serialised plain objects
 * (`{"$mid":n,"value":…}`).
 *
 * So the answer now comes from the response's **candidate streams**, and **the
 * contract arbitrates**: `readResponseCandidates` consumes `stream` **once** and
 * collects the text parts (`LanguageModelTextPart` instances and the measured RPC
 * text flavour) and the reasoning parts (`LanguageModelThinkingPart` and the
 * measured RPC reasoning flavour) as separate candidates, reading the `text`
 * projection **only** when no candidate stream carried text — a second consumer on
 * one response is the hazard this design removes. `pickResponseCandidate` then
 * tries the text candidate first, the reasoning candidate next, and the `text`
 * projection last, each scored on its own bytes by the caller's own validation
 * (the probe's exact-literal comparison, the run's JSON contract and schema): no
 * concatenation of two candidates, no repair, no guessing and no substitution of
 * another model. The stream that wins, and the reason, is logged at debug
 * (`responseCandidateSelectionLogLine`), and both candidates are recorded in the
 * diagnostics dump, labelled.
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
 * The command that opens the diagnostics dump in the editor
 * (`<logUri>/ai-pre-review-diagnostics.log`).
 *
 * It exists because the failure message now points at the channel for the
 * bounded excerpt and at this command for the full prompt and answer: with
 * `forgejoToolkit.debug` on the dump holds everything a diagnosis needs, and
 * without a way to open it a user would have to be told a filesystem path and
 * find it themselves. It is contributed as an ordinary command and is **not**
 * gated on the feature switch: reading a local diagnostic file sends nothing to
 * anyone, so the privacy argument that gates the run does not apply. When the
 * file is not there yet (debug was never on) it says so and names the setting
 * that creates one, instead of failing or opening nothing.
 */
export const COMMAND_AI_PRE_REVIEW_OPEN_DIAGNOSTICS = 'forgejoToolkit.aiPreReviewOpenDiagnostics';

/**
 * Runs in flight, keyed by `instanceId:owner/repo#index` (§6.2). Module-level
 * and window-scoped, the same single-flight shape
 * `src/commands/index.ts` uses for its publish and create-PR flows, but keyed
 * because two different pull requests may legitimately be reviewed at once.
 */
const runsInFlight = new Set<string>();

function runKey(params: PullRequestTarget): string {
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

/**
 * Same contract as `src/commands/index.ts`'s `sameDocumentUri`, including the
 * query: a diff editor's two sides share scheme and path and differ only in the
 * query (`isBase`/`ref`), so matching on the path alone resolved whichever side
 * `visibleTextEditors` listed first and validated the anchors against the other
 * side's line table.
 */
function sameDocumentUri(a: vscode.Uri, b: unknown): boolean {
  if (!b || typeof b !== 'object') {
    return false;
  }
  const candidate = b as Partial<vscode.Uri>;
  if (typeof candidate.scheme !== 'string' || candidate.scheme !== a.scheme) {
    return false;
  }
  if ((candidate.authority ?? '') !== (a.authority ?? '') || (candidate.query ?? '') !== (a.query ?? '')) {
    return false;
  }
  const path = typeof candidate.path === 'string' ? candidate.path : candidate.fsPath;
  return typeof path === 'string' && (path === a.path || path === a.fsPath);
}

/**
 * Registers the feature's four commands: the run itself, the model chooser, the
 * debug-only probe, and the command that opens the diagnostics dump. All are
 * kept in this module rather than inline in `src/commands/index.ts` because the
 * handlers own whole flows (fetch, model, confirm, write) and that file has to
 * stay readable.
 *
 * It also hands the view provider the run itself
 * (`viewProvider.setAiPreReviewRunner`), which is how the pull request detail
 * page's button reaches the very same flow: the provider owns webview messages
 * and validates what the webview sent, this module owns the flow, and neither has
 * to know more about the other than that one function.
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
      startAiPreReview(config, viewProvider, pullReviewCommentController, target.params, context);
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
    vscode.commands.registerCommand(COMMAND_AI_PRE_REVIEW_OPEN_DIAGNOSTICS, () => {
      openAiPreReviewDiagnostics(context).catch((error: unknown) => {
        const err = userFacingErrorMessage(error);
        logger.error(`[aiPreReview] opening the diagnostics file failed: ${err}`);
      });
    }),
  );

  // The dashboard's pull request detail page reaches the run through the
  // provider, which owns webview messages (see `setAiPreReviewRunner`). The
  // callback is this module's own `startAiPreReview`, so the page and the
  // `editor/title` button share one implementation rather than two flows that
  // agree by accident.
  viewProvider.setAiPreReviewRunner((target) => {
    startAiPreReview(config, viewProvider, pullReviewCommentController, target, context);
  });
}

/**
 * Starts one run from whichever entry point asked for it, and guards against the
 * one thing `runAiPreReview` does not handle itself: a genuinely unexpected
 * error.
 *
 * Both entries go through here — the `forgejoToolkit.aiPreReviewPullRequest`
 * command (which resolves its target from the active `forgejo-pr` diff document)
 * and the pull request detail page's button (whose target the view provider
 * validated from the webview message). The coordinates are all either of them
 * supplies: which pull request to review is the entry point's business, and
 * everything else about the run belongs to `runAiPreReview`.
 *
 * The run is not awaited: it reports its own expected outcomes through a
 * notification or the confirmation panel, and the caller here is a command
 * handler or a message dispatch that must return immediately.
 */
function startAiPreReview(
  config: ConfigManager,
  viewProvider: ForgejoToolkitViewProvider | undefined,
  pullReviewCommentController: PullReviewCommentController,
  target: PullRequestTarget,
  host: { extensionUri: vscode.Uri; logUri?: vscode.Uri },
): void {
  runAiPreReview(config, viewProvider, pullReviewCommentController, target, host).catch((error: unknown) => {
    const err = userFacingErrorMessage(error);
    logger.error(`[aiPreReview] ${err}`);
  });
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
  /** The model as the seam exposes it (`src/ai/transport.ts`). */
  model: AiModelInfo;
  /**
   * Tokens the fixed instruction prompt costs this model, or `undefined` when the
   * transport answered no measurement at all — the seam's "this model has no
   * tokenizer" arm (§4.2), which is not the same thing as a tokenizer that
   * **threw** (that refusal is reported as "could not measure", see
   * `validateChosenAiPreReviewModel`). An absent measurement is not a budget
   * failure: no comparison is made, exactly as no comparison could be made before
   * the seam existed.
   */
  instructionTokens: number | undefined;
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
 * module imports the view provider). The **model calls** themselves go through the
 * seam (`src/ai/transport.ts`), whose one implementation today is `vscode.lm`.
 */

/** One identity as a log line, a picker title or a failure message names it. */
function modelLabel(model: AiModelInfo): string {
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
 *
 * The list is generic over the seam's `AiModelInfo`, so the run (which holds seam
 * models) and the debug probe (which still holds the editor's own chat models)
 * both get their own type back without a cast. The selector's optional
 * `@version` part is read off whatever the entry carries: `vscode.lm` models have
 * a `version` at runtime and are still matched by it, while a seam model that
 * carries none can never satisfy a version constraint — which is why the setting
 * prefers `vendor/family` and `vendor/id`.
 */
export function findOfferedAiPreReviewModel<T extends AiModelInfo>(
  configured: string,
  offered: readonly T[],
): T | undefined {
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
      /** The pull request's own title, for the confirmation panel's header. */
      pullRequestTitle?: string;
      /**
       * What the confirmation panel's per-candidate "open the diff" link needs,
       * keyed by the changed file's path.
       *
       * It is built here, where the pull request and its changed-file list are
       * already in hand, rather than read again by the panel: the shas have to be
       * the ones this run's diff came from, and a second read could see a
       * different head.
       */
      diffTargets: Map<string, { status?: string; previousPath?: string; baseSha?: string; headSha?: string }>;
      /**
       * How many changed files the run fetched; the brief's own `files.length` is
       * how many of them it actually covered.
       *
       * The confirmation panel states both, because the two differ exactly when
       * the brief's table was cut short (the row cap, the path budget or the
       * client's own page cap) — and "this run covered the whole pull request"
       * would be a false claim precisely there.
       */
      changedFilesTotal: number;
    }
  /**
   * Cancelled. `changedFileCount` is present only when the file list had already
   * arrived, so the run can say how much of the pull request it had read.
   */
  | { kind: 'cancelled'; changedFileCount?: number }
  /** The prompt does not fit; built after the brief, so the file count is known. */
  | { kind: 'budget'; failure: AiPreReviewBudgetFailure; changedFileCount: number }
  /** Every attempt the run made failed the contract; `attempts` lists them. */
  | { kind: 'unparsed'; attempts: AiPreReviewModelAttempt[]; changedFileCount: number }
  /** The model call itself failed; `reported` says whether it was already shown. */
  | { kind: 'failed'; error: string; reported: boolean };

/**
 * The whole run. Returns after reporting to the user; never throws for an
 * expected failure (those are reported in place), so the command registration
 * only has to guard against a genuinely unexpected error.
 *
 * Everything between the first request and the model's answer runs inside one
 * cancellable progress notification, and cancelling it is the same outcome as
 * dismissing the confirmation panel: one sentence, nothing written (§6.4).
 *
 * `host` carries the two things only an `ExtensionContext` has: `extensionUri`
 * is what the confirmation panel's document is loaded from (the panel is an
 * editor tab, so it needs the extension's `out/webview` root), and `logUri` is
 * where the debug diagnostics dump is written. It is required rather than
 * optional because the confirmation step cannot exist without the first — a run
 * that could not build its panel would have no way to ask for confirmation, and
 * creating nothing is the only honest outcome for that.
 */
export async function runAiPreReview(
  config: ConfigManager,
  viewProvider: ForgejoToolkitViewProvider | undefined,
  pullReviewCommentController: PullReviewCommentController,
  params: PullRequestTarget,
  host: { extensionUri: vscode.Uri; logUri?: vscode.Uri },
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
    //
    // Both reads go through the model seam (`src/ai/transport.ts`), and neither of
    // them sends anything: `availability()` answers whether this editor has a
    // usable language model API at all (with the sentence to show when it does
    // not), and `listModels()` is the editor's own unfiltered list.
    const transport = vscodeLmTransport;
    const availability = await transport.availability();
    if (!availability.usable) {
      void vscode.window.showErrorMessage(availability.reason);
      return;
    }
    const offered = await transport.listModels();
    if (offered.length === 0) {
      reportNoChatModel();
      return;
    }

    const configured = aiPreReviewModelSettingValue();
    let chosen: AiModelInfo;
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

    // What the prompt may carry is settled next, and it is settled **before**
    // this run reads or sends anything: with the setting at `ask` the modal is
    // the only thing that happens, and a cancelled modal returns from here —
    // zero HTTP requests, zero model calls, zero writes of its own. The vendor
    // is why this question comes after the model choice: the modal has to name
    // who would receive the content.
    const scope = await resolveAiPreReviewPromptScope(aiPreReviewModelIdentity(chosen).vendor);
    if (scope === undefined) {
      reportPromptScopeNotChosen();
      return;
    }

    // The language the comment bodies are written in is settled here, **once for
    // the whole run**, and the instruction block is built from it right away:
    // the same bytes are then what the token counter measures, what both
    // attempts of the one model send, and what the diagnostics dump prints. It
    // is read after the scope question so a run the user declines never even
    // reads a setting it will not use, and before the validation below because
    // that measurement is of these exact instructions.
    const bodyLanguage = aiPreReviewCommentBodyLanguage();
    const systemPrompt = buildAiPreReviewSystemPrompt(bodyLanguage);
    logger.debug(`AI pre-review: the comment bodies are asked for in ${aiPreReviewBodyLanguageName(bodyLanguage)}`);

    // Validation, and only validation: the instruction block is prepared once,
    // so whether the chosen model can hold it is answered before the first
    // request goes out — and a model that cannot hold it refuses the run rather
    // than being swapped for a larger one.
    const chosenModel = await validateChosenAiPreReviewModel(transport, chosen, systemPrompt);
    if (!chosenModel) {
      return;
    }

    const diagnostics = await createRunDiagnostics(host, params, offered, chosenModel, configured, scope);

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
      (progress, token) =>
        gatherPreReviewRequest(
          transport,
          client,
          params,
          chosenModel,
          scope,
          systemPrompt,
          progress,
          token,
          diagnostics,
        ),
    );

    if (gathered.kind === 'cancelled') {
      reportCancelled(gathered.changedFileCount);
      return;
    }
    if (gathered.kind === 'budget') {
      reportRequestBudgetFailure(gathered.failure, chosenModel.model, gathered.changedFileCount);
      return;
    }
    if (gathered.kind === 'failed') {
      if (!gathered.reported) {
        logger.error(`AI pre-review model call failed: ${gathered.error}`);
        void vscode.window.showErrorMessage(
          vscode.l10n.t(
            'The AI pre-review of the whole pull request could not be completed: {0}. This does not affect your review — nothing was created.',
            gathered.error,
          ),
        );
      }
      return;
    }
    if (gathered.kind === 'unparsed') {
      reportContractFailures(gathered.attempts, gathered.changedFileCount);
      return;
    }

    const { accepted, dropped } = validatePreReviewComments(gathered.brief, { comments: gathered.comments });
    if (accepted.length === 0) {
      void vscode.window.showInformationMessage(
        vscode.l10n.t(
          'The AI pre-review read the whole pull request ({0} changed file(s)) and produced no usable comments ({1}). Nothing was created.',
          gathered.brief.files.length,
          describeDrops(dropped),
        ),
      );
      return;
    }

    // The confirmation step, and the run's only write gate. It used to be a
    // multi-select QuickPick whose rows carried each comment's body inside a
    // label VS Code truncates, with no description and no tooltip for the rest —
    // so a person could not read what they were about to accept. The panel shows
    // every body in full, lets it be edited before the draft exists (so a wording
    // is fixed here rather than corrected in the diff afterwards), and states what
    // the run sent (the model's vendor, the prompt scope, the counts and the drop
    // reasons). Dismissing it, closing the tab, or checking nothing all mean the
    // same thing: nothing is written.
    const panel = AiPreReviewPanel.createOrShow(
      host.extensionUri,
      {
        instanceId: params.instanceId,
        owner: params.owner,
        repo: params.repo,
        index: params.index,
        pullRequestTitle: gathered.pullRequestTitle,
        model: aiPreReviewModelIdentity(chosen),
        scope,
        // The coverage the panel's header states. It comes from the brief this
        // run validated against — not from a second read of the pull request,
        // which could see a different head — and so it is the number the run
        // actually covered rather than the number the server reports today.
        changedFileCount: gathered.brief.files.length,
        changedFilesTotal: gathered.changedFilesTotal,
        candidateCount: accepted.length,
        drops: droppedLabels(dropped),
        candidates: accepted.map((candidate, index) => ({
          index,
          path: candidate.path,
          line: candidate.line,
          side: candidate.side === 'base' ? 'base' : 'head',
          extraLines: candidate.extraLines,
          body: candidate.body,
          // Only when it is true, so the payload a card receives describes the
          // comment rather than carrying a field that is usually absent.
          ...(candidate.bodyTruncated ? { bodyTruncated: true } : {}),
          diff: gathered.diffTargets.get(candidate.path),
        })),
      },
      viewProvider,
    );

    const decision = await panel.decision;
    // The answer's bodies are the one thing the webview proposes; every anchor
    // still comes from this run's own validated candidates. The payload's card
    // indexes are the positions in `accepted` (it is built from `accepted.map`),
    // and the panel refuses any entry whose index it did not offer, so the lookup
    // here cannot become a second chance for a forged anchor.
    const confirmed =
      decision.kind === 'create'
        ? decision.entries
            .map((entry) => {
              const candidate = accepted[entry.index];
              return candidate ? { ...candidate, body: entry.body } : undefined;
            })
            .filter((entry): entry is AiPreReviewCandidate => !!entry)
        : [];
    if (confirmed.length === 0) {
      panel.dispose();
      reportCancelled(gathered.brief.files.length);
      return;
    }

    const outcome = await writeConfirmedDrafts(
      config,
      pullReviewCommentController,
      viewProvider,
      params,
      confirmed,
      dropped,
    );
    // The panel stays open on what it produced, so the status line and the way to
    // the pending review are where the answer was given.
    panel.reportResult(outcome);
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
 * from a bug report: which pull request, which prompt scope was chosen (and
 * that the feature switch is on at all), which model the
 * run is using and where that choice came from, which models the editor offered
 * with their input budgets, and the shape of the request. The answer never
 * appears here — only in the per-attempt blocks below.
 */
async function createRunDiagnostics(
  host: { logUri?: vscode.Uri } | undefined,
  params: PullRequestTarget,
  models: readonly AiModelInfo[],
  candidate: AiPreReviewChosenModel,
  configured: string,
  scope: AiPreReviewStatedScope,
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
      `settings: ${AI_PRE_REVIEW_SETTING}=true, ${AI_PRE_REVIEW_PROMPT_SCOPE_SETTING}=${scope}, ${AI_PRE_REVIEW_MODEL_SETTING}="${configured}"`,
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
  /**
   * The literal answer this shape asks for, when its exact text is the point.
   *
   * The three `{}` shapes do not set this, and their verdict stays the sentence
   * they always had. The echo shape does, and its verdict is then a **boolean**
   * (`answered the echo exactly as asked: true|false`) because the question is
   * not "did it answer something short" but "did this exact string survive the
   * round trip": a faithful provider returns the literal unchanged, a provider
   * that mangles text in transit returns it with punctuation missing, and a
   * model that cannot follow the instruction answers something else entirely.
   */
  exactAnswer?: {
    /** The literal text a faithful round trip returns. */
    text: string;
    /** How the verdict names the answer, e.g. `the echo`. */
    name: string;
  };
}

/**
 * The trivial question every probe sends. It asks for a two-character answer
 * that is derivable from the instruction alone, so a normal answer and a
 * degenerate one cannot be confused: any model that can answer at all can answer
 * `{}`.
 *
 * Deliberately content-free — no repository, no pull request, no diff — so a
 * probe run sends nothing that the feature's own switches are there to protect.
 *
 * Its one blind spot is punctuation: `{}` has none, so a provider that eats
 * commas, quotes and backslashes still answers this shape and still looks
 * healthy. That is what the echo request below is for.
 */
export const AI_PRE_REVIEW_PROBE_PROMPT = 'Reply with exactly {} and nothing else.';

/**
 * The punctuation-sensitive echo request: the fourth probe shape (2026-10-01,
 * added after a real run's answer came back as a scrambled copy of our own
 * request with its punctuation stripped).
 *
 * `{}` cannot see a transport that loses punctuation, and the feature's real
 * request is full of it — a JSON schema of quotes, commas and escapes. This
 * sentence asks for a literal answer with all three kinds in it, so the answer
 * can be compared **character by character** instead of judged by eye. It stays
 * content-free like every other probe shape: one sentence, no repository.
 */
export const AI_PRE_REVIEW_PROBE_ECHO_PROMPT = 'Reply with exactly {"a":"b,c\\"d\\\\e","f":[1,2]} and nothing else.';

/**
 * The answer {@link AI_PRE_REVIEW_PROBE_ECHO_PROMPT} asks for, verbatim: valid
 * JSON whose value carries a comma, an escaped quote, an escaped backslash and a
 * number list, so a round trip that loses any one of them cannot compare equal.
 */
export const AI_PRE_REVIEW_PROBE_ECHO_ANSWER = '{"a":"b,c\\"d\\\\e","f":[1,2]}';

/**
 * The shapes the probe asks with, in the order the dump lists them.
 *
 * Four shapes, one question each, because the machines this exists for fail in
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
 * 4. **the punctuation-sensitive echo** (2026-10-01, added after a real answer
 *    came back as a scrambled echo of our own request with punctuation missing)
 *    — the only shape whose exact text matters, so it is sent without our
 *    instruction block: its verdict then measures the round trip (provider and
 *    model) and not our wording. A faithful round trip returns the literal
 *    unchanged; a round trip that eats punctuation returns it mangled, which is
 *    a provider limitation rather than a model that cannot answer; anything else
 *    — prose, `{}`, a review comment — is a model that did not follow the
 *    instruction. Shapes 1–3 cannot see this at all: `{}` carries no punctuation
 *    to lose.
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
      messages: [
        { role: 'user', text: aiPreReviewPromptText(AI_PRE_REVIEW_SYSTEM_PROMPT, AI_PRE_REVIEW_PROBE_PROMPT) },
      ],
    },
    {
      label: 'echo: one user message, punctuation-sensitive',
      messages: [{ role: 'user', text: AI_PRE_REVIEW_PROBE_ECHO_PROMPT }],
      exactAnswer: { text: AI_PRE_REVIEW_PROBE_ECHO_ANSWER, name: 'the echo' },
    },
  ];
}

/**
 * Which models the probe will ask, or the reason it will not ask anything.
 *
 * The probe is a diagnostic for **the model the user chose**, not a survey of
 * every provider the editor offers: the user's choice is the single source of
 * truth for which model reviews a pull request (see `aiPreReviewSettings.ts`),
 * and asking the editor's whole provider list the same four questions spends
 * calls the user never asked for — several of them paid. So the setting decides:
 *
 * - a value that names an offered model → that model alone;
 * - an **empty** setting or a value that names nothing offered → nothing is
 *   asked, and the probe says which it was and lists the offered models so the
 *   value can be set (or the choice made with the picker). It deliberately does
 *   **not** fall back to one arbitrary model or to "ask everything": an explicit
 *   value that matches nothing is a typo to report, never a licence to spend
 *   calls on models the user did not name — the same refusal the run itself
 *   makes, so the two surfaces cannot disagree about which model is in play.
 */
export function resolveAiPreReviewProbeTarget(
  configured: string,
  offered: readonly vscode.LanguageModelChat[],
):
  | { kind: 'ask'; models: vscode.LanguageModelChat[]; reason: string }
  | { kind: 'none' }
  | { kind: 'empty' }
  | { kind: 'unmatched' } {
  if (offered.length === 0) {
    return { kind: 'none' };
  }
  if (configured === '') {
    return { kind: 'empty' };
  }
  const chosen = findOfferedAiPreReviewModel(configured, offered);
  if (!chosen) {
    return { kind: 'unmatched' };
  }
  return {
    kind: 'ask',
    models: [chosen],
    reason: `the chosen model — the setting "${AI_PRE_REVIEW_MODEL_SETTING}" names it, so only it was asked`,
  };
}

/**
 * The debug-only probe: asks the **chosen** model (see
 * {@link resolveAiPreReviewProbeTarget}) the same trivial question with each
 * shape above, and writes the prompts and the raw answers to the diagnostics
 * dump.
 *
 * This is the second half of the diagnosis the feature could not do on its own.
 * A run tells you that the chosen model answered a fragment; it cannot tell you
 * whether that model is unable to answer an extension at all, whether our
 * request is what it is choking on, or whether punctuation is being lost
 * somewhere between us and it. A two-character question answers the first two in
 * one pass, the punctuation-sensitive echo answers the third, and the dump puts
 * the evidence next to the run's own blocks.
 *
 * Gated twice on purpose, and it sends nothing unless both hold:
 *
 * - `forgejoToolkit.aiPreReview` must be on, because the promise that switch
 *   makes is "with this off, nothing is sent to a model provider" — including
 *   from a diagnostic command.
 * - `forgejoToolkit.debug` must be on, because the point of the probe is the
 *   file it writes, and that file holds prompts and model output.
 *
 * It asks one model, not every offered one: the dump header says which model was
 * asked and why, so a reader never has to infer it from the blocks, and the
 * probe stays a measurement of **the model that matters** rather than of the
 * editor's whole provider list.
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

  // The listing goes through the same seam reads the run uses, then narrows back
  // to the editor's own chat models: this diagnostic sends shapes the seam cannot
  // express (one of them is deliberately **two** messages, which the `vscode.lm`
  // transport flattens), so it keeps speaking to `sendRequest` itself.
  const availability = await vscodeLmTransport.availability();
  if (!availability.usable) {
    void vscode.window.showErrorMessage(availability.reason);
    return;
  }
  const offered = (await vscodeLmTransport.listModels())
    .map((model) => vscodeLmChatModelOf(model))
    .filter((model): model is vscode.LanguageModelChat => model !== undefined);
  if (offered.length === 0) {
    // Reuses the run's own "no chat model is available" report: one wording for
    // one condition, whichever entry point found it.
    reportNoChatModel();
    return;
  }

  const configured = aiPreReviewModelSettingValue();
  const target = resolveAiPreReviewProbeTarget(configured, offered);
  if (target.kind === 'empty') {
    logger.info(
      `AI pre-review model probe: "${AI_PRE_REVIEW_MODEL_SETTING}" is empty and the probe asks one model, so nothing was sent. Offered: ${offered.map(modelLabel).join(', ')}`,
    );
    void vscode.window.showWarningMessage(
      vscode.l10n.t(
        'Nothing was sent: the probe asks the model you chose, and the setting "forgejoToolkit.aiPreReviewModel" is empty. Pick a model first — the "AI Pre-Review: Choose Chat Model" command or the setting itself — then run the probe again. Offered models: {0}',
        offered.map(modelLabel).join(', '),
      ),
    );
    return;
  }
  if (target.kind === 'unmatched') {
    logger.error(
      `AI pre-review model probe: "${AI_PRE_REVIEW_MODEL_SETTING}" = "${configured}" names no offered chat model, so nothing was sent. Offered: ${offered.map(modelLabel).join(', ')}`,
    );
    void vscode.window.showWarningMessage(
      vscode.l10n.t(
        'Nothing was sent: the setting "forgejoToolkit.aiPreReviewModel" is set to "{0}", which names no offered chat model, and the probe will not spend calls on a model you did not choose. Correct the value or pick one with the "AI Pre-Review: Choose Chat Model" command. Offered models: {1}',
        configured,
        offered.map(modelLabel).join(', '),
      ),
    );
    return;
  }

  if (target.kind === 'none') {
    // The resolver's own "nothing is offered" arm; `offered` is checked above
    // too, so this is unreachable in practice and handled rather than asserted:
    // no probe may send anything without a model, whatever got it here.
    reportNoChatModel();
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
      `chat models offered by vscode.lm.selectChatModels(): ${offered.length}`,
      ...offered.map(
        (model, index) => `  model ${index + 1}: ${modelLabel(model)} maxInputTokens=${maxInputTokensOf(model)}`,
      ),
      // Which models this run actually asked, and why — stated up front so a
      // dump can be read without inferring the selection rule from the blocks,
      // and so "the probe asked only my model" is verifiable from the file.
      `models asked by this probe: ${target.models.map(modelLabel).join(', ')}`,
      `why these models: ${target.reason}`,
      `shapes asked of each model named above: ${shapes.length}`,
      ...shapes.map(
        (shape, index) =>
          `  shape ${index + 1}: ${shape.label} (${shape.messages.length} message(s))${
            shape.exactAnswer ? `; a faithful answer is exactly ${shape.exactAnswer.text}` : ''
          }`,
      ),
      `question: ${JSON.stringify(AI_PRE_REVIEW_PROBE_PROMPT)}`,
      `echo question: ${JSON.stringify(AI_PRE_REVIEW_PROBE_ECHO_PROMPT)}`,
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
      for (const model of target.models) {
        for (const shape of shapes) {
          if (token.isCancellationRequested) {
            return;
          }
          progress.report({ message: vscode.l10n.t('Asking the chosen chat model the same trivial question…') });
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
            candidates: outcome.candidates,
          });
          asked += 1;
          if (outcome.stop) {
            // Consent was declined (or the call was cancelled): repeating the
            // question would produce the same outcome, so the probe stops with
            // what it has. `classifyModelError` already showed the user the one
            // message that explains it.
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
 * The command body behind `COMMAND_AI_PRE_REVIEW_OPEN_DIAGNOSTICS`: open
 * `<logUri>/ai-pre-review-diagnostics.log` in the editor, or explain why there is
 * nothing to open.
 *
 * It is the "how do I get more than the bounded excerpt" half of the
 * contract-failure message. Both ways of not having a file are reported plainly
 * rather than as an error: a host with no log directory (the same degradation
 * `createAiPreReviewDiagnostics` already models) and a file that is not there
 * yet, which is the ordinary state of a machine where `forgejoToolkit.debug` has
 * never been on — in that case the message names that setting, because the
 * setting is the whole remedy and a bare "file not found" would be a dead end.
 *
 * Reading a local diagnostic file sends nothing to anyone, so this command is
 * deliberately **not** gated on `forgejoToolkit.aiPreReview` (nor on
 * `forgejoToolkit.debug`): it has to be reachable precisely when the diagnostics
 * are missing.
 */
export async function openAiPreReviewDiagnostics(host?: { logUri?: vscode.Uri }): Promise<void> {
  const filePath = aiPreReviewDiagnosticsFilePath(host?.logUri?.fsPath);
  if (filePath === undefined) {
    void vscode.window.showWarningMessage(
      vscode.l10n.t(
        'This VS Code host provides no extension log directory, so there is no AI pre-review diagnostics file to open. Everything else keeps working.',
      ),
    );
    return;
  }
  if (!fs.existsSync(filePath)) {
    void vscode.window.showWarningMessage(
      vscode.l10n.t(
        'There is no AI pre-review diagnostics file at {0} yet. It is written only while the setting "forgejoToolkit.debug" is on, so enable that setting and run a pre-review — or the "AI Pre-Review: Probe Chat Models (debug)" command — and open it again. Nothing was sent.',
        filePath,
      ),
    );
    return;
  }
  try {
    const document = await vscode.workspace.openTextDocument(vscode.Uri.file(filePath));
    await vscode.window.showTextDocument(document, { preview: false });
  } catch (error) {
    void vscode.window.showErrorMessage(
      vscode.l10n.t(
        'The AI pre-review diagnostics file {0} could not be opened: {1}',
        filePath,
        userFacingErrorMessage(error),
      ),
    );
  }
}

/**
 * One probe call. Never throws: a failing call is an outcome the dump records,
 * because "this model cannot answer" is a result, not an error to abort on. The
 * one exception is `stop`, which says the failure is about consent or
 * cancellation rather than about the model, and so applies to every later call
 * as well.
 *
 * The answer comes from the response's **candidate streams**, arbitrated exactly
 * as a real run arbitrates them: the text parts first, then the reasoning parts,
 * and the `text` projection only when neither carried text. The probe's contract
 * is not the run's JSON schema but the shape's own question — for the echo shape,
 * the exact literal — so the two surfaces cannot disagree about which channel an
 * answer came from, which is the whole point of probing with the same reader the
 * run uses.
 */
async function sendProbeRequest(
  model: vscode.LanguageModelChat,
  shape: AiPreReviewProbeShape,
  token?: vscode.CancellationToken,
): Promise<{
  answer: string;
  outcome: string;
  stop?: boolean;
  /** The candidate streams of this response, for the diagnostics dump. */
  candidates: AiPreReviewResponseCandidate[];
}> {
  try {
    const response = await model.sendRequest(
      shape.messages.map((message) => vscode.LanguageModelChatMessage.User(message.text)),
      {
        justification: vscode.l10n.t(
          'The AI pre-review model probe sends one trivial sentence to the chat model you chose and writes its answers to a diagnostics file, to find out whether that model can answer an extension at all.',
        ),
      },
      token,
    );
    if (!response || (!isAsyncIterable(response.stream) && !isAsyncIterable(response.text))) {
      return { answer: '', outcome: 'the model returned no response stream', candidates: [] };
    }
    // One pass over the response: the parts are collected and classified, and the
    // `text` projection is read only when no candidate stream carried text.
    const { candidates, fragments } = await readResponseCandidates(response, () => false);
    const text = candidates[0]?.text ?? '';
    logAnswerFragments(fragments ?? [], text, text.length);
    if (token?.isCancellationRequested) {
      return {
        answer: text,
        outcome: 'cancelled; the answer above may be partial',
        stop: true,
        candidates,
      };
    }
    // The probe's contract, arbitrated by the same function a run uses: a shape
    // that names an exact answer asks whether that literal survived the round
    // trip, and every other shape only asks whether an answer arrived at all.
    const selection = pickResponseCandidate(candidates, (candidate) =>
      shape.exactAnswer === undefined ? candidate.text !== '' : candidate.text.trim() === shape.exactAnswer.text,
    );
    if (logger.isDebugEnabled()) {
      logger.debug(responseCandidateSelectionLogLine(selection));
    }
    const chosen = selection.candidate;
    if (!chosen) {
      return { answer: '', outcome: 'the model returned no response stream', candidates };
    }
    return {
      answer: chosen.text,
      outcome: describeProbeAnswer(chosen.text, shape.exactAnswer, chosen.kind),
      candidates,
    };
  } catch (error) {
    // Reused from the run so the consent dialog's outcome is reported the same
    // way (and so a declined consent is not re-asked of every later model).
    const classified = classifyModelError(error);
    if (classified.kind === 'cancelled') {
      return { answer: '', outcome: 'cancelled', stop: true, candidates: [] };
    }
    const reason = classified.kind === 'failed' ? classified.error : 'unknown failure';
    return { answer: '', outcome: `model call failed: ${reason}`, stop: reason === 'NoPermissions', candidates: [] };
  }
}

/**
 * What the probe makes of one answer: the whole point of the exercise is the
 * first clause, so it is stated as a verdict and followed by the same bounded
 * shape the Output Channel uses — the answer itself is in the dump above it.
 *
 * A shape that names its exact answer gets a **boolean** verdict instead of the
 * `{}` sentence: `answered the echo exactly as asked: true` is the one line a
 * reader needs in order to tell a faithful round trip from one that mangles
 * punctuation, and a `false` puts them in front of the raw answer block above
 * it. `true` is the only thing that clears the transport, so a weak model and a
 * mangling provider cannot be read the same way.
 *
 * The verdict also names the **candidate stream** the answer came from, because
 * on the maintainer's machine the whole failure was that the two streams differ:
 * a verdict that did not say which one it judged would leave the reader unable to
 * tell a provider whose text parts are right from one whose reasoning trace is.
 * The label is the kind the reader sees in the debug dump (`the text candidate`,
 * `the reasoning candidate`) or, when no part carried text at all, `the text
 * projection` — the fallback.
 */
function describeProbeAnswer(
  text: string,
  exact: AiPreReviewProbeShape['exactAnswer'],
  kind: AiPreReviewResponseCandidate['kind'],
): string {
  const shape = describeAiPreReviewAnswerShape(text);
  const from = `from ${responseCandidateKindLabel(kind)}`;
  if (exact) {
    return `answered ${exact.name} exactly as asked: ${text.trim() === exact.text} (${shape}; ${from})`;
  }
  const verdict = text.trim() === '{}' ? 'answered exactly "{}" as asked' : 'did NOT answer the requested "{}"';
  return `${verdict} (${shape}; ${from})`;
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
 * command that changes the choice. The prompt scope is named only to say it
 * cannot help, so nobody spends a run finding that out: every scope costs at
 * least the fixed instructions, and the instructions are what did not fit.
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
      'The AI pre-review of the whole pull request was not started: the chat model you chose, {0}, cannot hold its fixed instruction prompt — {1} tokens are needed and its input budget is {2}. Nothing was sent, nothing was created, and no other model was substituted. {3} (Every prompt scope costs at least these instructions, so choosing a smaller scope cannot help here.)',
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
      'The AI pre-review of the whole pull request was not started: the chat model you chose, {0}, would not measure its fixed instruction prompt, so the run could not check that the prompt fits. Nothing was sent and nothing was created, and no other model was substituted. {1}',
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
 *
 * The smaller-scope remedy names the two cheapest scopes explicitly, because
 * "choose a smaller scope" is not an instruction a user can act on while the
 * setting is called `metadata-only` / `changed-lines-only` in the Settings UI.
 */
function reportRequestBudgetFailure(
  failure: AiPreReviewBudgetFailure,
  model: AiModelInfo,
  changedFileCount: number,
): void {
  logger.error(
    `AI pre-review: the shortest prompt for this pull request needs ${failure.neededTokens} tokens but the chosen model ${modelLabel(model)} has an input budget of ${failure.availableTokens}; nothing was sent`,
  );
  void vscode.window.showErrorMessage(
    vscode.l10n.t(
      'The AI pre-review could not fit the whole pull request ({0} changed file(s)) into the input budget of the chat model you chose, {1} ({2} tokens needed, {3} available). Nothing was sent and nothing was created, and no other model was substituted. Set the setting "forgejoToolkit.aiPreReviewPromptScope" to "changed-lines-only" or "metadata-only" to send a smaller request, or use a model with a larger input budget. {4}',
      changedFileCount,
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
 * that is the user's decision to make. {5} says where the bounded excerpt of each
 * answer now is and how to get the whole text, because "the answer was not JSON"
 * on its own is what the maintainer could not diagnose.
 */
function reportContractFailures(attempts: readonly AiPreReviewModelAttempt[], changedFileCount: number): void {
  const tried = describeFailedAttempts(attempts);
  const model = attempts[0]?.model;
  const label = model ? formatAiPreReviewModelIdentity(model) : 'the chosen chat model';
  logger.error(
    `AI pre-review: ${label} did not return the contracted JSON on any of its ${attempts.length} attempt(s); the bound is ${AI_PRE_REVIEW_MAX_ATTEMPTS_PER_MODEL} attempt(s) of the one chosen model, and no other model was called`,
  );
  void vscode.window.showErrorMessage(
    vscode.l10n.t(
      'The AI pre-review asked the chat model you chose, {0}, the same question about the whole pull request ({1} changed file(s)) {2} time(s) — its bound is {3} attempt(s) per run, and no other model was called — and none of the answers was the JSON it needs, so no comments were created. Tried: {4}. Nothing was created; you can review the pull request by hand. {5} {6}',
      label,
      changedFileCount,
      attempts.length,
      AI_PRE_REVIEW_MAX_ATTEMPTS_PER_MODEL,
      tried,
      chooseModelActionHint(),
      diagnosticsActionHint(),
    ),
  );
}

/**
 * The sentence the contract-failure message ends with: where the bounded excerpt
 * of each answer is, and how to get the whole text.
 *
 * It names the channel and the command id literally, for the same reason
 * `chooseModelActionHint` does — this API version cannot attach a command to a
 * message button — and it names the setting that has to be on for there to be a
 * file at all, so the pointer cannot send someone to a command that will only
 * say "there is nothing here yet".
 */
function diagnosticsActionHint(): string {
  return vscode.l10n.t(
    'The "Forgejo Toolkit" output channel shows a bounded excerpt of each answer (at most 200 characters, escaped onto one line); the command "AI Pre-Review: Open Diagnostics" ("forgejoToolkit.aiPreReviewOpenDiagnostics") opens the diagnostics file, which holds the full prompt and the full answer and is written only while the setting "forgejoToolkit.debug" is on.',
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
 * point of the split — and it names the model that produced the answer, how long
 * the answer was and a **bounded excerpt of it**, which is what makes the three
 * failure kinds diagnosable without turning `forgejoToolkit.debug` on: a bare
 * `comments[]` fragment, a truncated JSON object and a prose refusal all read as
 * "not JSON", and only the text tells them apart.
 *
 * The excerpt is capped at `AI_PRE_REVIEW_ANSWER_EXCERPT_LENGTH` characters and
 * then `JSON.stringify`-escaped, so it is one line whatever the answer contains;
 * the whole answer still lives only in the debug-only diagnostics file, and a
 * successful run still logs no answer text at all. Plain text rather than
 * `l10n.t`: log lines are never shown in the UI (AGENTS.md, i18n).
 */
function contractFailureLogLine(
  model: AiPreReviewModelIdentity,
  failure: AiPreReviewContractFailure,
  answer: string,
): string {
  const identity = formatAiPreReviewModelIdentity(model);
  const excerpt = JSON.stringify(aiPreReviewAnswerExcerpt(answer));
  const quoted = `the answer is ${answer.length} character(s), excerpt ${excerpt}`;
  switch (failure.kind) {
    case 'empty':
      return `AI pre-review: ${identity} returned an empty answer (${quoted})`;
    case 'not-json':
      return `AI pre-review: ${identity} returned an answer that is not JSON (${quoted})`;
    case 'wrong-shape':
      return failure.field === 'root'
        ? `AI pre-review: ${identity} returned JSON whose top level is not an object (${quoted})`
        : `AI pre-review: ${identity} returned JSON whose "comments" field is missing or not an array (${quoted})`;
  }
}

/**
 * One fragment of a streamed answer as one debug line: which fragment it was,
 * how long it is, and its text escaped onto one line.
 *
 * The escaping is the failure excerpt's — `JSON.stringify` of the text — so a
 * quote, a backslash, a newline, a tab or an unterminated surrogate pair cannot
 * break the log line apart; a **lone surrogate** (the fake stream's own boundary
 * case, and the shape a provider that splits an astral character would hand over)
 * is escaped rather than printed raw, which is what makes "the boundary fell
 * inside a character" visible instead of invisible. The text is capped at
 * `AI_PRE_REVIEW_ANSWER_EXCERPT_LENGTH` by `aiPreReviewAnswerExcerpt`, the same
 * helper the failure line uses, and the line then says the text was cut and by
 * how many characters — a reader must never mistake a capped fragment for a short
 * one, because the whole point of the line is to show the provider's boundaries.
 *
 * `total` is the fragment count of the whole response, which the stream only
 * knows once it ended; the accumulation therefore keeps the fragments and formats
 * them after the loop (see `logAnswerFragments`).
 */
function answerFragmentLogLine(index: number, total: number, fragment: string): string {
  const excerpt = aiPreReviewAnswerExcerpt(fragment);
  const cut = fragment.length > excerpt.length ? `, cut from ${fragment.length} characters` : '';
  return `AI pre-review: answer fragment ${index + 1} of ${total} in the stream: length=${fragment.length}, text=${JSON.stringify(
    excerpt,
  )}${cut}`;
}

/**
 * The closing line of a debug fragment list: how many fragments the response
 * arrived in, how many characters they added up to, and the bounded escaped
 * beginning of the answer **beside** the list — so a reader sees the
 * concatenated result without scrolling back through the fragments, and can tell
 * "the provider sent corrupt fragments" from "our accumulation corrupts them" by
 * comparing the two.
 *
 * The excerpt is `aiPreReviewAnswerExcerpt`, the same helper and the same cap the
 * failure line uses, so the two can never disagree about how much of an answer
 * the log may quote.
 */
function answerStreamSummaryLogLine(fragmentCount: number, characterCount: number, answer: string): string {
  return `AI pre-review: answer stream summary: ${fragmentCount} fragment(s), ${characterCount} character(s), excerpt=${JSON.stringify(
    aiPreReviewAnswerExcerpt(answer),
  )}`;
}

/**
 * Logs a whole streamed answer, fragment by fragment, and then its totals — the
 * **debug-only** diagnostic that makes the transport visible.
 *
 * Why the fragments are the unit. The maintainer's failure was an answer that
 * came back as a punctuation-stripped copy of the request, and the accumulation
 * loop had already been ruled out by unit test (`the streamed answer is
 * accumulated byte for byte (hypothesis C)`), so what a diagnosis still needs is
 * the one thing neither the debug dump nor the bounded failure excerpt carries:
 * **where one fragment ended and the next began**. Only that tells "the provider's
 * fragments are already corrupt" apart from "our accumulation corrupts them", and
 * with the dump holding the concatenation, the fragments beside it are what makes
 * the difference readable. Both a successful and a failed call may therefore log
 * them: the fragment list describes the transport, and the transport is the same
 * question whichever way the answer later parsed.
 *
 * What may never appear. Only what came back, never what was sent: the prompt,
 * the brief and the diff are not arguments of this function, so no fragment line
 * can carry them. The lines go to the Output Channel through `logger.debug` — the
 * one surface `forgejoToolkit.debug` gates (`Logger.debug` returns before it
 * writes) — so no message, toast or notification ever mentions them, and with
 * debug off nothing here reaches the channel at all. There is no new setting: the
 * debug switch that already opens the diagnostics dump is the whole gate, which
 * is consistent with that dump already carrying the full answer at debug level.
 */
function logAnswerFragments(fragments: readonly string[], answer: string, characterCount: number): void {
  if (!logger.isDebugEnabled()) {
    return;
  }
  fragments.forEach((fragment, index) => {
    logger.debug(answerFragmentLogLine(index, fragments.length, fragment));
  });
  logger.debug(answerStreamSummaryLogLine(fragments.length, characterCount, answer));
}

/**
 * One candidate stream of a response: a channel the provider may have put the
 * **answer** on, with the text it carried.
 *
 * It is the seam's own part type (`src/ai/transport.ts`): the transport reads the
 * response and hands the candidates over, and this feature's contract arbitrates
 * them. `kind` is named after the channel rather than after a class, because a
 * channel has more than one runtime shape (the published class and the RPC flavour
 * the maintainer's machine shows) and the arbitration and the log must talk about
 * the channel, not about one of its encodings.
 */
type AiPreReviewResponseCandidate = AiCompletionResult['parts'][number];

/** What arbitration made of the candidate streams: which one is the answer, and why. */
type ResponseCandidateSelection =
  | { outcome: 'match'; candidate: AiPreReviewResponseCandidate; reason: string }
  | { outcome: 'mismatch'; candidate?: AiPreReviewResponseCandidate; reason: string };

/** How the log and the diagnostics name one candidate stream. */
function responseCandidateKindLabel(kind: AiPreReviewResponseCandidate['kind']): string {
  switch (kind) {
    case 'text':
      return 'the text candidate';
    case 'reasoning':
      return 'the reasoning candidate';
    case 'text-projection':
      return 'the `text` projection';
  }
}

/**
 * The answer of one response: the candidate stream that satisfies the caller's
 * contract, preferred in the order {@link readResponseCandidates} returns.
 *
 * This is where the contract arbitrates. `accepts` is the caller's own strict
 * validation — the probe's exact-literal comparison, the run's JSON contract and
 * schema — and it is applied to each candidate **separately**. The text candidate
 * is tried first; if it is absent or does not verify, the reasoning candidate is
 * tried, and only then the `text` projection (which is itself a candidate, so it
 * is judged by the same rule rather than trusted). A candidate that verifies wins
 * even when an earlier, preferred one existed and failed, and the returned
 * `reason` says exactly which of the two happened so the caller can log it at
 * debug.
 *
 * When nothing verifies the run fails exactly as it did before: the mismatch arm
 * carries the preferred candidate (or none at all) so the failure message and the
 * diagnostics still describe the bytes that were actually examined. There is no
 * concatenation of two candidates, no guessing and no substitution of another
 * model anywhere in this file.
 */
function pickResponseCandidate(
  candidates: readonly AiPreReviewResponseCandidate[],
  accepts: (candidate: AiPreReviewResponseCandidate) => boolean,
): ResponseCandidateSelection {
  let failure: { candidate?: AiPreReviewResponseCandidate; detail: string } | undefined;
  let index = 0;
  for (const candidate of candidates) {
    const valid = accepts(candidate);
    if (valid) {
      const preferred = index === 0;
      const wanted = candidates
        .slice(0, index)
        .map((other) => responseCandidateKindLabel(other.kind))
        .join(' and ');
      return {
        outcome: 'match',
        candidate,
        reason: preferred
          ? `${responseCandidateKindLabel(candidate.kind)} was preferred and it satisfies the contract`
          : `${responseCandidateKindLabel(candidate.kind)} was used because ${wanted} did not satisfy the contract`,
      };
    }
    failure ??= { candidate, detail: 'it does not satisfy the contract' };
    index += 1;
  }
  return {
    outcome: 'mismatch',
    candidate: failure?.candidate,
    reason: failure?.detail ?? 'no candidate stream carried any text',
  };
}

/**
 * The **debug** line that says which candidate stream was used and why, or that
 * none verified — the ninth investigation's own question ("which of the two did
 * we take?") answered on the channel, at debug, the moment it is decided.
 *
 * It carries the selection, never the text: the answer itself is in the
 * diagnostics dump, the candidate that failed is in the failure excerpt, and a
 * line that quoted the answer would put model output on the Output Channel on the
 * success path.
 */
function responseCandidateSelectionLogLine(selection: ResponseCandidateSelection): string {
  if (selection.outcome === 'match') {
    return `AI pre-review: answer stream: using ${responseCandidateKindLabel(selection.candidate.kind)} (${selection.reason})`;
  }
  const preferred = selection.candidate ? responseCandidateKindLabel(selection.candidate.kind) : 'no candidate stream';
  return `AI pre-review: answer stream: no candidate satisfied the contract (preferred ${preferred}; no second model and no concatenation was tried)`;
}

/**
 * The one sentence every cancelled arm shows (§6.4).
 *
 * It names the scope for the same reason every other message in this run does:
 * the entry point is the pull request detail page, so "cancelled" has to be
 * unambiguous about what was cancelled. `changedFileCount` is absent on a run
 * that was cancelled before its file list arrived, and present on one cancelled
 * at the confirmation panel — the number the panel itself was showing.
 */
function reportCancelled(changedFileCount?: number): void {
  void vscode.window.showInformationMessage(
    changedFileCount === undefined
      ? vscode.l10n.t('The AI pre-review of the whole pull request was cancelled. No comments were created.')
      : vscode.l10n.t(
          'The AI pre-review of the whole pull request ({0} changed file(s)) was cancelled. No comments were created.',
          changedFileCount,
        ),
  );
}

/**
 * "The editor offers no chat model at all" (§9.3).
 *
 * The two other ways of having no model — no language model API at all, and a
 * listing that threw — are reported by the transport's own `availability()`
 * (`src/ai/vscodeLmTransport.ts`) before any list is read, so this is the one
 * condition that belongs to the list itself. There is deliberately no fallback
 * layer that substitutes heuristics: without a model this feature does not exist,
 * and pretending otherwise would produce review comments attributed to a machine
 * that never read anything.
 */
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
export function describeOfferedAiPreReviewModels(models: readonly AiModelInfo[]): string {
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
async function pickAiPreReviewModel(offered: readonly AiModelInfo[]): Promise<AiModelInfo | undefined> {
  const items: (vscode.QuickPickItem & { model: AiModelInfo })[] = offered.map((model) => {
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
async function rememberChosenAiPreReviewModel(model: AiModelInfo): Promise<void> {
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
 * The four buttons the prompt-scope modal offers. The first is the
 * recommendation (`changed-files`), the two after it are the cheaper scopes, and
 * the last is the cancel affordance — module constants so the answer can be
 * compared by identity, exactly as the items are handed to the dialog.
 *
 * `full-diff` deliberately has no button: it is the scope for someone who knows
 * they want the previous behaviour, and the modal's own text says how to set it.
 * Four buttons plus the platform's close control is already the limit of what a
 * modal can ask without turning a yes/no question into a form.
 */
export const AI_PRE_REVIEW_SCOPE_BUTTON_CHANGED_FILES = vscode.l10n.t('Send the changed files (recommended)');
export const AI_PRE_REVIEW_SCOPE_BUTTON_CHANGED_LINES = vscode.l10n.t('Send the changed lines only');
export const AI_PRE_REVIEW_SCOPE_BUTTON_METADATA_ONLY = vscode.l10n.t('Send metadata only');
export const AI_PRE_REVIEW_SCOPE_BUTTON_CANCEL = vscode.l10n.t('Cancel — send nothing');

/**
 * Asks the one question this feature asks about egress, as a **modal**.
 *
 * Modal on purpose: this answer decides whether source code leaves the machine,
 * it must not be answerable by clicking somewhere else, and the platform's modal
 * is the only VS Code message that blocks the window until it is answered. The
 * message names the provider (the vendor of the model this run will use, the
 * same fact the model picker shows), each scope's egress in plain words, the
 * setting the answer is stored in, and the fact that nothing is sent before the
 * answer — the four things a person has to know to answer it honestly.
 *
 * `undefined` covers every "not answered" case: the explicit cancel button, the
 * platform's close control, and Escape. There is deliberately no default answer:
 * the caller turns `undefined` into a cancelled run, because an unanswered
 * consent question is not consent.
 */
async function askAiPreReviewPromptScope(vendor: string): Promise<AiPreReviewStatedScope | undefined> {
  const message = vscode.l10n.t(
    'Before this AI pre-review sends anything: the chat model you chose belongs to the "{0}" provider, and the prompt is the only thing that leaves this machine. Choose what it may carry. "Send the changed files" sends the pull request title and branch names, the changed-file paths with their line counts, the metadata of existing review comments (path, line, author, review state — never a comment body), the whole diff, and the full text of every changed file at the pull request head version — the most content: the text of those files leaves this machine, not only the diff, and that is what lets the model read the code around a change. "Send the changed lines only" is the cheapest option that still sends code: the added and removed lines of each file with its file and hunk headers, and none of the surrounding context. "Send metadata only" sends the first three of those and no code at all, so the model cannot read a single changed line and can only comment on file-level matters. In no scope is an access token, a URL or host name, or an existing comment body ever sent. Set the setting "forgejoToolkit.aiPreReviewPromptScope" to "full-diff" instead if you want the whole diff without the file texts. Nothing is requested or sent before you answer, cancelling sends nothing and creates nothing, and your answer is written into that setting so this question is asked only once.',
    vendor,
  );
  const picked = await vscode.window.showInformationMessage(
    message,
    { modal: true },
    AI_PRE_REVIEW_SCOPE_BUTTON_CHANGED_FILES,
    AI_PRE_REVIEW_SCOPE_BUTTON_CHANGED_LINES,
    AI_PRE_REVIEW_SCOPE_BUTTON_METADATA_ONLY,
    AI_PRE_REVIEW_SCOPE_BUTTON_CANCEL,
  );
  if (picked === AI_PRE_REVIEW_SCOPE_BUTTON_CHANGED_FILES) {
    return 'changed-files';
  }
  if (picked === AI_PRE_REVIEW_SCOPE_BUTTON_CHANGED_LINES) {
    return 'changed-lines-only';
  }
  if (picked === AI_PRE_REVIEW_SCOPE_BUTTON_METADATA_ONLY) {
    return 'metadata-only';
  }
  return undefined;
}

/**
 * What this run's prompt may carry, resolved **before** anything is read.
 *
 * Three paths, and each one's ordering matters:
 *
 * - a stated scope is used as it is, with no question: the setting is the source
 *   of truth, so the question is asked once per choice rather than once per run;
 * - `ask` shows the modal and returns **nothing** when it is not answered — the
 *   caller reports that and stops, so a run that never got an answer makes no
 *   request and no model call;
 * - an answered modal writes the answer into the setting first (best effort, the
 *   same discipline as the model choice: a failed write changes where the answer
 *   is remembered, never what this run sends) and the run then uses it.
 */
async function resolveAiPreReviewPromptScope(vendor: string): Promise<AiPreReviewStatedScope | undefined> {
  const configured: AiPreReviewPromptScope = aiPreReviewPromptScopeSettingValue();
  if (configured !== 'ask') {
    logger.info(
      `AI pre-review: prompt scope: the setting "${AI_PRE_REVIEW_PROMPT_SCOPE_SETTING}" = "${configured}"; no question was shown`,
    );
    return configured;
  }
  const answered = await askAiPreReviewPromptScope(vendor.trim() === '' ? 'unknown' : vendor);
  if (answered === undefined) {
    return undefined;
  }
  await rememberChosenAiPreReviewPromptScope(answered);
  return answered;
}

/**
 * Stores the scope the user just chose in
 * `forgejoToolkit.aiPreReviewPromptScope` and says so.
 *
 * Best-effort in exactly one direction, like the model choice: a failed write
 * changes where the answer is remembered, never what this run sends — the user
 * answered, and the run uses the answer either way. The confirmation message is
 * what makes the write auditable: the answer is in the Settings UI, under a name
 * the user just read in the modal.
 */
async function rememberChosenAiPreReviewPromptScope(scope: AiPreReviewStatedScope): Promise<void> {
  try {
    await writeAiPreReviewPromptScopeSetting(scope);
  } catch (error) {
    logger.error(
      `AI pre-review: the chosen prompt scope could not be written to "${AI_PRE_REVIEW_PROMPT_SCOPE_SETTING}" (${userFacingErrorMessage(error)}); this run still uses "${scope}"`,
    );
    void vscode.window.showWarningMessage(
      vscode.l10n.t(
        'The AI pre-review will use the "{0}" prompt scope for this run, but writing the choice to the setting "forgejoToolkit.aiPreReviewPromptScope" failed: {1}. Set it by hand to keep the choice.',
        scope,
        userFacingErrorMessage(error),
      ),
    );
    return;
  }
  logger.info(
    `AI pre-review: prompt scope: "${AI_PRE_REVIEW_PROMPT_SCOPE_SETTING}" = "${scope}" was written, so later runs use it without asking`,
  );
  void vscode.window.showInformationMessage(
    vscode.l10n.t(
      'The setting "forgejoToolkit.aiPreReviewPromptScope" is now "{0}", so every later run uses that scope without asking. Change it in Settings whenever you want to.',
      scope,
    ),
  );
}

/**
 * The sentence an unanswered prompt-scope modal shows, the same outcome as
 * declining the confirmation list: one message, nothing sent, nothing created.
 *
 * It names the setting and the three answers the modal offered, so the user can
 * either run the command again or set the scope by hand — "the user did not
 * answer" must never leave them without a way forward.
 */
function reportPromptScopeNotChosen(): void {
  void vscode.window.showInformationMessage(
    vscode.l10n.t(
      'The AI pre-review did not start: no prompt scope was chosen, so nothing was requested, nothing was sent and nothing was created, and the setting "forgejoToolkit.aiPreReviewPromptScope" was left at "ask". Run the command again and answer the question, or set that setting by hand — "changed-files", "changed-lines-only", "full-diff" or "metadata-only".',
    ),
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
  // The same seam reads the run uses, and the same reporting for the two ways of
  // having no API ("no language model API", "the listing failed") and for an empty
  // list; this command only differs in what it does with an answer.
  const availability = await vscodeLmTransport.availability();
  if (!availability.usable) {
    void vscode.window.showErrorMessage(availability.reason);
    return;
  }
  const offered = await vscodeLmTransport.listModels();
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
 * instruction block — the one this run prepared, for the user's language — in
 * that model's own tokenizer and refuse the run when it cannot hold it.
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
  transport: AiModelTransport,
  model: AiModelInfo,
  systemPrompt: string,
): Promise<AiPreReviewChosenModel | undefined> {
  const identity = aiPreReviewModelIdentity(model);
  const availableTokens = maxInputTokensOf(model);
  let instructionTokens: number | undefined;
  try {
    instructionTokens = await transport.countTokens(model, systemPrompt);
  } catch (error) {
    logger.debug(
      `AI pre-review: could not count the instructions for ${modelLabel(model)} (${userFacingErrorMessage(error)})`,
    );
    reportChosenModelNotMeasurable(identity);
    return undefined;
  }
  // The seam's two "no number" arms are different things (§4.2): a **throw** was
  // reported above as "could not measure", while `undefined` means this model has
  // no tokenizer at all — there is nothing to compare, so no budget failure is
  // declared and the run proceeds with the number it does not have. That is what
  // the code did before the seam existed, where such a value simply failed the
  // `>=` comparison.
  if (instructionTokens !== undefined && instructionTokens >= availableTokens) {
    reportInstructionBudgetFailure({ model: identity, neededTokens: instructionTokens, availableTokens });
    return undefined;
  }
  if (instructionTokens !== undefined) {
    logger.debug(
      `AI pre-review: the fixed instruction prompt costs ${instructionTokens} token(s) for ${modelLabel(model)}, whose input budget is ${availableTokens}`,
    );
  }
  return { model, instructionTokens };
}

/**
 * What one model's tokenizer charges for the request this run would send: the
 * exact text of the single message (`aiPreReviewPromptText`), the run's
 * instruction half included.
 *
 * Not the sum of two separate `countTokens` calls, which is how the request used
 * to be measured when it was two messages: the request is one string now, and
 * the number the budget failure reports has to be the number the model is
 * actually handed, or the guidance that message gives is off by whatever the
 * two halves cost together rather than apart. The instruction half is passed in
 * rather than rebuilt here, so the bytes measured are the bytes the request will
 * carry.
 */
async function countRequestTokens(
  transport: AiModelTransport,
  model: AiModelInfo,
  systemPrompt: string,
  userPrompt: string,
): Promise<number | undefined> {
  return await transport.countTokens(model, aiPreReviewPromptText(systemPrompt, userPrompt));
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
 * The per-file facts the confirmation panel's "open the diff" link needs.
 *
 * One entry per changed file, so a candidate can be resolved by its path alone:
 * the status decides whether the base side is the file's old name, and the two
 * shas are the pull request's own. Read here, while the same response that
 * produced the diff is still the one in hand, rather than by the panel later —
 * a second read could see a head the run's diff did not come from.
 */
function changedFileDiffTargets(
  changedFiles: readonly ForgejoChangedFile[],
  pullRequest: ForgejoPullRequestDetail,
): Map<string, { status?: string; previousPath?: string; baseSha?: string; headSha?: string }> {
  const targets = new Map<string, { status?: string; previousPath?: string; baseSha?: string; headSha?: string }>();
  const baseSha = pullRequest.base?.sha;
  const headSha = pullRequest.head?.sha;
  for (const file of changedFiles) {
    const path = file.filename ?? '';
    if (path === '') {
      continue;
    }
    targets.set(path, { status: file.status, previousPath: file.previous_filename, baseSha, headSha });
  }
  return targets;
}

/** What the prompt builders need for one scope: which sections, and how. */
interface AiPreReviewPromptSections {
  diffText?: string;
  diffBody?: AiPreReviewDiffBodyMode;
  fileContents?: AiPreReviewFileContents;
}

/**
 * The one place a stated scope turns into prompt sections — the whole of "what
 * may leave the machine" as code.
 *
 * `metadata-only` returns nothing but the brief: no diff body, no file text, so
 * the model sees the changed-file table and the existing comments' metadata and
 * cannot read a single changed line. `changed-lines-only` sends the diff with
 * its context lines removed. `full-diff` sends the diff as the old diff-body
 * switch did. `changed-files` sends the full diff **and** the head text of the
 * changed files themselves, which is the only scope under which the model can
 * see the code around a change (error handling outside the hunk, callers in the
 * same file, conventions).
 *
 * The four **stated** scopes are four different egress
 * decisions, so a fifth one has to be a compile error here rather than a
 * silent fallback to sending the diff.
 */
async function promptSectionsForScope(
  client: ForgejoClient,
  params: PullRequestTarget,
  pullRequest: ForgejoPullRequestDetail,
  brief: AiPreReviewBrief,
  diffText: string,
  scope: AiPreReviewStatedScope,
  token: vscode.CancellationToken,
): Promise<AiPreReviewPromptSections> {
  switch (scope) {
    case 'metadata-only':
      return {};
    case 'changed-lines-only':
      return { diffText, diffBody: 'changed-lines-only' };
    case 'full-diff':
      return { diffText, diffBody: 'full' };
    case 'changed-files': {
      const fileContents = await collectChangedFileContents(client, params, pullRequest, brief, token);
      return { diffText, diffBody: 'full', fileContents };
    }
  }
}

/**
 * Reads the head text of the files the brief lists, for the `changed-files`
 * scope.
 *
 * Only files the brief already lists are read, and at most
 * `AI_PRE_REVIEW_MAX_CONTENT_FILES` of them: the brief's own row cap and
 * character budget have already cut the list, and this cap bounds the number of
 * requests a pull request with hundreds of changed files can cause. When the
 * brief lists more files than the cap, the result says so (`row-limit`), so the
 * prompt states that the file texts are partial.
 *
 * The `ref` is the pull request's own head sha, never the default branch: the
 * scope promises *this* pull request's version of each file, and reading `main`
 * would send code the review is not about. A pull request whose head lives in
 * another repository (a fork), or one the server describes without a head sha,
 * therefore contributes no file texts at all and says so, rather than reading
 * whatever the branch happens to hold.
 *
 * A file whose head version cannot be read — deleted in the pull request, a
 * binary or withheld payload, a path the contents API refuses — is counted as
 * `unavailable` and left out. Fewer files shown is the honest failure; a text
 * that is not the head version would be a wrong one.
 */
async function collectChangedFileContents(
  client: ForgejoClient,
  params: PullRequestTarget,
  pullRequest: ForgejoPullRequestDetail,
  brief: AiPreReviewBrief,
  token: vscode.CancellationToken,
): Promise<AiPreReviewFileContents> {
  const paths = brief.files.slice(0, AI_PRE_REVIEW_MAX_CONTENT_FILES).map((file) => file.path);
  const texts = new Map<string, string>();
  const headSha = pullRequest.head?.sha;
  const headRepo = pullRequest.head?.repo?.full_name;
  const sameRepository = headRepo === undefined || headRepo === `${params.owner}/${params.repo}`;

  if (typeof headSha !== 'string' || headSha === '' || !sameRepository) {
    logger.info(
      `AI pre-review: the pull request's head version cannot be read here (head repository ${headRepo ?? 'unknown'}, head sha ${headSha ?? 'unknown'}), so the ${paths.length} changed file(s) are not sent as file contents`,
    );
    return buildAiPreReviewFileContents({ paths, texts });
  }

  for (const path of paths) {
    if (token.isCancellationRequested) {
      // The caller's own cancellation check turns this into the cancelled arm;
      // stopping here only means no further request is made for a run that is
      // already over.
      break;
    }
    try {
      const result = await client.getFileContentResult(params.owner, params.repo, path, headSha);
      if (result.kind === 'file') {
        texts.set(path, result.text);
      } else {
        logger.debug(
          `AI pre-review: ${path} is not a regular file at the head version (${result.kind}), so it is left out of the file contents`,
        );
      }
    } catch (error) {
      logger.debug(
        `AI pre-review: ${path} could not be read at the head version (${userFacingErrorMessage(error)}), so it is left out of the file contents`,
      );
    }
  }

  const contents = buildAiPreReviewFileContents({ paths, texts });
  if (brief.files.length > paths.length) {
    // The brief listed more files than this scope reads: the prompt has to say
    // the file texts are partial, even when the character budget cut nothing.
    contents.truncatedBy = contents.truncatedBy ?? 'row-limit';
  }
  return contents;
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
 * The cancellation token is checked after every await that can be slow, and it is
 * adapted to the seam's `AbortSignal` (§4.1, constraint 1) so the transport hands
 * it to `sendRequest` and the provider stops the stream itself. A run cancelled
 * here can therefore never reach the confirmation list, let alone the write loop.
 *
 * `diagnostics` receives one block per model call — the messages that went out
 * and the whole answer that came back — and is a no-op unless
 * `forgejoToolkit.debug` is on (see `createRunDiagnostics`). It is written
 * *before* each arm returns, so a run that ends at the first attempt still
 * leaves the evidence behind.
 */
/**
 * The seam's cancellation signal for one run (§4.1, constraint 1).
 *
 * The seam carries an `AbortSignal` (§4.2) while this run is handed a
 * `vscode.CancellationToken` by `withProgress`, so the token is mirrored onto a
 * controller: already aborted when the token already is, and aborted when the
 * token is cancelled later. The transport converts the signal back into the token
 * shape `sendRequest` takes, so the provider still stops producing itself, and
 * the read loop asks the same fact (`signal.aborted`) before every step.
 */
function abortSignalForToken(token: vscode.CancellationToken | undefined): AbortSignal | undefined {
  if (!token) {
    return undefined;
  }
  const controller = new AbortController();
  if (token.isCancellationRequested) {
    controller.abort();
    return controller.signal;
  }
  token.onCancellationRequested(() => controller.abort());
  return controller.signal;
}

async function gatherPreReviewRequest(
  transport: AiModelTransport,
  client: ForgejoClient,
  params: PullRequestTarget,
  candidate: AiPreReviewChosenModel,
  scope: AiPreReviewStatedScope,
  systemPrompt: string,
  progress: vscode.Progress<{ message?: string; increment?: number }>,
  token: vscode.CancellationToken,
  diagnostics: AiPreReviewDiagnostics,
): Promise<GatheredPreReview> {
  // The scope is stated from the first line: this run reads **every** changed
  // file and the whole diff, which is exactly why its entry point is the pull
  // request detail page rather than a file's context menu (§6.1). The count is
  // not known yet — the fetch has not been issued — so the second report below
  // carries it.
  progress.report({ message: vscode.l10n.t('Reading the whole pull request…') });

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
  /**
   * How many changed files this run read, i.e. the ones the brief lists and the
   * anchors are validated against. Every arm returned from here on carries it,
   * so no message the run shows has to guess how much of the pull request it
   * covered (see `GatheredPreReview`).
   */
  const changedFileCount = brief.files.length;

  const sections = await promptSectionsForScope(client, params, pullRequest, brief, diffText, scope, token);
  if (token.isCancellationRequested) {
    return { kind: 'cancelled', changedFileCount };
  }

  const identity = aiPreReviewModelIdentity(candidate.model);
  const identityLabel = formatAiPreReviewModelIdentity(identity);
  // The prompt is prepared **once** for the whole run: every attempt asks the
  // same model the same question, so the messages have to be the same bytes for
  // "same model, same prompt" to mean what the record says it means. The
  // instruction half is the run's own, built for the user's language; the other
  // half is the brief this run assembled.
  const prepared = await preparePrompt(transport, brief, candidate, sections, systemPrompt);
  if (token.isCancellationRequested) {
    return { kind: 'cancelled', changedFileCount };
  }
  if (prepared.kind === 'budget') {
    // Nothing was sent: this run's one model cannot take even the shortest
    // prompt, and the caller reports both numbers rather than substituting a
    // model the user did not choose.
    return { kind: 'budget', failure: prepared.failure, changedFileCount };
  }

  // The messages are built once and handed to both the provider and the dump, so
  // "what the dump shows" is the request itself and not a reconstruction of it
  // that could drift from the real thing. Every attempt hands over this array.
  //
  // The dump records the **effective** `vscode.lm` request — one `User` message
  // carrying the instructions and then the request (`buildAiPreReviewPromptMessages`,
  // which is exactly what the transport sends below), while the seam request keeps
  // the instruction block and the request apart so a transport with a system role
  // can use it. Both are the same bytes.
  const messages = buildAiPreReviewPromptMessages(systemPrompt, prepared.userPrompt);
  const completionRequest: AiCompletionRequest = {
    system: systemPrompt,
    messages: [{ role: 'user', text: prepared.userPrompt }],
    // The API's consent-dialog text, which is why the wording stays here rather
    // than in the transport (§5.3: it does not change) and why it travels as the
    // request's `purpose`: the seam has no other field for "why this request is
    // being made" (§4.2).
    purpose: vscode.l10n.t(
      'The AI pre-review sends the metadata of this pull request and, depending on the prompt scope you chose in "forgejoToolkit.aiPreReviewPromptScope", the changed lines or the text of the changed files, to the model to draft line-level review comments for you to confirm.',
    ),
    signal: abortSignalForToken(token),
  };
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
    progress.report({
      message: vscode.l10n.t(
        'Asking the chat model to review the whole pull request ({0} changed file(s))…',
        changedFileCount,
      ),
    });
    const startedAt = new Date();
    const answer = await requestPreReviewComments(transport, candidate.model, completionRequest);
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
      return { kind: 'cancelled', changedFileCount };
    }
    if (answer.kind === 'failed') {
      await diagnostics.attempt({
        ...recorded,
        answer: '',
        outcome: `model call failed: ${answer.error}`,
        candidates: answer.candidates,
      });
      // A failing model call is not a shape problem, so it does not start a
      // retry — not of this model and, now, not of any other one either: the
      // caller reports the reason it already classified (§9.3).
      return answer;
    }

    // The contract arbitrates: the text candidate is tried first, then the
    // reasoning candidate, and only then the `text` projection (which is a
    // candidate of its own, so it is judged by the same rule rather than
    // trusted). Every candidate is scored on its own bytes — no concatenation of
    // the two, no repair, and no other model. The predicate is the contract
    // itself, so a candidate that parses is the answer and anything else is a
    // failure with its own bounded excerpt.
    const selection = pickResponseCandidate(
      answer.candidates,
      (candidate) => parseAiPreReviewResponse(candidate.text).kind === 'ok',
    );
    // Behind the same gate the rest of the diagnostic obeys: with
    // `forgejoToolkit.debug` off, which stream was used does not reach the channel
    // either.
    if (logger.isDebugEnabled()) {
      logger.debug(responseCandidateSelectionLogLine(selection));
    }
    const chosenText = selection.candidate?.text ?? '';
    // The fragment list describes the transport of the stream the answer came
    // from — which is why it is written after the arbitration and not before it —
    // and it is written only for a stream that was read to its end: an aborted
    // sweep, or a call that returned no candidate at all, carries no fragment
    // list and therefore logs none of these lines.
    if (answer.fragments !== undefined) {
      logAnswerFragments(answer.fragments, chosenText, chosenText.length);
    }
    const parsed = parseAiPreReviewResponse(chosenText);
    if (parsed.kind === 'ok') {
      await diagnostics.attempt({
        ...recorded,
        answer: chosenText,
        outcome: `the contracted JSON, with ${parsed.comments.length} proposed comment(s)`,
        notes: [`answer stream: ${responseCandidateKindLabel(selection.candidate?.kind ?? 'text')}`],
        candidates: answer.candidates,
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
      return {
        kind: 'parsed',
        comments: parsed.comments,
        brief,
        pullRequestTitle: pullRequest.title,
        diffTargets: changedFileDiffTargets(changedFiles, pullRequest),
        changedFilesTotal: changedFiles.length,
      };
    }

    // One distinct log line per failure kind, each naming the model, which ask
    // of it this was, how long the answer was and a bounded excerpt of it — that
    // excerpt is the one piece of answer text the Output Channel ever carries,
    // and only on this failure path. The prompt, the brief and the diff never
    // reach it, a successful run quotes nothing, and the dump (debug only, a file
    // rather than the channel) is where the whole answer goes.
    logger.error(
      `${contractFailureLogLine(identity, parsed, chosenText)} (attempt ${attempt} of ${AI_PRE_REVIEW_MAX_ATTEMPTS_PER_MODEL} for the chosen model)`,
    );
    const shape = describeAiPreReviewAnswerShape(chosenText);
    logger.debug(`AI pre-review: ${identityLabel} answer shape: ${shape}`);
    await diagnostics.attempt({
      ...recorded,
      answer: chosenText,
      outcome: `contract violation: ${describeContractFailurePlainly(parsed)}`,
      notes: [`answer shape: ${shape}`, selection.reason],
      candidates: answer.candidates,
    });
    failedAttempts.push({ model: identity, attempt, failure: parsed });
  }

  return { kind: 'unparsed', attempts: failedAttempts, changedFileCount };
}

/**
 * Builds the prompt and cuts it to the chosen model's input budget (§7.2).
 *
 * A prompt that does not fit is reduced by **file granularity**: whole files
 * (their line of the changed-file table and every section the stated scope gave
 * them — the diff block, the file's own text) are dropped from the end until
 * `countTokens` says it fits. The brief's own truncation note then says so,
 * because a model that is shown part of a change must know it is part of a
 * change.
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
  transport: AiModelTransport,
  brief: AiPreReviewBrief,
  candidate: AiPreReviewChosenModel,
  sections: AiPreReviewPromptSections,
  systemPrompt: string,
): Promise<PreparedPrompt> {
  const available = maxInputTokensOf(candidate.model);
  const needed = async (prompt: string): Promise<number | undefined> =>
    await countRequestTokens(transport, candidate.model, systemPrompt, prompt);

  let files: AiPreReviewBriefFile[] = brief.files;
  let current = buildAiPreReviewUserPrompt({ ...brief, files, truncatedBy: undefined }, sections);
  let total = await needed(current);

  // Dropped from the end. The list order is the server's, not a ranking of
  // importance, so dropping from either end is arbitrary; the end is chosen
  // because it is stable and the note says exactly how many were dropped.
  //
  // An absent measurement (`undefined`, the seam's "no tokenizer" arm) never
  // triggers a cut and never reports a budget failure: there is no number to
  // compare, which is the same outcome the old `undefined > available` comparison
  // produced.
  while (total !== undefined && total > available && files.length > 1) {
    files = files.slice(0, files.length - 1);
    current = buildAiPreReviewUserPrompt({ ...brief, files, truncatedBy: 'token-budget' }, sections);
    total = await needed(current);
  }
  if (total !== undefined && total > available) {
    // Everything left still does not fit: the run reports the budget failure
    // honestly instead of sending an oversized request.
    logger.error(
      `AI pre-review: the shortest prompt for this pull request needs ${total} tokens but the chosen model's input budget is ${available}`,
    );
    return { kind: 'budget', failure: { neededTokens: total, availableTokens: available } };
  }
  return { kind: 'ready', userPrompt: current };
}

/**
 * What one model call produced. Every arm is reported to the user exactly once.
 *
 * The successful arm carries the candidate streams beside the chosen answer, and
 * not only the text: the caller has to record **both** candidates in the
 * diagnostics dump, and it has to know which stream the answer came from in order
 * to name it in the debug log.
 */
type ModelAnswer =
  | { kind: 'answer'; candidates: AiPreReviewResponseCandidate[]; fragments?: readonly string[] }
  | { kind: 'cancelled' }
  | { kind: 'failed'; error: string; reported: boolean; candidates: AiPreReviewResponseCandidate[] };

/**
 * The seam's one request for this run, and the arms the feature reads.
 *
 * The body itself moved: `vscode.lm`'s `sendRequest`, the message mapping, the
 * response reading and the candidate collection all live in
 * `src/ai/vscodeLmTransport.ts` now (`docs/design/ai-model-transport.md` §5.1's
 * move table). What stays here is the **classification** of a rejection — the
 * seam's `complete()` has no failure arm, so a failed call arrives as a thrown
 * error, and only the feature knows which of its own messages to show and whether
 * it has already shown one (`reported`).
 *
 * `isCancellation`'s reading is unchanged and deliberately not `instanceof`: a
 * cancellation is recognised by `name`/`code`/message, which is the same rule the
 * OpenAI-compatible transport has to satisfy (§6.5). A transport that observed a
 * cancellation while reading throws an `AbortError` for exactly this path.
 */
async function requestPreReviewComments(
  transport: AiModelTransport,
  model: AiModelInfo,
  request: AiCompletionRequest,
): Promise<ModelAnswer> {
  try {
    const result = await transport.complete(model, request);
    return { kind: 'answer', candidates: result.parts, fragments: result.fragments };
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
    return { kind: 'failed', error: 'NoPermissions', reported: true, candidates: [] };
  }
  if (isCancellation(error)) {
    return { kind: 'cancelled' };
  }
  // Blocked / NotFound / anything else: one log line for diagnosis, one generic
  // error for the user, and never a heuristic substitute for the model.
  return { kind: 'failed', error: userFacingErrorMessage(error), reported: false, candidates: [] };
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
 * one; the rest are appended. A failure part-way through stops the run and
 * **keeps** what was already written, because those are real server objects and
 * deleting them would be an irreversible second write.
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
  params: PullRequestTarget,
  confirmed: readonly AiPreReviewCandidate[],
  dropped: readonly AiPreReviewDrop[],
): Promise<{ created: number; failure?: string }> {
  const instance = config.getInstances().find((candidate) => candidate.id === params.instanceId);
  if (!instance) {
    void vscode.window.showErrorMessage(vscode.l10n.t('Forgejo instance not found'));
    return { created: 0, failure: vscode.l10n.t('Forgejo instance not found') };
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
    return { created: 0, failure: err };
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
    return { created: outcome.written, failure: outcome.failure.reason };
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
  return { created: outcome.written };
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
  params: PullRequestTarget,
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
 * The same breakdown, unjoined and already localized, for the confirmation
 * panel's header: one line per reason with its own count, which is what "grouped
 * by reason" has to mean for the panel to be more transparent than the quick
 * pick was. The labels come from `describeDropReason`, so the panel and the
 * run's own messages cannot name a reason differently.
 */
function droppedLabels(dropped: readonly AiPreReviewDrop[]): { label: string; count: number }[] {
  return dropped.map((entry) => ({ label: vscode.l10n.t(describeDropReason(entry.reason)), count: entry.count }));
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
