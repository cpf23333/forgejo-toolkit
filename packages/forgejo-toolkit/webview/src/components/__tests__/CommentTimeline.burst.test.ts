import { describe, expect, it, vi, beforeEach } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { nextTick } from 'vue';

const { stateMock } = vi.hoisted(() => ({
  stateMock: {
    loading: new Map<string, boolean>(),
    errors: new Map<string, string>(),
    commentReactions: { value: new Map<string, unknown[]>() },
    instances: { value: [{ id: 'inst-1', url: 'https://forgejo.example.com', username: 'demo-user' }] },
    loadCommentReactions: vi.fn(),
    renderMarkdown: vi.fn(),
    openExternal: vi.fn(),
    deleteIssueComment: vi.fn(),
    editIssueComment: vi.fn(),
    uploadIssueCommentAttachment: vi.fn(),
    deleteIssueCommentAttachment: vi.fn(),
  },
}));

vi.mock('../../composables/useAppState', async () => {
  const { reactive } = await import('vue');
  const state = reactive(stateMock);
  return {
    useAppState: () => state,
    commentReactionsKey: (instanceId: string, owner: string, repo: string, commentId: number) =>
      `${instanceId}:${owner}/${repo}:comment:${commentId}:reactions`,
    issueCommentEditFormKey: (instanceId: string, owner: string, repo: string, commentId: number) =>
      `${instanceId}:${owner}/${repo}:comment:${commentId}:edit`,
    issueCommentDeleteFormKey: (instanceId: string, owner: string, repo: string, commentId: number) =>
      `${instanceId}:${owner}/${repo}:comment-${commentId}:delete-form`,
  };
});

import CommentTimeline from '../CommentTimeline.vue';
import { createTestI18n } from '../../__tests__/helpers/test-utils';
import type { ForgejoTimelineComment } from '../../types/api';

/**
 * The host caps a timeline at MAX_ITEMS (500) entries, and the view marks every
 * entry as needing a rendered body and a reaction list. Firing one host call per
 * entry in a single tick hammered the extension host with ~1,000 calls and
 * mounted 500 markdown bodies at once; the timeline now trickles the requests
 * and renders a first batch, revealing the rest on demand.
 */
describe('CommentTimeline burst control', () => {
  const COMMENT_COUNT = 500;
  const BATCH = 25;

  function comments(count = COMMENT_COUNT): ForgejoTimelineComment[] {
    return Array.from({ length: count }, (_, i) => ({
      id: i + 1,
      type: 'comment',
      body: `comment body ${i + 1}`,
      created_at: '2026-01-01T00:00:00Z',
      user: {
        id: 1,
        login: 'demo-user',
        full_name: 'Demo User',
        email: 'demo-user@forgejo.example.com',
        avatar_url: 'https://forgejo.example.com/avatars/demo-user',
      },
    }));
  }

  beforeEach(() => {
    vi.clearAllMocks();
    stateMock.loading.clear();
    stateMock.errors.clear();
    stateMock.commentReactions.value.clear();
    stateMock.renderMarkdown.mockImplementation(async (_instanceId: string, text: string) => `<p>${text}</p>`);
  });

  function mountTimeline(count = COMMENT_COUNT) {
    return mount(CommentTimeline, {
      props: {
        comments: comments(count),
        instanceId: 'inst-1',
        owner: 'owner',
        repo: 'repo',
        index: 1,
      },
      global: {
        plugins: [createTestI18n('en')],
        // The real editor loads EasyMDE (and needs IntersectionObserver), which
        // this test does not exercise.
        stubs: { EasyMdeEditor: true },
      },
    });
  }

  it('does not issue one markdown request per comment at once', async () => {
    let inFlight = 0;
    let peakInFlight = 0;
    stateMock.renderMarkdown.mockImplementation(async (_instanceId: string, text: string) => {
      inFlight += 1;
      peakInFlight = Math.max(peakInFlight, inFlight);
      // Resolve on a later task so overlapping calls are observable.
      await new Promise((resolve) => setTimeout(resolve, 0));
      inFlight -= 1;
      return `<p>${text}</p>`;
    });

    const wrapper = mountTimeline();

    // A 500-entry timeline used to fire 500 requests synchronously here.
    expect(stateMock.renderMarkdown.mock.calls.length).toBeLessThanOrEqual(4);

    // Draining the queue releases four at a time, never a burst.
    for (let round = 0; round < 8; round++) {
      await new Promise((resolve) => setTimeout(resolve, 0));
      await flushPromises();
    }

    // The whole visible batch still gets rendered, one small group at a time.
    expect(stateMock.renderMarkdown.mock.calls.length).toBe(BATCH);
    expect(peakInFlight).toBeLessThanOrEqual(4);
    expect(wrapper.findAll('.timeline-item')).toHaveLength(BATCH);
    expect(stateMock.loadCommentReactions.mock.calls.length).toBeLessThanOrEqual(BATCH);
    wrapper.unmount();
  });

  it('renders a large timeline in batches and keeps every entry reachable', async () => {
    // Sixty entries: the same batching path as a full page, without mounting
    // 500 rows of components in jsdom.
    const TOTAL = 60;
    const wrapper = mountTimeline(TOTAL);
    expect(wrapper.findAll('.timeline-item')).toHaveLength(BATCH);
    expect(wrapper.text()).not.toContain('comment body 26');

    const showMore = wrapper.get('.timeline-more vscode-button');
    expect(showMore.text()).toContain('Show 25 more entries');

    // The rest arrives in batches…
    await showMore.trigger('click');
    await nextTick();
    expect(wrapper.findAll('.timeline-item')).toHaveLength(BATCH * 2);

    // …until every entry is rendered, including the last one.
    await showMore.trigger('click');
    await nextTick();
    await flushPromises();

    expect(wrapper.findAll('.timeline-item')).toHaveLength(TOTAL);
    expect(wrapper.text()).toContain(`comment body ${TOTAL}`);
    expect(wrapper.find('.timeline-more').exists()).toBe(false);
    wrapper.unmount();
  });
});
