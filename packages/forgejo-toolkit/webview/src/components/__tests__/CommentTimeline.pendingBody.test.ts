import { beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';

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
      `${instanceId}:${owner}/${repo}:comment-${commentId}:edit`,
    issueCommentDeleteFormKey: (instanceId: string, owner: string, repo: string, commentId: number) =>
      `${instanceId}:${owner}/${repo}:comment-${commentId}:delete-form`,
  };
});

import CommentTimeline from '../CommentTimeline.vue';
import { createTestI18n } from '../../__tests__/helpers/test-utils';
import type { ForgejoTimelineComment } from '../../types/api';

/**
 * The timeline renders a first batch of rows (COMMENT_RENDER_BATCH = 25) but
 * only runs MAX_MARKDOWN_RENDERS_IN_FLIGHT = 4 markdown renders at a time. The
 * rows still waiting for a render slot have no HTML yet, and MarkdownBody reads
 * an empty `html` as "this comment has no body" — the user sees "No description
 * provided." on comments that are merely queued. Until a row's render returns it
 * must show the loading placeholder, never the empty-body text.
 */
describe('CommentTimeline pending comment bodies', () => {
  const COMMENT_COUNT = 25;

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

  it('does not claim a queued comment is empty', async () => {
    // Every render stays in flight: the rows beyond the concurrency limit are
    // queued and have no HTML yet.
    stateMock.renderMarkdown.mockImplementation(() => new Promise(() => {}));

    const wrapper = mountTimeline();
    await flushPromises();

    expect(wrapper.findAll('.timeline-item')).toHaveLength(COMMENT_COUNT);
    expect(wrapper.findAll('.markdown-empty')).toHaveLength(0);
    expect(wrapper.text()).not.toContain('No description provided.');
    // Every visible row says it is still rendering, not just the 4 in flight.
    expect(wrapper.findAll('.comment-body .loading')).toHaveLength(COMMENT_COUNT);

    wrapper.unmount();
  });

  it('shows the rendered body once the queued renders return', async () => {
    const resolving: Array<() => void> = [];
    stateMock.renderMarkdown.mockImplementation(
      (_instanceId: string, text: string) =>
        new Promise<string>((resolve) => {
          resolving.push(() => resolve(`<p>${text}</p>`));
        }),
    );

    const wrapper = mountTimeline();

    // Drain the queue in rounds: four renders at a time, resolving whatever is
    // in flight until every row has its body.
    for (let round = 0; round < 20 && resolving.length > 0; round++) {
      const inFlight = resolving.splice(0, resolving.length);
      for (const resolve of inFlight) {
        resolve();
      }
      await flushPromises();
      await new Promise((done) => setTimeout(done, 0));
      await flushPromises();
    }

    expect(wrapper.findAll('.comment-body .loading')).toHaveLength(0);
    expect(wrapper.findAll('.markdown-empty')).toHaveLength(0);
    expect(wrapper.findAll('.markdown-content')).toHaveLength(COMMENT_COUNT);
    expect(wrapper.text()).toContain('comment body 1');
    expect(wrapper.text()).toContain(`comment body ${COMMENT_COUNT}`);

    wrapper.unmount();
  });
});
