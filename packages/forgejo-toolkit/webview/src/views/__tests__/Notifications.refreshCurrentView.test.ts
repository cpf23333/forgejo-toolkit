import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { createTestRouter, createTestI18n } from '../../__tests__/helpers/test-utils';

/**
 * The sidebar's refresh, seen from the view that owns the data.
 *
 * The host posts one `refreshData`; the composable routes it to the view the
 * route shows (`refreshActiveView`), and that view re-issues the loads it issues
 * for itself — with the filters, branch or diff range it is actually showing,
 * which is why the composable cannot do it on the view's behalf.
 */
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

function postedMessages(): Array<Record<string, unknown>> {
  return vscodeApiMock.postMessage.mock.calls.map(([message]) => message as Record<string, unknown>);
}

/**
 * The view on its own route, over a fresh module graph: `useAppState` is a
 * module-level singleton whose router is the one its first caller saw, so the
 * route has to be in place before the view (and with it the state) mounts.
 */
async function mountNotifications() {
  vi.resetModules();
  const { appRouterKey } = await import('../../composables/useAppRouter');
  const router = createTestRouter();
  await router.push({ name: 'notifications', params: {} });
  const Notifications = (await import('../Notifications.vue')).default;
  const wrapper = mount(Notifications, {
    // The dashboard's entry provides this key (`src/main.ts`); without it the
    // composable behaves like one of the standalone panels, which have no route.
    global: { plugins: [router, createTestI18n('en')], provide: { [appRouterKey]: router } },
  });
  await flushPromises();
  return { wrapper, router };
}

describe('the notifications view refreshes itself', () => {
  it('re-reads the list, with the filters on screen, when the host refreshes the view', async () => {
    const { wrapper } = await mountNotifications();
    dispatchMessage({
      command: 'initialState',
      instances: [{ id: 'inst-1', url: 'https://forgejo.example.com', name: 'user', username: 'user' }],
      locale: 'en',
    });
    dispatchMessage({
      command: 'notifications',
      instanceId: 'inst-1',
      notifications: [{ id: 1, unread: true, subject: { title: 'Mention' } }],
    });
    await flushPromises();
    vscodeApiMock.postMessage.mockClear();

    dispatchMessage({ command: 'refreshData' });
    await flushPromises();

    // The default filter is the one the view shows ("Unread"), and it is the view
    // that decides the request: the composable knows neither the filter nor the
    // instance list the page is rendering.
    expect(postedMessages().filter((message) => message.command === 'getNotifications')).toEqual([
      expect.objectContaining({ instanceId: 'inst-1', statusTypes: ['unread', 'pinned'] }),
    ]);
    wrapper.unmount();
  });

  it('re-reads only the notifications when the host refreshes the view', async () => {
    const { wrapper } = await mountNotifications();
    dispatchMessage({
      command: 'initialState',
      instances: [{ id: 'inst-1', url: 'https://forgejo.example.com', name: 'user', username: 'user' }],
      locale: 'en',
    });
    await flushPromises();
    vscodeApiMock.postMessage.mockClear();

    dispatchMessage({ command: 'refreshData' });
    await flushPromises();

    // The dashboard's own refresh — dropping the instance-level caches and asking
    // for every instance's repositories — is not what a refresh of this page
    // means, and it would leave the list's own payload handling to a second path.
    expect(postedMessages().map((message) => message.command)).toEqual(['getNotifications']);
    wrapper.unmount();
  });
});
