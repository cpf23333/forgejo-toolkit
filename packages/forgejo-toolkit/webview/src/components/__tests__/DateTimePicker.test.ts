import { describe, it, expect, afterEach } from 'vitest';
import { mount } from '@vue/test-utils';
import { nextTick } from 'vue';
import DateTimePicker from '../DateTimePicker.vue';
import { createTestI18n } from '../../__tests__/helpers/test-utils';

function mountPicker(props: Record<string, unknown> = {}) {
  return mount(DateTimePicker, {
    props,
    // Focus assertions need the component connected to the document.
    attachTo: document.body,
    global: {
      plugins: [createTestI18n('en')],
    },
  });
}

async function pressKey(wrapper: ReturnType<typeof mountPicker>, key: string) {
  await wrapper.get('.date-time-input').trigger('keydown', { key });
  // One tick renders the panel, the next runs the deferred focus move.
  await nextTick();
  await nextTick();
}

describe('DateTimePicker keyboard access', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('is exposed as a dialog popup field instead of a mouse-only readonly input', () => {
    const wrapper = mountPicker();
    const input = wrapper.get('.date-time-input');

    expect(input.attributes('readonly')).toBeDefined();
    expect(input.attributes('role')).toBe('combobox');
    expect(input.attributes('aria-haspopup')).toBe('dialog');
    expect(input.attributes('aria-expanded')).toBe('false');
    expect(wrapper.find('.date-time-panel').exists()).toBe(false);
    wrapper.unmount();
  });

  it.each(['Enter', ' ', 'ArrowDown'])('opens the panel with %s and moves focus into it', async (key) => {
    const wrapper = mountPicker();
    await pressKey(wrapper, key);

    const panel = wrapper.get('.date-time-panel');
    expect(panel.attributes('role')).toBe('dialog');
    expect(wrapper.get('.date-time-input').attributes('aria-expanded')).toBe('true');
    expect(wrapper.get('.date-time-input').attributes('aria-controls')).toBe(panel.attributes('id'));
    expect(document.activeElement).toBe(panel.element);
    // The panel content the focus lands on is real buttons, so it is operable
    // with the keyboard alone.
    expect(wrapper.findAll('.date-time-panel button').length).toBeGreaterThan(0);
    wrapper.unmount();
  });

  it('closes the panel on Escape and returns focus to the field', async () => {
    const wrapper = mountPicker();
    const input = wrapper.get('.date-time-input');
    await pressKey(wrapper, 'Enter');

    await wrapper.get('.date-time-panel').trigger('keydown', { key: 'Escape' });
    await nextTick();

    expect(wrapper.find('.date-time-panel').exists()).toBe(false);
    expect(wrapper.get('.date-time-input').attributes('aria-expanded')).toBe('false');
    expect(document.activeElement).toBe(input.element);
    wrapper.unmount();
  });

  it('toggles the panel closed with Enter when the field is focused again', async () => {
    const wrapper = mountPicker();
    await pressKey(wrapper, 'Enter');
    expect(wrapper.find('.date-time-panel').exists()).toBe(true);

    await pressKey(wrapper, 'Enter');
    expect(wrapper.find('.date-time-panel').exists()).toBe(false);
    expect(document.activeElement).toBe(wrapper.get('.date-time-input').element);
    wrapper.unmount();
  });

  it('lets a keyboard user pick a day and keeps the field focus recoverable', async () => {
    const wrapper = mountPicker();
    await pressKey(wrapper, 'Enter');

    await wrapper.findAll('.day-cell.day-current-month')[0].trigger('click');
    const emitted = wrapper.emitted('update:modelValue');
    expect(emitted).toHaveLength(1);
    expect(typeof emitted?.[0][0]).toBe('string');
    wrapper.unmount();
  });

  it('returns focus to the field when the panel is closed by Clear', async () => {
    const wrapper = mountPicker();
    const input = wrapper.get('.date-time-input');
    await pressKey(wrapper, 'Enter');

    const clear = wrapper.findAll('.panel-button').find((button) => button.text() === 'Clear');
    expect(clear).toBeTruthy();
    await clear!.trigger('click');
    await nextTick();

    expect(wrapper.emitted('update:modelValue')?.[0]).toEqual([null]);
    expect(wrapper.find('.date-time-panel').exists()).toBe(false);
    expect(document.activeElement).toBe(input.element);
    wrapper.unmount();
  });

  it('does not open the panel for a disabled picker', async () => {
    const wrapper = mountPicker({ disabled: true });
    await pressKey(wrapper, 'Enter');

    expect(wrapper.find('.date-time-panel').exists()).toBe(false);
    wrapper.unmount();
  });
});

describe('DateTimePicker mouse behaviour', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('still toggles the panel on click without stealing focus from the field', async () => {
    const wrapper = mountPicker();
    const input = wrapper.get('.date-time-input');
    (input.element as HTMLInputElement).focus();

    await input.trigger('click');
    expect(wrapper.find('.date-time-panel').exists()).toBe(true);
    // A mouse user keeps the caret in the field; only the keyboard path moves
    // focus into the panel.
    expect(document.activeElement).toBe(input.element);

    await input.trigger('click');
    expect(wrapper.find('.date-time-panel').exists()).toBe(false);
    wrapper.unmount();
  });

  it('closes the panel when the pointer goes elsewhere without pulling focus back to the field', async () => {
    const wrapper = mountPicker();
    const outside = document.createElement('button');
    document.body.appendChild(outside);

    // Focus sits on a panel control when the pointer goes elsewhere.
    await pressKey(wrapper, 'Enter');
    expect(document.activeElement).toBe(wrapper.get('.date-time-panel').element);

    outside.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    await nextTick();

    expect(wrapper.find('.date-time-panel').exists()).toBe(false);
    expect(document.activeElement).not.toBe(wrapper.get('.date-time-input').element);
    wrapper.unmount();
  });
});
