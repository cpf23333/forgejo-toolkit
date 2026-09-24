import { describe, expect, it } from 'vitest';
import { mount } from '@vue/test-utils';
import ReactionBar from '../ReactionBar.vue';
import { createTestI18n } from '../../__tests__/helpers/test-utils';

function mountBar(reactions: Array<Record<string, unknown>>, currentUsername = 'demo-user') {
  return mount(ReactionBar, {
    props: { reactions: reactions as never, currentUsername },
    global: { plugins: [createTestI18n('en')] },
  });
}

/**
 * A reaction chip is a toggle, but only its colour said whether the signed-in
 * user had reacted: a screen reader got a button with no state. `aria-pressed`
 * carries it.
 */
describe('ReactionBar toggle state', () => {
  it('reports a chip the current user reacted with as pressed', () => {
    const wrapper = mountBar([{ content: '+1', user: { login: 'demo-user' } }]);

    const chip = wrapper.get('.reaction-chip');
    expect(chip.attributes('aria-pressed')).toBe('true');
    expect(chip.classes()).toContain('active');

    wrapper.unmount();
  });

  it('reports other users’ reactions as not pressed', () => {
    const wrapper = mountBar([
      { content: '+1', user: { login: 'someone-else' } },
      { content: '+1', user: { login: 'another-user' } },
    ]);

    const chip = wrapper.get('.reaction-chip');
    expect(chip.attributes('aria-pressed')).toBe('false');
    expect(chip.text()).toContain('2');

    wrapper.unmount();
  });

  it('asks to remove the reaction a pressed chip stands for', async () => {
    const wrapper = mountBar([{ content: '+1', user: { login: 'demo-user' } }]);

    await wrapper.get('.reaction-chip').trigger('click');

    // Removing one's own reaction is what a pressed chip asks for, and the
    // parent's answer (the new reaction list) drives `aria-pressed`.
    expect(wrapper.emitted('toggle')).toEqual([['+1', false]]);

    await wrapper.setProps({ reactions: [] as never });
    expect(wrapper.find('.reaction-chip').exists()).toBe(false);

    wrapper.unmount();
  });
});
