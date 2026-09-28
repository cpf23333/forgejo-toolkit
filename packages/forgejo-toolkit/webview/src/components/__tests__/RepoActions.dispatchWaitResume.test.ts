import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mount } from '@vue/test-utils';
import { defineComponent, h, KeepAlive, nextTick } from 'vue';

const { stateMock } = vi.hoisted(() => ({
  stateMock: {
    loading: new Map<string, boolean>(),
    errors: new Map<string, string>(),
    actionRuns: { value: new Map<string, unknown[]>() },
    actionRunsHasMore: { value: new Map<string, boolean>() },
    actionRunTotalCount: { value: new Map<string, number>() },
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

import { useAppState } from '../../composables/useAppState';
import RepoActions from '../RepoActions.vue';
import { createTestI18n } from '../../__tests__/helpers/test-utils';

const RUNS_KEY = 'inst-1:owner/repo:actions';
const DISPATCH_KEY = 'inst-1:owner/repo:actions:dispatch:ci.yml';

// The reactive store, not the raw mock: a list written straight into the raw
// object would not invalidate the view's computeds, and a test about the reply
// arriving would then never see it arrive.
const state = useAppState() as unknown as { actionRuns: { value: Map<string, unknown[]> } };

// RepoActions lives inside RepoDetail, which App.vue renders under keep-alive.
// Toggling `show` deactivates/activates the component instead of unmounting it,
// which is what the user does when they leave the Actions view and come back.
const Host = defineComponent({
  props: { show: { type: Boolean, default: true } },
  setup(props) {
    return () =>
      h(KeepAlive, null, {
        default: () =>
          props.show ? h(RepoActions, { instanceId: 'inst-1', owner: 'owner', repo: 'repo' }) : h('div', 'placeholder'),
      });
  },
});

function mountHost() {
  return mount(Host, { global: { plugins: [createTestI18n('en')] } });
}

async function dispatchWorkflow(wrapper: ReturnType<typeof mountHost>) {
  const triggerButton = wrapper.findAll('vscode-button').find((b) => b.text().includes('Trigger workflow'));
  expect(triggerButton, 'Trigger workflow button').toBeTruthy();
  await triggerButton!.trigger('click');

  const textfields = wrapper.findAll('vscode-textfield');
  (textfields[0].element as unknown as { value: string }).value = 'ci.yml';
  await textfields[0].trigger('input');
  (textfields[1].element as unknown as { value: string }).value = 'main';
  await textfields[1].trigger('input');

  const runButton = wrapper.findAll('vscode-button').find((b) => b.text().trim() === 'Run');
  expect(runButton, 'Run button').toBeTruthy();
  await runButton!.trigger('click');

  // The host accepts the dispatch: the loading slot opens and closes, which is
  // what starts the wait for the new run.
  const state = useAppState() as unknown as { loading: Map<string, boolean> };
  state.loading.set(DISPATCH_KEY, true);
  await nextTick();
  state.loading.set(DISPATCH_KEY, false);
  await nextTick();
}

function newRun(index: number) {
  return { id: 100 + index, index_in_repo: index, title: `Run ${index}`, status: 'success' };
}

/**
 * The dispatch feedback is a wait of its own: the view polls the run list for
 * ~60 s and keeps a "waiting" line on screen meanwhile. Leaving the Actions view
 * stopped the poll but left the message behind - `onActivated` only reloaded the
 * list, and the only writers of the status lived in the interval that had just
 * been cleared - so coming back within the wait showed "Waiting for the new run
 * to appear…" forever, even once the new run was in the refreshed list, and the
 * timeout could never fire either.
 */
describe('RepoActions dispatch wait across deactivate/activate', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    stateMock.loading.clear();
    stateMock.errors.clear();
    stateMock.actionRuns.value.clear();
    stateMock.lastDispatchCancelled.value = undefined;
  });

  it('clears the wait when the refreshed list contains the new run', async () => {
    vi.useFakeTimers();
    try {
      const wrapper = mountHost();
      await dispatchWorkflow(wrapper);
      expect(wrapper.text()).toContain('Waiting for the new run to appear');

      // The user leaves the Actions view while the wait is still running, and
      // comes back to it.
      await wrapper.setProps({ show: false });
      await nextTick();
      await wrapper.setProps({ show: true });
      await nextTick();

      // The activation refresh answers with a list that has the new run in it.
      state.actionRuns.value.set(RUNS_KEY, [newRun(1)]);
      await nextTick();

      expect(wrapper.text()).not.toContain('Waiting for the new run to appear');
      expect(wrapper.text()).not.toContain('no new run appeared yet');
      wrapper.unmount();
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps the wait running and still times out when no run ever appears', async () => {
    vi.useFakeTimers();
    try {
      const wrapper = mountHost();
      await dispatchWorkflow(wrapper);
      expect(wrapper.text()).toContain('Waiting for the new run to appear');

      // Two poll intervals pass before the user leaves.
      await vi.advanceTimersByTimeAsync(4000 * 2);
      await nextTick();
      expect(wrapper.text()).toContain('Waiting for the new run to appear');

      await wrapper.setProps({ show: false });
      await nextTick();
      await wrapper.setProps({ show: true });
      await nextTick();

      // The resumed poll still has its remaining attempts: the wait ends in the
      // timeout the user is told about instead of hanging on "waiting".
      await vi.advanceTimersByTimeAsync(4000 * 16);
      await nextTick();

      expect(wrapper.text()).toContain('no new run appeared yet');
      expect(wrapper.text()).not.toContain('Waiting for the new run to appear');
      wrapper.unmount();
    } finally {
      vi.useRealTimers();
    }
  });

  it('reports the timeout on re-entry once the ~60 s wait has already expired', async () => {
    vi.useFakeTimers();
    try {
      const wrapper = mountHost();
      await dispatchWorkflow(wrapper);

      // The user is away for longer than the whole wait (no poll runs while the
      // view is off screen), then returns.
      await wrapper.setProps({ show: false });
      await nextTick();
      await vi.advanceTimersByTimeAsync(70_000);
      await wrapper.setProps({ show: true });
      await nextTick();

      // The timeout is authoritative: the ~60 s were spent, whether or not the
      // view was the one watching the clock.
      expect(wrapper.text()).toContain('no new run appeared yet');
      expect(wrapper.text()).not.toContain('Waiting for the new run to appear');
      wrapper.unmount();
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not restart a wait that already ended before the view was left', async () => {
    vi.useFakeTimers();
    try {
      const wrapper = mountHost();
      await dispatchWorkflow(wrapper);

      state.actionRuns.value.set(RUNS_KEY, [newRun(1)]);
      await nextTick();
      await vi.advanceTimersByTimeAsync(4000 * 16);
      await nextTick();
      expect(wrapper.text()).not.toContain('Waiting for the new run to appear');

      // Leaving and re-entering much later must not revive the finished wait.
      await wrapper.setProps({ show: false });
      await nextTick();
      await vi.advanceTimersByTimeAsync(10 * 60_000);
      await wrapper.setProps({ show: true });
      await nextTick();

      expect(wrapper.text()).not.toContain('Waiting for the new run to appear');
      expect(wrapper.text()).not.toContain('no new run appeared yet');
      wrapper.unmount();
    } finally {
      vi.useRealTimers();
    }
  });

  /**
   * The wait used to be armed by an observed loading true→false transition while
   * the view was active. Leaving the view between the dispatch and its reply
   * therefore skipped both halves of the feedback: the promise made when `Run`
   * was used showed neither "waiting" nor, when the run never showed up, the
   * ~60 s timeout — the user came back to a form that said nothing at all.
   */
  it('waits and then times out when the reply lands while the view is off screen', async () => {
    vi.useFakeTimers();
    try {
      const wrapper = mountHost();
      const triggerButton = wrapper.findAll('vscode-button').find((b) => b.text().includes('Trigger workflow'));
      await triggerButton!.trigger('click');
      const textfields = wrapper.findAll('vscode-textfield');
      (textfields[0].element as unknown as { value: string }).value = 'ci.yml';
      await textfields[0].trigger('input');
      (textfields[1].element as unknown as { value: string }).value = 'main';
      await textfields[1].trigger('input');
      const runButton = wrapper.findAll('vscode-button').find((b) => b.text().trim() === 'Run');
      await runButton!.trigger('click');

      // The user leaves before the host answers the dispatch.
      await wrapper.setProps({ show: false });
      await nextTick();

      // The host accepts it now — with the view deactivated, so nothing observes
      // the loading transition that used to arm the wait.
      stateMock.loading.set(DISPATCH_KEY, true);
      await nextTick();
      stateMock.loading.set(DISPATCH_KEY, false);
      await nextTick();

      await wrapper.setProps({ show: true });
      await nextTick();

      // The wait was armed with the request, so coming back shows it waiting...
      expect(wrapper.text()).toContain('Waiting for the new run to appear');

      // ...and it ends in the timeout the user is told about, because the ~60 s
      // budget also started with the request.
      await vi.advanceTimersByTimeAsync(70_000);
      await nextTick();

      expect(wrapper.text()).toContain('no new run appeared yet');
      expect(wrapper.text()).not.toContain('Waiting for the new run to appear');
      wrapper.unmount();
    } finally {
      vi.useRealTimers();
    }
  });
});
