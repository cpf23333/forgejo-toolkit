import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { nextTick } from 'vue';
import { createTestRouter, createTestI18n } from '../../__tests__/helpers/test-utils';
import { NOTIFICATION_REQUEST_MAX_AGE_MS } from '../../composables/useAppState';

let messageHandlers: Array<(event: MessageEvent) => void> = [];
let vscodeApiMock: {
  postMessage: ReturnType<typeof vi.fn>;
  getState: ReturnType<typeof vi.fn>;
  setState: ReturnType<typeof vi.fn>;
};

beforeEach(() => {
  messageHandlers = [];
  vscodeApiMock = {
    postMessage: vi.fn(),
    getState: vi.fn(() => undefined),
    setState: vi.fn(),
  };
  (window as unknown as { acquireVsCodeApi: () => typeof vscodeApiMock }).acquireVsCodeApi = () => vscodeApiMock;
  vi.spyOn(window, 'addEventListener').mockImplementation((type, listener) => {
    if (type === 'message') {
      messageHandlers.push(listener as (event: MessageEvent) => void);
    }
  });
});

afterEach(() => {
  messageHandlers = [];
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

function dispatchMessage(message: unknown) {
  const event = new MessageEvent('message', { data: message });
  messageHandlers.forEach((handler) => handler(event));
}

async function createState() {
  vi.resetModules();
  const mod = await import('../../composables/useAppState');
  const router = createTestRouter();
  const i18n = createTestI18n();
  const wrapper = mount(
    {
      template: '<div></div>',
      setup() {
        const state = mod.useAppState();
        return { state };
      },
    },
    { global: { plugins: [router, i18n] } },
  );
  await flushPromises();
  return { wrapper, state: wrapper.vm.state as ReturnType<typeof mod.useAppState>, mod };
}

const INSTANCE_A = {
  id: 'inst-a',
  url: 'https://forgejo.example.com/alpha',
  name: 'alpha-user@forgejo.example.com',
  username: 'alpha-user',
};

/** An instance the webview never configured, to tell the two apart in a page. */
const OTHER_INSTANCE_ID = 'inst-b';

function badgeRequests(): Array<Record<string, unknown>> {
  return vscodeApiMock.postMessage.mock.calls
    .map(([message]) => message as Record<string, unknown>)
    .filter((message) => message.command === 'getNotifications');
}

function cursorOfRequest(index: number): string {
  return vscodeApiMock.postMessage.mock.calls
    .map(([message]) => message as Record<string, unknown>)
    .filter((message) => message.command === 'getNotifications')[index].before as string;
}

/**
 * A page that could only have been fetched for a request this webview had to
 * abandon. `handleNotifications` used to accept it whenever the queue happened
 * to be empty — which is exactly the state a prune leaves behind — and wrote it
 * into the view slot as the current server's notifications.
 */
describe('a getNotifications page that answers a pruned request', () => {
  it('is dropped instead of filling the view slot', async () => {
    const { state, mod } = await createState();
    const notificationsKey = mod.notificationsKey;
    dispatchMessage({ command: 'instances', data: [INSTANCE_A] });
    await nextTick();
    state.loadNotifications(INSTANCE_A.id, ['unread', 'pinned']);
    const viewCursor = cursorOfRequest(0);

    // The reply outlives the queue's bound: the entry is pruned first (which is
    // what leaving the queue empty used to mean), and the cursor is remembered as
    // one this webview has stopped waiting for.
    vi.useFakeTimers();
    try {
      vi.setSystemTime(Date.now() + NOTIFICATION_REQUEST_MAX_AGE_MS + 1_000);
      dispatchMessage({
        command: 'notifications',
        instanceId: INSTANCE_A.id,
        notifications: [{ id: 99, unread: true }],
        before: viewCursor,
      });
      await nextTick();
    } finally {
      vi.useRealTimers();
    }

    // The page names a request that can never be answered, so it must not fill
    // the view slot it was addressed to — nor any other.
    expect(state.notifications.value.has(notificationsKey(INSTANCE_A.id))).toBe(false);
    expect(state.notifications.value.has(notificationsKey(OTHER_INSTANCE_ID))).toBe(false);
    expect(state.unreadViewNotificationCount.value).toBe(0);
  });

  it('still fills the view slot for a reply whose request is still queued', async () => {
    const { state, mod } = await createState();
    const notificationsKey = mod.notificationsKey;
    dispatchMessage({ command: 'instances', data: [INSTANCE_A] });
    await nextTick();
    state.loadNotifications(INSTANCE_A.id, ['unread', 'pinned']);
    const viewCursor = cursorOfRequest(0);

    dispatchMessage({
      command: 'notifications',
      instanceId: INSTANCE_A.id,
      notifications: [{ id: 1, unread: true }],
      before: viewCursor,
    });
    await nextTick();

    expect(state.notifications.value.get(notificationsKey(INSTANCE_A.id))?.map((entry) => entry.id)).toEqual([1]);
  });

  it('keeps reading an uncursored page from a host that mints no cursors', async () => {
    // The permissive reading is only for a cursor this webview never minted: the
    // change above would otherwise have dropped every page of a host that does
    // not echo the request's cursor.
    const { state, mod } = await createState();
    const notificationsKey = mod.notificationsKey;
    dispatchMessage({ command: 'instances', data: [INSTANCE_A] });
    await nextTick();

    dispatchMessage({
      command: 'notifications',
      instanceId: INSTANCE_A.id,
      notifications: [{ id: 1, unread: true }],
    });
    await nextTick();

    expect(state.notifications.value.get(notificationsKey(INSTANCE_A.id))?.map((entry) => entry.id)).toEqual([1]);
  });
});

/**
 * The badge is asked for once per instance while nothing has answered for it,
 * and its queue entry is what keeps the next request waiting. A request the host
 * never answers therefore left the bell empty for the rest of the session: the
 * entry is only pruned when something asks again, and the dashboard only asks on
 * mount, on activation and when the instance list changes — none of which happen
 * while the user stays on the dashboard.
 */
describe('badge recovery while the dashboard stays open', () => {
  /** Captures the timers armed with the queue's own bound. */
  function captureRecoveryTimers(): Array<() => void> {
    const callbacks: Array<() => void> = [];
    const original = window.setTimeout.bind(window);
    vi.spyOn(window, 'setTimeout').mockImplementation(((
      handler: TimerHandler,
      timeout?: number,
      ...rest: unknown[]
    ) => {
      if (timeout === NOTIFICATION_REQUEST_MAX_AGE_MS && typeof handler === 'function') {
        callbacks.push(handler as () => void);
      }
      return original(handler, timeout, ...(rest as []));
    }) as typeof window.setTimeout);
    return callbacks;
  }

  it('re-asks once the unanswered badge request outlives the queue bound', async () => {
    const { state } = await createState();
    dispatchMessage({ command: 'instances', data: [INSTANCE_A] });
    await nextTick();

    const recoveries = captureRecoveryTimers();
    await state.loadNotificationBadge(INSTANCE_A.id);
    expect(badgeRequests()).toHaveLength(1);
    expect(recoveries).toHaveLength(1);

    vi.useFakeTimers();
    try {
      vi.setSystemTime(Date.now() + NOTIFICATION_REQUEST_MAX_AGE_MS + 1_000);
      vscodeApiMock.postMessage.mockClear();
      // Nothing on the dashboard asks again — that is the whole problem. The
      // recovery armed with the request is what retires the stranded entry and
      // asks once more.
      recoveries[0]();
      await nextTick();
    } finally {
      vi.useRealTimers();
    }

    expect(badgeRequests()).toHaveLength(1);
  });

  it('does not arm a recovery for a badge request that is answered', async () => {
    const { state } = await createState();
    dispatchMessage({ command: 'instances', data: [INSTANCE_A] });
    await nextTick();

    const recoveries = captureRecoveryTimers();
    await state.loadNotificationBadge(INSTANCE_A.id);
    const badgeCursor = cursorOfRequest(badgeRequests().length - 1);
    dispatchMessage({
      command: 'notifications',
      instanceId: INSTANCE_A.id,
      notifications: [{ id: 1, unread: true }],
      before: badgeCursor,
    });
    await nextTick();
    expect(state.unreadNotificationCount.value).toBe(1);

    vi.useFakeTimers();
    try {
      vi.setSystemTime(Date.now() + NOTIFICATION_REQUEST_MAX_AGE_MS + 1_000);
      vscodeApiMock.postMessage.mockClear();
      // The reply that filled the badge retired the recovery armed with its
      // request, so the bound passing later asks for nothing: the badge was
      // filled from its own reply and needs no retry.
      expect(recoveries).toHaveLength(1);
      recoveries[0]();
      await nextTick();
      expect(badgeRequests()).toHaveLength(0);
      await state.loadNotificationBadge(INSTANCE_A.id);
    } finally {
      vi.useRealTimers();
    }

    expect(badgeRequests()).toHaveLength(0);
  });
});
