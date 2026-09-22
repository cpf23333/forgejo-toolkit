import { describe, it, expect, vi, beforeEach } from 'vitest';
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
    loadActionRuns: vi.fn(),
    dispatchWorkflow: vi.fn(),
    openActionRunDetail: vi.fn(),
    openExternal: vi.fn(),
  },
}));

vi.mock('../../composables/useAppState', async () => {
  // Wrap in reactive so the component's computed/watch observe Map mutations
  // the tests perform through useAppState().
  const { reactive } = await import('vue');
  const state = reactive(stateMock);
  return {
    useAppState: () => state,
    ACTION_RUNS_PAGE_LIMIT: 30,
    actionRunsKey: (instanceId: string, owner: string, repo: string) => `${instanceId}:${owner}/${repo}:actions`,
    dispatchWorkflowKey: (instanceId: string, owner: string, repo: string, workflow: string) =>
      `${instanceId}:${owner}/${repo}:actions:dispatch:${workflow}`,
  };
});

import { useAppState } from '../../composables/useAppState';

// RepoActions lives inside RepoDetail, which App.vue renders under keep-alive.
// Simulate that: toggling `show` deactivates/activates the component instead
// of unmounting it.
const Host = defineComponent({
  props: {
    show: { type: Boolean, default: true },
    instanceId: { type: String, default: 'inst-1' },
  },
  setup(props) {
    return () =>
      h(KeepAlive, null, {
        default: () =>
          props.show
            ? h(RepoActions, { instanceId: props.instanceId, owner: 'owner', repo: 'repo' })
            : h('div', 'placeholder'),
      });
  },
});

function mountHost() {
  return mount(Host, {
    global: {
      plugins: [createTestI18n('en')],
    },
  });
}

describe('RepoActions under keep-alive', () => {
  beforeEach(() => {
    stateMock.loadActionRuns.mockClear();
  });

  it('loads action runs on mount', async () => {
    mountHost();

    expect(stateMock.loadActionRuns).toHaveBeenCalledWith('inst-1', 'owner', 'repo', 1);
  });

  it('ignores prop changes while deactivated and reloads on reactivation', async () => {
    const wrapper = mountHost();
    stateMock.loadActionRuns.mockClear();

    await wrapper.setProps({ show: false });
    await wrapper.setProps({ instanceId: 'inst-2' });

    // While deactivated, the props track the global route; loading must not fire.
    expect(stateMock.loadActionRuns).not.toHaveBeenCalled();

    await wrapper.setProps({ show: true });

    expect(stateMock.loadActionRuns).toHaveBeenCalledWith('inst-2', 'owner', 'repo', 1);
  });

  it('reloads when props change while active', async () => {
    const wrapper = mountHost();
    stateMock.loadActionRuns.mockClear();

    await wrapper.setProps({ instanceId: 'inst-2' });

    expect(stateMock.loadActionRuns).toHaveBeenCalledWith('inst-2', 'owner', 'repo', 1);
  });
});

describe('RepoActions dispatch feedback', () => {
  beforeEach(() => {
    stateMock.loadActionRuns.mockClear();
    stateMock.dispatchWorkflow.mockClear();
    stateMock.loading.clear();
    stateMock.errors.clear();
  });

  it('shows waiting feedback after a successful dispatch and timeout feedback when no run appears', async () => {
    vi.useFakeTimers();
    try {
      const wrapper = mountHost();

      // Open the trigger form and fill workflow + ref.
      const triggerButton = wrapper.findAll('vscode-button').find((b) => b.text().includes('Trigger workflow'));
      expect(triggerButton).toBeTruthy();
      await triggerButton!.trigger('click');

      const textfields = wrapper.findAll('vscode-textfield');
      expect(textfields.length).toBeGreaterThanOrEqual(2);
      (textfields[0].element as unknown as { value: string }).value = 'ci.yml';
      await textfields[0].trigger('input');
      (textfields[1].element as unknown as { value: string }).value = 'main';
      await textfields[1].trigger('input');

      const runButton = wrapper.findAll('vscode-button').find((b) => b.text().trim() === 'Run');
      expect(runButton).toBeTruthy();
      await runButton!.trigger('click');
      expect(stateMock.dispatchWorkflow).toHaveBeenCalledWith('inst-1', 'owner', 'repo', 'ci.yml', 'main', {});

      // Dispatch completes successfully → the poll for the new run starts.
      const state = useAppState() as unknown as { loading: Map<string, boolean> };
      state.loading.set('inst-1:owner/repo:actions:dispatch:ci.yml', true);
      await nextTick();
      state.loading.set('inst-1:owner/repo:actions:dispatch:ci.yml', false);
      await nextTick();

      expect(wrapper.text()).toContain('Waiting for the new run to appear');

      // Exhaust all polling attempts without a new run → timeout feedback.
      await vi.advanceTimersByTimeAsync(4000 * 16);
      await nextTick();
      expect(wrapper.text()).toContain('no new run appeared yet');
    } finally {
      vi.useRealTimers();
    }
  });
});
