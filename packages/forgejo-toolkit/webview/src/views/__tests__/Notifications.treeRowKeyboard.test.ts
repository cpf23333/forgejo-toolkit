import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import { nextTick } from 'vue';

const { stateMock } = vi.hoisted(() => ({
  stateMock: {
    instances: { value: [{ id: 'inst-1', url: 'https://forgejo.example.com', username: 'demo-user' }] },
    loading: new Map<string, boolean>(),
    errors: new Map<string, string>(),
    notificationPollErrors: { value: new Map<string, string>() },
    notifications: { value: new Map<string, unknown[]>() },
    notificationsHasMore: { value: new Map<string, boolean>() },
    notificationsBefore: { value: new Map<string, string>() },
    unreadViewNotificationCount: { value: 1 },
    unreadNotificationCount: { value: 0 },
    locale: { value: 'en' },
    loadNotifications: vi.fn(),
    markNotificationRead: vi.fn(),
    markAllNotificationsRead: vi.fn(),
    openIssueDetail: vi.fn(),
    openPullRequestDetail: vi.fn(),
    openExternal: vi.fn(),
  },
}));

vi.mock('../../composables/useAppState', async () => {
  const { reactive } = await import('vue');
  const state = reactive(stateMock);
  return {
    useAppState: () => state,
    notificationsKey: (instanceId: string) => `${instanceId}:notifications`,
  };
});

import Notifications from '../Notifications.vue';
import { createTestI18n, createTestRouter } from '../../__tests__/helpers/test-utils';

function mountNotifications() {
  return mount(Notifications, {
    global: { plugins: [createTestRouter(), createTestI18n('en')] },
  });
}

/**
 * The notification rows act on `@click.capture`, but `vscode-tree` consumes
 * Enter/Space on the tree item it focuses and never synthesizes a click: without
 * a capture-phase activation of its own, no notification could be opened from
 * the keyboard, while the nested mark-as-read / open-external buttons worked.
 */
describe('Notifications rows activate from the keyboard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    stateMock.notifications.value.clear();
    stateMock.notificationsHasMore.value.clear();
    stateMock.notificationsBefore.value.clear();
    stateMock.loading.clear();
    stateMock.errors.clear();
    stateMock.notificationPollErrors.value.clear();
    stateMock.notifications.value.set('inst-1:notifications', [
      {
        id: 7,
        unread: true,
        updated_at: '2026-09-20T12:00:00.000Z',
        repository: { full_name: 'owner/repo' },
        subject: { title: 'Mention', type: 'Issue', html_url: 'https://forgejo.example.com/owner/repo/issues/7' },
      },
    ]);
  });

  it('opens the focused notification on Enter and on Space', async () => {
    const wrapper = mountNotifications();
    await nextTick();

    const row = wrapper.get('[data-tree-row-action]');
    (row.element as HTMLElement).focus();
    await row.trigger('keydown', { key: 'Enter' });
    expect(stateMock.openIssueDetail).toHaveBeenCalledWith('inst-1', 'owner', 'repo', 7);

    await row.trigger('keydown', { key: ' ' });
    expect(stateMock.openIssueDetail).toHaveBeenCalledTimes(2);
    wrapper.unmount();
  });

  it('keeps the key from reaching the tree own selection handling', async () => {
    const wrapper = mountNotifications();
    await nextTick();

    const tree = wrapper.get('vscode-tree').element;
    // Stands in for the tree's own bubble-phase keydown listener.
    const treeKeydown = vi.fn();
    tree.addEventListener('keydown', treeKeydown);

    await wrapper.get('[data-tree-row-action]').trigger('keydown', { key: 'Enter' });

    expect(treeKeydown).not.toHaveBeenCalled();
    wrapper.unmount();
  });

  it('runs only the nested action button when the key targets it', async () => {
    const wrapper = mountNotifications();
    await nextTick();

    const markAsRead = wrapper.get('[data-tree-row-action] .notification-actions button');
    await markAsRead.trigger('keydown', { key: 'Enter' });

    expect(stateMock.markNotificationRead).toHaveBeenCalledWith('inst-1', 7);
    expect(stateMock.openIssueDetail).not.toHaveBeenCalled();
    wrapper.unmount();
  });

  it('leaves arrow-key navigation to the tree', async () => {
    const wrapper = mountNotifications();
    await nextTick();

    await wrapper.get('[data-tree-row-action]').trigger('keydown', { key: 'ArrowDown' });

    expect(stateMock.openIssueDetail).not.toHaveBeenCalled();
    wrapper.unmount();
  });
});
