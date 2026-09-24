import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as vscode from 'vscode';
import type { ForgejoNotification } from '../../api/types';
import type { ForgejoInstance } from '@cpf23333-forgejo-toolkit/shared/webview/messages';

const mockGetNotifications = vi.fn<() => Promise<ForgejoNotification[]>>();
const mockMarkAllRead = vi.fn<() => Promise<void>>();

vi.mock('../../api/client', () => ({
  ForgejoClient: vi.fn().mockImplementation(function () {
    return {
      getNotifications: mockGetNotifications,
      markAllNotificationsRead: mockMarkAllRead,
    };
  }),
}));

import { NotificationPoller } from '../notificationPoller';

const instanceA: ForgejoInstance = {
  id: 'a',
  url: 'https://forgejo.example.com',
  token: 'token-a',
  name: 'a@forgejo.example.com',
  username: 'a',
};

const instanceB: ForgejoInstance = { ...instanceA, id: 'b', token: 'token-b', username: 'b' };

function notification(id: number): ForgejoNotification {
  return { id } as ForgejoNotification;
}

function createFakeConfig(
  instances: ForgejoInstance[],
  onInstancesChanged: (listener: () => void) => void = () => undefined,
) {
  return {
    getInstances: () => instances,
    isNotificationPollingEnabled: () => true,
    getNotificationPollingInterval: () => 300,
    onInstancesChanged: (listener: () => void) => {
      onInstancesChanged(listener);
      return { dispose: vi.fn() };
    },
  };
}

function createFakeContext() {
  const store = new Map<string, unknown>();
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

describe('NotificationPoller', () => {
  let sender: {
    pushNotifications: ReturnType<typeof vi.fn>;
    pushNotificationError: ReturnType<typeof vi.fn>;
    openNotifications: ReturnType<typeof vi.fn>;
  };
  const logger = { debug: vi.fn(), info: vi.fn(), error: vi.fn() };

  beforeEach(() => {
    vi.useFakeTimers();
    mockGetNotifications.mockReset();
    mockMarkAllRead.mockReset();
    mockMarkAllRead.mockResolvedValue(undefined);
    sender = { pushNotifications: vi.fn(), pushNotificationError: vi.fn(), openNotifications: vi.fn() };
    (vscode.window.showInformationMessage as ReturnType<typeof vi.fn>).mockReset();
    (vscode.window.showInformationMessage as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
    (vscode.window.showErrorMessage as ReturnType<typeof vi.fn>).mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function createPoller(config: ReturnType<typeof createFakeConfig>, context: ReturnType<typeof createFakeContext>) {
    return new NotificationPoller(config as never, sender as never, context as never, logger as never);
  }

  it('establishes a baseline on the first poll without toasting past notifications', async () => {
    mockGetNotifications.mockResolvedValue([notification(1), notification(2)]);
    const config = createFakeConfig([instanceA]);
    const context = createFakeContext();
    const poller = createPoller(config, context);

    poller.start();
    await vi.advanceTimersByTimeAsync(0);

    // The list is pushed to the webview (with the ids the poll examined), but no
    // toast for pre-existing unread.
    expect(sender.pushNotifications).toHaveBeenCalledWith('a', [notification(1), notification(2)], [1, 2]);
    expect(vscode.window.showInformationMessage).not.toHaveBeenCalled();

    // Baseline recorded.
    const seen = context.store.get('forgejoToolkit.seenNotificationIds') as Record<string, number[]>;
    expect(seen.a).toEqual([1, 2]);

    // Second poll with an additional notification toasts exactly once.
    mockGetNotifications.mockResolvedValue([notification(1), notification(2), notification(3)]);
    await vi.advanceTimersByTimeAsync(300_000);
    expect(vscode.window.showInformationMessage).toHaveBeenCalledTimes(1);

    poller.dispose();
  });

  it('does not schedule polls after dispose', async () => {
    mockGetNotifications.mockResolvedValue([]);
    const config = createFakeConfig([instanceA]);
    const context = createFakeContext();
    const poller = createPoller(config, context);

    poller.dispose();
    poller.start();
    await vi.advanceTimersByTimeAsync(600_000);
    expect(mockGetNotifications).not.toHaveBeenCalled();
  });

  it('stops scheduling after a restart following dispose', async () => {
    mockGetNotifications.mockResolvedValue([]);
    const config = createFakeConfig([instanceA]);
    const context = createFakeContext();
    const poller = createPoller(config, context);

    poller.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(mockGetNotifications).toHaveBeenCalledTimes(1);

    poller.dispose();
    poller.restart();
    await vi.advanceTimersByTimeAsync(600_000);
    expect(mockGetNotifications).toHaveBeenCalledTimes(1);
  });

  it('drops poll results for instances removed while the request was in flight', async () => {
    let resolveRequest: (notifications: ForgejoNotification[]) => void = () => undefined;
    mockGetNotifications.mockImplementation(
      () =>
        new Promise<ForgejoNotification[]>((resolve) => {
          resolveRequest = resolve;
        }),
    );
    const instances = [instanceA];
    const config = createFakeConfig(instances);
    const context = createFakeContext();
    const poller = createPoller(config, context);

    poller.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(mockGetNotifications).toHaveBeenCalledTimes(1);

    // The instance is removed before the response arrives.
    instances.length = 0;
    resolveRequest([notification(1)]);
    await vi.advanceTimersByTimeAsync(0);

    expect(sender.pushNotifications).not.toHaveBeenCalled();
    expect(vscode.window.showInformationMessage).not.toHaveBeenCalled();
    poller.dispose();
  });

  it('merges seen-id updates from concurrent polls of different instances', async () => {
    mockGetNotifications.mockResolvedValue([notification(7)]);
    const config = createFakeConfig([instanceA, instanceB]);
    const context = createFakeContext();
    const poller = createPoller(config, context);

    poller.start();
    await vi.advanceTimersByTimeAsync(0);

    const seen = context.store.get('forgejoToolkit.seenNotificationIds') as Record<string, number[]>;
    expect(seen.a).toEqual([7]);
    expect(seen.b).toEqual([7]);
    poller.dispose();
  });

  it('coalesces overlapping immediate poll rounds into a single round', async () => {
    let resolveRequests: (notifications: ForgejoNotification[]) => void = () => undefined;
    const pending = new Promise<ForgejoNotification[]>((resolve) => {
      resolveRequests = resolve;
    });
    mockGetNotifications.mockReturnValue(pending);

    let listener: (() => void) | undefined;
    const config = createFakeConfig([instanceA, instanceB], (l) => {
      listener = l;
    });
    const context = createFakeContext();
    // Both instances already have a persisted baseline, so the notification
    // returned by the round counts as new.
    context.store.set('forgejoToolkit.seenNotificationIds', { a: [1], b: [1] });
    const poller = createPoller(config, context);

    poller.start();
    await vi.advanceTimersByTimeAsync(0);
    // One request per instance in the first round.
    expect(mockGetNotifications).toHaveBeenCalledTimes(2);

    // Importing instances fires onInstancesChanged once per instance while the
    // first round is still in flight: each restart must join that round
    // instead of starting another burst of requests.
    listener!();
    listener!();
    await vi.advanceTimersByTimeAsync(0);
    expect(mockGetNotifications).toHaveBeenCalledTimes(2);

    // The overlapping restarts must not report the same notification again.
    resolveRequests([notification(1), notification(2)]);
    await vi.advanceTimersByTimeAsync(0);
    expect(vscode.window.showInformationMessage).toHaveBeenCalledTimes(1);

    // Once the round settles, a scheduled tick polls normally again and finds
    // nothing new.
    await vi.advanceTimersByTimeAsync(300_000);
    expect(mockGetNotifications).toHaveBeenCalledTimes(4);
    expect(vscode.window.showInformationMessage).toHaveBeenCalledTimes(1);
    poller.dispose();
  });

  it('polls an instance added while a round is in flight as soon as that round settles', async () => {
    // A joined round only covers the instances it started with; without a
    // follow-up, an instance imported mid-round waits for the next interval
    // (five minutes by default) before it is polled at all.
    let resolveRequests: (notifications: ForgejoNotification[]) => void = () => undefined;
    mockGetNotifications.mockReturnValue(
      new Promise<ForgejoNotification[]>((resolve) => {
        resolveRequests = resolve;
      }),
    );
    const instances = [instanceA];
    let listener: (() => void) | undefined;
    const config = createFakeConfig(instances, (l) => {
      listener = l;
    });
    const poller = createPoller(config, createFakeContext());

    poller.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(mockGetNotifications).toHaveBeenCalledTimes(1);

    instances.push(instanceB);
    listener!();
    await vi.advanceTimersByTimeAsync(0);
    // The in-flight round cannot cover the new instance, so nothing new yet.
    expect(mockGetNotifications).toHaveBeenCalledTimes(1);

    resolveRequests([]);
    await vi.advanceTimersByTimeAsync(0);
    // The follow-up round polls both instances.
    expect(mockGetNotifications).toHaveBeenCalledTimes(3);
    poller.dispose();
  });

  it('does not report the same notification twice when a tick lands mid-round', async () => {
    let resolveFirst: (notifications: ForgejoNotification[]) => void = () => undefined;
    mockGetNotifications.mockImplementationOnce(
      () =>
        new Promise<ForgejoNotification[]>((resolve) => {
          resolveFirst = resolve;
        }),
    );
    mockGetNotifications.mockResolvedValue([notification(1), notification(2)]);
    const config = createFakeConfig([instanceA]);
    const context = createFakeContext();
    // A persisted baseline already contains notification 1.
    context.store.set('forgejoToolkit.seenNotificationIds', { a: [1] });
    const poller = createPoller(config, context);

    poller.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(mockGetNotifications).toHaveBeenCalledTimes(1);

    // The interval tick lands while the first round is still in flight: it
    // joins the round instead of issuing its own request.
    await vi.advanceTimersByTimeAsync(300_000);
    expect(mockGetNotifications).toHaveBeenCalledTimes(1);

    resolveFirst([notification(1), notification(2)]);
    await vi.advanceTimersByTimeAsync(0);
    expect(vscode.window.showInformationMessage).toHaveBeenCalledTimes(1);

    // The next tick polls again and finds nothing new: notification 2 was
    // recorded as seen by the round that reported it.
    await vi.advanceTimersByTimeAsync(300_000);
    expect(vscode.window.showInformationMessage).toHaveBeenCalledTimes(1);
    poller.dispose();
  });

  it('recovers from a legacy non-array seen-id payload without poisoning the write queue', async () => {
    mockGetNotifications.mockResolvedValue([notification(1)]);
    const config = createFakeConfig([instanceA]);
    const context = createFakeContext();
    // Legacy dirty data: an older version persisted a Set, which
    // JSON-serializes to {}.
    context.store.set('forgejoToolkit.seenNotificationIds', { a: {} });
    const poller = createPoller(config, context);

    poller.start();
    await vi.advanceTimersByTimeAsync(0);

    // The poll completes and rewrites the entry as a plain array.
    let seen = context.store.get('forgejoToolkit.seenNotificationIds') as Record<string, number[]>;
    expect(seen.a).toEqual([1]);
    expect(sender.pushNotifications).toHaveBeenCalledWith('a', [notification(1)], [1]);

    // The write queue survived: the next poll persists its update too.
    mockGetNotifications.mockResolvedValue([notification(1), notification(2)]);
    await vi.advanceTimersByTimeAsync(300_000);
    seen = context.store.get('forgejoToolkit.seenNotificationIds') as Record<string, number[]>;
    expect(seen.a).toEqual([1, 2]);
    poller.dispose();
  });

  it('aggregates one toast per poll round across instances with new notifications', async () => {
    mockGetNotifications.mockResolvedValue([notification(1)]);
    const config = createFakeConfig([instanceA, instanceB]);
    const context = createFakeContext();
    const poller = createPoller(config, context);

    // First round only establishes the baseline.
    poller.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(vscode.window.showInformationMessage).not.toHaveBeenCalled();

    // Both instances gain a new notification in the same round: a single
    // aggregated toast instead of one toast per instance.
    mockGetNotifications.mockResolvedValue([notification(1), notification(2)]);
    await vi.advanceTimersByTimeAsync(300_000);

    expect(vscode.window.showInformationMessage).toHaveBeenCalledTimes(1);
    const [message] = (vscode.window.showInformationMessage as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(message).toContain('across');
    poller.dispose();
  });

  it('keeps per-instance wording when only one instance has new notifications', async () => {
    mockGetNotifications.mockResolvedValue([notification(1)]);
    const config = createFakeConfig([instanceA]);
    const context = createFakeContext();
    const poller = createPoller(config, context);

    poller.start();
    await vi.advanceTimersByTimeAsync(0);

    mockGetNotifications.mockResolvedValue([notification(1), notification(2), notification(3)]);
    await vi.advanceTimersByTimeAsync(300_000);

    expect(vscode.window.showInformationMessage).toHaveBeenCalledTimes(1);
    const [message] = (vscode.window.showInformationMessage as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(message).toContain('from');
    poller.dispose();
  });

  it('reports a mark-all-read failure without touching the unread state or re-polling', async () => {
    mockGetNotifications.mockResolvedValue([notification(1)]);
    const config = createFakeConfig([instanceA]);
    const context = createFakeContext();
    const poller = createPoller(config, context);

    poller.start();
    await vi.advanceTimersByTimeAsync(0);

    // Second round: one new notification, the user picks "Mark all as read"
    // and the mark request itself fails.
    mockGetNotifications.mockResolvedValue([notification(1), notification(2)]);
    (vscode.window.showInformationMessage as ReturnType<typeof vi.fn>).mockResolvedValue('Mark all as read');
    mockMarkAllRead.mockRejectedValueOnce(new Error('boom'));
    await vi.advanceTimersByTimeAsync(300_000);

    expect(mockGetNotifications).toHaveBeenCalledTimes(2);
    expect(mockMarkAllRead).toHaveBeenCalledTimes(1);
    expect(vscode.window.showErrorMessage).toHaveBeenCalledTimes(1);
    const [errorMessage] = (vscode.window.showErrorMessage as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(errorMessage).toContain('Failed to mark notifications as read');
    // No refresh poll after a failed mark: the unread list stays as-is (there
    // is nothing to roll back because nothing was marked locally).
    expect(mockGetNotifications).toHaveBeenCalledTimes(2);
    poller.dispose();
  });

  it('does not report a refresh failure after a successful mark as a mark failure', async () => {
    mockGetNotifications.mockResolvedValue([notification(1)]);
    const config = createFakeConfig([instanceA]);
    const context = createFakeContext();
    const poller = createPoller(config, context);

    poller.start();
    await vi.advanceTimersByTimeAsync(0);

    // Second round: user picks "Mark all as read"; the mark succeeds but the
    // refresh poll fails.
    mockGetNotifications
      .mockResolvedValueOnce([notification(1), notification(2)])
      .mockRejectedValueOnce(new Error('refresh failed'))
      .mockResolvedValue([]);
    (vscode.window.showInformationMessage as ReturnType<typeof vi.fn>).mockResolvedValue('Mark all as read');
    await vi.advanceTimersByTimeAsync(300_000);

    expect(mockMarkAllRead).toHaveBeenCalledTimes(1);
    expect(vscode.window.showErrorMessage).not.toHaveBeenCalled();
    // The failure is surfaced to the notifications view instead.
    expect(sender.pushNotificationError).toHaveBeenCalledWith('a', expect.any(String));
    poller.dispose();
  });

  it('reports a row it examined and no longer finds unread as covered', async () => {
    // The poll asks the server for the unread+pinned set, so a page shorter than
    // the limit is the whole unread list: a row that was unread on the previous
    // poll and is absent now was examined and found read. The view can only clear
    // such a row when the host names it, because the row is not in the page.
    mockGetNotifications.mockResolvedValue([notification(1), notification(2)]);
    const config = createFakeConfig([instanceA]);
    const poller = createPoller(config, createFakeContext());

    poller.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(sender.pushNotifications).toHaveBeenLastCalledWith('a', [notification(1), notification(2)], [1, 2]);

    mockGetNotifications.mockResolvedValue([notification(1)]);
    await vi.advanceTimersByTimeAsync(300_000);
    expect(sender.pushNotifications).toHaveBeenLastCalledWith('a', [notification(1)], [1, 2]);

    poller.dispose();
  });

  it('reports the ids it marked read so an open view can clear them', async () => {
    // "Mark all as read" from the host toast has no webview command behind it,
    // and the refresh poll that follows comes back with an empty page. An empty
    // page alone says nothing about the rows a view is still showing, so the
    // poller has to name the ids it knows were marked.
    mockGetNotifications.mockResolvedValue([notification(1), notification(2)]);
    const config = createFakeConfig([instanceA]);
    const poller = createPoller(config, createFakeContext());

    poller.start();
    await vi.advanceTimersByTimeAsync(0);

    mockGetNotifications
      .mockResolvedValueOnce([notification(1), notification(2), notification(3)])
      .mockResolvedValue([]);
    (vscode.window.showInformationMessage as ReturnType<typeof vi.fn>).mockResolvedValue('Mark all as read');
    await vi.advanceTimersByTimeAsync(300_000);

    expect(mockMarkAllRead).toHaveBeenCalledTimes(1);
    expect(sender.pushNotifications).toHaveBeenCalledWith('a', [], [1, 2, 3]);
    poller.dispose();
  });
});
