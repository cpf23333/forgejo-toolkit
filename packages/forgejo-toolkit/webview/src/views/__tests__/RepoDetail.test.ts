import { describe, expect, it, vi } from 'vitest';
import { defineComponent, nextTick, reactive } from 'vue';
import { mount } from '@vue/test-utils';

const { stateMock, keyFor } = vi.hoisted(() => {
  const keyFor = (...parts: unknown[]) => parts.join('|');
  return {
    keyFor,
    stateMock: {
      instances: { value: [{ id: 'inst-1', url: 'https://forgejo.example.com', username: 'demo-user' }] },
      repoDetails: { value: new Map<string, unknown>() },
      repoBranchCommits: { value: new Map<string, unknown>() },
      loading: new Map<string, boolean>(),
      errors: new Map<string, string>(),
      loadRepoDetail: vi.fn(),
      loadRepoBranchCommits: vi.fn(),
      previewReadme: vi.fn(),
    },
  };
});

// Reactive params: this view stays cached (keep-alive) while the user opens
// another repository, so the route must be able to move under it.
vi.mock('vue-router', async () => {
  const { reactive: makeReactive } = await import('vue');
  const params = makeReactive({ instanceId: 'inst-1', owner: 'owner', repo: 'repoA' });
  return { useRoute: () => ({ params }), useRouter: () => ({ push: vi.fn() }), __params: params };
});

vi.mock('../../composables/useAppState', async () => {
  const state = reactive(stateMock);
  const keyBuilder = (...parts: unknown[]) => keyFor(...parts);
  return {
    useAppState: () => state,
    repoDetailKey: keyBuilder,
    repoBranchCommitsKey: keyBuilder,
  };
});

import * as routerModule from 'vue-router';
import RepoDetail from '../RepoDetail.vue';
import { useAppState } from '../../composables/useAppState';
import { createTestI18n } from '../../__tests__/helpers/test-utils';

const routeParams = (routerModule as unknown as { __params: Record<string, string> }).__params;
// The reactive proxy the view reads: mutating the raw mock object would not
// notify anybody.
const state = useAppState() as unknown as {
  repoDetails: { value: Map<string, unknown> };
  previewReadme: ReturnType<typeof vi.fn>;
};

function repoDetail(key: string, defaultBranch?: string, branches: string[] = []) {
  return {
    empty: false,
    branches,
    recentCommits: [],
    repository: {
      full_name: `owner/${key}`,
      description: '',
      html_url: `https://forgejo.example.com/owner/${key}`,
      owner: { login: 'owner' },
      default_branch: defaultBranch,
      stars_count: 0,
      forks_count: 0,
      open_issues_count: 0,
      open_pr_counter: 0,
    },
  };
}

// The real shell renders every view inside <KeepAlive>, so a view that is
// navigated away from is deactivated rather than unmounted.
const Host = defineComponent({
  components: { RepoDetail },
  props: { show: { type: Boolean, default: true } },
  template: '<KeepAlive><RepoDetail v-if="show" /></KeepAlive>',
});

function mountHost() {
  return mount(Host, {
    global: {
      plugins: [createTestI18n('en')],
      stubs: { RepoActions: true, RepoFileBrowser: true, RepoRefs: true, ViewTabs: true },
    },
  });
}

describe('RepoDetail default branch adoption', () => {
  it('ignores the default branch of a repository it no longer owns', async () => {
    state.repoDetails.value.clear();
    routeParams.instanceId = 'inst-1';
    routeParams.owner = 'owner';
    routeParams.repo = 'repoA';

    const wrapper = mountHost();
    await nextTick();

    // The user leaves this repository while its own detail is still loading, so
    // the branch selection is still empty.
    wrapper.setProps({ show: false });
    await nextTick();

    routeParams.repo = 'repoB';
    state.repoDetails.value.set(keyFor('inst-1', 'owner', 'repoB'), repoDetail('repoB', 'main-b', ['main-b']));
    await nextTick();

    // Coming back to repoA: repoB's default branch must not have been adopted.
    routeParams.repo = 'repoA';
    state.repoDetails.value.set(keyFor('inst-1', 'owner', 'repoA'), repoDetail('repoA', undefined, ['main-a']));
    wrapper.setProps({ show: true });
    await nextTick();

    expect(wrapper.find('.branch-select').attributes('value')).not.toBe('main-b');
    expect(wrapper.find('.branch-select').attributes('value')).toBe('');
    wrapper.unmount();
  });

  it('adopts the default branch while the view owns the active repository', async () => {
    state.repoDetails.value.clear();
    routeParams.repo = 'repoA';
    state.repoDetails.value.set(keyFor('inst-1', 'owner', 'repoA'), repoDetail('repoA', undefined, ['main-a']));

    const wrapper = mountHost();
    await nextTick();
    expect(wrapper.find('.branch-select').attributes('value')).toBe('');

    // The detail lands while the view is active.
    state.repoDetails.value.set(keyFor('inst-1', 'owner', 'repoA'), repoDetail('repoA', 'main-a', ['main-a']));
    await nextTick();

    expect(wrapper.find('.branch-select').attributes('value')).toBe('main-a');
    wrapper.unmount();
  });
});

describe('RepoDetail README preview', () => {
  it('sends the instance id with the preview request', async () => {
    // The host keys the preview document by instance id, so two instances
    // showing a README must not share one document.
    state.repoDetails.value.clear();
    routeParams.instanceId = 'inst-1';
    routeParams.owner = 'owner';
    routeParams.repo = 'repoA';
    state.repoDetails.value.set(keyFor('inst-1', 'owner', 'repoA'), {
      ...repoDetail('repoA', 'main-a', ['main-a']),
      readme: '# repoA',
    });
    state.previewReadme.mockClear();

    const wrapper = mountHost();
    await nextTick();

    const preview = wrapper
      .findAll('vscode-button')
      .find((button) => button.attributes('aria-label') === 'Preview README');
    expect(preview).toBeTruthy();
    await preview!.trigger('click');

    expect(state.previewReadme).toHaveBeenCalledWith('inst-1', 'owner', 'repoA', '# repoA');
    wrapper.unmount();
  });
});
