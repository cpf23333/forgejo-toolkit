import { describe, expect, it } from 'vitest';
import { mount } from '@vue/test-utils';
import IssueForm from '../IssueForm.vue';
import { createTestI18n } from '../../__tests__/helpers/test-utils';

/**
 * A visible `<label>` next to a `vscode-*` form control does not name it: the
 * control renders its own input inside a shadow root, so the browser never
 * associates the label with it. Each control therefore has to carry its own
 * accessible name (the elements' `label` property sets the inner `aria-label`).
 * Without one a screen reader announces every field as an unnamed textbox.
 */
function mountForm() {
  return mount(IssueForm, {
    props: {
      mode: 'create',
      branches: ['main'],
      labels: [{ id: 1, name: 'bug' }],
      assignees: ['alice'],
      milestones: [{ id: 7, title: 'v1' }],
      submitLabel: 'Create',
    },
    global: {
      plugins: [createTestI18n('en')],
      stubs: { EasyMdeEditor: true, DateTimePicker: true },
    },
  });
}

describe('IssueForm accessible names', () => {
  it('names every field with its visible label', () => {
    const wrapper = mountForm();

    const labeled = wrapper.findAll('vscode-textfield, vscode-single-select');
    expect(labeled.length).toBeGreaterThan(0);
    for (const control of labeled) {
      expect(control.attributes('label')).toBeTruthy();
    }

    expect(wrapper.get('vscode-textfield').attributes('label')).toBe('Title');
    expect(wrapper.findAll('vscode-single-select')[0].attributes('label')).toBe('Reference');
    expect(wrapper.findAll('vscode-single-select')[1].attributes('label')).toBe('Milestone');
    wrapper.unmount();
  });

  it('names the date picker with the field it edits', () => {
    const wrapper = mountForm();

    // The stub stands in for the picker, which puts `label` on its readonly
    // combobox input.
    expect(wrapper.getComponent({ name: 'DateTimePicker' }).props('label')).toBe('Due date');
    wrapper.unmount();
  });

  it('reports label and assignee chips as toggles', () => {
    const wrapper = mountForm();

    // The chip's text is its name; `aria-pressed` tells a screen reader it is a
    // toggle and whether it is currently on.
    const chip = wrapper.get('.label-chip');
    expect(chip.attributes('aria-pressed')).toBe('false');
    const assignee = wrapper.get('.assignee-chip');
    expect(assignee.attributes('aria-pressed')).toBe('false');

    wrapper.unmount();
  });
});
