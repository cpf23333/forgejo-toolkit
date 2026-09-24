import { describe, expect, it, vi, beforeEach } from 'vitest';
import { mount } from '@vue/test-utils';
import { defineComponent, nextTick } from 'vue';
import RepoFileHistoryDialog from '../RepoFileHistoryDialog.vue';
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

const commit = {
  sha: 'sha-1',
  parents: [{ sha: 'parent-1' }],
  files: [{ filename: 'src/index.ts', status: 'modified' }],
  commit: {
    message: 'fix: the thing',
    author: { name: 'dev', date: '2024-01-01T00:00:00Z' },
  },
};

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

/**
 * A history row was a focusable clickable `<li>` with no role: a screen reader
 * announced plain text in a list and gave no hint that the row opens a diff or
 * an old version. The row now carries a button role — on an inner target, so the
 * `<li>` itself stays a listitem and the `<ul>` keeps a valid child list.
 */
describe('RepoFileHistoryDialog row role', () => {
  beforeEach(() => {
    stateMock.fileHistories.value = new Map([[KEY, [commit]]]);
    stateMock.loading = new Map();
    stateMock.errors = new Map();
    stateMock.loadFileHistory.mockClear();
  });

  it('reports a history row as a button, not as a bare list item', async () => {
    const wrapper = mountDialog();
    await nextTick();

    const row = wrapper.get('.history-item');
    expect(row.element.tagName).toBe('LI');
    expect(row.attributes('role')).toBeUndefined();

    const target = row.get('[role="button"]');
    expect(target.attributes('tabindex')).toBe('0');
    // Its text is its accessible name.
    expect(target.text()).toContain('fix: the thing');
    expect(target.text()).toContain('dev');

    wrapper.unmount();
  });

  it('opens the diff from both the pointer and the keyboard', async () => {
    const wrapper = mountDialog();
    await nextTick();

    const target = wrapper.get('[role="button"]');
    await target.trigger('click');
    await target.trigger('keydown', { key: ' ' });

    expect(wrapper.emitted('viewDiff')).toHaveLength(2);

    wrapper.unmount();
  });
});
