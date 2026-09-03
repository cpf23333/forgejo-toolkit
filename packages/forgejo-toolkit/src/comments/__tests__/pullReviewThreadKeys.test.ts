import { describe, it, expect } from 'vitest';
import { pullReviewThreadKey, pullReviewThreadMatchesScope, type PullReviewThreadScope } from '../pullReviewThreadKeys';

const scope: PullReviewThreadScope = {
  instanceId: 'demo',
  owner: 'demo-user',
  repo: 'demo-repo',
  index: 2,
  path: 'src/index.ts',
  isBase: false,
};

describe('pullReviewThreadKey', () => {
  it('includes the instance id so identical PRs on different instances do not collide', () => {
    const other = pullReviewThreadKey({ ...scope, instanceId: 'other' }, 100, 200);
    expect(pullReviewThreadKey(scope, 100, 200)).not.toBe(other);
  });

  it('includes the diff side so base and head threads of the same comment do not collide', () => {
    const base = pullReviewThreadKey({ ...scope, isBase: true }, 100, 200);
    expect(pullReviewThreadKey(scope, 100, 200)).not.toBe(base);
  });

  it('stays unambiguous when the path contains key separators', () => {
    const withColon = pullReviewThreadKey({ ...scope, path: 'a:100:200' }, 1, 2);
    const plain = pullReviewThreadKey({ ...scope, path: 'a' }, 100, 200);
    expect(withColon).not.toBe(plain);
  });

  it('produces distinct keys per review comment', () => {
    expect(pullReviewThreadKey(scope, 100, 200)).not.toBe(pullReviewThreadKey(scope, 100, 201));
  });
});

describe('pullReviewThreadMatchesScope', () => {
  it('matches threads of the same document scope', () => {
    const key = pullReviewThreadKey(scope, 100, 200);
    expect(pullReviewThreadMatchesScope(key, scope)).toBe(true);
  });

  it('does not match threads of other files, pull requests, instances, or diff sides', () => {
    const key = pullReviewThreadKey(scope, 100, 200);
    expect(pullReviewThreadMatchesScope(key, { ...scope, path: 'src/other.ts' })).toBe(false);
    expect(pullReviewThreadMatchesScope(key, { ...scope, index: 3 })).toBe(false);
    expect(pullReviewThreadMatchesScope(key, { ...scope, instanceId: 'other' })).toBe(false);
    expect(pullReviewThreadMatchesScope(key, { ...scope, isBase: true })).toBe(false);
  });

  it('returns false for keys that are not serialized scopes', () => {
    expect(pullReviewThreadMatchesScope('not-json', scope)).toBe(false);
    expect(pullReviewThreadMatchesScope('123', scope)).toBe(false);
    expect(pullReviewThreadMatchesScope('"demo:demo-user"', scope)).toBe(false);
  });
});
