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

function mountBarWithError(error: string) {
  return mount(ReactionBar, {
    props: { reactions: [] as never, currentUsername: 'demo-user', error },
    global: { plugins: [createTestI18n('en')] },
  });
}

/**
 * A failed reaction load or toggle lands on the reactions key
 * (`state.errors.get(issueReactionsKey)`), and the host sends no toast for it:
 * the bar accepted no error prop, so the failure was read nowhere and a chip the
 * user clicked simply did nothing. The bar is the only surface that can explain
 * it, and a live region is what announces it (the action was async).
 */
describe('ReactionBar error surface', () => {
  it('renders the failure it is given', () => {
    const wrapper = mountBarWithError('permission denied');

    const message = wrapper.get('.reaction-error');
    expect(message.text()).toBe('Reactions failed: permission denied');
    expect(message.attributes('role')).toBe('status');

    wrapper.unmount();
  });

  it('renders nothing when there is no failure', () => {
    const wrapper = mountBar([]);

    expect(wrapper.find('.reaction-error').exists()).toBe(false);

    wrapper.unmount();
  });
});
