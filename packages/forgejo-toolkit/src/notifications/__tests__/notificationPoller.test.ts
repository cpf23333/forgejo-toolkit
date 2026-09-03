import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as vscode from 'vscode';
import type { ForgejoNotification } from '../../api/types';
import type { ForgejoInstance } from '@cpf23333-forgejo-toolkit/shared/webview/messages';

const mockGetNotifications = vi.fn<() => Promise<ForgejoNotification[]>>();

vi.mock('../../api/client', () => ({
  ForgejoClient: vi.fn().mockImplementation(function () {
    return {
      getNotifications: mockGetNotifications,
      markAllNotificationsRead: vi.fn(),
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

function createFakeConfig(instances: ForgejoInstance[]) {
  return {
    getInstances: () => instances,
    isNotificationPollingEnabled: () => true,
    getNotificationPollingInterval: () => 300,
    onInstancesChanged: () => ({ dispose: vi.fn() }),
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
  let sender: { pushNotifications: ReturnType<typeof vi.fn>; openNotifications: ReturnType<typeof vi.fn> };
  const logger = { debug: vi.fn(), info: vi.fn(), error: vi.fn() };

  beforeEach(() => {
    vi.useFakeTimers();
    mockGetNotifications.mockReset();
    sender = { pushNotifications: vi.fn(), openNotifications: vi.fn() };
    (vscode.window.showInformationMessage as ReturnType<typeof vi.fn>).mockReset();
    (vscode.window.showInformationMessage as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
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

    // The list is pushed to the webview, but no toast for pre-existing unread.
    expect(sender.pushNotifications).toHaveBeenCalledWith('a', [notification(1), notification(2)]);
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
    expect(sender.pushNotifications).toHaveBeenCalledWith('a', [notification(1)]);

    // The write queue survived: the next poll persists its update too.
    mockGetNotifications.mockResolvedValue([notification(1), notification(2)]);
    await vi.advanceTimersByTimeAsync(300_000);
    seen = context.store.get('forgejoToolkit.seenNotificationIds') as Record<string, number[]>;
    expect(seen.a).toEqual([1, 2]);
    poller.dispose();
  });
});
