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

const BATCH = 25;

/** More entries than one render batch, oldest first. */
function comments(count = 40): ForgejoTimelineComment[] {
  return Array.from({ length: count }, (_, i) => ({
    id: i + 1,
    type: 'comment',
    body: `comment body ${i + 1}`,
    created_at: new Date(Date.UTC(2026, 0, 1, 0, i)).toISOString(),
    user: {
      id: 1,
      login: 'demo-user',
      full_name: 'Demo User',
      email: 'demo-user@forgejo.example.com',
      avatar_url: 'https://forgejo.example.com/avatars/demo-user',
    },
  }));
}

function mountTimeline(count = 40) {
  return mount(CommentTimeline, {
    props: { comments: comments(count), instanceId: 'inst-1', owner: 'owner', repo: 'repo', index: 1 },
    global: {
      plugins: [createTestI18n('en')],
      stubs: { EasyMdeEditor: true },
    },
  });
}

async function drainRenders() {
  for (let round = 0; round < 12; round++) {
    await new Promise((resolve) => setTimeout(resolve, 0));
    await flushPromises();
  }
}

/**
 * The render queue was refilled by a watcher on `[() => props.comments,
 * visibleCommentCount]`, but the sort toggle re-slices `visibleComments` without
 * changing either: in a timeline longer than COMMENT_RENDER_BATCH every row the
 * flip brought into the window had no rendered body, so it rendered the "No
 * description provided." empty state for a comment that has one until the props
 * changed or "Show more" was pressed. The queue now follows the visible set.
 */
describe('CommentTimeline render queue follows the sort order', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    stateMock.loading.clear();
    stateMock.errors.clear();
    stateMock.commentReactions.value.clear();
    stateMock.renderMarkdown.mockImplementation(async (_instanceId: string, text: string) => `<p>${text}</p>`);
  });

  it('renders the rows a sort flip brings into the window', async () => {
    const wrapper = mountTimeline(40);
    await drainRenders();

    // The first batch, oldest first.
    expect(wrapper.text()).toContain('comment body 1');
    expect(wrapper.text()).not.toContain('comment body 40');

    const renderedBefore = stateMock.renderMarkdown.mock.calls.length;
    expect(renderedBefore).toBe(BATCH);

    // Flip to newest first: the window now holds entries 40..16, which the
    // watcher on `props.comments`/`visibleCommentCount` never saw change.
    (wrapper.vm as unknown as { toggleSortOrder: () => void }).toggleSortOrder();
    await nextTick();
    await drainRenders();

    // The newly visible rows were queued for a render…
    expect(stateMock.renderMarkdown.mock.calls.length).toBeGreaterThan(renderedBefore);
    // …and the newest entry is on screen.
    expect(wrapper.text()).toContain('comment body 40');
  });

  it('does not claim a rendered comment has no description after the flip', async () => {
    const wrapper = mountTimeline(40);
    await drainRenders();

    (wrapper.vm as unknown as { toggleSortOrder: () => void }).toggleSortOrder();
    await nextTick();
    await drainRenders();

    // Every visible row has a body, so none may show the empty state.
    expect(wrapper.text()).not.toContain('No description provided.');
    wrapper.unmount();
  });
});
