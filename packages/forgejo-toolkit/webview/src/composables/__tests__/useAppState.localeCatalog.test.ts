import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { nextTick } from 'vue';
import { createTestRouter } from '../../__tests__/helpers/test-utils';
import { createI18nInstance } from '../../i18n';
import zh from '../../i18n/zh.json';

/**
 * Pins what a locale change does now that only the base catalog ships with the
 * bundle.
 *
 * `zh.json` is a dynamic import (see `src/i18n/locales.ts`), so switching a live
 * view to Chinese is a chunk load. These tests hold the composable to:
 *
 * - the host's `setLocale` / `initialState` switches the rendered language, and
 *   only after the catalog has landed;
 * - `changeLocale` stays optimistic — the settings control must react at once —
 *   and the host's `setLocale` echo is what completes the switch;
 * - `<html lang>` follows the rendered language, not the requested one.
 *
 * The lazy loader is replaced with a deferred this file resolves by hand, and
 * the i18n instance is built with the base catalog only (the shared test helper
 * pre-loads both, which would make every switch synchronous). Without both, the
 * "chunk in flight" window would depend on which other test file ran first.
 */

interface PendingCatalog {
  resolve: () => void;
}

let deferreds: PendingCatalog[] = [];

vi.mock('../../i18n/locales', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../i18n/locales')>();
  return {
    ...actual,
    localeCatalogLoaders: {
      en: () => import('../../i18n/en.json'),
      zh: () =>
        new Promise<{ default: Record<string, unknown> }>((resolve) => {
          deferreds.push({ resolve: () => resolve({ default: zh as Record<string, unknown> }) });
        }),
    },
  };
});

const messageHandlers: Array<(event: MessageEvent) => void> = [];
const vscodeApiMock = { postMessage: vi.fn(), getState: vi.fn(), setState: vi.fn() };

beforeEach(() => {
  vi.resetModules();
  deferreds = [];
  messageHandlers.length = 0;
  (window as unknown as { acquireVsCodeApi: () => typeof vscodeApiMock }).acquireVsCodeApi = () => vscodeApiMock;
  vi.spyOn(window, 'addEventListener').mockImplementation((type, listener) => {
    if (type === 'message') {
      messageHandlers.push(listener as (event: MessageEvent) => void);
    }
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

function dispatchMessage(message: unknown) {
  const event = new MessageEvent('message', { data: message });
  messageHandlers.forEach((handler) => handler(event));
}

/**
 * Mounts `useAppState` on an i18n instance holding the base catalog only — the
 * state a real surface boots in, and the only state in which a switch has a
 * chunk to fetch.
 */
async function createState() {
  const mod = await import('../../composables/useAppState');
  const { appRouterKey } = await import('../../composables/useAppRouter');
  const router = createTestRouter();
  const i18n = createI18nInstance('en');
  const wrapper = mount(
    {
      template: '<div></div>',
      setup() {
        const state = mod.useAppState();
        return { state };
      },
    },
    { global: { plugins: [router, i18n], provide: { [appRouterKey]: router } } },
  );
  await flushPromises();
  return { state: wrapper.vm.state as ReturnType<typeof mod.useAppState>, i18n };
}

/** The locale the instance is actually rendering in. */
function rendered(i18n: { global: { locale: unknown } }): string {
  return (i18n.global.locale as { value: string }).value;
}

describe('useAppState locale switching with a lazy catalog', () => {
  it('loads the pushed locale before it publishes it', async () => {
    const { state, i18n } = await createState();
    expect(state.locale.value).toBe('en');
    expect(rendered(i18n)).toBe('en');

    dispatchMessage({ command: 'setLocale', locale: 'zh' });
    await nextTick();
    // The state has not published the language yet and the UI is still in the
    // base language: publishing `zh` first would flip every string while
    // `zh.json` was in flight.
    expect(deferreds).toHaveLength(1);
    expect(state.locale.value).toBe('en');
    expect(rendered(i18n)).toBe('en');

    deferreds[0].resolve();
    await flushPromises();
    expect(rendered(i18n)).toBe('zh');
    expect(state.locale.value).toBe('zh');
    // The rendered language, not the requested one, drives `<html lang>`.
    await nextTick();
    expect(document.documentElement.lang).toBe('zh-CN');
  });

  it('honours the locale in initialState the same way', async () => {
    const { state, i18n } = await createState();

    dispatchMessage({
      command: 'initialState',
      instances: [],
      locale: 'zh',
      debug: false,
      worktrees: [],
      worktreeOpenMode: 'ask',
      worktreeCacheDirectory: '',
      worktreeCacheDirectoryDefault: '',
    });
    await nextTick();
    expect(deferreds).toHaveLength(1);
    expect(rendered(i18n)).toBe('en');

    deferreds[0].resolve();
    await flushPromises();

    expect(state.locale.value).toBe('zh');
    expect(rendered(i18n)).toBe('zh');
  });

  it('keeps changeLocale optimistic and completes it when the host confirms', async () => {
    const { state, i18n } = await createState();

    // The settings control calls this: the state (which every view reads for
    // its date/number formatting) has to move at once, and the host's
    // `setLocale` echo is what fetches and applies the catalog.
    state.changeLocale('zh');
    expect(state.locale.value).toBe('zh');
    expect(vscodeApiMock.postMessage).toHaveBeenCalledWith({ command: 'setLocale', locale: 'zh' });
    // Nothing has fetched `zh.json` yet, so the rendered language is still the
    // base one; the messages a language needs are what the echo brings.
    expect(deferreds).toHaveLength(0);

    dispatchMessage({ command: 'setLocale', locale: 'zh' });
    expect(deferreds).toHaveLength(1);
    deferreds[0].resolve();
    await flushPromises();
    expect(rendered(i18n)).toBe('zh');
    expect(state.locale.value).toBe('zh');
  });

  it('switches back to the base locale without fetching a chunk', async () => {
    const { state, i18n } = await createState();
    dispatchMessage({ command: 'setLocale', locale: 'zh' });
    deferreds[0].resolve();
    await flushPromises();
    expect(rendered(i18n)).toBe('zh');

    dispatchMessage({ command: 'setLocale', locale: 'en' });
    // The base catalog is already in the bundle, so this needs no chunk and no
    // in-flight window.
    await flushPromises();
    expect(rendered(i18n)).toBe('en');
    expect(state.locale.value).toBe('en');
    await nextTick();
    expect(document.documentElement.lang).toBe('en');
  });

  it('leaves the language alone when a request races a newer one', async () => {
    const { state, i18n } = await createState();

    dispatchMessage({ command: 'setLocale', locale: 'zh' });
    expect(deferreds).toHaveLength(1);
    // The user (or another panel's settings change) asks for the base language
    // while the Chinese chunk is still in flight.
    dispatchMessage({ command: 'setLocale', locale: 'en' });
    await flushPromises();
    expect(rendered(i18n)).toBe('en');

    // The stale request finishes last and must not drag the UI back to Chinese.
    deferreds[0].resolve();
    await flushPromises();
    expect(rendered(i18n)).toBe('en');
    expect(state.locale.value).toBe('en');
  });
});
