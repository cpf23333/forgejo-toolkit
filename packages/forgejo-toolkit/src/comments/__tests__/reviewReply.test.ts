import { describe, expect, it } from 'vitest';
import {
  buildReviewReplyBody,
  quoteMarkdownLines,
  REVIEW_REPLY_ATTRIBUTION_MIDDLE,
  REVIEW_REPLY_ATTRIBUTION_PREFIX,
  type ReviewReplyQuote,
} from '../reviewReply';

const URL = 'https://forgejo.example.com/owner/repo/pulls/9/files#issuecomment-100';

function quote(body: string, author = 'reviewer'): ReviewReplyQuote {
  return { author, url: URL, body };
}

const ATTRIBUTION = `${REVIEW_REPLY_ATTRIBUTION_PREFIX}reviewer${REVIEW_REPLY_ATTRIBUTION_MIDDLE}${URL}:`;

/**
 * Forgejo's instance home activity feed stores the **first line** of a comment
 * body as the activity row's excerpt and renders that instead of the comment, so
 * a reply's own words have to be the body's first line. These tests pin the order
 * (reply, blank line, attribution line, blank line, quoted block) rather than
 * only a byte-for-byte example, because the order is the property the feed
 * depends on; the byte-for-byte example lives with the reply path in
 * `pullReviewCommentController.test.ts`.
 */
describe('buildReviewReplyBody order', () => {
  it('opens the body with a single-line reply', () => {
    const body = buildReviewReplyBody(quote('111'), '111');

    expect(body.split('\n')[0]).toBe('111');
    expect(body).toBe(['111', '', ATTRIBUTION, '', '> 111'].join('\n'));
  });

  it('opens the body with the first line the user typed on a multi-line reply', () => {
    const reply = 'first line the user typed\nsecond line\n\nfourth line';
    const body = buildReviewReplyBody(quote('note'), reply);
    const lines = body.split('\n');

    expect(lines[0]).toBe('first line the user typed');
    // Every line the user typed survives, in order, before the quote begins.
    expect(lines.slice(0, 4)).toEqual(['first line the user typed', 'second line', '', 'fourth line']);
    // Exactly one blank line separates the reply from the attribution line.
    expect(lines[4]).toBe('');
    expect(lines[5]).toBe(ATTRIBUTION);
    expect(lines[6]).toBe('');
    expect(lines[7]).toBe('> note');
    expect(lines).toHaveLength(8);
  });

  it('drops leading blank lines so the body starts with the text the user typed', () => {
    // The reply box only refuses a text that is empty after trimming, so a text
    // that starts with newlines reaches the builder. Left alone it would put an
    // empty first line on the body, and the instance home feed — which stores
    // that first line — would render a row with no text at all.
    for (const typed of ['\n\nhello', '\r\n\r\nhello', '   \nhello']) {
      const body = buildReviewReplyBody(quote('note'), typed);

      expect(body.split('\n')[0]).toBe('hello');
      expect(body.startsWith('\n')).toBe(false);
      expect(body).toBe(['hello', '', ATTRIBUTION, '', '> note'].join('\n'));
    }
  });

  it('leaves blank lines inside the reply alone', () => {
    const body = buildReviewReplyBody(quote('note'), 'hello\n\nworld');
    const lines = body.split('\n');

    expect(lines[0]).toBe('hello');
    expect(lines[1]).toBe('');
    expect(lines[2]).toBe('world');
    expect(lines[3]).toBe('');
    expect(lines[4]).toBe(ATTRIBUTION);
  });

  it('closes the body with the quoted block intact, even for a multi-line original', () => {
    const original = 'first line of the original\nsecond line of the original';
    const body = buildReviewReplyBody(quote(original), 'my reply');

    expect(body.split('\n')[0]).toBe('my reply');
    // The attribution line is the platform's own wording as a plain line (no
    // quote marker), and the quoted block still ends the body, one `> ` per
    // quoted line.
    expect(body).toBe(
      ['my reply', '', ATTRIBUTION, '', '> first line of the original', '> second line of the original'].join('\n'),
    );
    expect(body.endsWith(quoteMarkdownLines(original))).toBe(true);
  });

  it('quotes the original comment raw, line by line, at the end of the body', () => {
    // The quoted text is the comment's raw body, not a rendered one: an empty
    // line inside it becomes `> ` (a quoted empty line), and nothing is
    // re-wrapped or escaped.
    const original = 'a\n\nb';
    const body = buildReviewReplyBody(quote(original, 'someone-else'), 'answer');

    expect(body).toBe(['answer', '', `@someone-else wrote in ${URL}:`, '', '> a', '> ', '> b'].join('\n'));
    expect(body.split('\n')[2]).toBe(`@someone-else${REVIEW_REPLY_ATTRIBUTION_MIDDLE}${URL}:`);
  });
});
