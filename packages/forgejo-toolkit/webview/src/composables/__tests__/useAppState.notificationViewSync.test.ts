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
 * screen.
 */
describe('useAppState poller/view notification reconciliation', () => {
  it('marks a view notification read when the poller no longer reports it unread', async () => {
    const { state } = await createState();
    state.instances.value = [{ id: 'inst-1', url: 'https://forgejo.example.com', name: 'a', username: 'user-a' }];
    dispatchMessage({ command: 'notifications', instanceId: 'inst-1', notifications: [notification(1, true)] });
    await nextTick();
    expect(state.unreadViewNotificationCount.value).toBe(1);

    // The poller comes back with nothing unread: "mark all as read" ran.
    dispatchMessage({ command: 'polledNotifications', instanceId: 'inst-1', notifications: [] });
    await nextTick();

    expect(state.unreadViewNotificationCount.value).toBe(0);
    expect(state.notifications.value.get('inst-1:notifications')?.[0].unread).toBe(false);
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

    dispatchMessage({ command: 'polledNotifications', instanceId: 'inst-1', notifications: [] });
    await flushPromises();

    expect(wrapper.text()).not.toContain('Mention');
    wrapper.unmount();
  });
});
