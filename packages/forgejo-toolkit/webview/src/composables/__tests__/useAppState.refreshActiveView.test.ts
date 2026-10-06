import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { reactive } from 'vue';
import { createTestRouter, createTestI18n } from '../../__tests__/helpers/test-utils';

/**
 * Where the host's refresh goes.
 *
 * The sidebar has one refresh entry (a `view/title` item per target, see
 * `docs/architecture/README.md`), and the host does not route it: it posts
 * `refreshData` and the webview decides, because only the webview knows which of
 * its routes the reader is on. These tests pin that decision — the dashboard and
 * the repository issue/PR lists keep the instance-level refresh they always had,
 * a route whose view owns its own inputs is handed over through
 * `requestViewRefresh` instead, and a route the sidebar does not know falls back
 * to the dashboard behaviour.
 *
 * A probe component stands in for the view of the route under test: it registers
 * with the real `useViewRefresh`, so both halves of the handover are the shipped
 * ones.
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

function postedCommands(): string[] {
  return vscodeApiMock.postMessage.mock.calls.map(([message]) => (message as { command: string }).command);
}

const instance = {
  id: 'inst-1',
  url: 'https://forgejo.example.com',
  name: 'user@forgejo.example.com',
  username: 'user',
};

/**
 * The composable on its route, over a fresh module graph, with a probe view that
 * answers the refresh handover the way the view of `viewRouteName` would.
 *
 * The state is a module-level singleton whose router is the one the first caller
 * saw, so each test re-imports the modules and installs its own router before the
 * first call; the probe is imported from the same generation so both halves talk
 * to one signal.
 */
async function createState(route?: { name: string; params: Record<string, string> }, viewRouteName?: string) {
  vi.resetModules();
  const mod = await import('../../composables/useAppState');
  const { useViewRefresh } = await import('../../composables/viewRefresh');
  const { appRouterKey } = await import('../../composables/useAppRouter');
  const router = createTestRouter();
  const i18n = createTestI18n();
  const reload = vi.fn();
  // What the probe view is looking at. `useViewRefresh` reads nothing but the
  // route's name, so the probe can carry its own — kept in step with the router
  // below, the way a real view's route follows it.
  const probeRoute = reactive<{ name: unknown }>({ name: undefined });
  const wrapper = mount(
    {
      template: '<div></div>',
      setup() {
        const state = mod.useAppState();
        if (viewRouteName) {
          useViewRefresh(probeRoute, viewRouteName, reload);
        }
        return { state };
      },
    },
    // The dashboard's entry provides this key (`src/main.ts`); without it the
    // composable behaves like one of the standalone panels, which have no route
    // of their own and therefore route every refresh to the dashboard path.
    { global: { plugins: [router, i18n], provide: { [appRouterKey]: router } } },
  );
  if (route) {
    await router.push(route);
    probeRoute.name = route.name;
  }
  await flushPromises();
  return { state: wrapper.vm.state as ReturnType<typeof mod.useAppState>, router, reload, wrapper };
}

describe('refreshData routing', () => {
  const viewOwnedRoutes: Array<[string, Record<string, string>]> = [
    ['repoDetail', { instanceId: 'inst-1', owner: 'owner', repo: 'repo' }],
    ['issueDetail', { instanceId: 'inst-1', owner: 'owner', repo: 'repo', index: '5' }],
    ['pullRequestDetail', { instanceId: 'inst-1', owner: 'owner', repo: 'repo', index: '5' }],
    ['actionRunDetail', { instanceId: 'inst-1', owner: 'owner', repo: 'repo', runId: '7' }],
    ['notifications', {}],
  ];

  for (const [name, params] of viewOwnedRoutes) {
    it(`hands a refresh of ${name} to that view`, async () => {
      const { state, reload } = await createState({ name, params }, name);
      // Something for the dashboard path to drop if it ran.
      state.repositoriesCache.set('inst-1', []);

      dispatchMessage({ command: 'refreshData' });
      await flushPromises();

      // The view re-issues its own loads off the handover: it is the only side
      // that knows a repository's selected branch, an action run's expanded job
      // logs or the notification filters on screen.
      expect(reload).toHaveBeenCalledTimes(1);
      // And the instance-level refresh — which drops this cache and re-reads
      // every instance's repositories — is not what a refresh of this page means:
      // it would blank payloads the page is rendering.
      expect(state.repositoriesCache.has('inst-1')).toBe(true);
      expect(postedCommands()).not.toContain('getRepositories');
    });
  }

  it('keeps the instance-level refresh the dashboard always had', async () => {
    const { state, reload } = await createState({ name: 'dashboard', params: {} }, 'dashboard');
    dispatchMessage({ command: 'instances', data: [instance] });
    state.repositoriesCache.set('inst-1', []);
    vscodeApiMock.postMessage.mockClear();

    dispatchMessage({ command: 'refreshData' });
    await flushPromises();

    expect(reload).not.toHaveBeenCalled();
    expect(state.repositoriesCache.has('inst-1')).toBe(false);
    expect(postedCommands()).toContain('getRepositories');
  });

  it('replays the repository issue list without a view of its own', async () => {
    const { state, reload } = await createState(
      { name: 'repoIssues', params: { instanceId: 'inst-1', owner: 'owner', repo: 'repo', state: 'open' } },
      'repoIssues',
    );
    dispatchMessage({ command: 'instances', data: [instance] });
    state.repositoriesCache.set('inst-1', []);
    vscodeApiMock.postMessage.mockClear();

    dispatchMessage({ command: 'refreshData' });
    await flushPromises();

    // The held list request lives in the composable, so this route is refreshed
    // by the same instance-level path the dashboard uses.
    expect(reload).not.toHaveBeenCalled();
    expect(state.repositoriesCache.has('inst-1')).toBe(false);
  });

  it('leaves the search route on the refresh it had before', async () => {
    const { state, reload } = await createState({ name: 'globalSearch', params: {} }, 'globalSearch');
    state.repositoriesCache.set('inst-1', []);

    dispatchMessage({ command: 'refreshData' });
    await flushPromises();

    // The search page has no refresh item of its own: its results belong to the
    // query in its box, and its Search control is what re-runs that query.
    expect(reload).not.toHaveBeenCalled();
    expect(state.repositoriesCache.has('inst-1')).toBe(false);
  });

  it('falls back to the dashboard behaviour while the router has no route yet', async () => {
    const { state, reload } = await createState(undefined, 'dashboard');
    state.repositoriesCache.set('inst-1', []);

    dispatchMessage({ command: 'refreshData' });
    await flushPromises();

    // The host contributes no item until the webview reports a view, so this is
    // the window before the first report (and the behaviour a stray refresh had
    // before the routing existed).
    expect(reload).not.toHaveBeenCalled();
    expect(state.repositoriesCache.has('inst-1')).toBe(false);
  });
});
