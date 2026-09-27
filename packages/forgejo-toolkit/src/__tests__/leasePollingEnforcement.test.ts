import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as vscode from 'vscode';
import type { PagedList } from '../api/client';
import type { ForgejoNotification } from '../api/types';
import type { ForgejoInstance } from '@cpf23333-forgejo-toolkit/shared/webview/messages';
import type { LeasePollingGate } from '../lease/leasePollingGate';

/**
 * The notification poller's half of stage 2: what the lease's answer actually
 * changes. The supervisor's half — the rule that decides the answer — is
 * `leasePollingGate.test.ts`.
 *
 * The gate is faked here on purpose. This suite is about the poller's
 * behaviour, and a fake makes the state under test explicit: "the lease says
 * suppress" is exactly `gate.set(false)`.
 *
 * The one boundary worth naming: a round already in flight when the gate closes
 * still finishes and still alerts, because a handover is "the round belongs to
 * whoever started it". The window that takes over re-polls immediately and
 * reads the baseline the finishing round wrote (`_reconcileSeenIds`), so the
 * same notification is not alerted twice.
 */

const mockGetNotifications =
  vi.fn<
    (
      statusTypes?: string[],
      subjectType?: ('issue' | 'pull' | 'repository')[],
      limit?: number,
      before?: string,
    ) => Promise<PagedList<ForgejoNotification>>
  >();

vi.mock('../api/client', () => ({
  ForgejoClient: vi.fn().mockImplementation(function () {
    return {
      getNotifications: mockGetNotifications,
      markAllNotificationsRead: vi.fn().mockResolvedValue(undefined),
    };
  }),
}));

import { NotificationPoller } from '../notifications/notificationPoller';

const instanceA: ForgejoInstance = {
  id: 'a',
  url: 'https://forgejo.example.com',
  token: 'token-a',
  name: 'a@forgejo.example.com',
  username: 'a',
};

function paged(items: ForgejoNotification[], totalCount?: number): PagedList<ForgejoNotification> {
  return { items, totalCount };
}

function notification(id: number): ForgejoNotification {
  return { id } as ForgejoNotification;
}

/** A controllable `LeasePollingGate`: the answer plus its change event. */
function makeGate(initial: boolean): { gate: LeasePollingGate; set(next: boolean): void; listeners(): number } {
  let value = initial;
  const listeners = new Set<(mayPoll: boolean) => void>();
  return {
    gate: {
      mayPoll: () => value,
      onDidChange: (listener) => {
        listeners.add(listener);
        return {
          dispose: () => {
            listeners.delete(listener);
          },
        };
      },
    },
    set: (next) => {
      value = next;
      for (const listener of [...listeners]) {
        listener(next);
      }
    },
    listeners: () => listeners.size,
  };
}

function createFakeConfig(instances: ForgejoInstance[]) {
  return {
    getInstances: () => instances,
    isNotificationPollingEnabled: () => true,
    getNotificationPollingInterval: () => 300,
    onInstancesChanged: () => ({ dispose: vi.fn() }),
  };
}

function createFakeContext(store = new Map<string, unknown>()) {
  return {
    store,
    globalState: {
      get: (key: string, fallback?: unknown) => store.get(key) ?? fallback,
      update: async (key: string, value: unknown) => {
        store.set(key, value);
      },
    },
  };
}

describe('the notification poller follows the polling lease (§8, §11.1 stage 2)', () => {
  const sender = { pushNotifications: vi.fn(), pushNotificationError: vi.fn(), openNotifications: vi.fn() };
  const logger = { debug: vi.fn(), info: vi.fn(), error: vi.fn() };

  beforeEach(() => {
    vi.useFakeTimers();
    mockGetNotifications.mockReset();
    (vscode.window.showInformationMessage as ReturnType<typeof vi.fn>).mockReset();
    (vscode.window.showInformationMessage as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function createPoller(lease?: LeasePollingGate, store = new Map<string, unknown>()) {
    const config = createFakeConfig([instanceA]);
    const context = createFakeContext(store);
    return {
      poller: new NotificationPoller(config as never, sender as never, context as never, logger as never, lease),
      store,
    };
  }

  it('polls exactly as before when there is no gate at all', async () => {
    mockGetNotifications.mockResolvedValue(paged([notification(1)]));
    const { poller } = createPoller();

    poller.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(mockGetNotifications).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(300_000);
    expect(mockGetNotifications).toHaveBeenCalledTimes(2);
    poller.dispose();
  });

  it('polls and alerts for the owner (and with the setting off: the gate is open)', async () => {
    // A stored baseline, so the next round's notification is "new" and toasts.
    const store = new Map<string, unknown>([['forgejoToolkit.seenNotificationIds', { a: [1] }]]);
    const gate = makeGate(true);
    mockGetNotifications.mockResolvedValue(paged([notification(1), notification(2)]));
    const { poller } = createPoller(gate.gate, store);

    poller.start();
    await vi.advanceTimersByTimeAsync(0);

    expect(mockGetNotifications).toHaveBeenCalledTimes(1);
    expect(vscode.window.showInformationMessage).toHaveBeenCalledTimes(1);
    poller.dispose();
  });

  it('does not poll and does not alert while it is a healthy follower', async () => {
    const store = new Map<string, unknown>([['forgejoToolkit.seenNotificationIds', { a: [1] }]]);
    const gate = makeGate(false);
    mockGetNotifications.mockResolvedValue(paged([notification(1), notification(2)]));
    const { poller } = createPoller(gate.gate, store);

    poller.start();
    await vi.advanceTimersByTimeAsync(0);
    // Ten intervals: not one request, not one alert, and nothing written to the
    // baseline (a follower observes nothing, so it owns nothing).
    await vi.advanceTimersByTimeAsync(3_000_000);

    expect(mockGetNotifications).not.toHaveBeenCalled();
    expect(vscode.window.showInformationMessage).not.toHaveBeenCalled();
    expect(store.get('forgejoToolkit.seenNotificationIds')).toEqual({ a: [1] });
    poller.dispose();
  });

  it('polls immediately on the transition to owner, not at the next interval', async () => {
    const gate = makeGate(false);
    mockGetNotifications.mockResolvedValue(paged([]));
    const { poller } = createPoller(gate.gate);

    poller.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(mockGetNotifications).not.toHaveBeenCalled();

    // The supervisor publishes the transition when the previous owner closes,
    // crashes or yields to this window's focus. No timer is advanced here: the
    // whole point is that the poll does not wait for one.
    gate.set(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(mockGetNotifications).toHaveBeenCalledTimes(1);

    // …and the normal cadence resumes.
    await vi.advanceTimersByTimeAsync(300_000);
    expect(mockGetNotifications).toHaveBeenCalledTimes(2);
    poller.dispose();
  });

  it('resumes polling when a degraded mechanism reopens the gate', async () => {
    // §8's safety rail, seen from the poller: "degraded" is just a gate that is
    // open, so the window polls at full speed like every other degraded state.
    const gate = makeGate(false);
    mockGetNotifications.mockResolvedValue(paged([]));
    const { poller } = createPoller(gate.gate);

    poller.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(mockGetNotifications).not.toHaveBeenCalled();

    gate.set(true);
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(600_000);
    expect(mockGetNotifications).toHaveBeenCalledTimes(3);
    poller.dispose();
  });

  it('lets a round that started while allowed finish and alert when the gate closes mid-flight', async () => {
    let resolveRequest: (page: PagedList<ForgejoNotification>) => void = () => undefined;
    mockGetNotifications.mockImplementation(
      () =>
        new Promise<PagedList<ForgejoNotification>>((resolve) => {
          resolveRequest = resolve;
        }),
    );
    const store = new Map<string, unknown>([['forgejoToolkit.seenNotificationIds', { a: [1] }]]);
    const gate = makeGate(true);
    const { poller } = createPoller(gate.gate, store);

    poller.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(mockGetNotifications).toHaveBeenCalledTimes(1);

    // This window yields while the request is in flight.
    gate.set(false);
    resolveRequest(paged([notification(1), notification(2)]));
    await vi.advanceTimersByTimeAsync(0);

    // The round belongs to whoever started it. The successor's own immediate
    // round reads the baseline this one wrote and stays silent, so there is no
    // second alert for the same notification.
    expect(vscode.window.showInformationMessage).toHaveBeenCalledTimes(1);
    const seen = store.get('forgejoToolkit.seenNotificationIds') as Record<string, number[]>;
    expect(seen.a).toEqual([1, 2]);
    poller.dispose();
  });

  it('hands the seen baseline over on takeover: nothing re-reported, nothing dropped', async () => {
    // Two windows over one profile: the persisted baseline is shared (it is the
    // same `globalState` key), the in-memory state is not. The ownership rules
    // (`_ownedSeenInstanceIds`/`_mergeBaselineForWrite`) are untouched by stage
    // 2, and this is the property that depends on them: the window that takes
    // the lease over reads what the previous owner persisted.
    const shared = new Map<string, unknown>();
    const gateA = makeGate(true);
    const gateB = makeGate(false);
    mockGetNotifications.mockResolvedValue(paged([notification(1)]));
    const windowA = createPoller(gateA.gate, shared).poller;
    const windowB = createPoller(gateB.gate, shared).poller;

    windowA.start();
    windowB.start();
    await vi.advanceTimersByTimeAsync(0);
    // A (the owner) established the baseline and did not toast pre-existing
    // unread; B (the follower) never asked the server at all.
    expect(shared.get('forgejoToolkit.seenNotificationIds')).toEqual({ a: [1] });
    expect(mockGetNotifications).toHaveBeenCalledTimes(1);
    expect(vscode.window.showInformationMessage).not.toHaveBeenCalled();

    // A's window closes; B becomes the owner, polls immediately, and finds one
    // genuinely new notification next to the one it already knew about.
    mockGetNotifications.mockResolvedValue(paged([notification(1), notification(2)]));
    windowA.dispose();
    gateB.set(true);
    await vi.advanceTimersByTimeAsync(0);

    // Exactly one new notification: not zero (a drop) and not two (a re-report
    // of the baseline entry). The singular message distinguishes them, because
    // either way there is a single toast.
    expect(vscode.window.showInformationMessage).toHaveBeenCalledTimes(1);
    expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(
      'New notification from a@forgejo.example.com',
      'Open',
      'Mark all as read',
    );
    expect(shared.get('forgejoToolkit.seenNotificationIds')).toEqual({ a: [1, 2] });
    windowB.dispose();
  });

  it('reports the poll timing the diagnostics command carries', async () => {
    mockGetNotifications.mockResolvedValue(paged([]));
    const { poller } = createPoller(makeGate(true).gate);

    poller.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(typeof poller.pollingTiming().lastSuccessfulPollAt).toBe('number');
    expect(typeof poller.pollingTiming().nextScheduledPollAt).toBe('number');

    poller.stop();
    expect(poller.pollingTiming().nextScheduledPollAt).toBeUndefined();
    poller.dispose();
  });

  it('stops listening to the gate once it is disposed', async () => {
    const gate = makeGate(false);
    const { poller } = createPoller(gate.gate);
    poller.start();
    await vi.advanceTimersByTimeAsync(0);

    expect(gate.listeners()).toBe(1);
    poller.dispose();
    expect(gate.listeners()).toBe(0);

    mockGetNotifications.mockResolvedValue(paged([]));
    gate.set(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(mockGetNotifications).not.toHaveBeenCalled();
  });
});
