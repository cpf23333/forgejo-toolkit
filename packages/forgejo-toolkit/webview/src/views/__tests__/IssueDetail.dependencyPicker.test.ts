import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mount, flushPromises, type VueWrapper } from '@vue/test-utils';
import { defineComponent, nextTick, type Component } from 'vue';
import { createTestI18n, createTestRouter } from '../../__tests__/helpers/test-utils';

// The picker's on-demand load is a real host round-trip: `loadRepoIssues` posts
// a message and waits for the host's reply, so this test drives the real
// composable and inspects what it posts instead of mocking it away. Mocking
// `useAppState` is exactly what hid both halves of this defect — a mocked
// `repoIssuesFetchedAt` can never be reactive, and a mocked `loadRepoIssues`
// cannot show that the on-demand load fires.
const { postMessageMock } = vi.hoisted(() => ({ postMessageMock: vi.fn() }));

vi.mock('../../composables/vscode', () => ({ postMessage: postMessageMock }));

const EasyMdeEditorStub = defineComponent({ name: 'EasyMdeEditor', template: '<textarea />' });

/**
 * `useAppState` is a module-level singleton whose maps survive a view unmount,
 * so every test re-imports it (and the view under test, which imports the same
 * fresh copy) rather than inheriting the previous test's repository payloads.
 */
async function mountView() {
  vi.resetModules();
  const { default: IssueDetail } = (await import('../IssueDetail.vue')) as { default: Component };
  const router = createTestRouter();
  await router.push({
    name: 'issueDetail',
    params: { instanceId: 'inst-1', owner: 'owner', repo: 'repoA', index: '5' },
  });
  const wrapper = mount(IssueDetail, {
    global: {
      plugins: [router, createTestI18n('en')],
      stubs: { EasyMdeEditor: EasyMdeEditorStub },
    },
  });
  await flushPromises();
  // The template shows the dependency panel only once the issue detail exists.
  // The composable subscribes to `message` when the view's setup calls it, so
  // the host's reply has to be dispatched after mounting.
  window.dispatchEvent(
    new MessageEvent('message', {
      data: {
        command: 'issueDetail',
        instanceId: 'inst-1',
        owner: 'owner',
        repo: 'repoA',
        index: 5,
        detail: { number: 5, title: 'an issue', user: { login: 'demo-user' }, labels: [], assignees: [] },
      },
    }),
  );
  await flushPromises();
  return wrapper;
}

function repoIssuesRequests() {
  return postMessageMock.mock.calls.filter(
    ([message]) => (message as { command?: string }).command === 'getRepoIssues',
  );
}

/**
 * The dependency picker. It is a `vscode-single-select`, compiled as a custom
 * element: jsdom never upgrades it, so the class binding is the only reliable
 * handle and its `click` event listener is registered by Vue on the element.
 */
function dependencySelect(wrapper: VueWrapper) {
  return wrapper.find('vscode-single-select.dependency-select');
}

/** The "no candidates" hint of the dependency panel. */
function dependencyEmptyHint(wrapper: VueWrapper) {
  return wrapper.findAll('.dependency-status').find((node) => node.text() === 'No available issues');
}

describe('IssueDetail dependency picker', () => {
  beforeEach(() => {
    postMessageMock.mockClear();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('shows the empty hint once the repository issue list has been fetched without candidates', async () => {
    const wrapper = await mountView();
    await nextTick();

    // Nothing has been fetched yet: the picker is offered, but the panel must
    // not claim the repository has no issues.
    expect(dependencyEmptyHint(wrapper)).toBeUndefined();

    // The host answers the on-demand load with an empty list.
    window.dispatchEvent(
      new MessageEvent('message', {
        data: {
          command: 'repoIssues',
          instanceId: 'inst-1',
          owner: 'owner',
          repo: 'repoA',
          state: 'open',
          issues: [],
        },
      }),
    );
    await nextTick();

    expect(dependencyEmptyHint(wrapper)).toBeDefined();
    wrapper.unmount();
  });

  it('loads the repository issue list on demand, once, when the picker is opened', async () => {
    const wrapper = await mountView();
    await nextTick();

    // Opening the issue itself must not fetch the repository's whole issue
    // list: that is the on-demand contract the panel's comment documents.
    expect(repoIssuesRequests()).toHaveLength(0);

    await dependencySelect(wrapper).trigger('click');
    await nextTick();

    expect(repoIssuesRequests().map(([message]) => message)).toEqual([
      {
        command: 'getRepoIssues',
        instanceId: 'inst-1',
        owner: 'owner',
        repo: 'repoA',
        state: 'open',
        query: undefined,
      },
    ]);

    // A second open while the list is still fresh does not fire a second load:
    // the composable's TTL check dedups it, so the picker no longer needs its
    // own "already fetched" mark (which never expired).
    await dependencySelect(wrapper).trigger('click');
    expect(repoIssuesRequests()).toHaveLength(1);
    wrapper.unmount();
  });

  it('keeps the picker on screen while the list loads', async () => {
    // The picker is a control the user has already opened: replacing it with a
    // loading note one tick later would close the dropdown. Keyboard users are
    // the worst case, because the element opens from its own keydown with no
    // click to re-open it.
    const wrapper = await mountView();
    await nextTick();

    await dependencySelect(wrapper).trigger('click');
    await nextTick();

    expect(dependencySelect(wrapper).exists()).toBe(true);
    expect(wrapper.findAll('.dependency-status').some((node) => node.text() === 'Loading...')).toBe(true);

    // Opening it from the keyboard is what a keyboard user does: the element
    // opens from its own keydown, and the list load now rides along.
    await dependencySelect(wrapper).trigger('keydown', { key: 'Enter' });
    expect(dependencySelect(wrapper).exists()).toBe(true);
    wrapper.unmount();
  });

  it('warns when the repository issue list hit the paged cap', async () => {
    // Distinct from the load test above: 500 real options are needed, and
    // rendering them is what makes this one the slowest here.
    const wrapper = await mountView();
    await nextTick();

    // The reply is dispatched before the picker is ever opened: what is under
    // test here is the cap notice, not the load trigger.
    window.dispatchEvent(
      new MessageEvent('message', {
        data: {
          command: 'repoIssues',
          instanceId: 'inst-1',
          owner: 'owner',
          repo: 'repoA',
          state: 'open',
          issues: Array.from({ length: 500 }, (_, i) => ({
            id: i + 1,
            number: i + 1,
            title: `issue ${i + 1}`,
            state: 'open',
          })),
        },
      }),
    );
    await nextTick();

    expect(wrapper.text()).toContain('Only the first 500 issues are listed');
    wrapper.unmount();
  });

  it('asks the composable to load again on a later open, which refetches once the list is stale', async () => {
    const wrapper = await mountView();
    await nextTick();

    await dependencySelect(wrapper).trigger('click');
    expect(repoIssuesRequests()).toHaveLength(1);

    window.dispatchEvent(
      new MessageEvent('message', {
        data: { command: 'repoIssues', instanceId: 'inst-1', owner: 'owner', repo: 'repoA', state: 'open', issues: [] },
      }),
    );
    await nextTick();

    // Fresh list, second open: the composable's own TTL dedups the request. The
    // picker must not pre-empt that decision with its own "already fetched"
    // mark, which never expired and left the list frozen for the whole session.
    await dependencySelect(wrapper).trigger('click');
    expect(repoIssuesRequests()).toHaveLength(1);

    // Once the mark is stale the next open refetches. Fake timers start from the
    // wall clock so the composable's `Date.now()`-based freshness check sees the
    // same timestamps the real one did.
    vi.useFakeTimers({ now: Date.now() });
    try {
      await vi.advanceTimersByTimeAsync(31_000);
      await dependencySelect(wrapper).trigger('click');
      expect(repoIssuesRequests()).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
    wrapper.unmount();
  });
});
