import { describe, expect, it } from 'vitest';
import {
  actionStatusClass,
  actionStatusIcon,
  isActionRunCancellable,
  isActionRunDeletable,
  isActionStatusFailed,
  isActionStatusFinal,
  shouldPollActionRun,
} from '../actionStatus';

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

describe('isActionRunDeletable', () => {
  it('allows exactly the finished states the server accepts', () => {
    for (const status of ['success', 'failure', 'cancelled', 'skipped']) {
      expect(isActionRunDeletable(status), status).toBe(true);
    }
    // Anything else makes DELETE answer 500, so the button must stay hidden.
    for (const status of ['unknown', 'waiting', 'running', 'blocked', 'pending', undefined]) {
      expect(isActionRunDeletable(status), String(status)).toBe(false);
    }
  });
});

describe('isActionStatusFinal', () => {
  it('covers the done states and nothing else', () => {
    for (const status of ['success', 'failure', 'error', 'cancelled', 'skipped']) {
      expect(isActionStatusFinal(status), status).toBe(true);
    }
    for (const status of ['unknown', 'waiting', 'running', 'blocked', undefined]) {
      expect(isActionStatusFinal(status), String(status)).toBe(false);
    }
  });
});

/**
 * The run detail view polls a live run and stops when it finishes. A failed
 * load is the case that used to leak: no run entry is stored on error, so the
 * status stays `undefined`, `isActionStatusFinal(undefined)` is false, and the
 * interval refetched the failing request forever.
 */
describe('shouldPollActionRun', () => {
  it('keeps polling only while the run is live', () => {
    for (const status of ['unknown', 'waiting', 'running', 'blocked']) {
      expect(shouldPollActionRun(status, false), status).toBe(true);
    }
  });

  it('stops once the run reached a final status', () => {
    for (const status of ['success', 'failure', 'error', 'cancelled', 'skipped']) {
      expect(shouldPollActionRun(status, false), status).toBe(false);
    }
  });

  it('stops after a failed load even though no run status is known', () => {
    // The exact shape of the bug: the run could not be loaded, so there is no
    // status, and the poll decision must still say "stop".
    expect(shouldPollActionRun(undefined, true)).toBe(false);
    expect(shouldPollActionRun('running', true)).toBe(false);
    expect(shouldPollActionRun(undefined, false)).toBe(true);
  });

  it('is not the status-only predicate the view used to ask', () => {
    // Pre-fix the decision was `!isActionStatusFinal(status)` alone: with no run
    // entry stored on a failed load the status is undefined, so that predicate
    // answered "poll" and the interval refetched the failing request forever.
    const statusOnly = (status?: string) => !isActionStatusFinal(status);
    expect(statusOnly(undefined)).toBe(true);
    expect(shouldPollActionRun(undefined, true)).toBe(false);
  });
});
