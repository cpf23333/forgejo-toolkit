import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { nextTick } from 'vue';
import { createTestRouter, createTestI18n } from '../../__tests__/helpers/test-utils';
import { NOTIFICATIONS_LIMIT } from '../../composables/useAppState';

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
  return { wrapper, state: wrapper.vm.state as ReturnType<typeof mod.useAppState> };
}

function notification(id: number, unread: boolean) {
  return { id, unread, subject: { title: `Notification ${id}` } };
}

/**
 * The poller pushes the server's unread list into its own slot, which the
 * activity-bar badge reads; the open Notifications view renders a different
 * slot written only by `getNotifications` replies. Marking everything read from
 * the host toast (a path with no webview command behind it) updated the badge
 * but left the view showing rows that were read, so the two disagreed on
 * screen. The poller's reply is a page, so only a row it actually examined may
 * be marked read.
 */
describe('useAppState poller/view notification reconciliation', () => {
  it('marks a view row read when the poller examined it and no longer reports it unread', async () => {
    const { state } = await createState();
    state.instances.value = [{ id: 'inst-1', url: 'https://forgejo.example.com', name: 'a', username: 'user-a' }];
    dispatchMessage({ command: 'notifications', instanceId: 'inst-1', notifications: [notification(1, true)] });
    await nextTick();
    expect(state.unreadViewNotificationCount.value).toBe(1);

    // The poller fetched its unread page and row 1 was not in it: "mark all as
    // read" ran. The host names the row it examined with `coveredIds`.
    dispatchMessage({ command: 'polledNotifications', instanceId: 'inst-1', notifications: [], coveredIds: [1] });
    await nextTick();

    expect(state.unreadViewNotificationCount.value).toBe(0);
    expect(state.notifications.value.get('inst-1:notifications')?.[0].unread).toBe(false);
  });

  it('does not mark a row read when the poller never examined it', async () => {
    const { state } = await createState();
    state.instances.value = [{ id: 'inst-1', url: 'https://forgejo.example.com', name: 'a', username: 'user-a' }];
    // A view row that is outside the page the poller fetched next.
    dispatchMessage({ command: 'notifications', instanceId: 'inst-1', notifications: [notification(7, true)] });
    await nextTick();

    dispatchMessage({
      command: 'polledNotifications',
      instanceId: 'inst-1',
      notifications: [notification(1, true)],
      coveredIds: [1],
    });
    await nextTick();

    expect(state.notifications.value.get('inst-1:notifications')?.[0].unread).toBe(true);
    expect(state.unreadViewNotificationCount.value).toBe(1);
  });

  it('marks a view notification unread again when a later poll reports it', async () => {
    const { state } = await createState();
    state.instances.value = [{ id: 'inst-1', url: 'https://forgejo.example.com', name: 'a', username: 'user-a' }];
    dispatchMessage({ command: 'notifications', instanceId: 'inst-1', notifications: [notification(1, false)] });
    await nextTick();
    expect(state.unreadViewNotificationCount.value).toBe(0);

    dispatchMessage({ command: 'polledNotifications', instanceId: 'inst-1', notifications: [notification(1, true)] });
    await nextTick();

    expect(state.unreadViewNotificationCount.value).toBe(1);
    expect(state.notifications.value.get('inst-1:notifications')?.[0].unread).toBe(true);
  });

  it('leaves the view list alone when no poller push was received', async () => {
    const { state } = await createState();
    state.instances.value = [{ id: 'inst-1', url: 'https://forgejo.example.com', name: 'a', username: 'user-a' }];
    dispatchMessage({ command: 'notifications', instanceId: 'inst-1', notifications: [notification(1, true)] });
    await nextTick();

    // An error push carries no list and must not clear or rewrite the view.
    dispatchMessage({ command: 'polledNotifications', instanceId: 'inst-1', error: 'token expired' });
    await nextTick();

    expect(state.unreadViewNotificationCount.value).toBe(1);
    expect(state.notifications.value.get('inst-1:notifications')?.[0].unread).toBe(true);
  });
});

/**
 * The poller's request is a page: the host clamps it to its own limit (50) and
 * the endpoint reports no total. A row that fell outside that page was never
 * examined, so its absence is not evidence that it is read — treating it as read
 * hides unread traffic from the view. Only a row the poller actually examined
 * (and did not report unread) may be marked read; the host can name those rows
 * explicitly with `coveredIds`.
 */
describe('useAppState notification reconciliation with a capped poll page', () => {
  const LIMIT = NOTIFICATIONS_LIMIT;

  /** A poll page of `count` unread notifications. */
  function page(count: number) {
    return Array.from({ length: count }, (_, i) => notification(i + 1, true));
  }

  it('does not mark a view row read when the poll page was full', async () => {
    const { state } = await createState();
    state.instances.value = [{ id: 'inst-1', url: 'https://forgejo.example.com', name: 'a', username: 'user-a' }];
    // The view holds more rows than one poll page: the last one is beyond it.
    dispatchMessage({ command: 'notifications', instanceId: 'inst-1', notifications: page(LIMIT + 1) });
    await nextTick();
    expect(state.unreadViewNotificationCount.value).toBe(LIMIT + 1);

    dispatchMessage({ command: 'polledNotifications', instanceId: 'inst-1', notifications: page(LIMIT) });
    await nextTick();

    const list = state.notifications.value.get('inst-1:notifications') ?? [];
    expect(list[LIMIT].unread).toBe(true);
    expect(state.unreadViewNotificationCount.value).toBe(LIMIT + 1);
  });

  it('marks only the ids the host reports as covered', async () => {
    const { state } = await createState();
    state.instances.value = [{ id: 'inst-1', url: 'https://forgejo.example.com', name: 'a', username: 'user-a' }];
    dispatchMessage({ command: 'notifications', instanceId: 'inst-1', notifications: page(3) });
    await nextTick();
    expect(state.unreadViewNotificationCount.value).toBe(3);

    // The poll examined ids 1 and 2; id 2 came back read, id 3 was not examined.
    dispatchMessage({
      command: 'polledNotifications',
      instanceId: 'inst-1',
      notifications: [notification(1, true)],
      coveredIds: [1, 2],
    });
    await nextTick();

    const list = state.notifications.value.get('inst-1:notifications') ?? [];
    expect(list[0].unread).toBe(true);
    expect(list[1].unread).toBe(false);
    // Not covered: the poller never looked at it, so its state is unknown.
    expect(list[2].unread).toBe(true);
    expect(state.unreadViewNotificationCount.value).toBe(2);
  });

  it('marks every covered row read when the host reports an empty unread page', async () => {
    const { state } = await createState();
    state.instances.value = [{ id: 'inst-1', url: 'https://forgejo.example.com', name: 'a', username: 'user-a' }];
    dispatchMessage({ command: 'notifications', instanceId: 'inst-1', notifications: page(2) });
    await nextTick();

    // "Mark all as read" ran and the poller came back empty, having examined
    // both rows.
    dispatchMessage({ command: 'polledNotifications', instanceId: 'inst-1', notifications: [], coveredIds: [1, 2] });
    await nextTick();

    expect(state.unreadViewNotificationCount.value).toBe(0);
  });

  it('marks nothing when a full page arrives without a coverage report', async () => {
    const { state } = await createState();
    state.instances.value = [{ id: 'inst-1', url: 'https://forgejo.example.com', name: 'a', username: 'user-a' }];
    dispatchMessage({ command: 'notifications', instanceId: 'inst-1', notifications: [notification(60, true)] });
    await nextTick();

    dispatchMessage({ command: 'polledNotifications', instanceId: 'inst-1', notifications: page(LIMIT) });
    await nextTick();

    expect(state.notifications.value.get('inst-1:notifications')?.[0].unread).toBe(true);
  });
});

/**
 * The same reconciliation seen through the view the user is looking at: after
 * the host toast marks everything read, the open list must not keep showing the
 * rows under the "Unread" filter while the badge says nothing is unread.
 */
describe('Notifications view after the poller reports nothing unread', () => {
  async function mountView() {
    vi.resetModules();
    const Notifications = (await import('../../views/Notifications.vue')).default;
    return mount(Notifications, { global: { plugins: [createTestRouter(), createTestI18n('en')] } });
  }

  it('drops the row from the unread filter', async () => {
    const wrapper = await mountView();
    dispatchMessage({
      command: 'initialState',
      instances: [{ id: 'inst-1', url: 'https://forgejo.example.com', name: 'a', username: 'user-a' }],
      locale: 'en',
    });
    dispatchMessage({
      command: 'notifications',
      instanceId: 'inst-1',
      notifications: [{ id: 1, unread: true, subject: { title: 'Mention' } }],
    });
    await flushPromises();
    expect(wrapper.text()).toContain('Mention');

    // The poller examined row 1 and no longer reports it unread.
    dispatchMessage({ command: 'polledNotifications', instanceId: 'inst-1', notifications: [], coveredIds: [1] });
    await flushPromises();

    expect(wrapper.text()).not.toContain('Mention');
    wrapper.unmount();
  });
});
