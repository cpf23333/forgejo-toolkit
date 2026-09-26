import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mount } from '@vue/test-utils';
import { defineComponent, nextTick, reactive } from 'vue';
import { flushPromises } from '@vue/test-utils';

const { initialRouteParams, stateMock, keyFor } = vi.hoisted(() => {
  const keyFor = (...parts: unknown[]) => parts.join('|');
  const params: Record<string, string> = { instanceId: 'inst-1', owner: 'owner', repo: 'repoA', index: '5' };
  return {
    keyFor,
    initialRouteParams: params,
    stateMock: {
      addIssueTime: vi.fn(),
      changeIssueReaction: vi.fn(),
      changeIssueSubscription: vi.fn(),
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
      commentReactions: { value: new Map() },
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
      repoIssuesTotalCount: { value: new Map() },
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
// a request from the comment form is still in flight.
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
    // Distinct from the timeline's key: the real composable keys the comment
    // form's error separately, and sharing one key here would hide the whole
    // comment section (timeline included) as soon as a post failed.
    issueCommentFormKey: (...parts: unknown[]) => `comment-form|${keyFor(...parts)}`,
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

function postButton(wrapper: ReturnType<typeof mountView>) {
  return wrapper.find('.comment-form-actions vscode-button');
}

/** The comment form's error slot for one repository. */
function commentFormKey(repo: string): string {
  return `comment-form|${keyFor('inst-1', 'owner', repo, 5)}`;
}

/**
 * Posting a comment spans several requests (create the comment, upload its
 * attachments). `route.params` follows the global route, so reading it again
 * after an await would attach the files to whatever issue the user navigated to
 * in the meantime.
 */
describe('IssueDetail comment attachment target', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    routeParams.instanceId = 'inst-1';
    routeParams.owner = 'owner';
    routeParams.repo = 'repoA';
    routeParams.index = '5';
    state.issueDetails.value.clear();
    state.pullRequestComments.value.clear();
    state.errors.clear();
    // The timeline must have loaded, or the comment form is not rendered.
    state.pullRequestComments.value.set(keyFor('inst-1', 'owner', 'repoA', 5), []);
    state.issueDetails.value.set(keyFor('inst-1', 'owner', 'repoA', 5), {
      number: 5,
      title: 'an issue',
      user: { login: 'demo-user' },
      labels: [],
      assignees: [],
    });
  });

  it('uploads comment attachments to the issue the form was opened for', async () => {
    state.createIssueComment.mockImplementation(async () => {
      // The user switches repository while the create request is in flight.
      routeParams.repo = 'repoB';
      return { id: 11 };
    });
    state.uploadIssueCommentAttachment.mockResolvedValue({ id: 1, uuid: 'uuid-1' });

    const wrapper = mountView();
    await nextTick();

    wrapper
      .find('.comment-form-attachments')
      .findComponent(AttachmentListStub)
      .vm.$emit('upload', new File(['x'], 'shot.png', { type: 'image/png' }));
    await nextTick();
    await wrapper.find('.comment-form .editor-stub').setValue('a comment');
    await nextTick();

    await postButton(wrapper).trigger('click');
    await flushPromises();

    expect(state.createIssueComment).toHaveBeenCalledWith('inst-1', 'owner', 'repoA', 5, 'a comment');
    const uploadCall = state.uploadIssueCommentAttachment.mock.calls[0];
    expect(uploadCall.slice(0, 5)).toEqual(['inst-1', 'owner', 'repoA', 5, 11]);
    wrapper.unmount();
  });

  it('reports a failed comment on the form that was submitted', async () => {
    state.createIssueComment.mockImplementation(async () => {
      // The user switches issue while the create request is in flight.
      routeParams.repo = 'repoB';
      throw new Error('comment failed');
    });

    const wrapper = mountView();
    await nextTick();
    await wrapper.find('.comment-form .editor-stub').setValue('a comment');
    await nextTick();

    await postButton(wrapper).trigger('click');
    await flushPromises();

    // The failure belongs to the repoA form the user submitted, not to the form
    // of the issue the route points at now.
    expect(state.errors.get(commentFormKey('repoA'))).toContain('comment failed');
    expect(state.errors.has(commentFormKey('repoB'))).toBe(false);
    wrapper.unmount();
  });

  it('reports a failed comment attachment on the form that was submitted', async () => {
    state.createIssueComment.mockResolvedValue({ id: 11 });
    state.uploadIssueCommentAttachment.mockImplementation(async () => {
      // The user switches issue while the attachment upload is in flight.
      routeParams.repo = 'repoB';
      throw new Error('upload failed');
    });

    const wrapper = mountView();
    await nextTick();

    wrapper
      .find('.comment-form-attachments')
      .findComponent(AttachmentListStub)
      .vm.$emit('upload', new File(['x'], 'shot.png', { type: 'image/png' }));
    await nextTick();
    await wrapper.find('.comment-form .editor-stub').setValue('a comment');
    await nextTick();

    await postButton(wrapper).trigger('click');
    await flushPromises();

    expect(state.errors.has(commentFormKey('repoA'))).toBe(true);
    expect(state.errors.has(commentFormKey('repoB'))).toBe(false);
    wrapper.unmount();
  });

  it('clears the failed-attachment notice once a retry uploads everything', async () => {
    state.createIssueComment.mockResolvedValue({ id: 11 });
    state.uploadIssueCommentAttachment
      .mockRejectedValueOnce(new Error('upload failed'))
      .mockResolvedValue({ id: 1, uuid: 'uuid-1' });

    const wrapper = mountView();
    await nextTick();

    wrapper
      .find('.comment-form-attachments')
      .findComponent(AttachmentListStub)
      .vm.$emit('upload', new File(['x'], 'shot.png', { type: 'image/png' }));
    await nextTick();
    await wrapper.find('.comment-form .editor-stub').setValue('a comment');
    await nextTick();

    await postButton(wrapper).trigger('click');
    await flushPromises();

    const key = commentFormKey('repoA');
    expect(state.errors.get(key)).toContain('failed to upload');

    // The retry reuses the posted comment (no second create) and uploads the
    // file that failed; the notice must not outlive the failure it reported.
    await postButton(wrapper).trigger('click');
    await flushPromises();

    expect(state.createIssueComment).toHaveBeenCalledTimes(1);
    expect(state.uploadIssueCommentAttachment).toHaveBeenCalledTimes(2);
    expect(state.errors.has(key)).toBe(false);
    wrapper.unmount();
  });
});
