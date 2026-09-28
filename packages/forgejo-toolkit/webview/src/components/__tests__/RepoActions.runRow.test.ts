import { describe, expect, it, vi, beforeEach } from 'vitest';
import { mount } from '@vue/test-utils';
import { defineComponent, h, KeepAlive, nextTick } from 'vue';
import RepoActions from '../RepoActions.vue';
import { createTestI18n } from '../../__tests__/helpers/test-utils';

const { stateMock } = vi.hoisted(() => ({
  stateMock: {
    loading: new Map<string, boolean>(),
    errors: new Map<string, string>(),
    actionRuns: { value: new Map<string, unknown[]>() },
    actionRunsHasMore: { value: new Map<string, boolean>() },
    actionRunTotalCount: { value: new Map<string, number>() },
    actionRunsPage: { value: new Map<string, number>() },
    workflowDispatchInputs: { value: new Map<string, unknown>() },
    lastDispatchCancelled: { value: undefined as string | undefined },
    loadActionRuns: vi.fn(),
    loadWorkflowDispatchInputs: vi.fn(),
    dispatchWorkflow: vi.fn(),
    openActionRunDetail: vi.fn(),
    openExternal: vi.fn(),
  },
}));

vi.mock('../../composables/useAppState', async () => {
  const { reactive } = await import('vue');
  const state = reactive(stateMock);
  return {
    useAppState: () => state,
    ACTION_RUNS_PAGE_LIMIT: 30,
    actionRunsKey: (instanceId: string, owner: string, repo: string) => `${instanceId}:${owner}/${repo}:actions`,
    dispatchWorkflowKey: (instanceId: string, owner: string, repo: string, workflow: string) =>
      `${instanceId}:${owner}/${repo}:actions:dispatch:${workflow}`,
    workflowDispatchInputsKey: (instanceId: string, owner: string, repo: string, workflow: string, ref: string) =>
      `${instanceId}:${owner}/${repo}:actions:dispatch-inputs:${workflow}@${ref}`,
  };
});

const Host = defineComponent({
  setup() {
    return () =>
      h(KeepAlive, null, {
        default: () => h(RepoActions, { instanceId: 'inst-1', owner: 'owner', repo: 'repo' }),
      });
  },
});

function mountActions() {
  return mount(Host, { global: { plugins: [createTestI18n('en')] } });
}

/**
 * The run row is a button-like container (role=button, tabindex=0), and it holds
 * a real control: the "Open in Browser" button. Keydown bubbles out of that
 * control, so without a guard pressing Enter on it ran the row action as well
 * and opened the run detail behind the browser tab.
 */
describe('RepoActions run row keys', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    stateMock.loading.clear();
    stateMock.errors.clear();
    stateMock.actionRuns.value.clear();
    stateMock.actionRuns.value.set('inst-1:owner/repo:actions', [
      {
        id: 42,
        index_in_repo: 7,
        title: 'a run',
        status: 'success',
        html_url: 'https://forgejo.example.com/owner/repo/actions/runs/42',
      },
    ]);
  });

  function row(wrapper: ReturnType<typeof mountActions>) {
    return wrapper.get('.action-run-item');
  }

  it('opens the run when its own row is activated', async () => {
    const wrapper = mountActions();
    await nextTick();

    await row(wrapper).trigger('keydown', { key: 'Enter' });
    expect(stateMock.openActionRunDetail).toHaveBeenCalledWith('inst-1', 'owner', 'repo', 42);

    stateMock.openActionRunDetail.mockClear();
    await row(wrapper).trigger('keydown', { key: ' ' });
    expect(stateMock.openActionRunDetail).toHaveBeenCalledTimes(1);
    wrapper.unmount();
  });

  it('leaves the nested "Open in Browser" button to itself', async () => {
    const wrapper = mountActions();
    await nextTick();

    const openButton = row(wrapper).get('vscode-button');
    await openButton.trigger('keydown', { key: 'Enter' });
    await openButton.trigger('keydown', { key: ' ' });

    // The keydown originated inside the nested control: the row must not act.
    expect(stateMock.openActionRunDetail).not.toHaveBeenCalled();
    wrapper.unmount();
  });
});
