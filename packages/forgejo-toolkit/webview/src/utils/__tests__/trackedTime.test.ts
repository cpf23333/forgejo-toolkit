import { describe, expect, it } from 'vitest';
import { canDeleteTrackedTime, findStopwatchElsewhere, isTrackedTimeTotal } from '../trackedTime';

describe('canDeleteTrackedTime', () => {
  it('allows the caller to delete their own entry', () => {
    expect(canDeleteTrackedTime('demo-user', 'demo-user')).toBe(true);
  });

  it("hides the button for somebody else's entry (the server answers 403)", () => {
    expect(canDeleteTrackedTime('other-user', 'demo-user')).toBe(false);
  });

  it('leaves the decision to the server when a name is unknown', () => {
    expect(canDeleteTrackedTime(undefined, 'demo-user')).toBe(true);
    expect(canDeleteTrackedTime('other-user', undefined)).toBe(true);
  });
});

describe('isTrackedTimeTotal', () => {
  it('is a total for the issue author', () => {
    expect(isTrackedTimeTotal([], 'demo-user', true)).toBe(true);
  });

  it("is a total once another user's entry shows up", () => {
    expect(isTrackedTimeTotal([{ user_name: 'demo-user' }, { user_name: 'other-user' }], 'demo-user', false)).toBe(
      true,
    );
  });

  it('stays personal while only own entries are visible', () => {
    // The server narrows the list to the caller for non-writers, so this may be
    // a subset and must not be presented as the issue total.
    expect(isTrackedTimeTotal([{ user_name: 'demo-user' }], 'demo-user', false)).toBe(false);
    expect(isTrackedTimeTotal([], 'demo-user', false)).toBe(false);
  });

  it('stays personal when the caller is unknown', () => {
    expect(isTrackedTimeTotal([{ user_name: 'other-user' }], undefined, false)).toBe(false);
  });
});

describe('findStopwatchElsewhere', () => {
  const current = { owner: 'demo-user', repo: 'demo-repo', index: 1 };
  const ours = { repo_owner_name: 'demo-user', repo_name: 'demo-repo', issue_index: 1 };

  it('reports a stopwatch running on another issue', () => {
    const other = { repo_owner_name: 'demo-user', repo_name: 'demo-repo', issue_index: 2 };
    expect(findStopwatchElsewhere([other], current)).toBe(other);
    expect(findStopwatchElsewhere([other, ours], current)).toBe(other);
  });

  it('says nothing when only this issue is being timed', () => {
    expect(findStopwatchElsewhere([ours], current)).toBeUndefined();
    expect(findStopwatchElsewhere([], current)).toBeUndefined();
  });
});
