import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { nextTick } from 'vue';
import { createTestRouter, createTestI18n } from '../../__tests__/helpers/test-utils';

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
    {
      global: {
        plugins: [router, i18n],
      },
    },
  );
  await flushPromises();
  return { wrapper, state: wrapper.vm.state as ReturnType<typeof mod.useAppState>, mod };
}

type AppState = Awaited<ReturnType<typeof createState>>['state'];

const INSTANCE_A = {
  id: 'inst-a',
  url: 'https://forgejo.example.com/alpha',
  name: 'alpha-user@forgejo.example.com',
  username: 'alpha-user',
};

/** Requests the badge asks the host for. */
function badgeRequests(): Array<Record<string, unknown>> {
  return vscodeApiMock.postMessage.mock.calls
    .map(([message]) => message as Record<string, unknown>)
    .filter((message) => message.command === 'getNotifications');
}

/**
 * The cursor of every `getNotifications` request sent so far, in send order.
 * The host echoes the request's own `before` on its reply (see `viewProvider`'s
 * `getNotifications` case), which is the only per-request identity the reply
 * carries; a test plays the host by echoing it back.
 */
function cursorsSent(): string[] {
  return badgeRequests().map((message) => message.before as string);
}

/** Repoints the instance at another server while the requests above run. */
async function repointInstance() {
  dispatchMessage({
    command: 'instances',
    data: [{ ...INSTANCE_A, url: 'https://forgejo.example.com/beta' }],
  });
  await nextTick();
}

async function badgeInFlight(state: AppState) {
  dispatchMessage({ command: 'instances', data: [INSTANCE_A] });
  await nextTick();
  state.loadNotificationBadge(INSTANCE_A.id);
  vscodeApiMock.postMessage.mockClear();
  return state;
}

/**
 * The badge is filled by the reply to its own one-shot request, but the host's
 * `notifications` reply carries no request identity. The webview used to mark
 * the request with the bare instance id, so after an instance edit - the id
 * survives a URL or account change - the replaced server's late reply deleted
 * the marker the fresh request had set: its page filled the badge (or, landing
 * before the fresh request, filled it with the previous server's list for the
 * rest of the session).
 */
describe('useAppState notification badge request identity', () => {
  it('does not let a replaced instance own the reply of the request it was sent for', async () => {
    const { state, mod } = await createState();
    const notificationsKey = mod.notificationsKey;
    await badgeInFlight(state);

    // The user repoints the instance at another server while the request runs.
    dispatchMessage({
      command: 'instances',
      data: [{ ...INSTANCE_A, url: 'https://forgejo.example.com/beta' }],
    });
    await nextTick();
    // The dashboard asks again; the in-flight request still owns the marker, so
    // no second, indistinguishable request goes out.
    await state.loadNotificationBadge(INSTANCE_A.id);
    expect(badgeRequests()).toHaveLength(0);

    // The replaced server answers.
    dispatchMessage({ command: 'notifications', instanceId: INSTANCE_A.id, notifications: [{ id: 1, unread: true }] });
    await nextTick();

    // Its page must not fill the badge...
    expect(state.polledNotifications.value.has(INSTANCE_A.id)).toBe(false);
    // ...nor the notifications view, whose slot the identity change just
    // cleared: showing the replaced server's page there would present it as the
    // new server's notifications.
    expect(state.notifications.value.has(notificationsKey(INSTANCE_A.id))).toBe(false);
    expect(state.notificationsHasMore.value.has(notificationsKey(INSTANCE_A.id))).toBe(false);
    // ...and the badge is asked for again, for the server now configured.
    expect(badgeRequests()).toHaveLength(1);

    // The fresh reply is what fills it.
    dispatchMessage({
      command: 'notifications',
      instanceId: INSTANCE_A.id,
      notifications: [
        { id: 2, unread: true },
        { id: 3, unread: true },
      ],
    });
    await nextTick();

    expect(state.polledNotifications.value.get(INSTANCE_A.id)).toHaveLength(2);
    expect(state.unreadNotificationCount.value).toBe(2);
  });

  it('fills the badge from the reply of its own request', async () => {
    const { state } = await createState();
    await badgeInFlight(state);

    dispatchMessage({
      command: 'notifications',
      instanceId: INSTANCE_A.id,
      notifications: [{ id: 1, unread: true }],
    });
    await nextTick();

    expect(state.polledNotifications.value.get(INSTANCE_A.id)).toHaveLength(1);
    expect(state.unreadNotificationCount.value).toBe(1);
  });

  it('leaves the badge alone for a notifications reply it did not ask for', async () => {
    const { state } = await createState();
    dispatchMessage({ command: 'instances', data: [INSTANCE_A] });
    await nextTick();
    vscodeApiMock.postMessage.mockClear();

    // The notifications view's own filtered request, not the badge's.
    state.loadNotifications(INSTANCE_A.id, ['unread', 'pinned']);
    dispatchMessage({
      command: 'notifications',
      instanceId: INSTANCE_A.id,
      notifications: [{ id: 1, unread: true }],
    });
    await nextTick();

    expect(state.polledNotifications.value.has(INSTANCE_A.id)).toBe(false);
  });

  it('does not attribute a reply sent before the badge request to that request', async () => {
    // The interleaving the bare identity marker could not tell apart: the view's
    // own request is on the wire, the instance is repointed at another server
    // (which clears the loading slot but cannot cancel the request), and the
    // dashboard then asks for the badge. Two `notifications` requests are in
    // flight, and the host's reply carries no request id.
    const { state, mod } = await createState();
    const notificationsKey = mod.notificationsKey;
    dispatchMessage({ command: 'instances', data: [INSTANCE_A] });
    await nextTick();

    state.loadNotifications(INSTANCE_A.id, ['unread', 'pinned']);
    dispatchMessage({
      command: 'instances',
      data: [{ ...INSTANCE_A, url: 'https://forgejo.example.com/beta' }],
    });
    await nextTick();
    // Only the badge's own request is counted from here.
    vscodeApiMock.postMessage.mockClear();

    await state.loadNotificationBadge(INSTANCE_A.id);
    expect(badgeRequests()).toHaveLength(1);

    // The replaced server answers the *older* request first. Its page belongs to
    // the request that was sent before the badge request, so it must not fill the
    // badge: doing so took the fresh marker and left the badge request's own
    // reply to be written into the view slot instead.
    dispatchMessage({
      command: 'notifications',
      instanceId: INSTANCE_A.id,
      notifications: [{ id: 1, unread: true }],
    });
    await nextTick();

    expect(state.polledNotifications.value.has(INSTANCE_A.id)).toBe(false);
    expect(state.notifications.value.has(notificationsKey(INSTANCE_A.id))).toBe(false);

    // The badge request's own reply fills it, for the server now configured.
    dispatchMessage({
      command: 'notifications',
      instanceId: INSTANCE_A.id,
      notifications: [
        { id: 2, unread: true },
        { id: 3, unread: true },
      ],
    });
    await nextTick();

    expect(state.polledNotifications.value.get(INSTANCE_A.id)?.map((entry) => entry.id)).toEqual([2, 3]);
    expect(state.unreadNotificationCount.value).toBe(2);
  });

  it('attributes a reply by the cursor the host echoes, whatever order it lands in', async () => {
    // The real host echoes the request's own cursor, and it dispatches
    // concurrently: the request sent after the edit can be answered before the
    // one sent for the replaced server. Attribution by arrival order read the
    // newer server's page as the older request's and then let the replaced
    // server's page fill the badge and the view; matching the echoed cursor
    // attributes each reply to the request it actually answers.
    const { state, mod } = await createState();
    const notificationsKey = mod.notificationsKey;
    dispatchMessage({ command: 'instances', data: [INSTANCE_A] });
    await nextTick();

    state.loadNotifications(INSTANCE_A.id, ['unread', 'pinned']);
    const viewCursor = cursorsSent()[0];
    await repointInstance();

    await state.loadNotificationBadge(INSTANCE_A.id);
    const badgeCursor = cursorsSent().at(-1) as string;
    expect(badgeCursor).not.toBe(viewCursor);

    // The server now configured answers the badge request first...
    dispatchMessage({
      command: 'notifications',
      instanceId: INSTANCE_A.id,
      notifications: [
        { id: 2, unread: true },
        { id: 3, unread: true },
      ],
      before: badgeCursor,
    });
    await nextTick();

    // ...so its page is the badge's, not the older request's.
    expect(state.polledNotifications.value.get(INSTANCE_A.id)?.map((entry) => entry.id)).toEqual([2, 3]);

    // The replaced server answers the request sent before the edit, last.
    dispatchMessage({
      command: 'notifications',
      instanceId: INSTANCE_A.id,
      notifications: [{ id: 1, unread: true }],
      before: viewCursor,
    });
    await nextTick();

    // Its page must fill neither the badge...
    expect(state.polledNotifications.value.get(INSTANCE_A.id)?.map((entry) => entry.id)).toEqual([2, 3]);
    expect(state.unreadNotificationCount.value).toBe(2);
    // ...nor the view, which holds the page of the server now configured.
    expect(state.notifications.value.get(notificationsKey(INSTANCE_A.id))?.map((entry) => entry.id)).toEqual([2, 3]);
  });

  it('fills the badge from a cursor-carrying reply to its own request', async () => {
    // The badge request is a first page, but it is sent with a cursor of its own
    // (see notificationRequestCursor) so the reply can be attributed; that must
    // not make handleNotifications read it as a "load more" reply.
    const { state, mod } = await createState();
    const notificationsKey = mod.notificationsKey;
    dispatchMessage({ command: 'instances', data: [INSTANCE_A] });
    await nextTick();

    state.loadNotifications(INSTANCE_A.id, ['unread', 'pinned']);
    const viewCursor = cursorsSent()[0];
    await repointInstance();

    // The replaced server answers its own request first; its page must not fill
    // the view, which the identity change has just cleared.
    dispatchMessage({
      command: 'notifications',
      instanceId: INSTANCE_A.id,
      notifications: [{ id: 1, unread: true }],
      before: viewCursor,
    });
    await nextTick();
    expect(state.notifications.value.has(notificationsKey(INSTANCE_A.id))).toBe(false);

    await state.loadNotificationBadge(INSTANCE_A.id);
    dispatchMessage({
      command: 'notifications',
      instanceId: INSTANCE_A.id,
      notifications: [
        { id: 2, unread: true },
        { id: 3, unread: true },
      ],
      before: cursorsSent().at(-1) as string,
    });
    await nextTick();

    expect(state.polledNotifications.value.get(INSTANCE_A.id)?.map((entry) => entry.id)).toEqual([2, 3]);
    expect(state.unreadNotificationCount.value).toBe(2);
  });

  it('appends a load-more reply matched by its own cursor', async () => {
    const { state, mod } = await createState();
    const key = mod.notificationsKey(INSTANCE_A.id);
    dispatchMessage({ command: 'instances', data: [INSTANCE_A] });
    await nextTick();

    state.loadNotifications(INSTANCE_A.id, ['unread', 'pinned']);
    dispatchMessage({
      command: 'notifications',
      instanceId: INSTANCE_A.id,
      notifications: [{ id: 1, unread: true }],
      before: cursorsSent()[0],
    });
    await nextTick();

    const cursor = '2026-09-20T11:59:00.000Z';
    state.loadNotifications(INSTANCE_A.id, ['unread', 'pinned'], undefined, cursor);
    dispatchMessage({
      command: 'notifications',
      instanceId: INSTANCE_A.id,
      notifications: [{ id: 2, unread: true }],
      before: cursor,
    });
    await nextTick();

    expect(state.notifications.value.get(key)?.map((entry) => entry.id)).toEqual([1, 2]);
  });

  it('attributes a failure reply to the request of the server now configured, not the replaced one', async () => {
    // The failure reply echoes no cursor at all (`viewProvider`'s
    // `getNotifications` catch), so position was the only evidence left and the
    // oldest queued entry claimed it. With the replaced server's view request
    // (A) still queued in front of the badge request (B), B's failure popped A:
    // A's own, cursor-carrying reply then matched nothing and fell through to B,
    // whose identity was current — so the replaced server's page filled the view
    // list *and* the badge, while B's entry stayed queued with no reply to free
    // it, blocking every later badge request.
    const { state, mod } = await createState();
    const notificationsKey = mod.notificationsKey;
    dispatchMessage({ command: 'instances', data: [INSTANCE_A] });
    await nextTick();

    // A: the view's request, for the server about to be replaced.
    state.loadNotifications(INSTANCE_A.id, ['unread', 'pinned']);
    const viewCursor = cursorsSent()[0];
    await repointInstance();
    // B: the badge's request, for the server now configured. Only it is counted
    // from here.
    vscodeApiMock.postMessage.mockClear();
    await state.loadNotificationBadge(INSTANCE_A.id);
    expect(badgeRequests()).toHaveLength(1);

    // B fails. The reply names no request, so it can only belong to an entry
    // sent for the identity still configured — B.
    dispatchMessage({ command: 'notifications', instanceId: INSTANCE_A.id, error: 'instance unreachable' });
    await nextTick();
    expect(state.errors.get(notificationsKey(INSTANCE_A.id))).toBe('instance unreachable');

    // The replaced server then answers A, whose cursor names it.
    dispatchMessage({
      command: 'notifications',
      instanceId: INSTANCE_A.id,
      notifications: [{ id: 1, unread: true }],
      before: viewCursor,
    });
    await nextTick();

    // Its page may fill neither the badge...
    expect(state.polledNotifications.value.has(INSTANCE_A.id)).toBe(false);
    expect(state.unreadNotificationCount.value).toBe(0);
    // ...nor the view.
    expect(state.notifications.value.has(notificationsKey(INSTANCE_A.id))).toBe(false);
    expect(state.notificationsHasMore.value.has(notificationsKey(INSTANCE_A.id))).toBe(false);

    // B's entry was the one the failure popped, so the badge can be asked for
    // again instead of being blocked for the rest of the session.
    vscodeApiMock.postMessage.mockClear();
    await state.loadNotificationBadge(INSTANCE_A.id);
    expect(badgeRequests()).toHaveLength(1);
  });

  it('lets a badge request go out once an unanswered one outlives the queue bound', async () => {
    // A request the host never answers keeps its entry — and, for the badge,
    // keeps every later badge request waiting. The entry expires so the badge
    // cannot be stuck for the rest of the session.
    const { state } = await createState();
    dispatchMessage({ command: 'instances', data: [INSTANCE_A] });
    await nextTick();
    state.loadNotificationBadge(INSTANCE_A.id);
    expect(badgeRequests()).toHaveLength(1);

    vi.useFakeTimers();
    try {
      vi.setSystemTime(Date.now() + 121_000);
      vscodeApiMock.postMessage.mockClear();
      await state.loadNotificationBadge(INSTANCE_A.id);
      expect(badgeRequests()).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
