import { describe, it, expect, vi, beforeEach } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { defineComponent, nextTick, reactive } from 'vue';

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

vi.mock('vue-router', async () => {
  const { reactive: makeReactive } = await import('vue');
  const params = makeReactive({ ...initialRouteParams });
  return { useRoute: () => ({ params }), __params: params };
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
import * as routerModule from 'vue-router';
import { useAppState } from '../../composables/useAppState';
import { createTestI18n } from '../../__tests__/helpers/test-utils';

const routeParams = (routerModule as unknown as { __params: Record<string, string> }).__params;
const state = useAppState() as unknown as Record<string, any>;

// Keeps the upload handler reachable from the test while still feeding the
// editor's `update:modelValue` back into the view, the way the real editor
// writes into the body when a user types.
const EasyMdeEditorStub = defineComponent({
  name: 'EasyMdeEditor',
  props: {
    modelValue: { type: String, default: '' },
    uploadImage: { type: Function, default: undefined },
  },
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

function commentEditor(wrapper: ReturnType<typeof mountView>) {
  return wrapper.find('.comment-form').findComponent(EasyMdeEditorStub);
}

function commentBody(wrapper: ReturnType<typeof mountView>): string {
  return (wrapper.find('.comment-form .editor-stub').element as HTMLTextAreaElement).value;
}

/**
 * The editor uploads an image and inserts `![image](url)` into the comment body
 * only when the request returns: two independent round-trips. Posting the
 * comment while the upload is still in flight serialises a body that predates
 * the image, and the markdown the user just inserted never reaches the server.
 * The post must wait for the upload (the same way the issue and pull request
 * edit forms already do).
 */
describe('IssueDetail comment submit waits for an in-flight image upload', () => {
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
      assets: [],
    });
    state.createIssueComment.mockResolvedValue({ id: 11 });
  });

  it('posts the body the editor holds once the upload has inserted its image', async () => {
    let resolveUpload!: (attachment: { uuid: string }) => void;
    state.uploadIssueAttachment.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveUpload = resolve;
        }),
    );

    const wrapper = mountView();
    await nextTick();
    await wrapper.find('.comment-form .editor-stub').setValue('see this');

    // The user picks an image; its request is still in flight.
    const upload = commentEditor(wrapper).props('uploadImage') as (
      file: File,
      onSuccess: (url: string) => void,
      onError: (error: string) => void,
    ) => void;
    upload(
      new File(['x'], 'shot.png', { type: 'image/png' }),
      (url) => {
        // What EasyMdeEditor's imageUploadFunction does on success.
        void wrapper.find('.comment-form .editor-stub').setValue(`see this\n\n![image](${url})`);
      },
      () => {},
    );
    await nextTick();

    // The post is issued while the upload is running.
    await wrapper.find('.comment-form-actions vscode-button').trigger('click');
    await nextTick();

    expect(state.createIssueComment).not.toHaveBeenCalled();

    resolveUpload({ uuid: 'uuid-1' });
    await flushPromises();

    expect(state.createIssueComment).toHaveBeenCalledTimes(1);
    const body = state.createIssueComment.mock.calls[0][4] as string;
    expect(body).toContain('![image](/attachments/uuid-1)');
    expect(commentBody(wrapper)).toBe('');
    wrapper.unmount();
  });

  it('posts immediately when no upload is in flight', async () => {
    const wrapper = mountView();
    await nextTick();
    await wrapper.find('.comment-form .editor-stub').setValue('a comment');

    await wrapper.find('.comment-form-actions vscode-button').trigger('click');
    await flushPromises();

    expect(state.createIssueComment).toHaveBeenCalledWith('inst-1', 'owner', 'repoA', 5, 'a comment');
    wrapper.unmount();
  });
});
