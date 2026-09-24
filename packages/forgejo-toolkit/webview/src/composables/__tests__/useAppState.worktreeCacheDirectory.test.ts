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
  const wrapper = mount(
    {
      template: '<div></div>',
      setup() {
        const state = mod.useAppState();
        return { state };
      },
    },
    {
      global: { plugins: [createTestRouter(), createTestI18n()] },
    },
  );
  await flushPromises();
  return { wrapper, state: wrapper.vm.state as ReturnType<typeof mod.useAppState> };
}

/**
 * The host validates a requested cache directory before persisting it and only
 * replies with `worktreeCacheDirectory` when it accepted the path; a rejected
 * one is answered with a native error and nothing else (see the host's
 * `_setWorktreeCacheDirectory`). The composable used to write the requested
 * path into state up front, so the webview could not tell a rejected path from
 * an applied one — and Settings showed a directory that was not in use.
 */
describe('useAppState worktree cache directory', () => {
  it('keeps the directory the host confirmed until it answers a request', async () => {
    const { state } = await createState();
    dispatchMessage({
      command: 'worktreeCacheDirectory',
      directory: '/host/current',
      defaultDirectory: '/host/default',
    });
    await nextTick();
    expect(state.worktreeCacheDirectory.value).toBe('/host/current');

    state.setWorktreeCacheDirectory('/requested/path');

    expect(vscodeApiMock.postMessage).toHaveBeenCalledWith({
      command: 'setWorktreeCacheDirectory',
      directory: '/requested/path',
    });
    // The host has not answered yet: a path it may still reject must not
    // replace the directory that is actually in use.
    expect(state.worktreeCacheDirectory.value).toBe('/host/current');
  });

  it('adopts the directory the host replies with', async () => {
    const { state } = await createState();
    state.setWorktreeCacheDirectory('/requested/path');

    dispatchMessage({
      command: 'worktreeCacheDirectory',
      directory: '/accepted/path',
      defaultDirectory: '/host/default',
    });
    await nextTick();

    expect(state.worktreeCacheDirectory.value).toBe('/accepted/path');
    expect(state.worktreeCacheDirectoryDefault.value).toBe('/host/default');
  });
});
