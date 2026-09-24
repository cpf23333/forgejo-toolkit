import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import { defineComponent, nextTick, type Component } from 'vue';
import { createTestI18n, createTestRouter } from '../../__tests__/helpers/test-utils';

// The failure paths are host round-trips, so these tests drive the real
// composable and dispatch real replies rather than mocking `useAppState`: a mock
// can show that a handler was called but not that the error reached the section
// the user reads.
const { postMessageMock } = vi.hoisted(() => ({ postMessageMock: vi.fn() }));

vi.mock('../../composables/vscode', () => ({ postMessage: postMessageMock }));

const EasyMdeEditorStub = defineComponent({ name: 'EasyMdeEditor', template: '<textarea />' });

async function mountIssueDetail() {
  vi.resetModules();
  const { default: IssueDetail } = (await import('../IssueDetail.vue')) as { default: Component };
  const router = createTestRouter();
  await router.push({
    name: 'issueDetail',
    params: { instanceId: 'inst-1', owner: 'owner', repo: 'repoA', index: '5' },
  });
  const wrapper = mount(IssueDetail, {
    global: {
      plugins: [router, createTestI18n('en')],
      stubs: { EasyMdeEditor: EasyMdeEditorStub },
    },
  });
  await flushPromises();
  window.dispatchEvent(
    new MessageEvent('message', {
      data: {
        command: 'issueDetail',
        instanceId: 'inst-1',
        owner: 'owner',
        repo: 'repoA',
        index: 5,
        detail: { number: 5, title: 'an issue', user: { login: 'demo-user' }, labels: [], assignees: [] },
      },
    }),
  );
  await flushPromises();
  return wrapper;
}

function dispatchDependencies(payload: Record<string, unknown>) {
  window.dispatchEvent(
    new MessageEvent('message', {
      data: { command: 'issueDependencies', instanceId: 'inst-1', owner: 'owner', repo: 'repoA', index: 5, ...payload },
    }),
  );
}

/**
 * The dependency section had no error branch: a failed load fell through to "No
 * dependencies set.", which states as fact something the webview does not know,
 * and a failed add/remove rendered nothing at all — the row the user tried to
 * remove stayed put with no reason. The host sends no toast for either, so the
 * section is the only place the failure can appear.
 */
describe('IssueDetail dependency errors', () => {
  beforeEach(() => {
    postMessageMock.mockClear();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('shows the failure instead of claiming the issue has no dependencies', async () => {
    const wrapper = await mountIssueDetail();
    await nextTick();

    dispatchDependencies({ error: 'permission denied' });
    await nextTick();

    expect(wrapper.text()).toContain('Failed to load dependencies: permission denied');
    expect(wrapper.text()).not.toContain('No dependencies set.');
    wrapper.unmount();
  });

  it('keeps the empty state for a successful empty load', async () => {
    const wrapper = await mountIssueDetail();
    await nextTick();

    dispatchDependencies({ dependencies: [] });
    await nextTick();

    expect(wrapper.text()).toContain('No dependencies set.');
    expect(wrapper.text()).not.toContain('Failed to load dependencies');
    wrapper.unmount();
  });

  it('keeps the picked issue selected (and says why) when the add fails', async () => {
    const wrapper = await mountIssueDetail();
    await nextTick();

    // A list is on screen already: the wording under test is the change failure,
    // not the load one.
    dispatchDependencies({ dependencies: [{ id: 1, number: 9, title: 'blocking issue' }] });
    await nextTick();

    // The user picks #7 and presses Add; the host replies with a failure.
    (wrapper.vm as unknown as { selectedDependencyNumber: number }).selectedDependencyNumber = 7;
    (wrapper.vm as unknown as { addDependency: () => void }).addDependency();
    await nextTick();

    expect(postMessageMock).toHaveBeenCalledWith(
      expect.objectContaining({ command: 'createIssueDependency', dependencyIndex: 7 }),
    );

    window.dispatchEvent(
      new MessageEvent('message', {
        data: {
          command: 'issueDependencyChanged',
          instanceId: 'inst-1',
          owner: 'owner',
          repo: 'repoA',
          index: 5,
          dependencyIndex: 7,
          action: 'add',
          error: 'the issue is already a dependency',
        },
      }),
    );
    await nextTick();

    // The failure is explained, and the pick survives so a retry needs no
    // re-picking.
    expect(wrapper.text()).toContain('Failed to change dependencies: the issue is already a dependency');
    expect((wrapper.vm as unknown as { selectedDependencyNumber: number | undefined }).selectedDependencyNumber).toBe(
      7,
    );
    wrapper.unmount();
  });

  it('clears the pick once the add succeeds', async () => {
    const wrapper = await mountIssueDetail();
    await nextTick();

    dispatchDependencies({ dependencies: [{ id: 1, number: 9, title: 'blocking issue' }] });
    await nextTick();

    (wrapper.vm as unknown as { selectedDependencyNumber: number }).selectedDependencyNumber = 7;
    (wrapper.vm as unknown as { addDependency: () => void }).addDependency();
    await nextTick();

    window.dispatchEvent(
      new MessageEvent('message', {
        data: {
          command: 'issueDependencyChanged',
          instanceId: 'inst-1',
          owner: 'owner',
          repo: 'repoA',
          index: 5,
          dependencyIndex: 7,
          action: 'add',
        },
      }),
    );
    await nextTick();
    // A successful change reloads the list, and the reloaded payload is what the
    // view treats as the settle (see addDependency).
    dispatchDependencies({ dependencies: [{ id: 1, number: 9, title: 'blocking issue' }] });
    await flushPromises();

    expect((wrapper.vm as unknown as { selectedDependencyNumber: number | undefined }).selectedDependencyNumber).toBe(
      undefined,
    );
    wrapper.unmount();
  });

  it('explains a failed removal without dropping the row', async () => {
    const wrapper = await mountIssueDetail();
    await nextTick();

    dispatchDependencies({ dependencies: [{ id: 1, number: 9, title: 'blocking issue' }] });
    await nextTick();
    expect(wrapper.text()).toContain('#9 blocking issue');

    // The user removes #9 from its row. The view's own handler dispatches the
    // request, which is also what tells the shared dependency key that the reason
    // it reports belongs to a change and not to a load.
    (wrapper.vm as unknown as { handleRemoveDependency: (number: number) => void }).handleRemoveDependency(9);
    await nextTick();

    window.dispatchEvent(
      new MessageEvent('message', {
        data: {
          command: 'issueDependencyChanged',
          instanceId: 'inst-1',
          owner: 'owner',
          repo: 'repoA',
          index: 5,
          dependencyIndex: 9,
          action: 'remove',
          error: 'the dependency is required',
        },
      }),
    );
    await nextTick();

    expect(wrapper.text()).toContain('Failed to change dependencies: the dependency is required');
    // The row is still listed: nothing was removed, so nothing may look removed.
    expect(wrapper.text()).toContain('#9 blocking issue');
    wrapper.unmount();
  });

  it('does not announce a change failure for a load failure', async () => {
    // The wording distinguishes the two: a load failure must not read as "the
    // change failed" (the user changed nothing), and vice versa.
    const wrapper = await mountIssueDetail();
    await nextTick();

    dispatchDependencies({ error: 'network down' });
    await nextTick();

    expect(wrapper.text()).not.toContain('Failed to change dependencies');
    wrapper.unmount();
  });

  it('names the change, not the load, when the add fails on an issue with no dependencies yet', async () => {
    // The list is empty here because the issue has none, not because a load
    // failed — no dependency payload ever arrived. The change-failure line used to
    // be gated on `dependencies.length`, so this exact case rendered "Failed to
    // load dependencies" for an add the user had just made: the load had
    // succeeded (or was never the failing request), and the label named a cause
    // the code never established.
    const wrapper = await mountIssueDetail();
    await nextTick();

    (wrapper.vm as unknown as { selectedDependencyNumber: number }).selectedDependencyNumber = 7;
    (wrapper.vm as unknown as { addDependency: () => void }).addDependency();
    await nextTick();

    window.dispatchEvent(
      new MessageEvent('message', {
        data: {
          command: 'issueDependencyChanged',
          instanceId: 'inst-1',
          owner: 'owner',
          repo: 'repoA',
          index: 5,
          dependencyIndex: 7,
          action: 'add',
          error: 'the issue is already a dependency',
        },
      }),
    );
    await nextTick();

    expect(wrapper.text()).toContain('Failed to change dependencies: the issue is already a dependency');
    expect(wrapper.text()).not.toContain('Failed to load dependencies');
    wrapper.unmount();
  });

  it('keeps the load wording for a failed load on an issue with no dependencies', async () => {
    const wrapper = await mountIssueDetail();
    await nextTick();

    dispatchDependencies({ error: 'permission denied' });
    await nextTick();

    expect(wrapper.text()).toContain('Failed to load dependencies: permission denied');
    expect(wrapper.text()).not.toContain('Failed to change dependencies');
    wrapper.unmount();
  });
});
