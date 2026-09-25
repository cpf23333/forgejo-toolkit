import * as vscode from 'vscode';
import { ForgejoClient } from '../api/client';
import { ConfigManager } from '../config';
import { getWebviewContent } from '../webview/content';
import { logger } from '../logger';
import {
  toPublicInstance,
  type ForgejoInstance,
  type HostToWebviewMessage,
  type PullReviewSubmitEvent,
  type WebviewToHostMessage,
} from '@cpf23333-forgejo-toolkit/shared/webview/messages';
import type { CreatePullReviewComment } from '@cpf23333-forgejo-toolkit/api';
import { resolveLocale } from '../utils/resolveLocale';
import { resolveAttachmentImages } from '../utils/resolveAttachmentImages';
import { isSafeRepoIdentity } from '../webview/repoIdentity';
import { isSameOriginUrl } from '../webview/instanceImport';
import { userFacingErrorMessage } from '../api/errors';

/**
 * True when an instance still points at the server the review context was
 * recorded against. The recorded URL may be unparseable (`config.ts` accepts
 * those unvalidated), so an unchanged string counts as the same target rather
 * than being judged a repoint by the origin comparison below.
 */
function isSameInstanceTarget(previous: string, current: string): boolean {
  return previous === current || isSameOriginUrl(previous, current);
}

export interface PullReviewCommentContext {
  instanceId: string;
  owner: string;
  repo: string;
  index: number;
  path: string;
  /** 1-based line number in the file (new file for head side, old file for base side). */
  position: number;
  isBase: boolean;
  lineNumber: number;
  /**
   * Additional lines after `position` for multi-line comments (Forgejo
   * `extra_lines_count`); undefined/0 means a single-line comment.
   */
  extraLinesCount?: number;
  mode: 'single' | 'review';
  pendingReviewId?: number;
}

export interface PullReviewCommentPanelCallbacks {
  onSubmitted?: (context: PullReviewCommentContext) => void;
  onDeleted?: (context: PullReviewCommentContext) => void;
}

/**
 * The context a request handler is answering, snapshotted before its first
 * await.
 *
 * The panel is a singleton: `createOrShow` reuses it for another pull request
 * or diff line (`_switchContext` → `_setContext`), which replaces `_context`
 * and rebuilds the webview editor. A handler that awaited a network call (or a
 * confirmation modal) and then read the live `_context` would therefore answer,
 * notify, mutate and dispose the editor the user opened meanwhile: the reply
 * would be attributed to the wrong pull request, the callback would refresh it,
 * the new editor would be closed with whatever the user had typed into it, and
 * its `pendingReviewId` would be overwritten with a review it never started.
 * Every handler that awaits takes its target first, answers with it, and touches
 * the panel (callbacks, `pendingReviewId`, `dispose`) only while `_context` is
 * still `target.context`.
 */
interface PullReviewCommentTarget {
  /**
   * The context object itself. Compared by identity, not by `_contextKey`: a
   * switch rebuilds the webview editor even for a context that merely looks
   * equal (e.g. the same line reopened), so only the very object the handler
   * started with proves that the editor it is answering is still the one on
   * screen.
   */
  readonly context: PullReviewCommentContext;
  /**
   * The instance the request was made against. The instance record itself is
   * resolved through this id (its URL and token are read at that point, and a
   * repoint mid-flight is `_handleInstancesChanged`'s business), so a context
   * switch onto another instance cannot retarget the request.
   */
  readonly instanceId: string;
  readonly owner: string;
  readonly repo: string;
  readonly index: number;
  /** The pending review this request operates on, as read before the await. */
  readonly pendingReviewId: number | undefined;
}

/**
 * Request/response commands this panel answers through the command's own
 * completion reply instead of the generic `requestError`: the editor posts no
 * `_requestId` and clears its `submitting` flag only on the completion command
 * whose carried context matches its own (`isOwnReply` in
 * `PullReviewCommentEditor.vue`), so an unanswered request — or a reply
 * missing the context — wedges every button forever. A handler that throws
 * before replying — e.g. the `ForgejoClient` constructor rejecting an instance
 * URL that is not absolute — must still produce this reply.
 */
const COMPLETION_REPLY_COMMANDS: Record<string, HostToWebviewMessage['command']> = {
  submitPullReviewComment: 'pullReviewCommentSubmitted',
  submitPullReview: 'pullReviewSubmitted',
  deletePullReview: 'pullReviewDeleted',
};

/**
 * Upper bound for the byte array an attachment upload message may carry. The
 * webview is untrusted input and the bytes travel as a JSON array of numbers,
 * so without a cap a forged message could make the host allocate — and then
 * upload — an arbitrary amount of memory. 32 MiB matches the payload caps
 * used elsewhere in the extension (`REPO_CONTENTS_CACHE_MAX_BYTES` in
 * `api/client.ts`, `MAX_RESOLVED_IMAGE_BYTES` in `resolveAttachmentImages.ts`).
 */
const MAX_ATTACHMENT_BYTES = 32 * 1024 * 1024;

/** Reply command → the request command it completes (see above). */
const COMPLETION_REQUEST_COMMANDS = new Map<string, string>(
  Object.entries(COMPLETION_REPLY_COMMANDS).map(([request, reply]) => [reply, request]),
);

export class PullReviewCommentPanel implements vscode.Disposable {
  public static readonly viewType = 'forgejoToolkitPullReviewComment';
  public static currentPanel?: PullReviewCommentPanel;

  private readonly _panel: vscode.WebviewPanel;
  private readonly _disposables: vscode.Disposable[] = [];
  /**
   * Requests currently being handled. A request id is removed by `_reply`; a
   * completion-reply request command (see `COMPLETION_REPLY_COMMANDS`) is
   * tracked by its own name. The dispatch wrapper answers whatever is left when
   * the handler ends — or throws — without replying.
   */
  private readonly _unansweredRequests = new Set<string>();
  private _context: PullReviewCommentContext;
  /**
   * The instance URL the current review context was recorded against. An
   * instance can be repointed at another server in place (same id, new URL),
   * and the owner/repo/index in `_context` would then name a repository on a
   * different host, so the panel has to notice that too (see
   * `_handleInstancesChanged`).
   */
  private _instanceUrl: string | undefined;
  /**
   * Draft-state query in flight; `_dispose` settles it so its 2 s timeout can
   * no longer fire against a disposed panel (see `_queryDraftDirty`).
   */
  private _draftQuery: { settle(dirty: boolean): void } | undefined;
  private _disposed = false;

  public static createOrShow(
    extensionUri: vscode.Uri,
    config: ConfigManager,
    reviewContext: PullReviewCommentContext,
    callbacks?: PullReviewCommentPanelCallbacks,
  ): PullReviewCommentPanel {
    if (PullReviewCommentPanel.currentPanel) {
      PullReviewCommentPanel.currentPanel._switchContext(reviewContext, callbacks);
      // Keep the panel where it is: revealing with a column would drag it back
      // next to the active editor even if the user moved it elsewhere.
      PullReviewCommentPanel.currentPanel._panel.reveal();
      return PullReviewCommentPanel.currentPanel;
    }

    const panel = vscode.window.createWebviewPanel(
      PullReviewCommentPanel.viewType,
      PullReviewCommentPanel._title(reviewContext),
      // Beside the diff editor instead of on top of it.
      vscode.ViewColumn.Beside,
      {
        enableScripts: true,
        localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'out', 'webview')],
        retainContextWhenHidden: true,
      },
    );

    PullReviewCommentPanel.currentPanel = new PullReviewCommentPanel(
      panel,
      extensionUri,
      config,
      reviewContext,
      callbacks,
    );
    return PullReviewCommentPanel.currentPanel;
  }

  /**
   * Push a `forgejoToolkit.locale` change made outside this panel (the Settings
   * editor, the sidebar, another panel) into the open webview: it renders in
   * the language it was created with until it receives `setLocale`, which the
   * shared webview composable already handles.
   */
  public static notifyLocaleChanged(locale: 'en' | 'zh'): void {
    PullReviewCommentPanel.currentPanel?._reply('setLocale', { locale });
  }

  private static _title(reviewContext: PullReviewCommentContext): string {
    const firstLine = reviewContext.lineNumber + 1;
    if (reviewContext.extraLinesCount && reviewContext.extraLinesCount > 0) {
      return `${reviewContext.path}:${firstLine}-${firstLine + reviewContext.extraLinesCount}`;
    }
    return `${reviewContext.path}:${firstLine}`;
  }

  private constructor(
    panel: vscode.WebviewPanel,
    private readonly _extensionUri: vscode.Uri,
    private readonly _config: ConfigManager,
    reviewContext: PullReviewCommentContext,
    private _callbacks?: PullReviewCommentPanelCallbacks,
  ) {
    this._panel = panel;
    this._context = reviewContext;

    this._update();

    this._panel.onDidDispose(() => this._dispose(), null, this._disposables);

    // Instance-scoped, like every other panel and provider: this editor is only
    // usable while the instance its context names still exists and still points
    // at the same server. Without this the instance could be removed (here or
    // from another window) and every button would silently do nothing — the
    // handlers return early and the webview editor has no error surface of its
    // own. See `_handleInstancesChanged`.
    this._disposables.push(this._config.onInstancesChanged(() => this._handleInstancesChanged()));

    this._panel.webview.onDidReceiveMessage(
      async (message) => {
        // Read the command defensively: this line runs before the try below, so
        // a malformed (non-object) message must not throw out of the handler.
        const dispatchCommand =
          message && typeof message === 'object' && typeof (message as { command?: unknown }).command === 'string'
            ? (message as { command: string }).command
            : undefined;
        logger.debug(`Received message from pull review comment webview: ${String(dispatchCommand)}`);
        // Track what this dispatch owes an answer to, exactly like the sidebar
        // and onboarding dispatchers: a handler that returns early — or throws,
        // e.g. from a `ForgejoClient` constructor rejecting a non-absolute
        // instance URL — must not leave the webview's promise pending (the
        // editor's `submitting` flag then disables every button forever).
        const dispatchRequestId =
          message && typeof message === 'object' && typeof (message as { _requestId?: unknown })._requestId === 'string'
            ? (message as { _requestId: string })._requestId
            : undefined;
        if (dispatchRequestId) {
          this._unansweredRequests.add(dispatchRequestId);
        }
        const completionReply = dispatchCommand ? COMPLETION_REPLY_COMMANDS[dispatchCommand] : undefined;
        if (dispatchCommand && completionReply) {
          this._unansweredRequests.add(dispatchCommand);
        }
        // The context this dispatch is answering, snapshotted before any handler
        // awaits: the panel is a singleton and a context switch replaces
        // `_context` mid-request, so the `finally` fallback below must answer
        // with the snapshot — reading the live `_context` there would attribute
        // the error reply to whatever pull request the user switched to (see
        // `PullReviewCommentTarget`, which the handlers snapshot the same way).
        const dispatchContext = this._context;
        try {
          // Repository identity from the webview is interpolated verbatim into
          // API paths (`/repos/${owner}/${repo}/…`), where the URL parser
          // resolves dot segments and splits on `?`/`#`. This panel has its own
          // dispatcher, so the same guard the sidebar applies is repeated here
          // before any handler runs.
          const identity = message as { owner?: unknown; repo?: unknown; _requestId?: unknown };
          if (!isSafeRepoIdentity(identity.owner, identity.repo)) {
            logger.error(
              `Ignoring message from the review comment webview with an unsafe owner/repo identity: ${String(identity.owner)}/${String(identity.repo)}`,
            );
            if (typeof identity._requestId === 'string') {
              this._reply('requestError', {
                _requestId: identity._requestId,
                error: vscode.l10n.t('The request could not be completed'),
              });
            }
            return;
          }
          switch ((message as WebviewToHostMessage).command) {
            case 'getInitialState': {
              this._sendInitialState();
              return;
            }
            case 'getLinkedRepository': {
              // The editor webview shares the sidebar composable, which asks for
              // the linked repository on mount. This panel is not repository
              // -scoped UI, so answer with "none" instead of leaving the request
              // unanswered.
              this._reply('linkedRepository', {});
              return;
            }
            case 'renderMarkdown': {
              await this._handleRenderMarkdown(message);
              return;
            }
            case 'searchMentions': {
              await this._handleSearchMentions(message);
              return;
            }
            case 'closePullReviewCommentPanel': {
              this._panel.dispose();
              return;
            }
            case 'submitPullReviewComment': {
              await this._handleSubmitPullReviewComment(message);
              return;
            }
            case 'submitPullReview': {
              await this._handleSubmitPullReview(message);
              return;
            }
            case 'deletePullReview': {
              await this._handleDeletePullReview(message);
              return;
            }
            case 'createIssueAttachment': {
              await this._handleCreateIssueAttachment(message);
              return;
            }
            default: {
              // The editor webview posts through the shared sidebar composable,
              // so a command this panel does not implement used to be dropped
              // silently: the caller's promise then only settled on its 60 s
              // timeout (markdown preview) or produced an empty result (mention
              // completion). Answer request/response messages so the failure is
              // visible instead of hanging.
              const requestId = (message as { _requestId?: unknown })._requestId;
              const command = String((message as { command?: unknown }).command);
              if (typeof requestId === 'string') {
                logger.error(`Unhandled message from the pull review comment webview: ${command}`);
                this._reply('requestError', {
                  _requestId: requestId,
                  error: vscode.l10n.t('This action is not available in the review comment editor.'),
                });
                return;
              }
              // A fire-and-forget broadcast from the shared composable (mount-time
              // state requests and the like): nobody is waiting for an answer and
              // the panel is not broken, so this is not an error. It stays visible
              // when the user turns on debug logging.
              logger.debug(`Ignored fire-and-forget message in the review comment webview: ${command}`);
              return;
            }
          }
        } catch (error) {
          const err = userFacingErrorMessage(error);
          logger.error(`Error handling pull review comment webview message "${String(dispatchCommand)}": ${err}`);
        } finally {
          if (dispatchRequestId && this._unansweredRequests.has(dispatchRequestId)) {
            this._unansweredRequests.delete(dispatchRequestId);
            logger.error(
              `Pull review comment handler for "${String(dispatchCommand)}" ended without replying to request ${dispatchRequestId}`,
            );
            this._reply('requestError', {
              _requestId: dispatchRequestId,
              error: vscode.l10n.t('The request could not be completed'),
            });
          }
          if (dispatchCommand && completionReply && this._unansweredRequests.has(dispatchCommand)) {
            this._unansweredRequests.delete(dispatchCommand);
            logger.error(`Pull review comment handler for "${dispatchCommand}" ended without replying`);
            // The completion command is the only reply the editor can route, so
            // the fallback uses it instead of the generic `requestError`. The
            // repo params come from the dispatch-time snapshot, not the live
            // `_context`: the handler may have awaited, and a context switch in
            // between would otherwise attribute this error to the editor the
            // user opened meanwhile.
            (this._reply as (command: string, data: Record<string, unknown>) => void)(completionReply, {
              ...this._repoParams(dispatchContext),
              error: vscode.l10n.t('The request could not be completed'),
            });
          }
        }
      },
      undefined,
      this._disposables,
    );

    // Notify the webview of the current context so it can update if the panel
    // was reused or the initial config was not enough.
    this._sendOpenEditor();
  }

  dispose(): void {
    this._panel.dispose();
  }

  private _setContext(reviewContext: PullReviewCommentContext, callbacks?: PullReviewCommentPanelCallbacks): void {
    this._context = reviewContext;
    // Reused panels must not keep the closures of the previous pull request.
    this._callbacks = callbacks;
    this._panel.title = PullReviewCommentPanel._title(reviewContext);
    this._instanceUrl = this._findInstance(reviewContext.instanceId)?.url;
    this._sendOpenEditor();
  }

  // Serializes context switches so rapid line changes cannot stack two
  // discard confirmations on top of each other.
  private _contextSwitch: Promise<void> = Promise.resolve();

  /**
   * Mirrors the webview editor key: same key means the editor is not rebuilt
   * and the draft survives, so no confirmation is needed.
   */
  private _contextKey(c: PullReviewCommentContext): string {
    return `${c.instanceId}:${c.owner}/${c.repo}#${c.index}:${c.path}:${c.lineNumber}:${c.extraLinesCount ?? 0}:${c.isBase}:${c.mode}:${c.pendingReviewId ?? ''}`;
  }

  private _switchContext(reviewContext: PullReviewCommentContext, callbacks?: PullReviewCommentPanelCallbacks): void {
    // Same-key switches ride the chain too: applying one synchronously while a
    // different-key switch is still queued behind its discard confirmation
    // inverted the user's action order — the same-key switch landed first and
    // the confirmed switch then overwrote it, so the panel ended on the context
    // the user had asked for *earlier*, not latest.
    //
    // The key comparison runs when the queued switch executes, not when it is
    // enqueued: by then `_context` is whatever the earlier switches settled on.
    // A switch whose key matches the then-current context is a no-confirmation
    // fast path (the editor key is unchanged, so no draft can be lost and no
    // modal may appear); only a genuinely different key asks.
    //
    // Recover the chain after a failure (e.g. the confirmation prompt throws);
    // otherwise every later switch would ride on a rejected promise and
    // silently never run.
    this._contextSwitch = this._contextSwitch
      .then(() => {
        if (this._disposed) {
          // The panel may already be disposed when this queued switch runs
          // (the switch is chained on `_contextSwitch`, and `_dispose` ran
          // past it): retitling it is pointless, and `_confirmAndSetContext`'s
          // own guard covers the different-key path.
          return undefined;
        }
        return this._contextKey(reviewContext) === this._contextKey(this._context)
          ? this._setContext(reviewContext, callbacks)
          : this._confirmAndSetContext(reviewContext, callbacks);
      })
      .catch((error: unknown) => {
        const err = userFacingErrorMessage(error);
        logger.error(`Failed to switch pull review comment context: ${err}`);
      });
  }

  /**
   * Switching context rebuilds the editor and drops any unsubmitted draft.
   * Ask the webview whether a draft exists, and if so make the user confirm
   * the discard first (declining keeps the old context and draft).
   */
  private async _confirmAndSetContext(
    reviewContext: PullReviewCommentContext,
    callbacks?: PullReviewCommentPanelCallbacks,
  ): Promise<void> {
    // The panel may already be disposed when this queued switch runs (the switch
    // is chained on `_contextSwitch`, and `_dispose` ran past it): asking a
    // disposed webview about its draft is pointless, and the question would arm
    // a fresh 2 s timer that `_dispose` has already walked past.
    if (this._disposed) {
      return;
    }
    if (await this._queryDraftDirty()) {
      const discardLabel = vscode.l10n.t('Discard Draft');
      const choice = await vscode.window.showWarningMessage(
        vscode.l10n.t('The current draft comment will be discarded.'),
        { modal: true },
        discardLabel,
      );
      if (choice !== discardLabel) {
        return;
      }
    }
    // The panel may have been disposed while the draft query or the modal was
    // pending; retitling/posting to it afterwards is pointless (and posting can
    // reject on a disposed webview), so the switch stops here.
    if (this._disposed) {
      return;
    }
    this._setContext(reviewContext, callbacks);
  }

  /**
   * Ask the webview editor whether it holds an unsubmitted draft. A webview
   * that fails to answer is treated as clean: blocking the switch (or
   * prompting on a stale panel) would be worse than the residual risk.
   */
  private _queryDraftDirty(): Promise<boolean> {
    // A disposed panel has no editor to ask, and posting the question would
    // reject; answer "clean" without posting or arming the timeout.
    if (this._disposed) {
      return Promise.resolve(false);
    }
    return new Promise((resolve) => {
      // The query owns a webview listener and a 2 s timeout; both are tracked in
      // `_draftQuery` so `_dispose` can settle the promise and drop them instead
      // of letting the timeout fire against a disposed panel. `settle` is
      // idempotent and bound to its own query, so a listener from an earlier
      // query cannot answer a later one when disposal does not unregister it.
      let settled = false;
      const query = {
        timer: undefined as ReturnType<typeof setTimeout> | undefined,
        subscription: undefined as vscode.Disposable | undefined,
        settle: (dirty: boolean) => {
          if (settled) {
            return;
          }
          settled = true;
          if (query.timer !== undefined) {
            clearTimeout(query.timer);
          }
          query.subscription?.dispose();
          if (this._draftQuery === query) {
            this._draftQuery = undefined;
          }
          resolve(dirty);
        },
      };
      query.subscription = this._panel.webview.onDidReceiveMessage((message) => {
        const data = message as { command?: string; dirty?: boolean };
        if (data.command === 'pullReviewCommentDraftState') {
          query.settle(Boolean(data.dirty));
        }
      });
      query.timer = setTimeout(() => {
        logger.debug('Pull review draft-state query timed out; switching context without confirmation');
        query.settle(false);
      }, 2000);
      this._draftQuery = query;
      void this._panel.webview.postMessage({ command: 'queryPullReviewCommentDraft' });
    });
  }

  private _sendOpenEditor(): void {
    this._reply('openPullReviewCommentEditor', {
      instanceId: this._context.instanceId,
      owner: this._context.owner,
      repo: this._context.repo,
      index: this._context.index,
      path: this._context.path,
      position: this._context.position,
      isBase: this._context.isBase,
      lineNumber: this._context.lineNumber,
      extraLinesCount: this._context.extraLinesCount,
      mode: this._context.mode,
      pendingReviewId: this._context.pendingReviewId,
    });
  }

  private async _handleSubmitPullReviewComment(message: unknown): Promise<void> {
    const data = message as {
      body?: string;
      mode?: 'single' | 'review';
      pendingReviewId?: number;
    };
    // Snapshot the target before anything else is read or awaited: every reply
    // below — including the early error ones — answers for the editor this
    // request arrived from (see `PullReviewCommentTarget`).
    const target = this._captureTarget(data.pendingReviewId);
    const body = data.body?.trim();
    if (!body) {
      // Keep the request/response pair intact so the webview can reset its
      // submitting state even on this (normally unreachable) path.
      this._reply('pullReviewCommentSubmitted', {
        ...this._repoParams(target.context),
        error: vscode.l10n.t('Empty comment body'),
      });
      return;
    }

    const instance = this._findInstance(target.instanceId);
    if (!instance) {
      this._reply('pullReviewCommentSubmitted', {
        ...this._repoParams(target.context),
        error: vscode.l10n.t('Forgejo instance not found'),
      });
      return;
    }

    const comment: CreatePullReviewComment = {
      body,
      path: target.context.path,
    };
    // `position` is the 1-based file line number; Forgejo expects exactly
    // one of `new_position` (head side) or `old_position` (base side).
    if (target.context.isBase) {
      comment.old_position = target.context.position;
    } else {
      comment.new_position = target.context.position;
    }
    // Multi-line comments: the position is the first line of the range and
    // `extra_lines_count` extends it forward.
    if (target.context.extraLinesCount && target.context.extraLinesCount > 0) {
      comment.extra_lines_count = target.context.extraLinesCount;
    }

    const startsNewReview = data.mode === 'review' && typeof target.pendingReviewId !== 'number';
    try {
      // Constructed inside the try: the constructor resolves the instance
      // origin and throws for a URL that is not absolute (`config.ts` accepts
      // those unvalidated), which must surface as an error reply rather than a
      // rejected message promise.
      const client = new ForgejoClient(instance.url, instance.token, logger, instance.syncApiUrlsToInstanceUrl);
      if (data.mode === 'review') {
        if (typeof target.pendingReviewId === 'number') {
          await client.addPullReviewComment(target.owner, target.repo, target.index, target.pendingReviewId, comment);
        } else {
          const review = await client.createPendingPullReview(target.owner, target.repo, target.index, comment);
          // Only the editor this request started from learns the new review id:
          // the panel may be showing another one by now, and storing the id in
          // its context would pair that editor with a review it never started.
          if (this._isCurrentTarget(target)) {
            target.context.pendingReviewId = review.id;
          }
        }
      } else {
        await client.createPullReviewWithComment(target.owner, target.repo, target.index, comment);
      }
      this._reply('pullReviewCommentSubmitted', { ...this._repoParams(target.context) });
      // The callbacks and the close belong to the editor this request came
      // from: a submit that resolves after a context switch must not refresh
      // the pull request the user switched to, nor dispose the editor they just
      // opened (which would drop whatever they had typed into it).
      if (this._isCurrentTarget(target)) {
        this._callbacks?.onSubmitted?.(target.context);
        this._panel.dispose();
      }
      // The panel closes on success, which is indistinguishable from a failed
      // or cancelled submit without explicit feedback.
      if (startsNewReview) {
        vscode.window.showInformationMessage(
          vscode.l10n.t('Review started. Add more comments via the line context menu, then submit the review.'),
        );
      } else if (data.mode === 'review') {
        vscode.window.showInformationMessage(vscode.l10n.t('Comment added to the pending review.'));
      } else {
        vscode.window.showInformationMessage(vscode.l10n.t('Review comment added.'));
      }
    } catch (error) {
      const err = userFacingErrorMessage(error);
      logger.error(`Failed to submit pull review comment: ${err}`);
      this._reply('pullReviewCommentSubmitted', { ...this._repoParams(target.context), error: err });
      vscode.window.showErrorMessage(vscode.l10n.t('Failed to add review comment: {0}', err));
    }
  }

  private async _handleSubmitPullReview(message: unknown): Promise<void> {
    const data = message as { reviewId?: number; event?: string; body?: string };
    // Snapshot first; everything below answers for the editor this request
    // arrived from (see `PullReviewCommentTarget`).
    const target = this._captureTarget(data.reviewId);
    if (typeof target.pendingReviewId !== 'number') {
      this._reply('pullReviewSubmitted', {
        ...this._repoParams(target.context),
        error: vscode.l10n.t('No pending review'),
      });
      return;
    }
    const reviewId = target.pendingReviewId;

    const event: PullReviewSubmitEvent =
      data.event === 'APPROVED' || data.event === 'REQUEST_CHANGES' ? data.event : 'COMMENT';
    const body = typeof data.body === 'string' ? data.body.trim() : '';

    const instance = this._findInstance(target.instanceId);
    if (!instance) {
      this._reply('pullReviewSubmitted', {
        ...this._repoParams(target.context),
        error: vscode.l10n.t('Forgejo instance not found'),
      });
      return;
    }

    try {
      // Constructed inside the try so a non-absolute instance URL (a
      // constructor throw) still answers the request.
      const client = new ForgejoClient(instance.url, instance.token, logger, instance.syncApiUrlsToInstanceUrl);
      await client.submitPullReview(target.owner, target.repo, target.index, reviewId, event, body);
      this._reply('pullReviewSubmitted', { ...this._repoParams(target.context) });
      // Only the editor this request started from is notified and closed (see
      // `PullReviewCommentTarget`).
      if (this._isCurrentTarget(target)) {
        this._callbacks?.onSubmitted?.(target.context);
        this._panel.dispose();
      }
      if (event === 'APPROVED') {
        vscode.window.showInformationMessage(vscode.l10n.t('Review submitted: approved.'));
      } else if (event === 'REQUEST_CHANGES') {
        vscode.window.showInformationMessage(vscode.l10n.t('Review submitted: changes requested.'));
      } else {
        vscode.window.showInformationMessage(vscode.l10n.t('Review submitted.'));
      }
    } catch (error) {
      const err = userFacingErrorMessage(error);
      logger.error(`Failed to submit pull review ${reviewId}: ${err}`);
      this._reply('pullReviewSubmitted', { ...this._repoParams(target.context), error: err });
      vscode.window.showErrorMessage(vscode.l10n.t('Failed to submit review: {0}', err));
    }
  }

  private async _handleDeletePullReview(message: unknown): Promise<void> {
    const data = message as { reviewId?: number };
    // Snapshot first: the confirmation below is awaited, and the user can open
    // another comment while the modal is up (see `PullReviewCommentTarget`).
    const target = this._captureTarget(data.reviewId);
    if (typeof target.pendingReviewId !== 'number') {
      this._reply('pullReviewDeleted', {
        ...this._repoParams(target.context),
        error: vscode.l10n.t('No pending review'),
      });
      return;
    }
    const reviewId = target.pendingReviewId;

    const confirm = await vscode.window.showWarningMessage(
      vscode.l10n.t('Cancel this pending review? All draft comments will be discarded.'),
      { modal: true },
      vscode.l10n.t('Cancel Review'),
    );
    if (confirm !== vscode.l10n.t('Cancel Review')) {
      // Answer the request so the webview leaves its loading state.
      this._reply('pullReviewDeleted', { ...this._repoParams(target.context), cancelled: true });
      return;
    }

    // Looked up through the snapshot's instance id: the modal above was
    // awaited, so the live context may name another pull request — possibly on
    // another instance — by now.
    const instance = this._findInstance(target.instanceId);
    if (!instance) {
      this._reply('pullReviewDeleted', {
        ...this._repoParams(target.context),
        error: vscode.l10n.t('Forgejo instance not found'),
      });
      return;
    }

    try {
      // Constructed inside the try so a non-absolute instance URL (a
      // constructor throw) still answers the request.
      const client = new ForgejoClient(instance.url, instance.token, logger, instance.syncApiUrlsToInstanceUrl);
      await client.deletePullReview(target.owner, target.repo, target.index, reviewId);
      this._reply('pullReviewDeleted', { ...this._repoParams(target.context) });
      // Only the editor this request started from is notified and closed (see
      // `PullReviewCommentTarget`).
      if (this._isCurrentTarget(target)) {
        this._callbacks?.onDeleted?.(target.context);
        this._panel.dispose();
      }
    } catch (error) {
      const err = userFacingErrorMessage(error);
      logger.error(`Failed to delete pull review ${reviewId}: ${err}`);
      this._reply('pullReviewDeleted', { ...this._repoParams(target.context), error: err });
      vscode.window.showErrorMessage(vscode.l10n.t('Failed to cancel review: {0}', err));
    }
  }

  private async _handleCreateIssueAttachment(message: unknown): Promise<void> {
    const data = message as {
      instanceId?: string;
      owner?: string;
      repo?: string;
      index?: number;
      name?: string;
      data?: number[];
      _requestId?: string;
    };
    const requestId = data._requestId ?? '';
    const owner = data.owner ?? this._context.owner;
    const repo = data.repo ?? this._context.repo;
    const index = data.index ?? this._context.index;
    const instance = this._findInstance(data.instanceId);
    if (!instance) {
      this._reply('issueAttachmentCreated', {
        instanceId: data.instanceId ?? this._context.instanceId,
        owner,
        repo,
        index,
        error: vscode.l10n.t('Forgejo instance not found'),
        _requestId: requestId,
      });
      return;
    }

    // The index becomes a path segment of the upload route, so a forged
    // message must not be able to point the host's bytes at another route on
    // the same origin. The sidebar handler for the same message only checks
    // `typeof index === 'number'`, and that is not a traversal hole: a number
    // stringifies to digits with an optional sign or exponent (or `NaN`/
    // `Infinity`), never to `/`, `\` or a `..` segment, so a forged value at
    // worst reaches a sibling route and fails there. This panel still rejects a
    // non-integer or non-positive value because only a positive integer can
    // name a real upload target.
    if (!Number.isInteger(index) || index <= 0) {
      this._reply('issueAttachmentCreated', {
        instanceId: instance.id,
        owner,
        repo,
        index,
        error: vscode.l10n.t('Invalid attachment target'),
        _requestId: requestId,
      });
      return;
    }

    if (typeof data.name !== 'string' || !Array.isArray(data.data) || data.data.length > MAX_ATTACHMENT_BYTES) {
      this._reply('issueAttachmentCreated', {
        instanceId: instance.id,
        owner,
        repo,
        index,
        error: vscode.l10n.t('Invalid attachment data'),
        _requestId: requestId,
      });
      return;
    }

    try {
      const client = new ForgejoClient(instance.url, instance.token, logger, instance.syncApiUrlsToInstanceUrl);
      const attachment = await client.createIssueAttachment(owner, repo, index, new Uint8Array(data.data), data.name);
      this._reply('issueAttachmentCreated', {
        instanceId: instance.id,
        owner,
        repo,
        index,
        uuid: attachment.uuid,
        name: attachment.name,
        size: attachment.size,
        browser_download_url: attachment.browser_download_url,
        _requestId: requestId,
      });
    } catch (error) {
      const err = userFacingErrorMessage(error);
      logger.error(`Failed to create issue attachment for ${instance.name}/${owner}/${repo}#${index}: ${err}`);
      this._reply('issueAttachmentCreated', {
        instanceId: instance.id,
        owner,
        repo,
        index,
        error: err,
        _requestId: requestId,
      });
    }
  }

  /**
   * Answer the shared composable's mount request. The editor webview runs the
   * same `useAppState()` as the sidebar, so it asks for the full initial state;
   * this panel is not the dashboard and has no worktree manager, so the
   * worktree fields are answered with inert defaults (the editor only uses
   * `instances` for markdown image base URLs and `locale`).
   */
  private _sendInitialState(): void {
    const configured = vscode.workspace.getConfiguration('forgejoToolkit').get<'en' | 'zh' | undefined>('locale');
    const locale: 'en' | 'zh' = resolveLocale(configured);
    const debug = vscode.workspace.getConfiguration('forgejoToolkit').get<boolean>('debug', false);
    this._reply('initialState', {
      instances: this._config.getInstances().map(toPublicInstance),
      locale,
      debug,
      worktrees: [],
      worktreeOpenMode: 'ask',
      worktreeCacheDirectory: '',
      worktreeCacheDirectoryDefault: '',
    });
  }

  private async _handleRenderMarkdown(message: unknown): Promise<void> {
    const data = message as { instanceId?: string; text?: string; context?: string; _requestId?: string };
    const requestId = data._requestId;
    if (typeof requestId !== 'string') {
      return;
    }
    const instance = this._findInstance(data.instanceId ?? this._context.instanceId);
    if (!instance || typeof data.text !== 'string') {
      this._reply('renderedMarkdown', {
        _requestId: requestId,
        error: vscode.l10n.t('The Forgejo instance is no longer configured'),
      });
      return;
    }
    try {
      const client = new ForgejoClient(instance.url, instance.token, logger, instance.syncApiUrlsToInstanceUrl);
      const html = await client.renderMarkdown(data.text, data.context);
      // Attachments render as instance URLs that the webview cannot fetch with
      // the token, so they are inlined the same way the sidebar does it.
      const htmlWithResolvedImages = await resolveAttachmentImages(html, instance);
      this._reply('renderedMarkdown', { _requestId: requestId, html: htmlWithResolvedImages });
    } catch (error) {
      const err = userFacingErrorMessage(error);
      logger.error(`renderMarkdown failed for ${instance.name}: ${err}`);
      this._reply('renderedMarkdown', { _requestId: requestId, error: err });
    }
  }

  private async _handleSearchMentions(message: unknown): Promise<void> {
    const data = message as {
      instanceId?: string;
      owner?: string;
      repo?: string;
      query?: string;
      type?: string;
      _requestId?: string;
    };
    const requestId = data._requestId;
    if (typeof requestId !== 'string') {
      return;
    }
    const instance = this._findInstance(data.instanceId ?? this._context.instanceId);
    const owner = data.owner ?? this._context.owner;
    const repo = data.repo ?? this._context.repo;
    if (!instance || typeof data.query !== 'string') {
      this._reply('mentionSearchResult', {
        _requestId: requestId,
        error: vscode.l10n.t('The Forgejo instance is no longer configured'),
      });
      return;
    }
    try {
      const client = new ForgejoClient(instance.url, instance.token, logger, instance.syncApiUrlsToInstanceUrl);
      const result = await client.searchMentions(owner, repo, data.query, data.type as 'user' | 'issue' | 'all');
      this._reply('mentionSearchResult', { _requestId: requestId, users: result.users, issues: result.issues });
    } catch (error) {
      const err = userFacingErrorMessage(error);
      logger.error(`searchMentions failed for ${instance.name}/${owner}/${repo}: ${err}`);
      this._reply('mentionSearchResult', { _requestId: requestId, error: err });
    }
  }

  private _findInstance(id: unknown): ForgejoInstance | undefined {
    if (typeof id !== 'string') {
      return undefined;
    }
    return this._config.getInstances().find((i) => i.id === id);
  }

  /**
   * Capture the context a request handler is answering, before its first await.
   * The handler then answers with this object and only touches the panel while
   * `_context` is still `target.context` (see `PullReviewCommentTarget`).
   *
   * The pending review id comes from the host's own context, never from the
   * webview message: webview messages are untrusted input (the repo identity in
   * them is validated through `isSafeRepoIdentity` for the same reason), and a
   * forged `reviewId` would otherwise make the host submit or delete whatever
   * review the message names. The reported value only crosses the trust
   * boundary as a consistency signal — a disagreement between the editor and
   * the host state it mirrors is worth a log line, never an action.
   */
  private _captureTarget(reportedReviewId: number | undefined): PullReviewCommentTarget {
    const context = this._context;
    if (typeof reportedReviewId === 'number' && reportedReviewId !== context.pendingReviewId) {
      logger.info(
        `Ignoring webview-reported pending review id ${reportedReviewId}: the host context holds ${context.pendingReviewId ?? 'none'}`,
      );
    }
    return {
      context,
      instanceId: context.instanceId,
      owner: context.owner,
      repo: context.repo,
      index: context.index,
      pendingReviewId: context.pendingReviewId,
    };
  }

  /** True while the panel still shows the very context `target` was taken from. */
  private _isCurrentTarget(target: PullReviewCommentTarget): boolean {
    return this._context === target.context;
  }

  private _repoParams(context: PullReviewCommentContext): {
    instanceId: string;
    owner: string;
    repo: string;
    index: number;
  } {
    return {
      instanceId: context.instanceId,
      owner: context.owner,
      repo: context.repo,
      index: context.index,
    };
  }

  private _reply<T extends HostToWebviewMessage['command']>(
    command: T,
    data: Omit<Extract<HostToWebviewMessage, { command: T }>, 'command'>,
  ) {
    // Mark the request answered so the dispatch fallback does not emit a
    // duplicate reply.
    const requestId = (data as { _requestId?: unknown })._requestId;
    if (typeof requestId === 'string') {
      this._unansweredRequests.delete(requestId);
    }
    const completionRequest = COMPLETION_REQUEST_COMMANDS.get(command);
    if (completionRequest) {
      this._unansweredRequests.delete(completionRequest);
    }
    // The panel can be closed while a handler is still awaiting its network
    // call (`_handleSubmitPullReviewComment`, `_handleSubmitPullReview`,
    // `_handleCreateIssueAttachment` all reply after their request resolves).
    // Posting to the disposed webview then rejects, and an unguarded,
    // un-caught rejection surfaces as an unhandled rejection in the extension
    // host. The sidebar guards the same hazard by dropping the reply once its
    // view is gone (`viewProvider._reply`); this panel has no view to null out,
    // so `_disposed` is the equivalent check. The reply is dropped rather than
    // awaited: nobody can consume it any more.
    if (this._disposed) {
      return;
    }
    void Promise.resolve(this._panel.webview.postMessage({ command, ...data } as HostToWebviewMessage)).catch(
      () => undefined,
    );
  }

  private _update(): void {
    const configured = vscode.workspace.getConfiguration('forgejoToolkit').get<'en' | 'zh' | undefined>('locale');
    const locale = resolveLocale(configured);
    const instances = this._config.getInstances();
    // Recorded from the render's own instance read: the removal/repoint check
    // needs the URL this context was created against.
    this._instanceUrl = instances.find((instance) => instance.id === this._context.instanceId)?.url;
    this._panel.webview.html = getWebviewContent(this._panel.webview, this._extensionUri.fsPath, {
      panelMode: 'pullReviewComment',
      locale,
      instanceUrls: instances.map((i) => i.url),
      pullReviewComment: this._context,
    });
  }

  /**
   * Close the panel when its instance is gone: removed, or repointed at another
   * server so the recorded owner/repo/index no longer name a repository this
   * instance serves. Both leave every control in the webview editor inert (the
   * handlers answer "Forgejo instance not found" and the editor has no error
   * surface), so the panel is disposed with a message instead of becoming a
   * silent dead end. The `_disposed` guard keeps a second notification from
   * disposing it again.
   */
  private _handleInstancesChanged(): void {
    if (this._disposed) {
      return;
    }
    const instance = this._findInstance(this._context.instanceId);
    if (instance && (this._instanceUrl === undefined || isSameInstanceTarget(this._instanceUrl, instance.url))) {
      return;
    }
    if (instance) {
      void vscode.window.showWarningMessage(
        vscode.l10n.t(
          'The review comment editor was closed because its Forgejo instance now points to a different server.',
        ),
      );
    } else {
      void vscode.window.showWarningMessage(
        vscode.l10n.t('The review comment editor was closed because its Forgejo instance was removed.'),
      );
    }
    this._panel.dispose();
  }

  private _dispose(): void {
    this._disposed = true;
    PullReviewCommentPanel.currentPanel = undefined;
    // A draft-state query may still be waiting on its 2 s timeout: settle it and
    // drop the timer so it cannot fire (and post to a disposed webview) later.
    this._draftQuery?.settle(false);
    while (this._disposables.length) {
      const disposable = this._disposables.pop();
      if (disposable) {
        disposable.dispose();
      }
    }
  }
}
