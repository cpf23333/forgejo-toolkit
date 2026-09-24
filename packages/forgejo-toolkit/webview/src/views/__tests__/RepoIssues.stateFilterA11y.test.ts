import { describe, expect, it, vi, beforeEach } from 'vitest';
import { defineComponent, nextTick, reactive } from 'vue';
import { mount } from '@vue/test-utils';

const { stateMock, keyFor } = vi.hoisted(() => {
  const keyFor = (...parts: unknown[]) => parts.join('|');
  return {
    keyFor,
    stateMock: {
      loading: new Map<string, boolean>(),
      errors: new Map<string, string>(),
      repoIssues: { value: new Map<string, unknown[]>() },
      repoDetails: { value: new Map<string, unknown>() },
      repoLabels: { value: new Map<string, unknown>() },
      repoAssignees: { value: new Map<string, unknown>() },
      repoMilestones: { value: new Map<string, unknown>() },
      repoRefs: { value: new Map<string, unknown>() },
      pendingNewIssue: { value: undefined },
      loadRepoIssues: vi.fn(),
      loadRepoDetail: vi.fn(),
      loadRepoLabels: vi.fn(),
      loadRepoAssignees: vi.fn(),
      loadRepoMilestones: vi.fn(),
      loadRepoRefs: vi.fn(),
      changeRepoIssuesState: vi.fn(),
      consumePendingNewIssue: vi.fn(),
      createIssue: vi.fn(),
      editIssue: vi.fn(),
      openExternal: vi.fn(),
      openIssueDetail: vi.fn(),
      uploadIssueAttachment: vi.fn(),
    },
  };
});

// Reactive so a change of the state param (what clicking a filter does in the
// app) reaches the view's computed.
vi.mock('vue-router', async () => {
  const { reactive: makeReactive } = await import('vue');
  const route = makeReactive({
    path: '/repo/inst-1/owner/repoA/issues/open',
    params: { instanceId: 'inst-1', owner: 'owner', repo: 'repoA', state: 'open' },
  });
  return { useRoute: () => route, useRouter: () => ({ push: vi.fn() }), __route: route };
});

vi.mock('../../composables/useAppState', async () => {
  const state = reactive(stateMock);
  const keyBuilder = (...parts: unknown[]) => keyFor(...parts);
  return {
    useAppState: () => state,
    issueFormKey: keyBuilder,
    repoDetailKey: keyBuilder,
    repoIssuesKey: keyBuilder,
    repoLabelsKey: keyBuilder,
    repoAssigneesKey: keyBuilder,
    repoMilestonesKey: keyBuilder,
    repoRefsKey: keyBuilder,
  };
});

import * as routerModule from 'vue-router';
import RepoIssues from '../RepoIssues.vue';
import { useAppState } from '../../composables/useAppState';
import { createTestI18n } from '../../__tests__/helpers/test-utils';

const route = (routerModule as unknown as { __route: { params: Record<string, string> } }).__route;

const IssueFormStub = defineComponent({
  name: 'IssueForm',
  props: { uploadImage: { type: Function, default: undefined } },
  emits: ['submit', 'cancel', 'dirty'],
  template: '<div class="issue-form-stub"><slot name="extra" /></div>',
});

const AttachmentListStub = defineComponent({
  name: 'AttachmentList',
  props: { assets: { type: Array, default: () => [] } },
  emits: ['upload', 'delete', 'openExternal'],
  template: '<div class="attachment-list-stub" />',
});

function mountView() {
  return mount(RepoIssues, {
    global: {
      plugins: [createTestI18n('en')],
      stubs: { IssueForm: IssueFormStub, AttachmentList: AttachmentListStub },
    },
  });
}

function filter(wrapper: ReturnType<typeof mountView>, label: string) {
  const button = wrapper.findAll('.filter-button').find((candidate) => candidate.text().trim() === label);
  expect(button, `${label} filter`).toBeTruthy();
  return button!;
}

/** label -> aria-pressed, in the order the buttons render. */
function pressedState(wrapper: ReturnType<typeof mountView>): Array<[string, string | undefined]> {
  return wrapper.findAll('.filter-button').map((button) => [button.text().trim(), button.attributes('aria-pressed')]);
}

/**
 * The state filter is a set of toggle buttons, but it carried the active state
 * only in a CSS class: assistive technology heard three identical, stateless
 * buttons ("Open", "Closed", "All") and could not tell which filter the list was
 * showing.
 */
describe('RepoIssues state filter toggle semantics', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    route.params.state = 'open';
  });

  it('exposes which state is active and follows the filter', async () => {
    const wrapper = mountView();
    await nextTick();

    expect(pressedState(wrapper)).toEqual([
      ['Open', 'true'],
      ['Closed', 'false'],
      ['All', 'false'],
    ]);
    // The visual state and the announced state agree.
    expect(filter(wrapper, 'Open').classes()).toContain('active');

    await filter(wrapper, 'Closed').trigger('click');
    expect((useAppState() as unknown as typeof stateMock).changeRepoIssuesState).toHaveBeenCalledWith(
      'inst-1',
      'owner',
      'repoA',
      'closed',
    );

    // The route follows the click in the app; the pressed state follows it.
    route.params.state = 'closed';
    await nextTick();

    expect(pressedState(wrapper)).toEqual([
      ['Open', 'false'],
      ['Closed', 'true'],
      ['All', 'false'],
    ]);
    expect(filter(wrapper, 'Closed').classes()).toContain('active');
    wrapper.unmount();
  });
});
