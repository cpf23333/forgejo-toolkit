import { describe, it, expect } from 'vitest';
import { pullReviewThreadKey, pullReviewThreadMatchesScope, type PullReviewThreadScope } from '../pullReviewThreadKeys';

const scope: PullReviewThreadScope = {
  instanceId: 'demo',
  owner: 'demo-user',
  repo: 'demo-repo',
  index: 2,
  path: 'src/index.ts',
  isBase: false,
  ref: 'abc123',
};

const anchor = { line: 4, extraLines: 1 };

describe('pullReviewThreadKey', () => {
  it('includes the instance id so identical PRs on different instances do not collide', () => {
    const other = pullReviewThreadKey({ ...scope, instanceId: 'other' }, anchor);
    expect(pullReviewThreadKey(scope, anchor)).not.toBe(other);
  });

  it('includes the diff side so base and head threads of the same comment do not collide', () => {
    const base = pullReviewThreadKey({ ...scope, isBase: true }, anchor);
    expect(pullReviewThreadKey(scope, anchor)).not.toBe(base);
  });

  it('includes the ref so threads from different revisions of the same PR do not collide', () => {
    const other = pullReviewThreadKey({ ...scope, ref: 'def456' }, anchor);
    expect(pullReviewThreadKey(scope, anchor)).not.toBe(other);
  });

  it('stays unambiguous when the path contains key separators', () => {
    const withColon = pullReviewThreadKey({ ...scope, path: 'a:100:200' }, anchor);
    const plain = pullReviewThreadKey({ ...scope, path: 'a' }, anchor);
    expect(withColon).not.toBe(plain);
  });

  it('produces distinct keys for different anchors', () => {
    // A reply is a comment at the anchor it answers, so the anchor — not the
    // comment id — is what decides which thread a comment belongs to.
    expect(pullReviewThreadKey(scope, { line: 4, extraLines: 1 })).not.toBe(
      pullReviewThreadKey(scope, { line: 5, extraLines: 1 }),
    );
    expect(pullReviewThreadKey(scope, { line: 4, extraLines: 1 })).not.toBe(
      pullReviewThreadKey(scope, { line: 4, extraLines: 0 }),
    );
  });

  it('produces one key for every comment of the same anchor', () => {
    // Two comments (the original and a reply) at the same range are one
    // conversation; keying them apart would render two threads on one line.
    expect(pullReviewThreadKey(scope, { line: 4, extraLines: 1 })).toBe(
      pullReviewThreadKey(scope, { line: 4, extraLines: 1 }),
    );
  });
});

describe('pullReviewThreadMatchesScope', () => {
  it('matches threads of the same document scope', () => {
    const key = pullReviewThreadKey(scope, anchor);
    expect(pullReviewThreadMatchesScope(key, scope)).toBe(true);
  });

  it('does not match threads of other files, pull requests, instances, or diff sides', () => {
    const key = pullReviewThreadKey(scope, anchor);
    expect(pullReviewThreadMatchesScope(key, { ...scope, path: 'src/other.ts' })).toBe(false);
    expect(pullReviewThreadMatchesScope(key, { ...scope, index: 3 })).toBe(false);
    expect(pullReviewThreadMatchesScope(key, { ...scope, instanceId: 'other' })).toBe(false);
    expect(pullReviewThreadMatchesScope(key, { ...scope, isBase: true })).toBe(false);
    expect(pullReviewThreadMatchesScope(key, { ...scope, ref: 'def456' })).toBe(false);
  });

  it('returns false for keys that are not serialized scopes', () => {
    expect(pullReviewThreadMatchesScope('not-json', scope)).toBe(false);
    expect(pullReviewThreadMatchesScope('123', scope)).toBe(false);
    expect(pullReviewThreadMatchesScope('"demo:demo-user"', scope)).toBe(false);
  });
});
