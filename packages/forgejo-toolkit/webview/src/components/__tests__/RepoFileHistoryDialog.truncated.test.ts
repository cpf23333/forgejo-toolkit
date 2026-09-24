import { describe, expect, it, vi, beforeEach } from 'vitest';
import { mount } from '@vue/test-utils';
import { defineComponent, nextTick, ref } from 'vue';
import RepoFileHistoryDialog from '../RepoFileHistoryDialog.vue';
import { LIST_ITEM_LIMIT } from '@cpf23333-forgejo-toolkit/shared/limits';
import { createTestI18n } from '../../__tests__/helpers/test-utils';

const { stateMock } = vi.hoisted(() => ({
  stateMock: {
    fileHistories: { value: new Map<string, unknown[]>() },
    loading: new Map<string, boolean>(),
    errors: new Map<string, string>(),
    locale: { value: 'en' },
    loadFileHistory: vi.fn(),
    t: (key: string) => key,
  },
}));

vi.mock('../../composables/useAppState', () => ({
  useAppState: () => stateMock,
  fileHistoryKey: (instanceId: string, owner: string, repo: string, path: string, ref: string) =>
    `${instanceId}:${owner}/${repo}/${path}@${ref}`,
}));

// jsdom's <dialog> has no showModal/close.
const ModalDialogStub = defineComponent({
  name: 'ModalDialog',
  props: { open: { type: Boolean, default: false } },
  template: '<div class="modal-stub"><slot /></div>',
});

const KEY = 'inst-1:owner/repo/src/index.ts@main';

const commit = (index: number) => ({
  sha: `sha-${index}`,
  commit: { message: `commit ${index}`, author: { name: 'dev', date: '2024-01-01T00:00:00Z' } },
});

function mountDialog() {
  return mount(RepoFileHistoryDialog, {
    props: {
      open: true,
      instanceId: 'inst-1',
      owner: 'owner',
      repo: 'repo',
      path: 'src/index.ts',
      branchRef: 'main',
    },
    global: {
      plugins: [createTestI18n('en')],
      stubs: { ModalDialog: ModalDialogStub },
    },
  });
}

describe('RepoFileHistoryDialog truncation notice', () => {
  beforeEach(() => {
    stateMock.fileHistories.value = new Map();
    stateMock.loading = new Map();
    stateMock.errors = new Map();
    stateMock.loadFileHistory.mockClear();
    stateMock.locale = ref('en');
  });

  it('says the history was cut off at the cap instead of presenting it as complete', async () => {
    stateMock.fileHistories.value.set(
      KEY,
      Array.from({ length: LIST_ITEM_LIMIT }, (_, index) => commit(index)),
    );

    const wrapper = mountDialog();
    await nextTick();

    const notice = wrapper.find('.list-truncated');
    expect(notice.exists()).toBe(true);
    expect(notice.text()).toBe('Only the first 500 commits are shown.');
  });

  it('stays quiet for a history below the cap', async () => {
    stateMock.fileHistories.value.set(
      KEY,
      Array.from({ length: LIST_ITEM_LIMIT - 1 }, (_, index) => commit(index)),
    );

    const wrapper = mountDialog();
    await nextTick();

    expect(wrapper.find('.list-truncated').exists()).toBe(false);
    expect(wrapper.findAll('.history-item')).toHaveLength(LIST_ITEM_LIMIT - 1);
  });

  it('does not claim truncation when there is no history to show', async () => {
    stateMock.fileHistories.value.set(KEY, []);

    const wrapper = mountDialog();
    await nextTick();

    expect(wrapper.find('.list-truncated').exists()).toBe(false);
    expect(wrapper.text()).toContain('dashboard.fileBrowser.noHistory');
  });
});
