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
});
