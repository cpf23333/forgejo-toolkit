import { describe, it, expect, vi, beforeEach } from 'vitest';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';

/**
 * The AI pre-review chat model row on the Settings page.
 *
 * The row is the same choice the QuickPick command writes, offered where users
 * look for settings: a `vscode-single-select` built from the models the host
 * reports, a refresh button (the set of models changes between runs), and — when
 * there is nothing to offer — the host's own reason instead of an empty
 * dropdown. Selecting a value writes it through the host, and a failed write has
 * to be visible: the select goes back to the value that is actually stored.
 *
 * `useAppState` is mocked the way every other Settings test mocks it: the view
 * reads and writes only through the composable, and the two AI pre-review
 * helpers are the request/response pair it awaits.
 */

const { stateMock } = vi.hoisted(() => ({
  stateMock: {
    instances: { value: [] as unknown[] },
    importPreview: { value: undefined },
    locale: { value: 'en' },
    changeLocale: vi.fn(),
    debug: { value: false },
    changeDebug: vi.fn(),
    worktreeOpenMode: { value: 'ask' },
    changeWorktreeOpenMode: vi.fn(),
    worktreeCacheDirectory: { value: '' },
    worktreeCacheDirectoryDefault: { value: '/host/default' },
    setWorktreeCacheDirectory: vi.fn(),
    browseWorktreeCacheDirectory: vi.fn(),
    worktrees: { value: [] as unknown[] },
    lastWorktreeError: { value: undefined },
    openWorktreePath: vi.fn(),
    removeWorktree: vi.fn(),
    testConnectionResult: { value: undefined },
    saveInstanceResult: { value: undefined },
    exportInstancesResult: { value: undefined },
    importInstancesResult: { value: undefined },
    testConnection: vi.fn(),
    saveInstance: vi.fn(),
    editInstance: vi.fn(),
    removeInstance: vi.fn(),
    openExternal: vi.fn(),
    previewImportInstances: vi.fn(),
    exportInstances: vi.fn(),
    copyInstancesToClipboard: vi.fn(),
    loadAiPreReviewChatModels: vi.fn(async (): Promise<{ models: Model[]; configured: string; reason?: string }> => ({
      models: [],
      configured: '',
    })),
    saveAiPreReviewChatModel: vi.fn(async (value: string) => ({ value })),
  },
}));

vi.mock('../../composables/useAppState', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../composables/useAppState')>();
  const { reactive: makeReactive } = await import('vue');
  return {
    ...actual,
    useAppState: () => makeReactive(stateMock),
  };
});

import Settings from '../Settings.vue';
import { createTestRouter, createTestI18n } from '../../__tests__/helpers/test-utils';

const SELECTOR = '#ai-pre-review-model';
const REFRESH = '.ai-pre-review-model-actions vscode-button';

interface Model {
  name: string;
  vendor: string;
  family: string;
  id: string;
  maxInputTokens: number;
  value?: string;
}

function model(overrides: Partial<Model> = {}): Model {
  return {
    name: 'Fake Model',
    vendor: 'fake',
    family: 'fake',
    id: 'fake-model',
    maxInputTokens: 128_000,
    value: 'fake/fake-model',
    ...overrides,
  };
}

function mountView() {
  return mount(Settings, {
    global: {
      plugins: [createTestRouter(), createTestI18n('en')],
      stubs: { ModalDialog: true, TokenScopeList: true },
    },
  });
}

/** What the select is showing, whether Vue bound it as a property or an attribute. */
function selectValue(wrapper: VueWrapper): string {
  const element = wrapper.find(SELECTOR).element as unknown as { value?: string };
  return element.value !== undefined ? String(element.value) : (wrapper.find(SELECTOR).attributes('value') ?? '');
}

/** The labels of the model options, without the "ask each run" row. */
function modelOptions(wrapper: VueWrapper) {
  return wrapper.findAll(`${SELECTOR} vscode-option`).filter((option) => option.attributes('value') !== '');
}

async function selectModel(wrapper: VueWrapper, value: string) {
  const select = wrapper.find(SELECTOR);
  (select.element as unknown as { value: string }).value = value;
  await select.trigger('change');
  await flushPromises();
}

describe('Settings AI pre-review chat model chooser', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    stateMock.loadAiPreReviewChatModels.mockImplementation(async () => ({ models: [], configured: '' }));
    stateMock.saveAiPreReviewChatModel.mockImplementation(async (value: string) => ({ value }));
  });

  it('renders one option per offered model, naming the provider each would receive the brief', async () => {
    stateMock.loadAiPreReviewChatModels.mockImplementation(async () => ({
      models: [
        model({ name: 'First', id: 'first', family: 'shared', maxInputTokens: 64_000, value: 'fake/first' }),
        model({ name: 'Second', id: 'second', family: 'shared', maxInputTokens: 200_000, value: 'fake/second' }),
      ],
      configured: 'fake/second',
    }));

    const wrapper = mountView();
    await flushPromises();

    const options = modelOptions(wrapper);
    // The display name and the `vendor/family` pair are on the row, so two
    // models sharing a family cannot be confused.
    expect(options.map((option) => option.text())).toEqual(['First — fake/shared', 'Second — fake/shared']);
    expect(options.map((option) => option.attributes('value'))).toEqual(['fake/first', 'fake/second']);
    // The privacy point, per row: the provider that would receive the brief and
    // the model's own input budget.
    expect(options[0].attributes('description')).toBe('The brief goes to the "fake" provider. maxInputTokens=64000');
    // The stored value is what the control shows.
    expect(selectValue(wrapper)).toBe('fake/second');
    // The same sentence stays on screen while the dropdown is closed.
    expect(wrapper.text()).toContain('The brief goes to the "fake" provider. maxInputTokens=200000');
    wrapper.unmount();
  });

  it('offers the "ask each run" value, which is the setting default', async () => {
    const wrapper = mountView();
    await flushPromises();

    const first = wrapper.findAll(`${SELECTOR} vscode-option`)[0];
    expect(first.attributes('value')).toBe('');
    expect(first.text()).toBe('Ask each run (no stored model)');
    wrapper.unmount();
  });

  it('lists a model the setting cannot name as a disabled option that says so', async () => {
    // A provider that omits `vendor` leaves nothing the setting can store. The
    // model is still listed — hiding it would be a silent filter — but it cannot
    // be picked, and the row says why.
    stateMock.loadAiPreReviewChatModels.mockImplementation(async () => ({
      models: [model({ name: 'Orphan', vendor: '', family: 'orphan', id: 'orphan', value: undefined })],
      configured: '',
    }));

    const wrapper = mountView();
    await flushPromises();

    const option = modelOptions(wrapper)[0];
    expect(option.attributes('disabled')).toBeDefined();
    expect(option.attributes('value')).toBeUndefined();
    expect(option.text()).toContain('This model has no vendor/name form');
    wrapper.unmount();
  });

  it('writes the picked value through the host and reports what was stored', async () => {
    stateMock.loadAiPreReviewChatModels.mockImplementation(async () => ({
      models: [model({ value: 'fake/first', id: 'first', name: 'First' })],
      configured: '',
    }));

    const wrapper = mountView();
    await flushPromises();

    await selectModel(wrapper, 'fake/first');

    expect(stateMock.saveAiPreReviewChatModel).toHaveBeenCalledWith('fake/first');
    expect(wrapper.text()).toContain('Saved: fake/first');
    expect(selectValue(wrapper)).toBe('fake/first');
    wrapper.unmount();
  });

  it('clears the stored choice when the "ask each run" option is picked', async () => {
    stateMock.loadAiPreReviewChatModels.mockImplementation(async () => ({
      models: [model()],
      configured: 'fake/fake-model',
    }));

    const wrapper = mountView();
    await flushPromises();

    await selectModel(wrapper, '');

    expect(stateMock.saveAiPreReviewChatModel).toHaveBeenCalledWith('');
    expect(wrapper.text()).toContain('Cleared. The next pre-review run asks which model to use.');
    wrapper.unmount();
  });

  it('shows the host reason instead of an empty dropdown when there is nothing to offer', async () => {
    stateMock.loadAiPreReviewChatModels.mockImplementation(async () => ({
      models: [],
      configured: '',
      reason: 'No chat model is available: install and sign in to a chat model provider.',
    }));

    const wrapper = mountView();
    await flushPromises();

    expect(modelOptions(wrapper)).toHaveLength(0);
    // The host's own sentence, not a bare empty list: an empty dropdown with no
    // explanation is what this state exists to avoid.
    expect(wrapper.text()).toContain('No chat model is available: install and sign in to a chat model provider.');
    wrapper.unmount();
  });

  it('re-requests the list when the refresh button is pressed', async () => {
    stateMock.loadAiPreReviewChatModels.mockImplementationOnce(async () => ({
      models: [model({ name: 'First', id: 'first', family: 'first', value: 'fake/first' })],
      configured: '',
    }));
    stateMock.loadAiPreReviewChatModels.mockImplementationOnce(async () => ({
      models: [
        model({ name: 'First', id: 'first', family: 'first', value: 'fake/first' }),
        model({ name: 'Late', id: 'late', family: 'late', value: 'fake/late' }),
      ],
      configured: '',
    }));

    const wrapper = mountView();
    await flushPromises();
    expect(modelOptions(wrapper)).toHaveLength(1);

    await wrapper.find(REFRESH).trigger('click');
    await flushPromises();

    // The list changes between runs (a provider signs in, a model ships), so the
    // row has to be able to ask again.
    expect(stateMock.loadAiPreReviewChatModels).toHaveBeenCalledTimes(2);
    expect(modelOptions(wrapper).map((option) => option.text())).toEqual(['First — fake/first', 'Late — fake/late']);
    wrapper.unmount();
  });

  it('puts the stored value back when the host could not write the choice', async () => {
    stateMock.loadAiPreReviewChatModels.mockImplementation(async () => ({
      models: [model({ id: 'first', value: 'fake/first' }), model({ id: 'second', value: 'fake/second' })],
      configured: 'fake/first',
    }));
    stateMock.saveAiPreReviewChatModel.mockImplementation(async () => ({
      value: 'fake/second',
      error: 'The model choice was not stored: it is not a "vendor/family" or "vendor/id" form.',
    }));

    const wrapper = mountView();
    await flushPromises();

    await selectModel(wrapper, 'fake/second');

    // The row never shows a choice that was not stored.
    expect(selectValue(wrapper)).toBe('fake/first');
    expect(wrapper.text()).toContain('The model choice was not stored');
    wrapper.unmount();
  });

  it('says so when the configured value names no offered model', async () => {
    stateMock.loadAiPreReviewChatModels.mockImplementation(async () => ({
      models: [model({ id: 'first', value: 'fake/first' })],
      configured: 'deepseek/old-model',
    }));

    const wrapper = mountView();
    await flushPromises();

    // A stale value would make every run refuse, and a blank select on its own
    // does not say why.
    expect(wrapper.text()).toContain('The setting currently holds "deepseek/old-model"');
    wrapper.unmount();
  });
});
