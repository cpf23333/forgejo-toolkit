import { beforeEach, describe, expect, it } from 'vitest';
import { mount } from '@vue/test-utils';
import { nextTick } from 'vue';
import NotificationSummaryPanel from '../NotificationSummaryPanel.vue';
import { vscode } from '../composables/vscode';
import { createTestI18n } from './helpers/test-utils';
import type { NotificationSummaryPanelPayload } from '@cpf23333-forgejo-toolkit/shared/webview/messages';

/**
 * The notification-summary panel (`docs/design/notification-summary.md` §4, §7).
 *
 * The panel is the whole reading surface of this feature: the list action only
 * dispatches, and everything a reader learns about the answer — which model
 * answered, which scope tier the run actually used, whether the answer was cut —
 * is this document. So the tests here are about the panel's own claims: that the
 * header's three facts are the ones that **arrived** (not the ones the run meant),
 * that a truncated answer says so in the body and not only in the header, that each
 * failure arm renders the arm's own sentence, and that one panel re-renders for a
 * second notification instead of accumulating answers.
 */

const postMessageMock = vscode.postMessage as unknown as {
  mock: { calls: Array<[Record<string, unknown>]> };
  mockClear: () => void;
};

function postedMessages(): Array<Record<string, unknown>> {
  return postMessageMock.mock.calls.map((call) => call[0]);
}

function createPayload(overrides: Partial<NotificationSummaryPanelPayload> = {}): NotificationSummaryPanelPayload {
  return {
    instanceId: 'inst-1',
    owner: 'demo-user',
    repo: 'demo-repo',
    type: 'issue',
    index: 42,
    title: 'Crash on startup',
    outcome: 'answer',
    model: { name: 'Example Model', vendor: 'example', family: 'chat-1', id: 'example/chat-1' },
    transport: { id: 'vscode.lm', kind: 'vscode.lm', provider: 'example' },
    scope: 'body-and-comments',
    truncated: false,
    answer: 'The discussion settled on retrying the request.',
    ...overrides,
  };
}

/** The payload a second run sends while the panel is already open. */
function dispatchPayload(payload: NotificationSummaryPanelPayload) {
  window.dispatchEvent(new MessageEvent('message', { data: { command: 'notificationSummaryPanelPayload', payload } }));
}

function mountPanel(payload?: NotificationSummaryPanelPayload) {
  window.__FORGEJO_TOOLKIT_CONFIG__ = payload ? { notificationSummary: payload } : { vscodeVersion: '1.90.0' };
  return mount(NotificationSummaryPanel, { global: { plugins: [createTestI18n('en')] } });
}

/** One header fact's rendered value. */
function fact(wrapper: ReturnType<typeof mountPanel>, name: 'model' | 'scope' | 'truncated'): string {
  return wrapper.get(`.fact-${name} .fact-value`).text();
}

function buttonLabelled(wrapper: ReturnType<typeof mountPanel>, label: string) {
  return wrapper.findAll('vscode-button').find((button) => button.text().includes(label));
}

beforeEach(() => {
  postMessageMock.mockClear();
});

describe('NotificationSummaryPanel header', () => {
  it('states the model, the scope tier and the truncation fact the payload carried', async () => {
    const wrapper = mountPanel(
      createPayload({
        scope: 'body-comments-and-events',
        truncated: true,
        truncationReason: 'answer',
        model: createPayload().model,
      }),
    );

    // The three facts §4 requires, each rendered from the payload rather than
    // inferred from the answer's text.
    expect(fact(wrapper, 'model')).toContain('Example Model');
    expect(fact(wrapper, 'model')).toContain('example/chat-1');
    expect(fact(wrapper, 'scope')).toContain('body-comments-and-events');
    expect(fact(wrapper, 'truncated')).toContain("the endpoint's output limit");
    wrapper.unmount();
  });

  it('renders an endpoint model by its vendor alone, and says when a fact was never recorded', async () => {
    const wrapper = mountPanel(
      createPayload({
        model: { name: 'Gateway Model', vendor: 'local-gateway', family: '', id: 'gateway-1' },
        // A run that never got as far as a scope has no tier to name: that is not
        // the same statement as "the tier was empty", so it must not read alike.
        scope: undefined,
        truncated: undefined,
      }),
    );

    expect(fact(wrapper, 'model')).toContain('local-gateway');
    expect(fact(wrapper, 'model')).not.toContain('local-gateway/');
    expect(fact(wrapper, 'scope')).toContain('no run started');
    expect(fact(wrapper, 'truncated')).toContain('Not recorded');
    wrapper.unmount();
  });

  it('states an untruncated answer as untruncated rather than as unrecorded', () => {
    const wrapper = mountPanel(createPayload({ truncated: false }));
    expect(fact(wrapper, 'truncated')).toContain('No');
    expect(fact(wrapper, 'truncated')).not.toContain('Not recorded');
    wrapper.unmount();
  });
});

describe('NotificationSummaryPanel truncation wording', () => {
  /**
   * The defect this block exists for: the panel used to fold "the material was
   * trimmed" and "the endpoint stopped the answer" into one boolean, so a complete
   * answer built from a trimmed discussion was labelled 「这段摘要可能不完整」. The
   * record reserves "the answer may be incomplete" for the endpoint's own output
   * limit (`docs/design/notification-summary.md` §7), so each reason now says which
   * part was cut — and the material arm says the summary is **not** itself cut.
   */
  it('says the answer stopped at the endpoint limit when that is what was cut', () => {
    const wrapper = mountPanel(createPayload({ truncated: true, truncationReason: 'answer' }));

    expect(fact(wrapper, 'truncated')).toContain('the answer stopped at the endpoint');
    const note = wrapper.get('.truncated-note').text();
    expect(note).toContain('This summary is incomplete');
    expect(note).toContain('output limit');
    wrapper.unmount();
  });

  it('says the discussion was trimmed and the summary is not itself cut', () => {
    const wrapper = mountPanel(createPayload({ truncated: true, truncationReason: 'material' }));

    // The header names the side that was cut: the material, not the answer.
    expect(fact(wrapper, 'truncated')).toContain('The discussion only');
    expect(fact(wrapper, 'truncated')).toContain('not cut');
    // The body explains what a trimmed material means, and it must not claim the
    // summary itself is incomplete — that is the overclaim being fixed.
    const note = wrapper.get('.truncated-note').text();
    expect(note).toContain('trimmed version of this discussion');
    expect(note).toContain('faithful to what it saw');
    expect(note).toContain('is not itself cut');
    expect(note).not.toContain('This summary is incomplete');
    wrapper.unmount();
  });

  it('says both were cut when both were', () => {
    const wrapper = mountPanel(createPayload({ truncated: true, truncationReason: 'material-and-answer' }));

    expect(fact(wrapper, 'truncated')).toContain('both the discussion and the answer were cut');
    const note = wrapper.get('.truncated-note').text();
    expect(note).toContain('Both happened');
    expect(note).toContain('trimmed discussion');
    expect(note).toContain('output limit');
    expect(note).toContain('incomplete where it stops');
    wrapper.unmount();
  });

  it('keeps the no-truncation wording when the field is absent', () => {
    // `truncated: false` is the run's own claim that it cut nothing.
    const claimed = mountPanel(createPayload({ truncated: false }));
    expect(fact(claimed, 'truncated')).toBe('No');
    expect(claimed.find('.truncated-note').exists()).toBe(false);
    claimed.unmount();

    // No boolean at all is "no run made the claim", which is not the same statement.
    const unrecorded = mountPanel(createPayload({ truncated: undefined }));
    expect(fact(unrecorded, 'truncated')).toContain('Not recorded');
    expect(unrecorded.find('.truncated-note').exists()).toBe(false);
    unrecorded.unmount();
  });

  it('never turns a truncation with no stated reason into an incomplete answer', () => {
    // A payload from a host that predates the reason field: it says something was
    // cut but not which part. The panel says only that, rather than claiming the
    // prose is incomplete or that the material was trimmed.
    const wrapper = mountPanel(createPayload({ truncated: true }));

    expect(fact(wrapper, 'truncated')).toContain('part of the run was cut');
    const note = wrapper.get('.truncated-note').text();
    expect(note).toContain('cannot say');
    expect(note).not.toContain('This summary is incomplete');
    expect(note).not.toContain('faithful to what it saw');
    wrapper.unmount();
  });
});

describe('NotificationSummaryPanel body', () => {
  it('repeats the truncation in the body, not only in the header', () => {
    const wrapper = mountPanel(createPayload({ truncated: true, truncationReason: 'answer' }));

    const note = wrapper.get('.truncated-note').text();
    expect(note).toContain('This summary is incomplete');
    // The answer is still shown: the point is to read it as a partial one, not to
    // hide it.
    expect(wrapper.get('.answer').text()).toContain('retrying the request');
    wrapper.unmount();
  });

  it('leaves the body without a truncation note when nothing was cut', () => {
    const wrapper = mountPanel(createPayload({ truncated: false }));
    expect(wrapper.find('.truncated-note').exists()).toBe(false);
    wrapper.unmount();
  });

  it('says there is nothing to summarize, and names the selected scope as the reason', () => {
    const wrapper = mountPanel(
      createPayload({ outcome: 'empty', answer: undefined, scope: 'body-only', truncated: undefined }),
    );

    expect(wrapper.get('.state').text()).toContain('nothing to summarize');
    expect(wrapper.find('.answer').exists()).toBe(false);
    wrapper.unmount();
  });

  it('points at the settings for an unavailable model and offers no regenerate', () => {
    const wrapper = mountPanel(
      createPayload({
        outcome: 'unavailable',
        answer: undefined,
        model: undefined,
        scope: undefined,
        truncated: undefined,
      }),
    );

    expect(wrapper.get('.state').text()).toContain('No AI model is available');
    expect(buttonLabelled(wrapper, 'Open Extension Settings')).toBeTruthy();
    expect(buttonLabelled(wrapper, 'Regenerate the summary')).toBeUndefined();
    wrapper.unmount();
  });

  it('renders the host sentence that names what refused, without inventing a switch', () => {
    const wrapper = mountPanel(
      createPayload({
        outcome: 'refused',
        answer: undefined,
        failure: 'The endpoint "team-gateway" refused the request (403).',
      }),
    );

    expect(wrapper.get('.state').text()).toContain('refused this request');
    expect(wrapper.get('.failure').text()).toContain('team-gateway');
    wrapper.unmount();
  });

  it('says an over-long answer was refused rather than trimmed', () => {
    const wrapper = mountPanel(createPayload({ outcome: 'too-long', answer: undefined }));
    expect(wrapper.get('.state').text()).toContain('refused rather than trimmed');
    wrapper.unmount();
  });

  it('says a failed read called no model', () => {
    const wrapper = mountPanel(createPayload({ outcome: 'read-failed', answer: undefined }));
    expect(wrapper.get('.state').text()).toContain('could not be read');
    wrapper.unmount();
  });

  it('does not render an empty answer body when the payload claims an answer it did not carry', () => {
    const wrapper = mountPanel(createPayload({ outcome: 'answer', answer: undefined }));

    // Three facts, no prose and no state line would read as a complete answer of
    // nothing; the panel states that it could not produce the summary instead.
    expect(wrapper.find('.answer').exists()).toBe(false);
    expect(wrapper.get('.state').text()).toContain('could not be produced');
    wrapper.unmount();
  });
});

describe('NotificationSummaryPanel actions', () => {
  it('regenerates once and then spends the action', async () => {
    const wrapper = mountPanel(createPayload());

    const regenerate = buttonLabelled(wrapper, 'Regenerate the summary')!;
    expect(regenerate).toBeTruthy();
    await regenerate.trigger('click');

    expect(postedMessages()).toContainEqual({ command: 'notificationSummaryRegenerate' });
    expect(buttonLabelled(wrapper, 'Regenerating…')).toBeTruthy();

    // A second click while the run is in flight must not post a second request.
    postMessageMock.mockClear();
    await buttonLabelled(wrapper, 'Regenerating…')!.trigger('click');
    expect(postedMessages()).toEqual([]);
    wrapper.unmount();
  });

  it('re-arms the single regenerate when a new answer arrives', async () => {
    const wrapper = mountPanel(createPayload());
    await buttonLabelled(wrapper, 'Regenerate the summary')!.trigger('click');
    expect(buttonLabelled(wrapper, 'Regenerate the summary')).toBeUndefined();

    dispatchPayload(createPayload({ answer: 'A fresh answer.' }));
    await nextTick();

    expect(buttonLabelled(wrapper, 'Regenerate the summary')).toBeTruthy();
    expect(wrapper.get('.answer').text()).toContain('A fresh answer.');
    wrapper.unmount();
  });

  it('offers the prose as read-only text, with no editor that could change it', () => {
    const wrapper = mountPanel(createPayload());

    // Selectable and copyable because it is ordinary text; there is deliberately no
    // textarea or input holding it, so nothing on this surface can edit an answer
    // and nothing can send an edit anywhere.
    const answer = wrapper.get('.answer');
    expect(answer.element.tagName).toBe('P');
    expect(answer.text()).toBe('The discussion settled on retrying the request.');
    expect(wrapper.findAll('textarea, input')).toHaveLength(0);
    wrapper.unmount();
  });

  it('posts nothing but its own two actions, so no answer of this surface writes anywhere', async () => {
    const wrapper = mountPanel(
      createPayload({ outcome: 'unavailable', answer: undefined, model: undefined, truncated: undefined }),
    );
    // Every control the panel can offer, exercised in one run: the regenerate (on
    // the arms that have it) and the settings destination.
    dispatchPayload(createPayload());
    await nextTick();
    await buttonLabelled(wrapper, 'Regenerate the summary')!.trigger('click');
    dispatchPayload(createPayload({ outcome: 'unavailable', answer: undefined, scope: undefined }));
    await nextTick();
    await buttonLabelled(wrapper, 'Open Extension Settings')!.trigger('click');

    expect([...new Set(postedMessages().map((message) => message.command))].sort()).toEqual([
      'notificationSummaryRegenerate',
      'openNativeSettings',
    ]);
    wrapper.unmount();
  });
});

describe('NotificationSummaryPanel state arrives by message', () => {
  it('renders the payload a late message carries, field for field', async () => {
    const wrapper = mountPanel();
    // No injected payload: the panel is showing its loading state, which is also
    // what a host that opens the tab before the run finishes produces.
    expect(wrapper.find('.notification-summary').exists()).toBe(false);

    dispatchPayload(
      createPayload({
        scope: 'body-only',
        truncated: true,
        // The reason travels with the payload too: it is the field the header and the
        // body both read, so a message path that dropped it would show the wrong
        // truncation story.
        truncationReason: 'material',
        answer: 'From the message.',
      }),
    );
    await nextTick();

    expect(fact(wrapper, 'scope')).toContain('body-only');
    expect(fact(wrapper, 'truncated')).toContain('The discussion only');
    expect(wrapper.get('.truncated-note').text()).toContain('trimmed version of this discussion');
    expect(wrapper.get('.answer').text()).toContain('From the message.');
    wrapper.unmount();
  });

  it('re-renders the one panel for another notification instead of stacking a second answer', async () => {
    const wrapper = mountPanel(createPayload({ index: 42, answer: 'Answer for the first notification.' }));
    expect(buttonLabelled(wrapper, 'Regenerate the summary')).toBeTruthy();

    dispatchPayload(
      createPayload({
        index: 77,
        title: 'Second discussion',
        answer: 'Answer for the second notification.',
        scope: 'body-only',
      }),
    );
    await nextTick();

    // Exactly one panel, one identity and one answer: the previous notification's
    // answer is gone rather than kept beside the new one.
    expect(wrapper.findAll('.notification-summary')).toHaveLength(1);
    expect(wrapper.get('.summary-target').text()).toContain('#77');
    expect(wrapper.get('.summary-target').text()).not.toContain('#42');
    expect(wrapper.findAll('.answer')).toHaveLength(1);
    expect(wrapper.get('.answer').text()).toContain('second notification');
    expect(wrapper.text()).not.toContain('first notification');
    wrapper.unmount();
  });
});
