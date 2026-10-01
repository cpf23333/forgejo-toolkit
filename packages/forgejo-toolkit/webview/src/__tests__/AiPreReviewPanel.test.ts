import { describe, it, expect, beforeEach } from 'vitest';
import { mount } from '@vue/test-utils';
import AiPreReviewPanel from '../AiPreReviewPanel.vue';
import { createTestI18n } from './helpers/test-utils';
import { vscode } from '../composables/vscode';
import { PR_REVIEW_MAX_COMMENT_LENGTH } from '@cpf23333-forgejo-toolkit/shared/limits';
import type { AiPreReviewPanelCandidate, AiPreReviewPanelConfig } from '../types/config';

/**
 * The AI pre-review confirmation panel, webview side.
 *
 * This panel replaced a multi-select quick pick that put each comment's body
 * inside a label VS Code truncates — with no `description` and no `tooltip` for
 * the rest — so a person could not read what they were about to accept. What this
 * suite pins is the fix and the change that followed it: the **whole** body is on
 * the card, in an **editor** pre-filled with the model's wording, so a wording can
 * be corrected before the draft exists. An edit is marked, can be restored to the
 * model's wording, and is capped at `PR_REVIEW_MAX_COMMENT_LENGTH` with the cap
 * stated rather than cutting text. The header states what the run sent (the
 * model's vendor, the prompt scope, both counts and the grouped drop reasons),
 * nothing is checked until the user checks it, the extension offers no accept-all
 * control, and the answer carries the checked indexes **together with the text
 * each editor holds** — while every anchor stays on the host's side.
 */

const postMessageMock = vscode.postMessage as unknown as { mock: { calls: unknown[][] } };

function candidate(overrides: Partial<AiPreReviewPanelCandidate> = {}): AiPreReviewPanelCandidate {
  return {
    index: 0,
    path: 'src/index.ts',
    line: 2,
    side: 'head',
    extraLines: 0,
    body: 'This logs on every call.',
    diff: { status: 'modified', baseSha: 'abc123', headSha: 'def456' },
    ...overrides,
  };
}

function payload(overrides: Partial<AiPreReviewPanelConfig> = {}): AiPreReviewPanelConfig {
  return {
    instanceId: 'inst-1',
    owner: 'demo-user',
    repo: 'demo-repo',
    index: 2,
    pullRequestTitle: 'Add dark mode',
    model: { name: 'Fake Model', vendor: 'fake', family: 'fake', id: 'fake-model' },
    scope: 'changed-files',
    changedFileCount: 2,
    changedFilesTotal: 2,
    candidateCount: 2,
    drops: [
      { label: 'line not in the diff', count: 1 },
      { label: 'empty body', count: 2 },
    ],
    canOpenPullRequest: true,
    candidates: [
      candidate(),
      candidate({ index: 1, path: 'src/other.ts', line: 4, side: 'base', extraLines: 2, body: 'Second comment.' }),
    ],
    ...overrides,
  };
}

function mountPanel(overrides: Partial<AiPreReviewPanelConfig> = {}) {
  window.__FORGEJO_TOOLKIT_CONFIG__ = { aiPreReview: payload(overrides) };
  return mount(AiPreReviewPanel, { global: { plugins: [createTestI18n('en')] } });
}

/** The checkbox elements, in card order. */
function checkboxes(wrapper: ReturnType<typeof mountPanel>) {
  return wrapper.findAll('vscode-checkbox');
}

/** The body editors, in card order. */
function editors(wrapper: ReturnType<typeof mountPanel>) {
  return wrapper.findAll('.body-input');
}

/** What one editor currently holds. */
function editorValue(wrapper: ReturnType<typeof mountPanel>, position: number): string {
  return (editors(wrapper)[position].element as HTMLTextAreaElement).value;
}

/** The button elements, in DOM order. */
function buttons(wrapper: ReturnType<typeof mountPanel>) {
  return wrapper.findAll('vscode-button');
}

/** Ticks or unticks one card the way the custom element does. */
async function setChecked(wrapper: ReturnType<typeof mountPanel>, position: number, checked: boolean): Promise<void> {
  const box = checkboxes(wrapper)[position];
  (box.element as unknown as { checked: boolean }).checked = checked;
  await box.trigger('change');
}

/**
 * Whether a `<vscode-button>` is disabled.
 *
 * The elements are compiled as custom elements, so `config.global.stubs` does
 * not replace them and Vue writes a boolean attribute as the string `"false"`
 * when the value is false. Reading it back therefore has to normalise that,
 * rather than trusting `attributes('disabled')` to be absent.
 */
function isDisabled(button: { attributes(name: string): string | undefined }): boolean {
  const value = button.attributes('disabled');
  return value !== undefined && value !== 'false';
}

beforeEach(() => {
  postMessageMock.mock.calls.length = 0;
});

describe('AiPreReviewPanel header', () => {
  it('states the pull request, the model and its vendor, the scope and both counts', () => {
    const wrapper = mountPanel();

    const text = wrapper.text();
    expect(text).toContain('demo-user/demo-repo#2');
    expect(text).toContain('Add dark mode');
    // The privacy point stays on screen: which provider answered.
    expect(text).toContain('Fake Model (fake/fake)');
    // The scope the run actually used, spelled as the setting spells it.
    expect(text).toContain('changed-files');
    expect(text).toContain('2 passed the anchor validation');
    // The drop reasons are grouped, one count each — what the quick pick's
    // single sentence could not say.
    expect(wrapper.find('.dropped').text()).toBe('line not in the diff ×1, empty body ×2');
    wrapper.unmount();
  });

  it('says so when nothing was dropped', () => {
    const wrapper = mountPanel({ drops: [] });

    expect(wrapper.find('.dropped').text()).toBe('nothing was dropped');
    wrapper.unmount();
  });
});

describe('AiPreReviewPanel cards', () => {
  it('pre-fills each card editor with the model body, capped at the shared constant', () => {
    const longBody = `${'A comment that is far longer than a quick-pick row could ever show. '.repeat(3)}End.`;
    const wrapper = mountPanel({ candidates: [candidate({ body: longBody, extraLines: 3 })] });

    // The full body — not a preview, not a truncation made by the panel.
    expect(editorValue(wrapper, 0)).toBe(longBody);
    // The cap is the host's own constant, not a number this component invented:
    // the host re-validates against the same one, so the two cannot disagree.
    expect(editors(wrapper)[0].attributes('maxlength')).toBe(String(PR_REVIEW_MAX_COMMENT_LENGTH));
    // The anchor is the checkbox's own label, which is what a user reads beside
    // the box that creates the comment; the extra-line count is part of it.
    expect(checkboxes(wrapper)[0].attributes('label')).toBe('src/index.ts:2-5 (head)');
    // The editor is a labelled control, so it is reachable and named without a
    // mouse and without reading the card's layout.
    expect(editors(wrapper)[0].attributes('aria-label')).toBe('Comment body for src/index.ts:2-5 (head)');
    wrapper.unmount();
  });

  it('marks a body the host had to cut, and offers the diff link only when it can be opened', () => {
    const wrapper = mountPanel({
      candidates: [
        candidate({ index: 0, bodyTruncated: true, diff: { status: 'modified' } }),
        candidate({ index: 1, path: 'src/other.ts', diff: { baseSha: 'abc123', headSha: 'def456' } }),
      ],
    });

    expect(wrapper.text()).toContain("cut to the extension's per-comment limit");
    // One link per card that has both shas.
    expect(wrapper.findAll('.open-diff')).toHaveLength(1);
    wrapper.unmount();
  });

  it('shows no edited state until something is typed', () => {
    const wrapper = mountPanel();

    expect(wrapper.find('.edited-marker').exists()).toBe(false);
    expect(wrapper.find('.restore').exists()).toBe(false);
    wrapper.unmount();
  });

  it('explains an empty list instead of showing a bare panel', () => {
    const wrapper = mountPanel({ candidates: [], candidateCount: 0 });

    expect(wrapper.text()).toContain('no comment that passed the anchor validation');
    expect(checkboxes(wrapper)).toHaveLength(0);
    wrapper.unmount();
  });
});

describe('AiPreReviewPanel editing', () => {
  it('marks an edit and restores the model wording on demand', async () => {
    const wrapper = mountPanel();

    await editors(wrapper)[0].setValue('My own wording.');
    await wrapper.vm.$nextTick();

    // The card says the text is the user's, and offers the one action that undoes
    // it — without retyping, and only on the card that was edited.
    expect(wrapper.find('.edited-marker').text()).toBe('Edited');
    expect(wrapper.findAll('.edited-marker')).toHaveLength(1);
    expect(wrapper.findAll('.restore')).toHaveLength(1);
    expect(editorValue(wrapper, 0)).toBe('My own wording.');
    // The other card is untouched, so it carries neither mark nor action.
    expect(editorValue(wrapper, 1)).toBe('Second comment.');

    await wrapper.find('.restore').trigger('click');
    await wrapper.vm.$nextTick();

    expect(editorValue(wrapper, 0)).toBe('This logs on every call.');
    expect(wrapper.find('.edited-marker').exists()).toBe(false);
    expect(wrapper.find('.restore').exists()).toBe(false);
    wrapper.unmount();
  });

  it('caps the input at the shared limit and says so when the limit is reached', async () => {
    const wrapper = mountPanel({ candidates: [candidate({ body: 'Short.' })] });
    const atLimit = 'x'.repeat(PR_REVIEW_MAX_COMMENT_LENGTH);

    await editors(wrapper)[0].setValue(atLimit);
    await wrapper.vm.$nextTick();

    // The limit is stated with its number instead of the text being cut.
    expect(wrapper.find('.truncated').text()).toContain(`${PR_REVIEW_MAX_COMMENT_LENGTH}-character limit`);
    expect(editorValue(wrapper, 0)).toBe(atLimit);
    wrapper.unmount();
  });

  it('warns about a body over the cap and keeps Create disabled until it is fixed', async () => {
    // The editor itself cannot produce this (the `maxlength` attribute stops the
    // user first); the state is the host's own refusal mirrored in the UI, so a
    // payload or paste that got past the attribute cannot reach a disabled state
    // the user is not told about.
    const wrapper = mountPanel({ candidates: [candidate({ body: 'Short.' })] });
    await setChecked(wrapper, 0, true);

    const overLimit = 'y'.repeat(PR_REVIEW_MAX_COMMENT_LENGTH + 1);
    await editors(wrapper)[0].setValue(overLimit);
    await wrapper.vm.$nextTick();

    const warning = wrapper.find('.warning');
    expect(warning.text()).toContain(`${PR_REVIEW_MAX_COMMENT_LENGTH + 1} characters`);
    expect(warning.text()).toContain(`${PR_REVIEW_MAX_COMMENT_LENGTH}-character limit`);
    expect(isDisabled(buttons(wrapper)[0])).toBe(true);

    await wrapper.find('.restore').trigger('click');
    await wrapper.vm.$nextTick();

    expect(wrapper.find('.warning').exists()).toBe(false);
    expect(isDisabled(buttons(wrapper)[0])).toBe(false);
    wrapper.unmount();
  });

  it('disables Create while a checked card has an empty body, and says why', async () => {
    const wrapper = mountPanel();
    await setChecked(wrapper, 0, true);
    expect(isDisabled(buttons(wrapper)[0])).toBe(false);

    await editors(wrapper)[0].setValue('   ');
    await wrapper.vm.$nextTick();

    // Nothing is created from an empty body, and the user is told which card and
    // what to do rather than being left with a button that does nothing.
    expect(isDisabled(buttons(wrapper)[0])).toBe(true);
    expect(wrapper.find('.warning').text()).toContain('This body is empty');
    expect(wrapper.find('.status').text()).toContain('cannot be created as it stands');

    await editors(wrapper)[0].setValue('Now it has text.');
    await wrapper.vm.$nextTick();

    expect(isDisabled(buttons(wrapper)[0])).toBe(false);
    wrapper.unmount();
  });
});

describe('AiPreReviewPanel actions', () => {
  it('starts with nothing checked and offers no accept-all control of ours', () => {
    const wrapper = mountPanel();

    expect(checkboxes(wrapper)).toHaveLength(2);
    // Nothing is checked, and the count the button states is the proof that
    // matters to a user: the answer starts empty.
    expect(buttons(wrapper).map((button) => button.text())).toEqual(['Create 0 draft comment(s)', 'Cancel']);
    expect(isDisabled(buttons(wrapper)[0])).toBe(true);
    // No control of the extension's own selects everything.
    expect(wrapper.text()).not.toMatch(/accept all|select all|toggle all|check all/i);
    wrapper.unmount();
  });

  it('counts the checked cards and posts the edited bodies with them', async () => {
    const wrapper = mountPanel();

    expect(isDisabled(buttons(wrapper)[0])).toBe(true);

    await setChecked(wrapper, 1, true);
    await editors(wrapper)[1].setValue('Second, but mine.');
    await wrapper.vm.$nextTick();

    expect(wrapper.text()).toContain('Create 1 draft comment(s)');
    expect(isDisabled(buttons(wrapper)[0])).toBe(false);
    await buttons(wrapper)[0].trigger('click');

    // The answer carries the text the editor holds — the whole point of the
    // change — and still no anchor field of any kind.
    expect(postMessageMock.mock.calls).toEqual([
      [{ command: 'aiPreReviewPanelCreate', entries: [{ index: 1, body: 'Second, but mine.' }] }],
    ]);
    wrapper.unmount();
  });

  it('sends the model wording unchanged for a card that was not edited', async () => {
    const wrapper = mountPanel();

    await setChecked(wrapper, 0, true);
    await buttons(wrapper)[0].trigger('click');

    expect(postMessageMock.mock.calls).toEqual([
      [{ command: 'aiPreReviewPanelCreate', entries: [{ index: 0, body: 'This logs on every call.' }] }],
    ]);
    wrapper.unmount();
  });

  it('sends a cancellation when the user dismisses the question', async () => {
    const wrapper = mountPanel();

    await buttons(wrapper)[1].trigger('click');

    expect(postMessageMock.mock.calls).toEqual([[{ command: 'aiPreReviewPanelCancel' }]]);
    wrapper.unmount();
  });

  it('asks the host to open a card\u2019s anchor in the diff', async () => {
    const wrapper = mountPanel();

    await wrapper.find('.open-diff').trigger('click');

    expect(postMessageMock.mock.calls).toEqual([[{ command: 'aiPreReviewPanelOpenDiff', index: 0 }]]);
    wrapper.unmount();
  });
});

describe('AiPreReviewPanel outcome', () => {
  function dispatch(command: string, data: Record<string, unknown> = {}) {
    window.dispatchEvent(new MessageEvent('message', { data: { command, ...data } }));
  }

  it('shows the host refusal, keeps the question open and lets the user press Create again', async () => {
    const wrapper = mountPanel();
    await setChecked(wrapper, 0, true);
    await buttons(wrapper)[0].trigger('click');
    // The answer is out; the host refuses it as a whole. Start from a clean slate
    // so the last assertion is about the second press.
    postMessageMock.mock.calls.length = 0;

    const reason = 'Nothing was created: the comment for src/index.ts:2 (head) has an empty body.';
    dispatch('aiPreReviewPanelRejected', { reason });
    await wrapper.vm.$nextTick();

    expect(wrapper.find('.rejected').text()).toBe(reason);
    // The question is not over: the actions are still there (the refusal released
    // the button rather than leaving it stuck on "creating").
    expect(wrapper.find('.result').exists()).toBe(false);
    expect(buttons(wrapper).map((button) => button.text())).toContain('Cancel');

    // The user fixes the card and presses Create again; the refusal goes away as
    // soon as a new answer is sent.
    await editors(wrapper)[0].setValue('Fixed.');
    await wrapper.vm.$nextTick();
    await buttons(wrapper)[0].trigger('click');

    expect(postMessageMock.mock.calls).toEqual([
      [{ command: 'aiPreReviewPanelCreate', entries: [{ index: 0, body: 'Fixed.' }] }],
    ]);
    expect(wrapper.find('.rejected').exists()).toBe(false);
    wrapper.unmount();
  });

  it('replaces the actions with the outcome and the way to the pending review', async () => {
    const wrapper = mountPanel();

    dispatch('aiPreReviewPanelResult', { created: 2 });
    await wrapper.vm.$nextTick();

    expect(wrapper.find('.result').text()).toContain('Created 2 draft comment(s) in the pending review');
    expect(wrapper.text()).toContain('this extension never submits it');
    // No create action left to press a second time.
    expect(buttons(wrapper).map((button) => button.text())).toEqual(['Open the pull request']);

    await wrapper.find('.open-draft').trigger('click');
    expect(postMessageMock.mock.calls).toEqual([[{ command: 'aiPreReviewPanelOpenDraft' }]]);
    wrapper.unmount();
  });

  it('reports a partial and a total failure honestly, and hides the draft action without a target', async () => {
    const partial = mountPanel();
    dispatch('aiPreReviewPanelResult', { created: 1, failure: 'server said no' });
    await partial.vm.$nextTick();
    expect(partial.find('.result').text()).toContain('Created 1 draft comment(s); the rest failed: server said no');
    partial.unmount();

    const failed = mountPanel({ canOpenPullRequest: false });
    dispatch('aiPreReviewPanelResult', { created: 0, failure: 'server said no' });
    await failed.vm.$nextTick();
    expect(failed.find('.result').text()).toContain('No draft comment could be created: server said no');
    expect(failed.find('.open-draft').exists()).toBe(false);
    failed.unmount();
  });

  it('accepts a replaced payload and clears the answer state and the edits with it', async () => {
    const wrapper = mountPanel();
    await editors(wrapper)[0].setValue('An edit that must not survive.');
    await wrapper.vm.$nextTick();
    dispatch('aiPreReviewPanelResult', { created: 1 });
    await wrapper.vm.$nextTick();

    dispatch('aiPreReviewPanelPayload', { payload: payload({ candidateCount: 1, candidates: [candidate()] }) });
    await wrapper.vm.$nextTick();

    expect(checkboxes(wrapper)).toHaveLength(1);
    expect(wrapper.find('.result').exists()).toBe(false);
    expect(wrapper.find('.edited-marker').exists()).toBe(false);
    expect(editorValue(wrapper, 0)).toBe('This logs on every call.');
    expect(buttons(wrapper).map((button) => button.text())).toEqual(['Create 0 draft comment(s)', 'Cancel']);
    wrapper.unmount();
  });
});
