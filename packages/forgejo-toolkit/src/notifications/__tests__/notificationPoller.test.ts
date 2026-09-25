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

  it('logs instead of crashing when the toast action handler throws', async () => {
    // openNotifications runs synchronously inside the toast's .then callback; a
    // throw there used to surface as an unhandled rejection.
    mockGetNotifications.mockResolvedValue([notification(1)]);
    const config = createFakeConfig([instanceA]);
    const context = createFakeContext();
    const poller = createPoller(config, context);

    poller.start();
    await vi.advanceTimersByTimeAsync(0);

    mockGetNotifications.mockResolvedValue([notification(1), notification(2)]);
    (vscode.window.showInformationMessage as ReturnType<typeof vi.fn>).mockResolvedValue('Open');
    sender.openNotifications.mockImplementation(() => {
      throw new Error('view gone');
    });
    await vi.advanceTimersByTimeAsync(300_000);

    expect(sender.openNotifications).toHaveBeenCalledTimes(1);
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('view gone'));
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

  it('reports a row whose absence an empty page proves as covered', async () => {
    // An empty page is the one page that proves the poll saw the whole unread
    // set, so a row that was unread on the previous poll and is absent now was
    // examined and found read. The view can only clear such a row when the host
    // names it, because the row is not in the page.
    mockGetNotifications.mockResolvedValue([notification(1), notification(2)]);
    const config = createFakeConfig([instanceA]);
    const poller = createPoller(config, createFakeContext());

    poller.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(sender.pushNotifications).toHaveBeenLastCalledWith('a', [notification(1), notification(2)], [1, 2]);

    mockGetNotifications.mockResolvedValue([]);
    await vi.advanceTimersByTimeAsync(300_000);
    expect(sender.pushNotifications).toHaveBeenLastCalledWith('a', [], [1, 2]);

    poller.dispose();
  });

  it('drops a poll reply that was in flight when the view was cleared', async () => {
    // The webview clears the badge and marks the covered rows read on the mark
    // reply. A poll that was already in flight read the unread list *before*
    // that mark, so pushing its reply afterwards rewrites the badge slot and
    // re-flags every cleared row as unread until the next interval.
    mockGetNotifications.mockResolvedValue([notification(1), notification(2)]);
    const config = createFakeConfig([instanceA]);
    const poller = createPoller(config, createFakeContext());
    const internals = poller as unknown as {
      _pollInstance(instance: ForgejoInstance): Promise<unknown>;
      _markAllRead(instance: ForgejoInstance): Promise<void>;
    };

    poller.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(sender.pushNotifications).toHaveBeenLastCalledWith('a', [notification(1), notification(2)], [1, 2]);

    // A poll is in flight (its reply is held open) when the mark lands.
    let finishStalePoll!: () => void;
    mockGetNotifications
      .mockImplementationOnce(
        () =>
          new Promise<ForgejoNotification[]>((resolve) => {
            finishStalePoll = () => resolve([notification(1), notification(2), notification(3)]);
          }),
      )
      // The refresh poll that follows the mark sees what is still unread.
      .mockResolvedValue([notification(3), notification(4)]);
    const stalePoll = internals._pollInstance(instanceA);
    expect(typeof finishStalePoll).toBe('function');
    await internals._markAllRead(instanceA);
    // The stale reply only lands now, after the clear.
    finishStalePoll();
    await stalePoll;

    // The clear push, then the post-mark refresh: the stale reply is dropped.
    expect(sender.pushNotifications).toHaveBeenCalledWith('a', [], [1, 2]);
    expect(sender.pushNotifications).toHaveBeenLastCalledWith('a', [notification(3), notification(4)], [3, 4]);
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

  it('covers every known id when the page comes back empty', async () => {
    // An empty page is the one page that provably is the whole unread+pinned
    // set: everything this poller saw unread before is gone from it, so the view
    // may clear all of those rows.
    mockGetNotifications.mockResolvedValue([notification(1), notification(2), notification(3)]);
    const config = createFakeConfig([instanceA]);
    const poller = createPoller(config, createFakeContext());

    poller.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(sender.pushNotifications).toHaveBeenLastCalledWith('a', [1, 2, 3].map(notification), [1, 2, 3]);
    mockGetNotifications.mockResolvedValue([]);
    await vi.advanceTimersByTimeAsync(300_000);

    expect(sender.pushNotifications).toHaveBeenLastCalledWith('a', [], [1, 2, 3]);
    poller.dispose();
  });

  it('does not cover a previously seen id absent from a short page that is not the whole set', async () => {
    // Forgejo silently clamps a `limit` above its own cap, so a page shorter
    // than the poller's 50 can still be a truncated one. Unioning the previously
    // seen ids in on that evidence marked rows read that the poll never examined
    // — they were simply past the server's cap.
    mockGetNotifications.mockResolvedValue([notification(1), notification(2)]);
    const config = createFakeConfig([instanceA]);
    const poller = createPoller(config, createFakeContext());

    poller.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(sender.pushNotifications).toHaveBeenLastCalledWith('a', [notification(1), notification(2)], [1, 2]);

    // A clamped page: two rows, one of which was already known unread; id 2 is
    // absent but may only be past the cap, so it must stay uncovered.
    mockGetNotifications.mockResolvedValue([notification(1), notification(3)]);
    await vi.advanceTimersByTimeAsync(300_000);

    expect(sender.pushNotifications).toHaveBeenLastCalledWith('a', [notification(1), notification(3)], [1, 3]);
    poller.dispose();
  });

  it('covers only the returned ids when the page fills the limit', async () => {
    // A full page may have been truncated (a newly arrived notification pushes
    // older rows off it), so absence proves nothing there either.
    const fullPage = Array.from({ length: 50 }, (_, index) => notification(index + 1));
    mockGetNotifications.mockResolvedValue(fullPage);
    const config = createFakeConfig([instanceA]);
    const poller = createPoller(config, createFakeContext());

    poller.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(sender.pushNotifications).toHaveBeenLastCalledWith(
      'a',
      fullPage,
      fullPage.map((row) => row.id),
    );

    // The next page is full again and drops the oldest rows: they stay uncovered.
    const nextPage = Array.from({ length: 50 }, (_, index) => notification(index + 6));
    mockGetNotifications.mockResolvedValue(nextPage);
    await vi.advanceTimersByTimeAsync(300_000);

    expect(sender.pushNotifications).toHaveBeenLastCalledWith(
      'a',
      nextPage,
      nextPage.map((row) => row.id),
    );
    poller.dispose();
  });

  it('does not run a follow-up round for an instance added mid-round once stopped', async () => {
    // A joined round only covers the instances it started with, so an instance
    // added mid-round schedules one follow-up round. After `stop()` the poller
    // is off: the in-flight round settling must not start polling again.
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
    poller.stop();

    resolveRequests([]);
    await vi.advanceTimersByTimeAsync(0);
    // No follow-up round for the added instance: the poller was stopped.
    expect(mockGetNotifications).toHaveBeenCalledTimes(1);
    poller.dispose();
  });

  it('does not re-report notifications as new while the seen-id write keeps failing', async () => {
    // When the baseline cannot be persisted (e.g. a read-only state store), the
    // persisted map stays one round behind. Reading it again on the next poll
    // used to report the same notifications as new on every single round.
    mockGetNotifications.mockResolvedValue([notification(1), notification(2)]);
    const config = createFakeConfig([instanceA]);
    const context = createFakeContext();
    // A baseline exists, so notification 2 counts as new on the first poll.
    context.store.set('forgejoToolkit.seenNotificationIds', { a: [1] });
    context.globalState.update = async () => {
      throw new Error('state store is read-only');
    };
    const poller = createPoller(config, context);

    poller.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(vscode.window.showInformationMessage).toHaveBeenCalledTimes(1);

    // The write keeps failing, but the in-memory baseline stands in: no
    // repeated toast for the same notifications.
    await vi.advanceTimersByTimeAsync(300_000);
    await vi.advanceTimersByTimeAsync(300_000);
    expect(vscode.window.showInformationMessage).toHaveBeenCalledTimes(1);
    poller.dispose();
  });

  it('persists the in-memory baseline once the seen-id write recovers', async () => {
    mockGetNotifications.mockResolvedValue([notification(1), notification(2)]);
    const config = createFakeConfig([instanceA]);
    const context = createFakeContext();
    context.store.set('forgejoToolkit.seenNotificationIds', { a: [1] });
    let failWrites = true;
    context.globalState.update = async (key: string, value: unknown) => {
      if (failWrites) {
        throw new Error('state store is read-only');
      }
      context.store.set(key, value);
    };
    const poller = createPoller(config, context);

    poller.start();
    await vi.advanceTimersByTimeAsync(0);
    // Baseline [1, 2] exists only in memory; nothing is persisted.
    expect(context.store.get('forgejoToolkit.seenNotificationIds')).toEqual({ a: [1] });

    // The write recovers: the next reconcile persists the whole map again,
    // including the rounds that only lived in memory.
    failWrites = false;
    mockGetNotifications.mockResolvedValue([notification(1), notification(2), notification(3)]);
    await vi.advanceTimersByTimeAsync(300_000);

    // Notification 3 is reported as new (exactly once; notification 2 was
    // already toasted by the first round), and the whole baseline — including
    // the round that only lived in memory — is persisted now.
    expect(vscode.window.showInformationMessage).toHaveBeenCalledTimes(2);
    const seen = context.store.get('forgejoToolkit.seenNotificationIds') as Record<string, number[]>;
    expect(seen.a).toEqual([1, 2, 3]);
    poller.dispose();
  });

  it('does not run a follow-up round when polling was disabled while a round was in flight', async () => {
    // start() must not mark the poller started when polling is disabled:
    // `_started` also gates the follow-up round that an in-flight round owes a
    // newly added instance, and a disabled poller that still carried the flag
    // would poll once more when the in-flight round settles.
    let resolveRequests: (notifications: ForgejoNotification[]) => void = () => undefined;
    mockGetNotifications.mockReturnValue(
      new Promise<ForgejoNotification[]>((resolve) => {
        resolveRequests = resolve;
      }),
    );
    const instances = [instanceA];
    let listener: (() => void) | undefined;
    let pollingEnabled = true;
    const config = createFakeConfig(instances, (l) => {
      listener = l;
    });
    config.isNotificationPollingEnabled = () => pollingEnabled;
    const poller = createPoller(config, createFakeContext());

    poller.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(mockGetNotifications).toHaveBeenCalledTimes(1);

    // An instance is added mid-round: the restart joins the in-flight round and
    // owes a follow-up for the instance it cannot cover.
    instances.push(instanceB);
    listener!();
    await vi.advanceTimersByTimeAsync(0);
    expect(mockGetNotifications).toHaveBeenCalledTimes(1);

    // Polling is then disabled; the config change restarts the poller.
    pollingEnabled = false;
    listener!();

    resolveRequests([]);
    await vi.advanceTimersByTimeAsync(0);
    // The poller is off: settling the in-flight round must not start the
    // follow-up round for the added instance.
    expect(mockGetNotifications).toHaveBeenCalledTimes(1);
    poller.dispose();
  });

  it('does not toast new notifications from a round that was in flight when the poller stopped', async () => {
    let resolveRequests: (notifications: ForgejoNotification[]) => void = () => undefined;
    mockGetNotifications.mockReturnValue(
      new Promise<ForgejoNotification[]>((resolve) => {
        resolveRequests = resolve;
      }),
    );
    const config = createFakeConfig([instanceA]);
    const context = createFakeContext();
    // A persisted baseline, so the polled notification counts as new.
    context.store.set('forgejoToolkit.seenNotificationIds', { a: [1] });
    const poller = createPoller(config, context);

    poller.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(mockGetNotifications).toHaveBeenCalledTimes(1);

    // The round is still in flight when the poller is stopped (polling disabled
    // or the extension shutting down): its findings must not toast afterwards.
    poller.stop();
    resolveRequests([notification(1), notification(2)]);
    await vi.advanceTimersByTimeAsync(0);

    expect(vscode.window.showInformationMessage).not.toHaveBeenCalled();
    poller.dispose();
  });
});
