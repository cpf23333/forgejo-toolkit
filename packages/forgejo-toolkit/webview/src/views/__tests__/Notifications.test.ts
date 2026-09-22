import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import Notifications from '../Notifications.vue';
import { useAppState } from '../../composables/useAppState';
import { vscode } from '../../composables/vscode';
import { createTestRouter, createTestI18n } from '../../__tests__/helpers/test-utils';

// The view is mounted with the real composable so the notification slots and
// the toolbar wiring are exercised end to end. useAppState is a module-level
// singleton, so the window listener registers on the first mount and stays
// usable for every test in this file.
let messageHandlers: Array<(event: MessageEvent) => void> = [];
let listenerInstalled = false;

const postMessageMock = vscode.postMessage as unknown as {
  mock: { calls: Array<[Record<string, unknown>]> };
  mockClear: () => void;
};

function postedMessages(): Array<Record<string, unknown>> {
  return postMessageMock.mock.calls.map((call) => call[0]);
}

beforeEach(() => {
  postMessageMock.mockClear();
  if (!listenerInstalled) {
    vi.spyOn(window, 'addEventListener').mockImplementation((type, listener) => {
      if (type === 'message') {
        messageHandlers.push(listener as (event: MessageEvent) => void);
      }
    });
    listenerInstalled = true;
  }
});

afterEach(() => {
  vi.restoreAllMocks();
});

function dispatchMessage(message: unknown) {
  const event = new MessageEvent('message', { data: message });
  messageHandlers.forEach((handler) => handler(event));
}

function mountNotifications() {
  return mount(Notifications, {
    global: { plugins: [createTestRouter(), createTestI18n('en')] },
  });
}

async function dispatchNotifications(notifications: Array<Record<string, unknown>>) {
  // `locale` is part of the host snapshot: leaving it out would clear the
  // i18n locale and break every translated label in the view.
  dispatchMessage({
    command: 'initialState',
    instances: [{ id: 'inst-1', url: 'https://forgejo.example.com' }],
    locale: 'en',
  });
  dispatchMessage({ command: 'notifications', instanceId: 'inst-1', notifications });
  await flushPromises();
}

function markAllButton(wrapper: ReturnType<typeof mountNotifications>) {
  const button = wrapper.findAll('vscode-button').find((candidate) => candidate.text().includes('Mark all as read'));
  expect(button).toBeTruthy();
  return button!;
}

function markAllDisabled(wrapper: ReturnType<typeof mountNotifications>): boolean {
  // The test environment does not register the vscode-elements custom
  // elements, so Vue writes the boolean as an attribute string.
  const disabled = markAllButton(wrapper).attributes('disabled');
  return disabled !== undefined && disabled !== 'false';
}

describe('Notifications mark all as read', () => {
  it('is enabled from the loaded list when notification polling never ran', async () => {
    const wrapper = mountNotifications();
    await dispatchNotifications([
      { id: 1, unread: true, subject: { title: 'Mention' } },
      { id: 2, unread: false, subject: { title: 'Read one' } },
    ]);

    // Polling is off, so the activity-bar badge slot is empty: the button must
    // still react to the notifications the view displays.
    const state = useAppState();
    expect(state.unreadNotificationCount.value).toBe(0);
    expect(state.unreadViewNotificationCount.value).toBe(1);
    expect(markAllDisabled(wrapper)).toBe(false);
  });

  it('is disabled when every loaded notification is already read', async () => {
    const wrapper = mountNotifications();
    await dispatchNotifications([{ id: 1, unread: false, subject: { title: 'Read one' } }]);

    expect(markAllDisabled(wrapper)).toBe(true);
  });

  it('is disabled again once the host confirms everything was marked read', async () => {
    const wrapper = mountNotifications();
    await dispatchNotifications([{ id: 1, unread: true, subject: { title: 'Mention' } }]);
    expect(markAllDisabled(wrapper)).toBe(false);

    await markAllButton(wrapper).trigger('click');
    expect(postedMessages()).toContainEqual(
      expect.objectContaining({ command: 'markAllNotificationsRead', instanceId: 'inst-1' }),
    );

    dispatchMessage({ command: 'allNotificationsMarkedRead', instanceId: 'inst-1' });
    await flushPromises();

    expect(markAllDisabled(wrapper)).toBe(true);
  });
});
