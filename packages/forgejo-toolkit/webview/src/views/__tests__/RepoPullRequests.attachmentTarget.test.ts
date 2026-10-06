import { describe, expect, it, vi } from 'vitest';
import { computed, defineComponent, nextTick, reactive } from 'vue';
import { flushPromises, mount } from '@vue/test-utils';

const { stateMock, keyFor } = vi.hoisted(() => {
  const keyFor = (...parts: unknown[]) => parts.join('|');
  return {
    keyFor,
    stateMock: {
      loading: new Map<string, boolean>(),
      errors: new Map<string, string>(),
      repoPullRequests: { value: new Map<string, unknown[]>() },
      repoPullRequestsTotalCount: { value: new Map() },
      repoDetails: { value: new Map<string, unknown>() },
      repoLabels: { value: new Map<string, unknown>() },
      repoAssignees: { value: new Map<string, unknown>() },
      repoMilestones: { value: new Map<string, unknown>() },
      pendingCreatePr: { value: undefined },
      loadRepoPullRequests: vi.fn(),
      loadRepoDetail: vi.fn(),
      loadRepoLabels: vi.fn(),
      loadRepoAssignees: vi.fn(),
      loadRepoMilestones: vi.fn(),
      changeRepoPullRequestsState: vi.fn(),
      consumePendingCreatePr: vi.fn(),
      // The create form offers its "Generate description" control on this flag, which
      // the host derives (it is already false while a scope that needs an existing
      // pull request is configured); the run reads the settings itself, so a test
      // that is about the form only has to say whether the control exists.
      prDescriptionCreateForm: { value: false },
      createPullRequest: vi.fn(),
      editPullRequest: vi.fn(),
      openExternal: vi.fn(),
      openPullRequestDetail: vi.fn(),
      uploadIssueAttachment: vi.fn(),
    },
  };
});

// The route is reactive so a test can move the user to another repository while
// a request from the create dialog is still in flight, and so a test can move
// the view off screen the way the app does: the keep-alive key is the route
// path, which is how the view recognizes its own route.
vi.mock('vue-router', async () => {
  const { reactive: makeReactive } = await import('vue');
  const route = makeReactive({
    path: '/repo/inst-1/owner/repoA/pulls/open',
    params: { instanceId: 'inst-1', owner: 'owner', repo: 'repoA', state: 'open' },
  });
  return {
    useRoute: () => route,
    useRouter: () => ({ push: vi.fn() }),
    __route: route,
  };
});

vi.mock('../../composables/useAppState', async () => {
  const state = reactive(stateMock);
  const keyBuilder = (...parts: unknown[]) => keyFor(...parts);
  return {
    useAppState: () => state,
    pullRequestFormKey: keyBuilder,
    repoDetailKey: keyBuilder,
    repoLabelsKey: keyBuilder,
    repoAssigneesKey: keyBuilder,
    repoMilestonesKey: keyBuilder,
    repoPullRequestsKey: keyBuilder,
  };
});

import * as routerModule from 'vue-router';
import RepoPullRequests from '../RepoPullRequests.vue';
import { useAppState } from '../../composables/useAppState';
import { createTestI18n } from '../../__tests__/helpers/test-utils';

const route = (routerModule as unknown as { __route: { path: string; params: Record<string, string> } }).__route;
const routeParams = route.params;
// The reactive store, not the raw mock: a payload written straight into the raw
// object would not invalidate the view's computeds, and a test about a reply
// arriving would then never see it arrive.
const state = useAppState() as unknown as typeof stateMock;

const PULLS_PATH = '/repo/inst-1/owner/repoA/pulls/open';
const PULL_DETAIL_PATH = '/pull/inst-1/owner/repoA/7';
const OTHER_REPO_PULLS_PATH = '/repo/inst-1/owner/repoB/pulls/open';
const KEY_A = keyFor('inst-1', 'owner', 'repoA', 'open', '');

const PullRequestFormStub = defineComponent({
  name: 'PullRequestForm',
  props: {
    uploadImage: { type: Function, default: undefined },
  },
  emits: ['submit', 'cancel', 'dirty'],
  template: '<div class="pr-form-stub"><slot name="extra" /></div>',
});

const AttachmentListStub = defineComponent({
  name: 'AttachmentList',
  props: {
    assets: { type: Array, default: () => [] },
    allowUpload: { type: Boolean, default: false },
    allowDelete: { type: Boolean, default: false },
    uploading: { type: Boolean, default: false },
  },
  emits: ['upload', 'delete', 'openExternal'],
  template: '<div class="attachment-list-stub" />',
});

function mountView() {
  return mount(RepoPullRequests, {
    global: {
      plugins: [createTestI18n('en')],
      stubs: { PullRequestForm: PullRequestFormStub, AttachmentList: AttachmentListStub },
    },
  });
}

/**
 * The app keeps this view alive under a key that contains the route path, so a
 * route change to another path both hides this instance and tells it that it is
 * no longer the active one.
 */
function mountKeepAliveView(path = PULLS_PATH) {
  const View = defineComponent({
    components: { RepoPullRequests },
    setup() {
      return { show: computed(() => route.path === path) };
    },
    template: '<KeepAlive><RepoPullRequests v-if="show" /></KeepAlive>',
  });
  return mount(View, {
    global: {
      plugins: [createTestI18n('en')],
      stubs: { PullRequestForm: PullRequestFormStub, AttachmentList: AttachmentListStub },
    },
  });
}

function resetRoute() {
  route.path = PULLS_PATH;
  routeParams.instanceId = 'inst-1';
  routeParams.owner = 'owner';
  routeParams.repo = 'repoA';
  routeParams.state = 'open';
  state.loading.clear();
  state.errors.clear();
  state.repoPullRequests.value.clear();
}

/**
 * The create dialog spans several requests (create the pull request, upload its
 * attachments, rewrite its body). `route.params` follows the global route, so
 * reading it again after an await would post the attachment to whatever
 * repository the user navigated to in the meantime.
 */
describe('RepoPullRequests create dialog target', () => {
  it('uploads attachments to the repository the form was opened for', async () => {
    vi.clearAllMocks();
    routeParams.instanceId = 'inst-1';
    routeParams.owner = 'owner';
    routeParams.repo = 'repoA';
    state.createPullRequest.mockImplementation(async () => {
      // The user switches repository while the create request is in flight.
      routeParams.repo = 'repoB';
      return { number: 7 };
    });
    state.uploadIssueAttachment.mockResolvedValue({ id: 1, uuid: 'uuid-1' });

    const wrapper = mountView();
    await nextTick();
    wrapper.findComponent(AttachmentListStub).vm.$emit('upload', new File(['x'], 'shot.png', { type: 'image/png' }));
    await nextTick();

    wrapper.findComponent(PullRequestFormStub).vm.$emit('submit', {
      title: 'New pull request',
      body: 'body',
      assignees: [],
      labels: [],
    });
    await flushPromises();

    expect(state.createPullRequest).toHaveBeenCalledWith(
      'inst-1',
      'owner',
      'repoA',
      expect.objectContaining({ title: 'New pull request' }),
    );
    const uploadCall = state.uploadIssueAttachment.mock.calls[0];
    expect(uploadCall.slice(0, 4)).toEqual(['inst-1', 'owner', 'repoA', 7]);
    expect(state.openPullRequestDetail).toHaveBeenCalledWith('inst-1', 'owner', 'repoA', 7);
    wrapper.unmount();
  });

  it('reports a failed submit on the form that was submitted', async () => {
    vi.clearAllMocks();
    resetRoute();
    state.createPullRequest.mockImplementation(async () => {
      // The user switches repository while the create request is in flight.
      routeParams.repo = 'repoB';
      throw new Error('create failed');
    });

    const wrapper = mountView();
    await nextTick();
    wrapper.findComponent(PullRequestFormStub).vm.$emit('submit', {
      title: 'New pull request',
      body: 'body',
      assignees: [],
      labels: [],
    });
    await flushPromises();

    // The failure belongs to the repoA form the user submitted, not to the form
    // of the repository the route points at now.
    expect(state.errors.get(keyFor('inst-1', 'owner', 'repoA', 0))).toContain('create failed');
    expect(state.errors.has(keyFor('inst-1', 'owner', 'repoB', 0))).toBe(false);
    wrapper.unmount();
  });
});

/**
 * Under keep-alive a view that no longer owns the active route keeps running
 * its watchers, while `route.params` follows the global route. The route change
 * that hides the view is also what changes `route`, and the display watcher is a
 * pre-flush watcher: it runs before `onDeactivated`, so a guard that reads a
 * lifecycle flag would still see the view as active and adopt the rows another
 * view loaded.
 */
describe('RepoPullRequests inactive list', () => {
  it('never adopts the rows of the repository the route moved to', async () => {
    vi.clearAllMocks();
    resetRoute();
    state.repoPullRequests.value.set(KEY_A, [
      { number: 1, title: 'shown row', state: 'open', updated_at: '2026-01-01T00:00:00Z' },
    ]);

    const wrapper = mountKeepAliveView();
    await nextTick();
    expect(wrapper.text()).toContain('shown row');

    // The user opens another repository's pull request list. That hides this
    // instance (the keep-alive key is the route path) and moves `route` in the
    // same flush, and the other list arrives while this one is off screen.
    route.path = OTHER_REPO_PULLS_PATH;
    routeParams.repo = 'repoB';
    state.repoPullRequests.value.set(keyFor('inst-1', 'owner', 'repoB', 'open', ''), [
      { number: 2, title: 'adopted row', state: 'open', updated_at: '2026-01-01T00:00:00Z' },
    ]);
    await flushPromises();

    // Coming back: navigating between repositories released repoA's payload, so
    // the list is refetched and the previous rows must stay on screen while it
    // is in flight.
    state.repoPullRequests.value.delete(KEY_A);
    state.loading.set(KEY_A, true);
    route.path = PULLS_PATH;
    routeParams.repo = 'repoA';
    await flushPromises();

    expect(wrapper.text()).toContain('shown row');
    expect(wrapper.text()).not.toContain('adopted row');
    wrapper.unmount();
  });

  it('shows the rows that arrived while it was off screen', async () => {
    vi.clearAllMocks();
    resetRoute();

    const wrapper = mountKeepAliveView();
    await nextTick();

    // The user opens a pull request of the same repository while the list
    // request is still in flight: the path changes, the list key does not.
    route.path = PULL_DETAIL_PATH;
    await flushPromises();

    // The reply lands while the list is off screen; nothing it watches will
    // change again when the user comes back to a key that never changed.
    state.repoPullRequests.value.set(KEY_A, [
      { number: 1, title: 'shown row', state: 'open', updated_at: '2026-01-01T00:00:00Z' },
    ]);
    state.loading.set(KEY_A, false);
    await flushPromises();

    route.path = PULLS_PATH;
    await flushPromises();

    expect(wrapper.text()).toContain('shown row');
    wrapper.unmount();
  });
});
