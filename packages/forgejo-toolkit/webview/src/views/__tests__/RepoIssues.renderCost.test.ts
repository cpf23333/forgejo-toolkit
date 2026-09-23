import { describe, expect, it, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import { nextTick, reactive } from 'vue';

const { routeMock, stateMock, keyFor } = vi.hoisted(() => {
  const keyFor = (...parts: unknown[]) => parts.join('|');
  return {
    keyFor,
    routeMock: { params: { instanceId: 'inst-1', owner: 'owner', repo: 'repo', state: 'open' } },
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

vi.mock('vue-router', () => ({ useRoute: () => routeMock, useRouter: () => ({ push: vi.fn() }) }));

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

import RepoIssues from '../RepoIssues.vue';
import { useAppState } from '../../composables/useAppState';
import { createTestI18n } from '../../__tests__/helpers/test-utils';

/**
 * Measurement, not a behaviour test: the dashboard renders a whole page of 500
 * issues without virtualization, and the number below is what decides whether that
 * is acceptable or needs windowing. The assertion is deliberately loose; the
 * printed line is the evidence (see TODO for the decision it feeds).
 */
describe('RepoIssues render cost', () => {
  it('renders a full 500-issue page', async () => {
    const state = useAppState() as unknown as { repoIssues: { value: Map<string, unknown[]> } };
    const issues = Array.from({ length: 500 }, (_, i) => ({
      id: i + 1,
      number: i + 1,
      title: `issue ${i + 1}`,
      state: 'open',
      user: { login: 'demo-user' },
      labels: [],
      created_at: '2026-01-01T00:00:00Z',
    }));
    state.repoIssues.value.set(keyFor('inst-1', 'owner', 'repo', 'open', ''), issues);

    const started = performance.now();
    const wrapper = mount(RepoIssues, { global: { plugins: [createTestI18n('en')] } });
    await nextTick();
    const elapsed = performance.now() - started;
    const elements = wrapper.element.querySelectorAll('*').length;
    const rows = wrapper.findAll('.item-card').length;
    console.log(`[perf] 500 issues -> ${rows} rows, ${elements} elements, ${elapsed.toFixed(1)} ms`);

    expect(rows).toBeGreaterThan(0);
    expect(elements).toBeGreaterThan(rows);
    wrapper.unmount();
  });
});
