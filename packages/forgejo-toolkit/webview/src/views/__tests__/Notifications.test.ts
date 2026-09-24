import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { nextTick } from 'vue';
import Notifications from '../Notifications.vue';
import { useAppState, NOTIFICATIONS_LIMIT, notificationsKey } from '../../composables/useAppState';
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
  it('says that one click affects every configured instance', async () => {
    // The button loops over all configured instances and posts the command for
    // each; the host confirms destructive commands itself, so the label and the
    // hint are what tell the user the click is not scoped to this instance.
    const wrapper = mountNotifications();
    await dispatchNotifications([{ id: 1, unread: true, subject: { title: 'Mention' } }]);

    const button = markAllButton(wrapper);
    expect(button.text()).toContain('all instances');
    expect(button.attributes('title')).toContain('all configured');
    wrapper.unmount();
  });

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

describe('Notifications paging', () => {
  // Distinct, descending timestamps: the oldest one is the next-page cursor.
  function page(count: number, firstId = 1): Array<Record<string, unknown>> {
    const base = Date.UTC(2026, 8, 20, 12, 0, 0);
    return Array.from({ length: count }, (_, index) => ({
      id: firstId + index,
      unread: true,
      updated_at: new Date(base - index * 60_000).toISOString(),
      subject: { title: `Notification ${firstId + index}` },
    }));
  }

  function loadMoreButton(wrapper: ReturnType<typeof mountNotifications>) {
    return wrapper.findAll('vscode-button').find((candidate) => candidate.text().includes('Load more'));
  }

  function lastGetNotifications() {
    return [...postedMessages()].reverse().find((message) => message.command === 'getNotifications');
  }

  it('offers Load more until an empty page proves the list ended', async () => {
    const wrapper = mountNotifications();
    await dispatchNotifications(page(NOTIFICATIONS_LIMIT));
    expect(loadMoreButton(wrapper)).toBeTruthy();

    // A short page is not the end: the server may have clamped its own page size,
    // and its total only exists in a response header the client does not expose.
    dispatchMessage({ command: 'notifications', instanceId: 'inst-1', notifications: page(3) });
    await flushPromises();
    expect(loadMoreButton(wrapper)).toBeTruthy();

    // Only an empty page ends the list.
    dispatchMessage({ command: 'notifications', instanceId: 'inst-1', notifications: [] });
    await flushPromises();
    expect(loadMoreButton(wrapper)).toBeUndefined();
  });

  it('requests the next page from the oldest loaded notification', async () => {
    const wrapper = mountNotifications();
    const first = page(NOTIFICATIONS_LIMIT);
    await dispatchNotifications(first);

    postMessageMock.mockClear();
    await loadMoreButton(wrapper)!.trigger('click');

    expect(lastGetNotifications()).toMatchObject({
      instanceId: 'inst-1',
      limit: NOTIFICATIONS_LIMIT,
      before: first[NOTIFICATIONS_LIMIT - 1].updated_at,
    });
  });

  it('appends the next page and keeps Load more when it comes back short', async () => {
    const wrapper = mountNotifications();
    const first = page(NOTIFICATIONS_LIMIT);
    await dispatchNotifications(first);

    const cursor = first[NOTIFICATIONS_LIMIT - 1].updated_at as string;
    dispatchMessage({ command: 'notifications', instanceId: 'inst-1', notifications: page(2, 51), before: cursor });
    await flushPromises();

    expect(useAppState().notifications.value.get(notificationsKey('inst-1'))).toHaveLength(NOTIFICATIONS_LIMIT + 2);
    expect(loadMoreButton(wrapper)).toBeTruthy();
  });

  it('keeps the cursor of the loaded page after marking a notification read', async () => {
    const wrapper = mountNotifications();
    const first = page(NOTIFICATIONS_LIMIT);
    await dispatchNotifications(first);

    // Marking read removes the entry locally; the cursor must not move to the
    // next-oldest notification, or the page boundary would skip entries.
    const oldestId = first[NOTIFICATIONS_LIMIT - 1].id as number;
    dispatchMessage({ command: 'notificationMarkedRead', instanceId: 'inst-1', id: oldestId });
    await flushPromises();

    postMessageMock.mockClear();
    await loadMoreButton(wrapper)!.trigger('click');

    expect(lastGetNotifications()).toMatchObject({ before: first[NOTIFICATIONS_LIMIT - 1].updated_at });
  });
});

/**
 * The status/type filters debounce their reload by 300 ms. `keep-alive :max="10"`
 * unmounts an evicted view, and the shell's dashboard reopen remounts the current
 * view in place, so a timer armed just before that still fired: the view posted a
 * notifications request after it was gone.
 */
describe('Notifications filter debounce across unmount', () => {
  it('does not post a debounced filter reload for an unmounted view', async () => {
    const wrapper = mountNotifications();
    await dispatchNotifications([{ id: 1, unread: true, subject: { title: 'Mention' } }]);

    const statusFilter = wrapper.get('#notification-status-filter');
    (statusFilter.element as unknown as { value: string }).value = 'all';
    await statusFilter.trigger('change');
    await nextTick();

    postMessageMock.mockClear();
    wrapper.unmount();

    // Past the 300 ms window the debounced reload would have fired.
    await new Promise((resolve) => setTimeout(resolve, 350));

    expect(postedMessages().filter((message) => message.command === 'getNotifications')).toHaveLength(0);
  });
});

describe('Notifications failure banner', () => {
  function page(count: number, firstId = 1): Array<Record<string, unknown>> {
    const base = Date.UTC(2026, 8, 20, 12, 0, 0);
    return Array.from({ length: count }, (_, index) => ({
      id: firstId + index,
      unread: true,
      updated_at: new Date(base - index * 60_000).toISOString(),
      subject: { title: `Notification ${firstId + index}` },
    }));
  }

  // The composable is a module-level singleton shared by every test in this
  // file; the slots this describe writes are cleared so one case cannot leave a
  // banner (or a cursor) behind for the next one.
  beforeEach(() => {
    const state = useAppState();
    state.errors.delete(notificationsKey('inst-1'));
    state.notificationPollErrors.value.clear();
    state.notifications.value.delete(notificationsKey('inst-1'));
    state.notificationsHasMore.value.delete(notificationsKey('inst-1'));
    state.loading.delete(notificationsKey('inst-1'));
  });

  /** The banner's own lines, one per failing cause. */
  function bannerLines(wrapper: ReturnType<typeof mountNotifications>): string[] {
    return wrapper.findAll('.error-line').map((line) => line.text());
  }

  function bannerRetry(wrapper: ReturnType<typeof mountNotifications>) {
    return wrapper.findAll('.icon-action-button').find((button) => button.attributes('aria-label') === 'Retry');
  }

  function loadMoreButton(wrapper: ReturnType<typeof mountNotifications>) {
    return wrapper.findAll('vscode-button').find((candidate) => candidate.text().includes('Load more'));
  }

  it('states a load failure once, with only the load wrapper', async () => {
    const wrapper = mountNotifications();
    dispatchMessage({
      command: 'initialState',
      instances: [{ id: 'inst-1', url: 'https://forgejo.example.com' }],
      locale: 'en',
    });
    dispatchMessage({ command: 'notifications', instanceId: 'inst-1', error: 'instance unreachable' });
    await flushPromises();

    expect(bannerLines(wrapper)).toEqual(['Failed to load: instance unreachable']);
    wrapper.unmount();
  });

  it('states a poll failure once, with only the poll wrapper', async () => {
    const wrapper = mountNotifications();
    dispatchMessage({
      command: 'initialState',
      instances: [{ id: 'inst-1', url: 'https://forgejo.example.com' }],
      locale: 'en',
    });
    dispatchMessage({ command: 'polledNotifications', instanceId: 'inst-1', error: 'instance unreachable' });
    await flushPromises();

    expect(bannerLines(wrapper)).toEqual(['Failed to refresh notifications: instance unreachable']);
    wrapper.unmount();
  });

  it('states a load failure and a poll failure each once when both are recorded', async () => {
    const wrapper = mountNotifications();
    await dispatchNotifications([{ id: 1, unread: true, subject: { title: 'Mention' } }]);
    dispatchMessage({ command: 'notifications', instanceId: 'inst-1', error: 'token rejected' });
    dispatchMessage({ command: 'polledNotifications', instanceId: 'inst-1', error: 'instance unreachable' });
    await flushPromises();

    // Neither cause hides the other, and neither is wrapped inside the other.
    expect(bannerLines(wrapper)).toEqual([
      'Failed to load: token rejected',
      'Failed to refresh notifications: instance unreachable',
    ]);
    wrapper.unmount();
  });

  it('dismisses the poll-failure banner when its own Retry runs', async () => {
    const wrapper = mountNotifications();
    await dispatchNotifications([{ id: 1, unread: true, subject: { title: 'Mention' } }]);
    dispatchMessage({ command: 'polledNotifications', instanceId: 'inst-1', error: 'instance unreachable' });
    await flushPromises();
    expect(wrapper.text()).toContain('Failed to refresh notifications: instance unreachable');

    postMessageMock.mockClear();
    await bannerRetry(wrapper)!.trigger('click');
    await flushPromises();

    // The retry re-requests the list and drops the recorded poll failure, so the
    // banner does not survive a successful retry.
    expect(postedMessages()).toContainEqual(
      expect.objectContaining({ command: 'getNotifications', instanceId: 'inst-1' }),
    );
    expect(wrapper.text()).not.toContain('Failed to refresh notifications: instance unreachable');
    wrapper.unmount();
  });

  it('keeps an instance with another page reachable when the filters hide the loaded rows', async () => {
    const wrapper = mountNotifications();
    const first = page(NOTIFICATIONS_LIMIT);
    await dispatchNotifications(first);

    // The poller reports every loaded row read, so the (client-side) unread
    // filter now hides the whole page — but another page still exists.
    dispatchMessage({
      command: 'polledNotifications',
      instanceId: 'inst-1',
      notifications: [],
      coveredIds: first.map((notification) => notification.id),
    });
    await flushPromises();

    expect(wrapper.find('.notifications-list').exists()).toBe(true);
    expect(loadMoreButton(wrapper)).toBeTruthy();
    expect(wrapper.text()).toContain('No notifications match the selected filters.');
    wrapper.unmount();
  });
});
