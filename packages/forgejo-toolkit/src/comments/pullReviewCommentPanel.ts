import * as vscode from 'vscode';
import { ForgejoClient } from '../api/client';
import { ConfigManager } from '../config';
import { getWebviewContent } from '../webview/content';
import { logger } from '../logger';
import type { HostToWebviewMessage, WebviewToHostMessage } from '@cpf23333-forgejo-toolkit/shared/webview/messages';
import type { ForgejoInstance, PullReviewSubmitEvent } from '@cpf23333-forgejo-toolkit/shared/webview/messages';
import type { CreatePullReviewComment } from '@cpf23333-forgejo-toolkit/api';
import { resolveLocale } from '../utils/resolveLocale';

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
      PullReviewCommentPanel.currentPanel._setContext(reviewContext, callbacks);
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
    return `${reviewContext.path}:${reviewContext.lineNumber + 1}`;
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
        switch ((message as WebviewToHostMessage).command) {
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
      const err = error instanceof Error ? error.message : String(error);
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
      const err = error instanceof Error ? error.message : String(error);
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
      const err = error instanceof Error ? error.message : String(error);
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
      const err = error instanceof Error ? error.message : String(error);
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
