import { describe, expect, it, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import { reactive } from 'vue';

const { stateMock } = vi.hoisted(() => ({
  stateMock: {
    instances: { value: [{ id: 'inst-1', url: 'https://forgejo.example.com', username: 'demo-user' }] },
    dashboardActiveTab: { value: 'repositories' },
    setDashboardActiveTab: vi.fn(),
    activeLinkedRepository: { value: undefined as Record<string, unknown> | undefined },
    linkedRepositories: { value: [] as Record<string, unknown>[] },
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

/**
 * The linked-repository switcher carried an `aria-label` on the host element,
 * which names the `<vscode-single-select>` node itself: the combobox inside its
 * shadow root stays unnamed, so a screen reader announced a bare combobox. The
 * element's own `label` property is what names the control (see
 * `Settings.controlLabels.test.ts`).
 */
describe('Dashboard form control accessible names', () => {
  it('names the linked repository switcher on the control, not on the host', () => {
    stateMock.activeLinkedRepository.value = {
      localPath: '/work/repo-a',
      owner: 'owner',
      repo: 'repoA',
      remoteUrl: 'https://forgejo.example.com/owner/repoA',
    };
    stateMock.linkedRepositories.value = [
      { localPath: '/work/repo-a', owner: 'owner', repo: 'repoA' },
      { localPath: '/work/repo-b', owner: 'owner', repo: 'repoB' },
    ];

    const wrapper = mount(Dashboard, {
      global: {
        plugins: [createTestRouter(), createTestI18n('en')],
        stubs: { DashboardInstanceItem: true, ViewTabs: true },
      },
    });

    const switcher = wrapper.get('.linked-repo-switcher');
    expect(switcher.attributes('label')).toBe('Switch linked repository');
    // The tooltip stays; the host-level `aria-label` is what did not name the
    // combobox and is gone.
    expect(switcher.attributes('title')).toBe('Switch linked repository');
    expect(switcher.attributes('aria-label')).toBeUndefined();

    wrapper.unmount();
  });
});
