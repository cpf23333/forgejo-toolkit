import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mount } from '@vue/test-utils';
import { nextTick } from 'vue';

/**
 * The AI endpoint block of the import preview (`docs/design/ai-model-transport.md`
 * §10.1, §10.3).
 *
 * The host computes every fact this block renders — which ids already exist, which
 * addresses are plain `http://`, whether the file carried credentials at all — so
 * what is testable here is the view's half: that it says those things plainly, that
 * an entry the editor refuses is shown as not importable rather than offered, and
 * that the collision choice starts on the answer that changes nothing (`keep`) and
 * travels back on confirm.
 */

const EXPORTED_INSTANCE = {
  id: 'inst-a',
  name: 'Alpha',
  url: 'https://forgejo.example.com/alpha',
  username: 'demo-user',
  token: 'token',
};

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
    instances: [{ ...EXPORTED_INSTANCE }],
    existingIds: [],
    ...preview,
  };
}

function aiSection(providers: Array<Record<string, unknown>>, extra: Record<string, unknown> = {}) {
  return {
    providers,
    bindings: [],
    transport: 'auto',
    secretsIncluded: false,
    ...extra,
  };
}

const PROVIDER = {
  id: 'ollama-local',
  name: 'Ollama (this machine)',
  baseUrl: 'http://localhost:11434/v1',
  auth: 'bearer',
  models: ['qwen3:8b'],
  headers: ['api-version'],
  existing: false,
};

describe('ImportPreview AI endpoints', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    stateMock.importPreview.value = undefined;
    stateMock.instances.value = [];
  });

  it('says an unencrypted file carries no credentials, and names how many endpoints it has', async () => {
    setPreview({ ai: aiSection([PROVIDER], { secretsIncluded: false }) });
    const wrapper = mountView();
    await nextTick();

    const block = wrapper.find('.ai-summary');
    expect(block.exists()).toBe(true);
    expect(block.text()).toContain('This file was not encrypted');
    expect(block.text()).toContain('1 endpoint(s)');
    expect(wrapper.find('.ai-note-warning').text()).toContain('no API key and no header value');
    wrapper.unmount();
  });

  it('says an encrypted file carries credentials, and where they will be stored', async () => {
    setPreview({ ai: aiSection([PROVIDER], { secretsIncluded: true }) });
    const wrapper = mountView();
    await nextTick();

    const text = wrapper.find('.ai-summary').text();
    expect(text).toContain('encrypted file carries the credentials');
    expect(text).toContain("editor's secret storage");
    // The "no credentials" warning is not also shown: the two statements are
    // mutually exclusive, and showing both would say nothing.
    expect(wrapper.find('.ai-note-warning').exists()).toBe(false);
    wrapper.unmount();
  });

  it('flags a plain http address in the preview, not only at run time', async () => {
    const wrapper = mountView();
    await nextTick();
    setPreview({
      ai: aiSection([
        { ...PROVIDER, insecure: true },
        { ...PROVIDER, id: 'hosted-gateway', baseUrl: 'https://models.example.com/v1', existing: false },
      ]),
    });
    await nextTick();

    // The second warning: the first is the "no credentials" statement, which a
    // plaintext file always carries.
    const warnings = wrapper.findAll('.ai-note-warning').map((node) => node.text());
    expect(warnings).toHaveLength(2);
    // One of the two addresses, so the count is the flagged entries and not the rows.
    expect(warnings[1]).toContain('1 of these addresses is plain http://');
    wrapper.unmount();
  });

  it('shows the endpoints and their declaration without any header value', async () => {
    setPreview({ ai: aiSection([PROVIDER]) });
    const wrapper = mountView();
    await nextTick();

    const item = wrapper.find('.ai-item');
    expect(item.text()).toContain('Ollama (this machine)');
    expect(item.text()).toContain('ollama-local');
    expect(item.text()).toContain('http://localhost:11434/v1');
    expect(item.text()).toContain('api-version');
    expect(item.text()).toContain('1 declared model(s)');
    // The declaration is a name list; nothing here can hold a value.
    expect(item.find('.ai-conflict').exists()).toBe(false);
    wrapper.unmount();
  });

  it('offers the three collision answers, starting on the one that changes nothing', async () => {
    setPreview({ ai: aiSection([{ ...PROVIDER, existing: true }], { secretsIncluded: true }) });
    const wrapper = mountView();
    await nextTick();

    const select = wrapper.find('.ai-conflict select');
    expect(select.exists()).toBe(true);
    const options = wrapper.findAll('.ai-conflict option').map((option) => option.attributes('value'));
    expect(options).toEqual(['keep', 'rename', 'replace']);
    // The default is the fail-closed one, and the host reads an absent choice the
    // same way.
    expect((select.element as HTMLSelectElement).value).toBe('keep');
    wrapper.unmount();
  });

  it('sends the chosen collision strategy back with the confirmation', async () => {
    setPreview({ ai: aiSection([{ ...PROVIDER, existing: true }], { secretsIncluded: true }) });
    const wrapper = mountView();
    await nextTick();

    await wrapper.find('.ai-conflict select').setValue('rename');
    // The import button is the last one in the footer; the components render as
    // the `vscode-button` tags the other view tests trigger too.
    const buttons = wrapper.findAll('.import-preview-footer vscode-button');
    await buttons[buttons.length - 1].trigger('click');

    expect(stateMock.confirmImportInstances).toHaveBeenCalledTimes(1);
    const [, , aiChoices] = stateMock.confirmImportInstances.mock.calls[0] as [
      string[],
      unknown,
      Record<string, string>,
    ];
    expect(aiChoices).toEqual({ 'ollama-local': 'rename' });
    wrapper.unmount();
  });

  it('marks an entry the editor refuses as not importable instead of offering it', async () => {
    setPreview({
      ai: aiSection([
        { ...PROVIDER, id: 'file-endpoint', baseUrl: 'file:///tmp/v1', unusable: 'its scheme is "file:"' },
      ]),
    });
    const wrapper = mountView();
    await nextTick();

    expect(wrapper.find('.ai-unusable').text()).toContain('cannot be imported');
    // No decision to make about an entry that will not be written.
    expect(wrapper.find('.ai-conflict').exists()).toBe(false);
    wrapper.unmount();
  });

  it('renders no AI block for a file that carries no AI section', async () => {
    // A version 1/2 payload, or a reply from a host build without AI import: absent
    // is "no AI configuration in this file", which must not look like an empty one.
    setPreview({});
    const wrapper = mountView();
    await nextTick();

    expect(wrapper.find('.ai-summary').exists()).toBe(false);
    wrapper.unmount();
  });

  it('states that importing turns no AI switch on', async () => {
    setPreview({ ai: aiSection([PROVIDER]) });
    const wrapper = mountView();
    await nextTick();

    const note = wrapper.find('.ai-summary .ai-note').text();
    expect(note).toContain('does not turn AI on');
    expect(note).toContain('does not turn any AI feature on');
    wrapper.unmount();
  });
});
