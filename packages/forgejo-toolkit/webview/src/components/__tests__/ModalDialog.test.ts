import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mount } from '@vue/test-utils';
import ModalDialog from '../ModalDialog.vue';
import { createTestI18n } from '../../__tests__/helpers/test-utils';

const { showConfirmMock } = vi.hoisted(() => ({
  showConfirmMock: vi.fn(),
}));

vi.mock('../../composables/useAppState', () => ({
  useAppState: () => ({ showConfirm: showConfirmMock }),
}));

function mountDialog(options: { props?: Record<string, unknown>; slots?: Record<string, string> } = {}) {
  return mount(ModalDialog, {
    global: { plugins: [createTestI18n('en')] },
    ...options,
  });
}

describe('ModalDialog', () => {
  beforeEach(() => {
    showConfirmMock.mockReset();
    if (typeof HTMLDialogElement !== 'undefined') {
      HTMLDialogElement.prototype.showModal = vi.fn();
      HTMLDialogElement.prototype.close = vi.fn();
    }
  });

  it('renders title and body', () => {
    const wrapper = mountDialog({
      props: { open: false, title: 'Test Title' },
      slots: { default: '<p>body content</p>' },
    });

    expect(wrapper.text()).toContain('Test Title');
    expect(wrapper.text()).toContain('body content');
  });

  it('calls showModal when open becomes true', async () => {
    const wrapper = mountDialog({ props: { open: false } });

    await wrapper.setProps({ open: true });

    const dialog = wrapper.find('dialog').element as HTMLDialogElement;
    expect(dialog.showModal).toHaveBeenCalled();
  });

  it('calls close when open becomes false', async () => {
    const wrapper = mountDialog({ props: { open: true } });

    await wrapper.setProps({ open: false });

    const dialog = wrapper.find('dialog').element as HTMLDialogElement;
    expect(dialog.close).toHaveBeenCalled();
  });

  it('emits close when close button is clicked', async () => {
    const wrapper = mountDialog({ props: { open: true, title: 'T' } });

    await wrapper.find('.modal-close').trigger('click');

    expect(wrapper.emitted('close')).toHaveLength(1);
  });

  it('emits close on backdrop click when enabled', async () => {
    const wrapper = mountDialog({
      props: { open: true, closeOnBackdropClick: true },
    });

    const dialog = wrapper.find('dialog').element;
    vi.spyOn(dialog, 'getBoundingClientRect').mockReturnValue({
      left: 100,
      right: 300,
      top: 100,
      bottom: 300,
    } as DOMRect);

    await wrapper.find('dialog').trigger('click', { clientX: 50, clientY: 50 });

    expect(wrapper.emitted('close')).toHaveLength(1);
  });

  it('does not emit close on backdrop click when loading', async () => {
    const wrapper = mountDialog({
      props: { open: true, closeOnBackdropClick: true, loading: true },
    });

    const dialog = wrapper.find('dialog').element;
    vi.spyOn(dialog, 'getBoundingClientRect').mockReturnValue({
      left: 100,
      right: 300,
      top: 100,
      bottom: 300,
    } as DOMRect);

    await wrapper.find('dialog').trigger('click', { clientX: 50, clientY: 50 });

    expect(wrapper.emitted('close')).toBeFalsy();
    expect(wrapper.find('.modal-close').exists()).toBe(false);
  });

  it('emits close on native close event (e.g. Esc) when open', async () => {
    const wrapper = mountDialog({ props: { open: true } });

    await wrapper.find('dialog').trigger('close');

    expect(wrapper.emitted('close')).toHaveLength(1);
  });

  it('does not emit close on native close event when loading', async () => {
    const wrapper = mountDialog({ props: { open: true, loading: true } });

    await wrapper.find('dialog').trigger('close');

    expect(wrapper.emitted('close')).toBeFalsy();
  });

  it('does not emit close on native close event when already closed by the parent', async () => {
    const wrapper = mountDialog({ props: { open: false } });

    await wrapper.find('dialog').trigger('close');

    expect(wrapper.emitted('close')).toBeFalsy();
  });

  describe('closeOnEsc', () => {
    function dispatchCancel(wrapper: Awaited<ReturnType<typeof mountDialog>>) {
      const event = new Event('cancel', { cancelable: true });
      wrapper.find('dialog').element.dispatchEvent(event);
      return event;
    }

    it('does not prevent the cancel event by default', () => {
      const wrapper = mountDialog({ props: { open: true } });

      const event = dispatchCancel(wrapper);

      expect(event.defaultPrevented).toBe(false);
    });

    it('prevents the cancel event when closeOnEsc is false', () => {
      const wrapper = mountDialog({ props: { open: true, closeOnEsc: false } });

      const event = dispatchCancel(wrapper);

      expect(event.defaultPrevented).toBe(true);
      expect(wrapper.emitted('close')).toBeFalsy();
    });

    it('still emits close via the close button when closeOnEsc is false', async () => {
      const wrapper = mountDialog({ props: { open: true, closeOnEsc: false } });

      await wrapper.find('.modal-close').trigger('click');

      expect(wrapper.emitted('close')).toHaveLength(1);
    });
  });

  describe('confirmCloseIfDirty', () => {
    it('closes directly without confirming when not dirty', async () => {
      const wrapper = mountDialog({ props: { open: true, confirmCloseIfDirty: true, isDirty: false } });

      await wrapper.find('.modal-close').trigger('click');

      expect(showConfirmMock).not.toHaveBeenCalled();
      expect(wrapper.emitted('close')).toHaveLength(1);
    });

    it('asks for confirmation and closes when confirmed', async () => {
      showConfirmMock.mockResolvedValue(true);
      const wrapper = mountDialog({ props: { open: true, confirmCloseIfDirty: true, isDirty: true } });

      await wrapper.find('.modal-close').trigger('click');
      await vi.waitFor(() => expect(wrapper.emitted('close')).toHaveLength(1));

      expect(showConfirmMock).toHaveBeenCalledTimes(1);
    });

    it('asks for confirmation and stays open when cancelled', async () => {
      showConfirmMock.mockResolvedValue(false);
      const wrapper = mountDialog({ props: { open: true, confirmCloseIfDirty: true, isDirty: true } });

      await wrapper.find('.modal-close').trigger('click');
      await vi.waitFor(() => expect(showConfirmMock).toHaveBeenCalledTimes(1));

      expect(wrapper.emitted('close')).toBeFalsy();
    });

    it('prevents the Esc cancel and asks for confirmation instead', async () => {
      showConfirmMock.mockResolvedValue(true);
      const wrapper = mountDialog({ props: { open: true, confirmCloseIfDirty: true, isDirty: true } });

      const event = new Event('cancel', { cancelable: true });
      wrapper.find('dialog').element.dispatchEvent(event);
      await vi.waitFor(() => expect(wrapper.emitted('close')).toHaveLength(1));

      expect(event.defaultPrevented).toBe(true);
      expect(showConfirmMock).toHaveBeenCalledTimes(1);
    });

    it('asks for confirmation on backdrop click when dirty', async () => {
      showConfirmMock.mockResolvedValue(true);
      const wrapper = mountDialog({
        props: { open: true, closeOnBackdropClick: true, confirmCloseIfDirty: true, isDirty: true },
      });

      const dialog = wrapper.find('dialog').element;
      vi.spyOn(dialog, 'getBoundingClientRect').mockReturnValue({
        left: 100,
        right: 300,
        top: 100,
        bottom: 300,
      } as DOMRect);

      await wrapper.find('dialog').trigger('click', { clientX: 50, clientY: 50 });
      await vi.waitFor(() => expect(wrapper.emitted('close')).toHaveLength(1));

      expect(showConfirmMock).toHaveBeenCalledTimes(1);
    });

    it('does not open a second confirm while one is in flight', async () => {
      let resolveConfirm: ((confirmed: boolean) => void) | undefined;
      showConfirmMock.mockImplementation(
        () =>
          new Promise<boolean>((resolve) => {
            resolveConfirm = resolve;
          }),
      );
      const wrapper = mountDialog({ props: { open: true, confirmCloseIfDirty: true, isDirty: true } });

      await wrapper.find('.modal-close').trigger('click');
      await wrapper.find('.modal-close').trigger('click');

      expect(showConfirmMock).toHaveBeenCalledTimes(1);

      resolveConfirm?.(true);
      await vi.waitFor(() => expect(wrapper.emitted('close')).toHaveLength(1));
    });
  });
});
