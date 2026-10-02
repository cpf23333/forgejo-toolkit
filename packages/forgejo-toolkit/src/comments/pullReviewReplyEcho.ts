/**
 * The local echo of a reply that was posted to a pull request's timeline.
 *
 * Forgejo has no reply object: our reply is an ordinary issue-level comment
 * (`createIssueComment`, `POST /repos/{owner}/{repo}/issues/{index}/comments`),
 * which is exactly what makes it immediately visible on the web — and a comment
 * thread renders **review** comments, so the reply can never come back from the
 * review API. Without an echo, a successful reply leaves the thread that was
 * answered looking untouched: the maintainer's report was "nothing happens in
 * VS Code after posting".
 *
 * The echo is a **rendering aid, not a server object**. It is never written
 * back, re-posted, counted or sent anywhere, it is never registered as one of
 * the server's comments, and it changes nothing about what the thread believes
 * the server holds. Since the timeline became the echo's source
 * (`timelineReplyEcho.ts` derives every quote reply from the pull request's
 * timeline), this store only covers the seconds between a successful POST and
 * the timeline returning the row it created: the derived echo takes over as soon
 * as it appears, and the local entry is dropped in its favour rather than
 * rendered twice. The store is therefore still in memory and still keyed exactly
 * like the threads it belongs to (`pullReviewThreadKeys.ts`) — what changed is
 * that a window reload no longer loses the echo, because nothing local is needed
 * to rebuild it. See `docs/design/pr-comment-replies.md` §3.
 */

/**
 * `contextValue` prefix of an echoed reply — the local one and the
 * server-derived one alike.
 *
 * Deliberately **not** the `forgejo:` prefix the encoded server comments use:
 * the `comments/comment/context` menu offers Delete for
 * `comment =~ /^forgejo:/`, and an echo must not offer the review comment's own
 * actions — there is no server comment behind it to delete, and no context to
 * resolve. The prefix is what `isEchoedReply` recognises and what keeps an echo
 * out of `_commentContextMap` / `_commentQuoteSources`.
 */
export const ECHOED_REPLY_CONTEXT_VALUE_PREFIX = 'forgejo-timeline-reply:';

export interface EchoedReply {
  /** The body exactly as it stands on the timeline. */
  body: string;
  /** Login of the user who posted it, as the instance reports it. */
  author: string;
  /** Localised note rendered as the comment's label. */
  label: string;
  /**
   * When the reply was posted. For a local echo this is when this session saw
   * the POST succeed (not a server timestamp); a server-derived echo carries the
   * timeline comment's own `created_at`.
   */
  postedAt: Date | undefined;
  /** Recognisable `contextValue`; never registered as a server comment. */
  contextValue: string;
  /**
   * Id of the timeline comment this echo stands for, when it is known: the POST
   * response carries it for a local echo, and a derived echo *is* one. It is
   * what the dedupe matches on, so the same reply cannot render twice.
   */
  timelineCommentId?: number;
}

/** Whether a rendered comment is one of our echoes rather than a server comment. */
export function isEchoedReply(comment: { contextValue?: string }): boolean {
  return comment.contextValue?.startsWith(ECHOED_REPLY_CONTEXT_VALUE_PREFIX) === true;
}

/** What the controller knows when a reply POST succeeded. */
export interface EchoedReplyInput {
  body: string;
  author: string;
  label: string;
  postedAt: Date;
  /** Id the POST returned for the created timeline comment, when it returned one. */
  timelineCommentId?: number;
}

/**
 * The locally echoed replies of this extension session, one list per thread key
 * (`pullReviewThreadKey`). The key is the only thing that ties an echo to the
 * thread it belongs to, so two threads — including two anchors in one file —
 * keep their own echoes.
 *
 * It is intentionally not a cache: entries are never evicted and never expire,
 * because an echo that disappeared on its own would be a lie about what the user
 * posted. The number of entries is bounded by the replies the user types in one
 * session, and each of them is superseded (and hidden) by the derived record the
 * timeline provides.
 */
export class EchoedReplyStore {
  private readonly _byThread = new Map<string, EchoedReply[]>();
  private _sequence = 0;

  /** Remember one successfully posted reply. */
  add(threadKey: string, reply: EchoedReplyInput): EchoedReply {
    const echo: EchoedReply = {
      body: reply.body,
      author: reply.author,
      label: reply.label,
      postedAt: reply.postedAt,
      contextValue: `${ECHOED_REPLY_CONTEXT_VALUE_PREFIX}${this._sequence++}`,
      timelineCommentId: reply.timelineCommentId,
    };
    const existing = this._byThread.get(threadKey);
    if (existing) {
      existing.push(echo);
    } else {
      this._byThread.set(threadKey, [echo]);
    }
    return echo;
  }

  /** The replies echoed into one thread, oldest first; empty when there are none. */
  get(threadKey: string): readonly EchoedReply[] {
    return this._byThread.get(threadKey) ?? [];
  }

  clear(): void {
    this._byThread.clear();
    // The sequence deliberately is not rewound: a marker is never reused, so a
    // comment object left over from before the clear cannot collide with a new
    // echo's.
  }
}
