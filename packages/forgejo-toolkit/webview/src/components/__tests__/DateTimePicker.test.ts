import { describe, it, expect, afterEach, vi } from 'vitest';
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

describe('DateTimePicker panel identity', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('gives each instance on the page its own panel id', async () => {
    // One form can hold several pickers (the edit dialogs have one per date
    // field). A shared id would make every `aria-controls` point at the first
    // panel, so a screen reader would announce the wrong dialog.
    const first = mountPicker();
    const second = mountPicker();

    await pressKey(first, 'Enter');
    await pressKey(second, 'Enter');

    const firstInput = first.get('.date-time-input');
    const secondInput = second.get('.date-time-input');
    const firstPanel = first.get('.date-time-panel');
    const secondPanel = second.get('.date-time-panel');

    expect(firstPanel.attributes('id')).not.toBe(secondPanel.attributes('id'));
    expect(firstInput.attributes('aria-controls')).toBe(firstPanel.attributes('id'));
    expect(secondInput.attributes('aria-controls')).toBe(secondPanel.attributes('id'));

    first.unmount();
    second.unmount();
  });
});

/**
 * The panel is `position: fixed`, so a field near an edge puts part of it
 * outside the webview: at a narrow sidebar or high zoom the right columns and
 * the footer buttons were unreachable, with no scrollbar to bring them back.
 */
describe('DateTimePicker panel clamping', () => {
  afterEach(() => {
    document.body.innerHTML = '';
    restoreViewport();
    vi.restoreAllMocks();
  });

  const originalViewport = {
    width: Object.getOwnPropertyDescriptor(window, 'innerWidth'),
    height: Object.getOwnPropertyDescriptor(window, 'innerHeight'),
  };

  /** jsdom defines these as getters on the window, so `vi.stubGlobal` misses. */
  function setViewport(width: number, height: number) {
    Object.defineProperty(window, 'innerWidth', { value: width, configurable: true });
    Object.defineProperty(window, 'innerHeight', { value: height, configurable: true });
  }

  function restoreViewport() {
    if (originalViewport.width) {
      Object.defineProperty(window, 'innerWidth', originalViewport.width);
    }
    if (originalViewport.height) {
      Object.defineProperty(window, 'innerHeight', originalViewport.height);
    }
  }

  /**
   * jsdom performs no layout, so every element measures 0: without measured
   * panel bounds the vertical flip has nothing to decide on.
   */
  function measurePanel(width: number, height: number) {
    vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockReturnValue(width);
    vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(height);
  }

  function panelStyle(wrapper: ReturnType<typeof mountPicker>) {
    const panel = wrapper.get('.date-time-panel');
    return {
      top: Number.parseFloat((panel.element as HTMLElement).style.top),
      left: Number.parseFloat((panel.element as HTMLElement).style.left),
    };
  }

  it('keeps the panel inside the viewport when the field is at the right edge', async () => {
    const wrapper = mountPicker();
    const input = wrapper.get('.date-time-input');
    // A 200px-wide sidebar (or a zoomed-in editor): the field sits at the very
    // edge, so an unclamped panel (min-width 260px) would hang outside it.
    setViewport(200, 800);
    input.element.getBoundingClientRect = () =>
      ({ top: 100, bottom: 124, left: 180, right: 200, width: 20, height: 24 }) as DOMRect;

    await pressKey(wrapper, 'Enter');

    expect(panelStyle(wrapper).left).toBe(8);
    wrapper.unmount();
  });

  it('flips the panel above the field when it would not fit below', async () => {
    const wrapper = mountPicker();
    const input = wrapper.get('.date-time-input');
    setViewport(900, 300);
    measurePanel(260, 320);
    input.element.getBoundingClientRect = () =>
      ({ top: 270, bottom: 294, left: 40, right: 240, width: 200, height: 24 }) as DOMRect;

    await pressKey(wrapper, 'Enter');

    // 294 + 320 would end 314px below a 300px viewport: the panel opens above
    // the field instead, and stays clamped to the top gap.
    expect(panelStyle(wrapper).top).toBe(Math.max(8, 270 - 320 - 4));
    wrapper.unmount();
  });

  it('clamps a flipped panel to the top of the viewport', async () => {
    const wrapper = mountPicker();
    const input = wrapper.get('.date-time-input');
    setViewport(900, 300);
    measurePanel(260, 900);
    input.element.getBoundingClientRect = () =>
      ({ top: 270, bottom: 294, left: 40, right: 240, width: 200, height: 24 }) as DOMRect;

    await pressKey(wrapper, 'Enter');

    // A panel taller than the viewport cannot be shown above the field either:
    // it stays at the top gap rather than at a negative offset.
    expect(panelStyle(wrapper).top).toBe(8);
    wrapper.unmount();
  });

  it('opens below the field when there is room for it', async () => {
    const wrapper = mountPicker();
    const input = wrapper.get('.date-time-input');
    setViewport(900, 800);
    measurePanel(260, 320);
    input.element.getBoundingClientRect = () =>
      ({ top: 100, bottom: 124, left: 32, right: 232, width: 200, height: 24 }) as DOMRect;

    await pressKey(wrapper, 'Enter');

    expect(panelStyle(wrapper)).toEqual({ top: 128, left: 32 });
    wrapper.unmount();
  });
});
