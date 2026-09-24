import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mount } from '@vue/test-utils';
import { nextTick, reactive } from 'vue';
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
      deleteIssueAttachment: vi.fn(),
      deleteIssueTime: vi.fn(),
      editPullRequest: vi.fn(),
      errors: new Map(),
      instances: { value: [{ id: 'inst-1', url: 'https://forgejo.example.com', username: 'demo-user' }] },
      issueDependencies: { value: new Map() },
      issueReactions: { value: new Map() },
      issueSubscriptions: { value: new Map() },
      issueTrackedTimes: { value: new Map() },
      lastSavedPullRequest: { value: undefined },
      lastWorktreeCancelled: { value: undefined },
      lastWorktreeError: { value: undefined },
      loadCommentReactions: vi.fn(),
      loadIssueDependencies: vi.fn(),
      loadIssueReactions: vi.fn(),
      loadIssueSubscription: vi.fn(),
      loadIssueTrackedTimes: vi.fn(),
      loadPullRequestComments: vi.fn(),
      loadPullRequestCommits: vi.fn(),
      loadPullRequestDetail: vi.fn(),
      loadPullRequestFiles: vi.fn(),
      loadRepoAssignees: vi.fn(),
      loadRepoDetail: vi.fn(),
      loadRepoIssues: vi.fn(),
      loadRepoLabels: vi.fn(),
      loadRepoMilestones: vi.fn(),
      loadUserStopwatches: vi.fn(),
      loading: new Map(),
      mergePullRequest: vi.fn(),
      openExternal: vi.fn(),
      openIssueDetail: vi.fn(),
      openPrWorktree: vi.fn(),
      openPullRequestDiff: vi.fn(),
      openSelectedPullRequestDiffs: vi.fn(),
      pullRequestComments: { value: new Map() },
      pullRequestCommits: { value: new Map() },
      pullRequestDetails: { value: new Map() },
      pullRequestFiles: { value: new Map() },
      removeIssueDependency: vi.fn(),
      renderMarkdown: vi.fn(async () => ''),
      repoAssignees: { value: new Map() },
      repoDetails: { value: new Map() },
      repoIssues: { value: new Map() },
      repoIssuesFetchedAt: { has: () => false, set: () => {}, delete: () => {} },
      repoLabels: { value: new Map() },
      repoMilestones: { value: new Map() },
      revertMergeCommit: vi.fn(),
      showConfirm: vi.fn(async () => true),
      startIssueStopwatch: vi.fn(),
      stopIssueStopwatch: vi.fn(),
      supportsMultiDiff: { value: false },
      togglePullRequestState: vi.fn(),
      updatePullRequestDueDate: vi.fn(),
      uploadIssueAttachment: vi.fn(),
      uploadIssueCommentAttachment: vi.fn(),
      userStopwatches: { value: new Map() },
      worktrees: { value: [] },
    },
  };
});

// The route is reactive so a test can move the user to another repository while
// the save handler is still deleting the pull request's marked attachments.
// `path` is the key App.vue caches each keep-alive view under: a cached view of
// another pull request is recognised by its path, not by the (already moved)
// live params.
vi.mock('vue-router', async () => {
  const { reactive: makeReactive } = await import('vue');
  const params = makeReactive({ ...initialRouteParams });
  const route = makeReactive({ params, path: '/pull/inst-1/owner/repoA/5' });
  return {
    useRoute: () => route,
    useRouter: () => ({ push: vi.fn() }),
    __params: params,
    __route: route,
  };
});

vi.mock('../../composables/useAppState', async () => {
  const state = reactive(stateMock);
  const keyBuilder = (...parts: unknown[]) => keyFor(...parts);
  return {
    useAppState: () => state,
    pullRequestDetailKey: keyBuilder,
    pullRequestFilesKey: keyBuilder,
    pullRequestCommentsKey: keyBuilder,
    pullRequestCommitsKey: keyBuilder,
    pullRequestFormKey: keyBuilder,
    pullRequestStateKey: keyBuilder,
    pullRequestDueDateKey: keyBuilder,
    pullRequestMergeFormKey: keyBuilder,
    issueCommentFormKey: keyBuilder,
    repoDetailKey: keyBuilder,
    repoLabelsKey: keyBuilder,
    repoAssigneesKey: keyBuilder,
    repoMilestonesKey: keyBuilder,
    repoIssuesKey: keyBuilder,
    issueSubscriptionKey: keyBuilder,
    issueTrackedTimesKey: keyBuilder,
    userStopwatchesKey: keyBuilder,
    issueDependenciesKey: keyBuilder,
    issueReactionsKey: keyBuilder,
  };
});

import PullRequestDetail from '../PullRequestDetail.vue';
import { useAppState } from '../../composables/useAppState';
import * as routerModule from 'vue-router';
import { createTestI18n } from '../../__tests__/helpers/test-utils';

const routeParams = (routerModule as unknown as { __params: Record<string, string> }).__params;
const testRoute = (routerModule as unknown as { __route: { path: string } }).__route;

/** Paths App.vue would key the keep-alive entries with, one per pull request. */
const OWN_PR_PATH = '/pull/inst-1/owner/repoA/5';
const OTHER_PR_PATH = '/pull/inst-1/owner/repoA/6';

const state = useAppState() as unknown as Record<string, any>;

function mountView() {
  return mount(PullRequestDetail, {
    global: {
      plugins: [createTestI18n('en')],
      stubs: {
        AttachmentList: true,
        CollapsibleSection: true,
        CommentTimeline: true,
        CommitDiffList: true,
        DateTimePicker: true,
        DiffFileList: true,
        EasyMdeEditor: true,
        MarkdownBody: true,
        ModalDialog: true,
        PendingAttachmentList: true,
        PullRequestForm: true,
        ReactionBar: true,
      },
    },
  });
}

/**
 * Saving an edited pull request spans several requests: the marked attachments
 * are deleted first, then the detail is reloaded. `route.params` follows the
 * global route, so reading it again after that await would delete and reload
 * against whatever pull request the user navigated to in the meantime.
 */
describe('PullRequestDetail save target', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    routeParams.instanceId = 'inst-1';
    routeParams.owner = 'owner';
    routeParams.repo = 'repoA';
    routeParams.index = '5';
    testRoute.path = OWN_PR_PATH;
    state.pullRequestDetails.value.clear();
    state.pullRequestComments.value.clear();
    state.errors.clear();
    state.pullRequestDetails.value.set(keyFor('inst-1', 'owner', 'repoA', 5), {
      number: 5,
      title: 'a pull request',
      state: 'open',
      user: { login: 'demo-user' },
      base: { sha: 'base-sha' },
      head: { sha: 'head-sha' },
      labels: [],
      assignees: [],
      assets: [],
    });
  });

  it('deletes the marked attachments of the pull request that was saved', async () => {
    // The delete path has its own await before it knows which pull request to
    // address: a route switch during it must not redirect the delete.
    state.deleteIssueAttachment.mockImplementation(async () => {
      routeParams.repo = 'repoB';
      return true;
    });

    const wrapper = mountView();
    await nextTick();

    (wrapper.vm as unknown as { pendingDeleteAttachmentIds: number[] }).pendingDeleteAttachmentIds = [7, 8];
    state.lastSavedPullRequest.value = { instanceId: 'inst-1', owner: 'owner', repo: 'repoA', index: 5 };
    await flushPromises();

    expect(state.deleteIssueAttachment.mock.calls.map((call: unknown[]) => call.slice(0, 5))).toEqual([
      ['inst-1', 'owner', 'repoA', 5, 7],
      ['inst-1', 'owner', 'repoA', 5, 8],
    ]);
    wrapper.unmount();
  });

  it('still deletes the marked attachments when the save lands after the user navigated away', async () => {
    // The host reports the save asynchronously; the user may already be on
    // another pull request. The reply names the pull request that was saved, and
    // that pull request's own cached view still owns the delete: dropping it
    // would leave the marked attachment behind forever. Comparing the report
    // against the live route instead is the bug this pins down.
    const wrapper = mountView();
    await nextTick();

    (wrapper.vm as unknown as { pendingDeleteAttachmentIds: number[] }).pendingDeleteAttachmentIds = [7];
    testRoute.path = OTHER_PR_PATH;
    routeParams.repo = 'repoB';
    routeParams.index = '6';
    state.lastSavedPullRequest.value = { instanceId: 'inst-1', owner: 'owner', repo: 'repoA', index: 5 };
    await flushPromises();

    expect(state.deleteIssueAttachment.mock.calls.map((call: unknown[]) => call.slice(0, 5))).toEqual([
      ['inst-1', 'owner', 'repoA', 5, 7],
    ]);
    expect(state.loadPullRequestDetail).toHaveBeenCalledWith('inst-1', 'owner', 'repoA', 5, true);
    wrapper.unmount();
  });

  it('drops a save of another pull request while this cached view is inactive', async () => {
    // A cached view only owns the pull request it was created for. The reply for
    // #6 belongs to #6's own view; this cached view of #5 must neither delete
    // its marks against #6 nor clear them, or they would be gone when the user
    // comes back.
    const wrapper = mountView();
    await nextTick();

    (wrapper.vm as unknown as { pendingDeleteAttachmentIds: number[] }).pendingDeleteAttachmentIds = [7];
    testRoute.path = OTHER_PR_PATH;
    routeParams.repo = 'repoB';
    routeParams.index = '6';
    state.lastSavedPullRequest.value = { instanceId: 'inst-1', owner: 'owner', repo: 'repoB', index: 6 };
    await flushPromises();

    expect(state.deleteIssueAttachment.mock.calls.map((call: unknown[]) => call.slice(0, 5))).not.toContainEqual([
      'inst-1',
      'owner',
      'repoB',
      6,
      7,
    ]);
    expect((wrapper.vm as unknown as { pendingDeleteAttachmentIds: number[] }).pendingDeleteAttachmentIds).toEqual([7]);
    wrapper.unmount();
  });

  it('does not react to another pull request being saved while this view is live', async () => {
    // Being the live route is not ownership: this is the live view of #5 while
    // #6 is saved elsewhere, and deleting #5's marks against #6 would remove
    // them from the wrong pull request.
    const wrapper = mountView();
    await nextTick();

    (wrapper.vm as unknown as { pendingDeleteAttachmentIds: number[] }).pendingDeleteAttachmentIds = [7];

    state.lastSavedPullRequest.value = { instanceId: 'inst-1', owner: 'owner', repo: 'repoA', index: 6 };
    await flushPromises();

    expect(state.deleteIssueAttachment.mock.calls).toEqual([]);
    expect((wrapper.vm as unknown as { pendingDeleteAttachmentIds: number[] }).pendingDeleteAttachmentIds).toEqual([7]);
    wrapper.unmount();
  });

  it('reloads the pull request that was saved, not the one the user switched to', async () => {
    state.deleteIssueAttachment.mockImplementation(async () => {
      routeParams.repo = 'repoB';
      return true;
    });

    const wrapper = mountView();
    await nextTick();

    (wrapper.vm as unknown as { pendingDeleteAttachmentIds: number[] }).pendingDeleteAttachmentIds = [7];
    state.lastSavedPullRequest.value = { instanceId: 'inst-1', owner: 'owner', repo: 'repoA', index: 5 };
    await flushPromises();

    expect(state.loadPullRequestDetail).toHaveBeenCalledWith('inst-1', 'owner', 'repoA', 5, true);
    wrapper.unmount();
  });

  it('drops the deleted attachments from the pull request that was saved, not the one the user switched to', async () => {
    const savedPullRequest = state.pullRequestDetails.value.get(keyFor('inst-1', 'owner', 'repoA', 5)) as {
      assets: { id?: number; uuid?: string }[];
    };
    savedPullRequest.assets = [
      { id: 7, uuid: 'uuid-7' },
      { id: 8, uuid: 'uuid-8' },
    ];
    state.pullRequestDetails.value.set(keyFor('inst-1', 'owner', 'repoB', 6), {
      number: 6,
      title: 'another pull request',
      state: 'open',
      user: { login: 'demo-user' },
      base: { sha: 'base-sha' },
      head: { sha: 'head-sha' },
      labels: [],
      assignees: [],
      assets: [{ id: 9, uuid: 'uuid-9' }],
    });

    state.deleteIssueAttachment.mockImplementation(async () => {
      // The user switches pull request while the attachment delete is in flight.
      routeParams.repo = 'repoB';
      routeParams.index = '6';
      return true;
    });

    const wrapper = mountView();
    await nextTick();

    (wrapper.vm as unknown as { pendingDeleteAttachmentIds: number[] }).pendingDeleteAttachmentIds = [7];
    state.lastSavedPullRequest.value = { instanceId: 'inst-1', owner: 'owner', repo: 'repoA', index: 5 };
    await flushPromises();

    // The local list that must lose the deleted attachment is the saved pull
    // request's, not the one the route points at now.
    expect(savedPullRequest.assets.map((asset) => asset.id)).toEqual([8]);
    const otherPullRequest = state.pullRequestDetails.value.get(keyFor('inst-1', 'owner', 'repoB', 6)) as {
      assets: { id?: number; uuid?: string }[];
    };
    expect(otherPullRequest.assets.map((asset) => asset.id)).toEqual([9]);
    wrapper.unmount();
  });

  it('reports a failed save on the form of the pull request that was saved', async () => {
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
    state.lastSavedPullRequest.value = { instanceId: 'inst-1', owner: 'owner', repo: 'repoA', index: 5 };
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
 * into the assets of whatever pull request the user navigated to in the
 * meantime.
 */
describe('PullRequestDetail upload target', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    routeParams.instanceId = 'inst-1';
    routeParams.owner = 'owner';
    routeParams.repo = 'repoA';
    routeParams.index = '5';
    testRoute.path = OWN_PR_PATH;
    state.errors.clear();
    state.pullRequestDetails.value.clear();
    state.pullRequestDetails.value.set(keyFor('inst-1', 'owner', 'repoA', 5), {
      number: 5,
      title: 'a pull request',
      state: 'open',
      user: { login: 'demo-user' },
      base: { sha: 'base-sha' },
      head: { sha: 'head-sha' },
      labels: [],
      assignees: [],
      assets: [],
    });
    state.pullRequestDetails.value.set(keyFor('inst-1', 'owner', 'repoB', 6), {
      number: 6,
      title: 'another pull request',
      state: 'open',
      user: { login: 'demo-user' },
      base: { sha: 'base-sha' },
      head: { sha: 'head-sha' },
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

  // The user switches pull request while the upload request is in flight.
  function switchPullRequestDuringUpload() {
    state.uploadIssueAttachment.mockImplementation(async () => {
      routeParams.repo = 'repoB';
      routeParams.index = '6';
      return { id: 1, uuid: 'uuid-1' };
    });
  }

  function assetsOf(key: string) {
    return (state.pullRequestDetails.value.get(key) as { assets: { uuid?: string }[] }).assets;
  }

  it('attaches an image picked in the editor to the pull request the form was opened for', async () => {
    switchPullRequestDuringUpload();
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

  it('attaches a file added to the attachment list to the pull request the form was opened for', async () => {
    switchPullRequestDuringUpload();
    const { wrapper, handlers } = mountWithHandlers();
    await nextTick();

    await handlers.handleAttachmentUpload(new File(['x'], 'shot.png', { type: 'image/png' }));

    expect(assetsOf(keyFor('inst-1', 'owner', 'repoA', 5)).map((asset) => asset.uuid)).toEqual(['uuid-1']);
    expect(assetsOf(keyFor('inst-1', 'owner', 'repoB', 6))).toEqual([]);
    wrapper.unmount();
  });

  it('reports a failed attachment list upload on the form of that pull request', async () => {
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
