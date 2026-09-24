import { describe, expect, it, vi, beforeEach } from 'vitest';
import { mount } from '@vue/test-utils';
import { defineComponent, nextTick } from 'vue';

const { stateMock } = vi.hoisted(() => ({
  stateMock: {
    uploadReleaseAttachment: vi.fn(),
    deleteReleaseAttachment: vi.fn(),
  },
}));

vi.mock('../../composables/useAppState', () => ({ useAppState: () => stateMock }));

// jsdom's <dialog> has no showModal/close; the form and the dialog's own state
// are what these tests exercise.
const ModalDialogStub = defineComponent({
  name: 'ModalDialog',
  props: {
    open: { type: Boolean, default: false },
    loading: { type: Boolean, default: false },
    confirmCloseIfDirty: { type: Boolean, default: false },
    isDirty: { type: Boolean, default: false },
  },
  emits: ['close'],
  template: '<div class="modal-dialog-stub" :data-dirty="String(isDirty)"><slot /></div>',
});

const EasyMdeStub = defineComponent({
  name: 'EasyMdeEditor',
  props: { modelValue: { type: String, default: '' } },
  emits: ['update:modelValue'],
  template:
    '<textarea class="editor-stub" :value="modelValue" @input="$emit(\'update:modelValue\', $event.target.value)" />',
});

import RepoRefFormDialog from '../RepoRefFormDialog.vue';
import { createTestI18n } from '../../__tests__/helpers/test-utils';

function mountDialog(props: Record<string, unknown> = {}) {
  return mount(RepoRefFormDialog, {
    props: {
      mode: 'branch',
      open: true,
      instanceId: 'inst-1',
      owner: 'owner',
      repo: 'repo',
      defaultBranch: 'main',
      ...props,
    },
    global: {
      plugins: [createTestI18n('en')],
      stubs: { ModalDialog: ModalDialogStub, EasyMdeEditor: EasyMdeStub },
    },
  });
}

function cancelButton(wrapper: ReturnType<typeof mountDialog>) {
  const button = wrapper.findAll('vscode-button').find((entry) => entry.text().trim() === 'Cancel');
  expect(button, 'Cancel button').toBeTruthy();
  return button!;
}

/** A `change` event carrying the name the user typed into the textfield. */
async function typeName(wrapper: ReturnType<typeof mountDialog>, value: string) {
  const field = wrapper.find('vscode-textfield');
  (field.element as unknown as { value: string }).value = value;
  await field.trigger('input');
  await nextTick();
}

/**
 * Esc/×/Cancel all discard the dialog's typed input. Esc and × already went
 * through the modal's confirmation, but Cancel emitted `close` directly, so a
 * typed branch name, tag message, release title/body or queued attachment
 * disappeared with no prompt. The dialog now publishes its own dirty state to
 * the modal guard and routes Cancel through the same request-to-close path.
 */
describe('RepoRefFormDialog dirty contract', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('reports clean for a freshly opened dialog', async () => {
    const wrapper = mountDialog();
    await nextTick();

    expect(wrapper.emitted('dirty')).toEqual([[false]]);
  });

  it('reports dirty once the user types a name', async () => {
    const wrapper = mountDialog();
    await nextTick();

    await typeName(wrapper, 'feature/x');

    expect(wrapper.emitted('dirty')?.at(-1)).toEqual([true]);
  });

  it('reports dirty for a queued attachment', async () => {
    const wrapper = mountDialog({ mode: 'release' });
    await nextTick();
    expect(wrapper.emitted('dirty')?.at(-1)).toEqual([false]);

    // What the parent does when the user picks a file in the attachment list.
    await wrapper.setProps({ pendingAttachments: [new File(['x'], 'notes.txt')] });
    await nextTick();

    expect(wrapper.emitted('dirty')?.at(-1)).toEqual([true]);
    wrapper.unmount();
  });

  it('routes Cancel through the close request instead of closing directly', async () => {
    const wrapper = mountDialog();
    await nextTick();
    await typeName(wrapper, 'feature/x');

    await cancelButton(wrapper).trigger('click');

    expect(wrapper.emitted('cancel')).toEqual([[]]);
    // The old direct `close` skipped the parent's discard confirmation.
    expect(wrapper.emitted('close')).toBeUndefined();
  });

  it('hands the dirty state to the modal guard so Esc and × confirm as well', async () => {
    const wrapper = mountDialog();
    await nextTick();
    expect(wrapper.get('.modal-dialog-stub').attributes('data-dirty')).toBe('false');

    await typeName(wrapper, 'feature/x');

    expect(wrapper.get('.modal-dialog-stub').attributes('data-dirty')).toBe('true');
  });
});
