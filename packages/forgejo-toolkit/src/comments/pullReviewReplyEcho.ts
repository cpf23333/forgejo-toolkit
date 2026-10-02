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
 * The echo is a **local, session-scoped rendering aid, not a server object**. It
 * is never written back, re-posted, counted or sent anywhere, it is never
 * registered as one of the server's comments, and it changes nothing about what
 * the thread believes the server holds. It lives only in memory, keyed exactly
 * like the threads it belongs to (`pullReviewThreadKeys.ts`), so every rebuild
 * or re-render of a thread re-applies it for as long as the extension session
 * lasts. A window reload drops it — the threads are rebuilt from review data and
 * the reply is not review data — while the reply itself stays on the pull
 * request's timeline, which the thread's own context points at. That limitation
 * is recorded in `docs/design/pr-comment-replies.md` and in the paired
 * `KNOWN_ISSUES.md` / `KNOWN_ISSUES.zh.md` entry.
 */

/**
 * `contextValue` prefix of an echoed reply.
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
  /** The body exactly as it was posted to the timeline. */
  body: string;
  /** Login of the user who posted it, as the instance reports it. */
  author: string;
  /** Localised note rendered as the comment's label. */
  label: string;
  /**
   * Local time the reply was posted. Local-only on purpose: it is when this
   * session saw the POST succeed, not a server timestamp.
   */
  postedAt: Date;
  /** Recognisable `contextValue`; never registered as a server comment. */
  contextValue: string;
}

/** Whether a rendered comment is one of our local echoes rather than a server comment. */
export function isEchoedReply(comment: { contextValue?: string }): boolean {
  return comment.contextValue?.startsWith(ECHOED_REPLY_CONTEXT_VALUE_PREFIX) === true;
}

/** What the controller knows when a reply POST succeeded. */
export interface EchoedReplyInput {
  body: string;
  author: string;
  label: string;
  postedAt: Date;
}

/**
 * The echoed replies of this extension session, one list per thread key
 * (`pullReviewThreadKey`). The key is the only thing that ties an echo to the
 * thread it belongs to, so two threads — including two anchors in one file —
 * keep their own echoes.
 *
 * It is intentionally not a cache: entries are never evicted and never expire,
 * because an echo that disappeared on its own would be a lie about what the
 * user posted. The number of entries is bounded by the replies the user types
 * in one session.
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
