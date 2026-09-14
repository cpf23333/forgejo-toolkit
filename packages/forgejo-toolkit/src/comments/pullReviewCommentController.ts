import * as vscode from 'vscode';
import { ForgejoClient } from '../api/client';
import { ConfigManager } from '../config';
import { FORGEJO_PR_SCHEME, type ForgejoPrUriParams } from '../prFileSystemProvider';
import { parsePullDiff, type ParsedPullDiff } from '../utils/parseDiff';
import { resolveReviewCommentLine } from './reviewCommentPosition';
import { pullReviewThreadKey, pullReviewThreadMatchesScope, type PullReviewThreadScope } from './pullReviewThreadKeys';
import type { PullReview, PullReviewComment } from '@cpf23333-forgejo-toolkit/api';
import type { ForgejoInstance } from '@cpf23333-forgejo-toolkit/shared/webview/messages';
import type { Logger } from '../logger';
import { PullReviewCommentPanel, type PullReviewCommentContext } from './pullReviewCommentPanel';
import { resolveAttachmentImages } from '../utils/resolveAttachmentImages';
import { toHardBreakMarkdown } from './commentBodyMarkdown';
import { userFacingErrorMessage } from '../api/errors';
import { InFlightTasks } from '../worktree/inFlightTasks';
import { createTimedCache } from '../utils/timedCache';

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
  /** 1-based line number in the side's file the comment was rendered on. */
  position: number;
}

const CONTROLLER_ID = 'forgejo-pull-review-comments';
const CONTROLLER_LABEL = 'Forgejo Pull Request Reviews';
export const COMMAND_ADD_COMMENT = 'forgejoToolkit.addPullReviewComment';
export const COMMAND_DELETE_COMMENT = 'forgejoToolkit.deletePullReviewComment';

// Short TTL that only coalesces bursts (opening a multi-file diff fires one
// load per document; a refresh after submitting reloads every open document).
// Mutations invalidate explicitly, so staleness is bounded by the TTL.
const REVIEW_DATA_CACHE_TTL_MS = 15_000;

// Gates the "Add Pull Review Comment" line-number menu entry. The stock
// `resourceScheme` context key is not reliable inside diff editors, so the
// controller maintains its own key instead.
const CONTEXT_IN_PR_DIFF = 'forgejoToolkit.inPullRequestDiff';

export class PullReviewCommentController implements vscode.Disposable {
  private readonly _controller: vscode.CommentController;
  private readonly _threads = new Map<string, vscode.CommentThread>();
  private readonly _commentContextMap = new Map<string, CommentContext>();
  private readonly _disposables: vscode.Disposable[] = [];
  private readonly _reviewDataCache = createTimedCache<PullRequestReviewCache>(REVIEW_DATA_CACHE_TTL_MS);
  private readonly _reviewDataInFlight = new InFlightTasks();
  // VS Code's built-in comment-thread range decoration is an inline decoration:
  // the first line (the thread range always starts at column 0) and interior
  // lines get a full-width band via line-break fill, but the final line is
  // only tinted up to the range's end column, which reads as "the last line
  // is not highlighted". Paint a whole-line decoration over just the final
  // line of expanded multi-line thread ranges to complete the band.
  private readonly _rangeDecoration = vscode.window.createTextEditorDecorationType({
    isWholeLine: true,
    backgroundColor: new vscode.ThemeColor('editorCommentsWidget.rangeBackground'),
  });
  // All thread mutations are chained through this promise: two interleaved
  // renders of the same document could both miss `this._threads.get(key)`
  // before either awaits, creating a duplicate thread whose Map entry is then
  // overwritten (the first one leaks and stays visible).
  private _renderChain: Promise<void> = Promise.resolve();

  /** Invoked after a review comment or a whole review is submitted; used to refresh the dashboard. */
  public onReviewSubmitted:
    | ((params: { instanceId: string; owner: string; repo: string; index: number }) => void)
    | undefined;

  constructor(
    private readonly _config: ConfigManager,
    private readonly _extensionUri: vscode.Uri,
    private readonly _logger?: Logger,
  ) {
    this._controller = vscode.comments.createCommentController(CONTROLLER_ID, CONTROLLER_LABEL);
    this._controller.commentingRangeProvider = this._createRangeProvider();
    this._disposables.push(
      this._controller,
      this._rangeDecoration,
      vscode.workspace.onDidOpenTextDocument((document) => this._onOpenDocument(document)),
      vscode.window.onDidChangeActiveTextEditor((editor) => {
        this._updateActiveEditorContext(editor);
        if (editor?.document) {
          this._onOpenDocument(editor.document);
        }
        // Safety net: if an editor ever loses its decorations without a
        // visible-editors event, focus changes restore them.
        this._applyThreadRangeDecorations();
      }),
      // Threads outlive editor visibility changes; re-apply the range
      // decorations when a document becomes visible in a (new) editor.
      vscode.window.onDidChangeVisibleTextEditors(() => this._applyThreadRangeDecorations()),
      // The extension host learns about user-initiated comment-thread
      // collapse/expand only through a silent thread update — no event is
      // fired (verified against the shipped extension-host bundle). But the
      // zone widget's height change always alters the editor's visible
      // ranges, so use that as the trigger and debounce it (scrolling fires
      // it constantly). The small delay also lets the updated collapsible
      // state round-trip from the workbench before we read it.
      vscode.window.onDidChangeTextEditorVisibleRanges(() => this._scheduleThreadRangeDecorationSync()),
    );
    this._updateActiveEditorContext(vscode.window.activeTextEditor);
  }

  private _threadRangeDecorationSyncTimer: ReturnType<typeof setTimeout> | undefined;

  private _scheduleThreadRangeDecorationSync(): void {
    if (this._threadRangeDecorationSyncTimer !== undefined) {
      clearTimeout(this._threadRangeDecorationSyncTimer);
    }
    this._threadRangeDecorationSyncTimer = setTimeout(() => {
      this._threadRangeDecorationSyncTimer = undefined;
      this._applyThreadRangeDecorations();
    }, 50);
  }

  private _updateActiveEditorContext(editor: vscode.TextEditor | undefined): void {
    void vscode.commands.executeCommand(
      'setContext',
      CONTEXT_IN_PR_DIFF,
      editor?.document.uri.scheme === FORGEJO_PR_SCHEME,
    );
  }

  dispose(): void {
    if (this._threadRangeDecorationSyncTimer !== undefined) {
      clearTimeout(this._threadRangeDecorationSyncTimer);
      this._threadRangeDecorationSyncTimer = undefined;
    }
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

  private _threadScope(params: ForgejoPrUriParams): PullReviewThreadScope {
    return {
      instanceId: params.instanceId,
      owner: params.owner,
      repo: params.repo,
      index: params.index,
      path: params.path,
      isBase: params.isBase,
    };
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

  private _reviewDataCacheKey(params: { instanceId: string; owner: string; repo: string; index: number }): string {
    return `${params.instanceId}:${params.owner}/${params.repo}#${params.index}`;
  }

  private _loadReviewData(params: {
    instanceId: string;
    owner: string;
    repo: string;
    index: number;
  }): Promise<PullRequestReviewCache> {
    const key = this._reviewDataCacheKey(params);
    const cached = this._reviewDataCache.get(key);
    if (cached) {
      return Promise.resolve(cached);
    }
    // Coalesce concurrent loads of the same pull request (one per open
    // document when a multi-file diff opens) into a single fetch.
    return this._reviewDataInFlight.run(key, async () => {
      const data = await this._fetchReviewData(params);
      this._reviewDataCache.set(key, data);
      return data;
    });
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

    const client = new ForgejoClient(instance.url, instance.token, this._logger, instance.syncApiUrlsToInstanceUrl);
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
          const err = userFacingErrorMessage(error);
          this._logger?.error(`Failed to load pull review comments ${reviewId}: ${err}`);
        }
      }),
    );

    return { diff, reviews: reviewData };
  }

  private _findInstance(instanceId: string): ForgejoInstance | undefined {
    return this._config.getInstances().find((i) => i.id === instanceId);
  }

  private _enqueueRender(task: () => Promise<void>): Promise<void> {
    const run = this._renderChain.then(task).catch((error: unknown) => {
      const err = userFacingErrorMessage(error);
      this._logger?.error(`Failed to render pull request review threads: ${err}`);
    });
    this._renderChain = run;
    return run;
  }

  private _onOpenDocument(document: vscode.TextDocument): Promise<void> {
    if (document.uri.scheme !== FORGEJO_PR_SCHEME) {
      return Promise.resolve();
    }
    const params = this._parseUri(document.uri);
    if (!params) {
      return Promise.resolve();
    }
    // onDidOpenTextDocument and onDidChangeActiveTextEditor fire together for
    // the same diff document; serialize the load+render so the second trigger
    // reuses the cached data instead of racing the first render.
    return this._enqueueRender(() => this._loadAndRender(document, params));
  }

  private async _loadAndRender(document: vscode.TextDocument, params: ForgejoPrUriParams): Promise<void> {
    try {
      const data = await this._loadReviewData(params);
      await this._renderThreads(document, params, data);
    } catch (error) {
      const err = userFacingErrorMessage(error);
      this._logger?.error(
        `Failed to load pull request reviews for ${params.owner}/${params.repo}#${params.index}: ${err}`,
      );
    }
  }

  private async _renderThreads(
    document: vscode.TextDocument,
    params: ForgejoPrUriParams,
    data: PullRequestReviewCache,
  ): Promise<void> {
    const scope = this._threadScope(params);
    const threadsToKeep = new Set<string>();

    for (const { review, comments } of data.reviews) {
      const reviewId = review.id;
      if (typeof reviewId !== 'number') {
        continue;
      }
      for (const comment of comments) {
        const commentId = comment.id;
        const path = comment.path;
        if (typeof commentId !== 'number' || !path) {
          continue;
        }
        if (path !== params.path) {
          continue;
        }

        // Forgejo positions are 1-based file line numbers, not diff
        // positions, so resolve the comment directly against the file.
        const resolved = resolveReviewCommentLine(comment);
        if (!resolved) {
          continue;
        }

        const uri = this._buildUri({ ...params, isBase: resolved.side === 'base' });
        if (document.uri.toString() !== uri.toString()) {
          continue;
        }
        if (resolved.line >= document.lineCount) {
          // Outdated comment whose line no longer exists in this revision.
          this._logger?.info(
            `Skipping pull review comment ${commentId} on ${path}: line ${resolved.line + 1} exceeds the document (${document.lineCount} lines)`,
          );
          continue;
        }

        const key = pullReviewThreadKey(scope, reviewId, commentId);
        threadsToKeep.add(key);

        const instance = this._findInstance(params.instanceId);
        const instanceName = instance?.name ?? params.instanceId;
        // Multi-line comments anchor at the first line and extend
        // `extraLines` lines forward; clamp to the document end for outdated
        // ranges whose tail lines no longer exist in this revision. The range
        // must end at the last line's end character: ending at column 0 would
        // leave the final line unhighlighted.
        const endLine = Math.min(resolved.line + resolved.extraLines, document.lineCount - 1);
        const endCharacter = document.lineAt(endLine).text.length;
        const threadRange = new vscode.Range(resolved.line, 0, endLine, endCharacter);
        const existing = this._threads.get(key);
        if (existing) {
          this._dropCommentContexts(existing);
          existing.range = threadRange;
          existing.comments = [await this._createComment(params, reviewId, comment, resolved.line + 1, instanceName)];
          continue;
        }

        const thread = this._controller.createCommentThread(uri, threadRange, [
          await this._createComment(params, reviewId, comment, resolved.line + 1, instanceName),
        ]);
        thread.canReply = false;
        thread.collapsibleState = vscode.CommentThreadCollapsibleState.Expanded;
        this._threads.set(key, thread);
      }
    }

    // Dispose only threads of the document being re-rendered (including its
    // diff side); threads of other files, pull requests, or the other side
    // of the same file stay untouched.
    for (const [key, thread] of this._threads.entries()) {
      if (pullReviewThreadMatchesScope(key, scope) && !threadsToKeep.has(key)) {
        this._dropCommentContexts(thread);
        thread.dispose();
        this._threads.delete(key);
      }
    }
    this._applyThreadRangeDecorations();
  }

  // Re-apply the whole-line last-line supplements to every visible editor.
  // Threads spanning a single line are left to VS Code's native inline
  // decoration; for multi-line threads only the final line needs the
  // supplement (see the decoration type's comment). Ranges are deduplicated
  // per line: overlapping threads ending on the same line would otherwise
  // stack the translucent theme color once per thread. Like VS Code's own
  // comment-thread-range decorator, only expanded threads are painted.
  private _applyThreadRangeDecorations(): void {
    const lastLineByUri = new Map<string, Map<number, vscode.Range>>();
    for (const thread of this._threads.values()) {
      const range = thread.range;
      if (!range || range.start.line === range.end.line) {
        continue;
      }
      if (thread.collapsibleState !== vscode.CommentThreadCollapsibleState.Expanded) {
        continue;
      }
      const uriKey = thread.uri.toString();
      let byLine = lastLineByUri.get(uriKey);
      if (!byLine) {
        byLine = new Map();
        lastLineByUri.set(uriKey, byLine);
      }
      if (!byLine.has(range.end.line)) {
        byLine.set(range.end.line, new vscode.Range(range.end.line, 0, range.end.line, range.end.character));
      }
    }
    for (const editor of vscode.window.visibleTextEditors) {
      const byLine = lastLineByUri.get(editor.document.uri.toString());
      editor.setDecorations(this._rangeDecoration, byLine ? [...byLine.values()] : []);
    }
    // Diagnostics for "multi-line range highlight misses lines" reports: if a
    // user reproduces it with `forgejoToolkit.debug` enabled, this shows
    // whether the decoration reached the affected editor (count per editor
    // URI) or never matched it (0 / editor absent from the list).
    if (lastLineByUri.size > 0) {
      const detail = vscode.window.visibleTextEditors
        .map(
          (editor) =>
            `${editor.document.uri.toString()}=${lastLineByUri.get(editor.document.uri.toString())?.size ?? 0}`,
        )
        .join(', ');
      this._logger?.debug(`Thread range decorations applied per visible editor: ${detail}`);
    }
  }

  // The map is keyed by an encoded context string that includes the position,
  // so a comment whose line moves (or whose thread is disposed) would leave a
  // stale entry behind unless its old contextValue is removed here.
  private _dropCommentContexts(thread: vscode.CommentThread): void {
    for (const comment of thread.comments) {
      if (comment.contextValue) {
        this._commentContextMap.delete(comment.contextValue);
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

  private async _createComment(
    params: ForgejoPrUriParams,
    reviewId: number,
    comment: PullReviewComment,
    position: number,
    instanceName: string,
  ): Promise<vscode.Comment> {
    const user = comment.user;
    const authorName = user?.login ?? vscode.l10n.t('Unknown');
    const instance = this._findInstance(params.instanceId);
    let bodyText = comment.body ?? '';
    if (instance?.token && instance.url) {
      bodyText = await resolveAttachmentImages(bodyText, instance);
    }
    const bodyMarkdown = new vscode.MarkdownString(toHardBreakMarkdown(bodyText));
    bodyMarkdown.supportHtml = true;
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
      body: bodyMarkdown,
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

    // A non-empty selection comments on the whole line range (Forgejo anchors
    // at the first line and `extra_lines_count` extends the range forward); a
    // bare cursor or an explicit line-number menu click stays single-line.
    let line = lineNumber ?? editor.selection.active.line;
    let extraLinesCount = 0;
    if (!editor.selection.isEmpty) {
      const start = editor.selection.start.line;
      let end = editor.selection.end.line;
      // A selection ending at column 0 excludes that last line.
      if (end > start && editor.selection.end.character === 0) {
        end -= 1;
      }
      line = start;
      extraLinesCount = end - start;
    }

    const data = await this._loadReviewData(params).catch((error: unknown) => {
      const err = userFacingErrorMessage(error);
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

    // Forgejo expects 1-based file line numbers (`new_position` /
    // `old_position`), so no diff-position conversion is needed. The diff
    // map only guards that the line is part of the pull request diff;
    // context lines are allowed, matching Forgejo's own web UI.
    const sideLines = params.isBase ? fileMap.baseLines : fileMap.headLines;
    if (!sideLines.get(line) || (extraLinesCount > 0 && !sideLines.get(line + extraLinesCount))) {
      vscode.window.showErrorMessage(vscode.l10n.t('Comments can only be added to lines within the pull request diff'));
      return;
    }

    const position = line + 1;

    const pendingReview = data.reviews.find(
      (r) => r.review.state === 'PENDING' && r.review.user?.login === instance.username,
    )?.review;
    const pendingReviewId = typeof pendingReview?.id === 'number' ? pendingReview.id : undefined;

    const context: PullReviewCommentContext = {
      instanceId: params.instanceId,
      owner: params.owner,
      repo: params.repo,
      index: params.index,
      path: params.path,
      position,
      isBase: params.isBase,
      lineNumber: line,
      extraLinesCount: extraLinesCount > 0 ? extraLinesCount : undefined,
      mode: 'review',
      pendingReviewId,
    };

    PullReviewCommentPanel.createOrShow(this._extensionUri, this._config, context, {
      onSubmitted: () => {
        this.onReviewSubmitted?.({
          instanceId: params.instanceId,
          owner: params.owner,
          repo: params.repo,
          index: params.index,
        });
        this._refreshOpenPrDocuments(params).catch((error: unknown) => {
          const err = userFacingErrorMessage(error);
          this._logger?.error(`Failed to refresh PR documents after review comment: ${err}`);
        });
      },
      onDeleted: () => {
        this._refreshOpenPrDocuments(params).catch((error: unknown) => {
          const err = userFacingErrorMessage(error);
          this._logger?.error(`Failed to refresh PR documents after review deletion: ${err}`);
        });
      },
    });
  }

  private async _refreshOpenPrDocuments(params: {
    instanceId: string;
    owner: string;
    repo: string;
    index: number;
  }): Promise<void> {
    // Every caller gets here after a mutation (submit/delete), so drop the
    // cached data first to make the new state visible immediately.
    this._reviewDataCache.delete(this._reviewDataCacheKey(params));
    let data: PullRequestReviewCache;
    try {
      data = await this._loadReviewData(params);
    } catch (error) {
      const err = userFacingErrorMessage(error);
      this._logger?.error(
        `Failed to reload pull request reviews for ${params.owner}/${params.repo}#${params.index}: ${err}`,
      );
      return;
    }
    // Load once, then re-render every open document of the pull request with
    // the same data (previously each document triggered its own full load).
    const renders: Promise<void>[] = [];
    for (const document of vscode.workspace.textDocuments) {
      const docParams = this._parseUri(document.uri);
      if (
        docParams &&
        docParams.instanceId === params.instanceId &&
        docParams.owner === params.owner &&
        docParams.repo === params.repo &&
        docParams.index === params.index
      ) {
        renders.push(this._enqueueRender(() => this._renderThreads(document, docParams, data)));
      }
    }
    await Promise.all(renders);
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

    const client = new ForgejoClient(instance.url, instance.token, this._logger, instance.syncApiUrlsToInstanceUrl);
    try {
      await client.deletePullReviewComment(
        context.owner,
        context.repo,
        context.index,
        context.reviewId,
        context.commentId,
      );
      await this._refreshOpenPrDocuments(context);
      vscode.window.showInformationMessage(vscode.l10n.t('Review comment deleted'));
    } catch (error) {
      const err = userFacingErrorMessage(error);
      this._logger?.error(`Failed to delete pull review comment ${context.commentId}: ${err}`);
      vscode.window.showErrorMessage(vscode.l10n.t('Failed to delete review comment: {0}', err));
    }
  }
}
