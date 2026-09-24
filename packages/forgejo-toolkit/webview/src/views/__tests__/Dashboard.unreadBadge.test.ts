import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import { nextTick, reactive } from 'vue';

const { stateMock } = vi.hoisted(() => ({
  stateMock: {
    instances: {
      value: [
        { id: 'inst-1', url: 'https://forgejo.example.com', username: 'demo-user' },
        { id: 'inst-2', url: 'https://codeberg.org', username: 'other-user' },
      ],
    },
    dashboardActiveTab: { value: 'repositories' },
    setDashboardActiveTab: vi.fn(),
    activeLinkedRepository: { value: undefined },
    linkedRepositories: { value: [] },
    unreadNotificationCount: { value: 0 },
    selectLinkedRepository: vi.fn(),
    openLinkedRepositoryDetail: vi.fn(),
    openLinkedRepositoryIssues: vi.fn(),
    openLinkedRepositoryPullRequests: vi.fn(),
    loadNotificationBadge: vi.fn(),
  },
}));

vi.mock('../../composables/useAppState', () => ({ useAppState: () => reactive(stateMock) }));

import Dashboard from '../Dashboard.vue';
import { createTestI18n, createTestRouter } from '../../__tests__/helpers/test-utils';

function mountView() {
  return mount(Dashboard, {
    global: {
      plugins: [createTestRouter(), createTestI18n('en')],
      stubs: { DashboardInstanceItem: true, ViewTabs: true },
    },
  });
}

/**
 * The badge is fed by the host-side notification poller, which
 * `forgejoToolkit.notificationPollingEnabled` can turn off. With polling off
 * nothing ever fills that slot, so the dashboard asks for the unread list of
 * each instance itself (once — the composable skips instances that already have
 * one).
 */
describe('Dashboard unread badge', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    stateMock.unreadNotificationCount.value = 0;
  });

  it('asks for the unread list of every instance when it opens', async () => {
    const wrapper = mountView();
    await nextTick();

    expect(stateMock.loadNotificationBadge).toHaveBeenCalledWith('inst-1');
    expect(stateMock.loadNotificationBadge).toHaveBeenCalledWith('inst-2');
    wrapper.unmount();
  });

  it('shows the count once the unread list has answered', async () => {
    stateMock.unreadNotificationCount.value = 3;

    const wrapper = mountView();
    await nextTick();

    expect(wrapper.find('.notification-badge').text()).toBe('3');
    wrapper.unmount();
  });

  /**
   * The button's `aria-label` replaces its content for assistive technology, so
   * the badge's count — the only place the number is written — was never
   * announced. It also cannot be read off the visible label: that one is hidden
   * at narrow widths, where the bell is icon and badge only.
   */
  it('announces the unread count in the bell’s accessible name', async () => {
    stateMock.unreadNotificationCount.value = 3;

    const wrapper = mountView();
    await nextTick();

    const bell = wrapper.findAll('vscode-button').find((button) => button.attributes('icon') === 'bell');
    expect(bell, 'notification bell').toBeTruthy();
    expect(bell!.attributes('aria-label')).toBe('Notifications, 3 unread');
    wrapper.unmount();
  });

  it('keeps the plain name when nothing is unread', async () => {
    const wrapper = mountView();
    await nextTick();

    const bell = wrapper.findAll('vscode-button').find((button) => button.attributes('icon') === 'bell');
    expect(bell!.attributes('aria-label')).toBe('Notifications');
    wrapper.unmount();
  });
});
