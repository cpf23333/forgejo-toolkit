import { describe, expect, it, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import { nextTick, reactive } from 'vue';

const { stateMock, keyFor } = vi.hoisted(() => {
  const keyFor = (...parts: unknown[]) => parts.join('|');
  return {
    keyFor,
    stateMock: {
      loading: new Map<string, boolean>(),
      errors: new Map<string, string>(),
      repoIssues: { value: new Map<string, unknown[]>() },
      repoIssuesTotalCount: { value: new Map() },
      repoPullRequests: { value: new Map<string, unknown[]>() },
      repoPullRequestsTotalCount: { value: new Map() },
      repoDetails: { value: new Map<string, unknown>() },
      repoLabels: { value: new Map<string, unknown>() },
      repoAssignees: { value: new Map<string, unknown>() },
      repoMilestones: { value: new Map<string, unknown>() },
      repoRefs: { value: new Map<string, unknown>() },
      pendingNewIssue: { value: undefined },
      pendingCreatePr: { value: undefined },
      loadRepoIssues: vi.fn(),
      loadRepoPullRequests: vi.fn(),
      loadRepoDetail: vi.fn(),
      loadRepoLabels: vi.fn(),
      loadRepoAssignees: vi.fn(),
      loadRepoMilestones: vi.fn(),
      loadRepoRefs: vi.fn(),
      changeRepoIssuesState: vi.fn(),
      changeRepoPullRequestsState: vi.fn(),
      consumePendingNewIssue: vi.fn(),
      consumePendingCreatePr: vi.fn(),
      createIssue: vi.fn(),
      createPullRequest: vi.fn(),
      editIssue: vi.fn(),
      editPullRequest: vi.fn(),
      openExternal: vi.fn(),
      openIssueDetail: vi.fn(),
      openPullRequestDetail: vi.fn(),
      uploadIssueAttachment: vi.fn(),
    },
  };
});

// The route is reactive so a test can move the user to another repository the
// way the app does; `path` is the keep-alive key the views recognize themselves
// by.
vi.mock('vue-router', async () => {
  const { reactive: makeReactive } = await import('vue');
  const route = makeReactive({
    path: '/repo/inst-1/owner/repoA/issues/open',
    params: { instanceId: 'inst-1', owner: 'owner', repo: 'repoA', state: 'open' },
  });
  return { useRoute: () => route, useRouter: () => ({ push: vi.fn() }) };
});

vi.mock('../../composables/useAppState', async () => {
  const state = reactive(stateMock);
  const keyBuilder = (...parts: unknown[]) => keyFor(...parts);
  return {
    useAppState: () => state,
    issueFormKey: keyBuilder,
    pullRequestFormKey: keyBuilder,
    repoDetailKey: keyBuilder,
    repoIssuesKey: keyBuilder,
    repoPullRequestsKey: keyBuilder,
    repoLabelsKey: keyBuilder,
    repoAssigneesKey: keyBuilder,
    repoMilestonesKey: keyBuilder,
    repoRefsKey: keyBuilder,
  };
});

import RepoIssues from '../RepoIssues.vue';
import RepoPullRequests from '../RepoPullRequests.vue';
import { useAppState } from '../../composables/useAppState';
import ModalDialog from '../../components/ModalDialog.vue';
import { createTestI18n } from '../../__tests__/helpers/test-utils';

const state = useAppState() as unknown as typeof stateMock;

const REPO_DETAIL_KEY = keyFor('inst-1', 'owner', 'repoA');

function repoDetail(flags: { mirror?: boolean; hasIssues?: boolean; hasPullRequests?: boolean }) {
  return {
    empty: false,
    branches: [],
    recentCommits: [],
    repository: {
      full_name: 'owner/repoA',
      description: '',
      html_url: 'https://forgejo.example.com/owner/repoA',
      owner: { login: 'owner' },
      default_branch: 'main',
      mirror: flags.mirror ?? false,
      has_issues: flags.hasIssues ?? true,
      has_pull_requests: flags.hasPullRequests ?? true,
    },
  };
}

function mountView(component: typeof RepoIssues | typeof RepoPullRequests) {
  return mount(component, {
    global: {
      plugins: [createTestI18n('en')],
      stubs: {
        // jsdom's `<dialog>` has no `showModal`, and the forms pull in the
        // markdown editor; only the dialog's `open` flag and the header matter
        // for this test.
        ModalDialog: { props: ['open'], template: '<div class="modal-stub" :data-open="String(open)" />' },
        IssueForm: true,
        PullRequestForm: true,
        AttachmentList: true,
        PendingAttachmentList: true,
      },
    },
  });
}

/** The create dialog's `open` flag, read from the ModalDialog the view renders. */
function createDialogIsOpen(wrapper: ReturnType<typeof mountView>): boolean {
  const dialogs = wrapper.findAllComponents(ModalDialog);
  expect(dialogs, 'ModalDialog').toHaveLength(1);
  return dialogs[0].props('open') as boolean;
}

function findCreateAction(wrapper: ReturnType<typeof mountView>, label: string) {
  return wrapper.findAll('vscode-button').find((button) => button.text().trim() === label);
}

/**
 * A repository can have issues (or pull requests) turned off, or be a mirror.
 * The list already replaces itself with "disabled for this repository" in that
 * case, but the always-rendered header still offered the create action: the
 * dialog's option lists (labels/assignees/milestones) are gated on the same
 * flag, so the user could fill in a whole issue only to have the server reject
 * it.
 */
describe('RepoIssues create action when issues are disabled', () => {
  function mountWith(flags: { mirror?: boolean; hasIssues?: boolean }) {
    state.repoDetails.value.clear();
    state.errors.clear();
    state.loadRepoDetail.mockClear();
    state.repoDetails.value.set(REPO_DETAIL_KEY, repoDetail(flags));
    return mountView(RepoIssues);
  }

  it('does not offer a create action and still explains why', async () => {
    const wrapper = mountWith({ hasIssues: false });
    await nextTick();

    expect(findCreateAction(wrapper, 'New Issue')).toBeUndefined();
    expect(wrapper.find('.empty-list').text()).toContain('Issues are disabled for this repository');
    wrapper.unmount();
  });

  it('does not open the create dialog even when asked directly', async () => {
    const wrapper = mountWith({ mirror: true });
    await nextTick();

    (wrapper.vm as unknown as { openCreateIssue: () => void }).openCreateIssue();
    await nextTick();

    expect(createDialogIsOpen(wrapper)).toBe(false);
    wrapper.unmount();
  });

  it('offers the create action for a repository that takes issues', async () => {
    const wrapper = mountWith({});
    await nextTick();

    const action = findCreateAction(wrapper, 'New Issue');
    expect(action, 'New Issue button').toBeTruthy();
    await action!.trigger('click');
    await nextTick();

    expect(createDialogIsOpen(wrapper)).toBe(true);
    wrapper.unmount();
  });
});

describe('RepoPullRequests create action when pull requests are disabled', () => {
  function mountWith(flags: { mirror?: boolean; hasPullRequests?: boolean }) {
    state.repoDetails.value.clear();
    state.errors.clear();
    state.repoDetails.value.set(REPO_DETAIL_KEY, repoDetail(flags));
    return mountView(RepoPullRequests);
  }

  it('does not offer a create action and still explains why', async () => {
    const wrapper = mountWith({ hasPullRequests: false });
    await nextTick();

    expect(findCreateAction(wrapper, 'New Pull Request')).toBeUndefined();
    expect(wrapper.find('.empty-list').text()).toContain('Pull requests are disabled for this repository');
    wrapper.unmount();
  });

  it('does not open the create dialog even when asked directly', async () => {
    const wrapper = mountWith({ mirror: true });
    await nextTick();

    (wrapper.vm as unknown as { openCreatePullRequest: () => void }).openCreatePullRequest();
    await nextTick();

    expect(createDialogIsOpen(wrapper)).toBe(false);
    wrapper.unmount();
  });

  it('offers the create action for a repository that takes pull requests', async () => {
    const wrapper = mountWith({});
    await nextTick();

    const action = findCreateAction(wrapper, 'New Pull Request');
    expect(action, 'New Pull Request button').toBeTruthy();
    await action!.trigger('click');
    await nextTick();

    expect(createDialogIsOpen(wrapper)).toBe(true);
    wrapper.unmount();
  });
});
