import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mount } from '@vue/test-utils';
import ModalDialog from '../ModalDialog.vue';

describe('ModalDialog', () => {
  beforeEach(() => {
    if (typeof HTMLDialogElement !== 'undefined') {
      HTMLDialogElement.prototype.showModal = vi.fn();
      HTMLDialogElement.prototype.close = vi.fn();
    }
  });

  it('renders title and body', () => {
    const wrapper = mount(ModalDialog, {
      props: { open: false, title: 'Test Title' },
      slots: { default: '<p>body content</p>' },
    });

    expect(wrapper.text()).toContain('Test Title');
    expect(wrapper.text()).toContain('body content');
  });

  it('calls showModal when open becomes true', async () => {
    const wrapper = mount(ModalDialog, { props: { open: false } });

    await wrapper.setProps({ open: true });

    const dialog = wrapper.find('dialog').element as HTMLDialogElement;
    expect(dialog.showModal).toHaveBeenCalled();
  });

  it('calls close when open becomes false', async () => {
    const wrapper = mount(ModalDialog, { props: { open: true } });

    await wrapper.setProps({ open: false });

    const dialog = wrapper.find('dialog').element as HTMLDialogElement;
    expect(dialog.close).toHaveBeenCalled();
  });

  it('emits close when close button is clicked', async () => {
    const wrapper = mount(ModalDialog, { props: { open: true, title: 'T' } });

    await wrapper.find('.modal-close').trigger('click');

    expect(wrapper.emitted('close')).toHaveLength(1);
  });

  it('emits close on backdrop click when enabled', async () => {
    const wrapper = mount(ModalDialog, {
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
    const wrapper = mount(ModalDialog, {
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
    const wrapper = mount(ModalDialog, { props: { open: true } });

    await wrapper.find('dialog').trigger('close');

    expect(wrapper.emitted('close')).toHaveLength(1);
  });

  it('does not emit close on native close event when loading', async () => {
    const wrapper = mount(ModalDialog, { props: { open: true, loading: true } });

    await wrapper.find('dialog').trigger('close');

    expect(wrapper.emitted('close')).toBeFalsy();
  });

  it('does not emit close on native close event when already closed by the parent', async () => {
    const wrapper = mount(ModalDialog, { props: { open: false } });

    await wrapper.find('dialog').trigger('close');

    expect(wrapper.emitted('close')).toBeFalsy();
  });
});
