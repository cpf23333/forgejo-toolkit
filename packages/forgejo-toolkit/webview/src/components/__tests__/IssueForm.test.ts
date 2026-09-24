import { describe, expect, it } from 'vitest';
import { defineComponent, nextTick, ref } from 'vue';
import { mount } from '@vue/test-utils';
import IssueForm from '../IssueForm.vue';
import { createTestI18n } from '../../__tests__/helpers/test-utils';

const labels = [
  { id: 1, name: 'bug' },
  { id: 2, name: 'feature' },
];
const assignees = ['alice', 'bob'];

/**
 * The real views build `initial-label-ids` / `initial-assignees` inline with
 * `.map().filter()`, so every parent re-render hands the form a new array — and
 * the form's own `dirty` emit re-renders the parent (it drives the dialog's
 * dirty state). This host reproduces that: a toggle must survive the re-render
 * it triggers, and Save must send the toggled ids.
 */
const Host = defineComponent({
  components: { IssueForm },
  setup() {
    const dirty = ref(false);
    const submitted = ref<unknown>(undefined);
    const initialLabelIds = ref<number[]>([]);
    const initialAssignees = ref<string[]>([]);
    return {
      dirty,
      submitted,
      initialLabelIds,
      initialAssignees,
      labels,
      assignees,
      // New array identity on every render, like the real inline `.map()` props.
      labelIds: () => [...initialLabelIds.value],
      logins: () => [...initialAssignees.value],
    };
  },
  template: `
    <IssueForm
      mode="edit"
      initial-title="a title"
      initial-body="a body"
      :initial-label-ids="labelIds()"
      :initial-assignees="logins()"
      :labels="labels"
      :assignees="assignees"
      submit-label="Save"
      @dirty="dirty = $event"
      @submit="submitted = $event"
    />
  `,
});

function mountHost() {
  return mount(Host, {
    global: {
      plugins: [createTestI18n('en')],
      stubs: { EasyMdeEditor: true, DateTimePicker: true },
    },
  });
}

describe('IssueForm selection seeding', () => {
  it('keeps a toggled label and assignee even though the parent re-renders', async () => {
    const wrapper = mountHost();
    await nextTick();
    expect(wrapper.findAll('.label-chip')[0].classes()).not.toContain('selected');

    await wrapper.findAll('.label-chip')[0].trigger('click');
    await nextTick();

    // The parent re-rendered with a fresh array identity (caused by this form's
    // own dirty emit); the toggle must not be undone by the re-seed.
    expect(wrapper.vm.dirty).toBe(true);
    expect(wrapper.findAll('.label-chip')[0].classes()).toContain('selected');

    await wrapper.findAll('.assignee-chip')[1].trigger('click');
    await nextTick();
    expect(wrapper.findAll('.assignee-chip')[1].classes()).toContain('selected');
    expect(wrapper.findAll('.label-chip')[0].classes()).toContain('selected');

    await wrapper.find('form').trigger('submit');

    // Save must send the toggled ids, not the original selection.
    expect(wrapper.vm.submitted).toMatchObject({ labels: [1], assignees: ['bob'] });
    wrapper.unmount();
  });

  it('re-seeds when the parent actually changes the initial selection', async () => {
    const wrapper = mountHost();
    await nextTick();
    expect(wrapper.findAll('.label-chip')[0].classes()).not.toContain('selected');

    // A reload hands the form a different selection.
    wrapper.vm.initialLabelIds = [2];
    await nextTick();

    expect(wrapper.findAll('.label-chip')[0].classes()).not.toContain('selected');
    expect(wrapper.findAll('.label-chip')[1].classes()).toContain('selected');
    wrapper.unmount();
  });
});
