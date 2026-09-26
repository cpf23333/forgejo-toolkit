import { describe, it, expect } from 'vitest';
import { mount } from '@vue/test-utils';
import ViewTabs from '../ViewTabs.vue';

const tabs = [
  { key: 'a', label: 'Tab A' },
  { key: 'b', label: 'Tab B' },
  { key: 'c', label: 'Tab C' },
];

/**
 * `aria-pressed` (and the roving `tabindex`) is how this control reports its
 * state. It used to claim `role="tablist"`/`role="tab"` with `aria-selected`
 * while rendering no `role="tabpanel"` and no `aria-controls` at all — the three
 * views that use it own the panel and swap it by `v-if`, so a tab had nothing to
 * control. The roles are gone rather than completed: completing them would mean
 * moving each view's panel into this component's slot, and until then the ARIA
 * would promise a widget the markup cannot keep.
 */
describe('ViewTabs state is a toggle button, not an unfinished tab widget', () => {
  it('renders no tablist/tab role anywhere in the control', () => {
    const wrapper = mount(ViewTabs, { props: { tabs, modelValue: 'a' } });

    expect(wrapper.find('[role="tablist"]').exists()).toBe(false);
    expect(wrapper.find('[role="tab"]').exists()).toBe(false);
    expect(wrapper.find('[role="tabpanel"]').exists()).toBe(false);
    expect(wrapper.html()).not.toContain('aria-selected');
    expect(wrapper.html()).not.toContain('aria-controls');

    wrapper.unmount();
  });

  it('marks the chosen tab with aria-pressed and keeps the buttons buttons', () => {
    const wrapper = mount(ViewTabs, { props: { tabs, modelValue: 'b' } });

    expect(wrapper.findAll('button').map((button) => button.attributes('aria-pressed'))).toEqual([
      'false',
      'true',
      'false',
    ]);
    // Without an explicit type the buttons would submit a surrounding form.
    expect(wrapper.findAll('button').map((button) => button.attributes('type'))).toEqual([
      'button',
      'button',
      'button',
    ]);

    wrapper.unmount();
  });

  it('moves the pressed state and the roving tabindex together with the model', async () => {
    const wrapper = mount(ViewTabs, { props: { tabs, modelValue: 'a' } });

    await wrapper.find('.view-tabs').trigger('keydown', { key: 'ArrowRight' });
    await wrapper.setProps({ modelValue: 'b' });

    expect(wrapper.findAll('button').map((button) => button.attributes('aria-pressed'))).toEqual([
      'false',
      'true',
      'false',
    ]);
    expect(wrapper.findAll('button').map((button) => button.attributes('tabindex'))).toEqual(['-1', '0', '-1']);

    wrapper.unmount();
  });
});

describe('ViewTabs keyboard navigation', () => {
  it('keeps only the active tab in the tab order (roving tabindex)', () => {
    const wrapper = mount(ViewTabs, { props: { tabs, modelValue: 'a' } });

    expect(wrapper.findAll('button').map((b) => b.attributes('tabindex'))).toEqual(['0', '-1', '-1']);
  });

  it('ArrowRight/ArrowLeft activate the adjacent tab and move the roving tabindex', async () => {
    const wrapper = mount(ViewTabs, { props: { tabs, modelValue: 'a' } });
    const tablist = wrapper.find('.view-tabs');

    await tablist.trigger('keydown', { key: 'ArrowRight' });
    expect(wrapper.emitted('update:modelValue')?.[0]).toEqual(['b']);

    await wrapper.setProps({ modelValue: 'b' });
    expect(wrapper.findAll('button').map((b) => b.attributes('tabindex'))).toEqual(['-1', '0', '-1']);

    await tablist.trigger('keydown', { key: 'ArrowLeft' });
    expect(wrapper.emitted('update:modelValue')?.[1]).toEqual(['a']);
  });

  it('wraps around at both ends', async () => {
    const wrapper = mount(ViewTabs, { props: { tabs, modelValue: 'c' } });
    const tablist = wrapper.find('.view-tabs');

    await tablist.trigger('keydown', { key: 'ArrowRight' });
    expect(wrapper.emitted('update:modelValue')?.[0]).toEqual(['a']);

    await wrapper.setProps({ modelValue: 'a' });
    await tablist.trigger('keydown', { key: 'ArrowLeft' });
    expect(wrapper.emitted('update:modelValue')?.[1]).toEqual(['c']);
  });

  it('ignores other keys', async () => {
    const wrapper = mount(ViewTabs, { props: { tabs, modelValue: 'a' } });

    await wrapper.find('.view-tabs').trigger('keydown', { key: 'ArrowDown' });
    expect(wrapper.emitted('update:modelValue')).toBeUndefined();
  });
});
