import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mount } from '@vue/test-utils';
import { defineComponent, h, KeepAlive } from 'vue';
import RepoActions from '../RepoActions.vue';
import { createTestI18n } from '../../__tests__/helpers/test-utils';

const { stateMock } = vi.hoisted(() => ({
  stateMock: {
    loading: new Map<string, boolean>(),
    errors: new Map<string, string>(),
    actionRuns: { value: new Map<string, unknown[]>() },
    actionRunTotalCount: { value: new Map<string, number>() },
    loadActionRuns: vi.fn(),
    dispatchWorkflow: vi.fn(),
    openActionRunDetail: vi.fn(),
    openExternal: vi.fn(),
  },
}));

vi.mock('../../composables/useAppState', () => ({
  useAppState: () => stateMock,
  actionRunsKey: (instanceId: string, owner: string, repo: string, page: number) =>
    `${instanceId}:${owner}/${repo}:actions:page-${page}`,
  dispatchWorkflowKey: (instanceId: string, owner: string, repo: string, workflow: string) =>
    `${instanceId}:${owner}/${repo}:actions:dispatch:${workflow}`,
}));

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
