import * as vscode from 'vscode';
import { logger } from './logger';
import { userFacingErrorMessage } from './api/errors';
import { resolveLocale } from './utils/resolveLocale';
import { buildForgejoPrDiffUri } from './webview/diffUri';
import { isSafeRepoPath } from './webview/repoIdentity';
import { getWebviewContent } from './webview/content';
import { PR_REVIEW_MAX_COMMENT_LENGTH } from '@cpf23333-forgejo-toolkit/shared/limits';
import type {
  AiPreReviewPanelCandidate,
  AiPreReviewPanelPayload,
  AiPreReviewPanelSelectedBody,
  HostToWebviewMessage,
} from '@cpf23333-forgejo-toolkit/shared/webview/messages';

/**
 * The AI pre-review's confirmation step, as an editor-tab panel.
 *
 * It replaces the multi-select quick pick that used to be the run's write gate.
 * The quick pick shipped each candidate's **body inside its label**, which VS
 * Code truncates, with no `description` and no `tooltip` to hold the rest — so a
 * person could not read what they were about to accept, which the acceptance run
 * showed directly. The panel gives every candidate the room its body needs, and
 * it can state the things the quick pick had no surface for at all: which pull
 * request, which model answered (with its vendor), which prompt scope the run
 * actually used, how many candidates survived validation and how many were
 * dropped, grouped by reason.
 *
 * Three properties this module exists to guarantee:
 *
 * 1. **Nothing is created unconfirmed.** The decision resolves `cancel` for every
 *    "not answered" path — the cancel button and the tab being closed (VS Code
 *    disposes the panel) — and the run turns `cancel` into "nothing was written",
 *    exactly as declining the quick pick did. There is no default answer and no
 *    pre-checked card.
 * 2. **The webview may propose a body, never an anchor.** Its answer names the
 *    cards the user checked and carries the body each one is to be created with —
 *    the model's wording or the user's edit of it, so a wording can be fixed
 *    before it exists as a draft rather than corrected in the diff afterwards
 *    (2026-10-02). Paths, lines, sides and shas never travel in the answer at all:
 *    they come from the host's own copy of the payload, so a forged or modified
 *    message can select a card and propose text for it, but cannot move a comment
 *    to another file, line or side. Every entry is re-validated here — the index
 *    must be one this panel offered, the body a string that is non-empty after
 *    trimming and within `PR_REVIEW_MAX_COMMENT_LENGTH` — and **the whole Create
 *    is refused, creating nothing, if any entry fails**: a partly honoured answer
 *    would write comment text the user did not agree to.
 * 3. **The panel is not the writer.** It hands its answer back and the run keeps
 *    its existing write path (pending review only, never a submit). After the
 *    write the run reports the outcome here, and the panel offers the way to the
 *    drafts; it never touches the server itself.
 *
 * The extension contributes **no accept-all control** of its own here, and
 * nothing is pre-checked. The platform's `Toggle all checkboxes` control belonged
 * to VS Code's multi-select quick pick, which this panel does not use — so with
 * the panel in place the guarantee is the plain one: nothing is selected until
 * the user selects it.
 *
 * One thing this panel deliberately does **not** do, unlike the review-comment
 * editor: it does not follow a `forgejoToolkit.locale` change made while it is
 * open. Its whole job is one answer, the document is built in the locale resolved
 * at that moment, and that answer is read once — repainting a question the user
 * is already reading buys nothing. The next run opens the panel in the new
 * language.
 */
export class AiPreReviewPanel implements vscode.Disposable {
  public static readonly viewType = 'forgejoToolkitAiPreReview';

  private readonly _panel: vscode.WebviewPanel;
  private readonly _disposables: vscode.Disposable[] = [];
  private readonly _decision: Promise<AiPreReviewPanelDecision>;
  private _settleDecision: ((decision: AiPreReviewPanelDecision) => void) | undefined;
  /** Whether the answer has already been given; the first one wins. */
  private _answered = false;
  private _disposed = false;

  /**
   * Opens one panel for one run.
   *
   * `host` is what the "open the pull request" action calls once drafts exist;
   * without it the panel simply does not offer that action (the payload's
   * `canOpenPullRequest` says so), which is the honest thing to show rather than
   * a button that does nothing.
   */
  public static createOrShow(
    extensionUri: vscode.Uri,
    payload: AiPreReviewPanelPayload,
    host?: AiPreReviewPanelNavigation,
  ): AiPreReviewPanel {
    const panel = vscode.window.createWebviewPanel(
      AiPreReviewPanel.viewType,
      vscode.l10n.t('AI pre-review: review the proposed comments'),
      vscode.ViewColumn.Beside,
      {
        enableScripts: true,
        localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'out', 'webview')],
        // The webview keeps its checked boxes while the user reads the diff in
        // the other tab; without this, switching editors would reset them.
        retainContextWhenHidden: true,
      },
    );
    return new AiPreReviewPanel(panel, extensionUri, payload, host);
  }

  private constructor(
    panel: vscode.WebviewPanel,
    private readonly _extensionUri: vscode.Uri,
    private readonly _payload: AiPreReviewPanelPayload,
    private readonly _host?: AiPreReviewPanelNavigation,
  ) {
    this._panel = panel;
    this._decision = new Promise<AiPreReviewPanelDecision>((resolve) => {
      this._settleDecision = resolve;
    });
    this._update();
    this._panel.onDidDispose(() => this.dispose(), null, this._disposables);
    this._panel.webview.onDidReceiveMessage((message) => void this._handleMessage(message), null, this._disposables);
  }

  /**
   * The user's answer, or `cancel` when the panel is closed without one.
   *
   * Resolves exactly once: the first answer wins, and a dispose after an answer
   * leaves it alone (so a `create` the run is already acting on cannot be turned
   * into a cancel by the user closing the tab a moment later).
   */
  public get decision(): Promise<AiPreReviewPanelDecision> {
    return this._decision;
  }

  /** Tells the panel what the run's write produced, and offers the drafts. */
  public reportResult(result: { created: number; failure?: string }): void {
    this._post({
      command: 'aiPreReviewPanelResult',
      created: result.created,
      ...(result.failure !== undefined ? { failure: result.failure } : {}),
    });
  }

  /**
   * Tells the panel that a Create was refused as a whole and nothing was written.
   *
   * The question stays open on purpose: the reason names the card that failed, so
   * the user can fix that body (or restore the model's wording) and press Create
   * again. This is the same answer the panel's own disabled state gives for a body
   * it knows is empty or over the cap; it is stated here as well because the host
   * is what enforces the rule.
   */
  public reportRejected(reason: string): void {
    this._post({ command: 'aiPreReviewPanelRejected', reason });
  }

  public dispose(): void {
    if (this._disposed) {
      return;
    }
    this._disposed = true;
    this._answer({ kind: 'cancel' });
    while (this._disposables.length > 0) {
      this._disposables.pop()?.dispose();
    }
    // `dispose()` on the panel is what VS Code called us for when the user closed
    // the tab; calling it here for the host's own disposal is idempotent.
    this._panel.dispose();
  }

  /** Records the answer once and resolves the run's promise with it. */
  private _answer(decision: AiPreReviewPanelDecision): void {
    if (this._answered) {
      return;
    }
    this._answered = true;
    this._settleDecision?.(decision);
    this._settleDecision = undefined;
  }

  private async _handleMessage(message: unknown): Promise<void> {
    const command =
      message && typeof message === 'object' && typeof (message as { command?: unknown }).command === 'string'
        ? (message as { command: string }).command
        : undefined;
    logger.debug(`Received message from AI pre-review panel: ${String(command)}`);
    switch (command) {
      case 'aiPreReviewPanelCreate': {
        const selection = selectPanelEntries((message as { entries?: unknown }).entries, this._payload.candidates);
        if (selection.kind === 'empty') {
          // Nothing checked is not an answer: the run would create nothing and
          // report it as cancelled, which reads better from the Cancel button.
          // The panel keeps the decision open so the user can still choose.
          logger.debug('AI pre-review panel: the answer named no card, so nothing was created');
          return;
        }
        if (selection.kind === 'rejected') {
          const reason = describePanelSelectionFailure(selection.failure, this._payload.candidates);
          if (isPanelAnswerViolation(selection.failure)) {
            // An offered card and a string body are things a legitimate panel
            // always sends; anything else means the message was modified, which
            // is exactly the case the re-validation exists for.
            logger.error(`AI pre-review panel: refused the create: ${reason}`);
          } else {
            logger.debug(`AI pre-review panel: refused the create: ${reason}`);
          }
          this.reportRejected(reason);
          return;
        }
        this._answer({ kind: 'create', entries: selection.entries });
        return;
      }
      case 'aiPreReviewPanelCancel':
        this._answer({ kind: 'cancel' });
        return;
      case 'aiPreReviewPanelOpenDiff':
        await this._openDiff((message as { index?: unknown }).index);
        return;
      case 'aiPreReviewPanelOpenDraft':
        this._host?.revealPullRequestDetail({
          instanceId: this._payload.instanceId,
          owner: this._payload.owner,
          repo: this._payload.repo,
          index: this._payload.index,
        });
        return;
      default:
        return;
    }
  }

  /**
   * Opens one card's anchor: the file's diff, revealed at the commented line.
   *
   * The candidate is looked up in the host's own payload by index — the message
   * carries nothing else — and every field that reaches a URI is re-validated
   * here, because opening a document is a side effect a forged message must not
   * be able to direct. A missing sha, an unsafe path or an unknown index is a
   * no-op with a log line: the link is an affordance, not a write.
   */
  private async _openDiff(index: unknown): Promise<void> {
    const candidate =
      typeof index === 'number' && Number.isInteger(index)
        ? this._payload.candidates.find((entry) => entry.index === index)
        : undefined;
    if (!candidate) {
      logger.debug(`AI pre-review panel: no candidate is at index ${String(index)}; the diff was not opened`);
      return;
    }
    const { status, previousPath, baseSha, headSha } = candidate.diff ?? {};
    if (typeof headSha !== 'string' || headSha === '' || typeof baseSha !== 'string' || baseSha === '') {
      logger.debug(`AI pre-review panel: ${candidate.path} has no base/head sha; the diff was not opened`);
      return;
    }
    if (!isSafeRepoPath(candidate.path) || (previousPath !== undefined && !isSafeRepoPath(previousPath))) {
      logger.error(`AI pre-review panel: refusing to open a diff for an unsafe path (${candidate.path})`);
      return;
    }
    // A renamed file only exists under its old path at the base ref, exactly as
    // the dashboard's own "open diff" handler does it.
    const basePath = status === 'renamed' && previousPath ? previousPath : candidate.path;
    try {
      const baseUri = buildForgejoPrDiffUri({
        instanceId: this._payload.instanceId,
        owner: this._payload.owner,
        repo: this._payload.repo,
        index: this._payload.index,
        ref: baseSha,
        filepath: basePath,
        isBase: true,
        status,
      });
      const headUri = buildForgejoPrDiffUri({
        instanceId: this._payload.instanceId,
        owner: this._payload.owner,
        repo: this._payload.repo,
        index: this._payload.index,
        ref: headSha,
        filepath: candidate.path,
        isBase: false,
        status,
      });
      await vscode.commands.executeCommand(
        'vscode.diff',
        baseUri,
        headUri,
        `${candidate.path} (#${this._payload.index})`,
      );
      // The anchor's number belongs to its own side of the diff, so the reveal
      // goes to that side's document: showing a base line number in the head
      // document would point at a different line.
      const uri = candidate.side === 'base' ? baseUri : headUri;
      const lastLine = candidate.line + candidate.extraLines;
      await vscode.window.showTextDocument(uri, {
        selection: new vscode.Range(candidate.line - 1, 0, lastLine - 1, 0),
        preview: false,
      });
    } catch (error) {
      const err = userFacingErrorMessage(error);
      logger.error(`AI pre-review panel could not open the diff for ${candidate.path}: ${err}`);
      void vscode.window.showErrorMessage(vscode.l10n.t('Unable to open diff: {0}', err));
    }
  }

  /**
   * Renders the panel's document.
   *
   * The payload travels in `__FORGEJO_TOOLKIT_CONFIG__` exactly like the
   * review-comment editor's context, so the first paint shows the candidates
   * without a round trip; `aiPreReviewPanelPayload` exists for a payload that has
   * to be replaced later (a re-run reusing the panel would use it).
   */
  private _update(): void {
    const configured = vscode.workspace.getConfiguration('forgejoToolkit').get<'en' | 'zh' | undefined>('locale');
    const locale = resolveLocale(configured);
    this._panel.webview.html = getWebviewContent(this._panel.webview, this._extensionUri.fsPath, {
      panelMode: 'aiPreReview',
      locale,
      aiPreReview: { ...this._payload, canOpenPullRequest: this._host !== undefined },
    });
  }

  private _post(message: HostToWebviewMessage): void {
    if (this._disposed) {
      return;
    }
    // The reply is dropped rather than awaited: nobody can consume it any more,
    // and an unhandled rejection out of a disposed webview would surface in the
    // extension host (the review-comment panel guards the same hazard).
    void Promise.resolve(this._panel.webview.postMessage(message)).catch(() => undefined);
  }
}

/** Where the panel's "open the pull request" action navigates. */
export interface AiPreReviewPanelNavigation {
  revealPullRequestDetail(payload: { instanceId: string; owner: string; repo: string; index: number }): void;
}

/** What the panel's answer is: the checked cards with their bodies, or nothing at all. */
export type AiPreReviewPanelDecision = { kind: 'create'; entries: AiPreReviewPanelSelectedBody[] } | { kind: 'cancel' };

/** Why one entry of a Create answer cannot be honoured. */
export type AiPreReviewPanelSelectionFailure =
  | { kind: 'not-an-entry'; position: number }
  | { kind: 'index-not-offered'; position: number }
  | { kind: 'duplicate-index'; index: number }
  | { kind: 'body-not-a-string'; index: number }
  | { kind: 'body-empty'; index: number }
  | { kind: 'body-too-long'; index: number; length: number };

/**
 * What one Create answer amounts to.
 *
 * `empty` is not a refusal: an answer that names no card is not an answer at all,
 * and the panel keeps its question so the user can still choose (the Create button
 * is disabled with nothing checked, so this arm is defence in depth). `rejected`
 * is a refusal of the **whole** answer, and the run must then create nothing.
 */
export type AiPreReviewPanelSelection =
  | { kind: 'selected'; entries: AiPreReviewPanelSelectedBody[] }
  | { kind: 'empty' }
  | { kind: 'rejected'; failure: AiPreReviewPanelSelectionFailure };

/**
 * The entries of a Create answer, validated against the cards this panel offered.
 *
 * The webview is untrusted input of the same rank as any other message, and since
 * 2026-10-02 its answer carries **body text** as well as indexes, so this function
 * is what stands between a modified message and a draft:
 *
 * - an index that is not one of the cards this panel showed is refused — the
 *   message may select what it was offered and nothing else;
 * - the same index twice is refused rather than collapsed, because two bodies for
 *   one card have no defensible resolution and silently picking one would write
 *   text the user never saw chosen;
 * - the body must be a **string**, **non-empty after trimming** and **within
 *   `PR_REVIEW_MAX_COMMENT_LENGTH`** (the same constant the brief cuts with and
 *   the panel's editor caps at). The trimmed value is only what the emptiness test
 *   measures: the body is written exactly as it arrived, so the user's own leading
 *   or trailing whitespace is theirs to keep.
 * - every other field of an entry is ignored outright. Anchors — path, line, side,
 *   extra lines — and shas are never read from the message; the caller takes them
 *   from its own copy of the payload.
 *
 * Refusing the whole answer rather than dropping the bad entry is deliberate: a
 * card the user ticked and whose text was refused must not quietly disappear from
 * the set that gets written, because the number of drafts the panel promised
 * ("Create N draft comment(s)") is what the user is watching. The order is the
 * payload's own, so the drafts are created in the order the cards were shown.
 */
export function selectPanelEntries(
  value: unknown,
  candidates: readonly AiPreReviewPanelCandidate[],
): AiPreReviewPanelSelection {
  if (!Array.isArray(value) || value.length === 0) {
    return { kind: 'empty' };
  }
  const offered = new Set(candidates.map((candidate) => candidate.index));
  const bodies = new Map<number, string>();
  for (const [position, entry] of value.entries()) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      return { kind: 'rejected', failure: { kind: 'not-an-entry', position } };
    }
    const { index, body } = entry as { index?: unknown; body?: unknown };
    if (typeof index !== 'number' || !Number.isInteger(index) || !offered.has(index)) {
      return { kind: 'rejected', failure: { kind: 'index-not-offered', position } };
    }
    if (bodies.has(index)) {
      return { kind: 'rejected', failure: { kind: 'duplicate-index', index } };
    }
    // Registered before the body checks so a repeat of a bad entry is reported as
    // a duplicate: the second message must not be read as "the first one fixed".
    bodies.set(index, '');
    if (typeof body !== 'string') {
      return { kind: 'rejected', failure: { kind: 'body-not-a-string', index } };
    }
    if (body.trim() === '') {
      return { kind: 'rejected', failure: { kind: 'body-empty', index } };
    }
    if (body.length > PR_REVIEW_MAX_COMMENT_LENGTH) {
      return { kind: 'rejected', failure: { kind: 'body-too-long', index, length: body.length } };
    }
    bodies.set(index, body);
  }
  return {
    kind: 'selected',
    entries: candidates
      .filter((candidate) => bodies.has(candidate.index))
      .map((candidate) => ({ index: candidate.index, body: bodies.get(candidate.index) ?? '' })),
  };
}

/**
 * Whether a refusal means the message was modified rather than mistyped.
 *
 * The two failures a user can cause from the panel's own editor — an emptied body
 * and one over the cap — are reported at debug level like the rest of the panel's
 * traffic; a non-string body, an entry that is not an object, an index that was
 * never offered or a repeated index cannot come out of the panel's own code at
 * all, so those are logged as errors.
 */
function isPanelAnswerViolation(failure: AiPreReviewPanelSelectionFailure): boolean {
  return (
    failure.kind === 'not-an-entry' ||
    failure.kind === 'index-not-offered' ||
    failure.kind === 'duplicate-index' ||
    failure.kind === 'body-not-a-string'
  );
}

/** One card as the refusal messages name it: `path:line[-end] (side)`. */
function describePanelAnchor(candidate: AiPreReviewPanelCandidate): string {
  const range =
    candidate.extraLines > 0 ? `${candidate.line}-${candidate.line + candidate.extraLines}` : String(candidate.line);
  return `${candidate.path}:${range} (${candidate.side})`;
}

/**
 * The user-facing sentence for one refused Create answer.
 *
 * The two arm the user can reach from the panel name the card and say what to do
 * about it; the arms that mean a modified message say only that the answer was
 * refused and that nothing was written, because there is nothing to point at —
 * the card they named was never on screen.
 */
export function describePanelSelectionFailure(
  failure: AiPreReviewPanelSelectionFailure,
  candidates: readonly AiPreReviewPanelCandidate[],
): string {
  const anchorOf = (index: number): string => {
    const candidate = candidates.find((entry) => entry.index === index);
    return candidate ? describePanelAnchor(candidate) : `#${index}`;
  };
  switch (failure.kind) {
    case 'body-empty':
      return vscode.l10n.t(
        'Nothing was created: the comment for {0} has an empty body. Write something in it, or restore the wording the model proposed, and press Create again.',
        anchorOf(failure.index),
      );
    case 'body-too-long':
      return vscode.l10n.t(
        'Nothing was created: the comment for {0} is {1} characters, over the {2}-character limit for one comment. Shorten it, or restore the wording the model proposed, and press Create again.',
        anchorOf(failure.index),
        failure.length,
        PR_REVIEW_MAX_COMMENT_LENGTH,
      );
    default:
      return vscode.l10n.t(
        'Nothing was created: the confirmation panel sent an answer this extension cannot accept, so the whole answer was refused. A comment body has to be text, and only the comments this run offered may be named.',
      );
  }
}
