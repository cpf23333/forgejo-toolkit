import { describe, it, expect, vi, beforeEach } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { defineComponent, nextTick, reactive } from 'vue';

const { routeMock, stateMock, keyFor } = vi.hoisted(() => {
  const keyFor = (...parts: unknown[]) => parts.join('|');
  return {
    keyFor,
    routeMock: { params: { instanceId: 'inst-1', owner: 'owner', repo: 'repo', index: '5' } },
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
      instances: {
        value: [
          {
            id: 'inst-1',
            url: 'https://forgejo.example.com',
            username: 'demo-user',
            name: 'demo-user@forgejo.example.com',
          },
        ],
      },
      issueDependencies: { value: new Map() },
      issueDetails: { value: new Map() },
      issueReactions: { value: new Map() },
      issueSubscriptions: { value: new Map() },
      issueTrackedTimes: { value: new Map() },
      lastSavedIssue: { value: undefined },
      loadIssueDependencies: vi.fn(),
      loadIssueDetail: vi.fn(),
      loadIssueReactions: vi.fn(),
      loadIssueSubscription: vi.fn(),
      loadIssueTrackedTimes: vi.fn(),
      loadPullRequestComments: vi.fn(),
      loadCommentReactions: vi.fn(),
      commentReactions: { value: new Map() },
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
      renderMarkdown: vi.fn(),
      repoAssignees: { value: new Map() },
      repoIssues: { value: new Map() },
      repoIssuesTotalCount: { value: new Map() },
      repoIssuesFetchedAt: { has: () => false, set: () => {}, delete: () => {} },
      repoLabels: { value: new Map() },
      repoMilestones: { value: new Map() },
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

vi.mock('vue-router', () => ({ useRoute: () => routeMock }));

vi.mock('../../composables/useAppState', async () => {
  const state = reactive(stateMock);
  const keys = {
    issueDetailKey: (...parts: unknown[]) => keyFor(...parts),
    commentReactionsKey: (...parts: unknown[]) => keyFor(...parts),
    issueCommentEditFormKey: (...parts: unknown[]) => keyFor(...parts),
    issueFormKey: (...parts: unknown[]) => keyFor(...parts),
    issueCommentFormKey: (...parts: unknown[]) => keyFor(...parts),
    issueCommentDeleteFormKey: (...parts: unknown[]) => keyFor(...parts),
    pullRequestCommentsKey: (...parts: unknown[]) => keyFor(...parts),
    repoLabelsKey: (...parts: unknown[]) => keyFor(...parts),
    repoAssigneesKey: (...parts: unknown[]) => keyFor(...parts),
    repoMilestonesKey: (...parts: unknown[]) => keyFor(...parts),
    repoIssuesKey: (...parts: unknown[]) => keyFor(...parts),
    issueSubscriptionKey: (...parts: unknown[]) => `subscription|${keyFor(...parts)}`,
    issueTrackedTimesKey: (...parts: unknown[]) => `times|${keyFor(...parts)}`,
    userStopwatchesKey: (...parts: unknown[]) => keyFor(...parts),
    issueDependenciesKey: (...parts: unknown[]) => keyFor(...parts),
    issueReactionsKey: (...parts: unknown[]) => keyFor(...parts),
    issueStateKey: (...parts: unknown[]) => keyFor(...parts),
    issueDueDateKey: (...parts: unknown[]) => keyFor(...parts),
    startWorkKey: (...parts: unknown[]) => keyFor(...parts),
  };
  return { useAppState: () => state, ...keys };
});

import IssueDetail from '../IssueDetail.vue';
import { useAppState } from '../../composables/useAppState';
import { createTestI18n } from '../../__tests__/helpers/test-utils';

type TestState = Record<string, any>;
const appState = () => useAppState() as unknown as TestState;

function mountView() {
  return mount(IssueDetail, { global: { plugins: [createTestI18n('en')] } });
}

function trackedTimeDeleteButtons(wrapper: ReturnType<typeof mountView>) {
  return wrapper.findAll('.tracked-time-item [name="trash"]');
}

const TIMES_KEY = `times|${keyFor('inst-1', 'owner', 'repo', '5')}`;
const SUBSCRIPTION_KEY = `subscription|${keyFor('inst-1', 'owner', 'repo', '5')}`;
const STOPWATCH_KEY = keyFor('inst-1');
describe('IssueDetail tracked time panel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    appState().issueTrackedTimes.value.clear();
    appState().userStopwatches.value.clear();
    appState().issueDetails.value.clear();
    appState().errors.clear();
    appState().loading.clear();
  });

  it('labels the sum as the issue total for the author and hides foreign rows', async () => {
    appState().issueDetails.value.set(keyFor('inst-1', 'owner', 'repo', 5), {
      number: 5,
      title: 'an issue',
      user: { login: 'demo-user' },
    });
    appState().issueTrackedTimes.value.set(TIMES_KEY, [{ id: 1, time: 600, user_name: 'demo-user' }]);
    const wrapper = mountView();
    await nextTick();
    expect(wrapper.text()).toContain('Total tracked time');
    // The only row belongs to the caller, so it keeps its delete button.
    expect(trackedTimeDeleteButtons(wrapper)).toHaveLength(1);
    wrapper.unmount();
  });

  it('calls the sum personal while only the viewer rows are visible', async () => {
    // The server narrows the list to the caller for non-writers, so the sum may be a
    // subset and must not be presented as the issue total.
    appState().issueDetails.value.set(keyFor('inst-1', 'owner', 'repo', 5), {
      number: 5,
      title: 'an issue',
      user: { login: 'someone-else' },
    });
    appState().issueTrackedTimes.value.set(TIMES_KEY, [{ id: 1, time: 600, user_name: 'demo-user' }]);
    const wrapper = mountView();
    await nextTick();
    expect(wrapper.text()).toContain('My tracked time');
    expect(wrapper.text()).not.toContain('Total tracked time');
    wrapper.unmount();
  });

  it('hides the delete button for a row belonging to somebody else', async () => {
    // Only the record owner (or a site admin) may delete, so the button is offered
    // for the viewer rows only.
    appState().issueDetails.value.set(keyFor('inst-1', 'owner', 'repo', 5), {
      number: 5,
      title: 'an issue',
      user: { login: 'someone-else' },
    });
    appState().issueTrackedTimes.value.set(TIMES_KEY, [
      { id: 1, time: 600, user_name: 'demo-user' },
      { id: 2, time: 900, user_name: 'other-user' },
    ]);
    const wrapper = mountView();
    await nextTick();
    expect(trackedTimeDeleteButtons(wrapper)).toHaveLength(1);
    wrapper.unmount();
  });
  it('warns that a timer running elsewhere would be ended', async () => {
    appState().issueDetails.value.set(keyFor('inst-1', 'owner', 'repo', 5), {
      number: 5,
      title: 'an issue',
      user: { login: 'demo-user' },
    });
    appState().userStopwatches.value.set(STOPWATCH_KEY, [
      { repo_owner_name: 'owner', repo_name: 'other-repo', issue_index: 9 },
    ]);
    const wrapper = mountView();
    await nextTick();
    expect(wrapper.text()).toContain('A timer is already running');
    wrapper.unmount();
  });

  it('says when the timeline was cut off at the cap', async () => {
    appState().issueDetails.value.set(keyFor('inst-1', 'owner', 'repo', 5), {
      number: 5,
      title: 'an issue',
      user: { login: 'demo-user' },
    });
    appState().pullRequestComments.value.set(
      keyFor('inst-1', 'owner', 'repo', 5),
      Array.from({ length: 500 }, (_, index) => ({
        id: index + 1,
        type: 'comment',
        body: 'a comment',
        created_at: '2026-01-01T00:00:00Z',
        user: { login: 'demo-user' },
      })),
    );
    const wrapper = mountView();
    await nextTick();

    expect(wrapper.findAll('.list-truncated').length).toBeGreaterThan(0);
    wrapper.unmount();
  });

  it('shows a failed time-tracking request instead of dropping it', async () => {
    appState().issueDetails.value.set(keyFor('inst-1', 'owner', 'repo', 5), {
      number: 5,
      title: 'an issue',
      user: { login: 'demo-user' },
    });
    // A rejected add/delete/stopwatch used to leave the panel showing 0s with no
    // sign that anything had happened.
    appState().errors.set(TIMES_KEY, 'add time failed');

    const wrapper = mountView();
    await nextTick();

    expect(wrapper.find('.time-tracking-error').text()).toContain('add time failed');
    wrapper.unmount();
  });

  it('keeps the typed time until the server accepts it', async () => {
    appState().issueDetails.value.set(keyFor('inst-1', 'owner', 'repo', 5), {
      number: 5,
      title: 'an issue',
      user: { login: 'demo-user' },
    });
    const wrapper = mountView();
    await nextTick();

    const fields = wrapper.findAll('.time-tracking-form vscode-textfield');
    (fields[0].element as HTMLInputElement).value = '1';
    await fields[0].trigger('input');
    (fields[1].element as HTMLInputElement).value = '30';
    await fields[1].trigger('input');
    await nextTick();

    const addButton = wrapper.find('.time-tracking-form vscode-button');
    await addButton.trigger('click');
    expect(appState().addIssueTime).toHaveBeenNthCalledWith(1, 'inst-1', 'owner', 'repo', 5, 5400);

    // Still in flight: the form has not thrown the typed values away, so
    // pressing Add again re-sends the same time instead of doing nothing.
    await addButton.trigger('click');
    expect(appState().addIssueTime).toHaveBeenNthCalledWith(2, 'inst-1', 'owner', 'repo', 5, 5400);

    // The server accepted it: the form clears, so a further click has nothing
    // left to send.
    appState().loading.set(TIMES_KEY, true);
    await nextTick();
    appState().loading.set(TIMES_KEY, false);
    await nextTick();
    await addButton.trigger('click');
    expect(appState().addIssueTime).toHaveBeenCalledTimes(2);
    wrapper.unmount();
  });

  it('keeps the typed time and reports the failure when the request fails', async () => {
    appState().issueDetails.value.set(keyFor('inst-1', 'owner', 'repo', 5), {
      number: 5,
      title: 'an issue',
      user: { login: 'demo-user' },
    });
    const wrapper = mountView();
    await nextTick();

    const fields = wrapper.findAll('.time-tracking-form vscode-textfield');
    (fields[1].element as HTMLInputElement).value = '30';
    await fields[1].trigger('input');
    await nextTick();

    const addButton = wrapper.find('.time-tracking-form vscode-button');
    await addButton.trigger('click');

    appState().loading.set(TIMES_KEY, true);
    await nextTick();
    appState().errors.set(TIMES_KEY, 'add time failed');
    appState().loading.set(TIMES_KEY, false);
    await nextTick();

    expect(wrapper.find('.time-tracking-error').text()).toContain('add time failed');
    // The values survived the failure, so the retry needs no retyping.
    await addButton.trigger('click');
    expect(appState().addIssueTime).toHaveBeenNthCalledWith(2, 'inst-1', 'owner', 'repo', 5, 1800);
    wrapper.unmount();
  });
});

/**
 * A failed `checkIssueSubscription` used to leave `subscription` undefined
 * forever: the payload is only written on success, so the panel showed its
 * "Loading..." line with no error and no way to retry.
 */
describe('IssueDetail subscription panel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    appState().errors.clear();
    appState().loading.clear();
    appState().issueSubscriptions.value.clear();
    appState().issueDetails.value.clear();
    appState().issueDetails.value.set(keyFor('inst-1', 'owner', 'repo', 5), {
      number: 5,
      title: 'an issue',
      user: { login: 'demo-user' },
    });
  });

  it('shows the failure and a retry instead of spinning forever', async () => {
    appState().errors.set(SUBSCRIPTION_KEY, 'the check failed');

    const wrapper = mountView();
    await nextTick();

    expect(wrapper.find('.subscription-error').text()).toContain('the check failed');
    expect(wrapper.find('.subscription-actions').exists()).toBe(false);

    await wrapper.find('.subscription-error vscode-button').trigger('click');
    expect(appState().loadIssueSubscription).toHaveBeenCalledWith('inst-1', 'owner', 'repo', 5, true);
    wrapper.unmount();
  });

  it('offers the subscribe action once the check answered', async () => {
    appState().issueSubscriptions.value.set(SUBSCRIPTION_KEY, { subscribed: true });

    const wrapper = mountView();
    await nextTick();

    expect(wrapper.find('.subscription-error').exists()).toBe(false);
    expect(wrapper.find('.subscription-actions').text()).toContain('Unsubscribe');
    wrapper.unmount();
  });
});

/**
 * Saving while an image is still uploading used to submit the body from before
 * the upload: EasyMDE inserts `![image](url)` from the upload's success
 * callback, so the earlier body reached the server without the image the user
 * had just inserted.
 */
describe('IssueDetail save waits for in-flight image uploads', () => {
  const EasyMdeEditorStub = defineComponent({
    name: 'EasyMdeEditor',
    props: {
      modelValue: { type: String, default: '' },
      uploadImage: { type: Function, default: undefined },
    },
    emits: ['update:modelValue'],
    setup(props, { emit }) {
      // Mirrors EasyMDE's real behaviour: the markdown is inserted only from
      // the upload's success callback, never when the file is picked.
      function pickImage() {
        props.uploadImage?.(
          new File(['x'], 'shot.png', { type: 'image/png' }),
          (url: string) => emit('update:modelValue', `![image](${url})`),
          () => {},
        );
      }
      return { pickImage };
    },
    template:
      '<div class="editor-stub"><button type="button" class="pick-image" @click="pickImage">pick</button></div>',
  });

  function mountEditorView() {
    return mount(IssueDetail, {
      global: {
        plugins: [createTestI18n('en')],
        stubs: { EasyMdeEditor: EasyMdeEditorStub, AttachmentList: true },
      },
    });
  }

  beforeEach(() => {
    vi.clearAllMocks();
    // jsdom's `<dialog>` has no showModal/close, and the edit dialog is opened
    // for real here (its form is what the save comes from).
    if (typeof HTMLDialogElement !== 'undefined') {
      HTMLDialogElement.prototype.showModal = vi.fn();
      HTMLDialogElement.prototype.close = vi.fn();
    }
    appState().issueDetails.value.clear();
    appState().errors.clear();
    appState().issueDetails.value.set(keyFor('inst-1', 'owner', 'repo', 5), {
      number: 5,
      title: 'an issue',
      body: 'original body',
      user: { login: 'demo-user' },
      labels: [],
      assignees: [],
    });
  });

  function editDialog(wrapper: ReturnType<typeof mountEditorView>) {
    // The comment box renders an editor of its own; the edit dialog's form is
    // the one whose submit handler saves the issue. The dialog is opened first:
    // a submit that the user cancelled while the upload was in flight must not
    // dispatch the edit (see IssueDetail.editDialogCancel.test.ts), so the save
    // only happens for an open dialog.
    const view = wrapper.vm as unknown as { isEditing: boolean };
    view.isEditing = true;
    const form = wrapper.findAll('form').find((candidate) => candidate.classes().includes('issue-form'));
    expect(form, 'edit dialog form').toBeTruthy();
    return form!;
  }

  it('includes the image markdown when a save is issued while the upload is running', async () => {
    let finishUpload: ((attachment: { id: number; uuid: string }) => void) | undefined;
    const uploadPromise = new Promise<{ id: number; uuid: string }>((resolve) => {
      finishUpload = resolve;
    });
    appState().uploadIssueAttachment.mockReturnValue(uploadPromise);

    const wrapper = mountEditorView();
    await nextTick();
    const form = editDialog(wrapper);

    // The user inserts an image into the body: the request is in flight and the
    // markdown is not in the editor yet.
    await form.find('.pick-image').trigger('click');
    await nextTick();
    expect(appState().uploadIssueAttachment).toHaveBeenCalledTimes(1);

    // …and submits the form before the upload returns.
    await form.trigger('submit');
    await nextTick();
    expect(appState().editIssue).not.toHaveBeenCalled();

    // The upload lands and the editor inserts its markdown.
    finishUpload?.({ id: 1, uuid: 'uuid-1' });
    await flushPromises();

    expect(appState().editIssue).toHaveBeenCalledTimes(1);
    expect(appState().editIssue.mock.calls[0][4].body).toContain('![image](/attachments/uuid-1)');
    wrapper.unmount();
  });
});
