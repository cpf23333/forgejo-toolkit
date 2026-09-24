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

/**
 * The host's `saveInstanceResult` carries no identity, so the composable
 * stamps it with the target of the latest intent it answers. Without that
 * stamp a view cannot tell which form the reply belongs to.
 */
describe('useAppState saveInstanceResult target', () => {
  it('stamps an add reply with the new-instance target', async () => {
    const { state } = await createState();

    state.saveInstance('https://a.example.com', 'token-a');
    dispatchMessage({ command: 'saveInstanceResult', success: true });
    await nextTick();

    expect(state.saveInstanceResult.value).toMatchObject({ success: true, target: { kind: 'new' } });
  });

  it('stamps an edit reply with the instance it was sent for', async () => {
    const { state } = await createState();

    state.editInstance('inst-1', 'https://b.example.com', 'token-b');
    dispatchMessage({ command: 'saveInstanceResult', success: true });
    await nextTick();

    expect(state.saveInstanceResult.value).toMatchObject({
      success: true,
      target: { kind: 'instance', instanceId: 'inst-1' },
    });
  });

  it('stamps the replayed edit intent once its own reply lands', async () => {
    const { state } = await createState();
    vscodeApiMock.postMessage.mockClear();

    // An add is in flight when the user edits an instance instead: the add's
    // reply is superseded, dropped, and the edit is replayed.
    state.saveInstance('https://a.example.com', 'token-a');
    state.editInstance('inst-1', 'https://b.example.com', 'token-b');

    dispatchMessage({ command: 'saveInstanceResult', success: true });
    await nextTick();

    expect(state.saveInstanceResult.value).toBeUndefined();
    expect(vscodeApiMock.postMessage).toHaveBeenLastCalledWith(
      expect.objectContaining({ command: 'editInstance', id: 'inst-1' }),
    );

    dispatchMessage({ command: 'saveInstanceResult', success: true });
    await nextTick();

    expect(state.saveInstanceResult.value).toMatchObject({
      success: true,
      target: { kind: 'instance', instanceId: 'inst-1' },
    });
  });
});
