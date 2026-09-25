import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { nextTick } from 'vue';
import { createTestRouter, createTestI18n } from '../../__tests__/helpers/test-utils';

let messageHandlers: Array<(event: MessageEvent) => void> = [];

beforeEach(() => {
  messageHandlers = [];
  (window as unknown as { acquireVsCodeApi: () => unknown }).acquireVsCodeApi = () => ({
    postMessage: vi.fn(),
    getState: vi.fn(() => undefined),
    setState: vi.fn(),
  });
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
      global: {
        plugins: [createTestRouter(), createTestI18n()],
      },
    },
  );
  await flushPromises();
  return { wrapper, state: wrapper.vm.state as ReturnType<typeof mod.useAppState>, mod };
}

/**
 * Views record failures directly (`state.errors.set(...)`), bypassing the cap
 * the composable's internal `setError` enforced, so the bound lives in the
 * exported map itself: a long session cannot grow it past
 * `MAX_TRACKING_ENTRIES`.
 */
describe('useAppState errors map bound', () => {
  it('caps direct writes at MAX_TRACKING_ENTRIES, evicting the oldest entry', async () => {
    const { state, mod } = await createState();
    const max = mod.MAX_TRACKING_ENTRIES;

    for (let index = 0; index < max; index++) {
      state.errors.set(`key-${index}`, `error ${index}`);
    }
    expect(state.errors.size).toBe(max);

    state.errors.set('key-new', 'new');

    expect(state.errors.size).toBe(max);
    expect(state.errors.has('key-0')).toBe(false);
    expect(state.errors.get('key-1')).toBe('error 1');
    expect(state.errors.get('key-new')).toBe('new');
  });

  it('updates an existing key in place without evicting a sibling', async () => {
    const { state, mod } = await createState();
    const max = mod.MAX_TRACKING_ENTRIES;

    for (let index = 0; index < max; index++) {
      state.errors.set(`key-${index}`, `error ${index}`);
    }
    // A rewrite is an update, not a new entry: nothing is evicted for it, and
    // the key keeps its position, so the next insertion still evicts `key-0`
    // (a re-insert would have made `key-1` the oldest instead).
    state.errors.set('key-0', 'updated');
    expect(state.errors.size).toBe(max);
    expect(state.errors.get('key-0')).toBe('updated');

    state.errors.set('key-new', 'new');
    expect(state.errors.has('key-0')).toBe(false);
    expect(state.errors.get('key-1')).toBe('error 1');
    expect(state.errors.size).toBe(max);
  });

  it('bounds errors written through the composable handlers the same way', async () => {
    const { state, mod } = await createState();
    const max = mod.MAX_TRACKING_ENTRIES;

    for (let index = 0; index < max; index++) {
      state.errors.set(`key-${index}`, `error ${index}`);
    }

    // A failed load reply goes through the composable's own `setError`.
    dispatchMessage({
      command: 'repoDetail',
      instanceId: 'inst-1',
      owner: 'owner',
      repo: 'repo',
      error: 'Not found',
    });
    await nextTick();

    expect(state.errors.size).toBe(max);
    expect(state.errors.has('key-0')).toBe(false);
    expect(state.errors.get(mod.repoDetailKey('inst-1', 'owner', 'repo'))).toBe('Not found');
  });

  it('still supports the reads and deletes consumers rely on', async () => {
    const { state } = await createState();

    state.errors.set('key', 'message');
    expect(state.errors.get('key')).toBe('message');
    expect(state.errors.has('key')).toBe(true);
    expect([...state.errors.keys()]).toEqual(['key']);

    state.errors.delete('key');
    expect(state.errors.get('key')).toBeUndefined();
    expect(state.errors.size).toBe(0);
  });
});
