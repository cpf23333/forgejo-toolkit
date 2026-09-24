import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mount } from '@vue/test-utils';

const { stateMock } = vi.hoisted(() => ({
  stateMock: {
    getUserPreview: vi.fn(async () => ({ login: 'demo-user' })),
    getIssuePreview: vi.fn(async () => ({ index: 1, title: 'issue' })),
  },
}));

vi.mock('../../composables/useAppState', async () => {
  const { reactive } = await import('vue');
  const state = reactive(stateMock);
  return { useAppState: () => state };
});

import MarkdownBody from '../MarkdownBody.vue';
import { createTestI18n } from '../../__tests__/helpers/test-utils';

// The mention hover card is decorative here; the test only cares whether the
// host preview commands are requested.
const MentionHoverCardStub = { name: 'MentionHoverCard', template: '<div />' };

/**
 * Hovering an @mention starts a 200 ms debounce before the preview request is
 * sent. When the body is unmounted inside that window (the detail view closing,
 * the timeline re-rendering, a panel switching) the timer used to survive the
 * component: it still called the host preview command and wrote refs of a dead
 * component.
 */
describe('MarkdownBody hover debounce on unmount', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function mountBody() {
    return mount(MarkdownBody, {
      props: {
        html: '<p>hi <a class="mention" href="https://forgejo.example.com/demo-user">@demo-user</a></p>',
        instanceId: 'inst-1',
      },
      global: {
        plugins: [createTestI18n('en')],
        stubs: { MentionHoverCard: MentionHoverCardStub },
      },
    });
  }

  it('does not request a mention preview after unmounting inside the debounce', () => {
    const wrapper = mountBody();
    const anchor = wrapper.get('.markdown-content a.mention').element;

    // The debounce starts…
    anchor.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: 5, clientY: 6 }));

    // …and the user navigates away before it elapses.
    wrapper.unmount();
    vi.advanceTimersByTime(500);

    expect(stateMock.getUserPreview).not.toHaveBeenCalled();
    expect(stateMock.getIssuePreview).not.toHaveBeenCalled();
  });

  it('still requests the preview when the hover lasts past the debounce', () => {
    const wrapper = mountBody();
    const anchor = wrapper.get('.markdown-content a.mention').element;

    anchor.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: 5, clientY: 6 }));
    vi.advanceTimersByTime(300);

    expect(stateMock.getUserPreview).toHaveBeenCalledTimes(1);
    wrapper.unmount();
  });
});
