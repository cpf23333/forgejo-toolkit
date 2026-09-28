import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mount } from '@vue/test-utils';
import { defineComponent, h, KeepAlive, nextTick } from 'vue';
import RepoActions from '../RepoActions.vue';
import { createTestI18n } from '../../__tests__/helpers/test-utils';
import type { WorkflowDispatchInputDescriptor } from '../../types/api';

const { stateMock } = vi.hoisted(() => ({
  stateMock: {
    loading: new Map<string, boolean>(),
    errors: new Map<string, string>(),
    actionRuns: { value: new Map<string, unknown[]>() },
    actionRunsHasMore: { value: new Map<string, boolean>() },
    actionRunTotalCount: { value: new Map<string, number>() },
    workflowDispatchInputs: { value: new Map<string, unknown>() },
    lastDispatchCancelled: { value: undefined as string | undefined },
    loadActionRuns: vi.fn(),
    loadWorkflowDispatchInputs: vi.fn(),
    dispatchWorkflow: vi.fn(),
    openActionRunDetail: vi.fn(),
    openExternal: vi.fn(),
  },
}));

vi.mock('../../composables/useAppState', async () => {
  const { reactive } = await import('vue');
  const state = reactive(stateMock);
  return {
    useAppState: () => state,
    ACTION_RUNS_PAGE_LIMIT: 30,
    actionRunsKey: (instanceId: string, owner: string, repo: string) => `${instanceId}:${owner}/${repo}:actions`,
    dispatchWorkflowKey: (instanceId: string, owner: string, repo: string, workflow: string) =>
      `${instanceId}:${owner}/${repo}:actions:dispatch:${workflow}`,
    workflowDispatchInputsKey: (instanceId: string, owner: string, repo: string, workflow: string, ref: string) =>
      `${instanceId}:${owner}/${repo}:actions:dispatch-inputs:${workflow}@${ref}`,
  };
});

import { useAppState } from '../../composables/useAppState';

const INPUTS_KEY = 'inst-1:owner/repo:actions:dispatch-inputs:ci.yml@main';
const INPUTS_KEY_DEV = 'inst-1:owner/repo:actions:dispatch-inputs:ci.yml@dev';

// The reactive store, not the raw mock: a reply written into the raw object
// would not invalidate the component's computeds, and the form would never see
// the descriptors arrive.
const state = useAppState() as unknown as {
  workflowDispatchInputs: { value: Map<string, unknown> };
  loading: Map<string, boolean>;
};

// RepoActions lives inside RepoDetail, which App.vue renders under keep-alive.
const Host = defineComponent({
  setup() {
    return () =>
      h(KeepAlive, null, {
        default: () => h(RepoActions, { instanceId: 'inst-1', owner: 'owner', repo: 'repo' }),
      });
  },
});

function mountHost() {
  return mount(Host, { global: { plugins: [createTestI18n('en')] } });
}

async function openForm(wrapper: ReturnType<typeof mountHost>) {
  const trigger = wrapper.findAll('vscode-button').find((b) => b.text().includes('Trigger workflow'));
  expect(trigger, 'Trigger workflow button').toBeTruthy();
  await trigger!.trigger('click');
}

/** Types a workflow and a ref into the two plain fields the form opens with. */
async function select(wrapper: ReturnType<typeof mountHost>, workflow = 'ci.yml', ref = 'main') {
  const textfields = wrapper.findAll('vscode-textfield');
  (textfields[0].element as unknown as { value: string }).value = workflow;
  await textfields[0].trigger('input');
  (textfields[1].element as unknown as { value: string }).value = ref;
  await textfields[1].trigger('input');
}

/** The host's answer for the current selection. */
async function reply(key: string, payload: Record<string, unknown>) {
  state.workflowDispatchInputs.value.set(key, payload);
  await nextTick();
}

function runButton(wrapper: ReturnType<typeof mountHost>) {
  return wrapper.findAll('vscode-button').find((b) => b.text().trim() === 'Run');
}

function input(
  name: string,
  overrides: Partial<WorkflowDispatchInputDescriptor> = {},
): WorkflowDispatchInputDescriptor {
  return { name, type: 'string', declaredType: 'string', required: false, ...overrides };
}

describe('RepoActions dispatch form renders the inputs a workflow declares', () => {
  beforeEach(() => {
    stateMock.loading.clear();
    stateMock.errors.clear();
    stateMock.dispatchWorkflow.mockClear();
    stateMock.loadWorkflowDispatchInputs.mockClear();
    state.workflowDispatchInputs.value.clear();
  });

  /**
   * Forgejo's own dispatch form shows only each input's `description`, never its
   * name, so the raw key/value editor left the user guessing which names a
   * workflow declares. The form now renders one control per declared input.
   */
  it('renders one typed control per declared input, prefilled from the file', async () => {
    const wrapper = mountHost();
    await openForm(wrapper);
    await select(wrapper);
    await reply(INPUTS_KEY, {
      path: '.forgejo/workflows/ci.yml',
      inputs: [
        input('tag', { description: 'Release tag', default: 'v1.0.0', required: true }),
        input('prerelease', { type: 'boolean', declaredType: 'boolean', default: 'false' }),
        input('dry_run', {
          type: 'boolean',
          declaredType: 'boolean',
          description: 'Only print what would happen',
          default: 'true',
        }),
        input('channel', {
          type: 'choice',
          declaredType: 'choice',
          options: ['staging', 'production'],
          default: 'staging',
        }),
      ],
    });

    expect(wrapper.findAll('.declared-input')).toHaveLength(4);
    // Both modes are named on screen, and the typed one says where the inputs
    // came from.
    expect(wrapper.text()).toContain('Inputs declared by .forgejo/workflows/ci.yml');
    // The input name is the label — the gap this change closes — and the
    // description is the help text under it.
    expect(wrapper.text()).toContain('tag');
    expect(wrapper.text()).toContain('Release tag');
    expect(wrapper.text()).toContain('Only print what would happen');
    // The required marker is a `*` whose title names what it means.
    expect(wrapper.find('.input-required').attributes('title')).toBe('Required');

    // A boolean default of `true` renders checked, `false` unchecked.
    const checkboxes = wrapper.findAll('vscode-checkbox');
    expect(checkboxes).toHaveLength(2);
    expect(checkboxes[0].attributes('checked')).toBe('false');
    expect(checkboxes[1].attributes('checked')).toBe('true');

    // The choice renders its options, with the default selected.
    const choice = wrapper.find('.input-choice');
    expect(choice.exists()).toBe(true);
    expect(choice.attributes('value')).toBe('staging');
    expect(choice.findAll('vscode-option').map((option) => option.text())).toEqual(['staging', 'production']);

    // A type with no dedicated control is a text field, and says so.
    expect(wrapper.find('.input-text').attributes('value')).toBe('v1.0.0');
    wrapper.unmount();
  });

  it('sends the values the typed controls hold', async () => {
    const wrapper = mountHost();
    await openForm(wrapper);
    await select(wrapper);
    await reply(INPUTS_KEY, {
      path: '.forgejo/workflows/ci.yml',
      inputs: [
        input('tag'),
        input('channel', { type: 'choice', declaredType: 'choice', options: ['staging', 'production'] }),
        input('dry_run', { type: 'boolean', declaredType: 'boolean', default: 'true' }),
      ],
    });

    const tag = wrapper.find('.declared-input .input-text');
    (tag.element as unknown as { value: string }).value = 'v2.0.0';
    await tag.trigger('input');
    const channel = wrapper.find('.input-choice');
    (channel.element as unknown as { value: string }).value = 'production';
    await channel.trigger('change');
    // The user unchecks the box the file prefilled as on.
    const dryRun = wrapper.findAll('vscode-checkbox')[0];
    (dryRun.element as unknown as { checked: boolean }).checked = false;
    await dryRun.trigger('change');

    await runButton(wrapper)!.trigger('click');

    expect(stateMock.dispatchWorkflow).toHaveBeenCalledWith('inst-1', 'owner', 'repo', 'ci.yml', 'main', {
      tag: 'v2.0.0',
      channel: 'production',
      dry_run: 'false',
    });
    wrapper.unmount();
  });

  it('refuses an empty submit while a declared input is required', async () => {
    const wrapper = mountHost();
    await openForm(wrapper);
    await select(wrapper);
    await reply(INPUTS_KEY, {
      path: '.forgejo/workflows/ci.yml',
      inputs: [input('tag', { required: true }), input('dry_run', { type: 'boolean', declaredType: 'boolean' })],
    });

    expect(runButton(wrapper)!.attributes('disabled')).toBe('true');
    await runButton(wrapper)!.trigger('click');
    expect(stateMock.dispatchWorkflow).not.toHaveBeenCalled();

    const tag = wrapper.find('.declared-input .input-text');
    (tag.element as unknown as { value: string }).value = 'v1.2.3';
    await tag.trigger('input');

    expect(runButton(wrapper)!.attributes('disabled')).not.toBe('true');
    await runButton(wrapper)!.trigger('click');
    // The checkbox always answers: an input whose file declares no default is
    // sent as the state the box is in, not omitted.
    expect(stateMock.dispatchWorkflow).toHaveBeenCalledWith('inst-1', 'owner', 'repo', 'ci.yml', 'main', {
      tag: 'v1.2.3',
      dry_run: 'false',
    });
    wrapper.unmount();
  });

  /**
   * The raw editor is the fallback, not a dead end: a workflow whose file cannot
   * be fetched or parsed still has to be dispatchable, and the user has to be
   * told which mode they are in.
   */
  it('falls back to the raw key/value editor, saying why, when the file cannot be read', async () => {
    const wrapper = mountHost();
    await openForm(wrapper);
    await select(wrapper);
    await reply(INPUTS_KEY, {
      reason: 'unreadable',
      error: 'No workflow file named "ci.yml" was found in .forgejo/workflows.',
    });

    expect(wrapper.findAll('.declared-input')).toHaveLength(0);
    expect(wrapper.text()).toContain('Could not read the inputs this workflow declares');
    expect(wrapper.text()).toContain('No workflow file named "ci.yml" was found');

    // The raw rows are there, and what the user types in them is what is sent.
    const addInput = wrapper.findAll('vscode-button').find((b) => b.text().includes('Add input'));
    await addInput!.trigger('click');
    const row = wrapper.find('.trigger-input-row');
    const fields = row.findAll('vscode-textfield');
    (fields[0].element as unknown as { value: string }).value = 'tag';
    await fields[0].trigger('input');
    (fields[1].element as unknown as { value: string }).value = 'v1.2.3';
    await fields[1].trigger('input');

    await runButton(wrapper)!.trigger('click');
    expect(stateMock.dispatchWorkflow).toHaveBeenCalledWith('inst-1', 'owner', 'repo', 'ci.yml', 'main', {
      tag: 'v1.2.3',
    });
    wrapper.unmount();
  });

  it('says so when the workflow declares no inputs', async () => {
    const wrapper = mountHost();
    await openForm(wrapper);
    await select(wrapper);
    await reply(INPUTS_KEY, { path: '.forgejo/workflows/ci.yml', reason: 'no-inputs' });

    expect(wrapper.text()).toContain('This workflow declares no inputs');
    expect(wrapper.findAll('.declared-input')).toHaveLength(0);
    expect(wrapper.find('.trigger-input-row').exists()).toBe(false);
    wrapper.unmount();
  });

  it('moves a raw row into the typed field whose name it matches', async () => {
    const wrapper = mountHost();
    await openForm(wrapper);
    await select(wrapper);

    // The user types a row while the form is still on the raw editor.
    const addInput = wrapper.findAll('vscode-button').find((b) => b.text().includes('Add input'));
    await addInput!.trigger('click');
    const fields = wrapper.find('.trigger-input-row').findAll('vscode-textfield');
    (fields[0].element as unknown as { value: string }).value = 'tag';
    await fields[0].trigger('input');
    (fields[1].element as unknown as { value: string }).value = 'v1.2.3';
    await fields[1].trigger('input');

    // The reply then declares that same input: the row becomes the field's
    // value instead of being dropped or duplicated.
    await reply(INPUTS_KEY, {
      path: '.forgejo/workflows/ci.yml',
      inputs: [input('tag', { default: 'from-file' })],
    });

    expect(wrapper.findAll('.declared-input')).toHaveLength(1);
    expect(wrapper.find('.declared-input .input-text').attributes('value')).toBe('v1.2.3');
    expect(wrapper.findAll('.trigger-input-row')).toHaveLength(0);
    wrapper.unmount();
  });

  it('keeps a typed value when the next selection has no readable file', async () => {
    const wrapper = mountHost();
    await openForm(wrapper);
    await select(wrapper);
    await reply(INPUTS_KEY, { path: '.forgejo/workflows/ci.yml', inputs: [input('tag', { default: 'from-file' })] });

    const tag = wrapper.find('.declared-input .input-text');
    (tag.element as unknown as { value: string }).value = 'mine';
    await tag.trigger('input');

    // Another ref of the same workflow, whose file cannot be read there.
    await select(wrapper, 'ci.yml', 'dev');
    await reply(INPUTS_KEY_DEV, { reason: 'unreadable', error: 'not found on dev' });

    expect(wrapper.findAll('.declared-input')).toHaveLength(0);
    const rows = wrapper.findAll('.trigger-input-row');
    expect(rows).toHaveLength(1);
    // Vue writes `:value` as an attribute on the (un-upgraded) custom element in
    // this environment, which is where the rendered row's text is readable.
    const fields = rows[0].findAll('vscode-textfield');
    expect(fields[0].attributes('value')).toBe('tag');
    expect(fields[1].attributes('value')).toBe('mine');
    wrapper.unmount();
  });

  it('keeps the fields on screen while the next selection is still being read', async () => {
    const wrapper = mountHost();
    await openForm(wrapper);
    await select(wrapper);
    await reply(INPUTS_KEY, { path: '.forgejo/workflows/ci.yml', inputs: [input('tag', { default: 'from-file' })] });

    await select(wrapper, 'ci.yml', 'dev');
    state.loading.set(INPUTS_KEY_DEV, true);
    await nextTick();

    // Not a flicker through the raw editor: the previous declaration stays until
    // the reply for the new ref lands, and Run is blocked meanwhile so a submit
    // cannot send half a form.
    expect(wrapper.findAll('.declared-input')).toHaveLength(1);
    expect(wrapper.text()).toContain('Reading the inputs this workflow declares');
    expect(runButton(wrapper)!.attributes('disabled')).toBe('true');
    wrapper.unmount();
  });

  it('reads the declaration per selection and again when the view is re-entered', async () => {
    const host = defineComponent({
      props: { show: { type: Boolean, default: true } },
      setup(props) {
        return () =>
          h(KeepAlive, null, {
            default: () =>
              props.show
                ? h(RepoActions, { instanceId: 'inst-1', owner: 'owner', repo: 'repo' })
                : h('div', 'placeholder'),
          });
      },
    });
    const wrapper = mount(host, { global: { plugins: [createTestI18n('en')] } });
    await openForm(wrapper);
    await select(wrapper);

    expect(stateMock.loadWorkflowDispatchInputs).toHaveBeenCalledWith(
      'inst-1',
      'owner',
      'repo',
      'ci.yml',
      'main',
      false,
    );
    stateMock.loadWorkflowDispatchInputs.mockClear();

    // Leaving the Actions view with the form open and coming back re-reads the
    // file: the branch it is dispatched to may have moved on since.
    await wrapper.setProps({ show: false });
    await nextTick();
    await wrapper.setProps({ show: true });
    await nextTick();

    expect(stateMock.loadWorkflowDispatchInputs).toHaveBeenCalledWith(
      'inst-1',
      'owner',
      'repo',
      'ci.yml',
      'main',
      true,
    );
    wrapper.unmount();
  });
});
