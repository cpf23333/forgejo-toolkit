import { describe, expect, it } from 'vitest';
import { ECHOED_REPLY_CONTEXT_VALUE_PREFIX, EchoedReplyStore, isEchoedReply } from '../pullReviewReplyEcho';
import { pullReviewThreadKey } from '../pullReviewThreadKeys';

const FIRST_THREAD = pullReviewThreadKey(
  {
    instanceId: 'inst-1',
    owner: 'owner',
    repo: 'repo',
    index: 2,
    path: 'src/index.ts',
    isBase: false,
    ref: 'sha1',
  },
  { line: 1, extraLines: 0 },
);

const SECOND_THREAD = pullReviewThreadKey(
  {
    instanceId: 'inst-1',
    owner: 'owner',
    repo: 'repo',
    index: 2,
    path: 'src/index.ts',
    isBase: false,
    ref: 'sha1',
  },
  { line: 2, extraLines: 0 },
);

function input(body: string) {
  return { body, author: 'user', label: 'Posted to the pull request timeline', postedAt: new Date(0) };
}

describe('echoed reply marker', () => {
  it('does not look like a server comment context value', () => {
    // The `comments/comment/context` menu offers Delete for `comment =~
    // /^forgejo:/`, and an echo has nothing on the server to delete. The prefix
    // is therefore deliberately not the one the encoded review comments use.
    const serverCommentMenu = /^forgejo:/;
    expect(serverCommentMenu.test(ECHOED_REPLY_CONTEXT_VALUE_PREFIX)).toBe(false);
    const echo = new EchoedReplyStore().add(FIRST_THREAD, input('reply'));
    expect(serverCommentMenu.test(echo.contextValue)).toBe(false);
  });

  it('recognises an echo by its context value alone', () => {
    const store = new EchoedReplyStore();
    const echo = store.add(FIRST_THREAD, input('reply'));

    expect(isEchoedReply(echo)).toBe(true);
    expect(isEchoedReply({ contextValue: echo.contextValue })).toBe(true);
    // A server comment's encoded value and a comment without one are not echoes.
    expect(isEchoedReply({ contextValue: 'forgejo:inst-1:owner:repo:2:10:101:src/index.ts:2' })).toBe(false);
    expect(isEchoedReply({})).toBe(false);
    expect(isEchoedReply({ contextValue: undefined })).toBe(false);
  });
});

describe('EchoedReplyStore', () => {
  it('keeps each thread key separate, oldest first, with unique markers', () => {
    const store = new EchoedReplyStore();
    const first = store.add(FIRST_THREAD, input('answer to the first anchor'));
    const second = store.add(SECOND_THREAD, input('answer to the second anchor'));
    const third = store.add(FIRST_THREAD, input('a second reply on the first anchor'));

    expect(store.get(FIRST_THREAD)).toEqual([first, third]);
    expect(store.get(SECOND_THREAD)).toEqual([second]);
    expect(store.get(FIRST_THREAD).map((echo) => echo.body)).toEqual([
      'answer to the first anchor',
      'a second reply on the first anchor',
    ]);
    // Each echo carries its own recognisable marker.
    expect(new Set([first.contextValue, second.contextValue, third.contextValue]).size).toBe(3);
    for (const echo of [first, second, third]) {
      expect(echo.contextValue.startsWith(ECHOED_REPLY_CONTEXT_VALUE_PREFIX)).toBe(true);
    }
  });

  it('carries the posted body and its author unchanged', () => {
    const store = new EchoedReplyStore();
    // The posted body as `buildReviewReplyBody` now writes it: the reply first,
    // a blank line, the attribution line as a plain line, a blank line, then the
    // quoted block. The echo reproduces it byte for byte.
    const posted =
      'my reply\n\n@reviewer wrote in https://forgejo.example.com/owner/repo/pulls/2/files#issuecomment-101:\n\n> note';
    const echo = store.add(FIRST_THREAD, input(posted));

    expect(echo.body).toBe(posted);
    expect(echo.body.split('\n')[0]).toBe('my reply');
    expect(echo.body.endsWith('> note')).toBe(true);
    expect(echo.author).toBe('user');
    expect(echo.label).toBe('Posted to the pull request timeline');
  });

  it('answers an unknown thread key with an empty list, not undefined', () => {
    const store = new EchoedReplyStore();
    expect(store.get(FIRST_THREAD)).toEqual([]);
  });

  it('forgets everything on clear, and a later echo starts its own run', () => {
    const store = new EchoedReplyStore();
    const before = store.add(FIRST_THREAD, input('reply'));
    store.clear();

    expect(store.get(FIRST_THREAD)).toEqual([]);
    const after = store.add(FIRST_THREAD, input('reply after the clear'));
    expect(after.contextValue).not.toBe(before.contextValue);
    expect(store.get(FIRST_THREAD)).toEqual([after]);
  });
});
