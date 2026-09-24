import { beforeEach, describe, expect, it, vi } from 'vitest';
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

function comment(body: string, id = 1): ForgejoTimelineComment {
  return {
    id,
    type: 'comment',
    body,
    created_at: '2026-01-01T00:00:00Z',
    user: {
      id: 1,
      login: 'demo-user',
      full_name: 'Demo User',
      email: 'demo-user@forgejo.example.com',
      avatar_url: 'https://forgejo.example.com/avatars/demo-user',
    },
  };
}

const BODY = '**bold**\n- item';

function mountTimeline(comments: ForgejoTimelineComment[]) {
  return mount(CommentTimeline, {
    props: { comments, instanceId: 'inst-1', owner: 'owner', repo: 'repo', index: 1 },
    global: {
      plugins: [createTestI18n('en')],
      // The real editor loads EasyMDE (and needs IntersectionObserver), which
      // this test does not exercise.
      stubs: { EasyMdeEditor: true },
    },
  });
}

/**
 * A markdown render the host rejects used to be stored as if the body itself
 * were its rendered HTML, and the `finally` recorded that body as the rendered
 * source. Every later pass then matched the "already rendered" test, so the row
 * showed `**bold**` / `- item` literally, with no error line, for the rest of the
 * session: a refresh reloads the same bodies, the stale cache still matched, and
 * only a remount cleared it.
 */
describe('CommentTimeline markdown render failures', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    stateMock.loading.clear();
    stateMock.errors.clear();
    stateMock.commentReactions.value.clear();
  });

  it('shows the failure notice and the body as written instead of a rendered body', async () => {
    stateMock.renderMarkdown.mockRejectedValue(new Error('render failed'));

    const wrapper = mountTimeline([comment(BODY)]);
    await flushPromises();

    expect(stateMock.renderMarkdown).toHaveBeenCalledWith('inst-1', BODY);

    const failed = wrapper.find('.comment-body-render-failed');
    expect(failed.exists()).toBe(true);
    // The reason is reported in the entry itself, not only to the console.
    expect(failed.find('.render-failed-notice').text()).toContain('could not be formatted');
    expect(failed.find('.render-failed-notice').text()).toContain('render failed');
    // The body is shown as written, explicitly labelled, never as the rendered
    // form: no markdown body was mounted for this row.
    expect(failed.find('.render-failed-source').text()).toContain('**bold**');
    expect(wrapper.find('.markdown-content').exists()).toBe(false);
    expect(wrapper.find('.comment-body .loading').exists()).toBe(false);

    wrapper.unmount();
  });

  it('does not record a failed render as the body’s rendered form, so the next refresh asks again', async () => {
    stateMock.renderMarkdown.mockRejectedValue(new Error('render failed'));

    const wrapper = mountTimeline([comment(BODY)]);
    await flushPromises();
    expect(stateMock.renderMarkdown).toHaveBeenCalledTimes(1);
    expect(wrapper.find('.comment-body-render-failed').exists()).toBe(true);

    // A refresh reloads the same bodies into a new array. If the failure had been
    // cached as that source's rendered form, the row would be skipped here and
    // the raw markdown would stay for the session.
    stateMock.renderMarkdown.mockResolvedValue('<p>rendered</p>');
    await wrapper.setProps({ comments: [comment(BODY)] });
    await flushPromises();

    expect(stateMock.renderMarkdown).toHaveBeenCalledTimes(2);
    expect(wrapper.find('.comment-body-render-failed').exists()).toBe(false);
    expect(wrapper.find('.markdown-content').text()).toContain('rendered');

    wrapper.unmount();
  });

  it('re-requests the render from the entry’s Retry button', async () => {
    stateMock.renderMarkdown.mockRejectedValueOnce(new Error('render failed'));

    const wrapper = mountTimeline([comment(BODY)]);
    await flushPromises();
    expect(stateMock.renderMarkdown).toHaveBeenCalledTimes(1);

    // The next attempt succeeds: the row leaves the failed state behind and shows
    // the rendered body.
    stateMock.renderMarkdown.mockResolvedValue('<p>rendered</p>');
    await wrapper.find('.render-failed-notice vscode-button').trigger('click');
    await nextTick();
    await flushPromises();

    expect(stateMock.renderMarkdown).toHaveBeenCalledTimes(2);
    expect(wrapper.find('.comment-body-render-failed').exists()).toBe(false);
    expect(wrapper.find('.markdown-content').text()).toContain('rendered');

    wrapper.unmount();
  });

  it('keeps the notice off a row whose body changed after the failure', async () => {
    // The comment keeps its id across edits: the notice of the failed body must
    // not label the new body as failed.
    stateMock.renderMarkdown.mockRejectedValueOnce(new Error('render failed')).mockResolvedValue('<p>new</p>');

    const wrapper = mountTimeline([comment(BODY)]);
    await flushPromises();
    expect(wrapper.find('.comment-body-render-failed').exists()).toBe(true);

    await wrapper.setProps({ comments: [comment('a new body')] });
    await flushPromises();

    expect(wrapper.find('.comment-body-render-failed').exists()).toBe(false);
    expect(wrapper.find('.markdown-content').text()).toContain('new');

    wrapper.unmount();
  });
});
