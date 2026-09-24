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

const comment: ForgejoTimelineComment = {
  id: 7,
  type: 'comment',
  // The same body in two repositories: `#123`, `@user` and relative links in it
  // resolve against the repository the comment was written in, so it is not the
  // same render.
  body: 'see #123 for the details',
  created_at: '2026-01-01T00:00:00Z',
  user: {
    id: 1,
    login: 'demo-user',
    full_name: 'Demo User',
    email: 'demo-user@forgejo.example.com',
    avatar_url: 'https://forgejo.example.com/avatars/demo-user',
  },
};

function mountTimeline(repo: string) {
  return mount(CommentTimeline, {
    props: { comments: [comment], instanceId: 'inst-1', owner: 'owner', repo, index: 1 },
    global: {
      plugins: [createTestI18n('en')],
      stubs: { EasyMdeEditor: true },
    },
  });
}

/**
 * The timeline rendered comment bodies without the repository context every
 * other render site passes (`IssueDetail`, `PullRequestDetail`, `EasyMdeEditor`),
 * so `#123`, `@user` and relative links in a comment stayed plain text — and,
 * with the render cache keyed by the context as well, two repositories' identical
 * comment text would have shared one rendered entry the moment the context was
 * added at only one call site.
 */
describe('CommentTimeline comment render context', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    stateMock.loading.clear();
    stateMock.errors.clear();
    stateMock.commentReactions.value.clear();
    stateMock.renderMarkdown.mockImplementation(
      async (_instanceId: string, text: string, _context?: string) => `<p>${text}</p>`,
    );
  });

  it('renders a comment body with its repository as the markdown context', async () => {
    const wrapper = mountTimeline('repoA');
    await flushPromises();

    expect(stateMock.renderMarkdown).toHaveBeenCalledWith('inst-1', comment.body, 'owner/repoA');
    wrapper.unmount();
  });

  it('keeps two repositories with identical comment text in separate renders', async () => {
    const first = mountTimeline('repoA');
    await flushPromises();
    const second = mountTimeline('repoB');
    await flushPromises();

    const contexts = stateMock.renderMarkdown.mock.calls.map((call) => call[2]);
    expect(contexts).toEqual(['owner/repoA', 'owner/repoB']);

    first.unmount();
    second.unmount();
  });
});
