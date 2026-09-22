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
import { userFacingErrorMessage } from '../api/errors';

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

export class PullReviewCommentPanel implements vscode.Disposable {
  public static readonly viewType = 'forgejoToolkitPullReviewComment';
  public static currentPanel?: PullReviewCommentPanel;

  private readonly _panel: vscode.WebviewPanel;
  private readonly _disposables: vscode.Disposable[] = [];
  private _context: PullReviewCommentContext;

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

    this._panel.webview.onDidReceiveMessage(
      async (message) => {
        logger.debug(`Received message from pull review comment webview: ${(message as WebviewToHostMessage).command}`);
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
    if (this._contextKey(reviewContext) === this._contextKey(this._context)) {
      this._setContext(reviewContext, callbacks);
      return;
    }
    // Recover the chain after a failure (e.g. the confirmation prompt throws);
    // otherwise every later switch would ride on a rejected promise and
    // silently never run.
    this._contextSwitch = this._contextSwitch
      .then(() => this._confirmAndSetContext(reviewContext, callbacks))
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
    this._setContext(reviewContext, callbacks);
  }

  /**
   * Ask the webview editor whether it holds an unsubmitted draft. A webview
   * that fails to answer is treated as clean: blocking the switch (or
   * prompting on a stale panel) would be worse than the residual risk.
   */
  private _queryDraftDirty(): Promise<boolean> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        subscription.dispose();
        logger.debug('Pull review draft-state query timed out; switching context without confirmation');
        resolve(false);
      }, 2000);
      const subscription = this._panel.webview.onDidReceiveMessage((message) => {
        const data = message as { command?: string; dirty?: boolean };
        if (data.command === 'pullReviewCommentDraftState') {
          clearTimeout(timer);
          subscription.dispose();
          resolve(Boolean(data.dirty));
        }
      });
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
    const body = data.body?.trim();
    if (!body) {
      // Keep the request/response pair intact so the webview can reset its
      // submitting state even on this (normally unreachable) path.
      this._reply('pullReviewCommentSubmitted', { ...this._repoParams(), error: 'Empty comment body' });
      return;
    }

    const instance = this._findInstance(this._context.instanceId);
    if (!instance) {
      this._reply('pullReviewCommentSubmitted', { ...this._repoParams(), error: 'Forgejo instance not found' });
      return;
    }

    const comment: CreatePullReviewComment = {
      body,
      path: this._context.path,
    };
    // `position` is the 1-based file line number; Forgejo expects exactly
    // one of `new_position` (head side) or `old_position` (base side).
    if (this._context.isBase) {
      comment.old_position = this._context.position;
    } else {
      comment.new_position = this._context.position;
    }
    // Multi-line comments: the position is the first line of the range and
    // `extra_lines_count` extends it forward.
    if (this._context.extraLinesCount && this._context.extraLinesCount > 0) {
      comment.extra_lines_count = this._context.extraLinesCount;
    }

    const client = new ForgejoClient(instance.url, instance.token, logger, instance.syncApiUrlsToInstanceUrl);
    const startsNewReview = data.mode === 'review' && typeof data.pendingReviewId !== 'number';
    try {
      if (data.mode === 'review') {
        if (typeof data.pendingReviewId === 'number') {
          await client.addPullReviewComment(
            this._context.owner,
            this._context.repo,
            this._context.index,
            data.pendingReviewId,
            comment,
          );
        } else {
          const review = await client.createPendingPullReview(
            this._context.owner,
            this._context.repo,
            this._context.index,
            comment,
          );
          this._context.pendingReviewId = review.id;
        }
      } else {
        await client.createPullReviewWithComment(this._context.owner, this._context.repo, this._context.index, comment);
      }
      this._reply('pullReviewCommentSubmitted', { ...this._repoParams() });
      this._callbacks?.onSubmitted?.(this._context);
      this._panel.dispose();
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
      this._reply('pullReviewCommentSubmitted', { ...this._repoParams(), error: err });
      vscode.window.showErrorMessage(vscode.l10n.t('Failed to add review comment: {0}', err));
    }
  }

  private async _handleSubmitPullReview(message: unknown): Promise<void> {
    const data = message as { reviewId?: number; event?: string; body?: string };
    const reviewId = data.reviewId;
    if (typeof reviewId !== 'number') {
      this._reply('pullReviewSubmitted', { ...this._repoParams(), error: 'No pending review' });
      return;
    }

    const event: PullReviewSubmitEvent =
      data.event === 'APPROVED' || data.event === 'REQUEST_CHANGES' ? data.event : 'COMMENT';
    const body = typeof data.body === 'string' ? data.body.trim() : '';

    const instance = this._findInstance(this._context.instanceId);
    if (!instance) {
      this._reply('pullReviewSubmitted', { ...this._repoParams(), error: 'Forgejo instance not found' });
      return;
    }

    const client = new ForgejoClient(instance.url, instance.token, logger, instance.syncApiUrlsToInstanceUrl);
    try {
      await client.submitPullReview(
        this._context.owner,
        this._context.repo,
        this._context.index,
        reviewId,
        event,
        body,
      );
      this._reply('pullReviewSubmitted', { ...this._repoParams() });
      this._callbacks?.onSubmitted?.(this._context);
      this._panel.dispose();
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
      this._reply('pullReviewSubmitted', { ...this._repoParams(), error: err });
      vscode.window.showErrorMessage(vscode.l10n.t('Failed to submit review: {0}', err));
    }
  }

  private async _handleDeletePullReview(message: unknown): Promise<void> {
    const data = message as { reviewId?: number };
    const reviewId = data.reviewId;
    if (typeof reviewId !== 'number') {
      this._reply('pullReviewDeleted', { ...this._repoParams(), error: 'No pending review' });
      return;
    }

    const confirm = await vscode.window.showWarningMessage(
      vscode.l10n.t('Cancel this pending review? All draft comments will be discarded.'),
      { modal: true },
      vscode.l10n.t('Cancel Review'),
    );
    if (confirm !== vscode.l10n.t('Cancel Review')) {
      // Answer the request so the webview leaves its loading state.
      this._reply('pullReviewDeleted', { ...this._repoParams(), cancelled: true });
      return;
    }

    const instance = this._findInstance(this._context.instanceId);
    if (!instance) {
      this._reply('pullReviewDeleted', { ...this._repoParams(), error: 'Forgejo instance not found' });
      return;
    }

    const client = new ForgejoClient(instance.url, instance.token, logger, instance.syncApiUrlsToInstanceUrl);
    try {
      await client.deletePullReview(this._context.owner, this._context.repo, this._context.index, reviewId);
      this._reply('pullReviewDeleted', { ...this._repoParams() });
      this._callbacks?.onDeleted?.(this._context);
      this._panel.dispose();
    } catch (error) {
      const err = userFacingErrorMessage(error);
      logger.error(`Failed to delete pull review ${reviewId}: ${err}`);
      this._reply('pullReviewDeleted', { ...this._repoParams(), error: err });
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
        error: 'Forgejo instance not found',
        _requestId: requestId,
      });
      return;
    }

    if (typeof data.name !== 'string' || !Array.isArray(data.data)) {
      this._reply('issueAttachmentCreated', {
        instanceId: instance.id,
        owner,
        repo,
        index,
        error: 'Invalid attachment data',
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

  private _repoParams(): { instanceId: string; owner: string; repo: string; index: number } {
    return {
      instanceId: this._context.instanceId,
      owner: this._context.owner,
      repo: this._context.repo,
      index: this._context.index,
    };
  }

  private _reply<T extends HostToWebviewMessage['command']>(
    command: T,
    data: Omit<Extract<HostToWebviewMessage, { command: T }>, 'command'>,
  ) {
    this._panel.webview.postMessage({ command, ...data } as HostToWebviewMessage);
  }

  private _update(): void {
    const configured = vscode.workspace.getConfiguration('forgejoToolkit').get<'en' | 'zh' | undefined>('locale');
    const locale = resolveLocale(configured);
    this._panel.webview.html = getWebviewContent(this._panel.webview, this._extensionUri.fsPath, {
      panelMode: 'pullReviewComment',
      locale,
      instanceUrls: this._config.getInstances().map((i) => i.url),
      pullReviewComment: this._context,
    });
  }

  private _dispose(): void {
    PullReviewCommentPanel.currentPanel = undefined;
    while (this._disposables.length) {
      const disposable = this._disposables.pop();
      if (disposable) {
        disposable.dispose();
      }
    }
  }
}
