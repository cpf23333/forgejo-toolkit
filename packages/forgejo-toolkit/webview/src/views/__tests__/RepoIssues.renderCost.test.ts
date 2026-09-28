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
      repoIssuesTotalCount: { value: new Map<string, number>() },
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
 * issues without virtualization, and the numbers below decide whether that is
 * acceptable or needs windowing — they are recorded here and in the commit that
 * added this test, not in TODO.md.
 *
 * The cheap numbers (rows, elements) are asserted as change detectors, not as
 * performance thresholds: if the list starts virtualizing, if a card loses or
 * gains an element, or if a page stops rendering all 500 items, the recorded
 * decision is no longer describing this code and the test must fail. Anything
 * that changes the DOM must therefore update the constants here in the same
 * change. Rendering time is printed for the record but deliberately
 * not asserted — it is machine-dependent and would only produce flaky failures.
 *
 * Measured on 2026-09-23 (jsdom): 500 rows, 5,536 elements, ~200 ms. Re-measured
 * when this test was strengthened: same counts, ~120 ms on the dev machine.
 */
describe('RepoIssues render cost', () => {
  /**
   * One full page. The host caps a paged list at `LIST_ITEM_LIMIT` from
   * `@cpf23333-forgejo-toolkit/shared/limits`, which is set to this number.
   */
  const FULL_PAGE = 500;
  /**
   * `.item-card` count for a full page. The fixture holds `FULL_PAGE` items, i.e.
   * exactly at the limit and not above it, so the truncation notice is not
   * rendered and every item gets a card.
   */
  const EXPECTED_ROWS = FULL_PAGE;
  /** Total elements under the mounted root: the header/actions plus 500 cards. */
  const EXPECTED_ELEMENTS = 5536;
  /** Title + state badge per card, used to prove every row is fully rendered. */
  const EXPECTED_TITLES = FULL_PAGE;
  const EXPECTED_STATE_BADGES = FULL_PAGE;

  it('renders a full 500-issue page', async () => {
    const state = useAppState() as unknown as { repoIssues: { value: Map<string, unknown[]> } };
    const issues = Array.from({ length: FULL_PAGE }, (_, i) => ({
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
    const rows = wrapper.findAll('.item-card');
    const titles = wrapper.findAll('.item-title');
    const badges = wrapper.findAll('.state-badge');
    const cards = rows.map((row) => row.text());
    console.log(`[perf] ${FULL_PAGE} issues -> ${rows.length} rows, ${elements} elements, ${elapsed.toFixed(1)} ms`);

    // Everything below is a change detector for the "no virtualization" decision:
    // a virtualized list would render far fewer cards than the page holds.
    expect(rows).toHaveLength(EXPECTED_ROWS);
    expect(titles).toHaveLength(EXPECTED_TITLES);
    expect(badges).toHaveLength(EXPECTED_STATE_BADGES);
    expect(elements).toBe(EXPECTED_ELEMENTS);

    // The first and last item of the page are really in the DOM: a list that only
    // rendered the first screenful would still pass a bare `.length > 0` check.
    expect(cards[0]).toContain('#1 issue 1');
    expect(cards[cards.length - 1]).toContain(`#${FULL_PAGE} issue ${FULL_PAGE}`);

    wrapper.unmount();
  });
});
