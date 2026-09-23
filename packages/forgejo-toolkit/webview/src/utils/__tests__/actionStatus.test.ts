import { describe, expect, it } from 'vitest';
import { actionStatusClass, actionStatusIcon, isActionRunCancellable, isActionStatusFailed } from '../actionStatus';

/** `models/actions/status.go` is the source of this list. */
const FORGEJO_STATUSES = ['unknown', 'waiting', 'running', 'success', 'failure', 'cancelled', 'skipped', 'blocked'];

describe('actionStatusIcon', () => {
  it('maps every Forgejo status to a codicon', () => {
    const icons = new Map(FORGEJO_STATUSES.map((status) => [status, actionStatusIcon(status)]));
    expect(icons.get('success')).toBe('check');
    expect(icons.get('failure')).toBe('error');
    expect(icons.get('running')).toBe('sync');
    expect(icons.get('waiting')).toBe('watch');
    expect(icons.get('blocked')).toBe('lock');
    expect(icons.get('cancelled')).toBe('circle-slash');
    expect(icons.get('skipped')).toBe('debug-step-over');
    // `unknown` deliberately keeps the fallback icon.
    expect(icons.get('unknown')).toBe('question');
  });

  it('does not pretend GitHub-only statuses exist', () => {
    // The views used to list these, which hid the fact that `blocked` was missing.
    expect(actionStatusIcon('pending')).toBe('question');
    expect(actionStatusIcon('requested')).toBe('question');
  });
});

describe('actionStatusClass', () => {
  it('falls back to unknown so the row still gets a status class', () => {
    expect(actionStatusClass('blocked')).toBe('blocked');
    expect(actionStatusClass(undefined)).toBe('unknown');
  });
});

describe('isActionStatusFailed', () => {
  it('flags failure and error only', () => {
    expect(isActionStatusFailed('failure')).toBe(true);
    expect(isActionStatusFailed('error')).toBe(true);
    expect(isActionStatusFailed('cancelled')).toBe(false);
    expect(isActionStatusFailed(undefined)).toBe(false);
  });
});

describe('isActionRunCancellable', () => {
  it('offers cancel for the statuses the server accepts', () => {
    for (const status of ['unknown', 'waiting', 'running', 'blocked']) {
      expect(isActionRunCancellable(status), status).toBe(true);
    }
  });

  it('hides cancel for final states and ignores non-Forgejo statuses', () => {
    for (const status of ['success', 'failure', 'cancelled', 'skipped', 'pending', 'requested', undefined]) {
      expect(isActionRunCancellable(status), String(status)).toBe(false);
    }
  });
});
