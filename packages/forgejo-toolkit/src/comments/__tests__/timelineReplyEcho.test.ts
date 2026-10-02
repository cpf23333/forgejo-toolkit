import { describe, expect, it } from 'vitest';
import {
  deriveTimelineReplyEchoes,
  parseTimelineReplyAttribution,
  type TimelineCommentLike,
} from '../timelineReplyEcho';

function attribution(commentId: number, login = 'reviewer'): string {
  return `@${login} wrote in https://forgejo.example.com/owner/repo/pulls/2/files#issuecomment-${commentId}:`;
}

describe('parseTimelineReplyAttribution', () => {
  it('reads the platform shape, where the attribution is the first line', () => {
    const body = [attribution(101), '', '> quoted text', '', 'the reply'].join('\n');

    expect(parseTimelineReplyAttribution(body)).toEqual({ author: 'reviewer', answeredCommentId: 101 });
  });

  it('reads our shape, where the reply text comes first and the attribution follows', () => {
    // Our replies are reply-first on purpose (the instance home activity feed
    // stores a body's first line as its excerpt), so a parser that only read the
    // first line would lose every reply this extension posts.
    const body = ['the reply', '', attribution(101), '', '> quoted text'].join('\n');

    expect(parseTimelineReplyAttribution(body)).toEqual({ author: 'reviewer', answeredCommentId: 101 });
  });

  it('accepts a body that opens with blank lines', () => {
    expect(parseTimelineReplyAttribution('\n\n' + attribution(7))).toEqual({
      author: 'reviewer',
      answeredCommentId: 7,
    });
  });

  it('tolerates a trailing carriage return, as a CRLF body leaves one', () => {
    // The feed's own excerpt keeps a trailing `\r` (it splits on a bare `\n`), so
    // an attribution line that reached us through such a copy must still parse.
    expect(parseTimelineReplyAttribution(`the reply\n\n${attribution(42)}\r`)).toEqual({
      author: 'reviewer',
      answeredCommentId: 42,
    });
  });

  it('stops at the first quote line, so a quoted attribution names nothing', () => {
    // The quoted reply's own attribution lives inside the quote block, and it
    // answers the comment that quoted reply answered — not this one.
    const body = ['my reply', '', attribution(101), '', `> ${attribution(55)}`, '> the quoted reply'].join('\n');

    expect(parseTimelineReplyAttribution(body)).toEqual({ author: 'reviewer', answeredCommentId: 101 });
    // With no attribution of its own, the quoted one is not picked up.
    expect(parseTimelineReplyAttribution(`> ${attribution(55)}\n> the quoted reply`)).toBeUndefined();
  });

  it('ignores a body without an attribution, and a body that is not there at all', () => {
    expect(parseTimelineReplyAttribution('just a comment')).toBeUndefined();
    expect(parseTimelineReplyAttribution('')).toBeUndefined();
    expect(parseTimelineReplyAttribution(undefined)).toBeUndefined();
  });

  it('ignores prose that only mentions the wording', () => {
    expect(
      parseTimelineReplyAttribution('I saw that @reviewer wrote in the linked issue, so:\n\n> quoted'),
    ).toBeUndefined();
    // Mid-line, without the line ending a real attribution has.
    expect(parseTimelineReplyAttribution(`see ${attribution(3)} above`)).toBeUndefined();
  });

  it('ignores an attribution whose URL names no comment id', () => {
    expect(
      parseTimelineReplyAttribution('@reviewer wrote in https://forgejo.example.com/owner/repo/pulls/2/files:'),
    ).toBeUndefined();
    expect(
      parseTimelineReplyAttribution(
        '@reviewer wrote in https://forgejo.example.com/owner/repo/pulls/2/files#issuecomment-abc:',
      ),
    ).toBeUndefined();
  });

  it('returns the first of several unquoted attributions', () => {
    // Only the first can be this comment's own; a later one is body content.
    const body = [attribution(101), '', attribution(102), '', 'the reply'].join('\n');

    expect(parseTimelineReplyAttribution(body)).toEqual({ author: 'reviewer', answeredCommentId: 101 });
  });
});

describe('deriveTimelineReplyEchoes', () => {
  const THREAD_A = '["inst-1","owner","repo","2","src/index.ts",false,"sha1",1,0]';
  const THREAD_B = '["inst-1","owner","repo","2","src/index.ts",false,"sha1",2,0]';

  const comment = (id: number, body: string, overrides: Partial<TimelineCommentLike> = {}): TimelineCommentLike => ({
    id,
    body,
    created_at: '2026-10-02T10:00:00Z',
    user: { login: 'user' },
    ...overrides,
  });

  it('groups a reply under the thread that renders the comment it answers', () => {
    const body = ['reply', '', attribution(101)].join('\n');
    const byThread = deriveTimelineReplyEchoes([comment(700, body)], new Map([[101, THREAD_A]]));

    expect(byThread.get(THREAD_A)).toEqual([
      { timelineCommentId: 700, body, author: 'user', postedAt: new Date('2026-10-02T10:00:00Z') },
    ]);
  });

  it('keeps each thread separate and the timeline order within one', () => {
    const byThread = deriveTimelineReplyEchoes(
      [
        comment(800, ['answer to b', '', attribution(202)].join('\n')),
        comment(801, ['answer to a', '', attribution(201)].join('\n')),
        comment(802, ['a second answer to a', '', attribution(201)].join('\n')),
      ],
      new Map([
        [201, THREAD_A],
        [202, THREAD_B],
      ]),
    );

    expect(byThread.get(THREAD_A)?.map((echo) => echo.timelineCommentId)).toEqual([801, 802]);
    expect(byThread.get(THREAD_B)?.map((echo) => echo.timelineCommentId)).toEqual([800]);
  });

  it('ignores a reply whose answered id no thread renders, and one with no attribution', () => {
    // 999 is a comment that was deleted, or one on a file this render never
    // attached: either way there is no thread for it.
    const byThread = deriveTimelineReplyEchoes(
      [
        comment(810, ['answers a comment nobody renders', '', attribution(999)].join('\n')),
        comment(811, 'a plain timeline comment'),
        comment(812, ['answers nothing', '', '@reviewer wrote in somewhere:'].join('\n')),
      ],
      new Map([[201, THREAD_A]]),
    );

    expect(byThread.size).toBe(0);
  });

  it('ignores a row without an id, which could never be deduped again', () => {
    const byThread = deriveTimelineReplyEchoes(
      [comment(0, ['reply', '', attribution(201)].join('\n'), { id: undefined })],
      new Map([[201, THREAD_A]]),
    );

    expect(byThread.size).toBe(0);
  });

  it('falls back to the attribution login when the row names no user', () => {
    const byThread = deriveTimelineReplyEchoes(
      [comment(820, ['reply', '', attribution(201, 'quoted-author')].join('\n'), { user: undefined })],
      new Map([[201, THREAD_A]]),
    );

    expect(byThread.get(THREAD_A)?.[0].author).toBe('quoted-author');
  });

  it('answers with no echoes and reads no timeline when no thread renders anything', () => {
    const byThread = deriveTimelineReplyEchoes([comment(830, ['reply', '', attribution(201)].join('\n'))], new Map());

    // The controller relies on this to skip the timeline request entirely: an
    // empty id map means there is nothing an echo could attach to.
    expect(byThread.size).toBe(0);
  });

  it('keeps an unparseable timestamp as undefined rather than inventing one', () => {
    const byThread = deriveTimelineReplyEchoes(
      [comment(840, ['reply', '', attribution(201)].join('\n'), { created_at: 'not a date' })],
      new Map([[201, THREAD_A]]),
    );

    expect(byThread.get(THREAD_A)?.[0].postedAt).toBeUndefined();
  });

  it('reads the attribution of the platform shape as well', () => {
    const byThread = deriveTimelineReplyEchoes(
      [comment(850, [attribution(201), '', '> quoted', '', 'platform-order reply'].join('\n'))],
      new Map([[201, THREAD_A]]),
    );

    expect(byThread.get(THREAD_A)?.[0].timelineCommentId).toBe(850);
  });
});
