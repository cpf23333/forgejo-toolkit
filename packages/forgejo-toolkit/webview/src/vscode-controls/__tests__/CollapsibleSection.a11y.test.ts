import { describe, expect, it } from 'vitest';
import { mount } from '@vue/test-utils';
import { defineComponent } from 'vue';
import CollapsibleSection from '../CollapsibleSection.vue';
import { createTestI18n } from '../../__tests__/helpers/test-utils';

function mountSection(defaultExpanded = true) {
  return mount(CollapsibleSection, {
    props: { title: 'Labels', defaultExpanded },
    slots: { default: '<p class="content">body</p>' },
    global: { plugins: [createTestI18n('en')] },
  });
}

/**
 * The disclosure state was carried by CSS alone (the chevron rotates); a screen
 * reader announced a button with no state, and nothing tied the content to the
 * trigger. The header now reports `aria-expanded` and points at its own content
 * with `aria-controls`.
 */
describe('CollapsibleSection disclosure state', () => {
  it('reports the expanded state and names the content it controls', () => {
    const wrapper = mountSection(true);

    const header = wrapper.get('.collapsible-header');
    const controls = header.attributes('aria-controls');
    expect(header.attributes('aria-expanded')).toBe('true');
    expect(controls).toBeTruthy();
    expect(wrapper.get(`#${controls}`).classes()).toContain('collapsible-content');

    wrapper.unmount();
  });

  it('reports a collapsed section and flips the state on toggle', async () => {
    const wrapper = mountSection(false);

    expect(wrapper.get('.collapsible-header').attributes('aria-expanded')).toBe('false');

    await wrapper.get('.collapsible-header').trigger('click');
    expect(wrapper.get('.collapsible-header').attributes('aria-expanded')).toBe('true');

    await wrapper.get('.collapsible-header').trigger('click');
    expect(wrapper.get('.collapsible-header').attributes('aria-expanded')).toBe('false');

    wrapper.unmount();
  });

  it('gives each section its own content id', () => {
    // Two sections of one view: `aria-controls` may only be unique among the
    // sections rendered together.
    const Host = defineComponent({
      components: { CollapsibleSection },
      template: '<div><CollapsibleSection title="Labels" /><CollapsibleSection title="Milestone" /></div>',
    });
    const wrapper = mount(Host, { global: { plugins: [createTestI18n('en')] } });

    const ids = wrapper.findAll('.collapsible-header').map((header) => header.attributes('aria-controls'));
    expect(ids).toHaveLength(2);
    expect(new Set(ids).size).toBe(2);
    for (const id of ids) {
      expect(wrapper.get(`#${id}`).classes()).toContain('collapsible-content');
    }

    wrapper.unmount();
  });
});
