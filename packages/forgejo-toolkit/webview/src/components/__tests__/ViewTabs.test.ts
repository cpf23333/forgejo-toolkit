import { describe, it, expect } from 'vitest';
import { mount } from '@vue/test-utils';
import ViewTabs from '../ViewTabs.vue';

const tabs = [
  { key: 'a', label: 'Tab A' },
  { key: 'b', label: 'Tab B' },
  { key: 'c', label: 'Tab C' },
];

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
