import { describe, expect, it } from 'vitest';
import { mount } from '@vue/test-utils';
import { nextTick } from 'vue';
import Notifications from '../Notifications.vue';
import { useAppState } from '../../composables/useAppState';
import { createTestRouter, createTestI18n } from '../../__tests__/helpers/test-utils';

function mountView() {
  return mount(Notifications, {
    global: { plugins: [createTestRouter(), createTestI18n('en')] },
  });
}

// The view is mounted with the real composable: its instances slot is what
// decides whether the filters render at all.
function seedInstance() {
  const state = useAppState() as unknown as { instances: { value: unknown[] } };
  state.instances.value = [{ id: 'inst-1', url: 'https://forgejo.example.com', username: 'demo-user' }];
}

/**
 * Both filter selects are named by a `<label for>` next to them, which a
 * `vscode-single-select` never reads (the accessible name has to be its own
 * `label` property, see `Settings.controlLabels.test.ts`). Without one a screen
 * reader announced two unnamed comboboxes.
 */
describe('Notifications filter select accessible names', () => {
  it('names each filter with the label shown beside it', async () => {
    const wrapper = mountView();
    seedInstance();
    await nextTick();

    expect(wrapper.get('#notification-status-filter').attributes('label')).toBe('Status');
    expect(wrapper.get('#notification-type-filter').attributes('label')).toBe('Type');

    // The visible `<label>` elements are still the text the user reads.
    expect(wrapper.get('label[for="notification-status-filter"]').text()).toBe('Status');
    expect(wrapper.get('label[for="notification-type-filter"]').text()).toBe('Type');

    for (const control of wrapper.findAll('vscode-single-select, vscode-textfield')) {
      expect(control.attributes('label'), control.html()).toBeTruthy();
    }

    wrapper.unmount();
  });
});
