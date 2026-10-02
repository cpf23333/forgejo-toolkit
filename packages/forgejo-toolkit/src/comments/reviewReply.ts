/**
 * The body of a reply on Forgejo.
 *
 * Forgejo has no reply object: its web UI posts a reply as a comment — a
 * **review** comment carrying `origin=timeline`, which is what puts it on the
 * pull request timeline. The route's `reply=` does not name the comment being
 * answered: it is a **review** id, read only to decide whether the new comment
 * joins that pending review (`routers/web/repo/pull_review.go`), and Forgejo's
 * comment model carries no reply-to field — a thread is a query, not a stored
 * edge. The body the web UI itself posts for a quoted reply (captured on the
 * instance, comment 125) is:
 *
 * ```
 * @reviewer wrote in https://forgejo.example.com/owner/repo/pulls/9/files#issuecomment-100:
 *
 * > the quoted text
 *
 * the reply
 * ```
 *
 * — the attribution as a **plain line** (no quote marker), a blank line, the
 * quoted comment line by line, a blank line, then the reply text. Attribution and
 * quoting are a **client-side convention**: the browser appends the attribution
 * and inserts the quote (`web_src/js/features/repo-legacy.js`, the quote-reply
 * handler), and the server stores the resulting text with no notion of it. Our
 * body keeps every piece of that shape: the same attribution text, the same
 * line-by-line quoting of the raw comment, the same single blank lines. It
 * differs in exactly one way, on purpose: the reply text comes first and the
 * quoted block last.
 *
 * Forgejo's instance home activity feed stores the **first line** of a comment
 * body as the activity row's excerpt and renders that excerpt instead of the
 * comment. `abbreviatedComment` (`services/feed/action.go`) cuts it once, when
 * the row is written: `strings.Split(body, "\n")[0]` — a bare `\n`, so a trailing
 * `\r` survives — then `util.SplitStringAtByteN(firstLine, 200)`, at most 200
 * bytes with the last broken word dropped within 15 bytes and a `…` appended. No
 * field, parameter or endpoint selects a later line, nothing strips a quote or an
 * attribution, and editing the comment never refreshes the row. Measured on the
 * instance: row 582 for the web-composed reply (comment 125) shows only its
 * attribution line, row 580 for our old quote-first reply (comment 123) shows the
 * quote, and row 581 for a reply whose body carried no quote (comment 124) showed
 * that text. The platform's own replies therefore read as their attribution
 * there; reply-first is what makes every excerpting consumer (home feed,
 * notifications, mail, mobile) show the words the user typed, while the quote
 * still renders as a quote, at the end. The excerpt is what makes the body's
 * order the only lever: our reply goes out on the issue-comment endpoint, which
 * notifies, whereas `POST …/reviews/{id}/comments` notifies nothing and so never
 * reaches the feed.
 *
 * `docs/design/pr-comment-replies.md` records the decision, the measured
 * evidence, the trade-off and the endpoint difference, and
 * `docs/design/README.md` indexes it.
 */

/**
 * The attribution text the platform's own reply writes for its quote:
 * `@<login> wrote in <absolute comment URL>:`, a plain line with no quote marker,
 * so the quote block that follows it is a separate blockquote — exactly as the
 * platform posts it. The literal parts are exported so the tests can pin the
 * platform's wording instead of restating it.
 */
export const REVIEW_REPLY_ATTRIBUTION_PREFIX = '@';
export const REVIEW_REPLY_ATTRIBUTION_MIDDLE = ' wrote in ';

/** Prefix every line of `text` with the markdown quote marker. */
export function quoteMarkdownLines(text: string): string {
  return text.replace(/^/gm, '> ');
}

export interface ReviewReplyQuote {
  /** Login of the author of the comment being quoted, without the `@`. */
  author: string;
  /** Absolute URL of the comment being quoted. */
  url: string;
  /** The comment's raw Forgejo body, quoted line by line. */
  body: string;
}

/**
 * Drop leading blank lines from the reply. `replyToComment` only refuses a text
 * that is empty after trimming, so a reply like `"\n\nhello"` reaches the
 * builder; left alone it would give the body an empty first line, and Forgejo's
 * instance home feed — which stores the body's first line as the activity row's
 * excerpt — would then render no text at all for the row. Only leading blank
 * lines are removed: the body's first line has to be the first line the user
 * actually typed.
 */
function withoutLeadingBlankLines(text: string): string {
  return text.replace(/^(?:[ \t]*\r?\n)+/, '');
}

/**
 * The body of a reply: the reply text first, one blank line, the attribution
 * line naming the original author and linking the original comment, one blank
 * line, then the quoted comment line by line. Reply-first is what makes an
 * excerpting consumer of the body — Forgejo's instance home activity feed above
 * all, which stores the body's first line — show the words the user typed
 * instead of the quote; that order is the only difference from the body the web
 * UI writes for the same reply. Leading blank lines in `reply` are dropped so
 * that first line is always the user's own text.
 */
export function buildReviewReplyBody(quote: ReviewReplyQuote, reply: string): string {
  return [
    withoutLeadingBlankLines(reply),
    '',
    `${REVIEW_REPLY_ATTRIBUTION_PREFIX}${quote.author}${REVIEW_REPLY_ATTRIBUTION_MIDDLE}${quote.url}:`,
    '',
    quoteMarkdownLines(quote.body),
  ].join('\n');
}
