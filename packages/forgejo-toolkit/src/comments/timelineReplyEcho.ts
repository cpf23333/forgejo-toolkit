/**
 * Deriving a thread's echoes from the server instead of remembering them.
 *
 * A reply is an issue-level comment (`createIssueComment`), so it can never come
 * back from the review API that fills a comment thread — but it *is* in the pull
 * request's timeline, and the timeline is readable. Every quote reply a person
 * writes — through this extension, through Forgejo's web UI, or from a phone —
 * carries the platform's attribution line in its body, and that line names the
 * comment being answered:
 *
 * ```
 * @<login> wrote in <absolute comment url>:
 * ```
 *
 * where the URL ends with `#issuecomment-<id>`. So a thread can be rebuilt from
 * the server on *any* window: match the attributed id against the review
 * comments that thread renders, and the reply is there again — including replies
 * this extension never posted. That is what replaced the session-scoped echo
 * store (`pullReviewReplyEcho.ts`) as the source of the rendering; the store
 * stays as the bridge for the moment between a successful POST and the timeline
 * returning the new row.
 *
 * The attribution is a **client-side convention**, not a server field
 * (`reviewReply.ts`): nothing in Forgejo's comment model records a reply edge, so
 * the body is the only carrier and this parse is the only way back. Two shapes
 * exist, and both are read here: the platform's own order puts the attribution
 * on the **first line** (quote first, reply last), while ours puts the reply text
 * first and the attribution after it — deliberately, because the instance home
 * activity feed stores a comment body's first line as the activity row's excerpt
 * (`docs/design/pr-comment-replies.md` §1.1). Reading the first line alone would
 * therefore re-derive only the platform's own replies and lose ours.
 */

import { REVIEW_REPLY_ATTRIBUTION_MIDDLE, REVIEW_REPLY_ATTRIBUTION_PREFIX } from './reviewReply';

/**
 * `@<login> wrote in <url>:`, anchored at both ends so a *quoted* attribution
 * (one carrying the `> ` marker the quote block adds) cannot match, and so a
 * paragraph that merely mentions the wording cannot either. The login is any
 * non-space run (Forgejo logins have no spaces) and the URL is any non-space run
 * — validated for the `#issuecomment-<id>` fragment separately, so a malformed
 * or truncated URL is simply not an attribution.
 */
const ATTRIBUTION_LINE_REGEX = new RegExp(
  `^${REVIEW_REPLY_ATTRIBUTION_PREFIX}(\\S+)${REVIEW_REPLY_ATTRIBUTION_MIDDLE}(\\S+):[ \\t\\r]*$`,
);

/** The comment id an attribution URL names, or `undefined` when it names none. */
const ISSUE_COMMENT_FRAGMENT_REGEX = /#issuecomment-(\d+)$/;

/** Prefix of a quote block's lines; where the attribution scan stops. */
const QUOTE_LINE_PREFIX = '>';

export interface TimelineReplyAttribution {
  /** Login the attribution names, as the timeline comment spells it. */
  author: string;
  /** Id of the comment the reply answers — the `#issuecomment-<id>` fragment. */
  answeredCommentId: number;
}

/**
 * The attribution of a timeline comment body, or `undefined` when it carries
 * none.
 *
 * Lines are read in order and the scan **stops at the first blockquote line**:
 * a quote block is where somebody else's words (and somebody else's attribution)
 * live, so an attribution inside it names a comment the *quoted* reply answered,
 * not this one. Empty lines are skipped rather than stopping the scan, because
 * ours separates the reply text from the attribution with one. The first
 * attribution before any quote block is the one this comment carries.
 *
 * Everything else is ignored on purpose: an absent attribution, a line that only
 * looks like one (a quoted or indented line, or prose that mentions the wording
 * mid-sentence), and a URL without a numeric `#issuecomment-` fragment.
 */
export function parseTimelineReplyAttribution(body: string | undefined): TimelineReplyAttribution | undefined {
  if (!body) {
    return undefined;
  }
  for (const line of body.split('\n')) {
    // Both the leading-whitespace and the CRLF `\r` are tolerated here (a body
    // rendered from a CRLF copy of the same attribution); the regex pins the
    // rest.
    const candidate = line.trimStart();
    if (candidate.startsWith(QUOTE_LINE_PREFIX)) {
      // A quote block: everything from here on is the quoted comment.
      return undefined;
    }
    const match = ATTRIBUTION_LINE_REGEX.exec(candidate);
    if (!match) {
      continue;
    }
    const fragment = ISSUE_COMMENT_FRAGMENT_REGEX.exec(match[2]);
    if (!fragment) {
      continue;
    }
    const answeredCommentId = Number(fragment[1]);
    if (!Number.isSafeInteger(answeredCommentId)) {
      continue;
    }
    return { author: match[1], answeredCommentId };
  }
  return undefined;
}

/** One timeline comment that answers a comment a thread renders. */
export interface TimelineReplyEcho {
  /**
   * Id of the timeline comment itself. Carried so the local echo from the POST
   * that created it can be recognised as the same reply and dropped (see
   * `_localEchoesToApply` in the controller).
   */
  timelineCommentId: number;
  /** The timeline comment's body, unchanged. */
  body: string;
  /** Login of the timeline comment's author, as the instance reports it. */
  author: string;
  /** When the timeline comment was created; `undefined` when unparseable. */
  postedAt: Date | undefined;
}

/** The timeline comment fields the derivation reads. */
export interface TimelineCommentLike {
  id?: number;
  body?: string;
  created_at?: string;
  user?: { login?: string } | undefined;
}

/** Review comment id → the thread key that renders it. */
export type ThreadKeyByCommentId = ReadonlyMap<number, string>;

/**
 * Group the timeline's quote replies by the thread they answer.
 *
 * A timeline comment lands in a thread exactly when the id its attribution names
 * is one of the review comments that thread renders (`answeredCommentId` is
 * looked up in `threadKeyByCommentId`) — so a reply whose quoted comment this
 * controller does not render, or whose quoted comment was deleted, matches
 * nothing and is ignored. Rows without an id are ignored too: the id is what the
 * dedupe against the local echo matches on, and an echo that cannot be
 * recognised later would render twice.
 *
 * The map's insertion order is the timeline's order, and each thread's list keeps
 * it, so echoes read oldest-first exactly as the thread's own comments do.
 */
export function deriveTimelineReplyEchoes(
  timeline: readonly TimelineCommentLike[],
  threadKeyByCommentId: ThreadKeyByCommentId,
): Map<string, TimelineReplyEcho[]> {
  const byThread = new Map<string, TimelineReplyEcho[]>();
  if (threadKeyByCommentId.size === 0) {
    return byThread;
  }
  for (const comment of timeline) {
    const timelineCommentId = comment.id;
    const body = comment.body;
    if (typeof timelineCommentId !== 'number' || !body) {
      continue;
    }
    const attribution = parseTimelineReplyAttribution(body);
    if (!attribution) {
      continue;
    }
    const threadKey = threadKeyByCommentId.get(attribution.answeredCommentId);
    if (threadKey === undefined) {
      continue;
    }
    const echo: TimelineReplyEcho = {
      timelineCommentId,
      body,
      author: comment.user?.login ?? attribution.author,
      postedAt: toDate(comment.created_at),
    };
    const existing = byThread.get(threadKey);
    if (existing) {
      existing.push(echo);
    } else {
      byThread.set(threadKey, [echo]);
    }
  }
  return byThread;
}

/** `created_at` as a `Date`, or `undefined` when absent or unparseable. */
function toDate(createdAt: string | undefined): Date | undefined {
  if (!createdAt) {
    return undefined;
  }
  const date = new Date(createdAt);
  return Number.isNaN(date.getTime()) ? undefined : date;
}
