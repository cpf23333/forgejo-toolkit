import { describe, expect, it, vi, afterEach } from 'vitest';
import { computed, defineComponent, nextTick, reactive } from 'vue';
import { flushPromises, mount } from '@vue/test-utils';

const { stateMock, keyFor } = vi.hoisted(() => {
  const keyFor = (...parts: unknown[]) => parts.join('|');
  return {
    keyFor,
    stateMock: {
      loading: new Map<string, boolean>(),
      errors: new Map<string, string>(),
      repoIssues: { value: new Map<string, unknown[]>() },
      repoIssuesTotalCount: { value: new Map() },
      repoDetails: { value: new Map<string, unknown>() },
      repoLabels: { value: new Map<string, unknown>() },
      repoAssignees: { value: new Map<string, unknown>() },
      repoMilestones: { value: new Map<string, unknown>() },
      repoRefs: { value: new Map<string, unknown>() },
      pendingNewIssue: { value: undefined },
      loadRepoIssues: vi.fn(),
      loadRepoDetail: vi.fn(),
      loadRepoLabels: vi.fn(),
      loadRepoAssignees: vi.fn(),
      loadRepoMilestones: vi.fn(),
      loadRepoRefs: vi.fn(),
      changeRepoIssuesState: vi.fn(),
      consumePendingNewIssue: vi.fn(),
      createIssue: vi.fn(),
      editIssue: vi.fn(),
      openExternal: vi.fn(),
      openIssueDetail: vi.fn(),
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
    path: '/repo/inst-1/owner/repoA/issues/open',
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
    issueFormKey: keyBuilder,
    repoDetailKey: keyBuilder,
    repoIssuesKey: keyBuilder,
    repoLabelsKey: keyBuilder,
    repoAssigneesKey: keyBuilder,
    repoMilestonesKey: keyBuilder,
    repoRefsKey: keyBuilder,
  };
});

import * as routerModule from 'vue-router';
import RepoIssues from '../RepoIssues.vue';
import { useAppState } from '../../composables/useAppState';
import { createTestI18n } from '../../__tests__/helpers/test-utils';

const route = (routerModule as unknown as { __route: { path: string; params: Record<string, string> } }).__route;
const routeParams = route.params;
// The reactive store, not the raw mock: a payload written straight into the raw
// object would not invalidate the view's computeds, and a test about a reply
// arriving would then never see it arrive.
const state = useAppState() as unknown as typeof stateMock;

const ISSUES_PATH = '/repo/inst-1/owner/repoA/issues/open';
const ISSUE_DETAIL_PATH = '/issue/inst-1/owner/repoA/7';
const OTHER_REPO_ISSUES_PATH = '/repo/inst-1/owner/repoB/issues/open';
const KEY_A = keyFor('inst-1', 'owner', 'repoA', 'open', '');

const IssueFormStub = defineComponent({
  name: 'IssueForm',
  props: {
    uploadImage: { type: Function, default: undefined },
  },
  emits: ['submit', 'cancel', 'dirty'],
  template: '<div class="issue-form-stub"><slot name="extra" /></div>',
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
  return mount(RepoIssues, {
    global: {
      plugins: [createTestI18n('en')],
      stubs: { IssueForm: IssueFormStub, AttachmentList: AttachmentListStub },
    },
  });
}

/**
 * The app keeps this view alive under a key that contains the route path, so a
 * route change to another path both hides this instance and tells it that it is
 * no longer the active one.
 */
function mountKeepAliveView(path = ISSUES_PATH) {
  const View = defineComponent({
    components: { RepoIssues },
    setup() {
      return { show: computed(() => route.path === path) };
    },
    template: '<KeepAlive><RepoIssues v-if="show" /></KeepAlive>',
  });
  return mount(View, {
    global: {
      plugins: [createTestI18n('en')],
      stubs: { IssueForm: IssueFormStub, AttachmentList: AttachmentListStub },
    },
  });
}

function resetRoute() {
  route.path = ISSUES_PATH;
  routeParams.instanceId = 'inst-1';
  routeParams.owner = 'owner';
  routeParams.repo = 'repoA';
  routeParams.state = 'open';
  state.loading.clear();
  state.errors.clear();
  state.repoIssues.value.clear();
}

// The blob-URL test replaces the global URL helpers; restore them for every
// later test in this file (and in the worker, which shares globals).
afterEach(() => {
  vi.restoreAllMocks();
});

/**
 * Under keep-alive a view that no longer owns the active route keeps running
 * its watchers, while `route.params` follows the global route. The route change
 * that hides the view is also what changes `route`, and the display watcher is a
 * pre-flush watcher: it runs before `onDeactivated`, so a guard that reads a
 * lifecycle flag would still see the view as active and adopt the rows another
 * view loaded.
 */
describe('RepoIssues inactive list', () => {
  it('never adopts the rows of the repository the route moved to', async () => {
    vi.clearAllMocks();
    resetRoute();
    state.repoIssues.value.set(KEY_A, [
      { number: 1, title: 'shown row', state: 'open', updated_at: '2026-01-01T00:00:00Z' },
    ]);

    const wrapper = mountKeepAliveView();
    await nextTick();
    expect(wrapper.text()).toContain('shown row');

    // The user opens another repository's issue list. That hides this instance
    // (the keep-alive key is the route path) and moves `route` in the same
    // flush, and the other list arrives while this one is off screen.
    route.path = OTHER_REPO_ISSUES_PATH;
    routeParams.repo = 'repoB';
    state.repoIssues.value.set(keyFor('inst-1', 'owner', 'repoB', 'open', ''), [
      { number: 2, title: 'adopted row', state: 'open', updated_at: '2026-01-01T00:00:00Z' },
    ]);
    await flushPromises();

    // Coming back: navigating between repositories released repoA's payload, so
    // the list is refetched and the previous rows must stay on screen while it
    // is in flight.
    state.repoIssues.value.delete(KEY_A);
    state.loading.set(KEY_A, true);
    route.path = ISSUES_PATH;
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

    // The user opens an issue of the same repository while the list request is
    // still in flight: the path changes, the list key does not.
    route.path = ISSUE_DETAIL_PATH;
    await flushPromises();

    // The reply lands while the list is off screen; nothing it watches will
    // change again when the user comes back to a key that never changed.
    state.repoIssues.value.set(KEY_A, [
      { number: 1, title: 'shown row', state: 'open', updated_at: '2026-01-01T00:00:00Z' },
    ]);
    state.loading.set(KEY_A, false);
    await flushPromises();

    route.path = ISSUES_PATH;
    await flushPromises();

    expect(wrapper.text()).toContain('shown row');
    wrapper.unmount();
  });
});

/**
 * The create dialog spans several requests (create the issue, upload its
 * attachments, rewrite its body). `route.params` follows the global route, so
 * reading it again after an await would post the attachment to whatever
 * repository the user navigated to in the meantime.
 */
describe('RepoIssues create dialog target', () => {
  it('uploads attachments to the repository the form was opened for', async () => {
    vi.clearAllMocks();
    routeParams.instanceId = 'inst-1';
    routeParams.owner = 'owner';
    routeParams.repo = 'repoA';
    state.createIssue.mockImplementation(async () => {
      // The user switches repository while the create request is in flight.
      routeParams.repo = 'repoB';
      return { number: 7 };
    });
    state.uploadIssueAttachment.mockResolvedValue({ id: 1, uuid: 'uuid-1' });

    const wrapper = mountView();
    await nextTick();
    wrapper.findComponent(AttachmentListStub).vm.$emit('upload', new File(['x'], 'shot.png', { type: 'image/png' }));
    await nextTick();

    wrapper.findComponent(IssueFormStub).vm.$emit('submit', { title: 'New issue', body: 'body' });
    await flushPromises();

    expect(state.createIssue).toHaveBeenCalledWith(
      'inst-1',
      'owner',
      'repoA',
      expect.objectContaining({ title: 'New issue' }),
    );
    const uploadCall = state.uploadIssueAttachment.mock.calls[0];
    expect(uploadCall.slice(0, 4)).toEqual(['inst-1', 'owner', 'repoA', 7]);
    expect(state.openIssueDetail).toHaveBeenCalledWith('inst-1', 'owner', 'repoA', 7);
    wrapper.unmount();
  });

  it('strips the blob URL of a pending image the user removed before submitting', async () => {
    vi.clearAllMocks();
    routeParams.instanceId = 'inst-1';
    routeParams.owner = 'owner';
    routeParams.repo = 'repoA';
    state.createIssue.mockResolvedValue({ number: 7 });
    let objectUrlSeq = 0;
    URL.createObjectURL = vi.fn(() => `blob:pending-${++objectUrlSeq}`) as unknown as typeof URL.createObjectURL;
    URL.revokeObjectURL = vi.fn() as unknown as typeof URL.revokeObjectURL;

    const wrapper = mountView();
    await nextTick();

    // The editor's image picker hands the file to the view, which returns the
    // object URL the editor then writes into the body.
    const file = new File(['x'], 'shot.png', { type: 'image/png' });
    const uploadImage = wrapper.findComponent(IssueFormStub).props('uploadImage') as (
      picked: File,
      onSuccess: (url: string) => void,
      onError: (error: string) => void,
    ) => void;
    expect(uploadImage).toBeTypeOf('function');
    let objectUrl = '';
    uploadImage(
      file,
      (url) => (objectUrl = url),
      () => {},
    );
    await nextTick();
    expect(objectUrl).toBe('blob:pending-1');

    // The user removes the image again, but it is still referenced by the body.
    await wrapper.find('.pending-attachment-remove').trigger('click');
    await nextTick();

    wrapper.findComponent(IssueFormStub).vm.$emit('submit', {
      title: 'New issue',
      body: `before ![image](${objectUrl}) after`,
    });
    await flushPromises();

    // No upload happened, so the stored body must not keep the session blob URL.
    expect(state.uploadIssueAttachment).not.toHaveBeenCalled();
    expect(state.editIssue).toHaveBeenCalledWith(
      'inst-1',
      'owner',
      'repoA',
      7,
      expect.objectContaining({ body: 'before  after' }),
    );
    wrapper.unmount();
  });

  it('reports a failed submit on the form that was submitted', async () => {
    vi.clearAllMocks();
    resetRoute();
    state.createIssue.mockImplementation(async () => {
      // The user switches repository while the create request is in flight.
      routeParams.repo = 'repoB';
      throw new Error('create failed');
    });

    const wrapper = mountView();
    await nextTick();
    wrapper.findComponent(IssueFormStub).vm.$emit('submit', { title: 'New issue', body: 'body' });
    await flushPromises();

    // The failure belongs to the repoA form the user submitted, not to the form
    // of the repository the route points at now.
    expect(state.errors.get(keyFor('inst-1', 'owner', 'repoA', 0))).toContain('create failed');
    expect(state.errors.has(keyFor('inst-1', 'owner', 'repoB', 0))).toBe(false);
    wrapper.unmount();
  });
});
