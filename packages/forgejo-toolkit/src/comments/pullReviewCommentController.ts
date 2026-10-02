import * as vscode from 'vscode';
import { ForgejoClient } from '../api/client';
import { ConfigManager } from '../config';
import { FORGEJO_PR_SCHEME, parseForgejoPrUri, type ForgejoPrUriParams } from '../prFileSystemProvider';
import { parsePullDiff, type ParsedPullDiff } from '../utils/parseDiff';
import { resolveReviewCommentLine, type ReviewCommentSide } from './reviewCommentPosition';
import {
  pullReviewThreadKey,
  pullReviewThreadMatchesScope,
  type PullReviewThreadAnchor,
  type PullReviewThreadScope,
} from './pullReviewThreadKeys';
import {
  decodePullReviewReplyTarget,
  encodePullReviewReplyTarget,
  type PullReviewReplyTarget,
} from './pullReviewReplyTarget';
import { buildReviewReplyBody } from './reviewReply';
import {
  ECHOED_REPLY_CONTEXT_VALUE_PREFIX,
  EchoedReplyStore,
  isEchoedReply,
  type EchoedReply,
} from './pullReviewReplyEcho';
import { deriveTimelineReplyEchoes, type TimelineCommentLike, type TimelineReplyEcho } from './timelineReplyEcho';
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

/**
 * What the reply command needs to know about one rendered comment: the plain
 * text Forgejo stores (the thread's `MarkdownString` body is a rendering of it,
 * with hard breaks and the instance's attachment URLs resolved, so it cannot be
 * quoted back) and the author's login for the attribution line.
 */
interface CommentQuoteSource {
  authorLogin: string;
  body: string;
}

/**
 * The argument VS Code hands to the reply command contributed through
 * `comments/commentThread/context`: the thread the box belongs to and the text
 * in it (`vscode.CommentReply`), reshaped here to the two fields this
 * controller reads — the signature is total over what the host actually sends,
 * including a marshalled value from a host build that could not revive it.
 */
interface PullReviewCommentReply {
  thread: vscode.CommentThread | undefined;
  text: string;
}

/**
 * One server comment resolved for a document, with everything the render needs.
 * The `extraLinesCount` a reply anchors with is read back from the server
 * comment, so the anchor posted to Forgejo names the same range the rendered
 * thread covers.
 */
interface RenderedComment {
  params: ForgejoPrUriParams;
  reviewId: number;
  comment: PullReviewComment;
  /** 1-based line in the side's file. */
  position: number;
  /** The document's thread range for the whole anchor group. */
  threadRange: vscode.Range;
  side: ReviewCommentSide;
  instanceName: string;
}

const CONTROLLER_ID = 'forgejo-pull-review-comments';
const CONTROLLER_LABEL = 'Forgejo Pull Request Reviews';
export const COMMAND_ADD_COMMENT = 'forgejoToolkit.addPullReviewComment';
export const COMMAND_DELETE_COMMENT = 'forgejoToolkit.deletePullReviewComment';
/** Registered by the controller; contributed through `comments/commentThread/context`. */
export const COMMAND_REPLY_COMMENT = 'forgejoToolkit.replyToPullReviewComment';

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

// The pull request's timeline is fetched to re-derive the replies it holds
// (`timelineReplyEcho.ts`). It is read once per render pass, not once per thread,
// and this TTL coalesces the pass with the renders that follow it (every open
// diff document of the pull request re-renders, and a mutation invalidates the
// review data, which re-renders again). Shorter than the review-data TTL on
// purpose: the timeline is what makes a reply appear, so it should be the first
// thing to be re-read.
const TIMELINE_COMMENTS_CACHE_TTL_MS = 10_000;
const TIMELINE_COMMENTS_MAX_ENTRIES = 4;
const TIMELINE_COMMENTS_MAX_BYTES = 8 * 1024 * 1024;

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
  /**
   * Plain text of every rendered comment, keyed by the same encoded context
   * value as `_commentContextMap`. Kept beside it (and dropped with it) because
   * only the reply needs it and it must stay unrendered: the thread's body is
   * `toHardBreakMarkdown` output with attachment URLs already rewritten.
   */
  private readonly _commentQuoteSources = new Map<string, CommentQuoteSource>();
  /**
   * The replies this session posted to the pull request's timeline, keyed by
   * thread key. A reply is never a review comment, so the review API will never
   * return it; this store covers the gap between a successful POST and the
   * timeline returning the row it created, after which the derived echo
   * (`_derivedEchoesFor`) takes over. See `pullReviewReplyEcho.ts`.
   */
  private readonly _echoedReplies = new EchoedReplyStore();
  /**
   * The pull request's timeline rows, keyed by pull request. Their quote replies
   * are what re-derive the echoes on every render — including after a window
   * reload, and including replies composed outside this extension. Cached only to
   * coalesce a render pass; see `_timelineComments`.
   */
  private readonly _timelineCommentsCache = createTimedCache<TimelineCommentLike[]>(TIMELINE_COMMENTS_CACHE_TTL_MS, {
    maxEntries: TIMELINE_COMMENTS_MAX_ENTRIES,
    maxBytes: TIMELINE_COMMENTS_MAX_BYTES,
    sizeOf: (value) => estimateValueBytes(value),
  });
  private readonly _timelineCommentsInFlight = new InFlightTasks();
  private readonly _disposables: vscode.Disposable[] = [];
  private readonly _reviewDataCache = createTimedCache<PullRequestReviewCache>(REVIEW_DATA_CACHE_TTL_MS, {
    maxEntries: REVIEW_DATA_MAX_ENTRIES,
    maxBytes: REVIEW_DATA_MAX_BYTES,
    // The maps dominate: every diff line is a Map entry, and each stores the
    // path/line keys plus their line-type strings.
    sizeOf: (value) => estimateValueBytes(value.diff) + estimateValueBytes(value.reviews),
  });
  private readonly _reviewDataInFlight = new InFlightTasks();
  /**
   * Fingerprint of the incomplete review-id set the load warning was last shown
   * for, keyed by the pull request it belongs to (`_reviewDataCacheKey`). Both
   * the user and the editor can trigger a re-fetch (a mutation invalidates the
   * review-data cache), so without this the same failure warns again every time
   * the cache is refilled.
   *
   * The key is part of the fingerprint because review ids are per-pull-request
   * sequences: bare ids made a failure in pull request A suppress the warning
   * for an unrelated pull request B whose failing review happened to share a
   * number. The entry is dropped when that pull request's data is complete
   * again, so a recovery followed by a fresh failure still warns.
   */
  private readonly _warnedIncompleteReviews = new Map<string, string>();
  /**
   * Fingerprint of the error the whole-load failure toast was last shown for,
   * keyed by the pull request it belongs to (`_reviewDataCacheKey`), mirroring
   * `_warnedIncompleteReviews` for the *partial* failure. A failed load is not
   * what `_reviewDataCache` holds (only successful loads are cached) and
   * `_reviewDataInFlight` only coalesces while the fetch runs, so every document
   * render of the pull request — one per open diff document, plus one per focus
   * change — re-fetches and, without this map, re-toasts the identical error.
   * A recovered load clears the entry, so a failure after a recovery warns again.
   */
  private readonly _warnedLoadFailures = new Map<string, string>();
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
    // No `options` override: a reply is an ordinary public comment on the pull
    // request (see `replyToComment`), which is exactly what VS Code's own
    // "Reply…" wording and submit button describe. The override that used to be
    // here existed only because the reply was appended to the user's pending
    // review, where the stock wording would have promised a public submission
    // the extension was not making.
    this._disposables.push(
      this._controller,
      this._rangeDecoration,
      vscode.commands.registerCommand(COMMAND_REPLY_COMMENT, (reply: PullReviewCommentReply | undefined) =>
        this.replyToComment(reply).catch((error: unknown) => {
          const err = userFacingErrorMessage(error);
          this._logger?.error(`Failed to reply to a pull review comment: ${err}`);
          void vscode.window.showErrorMessage(vscode.l10n.t('Could not post the reply: {0}', err));
        }),
      ),
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
        // visible-editors event, focus changes restore them. Forced, because
        // this path exists precisely to repaint what the apply-skip otherwise
        // trusts to be intact.
        this._applyThreadRangeDecorations(true);
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
      //
      // Only documents this controller decorates may trigger the re-apply.
      // `onDidChangeTextEditorVisibleRanges` also fires for documents that
      // can never carry a thread — the output channel and the comment-input
      // documents — and the re-apply itself writes to the output channel, so
      // without this filter the debug line below changed the output editor's
      // visible ranges and re-triggered the very sync that had written it: a
      // self-sustaining loop that burned CPU and spammed the channel.
      vscode.window.onDidChangeTextEditorVisibleRanges((event) =>
        this._scheduleThreadRangeDecorationSync(event?.textEditor?.document),
      ),
    );
    this._updateActiveEditorContext(vscode.window.activeTextEditor);
  }

  private _threadRangeDecorationSyncTimer: ReturnType<typeof setTimeout> | undefined;

  /**
   * Exact detail string of the last "Thread range decorations applied per
   * visible editor" line written to the output channel. The diagnostic may only
   * be written when it changes: writing it alters the output editor's visible
   * ranges, and the re-apply that follows produces the identical string, so an
   * unconditional write was a self-sustaining output/CPU loop (see the
   * visible-ranges listener).
   */
  private _lastRangeDecorationDetail: string | undefined;

  /**
   * Range signature `setDecorations` was last called with, per editor, so a
   * re-apply whose computed range sets are unchanged does not repaint. Keyed by
   * the editor (not its document URI) on purpose: a document can be shown in a
   * new editor instance whose decorations are not the previous instance's, so
   * identity is what makes the skip safe. A `WeakMap` releases the entry with
   * the editor.
   */
  private readonly _appliedRangeDecorations = new WeakMap<vscode.TextEditor, string>();

  /** Signature of a range set, stable across re-computation of the same ranges. */
  private _rangeSetSignature(ranges: readonly vscode.Range[]): string {
    return ranges
      .map((range) => `${range.start.line}:${range.start.character}-${range.end.line}:${range.end.character}`)
      .sort()
      .join('|');
  }

  /**
   * Whether a visible-range change on `document` can affect these decorations.
   * Only documents that carry a thread this controller tracks are decorated
   * (see `_applyThreadRangeDecorations`); everything else — the output channel,
   * the comment-input documents, ordinary files — must not schedule the sync,
   * both because the work would be a no-op and because the sync can write to
   * the output channel, which would then re-trigger itself.
   */
  private _shouldSyncDecorationsForDocument(document: vscode.TextDocument | undefined): boolean {
    if (!document) {
      // No document on the event (a different VS Code version, or a caller
      // that passed nothing): keep the old, unconditional behaviour rather
      // than silently dropping the collapse/expand re-apply.
      return true;
    }
    const uriKey = document.uri.toString();
    for (const thread of this._threads.values()) {
      if (thread.uri.toString() === uriKey) {
        return true;
      }
    }
    return false;
  }

  private _scheduleThreadRangeDecorationSync(document?: vscode.TextDocument): void {
    if (!this._shouldSyncDecorationsForDocument(document)) {
      return;
    }
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
      // Forced: a sweep removes the ranges of the dropped threads, and the
      // range set of an editor whose supplement was already absent is
      // unchanged, so the skip would leave nothing to re-report either.
      this._applyThreadRangeDecorations(true);
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
    this._commentQuoteSources.clear();
    this._echoedReplies.clear();
    this._warnedIncompleteReviews.clear();
    this._warnedLoadFailures.clear();
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

  private _reviewDataCacheKey(params: { instanceId: string; owner: string; repo: string; index: number }): string {
    return `${params.instanceId}:${params.owner}/${params.repo}#${params.index}`;
  }

  private _loadReviewData(params: {
    instanceId: string;
    owner: string;
    repo: string;
    index: number;
  }): Promise<{ data: PullRequestReviewCache; fetched: boolean }> {
    const key = this._reviewDataCacheKey(params);
    const cached = this._reviewDataCache.get(key);
    if (cached) {
      return Promise.resolve({ data: cached, fetched: false });
    }
    // Coalesce concurrent loads of the same pull request (one per open
    // document when a multi-file diff opens) into a single fetch.
    return this._reviewDataInFlight.run(key, async () => {
      const data = await this._fetchReviewData(params);
      this._reviewDataCache.set(key, data);
      return { data, fetched: true };
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
      // Localized like the "Forgejo instance not found" messages the rest of the
      // extension shows: this one is surfaced in the load-failure toast below.
      throw new Error(vscode.l10n.t('Forgejo instance not found: {0}', params.instanceId));
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

  /**
   * The pull request's timeline rows, fetched with the client's own timeline
   * method (no raw request), paged by it to the shared list cap — the same read
   * the PR detail page makes.
   *
   * Called only from a render that has at least one thread to attach an echo to,
   * so a pull request without review comments on the opened file costs no extra
   * request, and called once per render pass rather than once per thread.
   * Concurrent callers share the in-flight fetch, and the short TTL coalesces the
   * documents of one pass.
   *
   * A failure is logged and answered with an empty timeline: the threads are the
   * point of the render and must still appear, and a reply's echo simply falls
   * back to the local store. Note that the client's timeline method also asks for
   * each attachment-carrying comment's asset list — the price of reusing the
   * existing call instead of adding a second, leaner endpoint call.
   */
  private _timelineComments(params: {
    instanceId: string;
    owner: string;
    repo: string;
    index: number;
  }): Promise<TimelineCommentLike[]> {
    const key = this._reviewDataCacheKey(params);
    const cached = this._timelineCommentsCache.get(key);
    if (cached) {
      return Promise.resolve(cached);
    }
    return this._timelineCommentsInFlight.run(key, async () => {
      const instance = this._findInstance(params.instanceId);
      if (!instance) {
        return [];
      }
      try {
        const client = new ForgejoClient(instance.url, instance.token, this._logger, instance.syncApiUrlsToInstanceUrl);
        const comments = await client.getPullRequestCommentsAndTimeline(params.owner, params.repo, params.index);
        this._timelineCommentsCache.set(key, comments);
        return comments;
      } catch (error) {
        const err = userFacingErrorMessage(error);
        this._logger?.error(
          `Failed to load the pull request timeline for ${params.owner}/${params.repo}#${params.index}: ${err}`,
        );
        // Deliberately not cached: the next render retries, so a transient
        // failure does not cost the user their echoes for the whole TTL.
        return [];
      }
    });
  }

  /**
   * Comment id → thread key for every review comment this render attached, so a
   * timeline row can be matched to the thread it answers.
   *
   * Built from the same key the render uses (`pullReviewThreadKey`), which is why
   * a reply to any anchor — including one of two anchors on different lines of
   * the same file — lands in exactly the thread that carries the comment it
   * quotes. Echoes are not in here: the map's keys are ids of server review
   * comments, and an echo has no server comment behind it.
   */
  private _threadKeyByCommentId(
    anchors: ReadonlyMap<string, { comments: readonly RenderedComment[] }>,
  ): Map<number, string> {
    const byCommentId = new Map<number, string>();
    for (const [key, group] of anchors) {
      for (const entry of group.comments) {
        if (typeof entry.comment.id === 'number') {
          byCommentId.set(entry.comment.id, key);
        }
      }
    }
    return byCommentId;
  }

  /**
   * The local echoes that are still worth showing beside this thread's derived
   * echoes — the exact dedupe rule.
   *
   * The same timeline comment renders exactly once, even though two records of it
   * can exist at the same moment (the one the POST just created locally, and the
   * one the server's timeline returns):
   *
   * - A local echo whose `timelineCommentId` matches a derived echo's is the very
   *   same timeline comment, so it is dropped; the derived record wins.
   * - A local echo with no id — the POST response did not carry one — cannot be
   *   matched, so it is dropped as soon as *any* derived echo exists in that
   *   thread: a derived echo proves the timeline read is answering for this
   *   thread, and the local record is then at best a duplicate of a reply that
   *   read already contains. Until then it is the only trace of the just-posted
   *   reply, and it stays.
   *
   * Matching is on the timeline comment's id and nothing else: body, author and
   * timestamp are all things the user can edit on the server afterwards, and a
   * dedupe that compared them would start rendering one reply as two.
   */
  private _localEchoesToApply(threadKey: string, derivedEchoes: readonly TimelineReplyEcho[]): EchoedReply[] {
    const local = this._echoedReplies.get(threadKey);
    if (local.length === 0) {
      return [];
    }
    const derivedIds = new Set(derivedEchoes.map((echo) => echo.timelineCommentId));
    return local.filter((echo) => {
      if (echo.timelineCommentId !== undefined) {
        return !derivedIds.has(echo.timelineCommentId);
      }
      return derivedEchoes.length === 0;
    });
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
    const params = parseForgejoPrUri(document.uri);
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
    const cacheKey = this._reviewDataCacheKey(params);
    try {
      const { data, fetched } = await this._loadReviewData(params);
      // A successful load means a previously reported whole-load failure is
      // over; clear its memory so a failure after this recovery toasts again.
      this._warnedLoadFailures.delete(cacheKey);
      // A review whose comments failed to load is kept in `data.reviews` (so a
      // pending review stays visible, see _fetchReviewData) but its threads are
      // necessarily missing. Say so: otherwise the diff looks like a complete
      // picture of the discussion.
      //
      // Only when the data was actually fetched. `_loadAndRender` re-runs for
      // every `onDidChangeActiveTextEditor` (opening the other side of a diff,
      // focusing any document), and the 15 s cache answers then — before this
      // guard, one transient per-review failure re-toasted the warning once per
      // document opened and on every focus change. The id set is remembered per
      // pull request too, so a later re-fetch that fails on the same reviews
      // stays silent while a different set — or a different pull request whose
      // failing review shares a numeric id — still warns.
      if (fetched) {
        if (data.incompleteReviewIds.length > 0) {
          const fingerprint = data.incompleteReviewIds.slice().sort().join(',');
          if (fingerprint !== this._warnedIncompleteReviews.get(cacheKey)) {
            this._warnedIncompleteReviews.set(cacheKey, fingerprint);
            vscode.window.showWarningMessage(
              vscode.l10n.t(
                'Some reviews could not be loaded, so their comments may be missing: {0}',
                data.incompleteReviewIds.join(', '),
              ),
            );
          }
        } else {
          // Complete data clears the memory, so a failure on the same reviews
          // after a recovery is not mistaken for the failure already reported.
          this._warnedIncompleteReviews.delete(cacheKey);
        }
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
      // threads and nothing else. Say that the load failed — but only once per
      // distinct failure per pull request, not per document render: a failed
      // load is never cached (see _loadReviewData) and `_reviewDataInFlight`
      // only coalesces while a fetch runs, so without the fingerprint check
      // every open diff document of the pull request — and every focus change,
      // which re-renders — re-fetched and re-toasted the identical error.
      if (this._warnedLoadFailures.get(cacheKey) !== err) {
        this._warnedLoadFailures.set(cacheKey, err);
        void vscode.window.showErrorMessage(
          vscode.l10n.t('Could not load the review comments for this file: {0}', err),
        );
      }
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
    // Comments of this document, grouped by the anchor they name: one thread per
    // anchor is what makes a reply legible. A reply is an ordinary comment at
    // the anchor it answers, so without the grouping it would show up as a
    // second thread on the same line instead of joining the conversation it
    // continues — which is how Forgejo's own web UI shows an anchor's comments.
    const anchors = new Map<string, { anchor: PullReviewThreadAnchor; comments: RenderedComment[] }>();
    /** Anchor keys in the order the server listed them, so threads keep that order. */
    const anchorOrder: string[] = [];
    // One lookup for the whole render: every rendered comment's author falls
    // back to the instance name.
    const instanceName = this._findInstance(params.instanceId)?.name ?? params.instanceId;
    // The replies the pull request's timeline holds, by thread key, derived once
    // for this whole pass (see _derivedEchoesFor). Fetched lazily: a pass with no
    // thread to attach to never asks for the timeline.
    let derivedEchoesByThread: Map<string, TimelineReplyEcho[]> | undefined;

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

        // Multi-line comments anchor at the first line and extend
        // `extraLines` lines forward; clamp to the document end for outdated
        // ranges whose tail lines no longer exist in this revision. The range
        // must end at the last line's end character: ending at column 0 would
        // leave the final line unhighlighted.
        const endLine = Math.min(resolved.line + resolved.extraLines, document.lineCount - 1);
        const endCharacter = document.lineAt(endLine).text.length;
        const anchor: PullReviewThreadAnchor = { line: resolved.line, extraLines: endLine - resolved.line };
        const key = pullReviewThreadKey(scope, anchor);
        let group = anchors.get(key);
        if (!group) {
          group = { anchor, comments: [] };
          anchors.set(key, group);
          anchorOrder.push(key);
        }
        group.comments.push({
          params,
          reviewId,
          comment,
          position: resolved.line + 1,
          instanceName,
          threadRange: new vscode.Range(anchor.line, 0, endLine, endCharacter),
          side: resolved.side,
        });
      }
    }

    for (const key of anchorOrder) {
      if (documentClosed) {
        break;
      }
      const group = anchors.get(key);
      if (!group || group.comments.length === 0) {
        continue;
      }
      const first = group.comments[0];
      const rendered = await this._createGroupComments(group.comments);
      // _createGroupComments awaits attachment resolution, and the document may
      // close while it is in flight: `_onCloseDocument` then already disposed an
      // existing thread and removed it from `_threads`, so writing into it would
      // mutate a dead thread, and the freshly registered comment contexts would
      // be orphaned. Drop the orphans and stop rendering a document that is
      // gone — a thread created for a closed document lingers in the Comments
      // panel forever, because no further close event arrives for it.
      if (document.isClosed) {
        this._dropOrphanedCommentContexts(rendered);
        documentClosed = true;
        break;
      }
      if (rendered.length === 0) {
        continue;
      }
      // The replies the timeline holds for this thread — this extension's and
      // anyone else's — go after every server comment: they were posted later,
      // and the server's review comment list will never carry them. They are
      // re-derived here on every render rather than carried over from the
      // previous one, so a rebuild (and a window reload) can neither lose an echo
      // nor duplicate one — the local store's entry for a reply the timeline
      // already returned is dropped in the derived record's favour.
      if (derivedEchoesByThread === undefined) {
        derivedEchoesByThread = await this._derivedEchoesFor(params, anchors);
      }
      const derivedEchoes = derivedEchoesByThread.get(key) ?? [];
      const comments = [
        ...rendered,
        ...this._localEchoesToApply(key, derivedEchoes).map((echo) => this._createEchoedComment(echo)),
        ...this._derivedEchoComments(derivedEchoes),
      ];
      // The new comments are built before the old thread is touched: they carry
      // the same encoded context values as the comments being replaced, so
      // dropping the old contexts first would delete the entry the re-created
      // comment's Delete command needs.
      const existing = this._threads.get(key);
      if (existing && !this._threadsIsLive(existing)) {
        // Disposed while the comments were built (a sweep, or the close of a
        // document that re-opened). Writing into it would resurrect a dead
        // thread; the freshly registered contexts are dropped with it.
        this._dropOrphanedCommentContexts(rendered);
        continue;
      }
      if (existing) {
        existing.range = first.threadRange;
        existing.comments = comments;
        // Re-asserted on every render: a comment added to the thread by the
        // user must not turn the reply box (and its Delete actions) off.
        existing.canReply = true;
        existing.contextValue = this._replyTargetValue(first, group.anchor);
        this._dropReplacedCommentContexts(existing, comments);
      } else {
        // A thread created for a closed document lingers in the Comments panel
        // forever, because no further close event arrives for it.
        const thread = this._controller.createCommentThread(
          this._buildUri({ ...params, isBase: first.side === 'base' }),
          first.threadRange,
          comments,
        );
        // The reply box exists exactly when the thread allows replies, and every
        // review comment can be answered: the reply is posted as an ordinary
        // comment on the pull request (`replyToComment`) and echoed back into
        // this thread, never written into the user's pending review.
        thread.canReply = true;
        thread.collapsibleState = vscode.CommentThreadCollapsibleState.Expanded;
        thread.contextValue = this._replyTargetValue(first, group.anchor);
        this._threads.set(key, thread);
      }
      // Only a thread this render actually attached is kept: a comment the
      // loop stopped before (the document closed) must not protect its stale
      // thread from the prune below.
      threadsToKeep.add(key);
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
  //
  // `force` repaints even an unchanged range set, for the few callers that
  // must not trust the last painted state: the focus-change safety net and the
  // invisible-thread sweep. The high-frequency callers (the debounced
  // visible-ranges sync and the visible-editors event) leave it off, so a
  // repeated computation that produces the same ranges does not call
  // `setDecorations` at all.
  private _applyThreadRangeDecorations(force = false): void {
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
      const ranges = byLine ? [...byLine.values()] : [];
      // Repainting identical data is what makes a visible-ranges event
      // expensive for no visible change; only call setDecorations when this
      // editor's range set actually differs from what it was last given.
      const signature = this._rangeSetSignature(ranges);
      if (force || this._appliedRangeDecorations.get(editor) !== signature) {
        this._appliedRangeDecorations.set(editor, signature);
        editor.setDecorations(this._rangeDecoration, ranges);
      }
    }
    // Diagnostics for "multi-line range highlight misses lines" reports: if a
    // user reproduces it with `forgejoToolkit.debug` enabled, this shows
    // whether the decoration reached the affected editor (count per editor
    // URI) or never matched it (0 / editor absent from the list). Written only
    // when the detail changes: the line itself alters the output editor's
    // visible ranges, so a repeated identical write would re-trigger the sync
    // that wrote it (see the visible-ranges listener).
    if (lastLineByUri.size > 0) {
      const detail = vscode.window.visibleTextEditors
        .map(
          (editor) =>
            `${editor.document.uri.toString()}=${lastLineByUri.get(editor.document.uri.toString())?.size ?? 0}`,
        )
        .join(', ');
      if (detail !== this._lastRangeDecorationDetail) {
        this._lastRangeDecorationDetail = detail;
        this._logger?.debug(`Thread range decorations applied per visible editor: ${detail}`);
      }
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
      this._dropCommentContextValue(comment.contextValue);
    }
  }

  /**
   * Drop the contexts of the comments a re-render replaced, now that the
   * replacement comments are attached. Calling this before the assignment in
   * `_renderThreads` would delete the entry a re-created comment reuses.
   */
  private _dropReplacedCommentContexts(thread: vscode.CommentThread, rendered: readonly vscode.Comment[]): void {
    const kept = new Set(rendered.map((comment) => comment.contextValue));
    for (const comment of thread.comments) {
      if (!comment.contextValue || kept.has(comment.contextValue)) {
        continue;
      }
      this._dropCommentContextValue(comment.contextValue);
    }
  }

  private _dropCommentContextValue(contextValue: string | undefined): void {
    if (contextValue && !this._contextValueInUse(contextValue)) {
      this._commentContextMap.delete(contextValue);
      this._commentQuoteSources.delete(contextValue);
    }
  }

  // _createComment registers its context before the caller has attached the
  // comment to a thread. When the caller then abandons the comment (the
  // document closed while the registration was awaited), no tracked thread
  // ever carries it, so _dropCommentContexts never reaches it and the entry
  // would sit in the map forever. Delete it — unless a live thread happens to
  // carry the same encoded value (a concurrent render of the same comment),
  // whose Delete command still needs the entry.
  private _dropOrphanedCommentContext(comment: vscode.Comment): void {
    this._dropCommentContextValue(comment.contextValue);
  }

  private _dropOrphanedCommentContexts(comments: readonly vscode.Comment[]): void {
    for (const comment of comments) {
      this._dropOrphanedCommentContext(comment);
    }
  }

  /**
   * Whether the thread is still one this controller tracks. The render chain
   * awaits attachment resolution, and a thread disposed during that await —
   * by the document closing and re-opening, or by the invisible-thread sweep —
   * must not be written into: its widget is gone, so the update would resurrect
   * nothing while its comments' contexts leak.
   */
  private _threadsIsLive(thread: vscode.CommentThread): boolean {
    for (const tracked of this._threads.values()) {
      if (tracked === thread) {
        return true;
      }
    }
    return false;
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

  /** The `contextValue` a thread carries so the reply command can find its anchor. */
  private _replyTargetValue(rendered: RenderedComment, anchor: PullReviewThreadAnchor): string {
    return encodePullReviewReplyTarget({
      instanceId: rendered.params.instanceId,
      owner: rendered.params.owner,
      repo: rendered.params.repo,
      index: rendered.params.index,
      path: rendered.params.path,
      position: anchor.line + 1,
      extraLinesCount: anchor.extraLines,
      isBase: rendered.side === 'base',
    });
  }

  /**
   * The thread key an echoed reply has to be remembered under, rebuilt from the
   * thread itself.
   *
   * The reply target a thread carries names the anchor (path, line, range and
   * side) but not the revision, and `pullReviewThreadKey` uses the revision —
   * so the key is recomputed from the thread's own document URI (which carries
   * the ref) plus the anchor the target encodes. That is the same key
   * `_renderThreads` builds, by construction: same scope, same anchor.
   */
  private _threadKeyForThread(thread: vscode.CommentThread, target: PullReviewReplyTarget): string | undefined {
    const params = parseForgejoPrUri(thread.uri);
    if (!params) {
      return undefined;
    }
    return pullReviewThreadKey(this._threadScope(params), {
      line: target.position - 1,
      extraLines: target.extraLinesCount,
    });
  }

  /**
   * The timeline's replies to the comments this render attached, grouped by thread
   * key — the server-side source of the echoes, so they survive a window reload
   * and cover replies composed elsewhere (the web UI, a phone).
   *
   * Called once per render pass, lazily: it returns immediately when no thread has
   * a server comment to attach to, which is what keeps a pull request without
   * review comments from costing an extra request. One timeline read serves every
   * thread of the pass — the matching happens locally, against the comment ids
   * this render collected. A failed or empty timeline yields no derived echoes
   * and the threads still render; the local store then carries the just-posted
   * reply, and `_timelineComments` logs the failure.
   */
  private async _derivedEchoesFor(
    params: ForgejoPrUriParams,
    anchors: ReadonlyMap<string, { anchor: PullReviewThreadAnchor; comments: readonly RenderedComment[] }>,
  ): Promise<Map<string, TimelineReplyEcho[]>> {
    const byCommentId = this._threadKeyByCommentId(anchors);
    if (byCommentId.size === 0) {
      return new Map();
    }
    const timeline = await this._timelineComments(params);
    return deriveTimelineReplyEchoes(timeline, byCommentId);
  }

  /**
   * One echoed reply as a read-only thread comment.
   *
   * `CommentMode.Preview` and the `label` are what keep it from being mistaken
   * for review content: the note says where the text actually lives, and the
   * echo's `contextValue` deliberately does not carry the `forgejo:` prefix the
   * server comments use, so the comment context menu offers it no Delete (there
   * is nothing on the server it could delete). The body is the body as it stands
   * on the timeline, unchanged — no hard-break rewriting and no attachment
   * resolution, because a reply is not review content and its rendered form is
   * not what the confirmation note is about.
   */
  private _createEchoedComment(echo: EchoedReply): vscode.Comment {
    const body = new vscode.MarkdownString(echo.body);
    body.supportHtml = true;
    return {
      body,
      mode: vscode.CommentMode.Preview,
      author: { name: echo.author },
      timestamp: echo.postedAt,
      label: echo.label,
      contextValue: echo.contextValue,
    };
  }

  /**
   * The timeline comments of `derivedEchoes`, as echo comments rendered after the
   * thread's server comments.
   *
   * Derived and local echoes render identically (same marker, same read-only
   * mode), because which of the two supplied a given reply is an implementation
   * detail the reader must not have to care about. The `contextValue` carries the
   * timeline comment's own id, so two derived echoes can never share a marker and
   * one timeline comment can never be rendered twice.
   */
  private _derivedEchoComments(derivedEchoes: readonly TimelineReplyEcho[]): vscode.Comment[] {
    return derivedEchoes.map((derived) =>
      this._createEchoedComment({
        body: derived.body,
        author: derived.author,
        label: vscode.l10n.t('Posted to the pull request timeline'),
        postedAt: derived.postedAt,
        contextValue: `${ECHOED_REPLY_CONTEXT_VALUE_PREFIX}${derived.timelineCommentId}`,
        timelineCommentId: derived.timelineCommentId,
      }),
    );
  }

  /** Every comment of one anchor, in the order the server listed them. */
  private async _createGroupComments(rendered: readonly RenderedComment[]): Promise<vscode.Comment[]> {
    const comments: vscode.Comment[] = [];
    for (const entry of rendered) {
      comments.push(
        await this._createComment(entry.params, entry.reviewId, entry.comment, entry.position, entry.instanceName),
      );
    }
    return comments;
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
    const rawBody = comment.body ?? '';
    let bodyText = rawBody;
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
    // The rendered body is not the comment's text (hard breaks, rewritten
    // attachment URLs), so keep the plain text for the reply's quote.
    this._commentQuoteSources.set(contextValue, { authorLogin: authorName, body: rawBody });

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
    const params = parseForgejoPrUri(editor.document.uri);
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

    const loaded = await this._loadReviewData(params).catch((error: unknown) => {
      const err = userFacingErrorMessage(error);
      this._logger?.error(`Failed to load pull request diff for commenting: ${err}`);
      // The command comes from an editor context menu, so returning silently
      // looks like the click did nothing at all: name the failure (offline, an
      // expired token, a deleted PR) instead of leaving the user guessing why no
      // comment editor appeared.
      void vscode.window.showErrorMessage(vscode.l10n.t('Could not load the pull request diff: {0}', err));
      return undefined;
    });
    if (!loaded) {
      return;
    }
    const { data } = loaded;

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
    if (!sideLines.get(line)) {
      vscode.window.showErrorMessage(vscode.l10n.t('Comments can only be added to lines within the pull request diff'));
      return;
    }
    const endLine = line + extraLinesCount;
    if (extraLinesCount > 0 && !sideLines.get(endLine)) {
      // The anchor is commentable and only the range runs past the diff (a
      // selection that ends below the last line of the hunk). The blanket
      // refusal above reads as "your first line was wrong" while the caret sat
      // on a changed line, so name the line that is actually out of range —
      // 1-based, as the editor shows it. The range is still refused: nothing is
      // guessed into the comment.
      vscode.window.showErrorMessage(
        vscode.l10n.t('The selection reaches line {0}, which is outside the pull request diff', endLine + 1),
      );
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

  /**
   * The pending review of this pull request, or `undefined` when the user has
   * none. Used by the AI pre-review, which must reuse the one draft Forgejo
   * allows per user and pull request instead of starting a second one.
   *
   * The predicate is `addComment`'s own (`state === 'PENDING' && user.login ===
   * instance.username`), deliberately in one place: a second, differently
   * written lookup could disagree with the interactive path about which review
   * "continue reviewing" means.
   */
  async findPendingReview(params: {
    instanceId: string;
    owner: string;
    repo: string;
    index: number;
  }): Promise<number | undefined> {
    const instance = this._findInstance(params.instanceId);
    if (!instance) {
      return undefined;
    }
    const { data } = await this._loadReviewData(params);
    const pendingEntry = data.reviews.find(
      (r) => r.review.state === 'PENDING' && r.review.user?.login === instance.username,
    );
    return typeof pendingEntry?.review.id === 'number' ? pendingEntry.review.id : undefined;
  }

  /**
   * Reloads the pull request's review threads so a comment created outside the
   * panel (the AI pre-review writes drafts directly through the client) appears
   * without waiting for the review-data cache to expire.
   */
  async refreshPullRequestComments(params: {
    instanceId: string;
    owner: string;
    repo: string;
    index: number;
  }): Promise<void> {
    await this._refreshOpenPrDocuments(params);
  }

  private async _refreshOpenPrDocuments(params: {
    instanceId: string;
    owner: string;
    repo: string;
    index: number;
  }): Promise<void> {
    // Every caller gets here after a mutation (submit/delete), so drop the
    // cached data first to make the new state visible immediately. That includes
    // the timeline: it is what carries a reply, and a reply is a mutation of its
    // own, so a refresh must re-read it rather than answer from the burst cache.
    this._reviewDataCache.delete(this._reviewDataCacheKey(params));
    this._timelineCommentsCache.delete(this._reviewDataCacheKey(params));
    let data: PullRequestReviewCache;
    try {
      ({ data } = await this._loadReviewData(params));
    } catch (error) {
      const err = userFacingErrorMessage(error);
      this._logger?.error(
        `Failed to reload pull request reviews for ${params.owner}/${params.repo}#${params.index}: ${err}`,
      );
      // The mutation itself already succeeded and was reported as such; without
      // a visible notice here the diff threads simply stay stale and the user
      // would never know the refresh failed. Warn instead of throwing: the
      // failure must not rewrite the caller's success path.
      void vscode.window.showWarningMessage(
        vscode.l10n.t('The change was applied, but refreshing the review threads failed: {0}', err),
      );
      return;
    }
    // Load once, then re-render every open document of the pull request with
    // the same data (previously each document triggered its own full load).
    const renders: Promise<void>[] = [];
    for (const document of vscode.workspace.textDocuments) {
      const docParams = parseForgejoPrUri(document.uri);
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

  /**
   * Posts the reply the user submitted in a thread's reply box.
   *
   * A reply is a comment on a comment — conversation, not review content — so it
   * is posted as an ordinary pull request timeline comment through
   * `createIssueComment` (the issue-comment endpoint) and never into the user's
   * pending review. That is what makes it visible in the pull request timeline
   * immediately and keeps the pending review for what the draft-only design
   * promises: the AI pre-review's drafts, which stay invisible until the user
   * submits the review. Forgejo's own web UI writes its replies through the
   * review-comments endpoint with `origin=timeline` and `reply=<review id>`
   * instead; that `reply` names the **review** the comment joins, not the comment
   * being answered (`routers/web/repo/pull_review.go` reads it with
   * `GetReviewByID`), and this endpoint notifies nothing, so a comment written
   * through it creates no activity row. Both land in the timeline, and the
   * linkage is recorded in `docs/design/pr-comment-replies.md` as a possible
   * future refinement, not something this path does today.
   *
   * Forgejo has no reply object, so the body carries a quote of the comment being
   * answered (`reviewReply.ts`): the platform's own attribution line
   * (`@author wrote in <comment URL>:`) and line-by-line `> ` quoting, written
   * with the reply text **first** and the quote last. The reason is the activity
   * excerpt: `abbreviatedComment` (`services/feed/action.go`) cuts the comment
   * body at its **first line** — split on a bare `\n`, at most 200 bytes — when
   * the activity row is written, and the feed renders that excerpt instead of the
   * comment. A quote-first body therefore reads there as the quote (the platform's
   * own replies read as their attribution), while reply-first reads as the user's
   * own words. The builder also drops leading blank lines, so that first line is
   * never empty. The order is our only lever and costs nothing server-side: the
   * platform's own order is a client-side convention
   * (`web_src/js/features/repo-legacy.js`) that means nothing to the server. The
   * reason and the measured evidence are in `docs/design/pr-comment-replies.md`.
   *
   * Only the user's own submission reaches here, and nothing is sent before the
   * anchor has been revalidated against the diff's own line tables and the
   * comment being quoted has been read back from the thread it came from, so a
   * thread whose anchor left the diff, or which no longer carries the comment it
   * came from, is refused instead of guessed at. A failure leaves no comment
   * behind and is reported — the input must not look posted.
   *
   * A **success** additionally echoes the reply into the thread it was answered
   * in, marked as a timeline comment (`pullReviewReplyEcho.ts`): the thread
   * renders review comments, so without the echo the user would see nothing
   * happen where they took the action. That local echo is a bridge only — the
   * thread's echoes are re-derived from the pull request's timeline on every
   * render (`_derivedEchoesFor`), so a reloaded window still shows the reply.
   */
  async replyToComment(reply: PullReviewCommentReply | undefined): Promise<void> {
    if (!reply || typeof reply.text !== 'string' || !reply.text.trim()) {
      // VS Code passes whatever is in the input; an empty submission is not an
      // error worth a toast, and there is nothing to post.
      return;
    }
    const thread = reply.thread;
    const target = decodePullReviewReplyTarget(thread?.contextValue);
    if (!thread || !target) {
      // Not a thread this controller owns (another extension's comment
      // controller, or a stale thread from an older build).
      return;
    }

    const instance = this._findInstance(target.instanceId);
    if (!instance) {
      void vscode.window.showErrorMessage(vscode.l10n.t('Forgejo instance not found'));
      return;
    }

    const params = {
      instanceId: target.instanceId,
      owner: target.owner,
      repo: target.repo,
      index: target.index,
    };

    // The load is for the diff the anchor is validated against; neither the
    // pending review nor the signed-in user name matters to a timeline comment.
    let data: PullRequestReviewCache;
    try {
      ({ data } = await this._loadReviewData(params));
    } catch (error) {
      const err = userFacingErrorMessage(error);
      this._logger?.error(
        `Could not load the pull request before replying to a review comment on ${target.owner}/${target.repo}#${target.index}: ${err}`,
      );
      void vscode.window.showErrorMessage(vscode.l10n.t('Could not load the pull request for this reply: {0}', err));
      return;
    }

    // The anchor is revalidated against the diff's line tables before anything
    // is sent: a line that left the diff (a force-push, or a file that no
    // longer appears) must be refused, never relocated.
    const fileMap = data.diff.files.get(target.path);
    if (!fileMap) {
      void vscode.window.showErrorMessage(vscode.l10n.t('Unable to locate the file in the pull request diff'));
      return;
    }
    const sideLines = target.isBase ? fileMap.baseLines : fileMap.headLines;
    if (
      !sideLines.get(target.position) ||
      (target.extraLinesCount > 0 && !sideLines.get(target.position + target.extraLinesCount))
    ) {
      void vscode.window.showErrorMessage(
        vscode.l10n.t('This comment is no longer on a line within the pull request diff, so the reply was not posted'),
      );
      return;
    }

    // The comment being answered: the last **server** comment rendered in the
    // thread. Its context names it and its stored plain text is what gets
    // quoted. Echoed replies are skipped on purpose: they carry no context and
    // quoting one back would both quote our own local copy and hide which
    // server comment the reply actually answers.
    const answered = [...thread.comments]
      .reverse()
      .find((comment) => comment.contextValue !== undefined && !isEchoedReply(comment));
    const context = answered?.contextValue ? this.getCommentContext(answered.contextValue) : undefined;
    const quoteSource = answered?.contextValue ? this._commentQuoteSources.get(answered.contextValue) : undefined;
    if (!answered?.contextValue || !context || !quoteSource) {
      // The thread is being replaced by a re-render (or was dropped), so the
      // reply cannot be attributed. Say so instead of posting something the
      // user did not aim at.
      void vscode.window.showErrorMessage(
        vscode.l10n.t('This comment thread is no longer available, so the reply was not posted'),
      );
      return;
    }

    const body = buildReviewReplyBody(
      {
        author: quoteSource.authorLogin,
        url: this._commentUrl(instance.url, target.owner, target.repo, target.index, context.commentId),
        body: quoteSource.body,
      },
      reply.text,
    );

    let failure: string | undefined;
    let timelineCommentId: number | undefined;
    try {
      const client = new ForgejoClient(instance.url, instance.token, this._logger, instance.syncApiUrlsToInstanceUrl);
      // `POST /repos/{owner}/{repo}/issues/{index}/comments` — the endpoint
      // Forgejo serves for issues *and* pull requests (a pull request is an
      // issue), and the one the web UI's own plain comments use (its quote
      // replies use the review-comments endpoint, see the doc above). Nothing
      // here touches a review: no pending review is started or appended to, and
      // no review is ever submitted. The response is the created timeline
      // comment; its id is what lets the echo below be recognised as that exact
      // timeline comment once the timeline returns it (`_localEchoesToApply`).
      const created = await client.createIssueComment(target.owner, target.repo, target.index, body);
      timelineCommentId = created?.id;
    } catch (error) {
      failure = userFacingErrorMessage(error);
    }

    if (failure !== undefined) {
      this._logger?.error(
        `Failed to post a reply to pull review comment ${context.commentId} on ${target.owner}/${target.repo}#${target.index}: ${failure}`,
      );
      void vscode.window.showErrorMessage(vscode.l10n.t('Could not post the reply: {0}', failure));
      // Nothing was created, so the thread must not be re-rendered as if it
      // had been: reloading would drop the input the user is looking at.
      return;
    }

    // Echo the reply into the thread it was written in. The reply is a timeline
    // comment, so the review API will never return it: append the local copy now
    // so the post is visible immediately, and remember it under the thread's key
    // so a rebuild of that thread before the timeline catches up keeps it. The
    // echo is read-only and carries a note saying where the text lives, and it is
    // never registered as a server comment — nothing about it is sent, counted or
    // written back.
    //
    // This local copy is only a bridge: every render also re-derives the thread's
    // echoes from the pull request's timeline (`_derivedEchoesFor`), which is what
    // makes a reply survive a window reload and what shows replies composed
    // elsewhere. The two records are deduped by the timeline comment's id — the
    // id the POST just returned — so the reply renders once.
    const threadKey = this._threadKeyForThread(thread, target);
    if (threadKey !== undefined) {
      const echo = this._echoedReplies.add(threadKey, {
        body,
        author: instance.username || instance.name,
        label: vscode.l10n.t('Posted to the pull request timeline'),
        postedAt: new Date(),
        timelineCommentId,
      });
      thread.comments = [...thread.comments, this._createEchoedComment(echo)];
    }

    // Say where it went as well: it is on the pull request's timeline now,
    // visible to everyone without any review being submitted. No refresh of the
    // review threads runs after a reply — the echo above is what makes the post
    // visible in place, and reloading the thread would drop the input. The next
    // render of the document (a refresh, a reopen, a reloaded window) re-derives
    // it from the timeline like any other reply.
    void vscode.window.showInformationMessage(vscode.l10n.t('Reply posted as a comment on the pull request timeline.'));
  }

  /**
   * Absolute URL of a review comment, in the shape Forgejo's own reply quotes:
   * the pull request's file view plus the comment's global hash tag.
   */
  private _commentUrl(instanceUrl: string, owner: string, repo: string, index: number, commentId: number): string {
    const base = instanceUrl.replace(/\/+$/, '');
    return `${base}/${owner}/${repo}/pulls/${index}/files#issuecomment-${commentId}`;
  }
}
