import { describe, expect, it, vi } from 'vitest';
import { mount } from '@vue/test-utils';

const { stateMock } = vi.hoisted(() => ({
  stateMock: {
    getUserPreview: vi.fn(async () => undefined),
    getIssuePreview: vi.fn(async () => undefined),
  },
}));

vi.mock('../../composables/useAppState', async () => {
  const { reactive } = await import('vue');
  const state = reactive(stateMock);
  return { useAppState: () => state };
});

import MarkdownBody from '../MarkdownBody.vue';
import { createTestI18n } from '../../__tests__/helpers/test-utils';

const MentionHoverCardStub = { name: 'MentionHoverCard', template: '<div />' };

function mountBody(html: string) {
  return mount(MarkdownBody, {
    props: { html },
    global: {
      plugins: [createTestI18n('en')],
      stubs: { MentionHoverCard: MentionHoverCardStub },
    },
  });
}

/**
 * A `mailto:`/`file:`/`vscode:` link used to render with link styling and the
 * click handler emitted `openExternal` for it, but the host opens web URLs only
 * and refused it with a log line: the user clicked a live looking link and
 * nothing happened. The body now says so by rendering it as plain text, while a
 * link the host can open keeps working.
 */
describe('MarkdownBody links the host can open', () => {
  it('emits openExternal for an https link', async () => {
    const wrapper = mountBody('<p><a href="https://codeberg.org/forgejo">forgejo</a></p>');

    await wrapper.get('.markdown-content a').trigger('click');

    expect(wrapper.emitted('openExternal')?.[0]).toEqual(['https://codeberg.org/forgejo']);
  });

  it('renders a mailto: link as plain text instead of a dead link', async () => {
    const wrapper = mountBody('<p><a href="mailto:dev@example.com">dev@example.com</a></p>');

    expect(wrapper.find('.markdown-content a').exists()).toBe(false);
    expect(wrapper.get('.markdown-content').text()).toContain('dev@example.com');
    expect(wrapper.emitted('openExternal')).toBeUndefined();
  });

  it('renders a neutralized href as plain text instead of a dead live-looking link', async () => {
    // A dangerous-scheme href kept its anchor (rewritten to `javascript:void(0)`
    // with no `data-href`), so it rendered in link colour and stayed a tab stop
    // while activating it did nothing.
    const wrapper = mountBody('<p>see <a href="javascript:void(0)">the docs</a> for it</p>');

    expect(wrapper.find('.markdown-content a').exists()).toBe(false);
    expect(wrapper.get('.markdown-content').text()).toContain('see the docs for it');
    expect(wrapper.emitted('openExternal')).toBeUndefined();
  });

  it('lets a fragment link keep jumping inside the body', async () => {
    const wrapper = mountBody('<p><a href="#section">jump</a></p>');

    const event = new MouseEvent('click', { bubbles: true, cancelable: true });
    wrapper.get('.markdown-content a').element.dispatchEvent(event);

    // The browser's own in-page jump, not something the handler swallows.
    expect(event.defaultPrevented).toBe(false);
    expect(wrapper.emitted('openExternal')).toBeUndefined();
  });

  it('stops an anchor with no destination that reached the DOM anyway', async () => {
    // The sanitizer unwraps these, so this is the backstop: markup that landed in
    // the DOM regardless must not run its placeholder href on activation.
    const wrapper = mountBody('<p>text</p>');
    const anchor = document.createElement('a');
    anchor.setAttribute('href', 'javascript:void(0)');
    anchor.textContent = 'dead';
    wrapper.get('.markdown-content').element.appendChild(anchor);

    const event = new MouseEvent('click', { bubbles: true, cancelable: true });
    anchor.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(true);
    expect(wrapper.emitted('openExternal')).toBeUndefined();
  });
});
