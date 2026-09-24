import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { nextTick } from 'vue';
import { createTestRouter, createTestI18n } from '../../__tests__/helpers/test-utils';

let messageHandlers: Array<(event: MessageEvent) => void> = [];
let vscodeApiMock: {
  postMessage: ReturnType<typeof vi.fn>;
  getState: ReturnType<typeof vi.fn>;
  setState: ReturnType<typeof vi.fn>;
};

beforeEach(() => {
  messageHandlers = [];
  vscodeApiMock = {
    postMessage: vi.fn(),
    getState: vi.fn(() => undefined),
    setState: vi.fn(),
  };
  (window as unknown as { acquireVsCodeApi: () => typeof vscodeApiMock }).acquireVsCodeApi = () => vscodeApiMock;
  vi.spyOn(window, 'addEventListener').mockImplementation((type, listener) => {
    if (type === 'message') {
      messageHandlers.push(listener as (event: MessageEvent) => void);
    }
  });
});

afterEach(() => {
  messageHandlers = [];
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

function dispatchMessage(message: unknown) {
  const event = new MessageEvent('message', { data: message });
  messageHandlers.forEach((handler) => handler(event));
}

async function createState() {
  vi.resetModules();
  const mod = await import('../../composables/useAppState');
  const router = createTestRouter();
  const i18n = createTestI18n();
  const wrapper = mount(
    {
      template: '<div></div>',
      setup() {
        const state = mod.useAppState();
        return { state };
      },
    },
    {
      global: {
        plugins: [router, i18n],
      },
    },
  );
  await flushPromises();
  return { wrapper, state: wrapper.vm.state as ReturnType<typeof mod.useAppState> };
}

const START_WORK_REPLY = { instanceId: 'inst-1', owner: 'owner', repo: 'repo', index: 5 };

const CREATED_WORKTREE = {
  id: 'issue-worktree-5',
  kind: 'issue',
  instanceId: 'inst-1',
  owner: 'owner',
  repo: 'repo',
  prIndex: 5,
  worktreePath: '/tmp/worktrees/issue-5',
  headBranch: 'issue-5-fix',
};

/**
 * "Start work" creates a worktree in the host and answers with a bare
 * `startWorkResult`, so the Settings list (rendered from `worktrees`) never
 * learned about it until a full state snapshot arrived. The webview merges the
 * record when the host sends it with the reply, the same shape
 * `worktreeOpened` already uses; a reply without one must not invent an entry.
 */
describe('useAppState startWorkResult worktree', () => {
  it('adds the worktree the host reports to the list Settings renders', async () => {
    const { state } = await createState();
    expect(state.worktrees.value).toEqual([]);

    dispatchMessage({ command: 'startWorkResult', ...START_WORK_REPLY, worktree: CREATED_WORKTREE });
    await nextTick();

    expect(state.worktrees.value.map((entry) => entry.id)).toEqual([CREATED_WORKTREE.id]);
  });

  it('replaces an existing entry with the same id instead of duplicating it', async () => {
    const { state } = await createState();
    state.worktrees.value = [{ ...CREATED_WORKTREE, worktreePath: '/tmp/worktrees/old' } as never];

    dispatchMessage({ command: 'startWorkResult', ...START_WORK_REPLY, worktree: CREATED_WORKTREE });
    await nextTick();

    expect(state.worktrees.value).toHaveLength(1);
    expect(state.worktrees.value[0].worktreePath).toBe(CREATED_WORKTREE.worktreePath);
  });

  it('does not add anything for a reply without a worktree', async () => {
    const { state } = await createState();

    dispatchMessage({ command: 'startWorkResult', ...START_WORK_REPLY });
    await nextTick();

    expect(state.worktrees.value).toEqual([]);
  });

  it('does not add a worktree for a failed reply', async () => {
    const { state } = await createState();

    dispatchMessage({ command: 'startWorkResult', ...START_WORK_REPLY, error: 'branch exists' });
    await nextTick();

    expect(state.worktrees.value).toEqual([]);
  });

  it('ignores a malformed worktree record', async () => {
    const { state } = await createState();

    dispatchMessage({ command: 'startWorkResult', ...START_WORK_REPLY, worktree: { worktreePath: '/tmp/x' } });
    await nextTick();

    expect(state.worktrees.value).toEqual([]);
  });
});
