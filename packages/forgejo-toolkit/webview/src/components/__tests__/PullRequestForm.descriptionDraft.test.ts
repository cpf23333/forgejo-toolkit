import { describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { defineComponent, nextTick } from 'vue';
import PullRequestForm from '../PullRequestForm.vue';
import { createTestI18n } from '../../__tests__/helpers/test-utils';

/**
 * The create-pull-request form's "Generate description" control.
 *
 * The host owns the model, the prompt and the consent question, so everything
 * asserted here is the form's own half: it offers the control only when there is
 * something to describe, it fills the body field with the draft as an **editable**
 * value, and it never replaces writing the user has done without asking.
 */

const EasyMdeEditorStub = defineComponent({
  name: 'EasyMdeEditor',
  props: { modelValue: { type: String, default: '' }, uploadImage: { type: Function, default: undefined } },
  emits: ['update:modelValue'],
  template:
    '<textarea class="editor-stub" :value="modelValue" @input="$emit(\'update:modelValue\', $event.target.value)" />',
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

/** The form's current body, read from the editor stub the form renders. */
function bodyOf(wrapper: ReturnType<typeof mountForm>): string {
  return (wrapper.find('textarea.editor-stub').element as HTMLTextAreaElement).value;
}

/**
 * The generate control, or `undefined` when the form does not offer it.
 *
 * `vscode-button` is a custom element in the test environment rather than a real
 * `<button>`, so the control is found by tag and matched on its label.
 */
function generateButton(wrapper: ReturnType<typeof mountForm>) {
  return wrapper.findAll('vscode-button').find((button) => button.text().includes('Generate description'));
}

describe('PullRequestForm AI description draft', () => {
  it('fills the body field with the draft the host returned', async () => {
    const generateDescription = vi.fn(async () => 'Adds the retry the issue asked for.');
    const wrapper = mountForm({
      prDescriptionEnabled: true,
      generateDescription,
      initialBase: 'main',
      initialHead: 'feature',
      initialTitle: 'Retry failed requests',
    });
    await nextTick();

    const button = generateButton(wrapper);
    expect(button).toBeDefined();
    await button?.trigger('click');
    await flushPromises();
    await nextTick();

    // The coordinates the form is about to submit, and the title the user typed:
    // the host drafts from exactly that comparison, so the form has to hand it
    // over rather than let the host guess a branch pair.
    expect(generateDescription).toHaveBeenCalledWith({ base: 'main', head: 'feature', title: 'Retry failed requests' });
    expect(bodyOf(wrapper)).toBe('Adds the retry the issue asked for.');
    wrapper.unmount();
  });

  it('offers no control when the host reports the feature off', async () => {
    const generateDescription = vi.fn(async () => 'never used');
    const wrapper = mountForm({
      prDescriptionEnabled: false,
      generateDescription,
      initialBase: 'main',
      initialHead: 'feature',
    });
    await nextTick();

    expect(generateButton(wrapper)).toBeUndefined();
    expect(generateDescription).not.toHaveBeenCalled();
    wrapper.unmount();
  });

  it("offers the control on an existing pull request's edit form, with that pull request's own branches", async () => {
    const generateDescription = vi.fn(async () => 'Rewrites the description.');
    const wrapper = mountForm({
      mode: 'edit',
      prDescriptionEnabled: true,
      generateDescription,
      initialBase: 'main',
      initialHead: 'feature',
      initialTitle: 'Retry failed requests',
    });
    await nextTick();

    const button = generateButton(wrapper);
    expect(button).toBeDefined();
    await button?.trigger('click');
    await flushPromises();
    await nextTick();

    // The form hands over the refs it was opened with: in edit mode the branch
    // pickers are hidden, but `initialBase`/`initialHead` are the pull request's own
    // comparison and the host needs them for the commit list. The index stays with
    // the view that knows it — the edit dialog closes over it.
    expect(generateDescription).toHaveBeenCalledWith({ base: 'main', head: 'feature', title: 'Retry failed requests' });
    expect(bodyOf(wrapper)).toBe('Rewrites the description.');
    wrapper.unmount();
  });

  it('offers no control on the edit form either while the host reports it off', async () => {
    const generateDescription = vi.fn(async () => 'never used');
    const wrapper = mountForm({
      mode: 'edit',
      prDescriptionEnabled: false,
      generateDescription,
      initialBase: 'main',
      initialHead: 'feature',
    });
    await nextTick();

    expect(generateButton(wrapper)).toBeUndefined();
    expect(generateDescription).not.toHaveBeenCalled();
    wrapper.unmount();
  });

  it('leaves the body untouched and shows the host sentence when the draft fails', async () => {
    const generateDescription = vi.fn(async () => {
      throw new Error('The description could not be drafted: the request timed out.');
    });
    const wrapper = mountForm({
      prDescriptionEnabled: true,
      generateDescription,
      initialBase: 'main',
      initialHead: 'feature',
    });
    await nextTick();

    await generateButton(wrapper)?.trigger('click');
    await flushPromises();
    await nextTick();

    // The failure line is the form's own, next to the control: the save's error
    // slot is for the pull request itself, which was never attempted.
    expect(wrapper.text()).toContain('The description could not be drafted: the request timed out.');
    expect(bodyOf(wrapper)).toBe('');
    wrapper.unmount();
  });

  it('asks again when the user emptied a field they had typed in', async () => {
    // A cleared field is not "nobody's": the user emptied it after writing in it, so
    // the first press must still ask. An "empty means replaceable" shortcut would
    // overwrite it silently — the same failure as overwriting live text.
    const generateDescription = vi.fn(async () => 'A drafted description.');
    const wrapper = mountForm({
      prDescriptionEnabled: true,
      generateDescription,
      initialBase: 'main',
      initialHead: 'feature',
    });
    await nextTick();

    const editor = wrapper.find('textarea.editor-stub');
    await editor.setValue('Something I started writing.');
    await editor.setValue('');
    await generateButton(wrapper)?.trigger('click');
    await flushPromises();
    await nextTick();

    expect(generateDescription).not.toHaveBeenCalled();
    expect(wrapper.text()).toContain('would be replaced');
    expect(bodyOf(wrapper)).toBe('');
    wrapper.unmount();
  });

  it('asks before replacing writing the user has already done', async () => {
    const generateDescription = vi.fn(async () => 'A drafted description.');
    const wrapper = mountForm({
      prDescriptionEnabled: true,
      generateDescription,
      initialBody: 'What I wrote myself.',
      initialBase: 'main',
      initialHead: 'feature',
    });
    await nextTick();

    await generateButton(wrapper)?.trigger('click');
    await flushPromises();
    await nextTick();

    // The first press only asks; nothing has been sent and nothing replaced.
    expect(generateDescription).not.toHaveBeenCalled();
    expect(bodyOf(wrapper)).toBe('What I wrote myself.');
    expect(wrapper.text()).toContain('would be replaced');

    await generateButton(wrapper)?.trigger('click');
    await flushPromises();
    await nextTick();

    expect(generateDescription).toHaveBeenCalledTimes(1);
    expect(bodyOf(wrapper)).toBe('A drafted description.');
    wrapper.unmount();
  });

  it('replaces its own unedited draft without asking again', async () => {
    const generateDescription = vi.fn(async () => 'First draft.');
    const wrapper = mountForm({
      prDescriptionEnabled: true,
      generateDescription,
      initialBase: 'main',
      initialHead: 'feature',
    });
    await nextTick();

    await generateButton(wrapper)?.trigger('click');
    await flushPromises();
    await nextTick();
    expect(bodyOf(wrapper)).toBe('First draft.');

    // Second press: the body is the draft this form filled in and the user did not
    // touch it, so there is nothing of theirs to protect.
    generateDescription.mockResolvedValue('Second draft.');
    await generateButton(wrapper)?.trigger('click');
    await flushPromises();
    await nextTick();

    expect(generateDescription).toHaveBeenCalledTimes(2);
    expect(bodyOf(wrapper)).toBe('Second draft.');
    wrapper.unmount();
  });

  it('leaves the body alone when the host reports a cancelled run', async () => {
    // A cancelled run resolves with the empty string: the host has already said
    // what happened (a dismissed consent question or model picker), so the form
    // must not turn it into a second message or an empty body.
    const generateDescription = vi.fn(async () => '');
    const wrapper = mountForm({
      prDescriptionEnabled: true,
      generateDescription,
      initialBody: 'Mine.',
      initialBase: 'main',
      initialHead: 'feature',
    });
    await nextTick();

    await generateButton(wrapper)?.trigger('click');
    await flushPromises();
    await nextTick();
    await generateButton(wrapper)?.trigger('click');
    await flushPromises();
    await nextTick();

    expect(bodyOf(wrapper)).toBe('Mine.');
    expect(wrapper.text()).not.toContain('could not be drafted');
    wrapper.unmount();
  });
});
