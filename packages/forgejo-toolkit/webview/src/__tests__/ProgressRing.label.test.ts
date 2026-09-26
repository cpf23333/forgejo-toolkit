import { describe, expect, it, vi, beforeEach } from 'vitest';
import { mount, type VueWrapper } from '@vue/test-utils';
import { nextTick } from 'vue';

/**
 * `@vscode-elements/elements`' `vscode-progress-ring` hard-codes its accessible
 * name: the constructor sets `ariaLabel = 'Loading'`, `ariaLive = 'assertive'`
 * and `role = 'alert'` (see
 * `node_modules/@vscode-elements/elements/dist/vscode-progress-ring/vscode-progress-ring.js`),
 * and the property is declared
 * `@property({ reflect: true, attribute: 'aria-label' })`. The element renders
 * nothing but an `<svg>`, so no light-DOM text can name it — leaving the
 * attribute alone made every ring in the webview announce English "Loading" in
 * every locale. `ariaLabel` is a *property* of the element (not a plain ARIA
 * attribute of the host), so the binding is `:aria-label="…"`: Vue writes the
 * attribute the reflected property reads.
 *
 * The label is the localized loading text these rings already show beside them,
 * so the visible sentence and the announced one are the same string in the same
 * locale.
 */

const SOURCES = import.meta.glob('../**/*.vue', { query: '?raw', import: 'default', eager: true }) as Record<
  string,
  string
>;

/** Every rendered `<vscode-progress-ring …>` opening tag in the webview sources. */
function progressRingTags(): Array<{ file: string; tag: string }> {
  const tags: Array<{ file: string; tag: string }> = [];
  for (const [file, source] of Object.entries(SOURCES)) {
    const display = file.replace(/^\.\.\//, '');
    for (const match of source.matchAll(/<vscode-progress-ring\b[^>]*>/g)) {
      tags.push({ file: display, tag: match[0].replace(/\s+/g, ' ') });
    }
  }
  return tags;
}

const { stateMock } = vi.hoisted(() => ({
  stateMock: {
    instances: { value: [] as Array<Record<string, unknown>> },
    loading: new Map<string, boolean>(),
    errors: new Map<string, string>(),
    notifications: { value: new Map<string, unknown[]>() },
    notificationPollErrors: { value: new Map<string, string>() },
    notificationsBefore: { value: new Map<string, string>() },
    notificationsHasMore: { value: new Map<string, boolean>() },
    globalSearchResults: { value: new Map<string, unknown>() },
    unreadViewNotificationCount: { value: 0 },
    locale: { value: 'en' },
    loadNotifications: vi.fn(),
    markNotificationRead: vi.fn(),
    markAllNotificationsRead: vi.fn(),
    loadGlobalSearch: vi.fn(),
    openRepoDetail: vi.fn(),
    openIssueDetail: vi.fn(),
    openPullRequestDetail: vi.fn(),
    openExternal: vi.fn(),
    copyToClipboard: vi.fn(),
    loadRepositories: vi.fn(),
    loadMyIssues: vi.fn(),
    loadMyPullRequests: vi.fn(),
    repositories: { value: new Map<string, unknown[]>() },
    myIssues: { value: new Map<string, unknown[]>() },
    myPullRequests: { value: new Map<string, unknown[]>() },
    repositoriesCache: { has: () => false },
    myIssuesCache: { has: () => false },
    myPullRequestsCache: { has: () => false },
  },
}));

vi.mock('../composables/useAppState', async () => {
  const { reactive } = await import('vue');
  const state = reactive(stateMock);
  // The loaders mark their own key as in flight, exactly like the composable:
  // the view then renders the ring off a state change it can actually observe.
  stateMock.loadGlobalSearch.mockImplementation(
    (instanceId: string, scope: string, query: string, stateFilter: string) => {
      state.loading.set(`${instanceId}:global-search:${scope}:${stateFilter}:${query}`, true);
    },
  );
  stateMock.loadNotifications.mockImplementation((instanceId: string) => {
    state.loading.set(`${instanceId}:notifications`, true);
  });
  return {
    useAppState: () => state,
    notificationsKey: (instanceId: string) => `${instanceId}:notifications`,
    globalSearchKey: (instanceId: string, scope: string, query: string, stateFilter: string) =>
      `${instanceId}:global-search:${scope}:${stateFilter}:${query}`,
    GLOBAL_SEARCH_LIMIT: 20,
    NOTIFICATIONS_LIMIT: 50,
  };
});

import { defineComponent, h, KeepAlive } from 'vue';
import GlobalSearch from '../views/GlobalSearch.vue';
import Notifications from '../views/Notifications.vue';
import DashboardInstanceItem from '../components/DashboardInstanceItem.vue';
import { createTestI18n, createTestRouter } from './helpers/test-utils';
import en from '../i18n/en.json';
import zh from '../i18n/zh.json';

const LOCALES = [
  { locale: 'en' as const, messages: en },
  { locale: 'zh' as const, messages: zh },
];

const INSTANCE = { id: 'inst-1', url: 'https://forgejo.example.com', name: 'demo', username: 'demo-user' };

const labelOf = (wrapper: VueWrapper, index = 0): string | undefined =>
  wrapper.findAll('vscode-progress-ring')[index]?.attributes('aria-label');

beforeEach(() => {
  vi.clearAllMocks();
  stateMock.loading.clear();
  stateMock.errors.clear();
  stateMock.notifications.value.clear();
  stateMock.globalSearchResults.value.clear();
  stateMock.instances.value = [INSTANCE];
});

describe('progress ring accessible names', () => {
  it('labels every progress ring the webview renders', () => {
    const tags = progressRingTags();

    // The scan is the point: a ring elsewhere in the webview fails here instead
    // of silently announcing English "Loading" again.
    expect(tags.length).toBeGreaterThanOrEqual(16);
    expect(tags.filter(({ tag }) => !tag.includes(':aria-label='))).toEqual([]);

    // Every label is the shared localized loading string, not a literal.
    for (const { tag } of tags) {
      expect(tag).toContain(':aria-label="t(\'dashboard.loading\')"');
    }
  });

  it.each(LOCALES)('names the GlobalSearch loading ring in $locale', async ({ locale, messages }) => {
    const wrapper = mount(GlobalSearch, {
      global: { plugins: [createTestI18n(locale)] },
    });

    const input = wrapper.find('.search-input');
    (input.element as HTMLInputElement).value = 'alpha';
    await input.trigger('input');
    await nextTick();
    await input.trigger('keydown', { key: 'Enter' });
    await nextTick();

    const rings = wrapper.findAll('vscode-progress-ring');
    expect(rings).toHaveLength(1);
    expect(labelOf(wrapper)).toBe(messages.dashboard.loading);
    // The visible sentence beside the ring carries the same string.
    expect(wrapper.text()).toContain(messages.dashboard.loading);

    wrapper.unmount();
  });

  it.each(LOCALES)('names the Notifications loading ring in $locale', async ({ locale, messages }) => {
    // The view loads its list from `onActivated`, so it has to be mounted under
    // keep-alive the way the shell mounts it.
    const Host = defineComponent({
      props: { show: { type: Boolean, default: true } },
      setup: (props) => () =>
        h(KeepAlive, null, {
          default: () => (props.show ? h(Notifications) : h('div')),
        }),
    });
    const wrapper = mount(Host, {
      global: { plugins: [createTestRouter(), createTestI18n(locale)] },
    });
    await nextTick();
    await nextTick();

    const rings = wrapper.findAll('vscode-progress-ring');
    expect(rings).toHaveLength(1);
    expect(labelOf(wrapper)).toBe(messages.dashboard.loading);

    wrapper.unmount();
  });

  it.each(LOCALES)('names a ring that has visible text beside it in $locale', async ({ locale, messages }) => {
    stateMock.loading.set('repos-inst-1', true);

    const wrapper = mount(DashboardInstanceItem, {
      props: { instance: INSTANCE, activeTab: 'repositories' },
      global: { plugins: [createTestI18n(locale)] },
    });
    await nextTick();

    const rings = wrapper.findAll('vscode-progress-ring');
    expect(rings).toHaveLength(1);
    expect(labelOf(wrapper)).toBe(messages.dashboard.loading);
    expect(wrapper.text()).toContain(messages.dashboard.loading);

    wrapper.unmount();
  });
});
