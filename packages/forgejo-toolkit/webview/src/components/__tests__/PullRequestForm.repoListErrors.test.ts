import { describe, expect, it } from 'vitest';
import { mount } from '@vue/test-utils';
import { defineComponent, nextTick } from 'vue';
import PullRequestForm from '../PullRequestForm.vue';
import { createTestI18n } from '../../__tests__/helpers/test-utils';

const EasyMdeEditorStub = defineComponent({
  name: 'EasyMdeEditor',
  props: { modelValue: { type: String, default: '' }, uploadImage: { type: Function, default: undefined } },
  emits: ['update:modelValue'],
  template: '<textarea class="editor-stub" :value="modelValue" />',
});

const DateTimePickerStub = defineComponent({
  name: 'DateTimePicker',
  props: { modelValue: { type: String, default: null } },
  emits: ['update:modelValue'],
  template: '<input class="date-stub" />',
});

function mountForm(props: Record<string, unknown>) {
  return mount(PullRequestForm, {
    props: { submitLabel: 'Create', ...props },
    global: {
      plugins: [createTestI18n('en')],
      stubs: { EasyMdeEditor: EasyMdeEditorStub, DateTimePicker: DateTimePickerStub },
    },
  });
}

/**
 * The PR form always renders its labels/assignees/milestone controls, so an empty
 * list looked exactly like a repository with none of them: the lists' load
 * failures are written to their own keys and no view read them, and the form
 * offered empty option lists with no explanation. The three failures are named
 * separately, so the user knows which control is unusable.
 */
describe('PullRequestForm repository list load errors', () => {
  it('names each list whose load failed', async () => {
    const wrapper = mountForm({
      labels: [],
      assignees: [],
      milestones: [],
      labelsError: 'labels are forbidden',
      assigneesError: 'assignees are forbidden',
      milestonesError: 'milestones are forbidden',
    });
    await nextTick();

    const text = wrapper.text();
    expect(text).toContain('Could not load labels: labels are forbidden');
    expect(text).toContain('Could not load assignees: assignees are forbidden');
    expect(text).toContain('Could not load milestones: milestones are forbidden');
    wrapper.unmount();
  });

  it('keeps the pickers silent when every list loaded', async () => {
    const wrapper = mountForm({
      labels: [{ id: 1, name: 'bug' }],
      assignees: ['demo-user'],
      milestones: [{ id: 2, title: 'v1' }],
    });
    await nextTick();

    const text = wrapper.text();
    expect(text).not.toContain('Could not load');
    expect(text).toContain('bug');
    expect(text).toContain('demo-user');
    expect(text).toContain('v1');
    wrapper.unmount();
  });

  it('names only the list that failed', async () => {
    const wrapper = mountForm({
      labels: [{ id: 1, name: 'bug' }],
      assignees: [],
      milestones: [],
      assigneesError: 'assignees are forbidden',
    });
    await nextTick();

    const text = wrapper.text();
    expect(text).toContain('Could not load assignees: assignees are forbidden');
    expect(text).not.toContain('Could not load labels');
    expect(text).not.toContain('Could not load milestones');
    wrapper.unmount();
  });
});
