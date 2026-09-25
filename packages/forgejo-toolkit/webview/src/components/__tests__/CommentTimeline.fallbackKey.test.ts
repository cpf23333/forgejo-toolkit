import { describe, expect, it, vi, beforeEach } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';

const { stateMock } = vi.hoisted(() => ({
  stateMock: {
    loading: new Map<string, boolean>(),
    errors: new Map<string, string>(),
    commentReactions: { value: new Map<string, unknown[]>() },
    instances: { value: [{ id: 'inst-1', url: 'https://forgejo.example.com', username: 'demo-user' }] },
    loadCommentReactions: vi.fn(),
    renderMarkdown: vi.fn(async (_instanceId: string, text: string, _context?: string) => `<p>${text}</p>`),
    openExternal: vi.fn(),
    deleteIssueComment: vi.fn(),
    editIssueComment: vi.fn(),
    uploadIssueCommentAttachment: vi.fn(),
    deleteIssueCommentAttachment: vi.fn(),
    showConfirm: vi.fn(async () => true),
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
 * Timeline events without an id fall back to a `type-created_at-login` key. Two
 * events of the same type in the same second by the same user shared that key:
 * Vue warned about the duplicate `v-for` key, and the rendered-body cache (keyed
 * by the same string) let one event's body label the other's row. The fallback
 * key now carries the event's position in the (append-only) timeline.
 */
describe('CommentTimeline fallback keys for id-less events', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    stateMock.loading.clear();
    stateMock.errors.clear();
    stateMock.commentReactions.value.clear();
  });

  it('renders two same-second id-less events as separate rows with their own bodies', async () => {
    const user = { id: 1, login: 'demo-user' } as ForgejoTimelineComment['user'];
    const first: ForgejoTimelineComment = {
      type: 'comment',
      body: 'first body',
      created_at: '2026-01-01T00:00:00Z',
      user,
    };
    const second: ForgejoTimelineComment = {
      type: 'comment',
      body: 'second body',
      created_at: '2026-01-01T00:00:00Z',
      user,
    };

    const wrapper = mount(CommentTimeline, {
      props: { comments: [first, second], instanceId: 'inst-1', owner: 'owner', repo: 'repo', index: 1 },
      global: {
        plugins: [createTestI18n('en')],
        stubs: { EasyMdeEditor: true },
      },
    });
    await flushPromises();

    const rows = wrapper.findAll('.timeline-item');
    expect(rows).toHaveLength(2);
    expect(rows[0].text()).toContain('first body');
    expect(rows[1].text()).toContain('second body');
    wrapper.unmount();
  });
});
