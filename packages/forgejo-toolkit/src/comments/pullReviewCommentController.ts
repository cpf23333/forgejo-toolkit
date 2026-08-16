import * as vscode from 'vscode';
import { ForgejoClient } from '../api/client';
import { ConfigManager } from '../config';
import { FORGEJO_PR_SCHEME, type ForgejoPrUriParams } from '../prFileSystemProvider';
import { parsePullDiff, type ParsedPullDiff } from '../utils/parseDiff';
import type { PullReview, PullReviewComment } from '@cpf23333-forgejo-toolkit/api';
import type { ForgejoInstance } from '@cpf23333-forgejo-toolkit/shared/webview/messages';
import type { Logger } from '../logger';

interface PullReviewData {
  review: PullReview;
  comments: PullReviewComment[];
}

interface PullRequestReviewCache {
  diff: ParsedPullDiff;
  reviews: PullReviewData[];
}

export interface CommentContext {
  instanceId: string;
  instanceName: string;
  owner: string;
  repo: string;
  index: number;
  reviewId: number;
  commentId: number;
  path: string;
  position: number;
}

const CONTROLLER_ID = 'forgejo-pull-review-comments';
const CONTROLLER_LABEL = 'Forgejo Pull Request Reviews';
export const COMMAND_ADD_COMMENT = 'forgejoToolkit.addPullReviewComment';
export const COMMAND_DELETE_COMMENT = 'forgejoToolkit.deletePullReviewComment';

export class PullReviewCommentController implements vscode.Disposable {
  private readonly _controller: vscode.CommentController;
  private readonly _cache = new Map<string, PullRequestReviewCache>();
  private readonly _loading = new Map<string, Promise<PullRequestReviewCache>>();
  private readonly _threads = new Map<string, vscode.CommentThread>();
  private readonly _commentContextMap = new Map<string, CommentContext>();
  private readonly _disposables: vscode.Disposable[] = [];

  constructor(
    private readonly _config: ConfigManager,
    private readonly _logger?: Logger,
  ) {
    this._controller = vscode.comments.createCommentController(CONTROLLER_ID, CONTROLLER_LABEL);
    this._controller.commentingRangeProvider = this._createRangeProvider();
    this._disposables.push(
      this._controller,
      vscode.workspace.onDidOpenTextDocument((document) => this._onOpenDocument(document)),
      vscode.window.onDidChangeActiveTextEditor((editor) => {
        if (editor?.document) {
          this._onOpenDocument(editor.document);
        }
      }),
    );
  }

  dispose(): void {
    for (const thread of this._threads.values()) {
      thread.dispose();
    }
    this._threads.clear();
    this._commentContextMap.clear();
    for (const disposable of this._disposables) {
      disposable.dispose();
    }
    this._disposables.length = 0;
  }

  getCommentContext(contextValue: string): CommentContext | undefined {
    return this._commentContextMap.get(contextValue);
  }

  private _createRangeProvider(): vscode.CommentingRangeProvider {
    return {
      provideCommentingRanges: (document: vscode.TextDocument) => {
        // The current VS Code Comments API no longer exposes onDidCreateCommentThread,
        // so new comments are added via the editor context command instead of the
        // gutter + icon. Returning an empty range avoids showing a non-functional
        // gutter button.
        if (document.uri.scheme !== FORGEJO_PR_SCHEME) {
          return [];
        }
        return [];
      },
    };
  }

  private _cacheKey(params: { instanceId: string; owner: string; repo: string; index: number }): string {
    return `${params.instanceId}:${params.owner}:${params.repo}:${params.index}`;
  }

  private _threadKey(params: {
    owner: string;
    repo: string;
    index: number;
    path: string;
    reviewId: number;
    commentId: number;
  }): string {
    return `${params.owner}:${params.repo}:${params.index}:${params.path}:${params.reviewId}:${params.commentId}`;
  }

  private _parseUri(uri: vscode.Uri): ForgejoPrUriParams | undefined {
    if (uri.scheme !== FORGEJO_PR_SCHEME || !uri.query) {
      return undefined;
    }
    try {
      const query = JSON.parse(uri.query) as Partial<ForgejoPrUriParams>;
      const pathMatch = uri.path.match(/^\/([^/]+)\/([^/]+)\/([^/]+)\/(.+)$/);
      if (!pathMatch) {
        return undefined;
      }
      const [, instanceId, owner, repo, filepath] = pathMatch;
      const index = typeof query.index === 'number' ? query.index : Number(query.index);
      return {
        instanceId,
        owner,
        repo,
        index: Number.isNaN(index) ? 0 : index,
        ref: query.ref ?? '',
        path: filepath,
        isBase: query.isBase ?? false,
        status: query.status,
      };
    } catch {
      return undefined;
    }
  }

  private async _loadReviewData(params: {
    instanceId: string;
    owner: string;
    repo: string;
    index: number;
  }): Promise<PullRequestReviewCache> {
    const key = this._cacheKey(params);
    const cached = this._cache.get(key);
    if (cached) {
      return cached;
    }

    const loading = this._loading.get(key);
    if (loading) {
      return loading;
    }

    const promise = this._fetchReviewData(params).then((data) => {
      this._cache.set(key, data);
      this._loading.delete(key);
      return data;
    });
    this._loading.set(key, promise);
    return promise;
  }

  private async _fetchReviewData(params: {
    instanceId: string;
    owner: string;
    repo: string;
    index: number;
  }): Promise<PullRequestReviewCache> {
    const instance = this._findInstance(params.instanceId);
    if (!instance) {
      throw new Error(`Forgejo instance not found: ${params.instanceId}`);
    }

    const client = new ForgejoClient(instance.url, instance.token, this._logger);
    const [diffText, reviews] = await Promise.all([
      client.getPullRequestDiff(params.owner, params.repo, params.index),
      client.listPullReviews(params.owner, params.repo, params.index),
    ]);

    const diff = parsePullDiff(diffText);
    const reviewData: PullReviewData[] = [];
    await Promise.all(
      reviews.map(async (review) => {
        const reviewId = review.id;
        if (typeof reviewId !== 'number') {
          return;
        }
        try {
          const comments = await client.getPullReviewComments(params.owner, params.repo, params.index, reviewId);
          reviewData.push({ review, comments });
        } catch (error) {
          const err = error instanceof Error ? error.message : String(error);
          this._logger?.error(`Failed to load pull review comments ${reviewId}: ${err}`);
        }
      }),
    );

    return { diff, reviews: reviewData };
  }

  private _findInstance(instanceId: string): ForgejoInstance | undefined {
    return this._config.getInstances().find((i) => i.id === instanceId);
  }

  private async _onOpenDocument(document: vscode.TextDocument): Promise<void> {
    if (document.uri.scheme !== FORGEJO_PR_SCHEME) {
      return;
    }
    const params = this._parseUri(document.uri);
    if (!params) {
      return;
    }

    try {
      const data = await this._loadReviewData(params);
      this._renderThreads(document, params, data);
    } catch (error) {
      const err = error instanceof Error ? error.message : String(error);
      this._logger?.error(
        `Failed to load pull request reviews for ${params.owner}/${params.repo}#${params.index}: ${err}`,
      );
    }
  }

  private _renderThreads(
    document: vscode.TextDocument,
    params: ForgejoPrUriParams,
    data: PullRequestReviewCache,
  ): void {
    const fileMap = data.diff.files.get(params.path);
    if (!fileMap) {
      return;
    }

    const threadsToKeep = new Set<string>();

    for (const { review, comments } of data.reviews) {
      const reviewId = review.id;
      if (typeof reviewId !== 'number') {
        continue;
      }
      for (const comment of comments) {
        const commentId = comment.id;
        const position = comment.position ?? comment.original_position;
        const path = comment.path;
        if (typeof commentId !== 'number' || typeof position !== 'number' || !path) {
          continue;
        }
        if (path !== params.path) {
          continue;
        }

        const lineInfo = fileMap.positions.get(position);
        if (!lineInfo) {
          continue;
        }

        let uri: vscode.Uri;
        let line: number | undefined;
        if (lineInfo.type === 'deleted') {
          uri = this._buildUri({ ...params, isBase: true });
          line = lineInfo.baseLine;
        } else {
          uri = this._buildUri({ ...params, isBase: false });
          line = lineInfo.headLine;
        }
        if (line === undefined) {
          continue;
        }
        if (document.uri.toString() !== uri.toString()) {
          continue;
        }

        const key = this._threadKey({
          owner: params.owner,
          repo: params.repo,
          index: params.index,
          path: params.path,
          reviewId,
          commentId,
        });
        threadsToKeep.add(key);

        const instance = this._findInstance(params.instanceId);
        const instanceName = instance?.name ?? params.instanceId;
        const existing = this._threads.get(key);
        if (existing) {
          existing.comments = [this._createComment(params, reviewId, comment, position, instanceName)];
          continue;
        }

        const thread = this._controller.createCommentThread(uri, new vscode.Range(line, 0, line, 0), [
          this._createComment(params, reviewId, comment, position, instanceName),
        ]);
        thread.canReply = false;
        thread.collapsibleState = vscode.CommentThreadCollapsibleState.Expanded;
        this._threads.set(key, thread);
      }
    }

    // Dispose threads for comments that no longer exist.
    for (const [key, thread] of this._threads.entries()) {
      if (!threadsToKeep.has(key)) {
        thread.dispose();
        this._threads.delete(key);
      }
    }
  }

  private _buildUri(params: ForgejoPrUriParams & { isBase: boolean }): vscode.Uri {
    const query = JSON.stringify({
      index: params.index,
      ref: params.ref,
      isBase: params.isBase,
      status: params.status,
    });
    return vscode.Uri.from({
      scheme: FORGEJO_PR_SCHEME,
      path: `/${params.instanceId}/${params.owner}/${params.repo}/${params.path}`,
      query,
    });
  }

  private _createComment(
    params: ForgejoPrUriParams,
    reviewId: number,
    comment: PullReviewComment,
    position: number,
    instanceName: string,
  ): vscode.Comment {
    const user = comment.user;
    const authorName = user?.login ?? vscode.l10n.t('Unknown');
    const bodyText = comment.body ?? '';
    const timestamp = comment.created_at ? new Date(comment.created_at) : undefined;
    const context: CommentContext = {
      instanceId: params.instanceId,
      instanceName,
      owner: params.owner,
      repo: params.repo,
      index: params.index,
      reviewId,
      commentId: comment.id as number,
      path: params.path,
      position,
    };
    const contextValue = this._encodeCommentContext(context);
    this._commentContextMap.set(contextValue, context);

    return {
      body: bodyText,
      mode: vscode.CommentMode.Preview,
      author: {
        name: authorName,
        iconPath: user?.avatar_url ? vscode.Uri.parse(user.avatar_url) : undefined,
      },
      timestamp,
      contextValue,
    };
  }

  private _encodeCommentContext(context: CommentContext): string {
    return `forgejo:${context.instanceId}:${context.owner}:${context.repo}:${context.index}:${context.reviewId}:${context.commentId}:${context.path}:${context.position}`;
  }

  async addComment(editor: vscode.TextEditor, lineNumber?: number): Promise<void> {
    const params = this._parseUri(editor.document.uri);
    if (!params) {
      vscode.window.showWarningMessage(vscode.l10n.t('No Forgejo PR diff file is active'));
      return;
    }

    const instance = this._findInstance(params.instanceId);
    if (!instance) {
      vscode.window.showErrorMessage(vscode.l10n.t('Forgejo instance not found'));
      return;
    }

    const line = lineNumber ?? editor.selection.active.line;
    const data = await this._loadReviewData(params).catch((error: unknown) => {
      const err = error instanceof Error ? error.message : String(error);
      this._logger?.error(`Failed to load pull request diff for commenting: ${err}`);
      return undefined;
    });
    if (!data) {
      return;
    }

    const fileMap = data.diff.files.get(params.path);
    if (!fileMap) {
      vscode.window.showErrorMessage(vscode.l10n.t('Unable to locate the file in the pull request diff'));
      return;
    }

    const positions = params.isBase ? fileMap.baseLineToPositions.get(line) : fileMap.headLineToPositions.get(line);
    const position = positions?.[0];
    if (typeof position !== 'number') {
      vscode.window.showErrorMessage(vscode.l10n.t('Unable to map the selected line to a diff position'));
      return;
    }

    const body = await vscode.window.showInputBox({
      prompt: vscode.l10n.t('Enter a review comment'),
      placeHolder: vscode.l10n.t('Comment on this line'),
      ignoreFocusOut: true,
    });

    if (!body || !body.trim()) {
      return;
    }

    const client = new ForgejoClient(instance.url, instance.token, this._logger);
    try {
      const comment: { body: string; path: string; old_position?: number; new_position?: number } = {
        body: body.trim(),
        path: params.path,
      };
      if (params.isBase) {
        comment.old_position = position;
      } else {
        comment.new_position = position;
      }
      await client.createPullReviewWithComment(params.owner, params.repo, params.index, comment);
      this._invalidateCache(params);
      await this._refreshOpenPrDocuments(params);
      vscode.window.showInformationMessage(vscode.l10n.t('Review comment added'));
    } catch (error) {
      const err = error instanceof Error ? error.message : String(error);
      this._logger?.error(`Failed to create pull review comment: ${err}`);
      vscode.window.showErrorMessage(vscode.l10n.t('Failed to add review comment: {0}', err));
    }
  }

  private _invalidateCache(params: { instanceId: string; owner: string; repo: string; index: number }): void {
    this._cache.delete(this._cacheKey(params));
  }

  private async _refreshOpenPrDocuments(params: {
    instanceId: string;
    owner: string;
    repo: string;
    index: number;
  }): Promise<void> {
    for (const document of vscode.workspace.textDocuments) {
      const docParams = this._parseUri(document.uri);
      if (
        docParams &&
        docParams.instanceId === params.instanceId &&
        docParams.owner === params.owner &&
        docParams.repo === params.repo &&
        docParams.index === params.index
      ) {
        await this._onOpenDocument(document);
      }
    }
  }

  async deleteComment(context: CommentContext): Promise<void> {
    const instance = this._findInstance(context.instanceId);
    if (!instance) {
      vscode.window.showErrorMessage(vscode.l10n.t('Forgejo instance not found'));
      return;
    }

    const confirm = await vscode.window.showWarningMessage(
      vscode.l10n.t('Delete this review comment?'),
      { modal: true },
      vscode.l10n.t('Delete'),
    );
    if (confirm !== vscode.l10n.t('Delete')) {
      return;
    }

    const client = new ForgejoClient(instance.url, instance.token, this._logger);
    try {
      await client.deletePullReviewComment(
        context.owner,
        context.repo,
        context.index,
        context.reviewId,
        context.commentId,
      );
      this._invalidateCache(context);
      await this._refreshOpenPrDocuments(context);
      vscode.window.showInformationMessage(vscode.l10n.t('Review comment deleted'));
    } catch (error) {
      const err = error instanceof Error ? error.message : String(error);
      this._logger?.error(`Failed to delete pull review comment ${context.commentId}: ${err}`);
      vscode.window.showErrorMessage(vscode.l10n.t('Failed to delete review comment: {0}', err));
    }
  }
}
