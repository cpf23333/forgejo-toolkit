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
import { createTimedCache, estimateValueBytes } from '../utils/timedCache';

interface PullReviewData {
  review: PullReview;
  comments: PullReviewComment[];
  /**
   * True when the review's comment list could not be fetched: `comments` is then
   * empty because the data is missing, not because the review has none. The
   * entry is still kept so its `state`/`user` stay visible — dropping it hid a
   * pending review from both the panel and `addComment`'s lookup.
   */
  incomplete?: boolean;
}

interface PullRequestReviewCache {
  diff: ParsedPullDiff;
  reviews: PullReviewData[];
  /**
   * Ids of reviews whose comments could not be fetched during this load. Their
   * entries stay in `reviews` with `incomplete: true`, so the failure is never
   * silently presented as "this review has no comments".
   */
  incompleteReviewIds: number[];
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

// A parsed diff is retained by this cache and a 10 MiB patch parses into several
// MiB of line maps, so the TTL alone is not a bound: an entry is only released
// when its key is read again after expiry. Keep only the few pull requests that
// are actually open, and cap their combined footprint.
const REVIEW_DATA_MAX_ENTRIES = 4;
const REVIEW_DATA_MAX_BYTES = 32 * 1024 * 1024;

// Gates the "Add Pull Review Comment" line-number menu entry. The stock
// `resourceScheme` context key is not reliable inside diff editors, so the
// controller maintains its own key instead.
const CONTEXT_IN_PR_DIFF = 'forgejoToolkit.inPullRequestDiff';

// Debounce for the fallback cleanup of threads whose document is no longer
// visible (see _scheduleInvisibleThreadSweep). Long enough to coalesce the
// events of a closing diff editor, short enough that leftover threads do not
// sit in the Comments panel.
const INVISIBLE_THREAD_SWEEP_DELAY_MS = 250;

// A review's comments are fetched one request per review, and the review list
// can reach the shared 500-item list cap: firing them all at once opens up to
// 500 concurrent authenticated requests against a self-hosted instance. The
// sibling comment-asset fan-out in `api/client.ts` uses the same pool size for
// the same reason. Four keeps a busy pull request's load to a handful of
// in-flight requests while still finishing in a few round trips.
const REVIEW_COMMENTS_CONCURRENCY = 4;

/**
 * Run `task` for every item with at most `limit` tasks in flight. The cursor is
 * shared and bumped synchronously in the loop condition, so a task that resolves
 * its worker immediately cannot push past the limit.
 */
async function mapWithConcurrency<T>(
  items: readonly T[],
  limit: number,
  task: (item: T) => Promise<void>,
): Promise<void> {
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (let index = next++; index < items.length; index = next++) {
      await task(items[index]);
    }
  });
  await Promise.all(workers);
}

export class PullReviewCommentController implements vscode.Disposable {
  private readonly _controller: vscode.CommentController;
  private readonly _threads = new Map<string, vscode.CommentThread>();
  private readonly _commentContextMap = new Map<string, CommentContext>();
  private readonly _disposables: vscode.Disposable[] = [];
  private readonly _reviewDataCache = createTimedCache<PullRequestReviewCache>(REVIEW_DATA_CACHE_TTL_MS, {
    maxEntries: REVIEW_DATA_MAX_ENTRIES,
    maxBytes: REVIEW_DATA_MAX_BYTES,
    // The maps dominate: every diff line is a Map entry, and each stores the
    // path/line keys plus their line-type strings.
    sizeOf: (value) => estimateValueBytes(value.diff) + estimateValueBytes(value.reviews),
  });
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
      // Threads render on a specific document; when that document closes
      // (for example a PR diff editor being closed), its threads must not
      // linger in the Comments panel.
      vscode.workspace.onDidCloseTextDocument((document) => this._onCloseDocument(document)),
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
      // decorations when a document becomes visible in a (new) editor, and
      // sweep threads whose document is not shown anywhere any more (VS Code
      // does not fire the close event for every virtual PR document).
      vscode.window.onDidChangeVisibleTextEditors(() => {
        this._applyThreadRangeDecorations();
        this._scheduleInvisibleThreadSweep();
      }),
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

  private _invisibleThreadSweepTimer: ReturnType<typeof setTimeout> | undefined;

  /**
   * Schedule the fallback cleanup for threads of documents that are no longer
   * visible in any editor. `onDidCloseTextDocument` is the primary signal, but
   * VS Code does not reliably fire it for the virtual PR documents: closing a
   * diff editor can leave its threads in the Comments panel for a long time.
   * Debounced because a diff editor closing fires the visible-editor event
   * more than once, and a document that is merely no longer active is
   * re-rendered by the active-editor handler when the user returns to it.
   */
  private _scheduleInvisibleThreadSweep(): void {
    if (this._invisibleThreadSweepTimer !== undefined) {
      clearTimeout(this._invisibleThreadSweepTimer);
    }
    this._invisibleThreadSweepTimer = setTimeout(() => {
      this._invisibleThreadSweepTimer = undefined;
      this._dropThreadsOfInvisibleDocuments();
    }, INVISIBLE_THREAD_SWEEP_DELAY_MS);
  }

  private _dropThreadsOfInvisibleDocuments(): void {
    if (this._threads.size === 0) {
      return;
    }
    const visibleUris = new Set(vscode.window.visibleTextEditors.map((editor) => editor.document.uri.toString()));
    let dropped = false;
    for (const [key, thread] of this._threads.entries()) {
      if (visibleUris.has(thread.uri.toString())) {
        continue;
      }
      thread.dispose();
      this._threads.delete(key);
      // After the delete: _dropCommentContexts keeps contexts a live thread
      // still carries, and this thread must no longer count as one.
      this._dropCommentContexts(thread);
      dropped = true;
    }
    if (dropped) {
      this._applyThreadRangeDecorations();
    }
  }

  dispose(): void {
    if (this._threadRangeDecorationSyncTimer !== undefined) {
      clearTimeout(this._threadRangeDecorationSyncTimer);
      this._threadRangeDecorationSyncTimer = undefined;
    }
    if (this._invisibleThreadSweepTimer !== undefined) {
      clearTimeout(this._invisibleThreadSweepTimer);
      this._invisibleThreadSweepTimer = undefined;
    }
    for (const thread of this._threads.values()) {
      thread.dispose();
    }
    this._threads.clear();
    this._commentContextMap.clear();
    // The cache holds parsed diffs (several MiB for a large patch) and lives for
    // the controller's lifetime; release them with it instead of waiting for a
    // TTL that nothing will read again.
    this._reviewDataCache.clear();
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
      ref: params.ref,
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
    // One entry per review, in the server's order: a failed comments fetch must
    // not remove the review from the list, or the panel would render an
    // incomplete comment set as if it were complete and `addComment` could no
    // longer see an existing pending review (it would start a second one).
    const reviewData: PullReviewData[] = reviews.map((review) => ({ review, comments: [] }));
    const incompleteReviewIds: number[] = [];
    await mapWithConcurrency(reviewData, REVIEW_COMMENTS_CONCURRENCY, async (entry) => {
      const reviewId = entry.review.id;
      if (typeof reviewId !== 'number') {
        return;
      }
      try {
        entry.comments = await client.getPullReviewComments(params.owner, params.repo, params.index, reviewId);
      } catch (error) {
        const err = userFacingErrorMessage(error);
        this._logger?.error(`Failed to load pull review comments ${reviewId}: ${err}`);
        entry.incomplete = true;
        incompleteReviewIds.push(reviewId);
      }
    });

    return { diff, reviews: reviewData, incompleteReviewIds };
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

  // Threads are matched by exact URI, so closing one side of a diff editor
  // only clears that side's threads; the other side (a different URI via the
  // `isBase` query flag) stays until its own document closes. VS Code fires
  // this event once per real document — closing a diff editor fires it for
  // both sides, while a virtual diff side that never became an actual
  // document never fires it (and never created threads here either, since
  // threads are only rendered for opened documents).
  private _onCloseDocument(document: vscode.TextDocument): void {
    const uriKey = document.uri.toString();
    for (const [key, thread] of this._threads.entries()) {
      if (thread.uri.toString() === uriKey) {
        thread.dispose();
        this._threads.delete(key);
        // After the delete: _dropCommentContexts keeps contexts a live thread
        // still carries, and this thread must no longer count as one.
        this._dropCommentContexts(thread);
      }
    }
  }

  private async _loadAndRender(document: vscode.TextDocument, params: ForgejoPrUriParams): Promise<void> {
    try {
      const data = await this._loadReviewData(params);
      // A review whose comments failed to load is kept in `data.reviews` (so a
      // pending review stays visible, see _fetchReviewData) but its threads are
      // necessarily missing. Say so: otherwise the diff looks like a complete
      // picture of the discussion.
      if (data.incompleteReviewIds.length > 0) {
        vscode.window.showWarningMessage(
          vscode.l10n.t(
            'Some reviews could not be loaded, so their comments may be missing: {0}',
            data.incompleteReviewIds.join(', '),
          ),
        );
      }
      // The document may have been closed while the load was in flight; the
      // close event then found no threads to dispose, so threads created now
      // would linger in the Comments panel forever.
      if (document.isClosed) {
        return;
      }
      await this._renderThreads(document, params, data);
    } catch (error) {
      const err = userFacingErrorMessage(error);
      this._logger?.error(
        `Failed to load pull request reviews for ${params.owner}/${params.repo}#${params.index}: ${err}`,
      );
      // Logging alone left a revoked token, a rate limit or an outage looking
      // exactly like "this file has no comments": the diff opened with zero
      // threads and nothing else. Say that the load failed — once per document
      // render, not per comment.
      void vscode.window.showErrorMessage(vscode.l10n.t('Could not load the review comments for this file: {0}', err));
    }
  }

  private async _renderThreads(
    document: vscode.TextDocument,
    params: ForgejoPrUriParams,
    data: PullRequestReviewCache,
  ): Promise<void> {
    const scope = this._threadScope(params);
    const threadsToKeep = new Set<string>();
    // The document can close in the middle of the loop (below), and the prune at
    // the end must run even then: threads of an earlier render stay in the panel
    // and in `_threads` otherwise, with the comment created for this render
    // never attached to anything. `break` out of the loop instead of returning.
    let documentClosed = false;

    for (const { review, comments } of data.reviews) {
      if (documentClosed) {
        break;
      }
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
          // The new comment is built first: it carries the same encoded context
          // value as the one being replaced, so dropping the old comment's
          // context before registering the new one would delete the entry the
          // re-created comment depends on — leaving a comment whose Delete
          // command finds no context and returns silently. Dropping afterwards
          // removes only the old values that are not reused (a moved line).
          const replacement = await this._createComment(params, reviewId, comment, resolved.line + 1, instanceName);
          this._dropCommentContexts(existing);
          existing.range = threadRange;
          existing.comments = [replacement];
          threadsToKeep.add(key);
          continue;
        }

        // _createComment awaits attachment resolution; re-check that the
        // document is still open before creating a thread for it (same race
        // as the post-load guard in _loadAndRender).
        if (document.isClosed) {
          documentClosed = true;
          break;
        }
        const thread = this._controller.createCommentThread(uri, threadRange, [
          await this._createComment(params, reviewId, comment, resolved.line + 1, instanceName),
        ]);
        thread.canReply = false;
        thread.collapsibleState = vscode.CommentThreadCollapsibleState.Expanded;
        this._threads.set(key, thread);
        // Only a thread this render actually attached is kept: a comment the
        // loop stopped before (the document closed) must not protect its stale
        // thread from the prune below.
        threadsToKeep.add(key);
      }
    }

    // Dispose only threads of the document being re-rendered (including its
    // diff side); threads of other files, pull requests, or the other side
    // of the same file stay untouched. Runs even when the document closed
    // mid-render, so nothing from an earlier render is left behind.
    for (const [key, thread] of this._threads.entries()) {
      if (pullReviewThreadMatchesScope(key, scope) && !threadsToKeep.has(key)) {
        thread.dispose();
        this._threads.delete(key);
        // After the delete: _dropCommentContexts keeps contexts a live thread
        // still carries, and this thread must no longer count as one.
        this._dropCommentContexts(thread);
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
  //
  // A value that a comment *still in a live thread* carries is left in place:
  // `_encodeCommentContext` is pure over the coordinates, so re-rendering a
  // comment in place builds a new comment with the identical contextValue. The
  // new comment is registered in the map before the old one is dropped (see
  // `_renderThreads`), and deleting by value would then remove the entry the
  // re-created comment's Delete command needs — the command found no context and
  // returned silently.
  private _dropCommentContexts(thread: vscode.CommentThread): void {
    for (const comment of thread.comments) {
      const contextValue = comment.contextValue;
      if (contextValue && !this._contextValueInUse(contextValue)) {
        this._commentContextMap.delete(contextValue);
      }
    }
  }

  /** Whether any thread this controller still tracks carries `contextValue`. */
  private _contextValueInUse(contextValue: string): boolean {
    for (const thread of this._threads.values()) {
      for (const comment of thread.comments) {
        if (comment.contextValue === contextValue) {
          return true;
        }
      }
    }
    return false;
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

    // An explicit line number (line-number context menu) always wins: the
    // user right-clicked that line, and a stale non-empty selection elsewhere
    // must not redirect the anchor. The selection is only consulted when no
    // line number was passed (editor text-area context menu / command
    // palette); a non-empty selection then comments on the whole line range
    // (Forgejo anchors at the first line and `extra_lines_count` extends the
    // range forward).
    let line = lineNumber ?? editor.selection.active.line;
    let extraLinesCount = 0;
    if (lineNumber === undefined && !editor.selection.isEmpty) {
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
      // The command comes from an editor context menu, so returning silently
      // looks like the click did nothing at all: name the failure (offline, an
      // expired token, a deleted PR) instead of leaving the user guessing why no
      // comment editor appeared.
      void vscode.window.showErrorMessage(vscode.l10n.t('Could not load the pull request diff: {0}', err));
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

    // A pending review is found through this list, so it must never be dropped
    // for a failed comments fetch: without it Forgejo starts a *second* review
    // ("Review started…") instead of adding to the existing one.
    // `incomplete` only says its comments could not be listed, which is exactly
    // why the editor is told what to expect: the comment still attaches to the
    // pending review following Forgejo's one-pending-review-per-user rule, so
    // the editor must not claim the server will create a new one.
    const pendingEntry = data.reviews.find(
      (r) => r.review.state === 'PENDING' && r.review.user?.login === instance.username,
    );
    const pendingReviewId = typeof pendingEntry?.review.id === 'number' ? pendingEntry.review.id : undefined;
    if (pendingEntry?.incomplete && pendingReviewId !== undefined) {
      void vscode.window.showWarningMessage(
        vscode.l10n.t('Adding to pending review #{0}; its existing comments could not be loaded', pendingReviewId),
      );
    }

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
