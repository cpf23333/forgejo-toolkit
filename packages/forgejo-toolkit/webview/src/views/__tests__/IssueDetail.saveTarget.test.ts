import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mount } from '@vue/test-utils';
import { defineComponent, nextTick, reactive } from 'vue';
import { flushPromises } from '@vue/test-utils';

const { initialRouteParams, stateMock, keyFor } = vi.hoisted(() => {
  const keyFor = (...parts: unknown[]) => parts.join('|');
  return {
    keyFor,
    initialRouteParams: { instanceId: 'inst-1', owner: 'owner', repo: 'repoA', index: '5' },
    stateMock: {
      addIssueTime: vi.fn(),
      changeIssueReaction: vi.fn(),
      changeIssueSubscription: vi.fn(),
      commentReactions: { value: new Map() },
      copyToClipboard: vi.fn(),
      createIssueComment: vi.fn(),
      createIssueDependency: vi.fn(),
      deleteIssue: vi.fn(),
      deleteIssueAttachment: vi.fn(),
      deleteIssueTime: vi.fn(),
      editIssue: vi.fn(),
      errors: new Map(),
      instances: { value: [{ id: 'inst-1', url: 'https://forgejo.example.com', username: 'demo-user' }] },
      issueDependencies: { value: new Map() },
      issueDetails: { value: new Map() },
      issueReactions: { value: new Map() },
      issueSubscriptions: { value: new Map() },
      issueTrackedTimes: { value: new Map() },
      lastSavedIssue: { value: undefined },
      loadCommentReactions: vi.fn(),
      loadIssueDependencies: vi.fn(),
      loadIssueDetail: vi.fn(),
      loadIssueReactions: vi.fn(),
      loadIssueSubscription: vi.fn(),
      loadIssueTrackedTimes: vi.fn(),
      loadPullRequestComments: vi.fn(),
      loadRepoAssignees: vi.fn(),
      loadRepoIssues: vi.fn(),
      loadRepoLabels: vi.fn(),
      loadRepoMilestones: vi.fn(),
      loadUserStopwatches: vi.fn(),
      loading: new Map(),
      openExternal: vi.fn(),
      openIssueDetail: vi.fn(),
      pullRequestComments: { value: new Map() },
      removeIssueDependency: vi.fn(),
      renderMarkdown: vi.fn(async () => ''),
      repoAssignees: { value: new Map() },
      repoIssues: { value: new Map() },
      repoIssuesFetchedAt: { has: () => false, set: () => {}, delete: () => {} },
      repoLabels: { value: new Map() },
      repoMilestones: { value: new Map() },
      showConfirm: vi.fn(async () => true),
      startIssueStopwatch: vi.fn(),
      startWorkOnIssue: vi.fn(),
      stopIssueStopwatch: vi.fn(),
      toggleIssueState: vi.fn(),
      updateIssueDueDate: vi.fn(),
      uploadIssueAttachment: vi.fn(),
      uploadIssueCommentAttachment: vi.fn(),
      userStopwatches: { value: new Map() },
    },
  };
});

// The route is reactive so a test can move the user to another repository while
// the save handler is still deleting the issue's marked attachments.
vi.mock('vue-router', async () => {
  const { reactive: makeReactive } = await import('vue');
  const params = makeReactive({ ...initialRouteParams });
  return {
    useRoute: () => ({ params }),
    __params: params,
  };
});

vi.mock('../../composables/useAppState', async () => {
  const state = reactive(stateMock);
  const keyBuilder = (...parts: unknown[]) => keyFor(...parts);
  return {
    useAppState: () => state,
    issueDetailKey: keyBuilder,
    issueFormKey: keyBuilder,
    issueCommentFormKey: keyBuilder,
    commentReactionsKey: keyBuilder,
    issueCommentEditFormKey: keyBuilder,
    pullRequestCommentsKey: keyBuilder,
    repoLabelsKey: keyBuilder,
    repoAssigneesKey: keyBuilder,
    repoMilestonesKey: keyBuilder,
    repoIssuesKey: keyBuilder,
    issueSubscriptionKey: keyBuilder,
    issueTrackedTimesKey: keyBuilder,
    userStopwatchesKey: keyBuilder,
    issueDependenciesKey: keyBuilder,
    issueReactionsKey: keyBuilder,
    issueStateKey: keyBuilder,
    issueDueDateKey: keyBuilder,
    startWorkKey: keyBuilder,
  };
});

import IssueDetail from '../IssueDetail.vue';
import { useAppState } from '../../composables/useAppState';
import * as routerModule from 'vue-router';
import { createTestI18n } from '../../__tests__/helpers/test-utils';

const routeParams = (routerModule as unknown as { __params: Record<string, string> }).__params;

const state = useAppState() as unknown as Record<string, any>;

const EasyMdeEditorStub = defineComponent({
  name: 'EasyMdeEditor',
  props: { modelValue: { type: String, default: '' } },
  emits: ['update:modelValue'],
  template:
    '<textarea class="editor-stub" :value="modelValue" @input="$emit(\'update:modelValue\', $event.target.value)" />',
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
  return mount(IssueDetail, {
    global: {
      plugins: [createTestI18n('en')],
      stubs: { EasyMdeEditor: EasyMdeEditorStub, AttachmentList: AttachmentListStub },
    },
  });
}

/**
 * Saving an edited issue spans several requests: the marked attachments are
 * deleted first, then the detail is reloaded. `route.params` follows the global
 * route, so reading it again after that await would reload (and clear the
 * pending list of) whatever issue the user navigated to in the meantime.
 */
describe('IssueDetail save target', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    routeParams.instanceId = 'inst-1';
    routeParams.owner = 'owner';
    routeParams.repo = 'repoA';
    routeParams.index = '5';
    state.issueDetails.value.clear();
    state.issueDetails.value.set(keyFor('inst-1', 'owner', 'repoA', 5), {
      number: 5,
      title: 'an issue',
      user: { login: 'demo-user' },
      labels: [],
      assignees: [],
      assets: [],
    });
  });

  it('reloads the issue that was saved, not the one the user switched to', async () => {
    state.deleteIssueAttachment.mockImplementation(async () => {
      // The user switches repository while the attachment delete is in flight.
      routeParams.repo = 'repoB';
      return true;
    });

    const wrapper = mountView();
    await nextTick();

    // The edit dialog marks one attachment for deletion, then the host reports
    // the save.
    (wrapper.vm as unknown as { pendingDeleteAttachmentIds: number[] }).pendingDeleteAttachmentIds = [7];
    state.lastSavedIssue.value = { instanceId: 'inst-1', owner: 'owner', repo: 'repoA', index: 5 };
    await flushPromises();

    expect(state.deleteIssueAttachment.mock.calls[0].slice(0, 5)).toEqual(['inst-1', 'owner', 'repoA', 5, 7]);
    expect(state.loadIssueDetail).toHaveBeenCalledWith('inst-1', 'owner', 'repoA', 5, true);
    wrapper.unmount();
  });

  it('deletes the marked attachments of the issue that was saved', async () => {
    // The delete path has its own await before it knows which issue to address:
    // a route switch during it must not redirect the delete to the new issue.
    state.deleteIssueAttachment.mockImplementation(async () => {
      routeParams.repo = 'repoB';
      return true;
    });

    const wrapper = mountView();
    await nextTick();

    (wrapper.vm as unknown as { pendingDeleteAttachmentIds: number[] }).pendingDeleteAttachmentIds = [7, 8];
    state.lastSavedIssue.value = { instanceId: 'inst-1', owner: 'owner', repo: 'repoA', index: 5 };
    await flushPromises();

    expect(state.deleteIssueAttachment.mock.calls.map((call: unknown[]) => call.slice(0, 5))).toEqual([
      ['inst-1', 'owner', 'repoA', 5, 7],
      ['inst-1', 'owner', 'repoA', 5, 8],
    ]);
    wrapper.unmount();
  });

  it('drops the deleted attachments from the issue that was saved, not the one the user switched to', async () => {
    const savedIssue = state.issueDetails.value.get(keyFor('inst-1', 'owner', 'repoA', 5)) as {
      assets: { id?: number; uuid?: string }[];
    };
    savedIssue.assets = [
      { id: 7, uuid: 'uuid-7' },
      { id: 8, uuid: 'uuid-8' },
    ];
    state.issueDetails.value.set(keyFor('inst-1', 'owner', 'repoB', 6), {
      number: 6,
      title: 'another issue',
      user: { login: 'demo-user' },
      labels: [],
      assignees: [],
      assets: [{ id: 9, uuid: 'uuid-9' }],
    });

    state.deleteIssueAttachment.mockImplementation(async () => {
      // The user switches issue while the attachment delete is in flight.
      routeParams.repo = 'repoB';
      routeParams.index = '6';
      return true;
    });

    const wrapper = mountView();
    await nextTick();

    (wrapper.vm as unknown as { pendingDeleteAttachmentIds: number[] }).pendingDeleteAttachmentIds = [7];
    state.lastSavedIssue.value = { instanceId: 'inst-1', owner: 'owner', repo: 'repoA', index: 5 };
    await flushPromises();

    // The local list that must lose the deleted attachment is the saved issue's,
    // not the one the route points at now.
    expect(savedIssue.assets.map((asset) => asset.id)).toEqual([8]);
    const otherIssue = state.issueDetails.value.get(keyFor('inst-1', 'owner', 'repoB', 6)) as {
      assets: { id?: number; uuid?: string }[];
    };
    expect(otherIssue.assets.map((asset) => asset.id)).toEqual([9]);
    wrapper.unmount();
  });

  it('reports a failed save on the form of the issue that was saved', async () => {
    // A synchronous failure on the way into the delete (the host channel
    // rejecting) is what the watcher's catch handles: `deletePendingAttachments`
    // collects rejected deletes itself, so only this shape reaches the catch.
    state.deleteIssueAttachment.mockImplementation(() => {
      routeParams.repo = 'repoB';
      throw new Error('save failed');
    });

    const wrapper = mountView();
    await nextTick();

    (wrapper.vm as unknown as { pendingDeleteAttachmentIds: number[] }).pendingDeleteAttachmentIds = [7];
    state.lastSavedIssue.value = { instanceId: 'inst-1', owner: 'owner', repo: 'repoA', index: 5 };
    await flushPromises();

    expect(state.errors.get(keyFor('inst-1', 'owner', 'repoA', 5))).toContain('save failed');
    expect(state.errors.has(keyFor('inst-1', 'owner', 'repoB', 5))).toBe(false);
    wrapper.unmount();
  });
});

/**
 * The edit dialog uploads through two handlers (the editor's image picker and
 * the attachment list). Both span a request, and `route.params` follows the
 * global route: reading it again after the await would push the uploaded file
 * into the assets of whatever issue the user navigated to in the meantime.
 */
describe('IssueDetail upload target', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    routeParams.instanceId = 'inst-1';
    routeParams.owner = 'owner';
    routeParams.repo = 'repoA';
    routeParams.index = '5';
    state.errors.clear();
    state.issueDetails.value.clear();
    state.issueDetails.value.set(keyFor('inst-1', 'owner', 'repoA', 5), {
      number: 5,
      title: 'an issue',
      user: { login: 'demo-user' },
      labels: [],
      assignees: [],
      assets: [],
    });
    state.issueDetails.value.set(keyFor('inst-1', 'owner', 'repoB', 6), {
      number: 6,
      title: 'another issue',
      user: { login: 'demo-user' },
      labels: [],
      assignees: [],
      assets: [],
    });
  });

  type UploadHandlers = {
    handleUploadImage: (
      file: File,
      onSuccess: (url: string) => void,
      onError: (error: string) => void,
    ) => Promise<void>;
    handleAttachmentUpload: (file: File) => Promise<void>;
  };

  function mountWithHandlers() {
    const wrapper = mountView();
    return { wrapper, handlers: wrapper.vm as unknown as UploadHandlers };
  }

  // The user switches issue while the upload request is in flight.
  function switchIssueDuringUpload() {
    state.uploadIssueAttachment.mockImplementation(async () => {
      routeParams.repo = 'repoB';
      routeParams.index = '6';
      return { id: 1, uuid: 'uuid-1' };
    });
  }

  function assetsOf(key: string) {
    return (state.issueDetails.value.get(key) as { assets: { uuid?: string }[] }).assets;
  }

  it('attaches an image picked in the editor to the issue the form was opened for', async () => {
    switchIssueDuringUpload();
    const { wrapper, handlers } = mountWithHandlers();
    await nextTick();

    await handlers.handleUploadImage(
      new File(['x'], 'shot.png', { type: 'image/png' }),
      () => {},
      () => {},
    );

    expect(assetsOf(keyFor('inst-1', 'owner', 'repoA', 5)).map((asset) => asset.uuid)).toEqual(['uuid-1']);
    expect(assetsOf(keyFor('inst-1', 'owner', 'repoB', 6))).toEqual([]);
    wrapper.unmount();
  });

  it('attaches a file added to the attachment list to the issue the form was opened for', async () => {
    switchIssueDuringUpload();
    const { wrapper, handlers } = mountWithHandlers();
    await nextTick();

    await handlers.handleAttachmentUpload(new File(['x'], 'shot.png', { type: 'image/png' }));

    expect(assetsOf(keyFor('inst-1', 'owner', 'repoA', 5)).map((asset) => asset.uuid)).toEqual(['uuid-1']);
    expect(assetsOf(keyFor('inst-1', 'owner', 'repoB', 6))).toEqual([]);
    wrapper.unmount();
  });

  it('reports a failed attachment list upload on the form of that issue', async () => {
    state.uploadIssueAttachment.mockImplementation(async () => {
      routeParams.repo = 'repoB';
      routeParams.index = '6';
      throw new Error('upload failed');
    });
    const { wrapper, handlers } = mountWithHandlers();
    await nextTick();

    await handlers.handleAttachmentUpload(new File(['x'], 'shot.png', { type: 'image/png' }));

    expect(state.errors.get(keyFor('inst-1', 'owner', 'repoA', 5))).toContain('upload failed');
    expect(state.errors.has(keyFor('inst-1', 'owner', 'repoB', 6))).toBe(false);
    wrapper.unmount();
  });
});
