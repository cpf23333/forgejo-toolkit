import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mount } from '@vue/test-utils';
import { nextTick } from 'vue';

const { stateMock } = vi.hoisted(() => ({
  stateMock: {
    importPreview: { value: undefined as unknown },
    instances: { value: [] as unknown[] },
    confirmImportInstances: vi.fn(),
    cancelImportInstances: vi.fn(),
  },
}));

vi.mock('../../composables/useAppState', async () => {
  const { reactive } = await import('vue');
  return { useAppState: () => reactive(stateMock) };
});

import ImportPreview from '../ImportPreview.vue';
import { useAppState } from '../../composables/useAppState';
import { createTestRouter, createTestI18n } from '../../__tests__/helpers/test-utils';

function state() {
  return useAppState() as unknown as { importPreview: { value: unknown } };
}

function mountView() {
  return mount(ImportPreview, {
    global: { plugins: [createTestRouter(), createTestI18n('en')] },
  });
}

/** The `importPreview` state the host reply for `previewImportInstances` writes. */
function setPreview(preview: Record<string, unknown>) {
  state().importPreview.value = {
    instances: [{ id: 'inst-a', name: 'Alpha', url: 'https://forgejo.example.com/alpha', username: 'demo-user' }],
    existingIds: ['inst-a'],
    ...preview,
  };
}

/** The URL line of the "existing instance" diff block, if it is rendered. */
function urlDiff(wrapper: ReturnType<typeof mountView>): string | undefined {
  return wrapper
    .findAll('.diff-line')
    .map((line) => line.text())
    .find((text) => text.startsWith('URL:'));
}

/**
 * The instance list the webview holds carries a userinfo-redacted URL:
 * `toPublicInstance` blanks a stored credential to `https://***@host/...` before
 * it crosses into the webview, while the imported file holds the raw URL.
 * Comparing the two strings straight reported a URL change that never happened
 * (`https://***@host` to `https://token@host`), telling the user the import would
 * repoint their instance.
 */
describe('ImportPreview URL change diff', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    stateMock.importPreview.value = undefined;
    stateMock.instances.value = [];
  });

  function withCurrentInstance(url: string) {
    stateMock.instances.value = [{ id: 'inst-a', name: 'Alpha', url, username: 'demo-user' }];
  }

  it('does not report a change when only the redacted userinfo differs', async () => {
    // The stored instance's URL with its token blanked, as the webview sees it.
    withCurrentInstance('https://***@forgejo.example.com/alpha');
    setPreview({
      instances: [
        { id: 'inst-a', name: 'Alpha', url: 'https://token@forgejo.example.com/alpha', username: 'demo-user' },
      ],
    });

    const wrapper = mountView();
    await nextTick();

    expect(urlDiff(wrapper)).toBeUndefined();
    wrapper.unmount();
  });

  it('does not report a change when the redaction also normalized the path', async () => {
    // `URL.toString()` turns `https://host` into `https://host/`: not a change.
    withCurrentInstance('https://forgejo.example.com/');
    setPreview({
      instances: [{ id: 'inst-a', name: 'Alpha', url: 'https://forgejo.example.com', username: 'demo-user' }],
    });

    const wrapper = mountView();
    await nextTick();

    expect(urlDiff(wrapper)).toBeUndefined();
    wrapper.unmount();
  });

  it('still reports a genuine URL change', async () => {
    withCurrentInstance('https://forgejo.example.com/alpha');
    setPreview({
      instances: [{ id: 'inst-a', name: 'Alpha', url: 'https://forgejo.example.com/beta', username: 'demo-user' }],
    });

    const wrapper = mountView();
    await nextTick();

    expect(urlDiff(wrapper)).toContain('https://forgejo.example.com/alpha');
    expect(urlDiff(wrapper)).toContain('https://forgejo.example.com/beta');
    wrapper.unmount();
  });

  it('falls back to an exact comparison for a URL that cannot be parsed', async () => {
    withCurrentInstance('forgejo.example.com/alpha');
    setPreview({
      instances: [{ id: 'inst-a', name: 'Alpha', url: 'forgejo.example.com/beta', username: 'demo-user' }],
    });

    const wrapper = mountView();
    await nextTick();

    expect(urlDiff(wrapper)).toContain('forgejo.example.com/alpha');
    wrapper.unmount();
  });
});
