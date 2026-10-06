import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { createTestRouter, createTestI18n } from '../../__tests__/helpers/test-utils';

/**
 * A pull request detail page re-reading itself on the host's refresh.
 *
 * The review's first complaint was that the sidebar's refresh icon refreshed the
 * instance list while the reader was looking at one pull request. This is that
 * page's half of the fix: the one `refreshData` the host posts reaches the view
 * the route shows, and the view re-issues the loads it issues for itself — the
 * pull request first, then the files, timeline and commits whose diff range only
 * its own payload names.
 *
 * The cache is warmed by the host's reply before the refresh, which is what makes
 * the assertion meaningful: a load that was not forced would be answered from the
 * five-second cache and never reach the host at all.
 */
let messageHandlers: Array<(event: MessageEvent) => void> = [];
let vscodeApiMock: {
  postMessage: ReturnType<typeof vi.fn>;
  getState: ReturnType<typeof vi.fn>;
  setState: ReturnType<typeof vi.fn>;
};

beforeEach(() => {
  messageHandlers = [];
  vscodeApiMock = {
    postMessage: vi.fn(),
    getState: vi.fn(() => undefined),
    setState: vi.fn(),
  };
  (window as unknown as { acquireVsCodeApi: () => typeof vscodeApiMock }).acquireVsCodeApi = () => vscodeApiMock;
  vi.spyOn(window, 'addEventListener').mockImplementation((type, listener) => {
    if (type === 'message') {
      messageHandlers.push(listener as (event: MessageEvent) => void);
    }
  });
});

afterEach(() => {
  messageHandlers = [];
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

function dispatchMessage(message: unknown) {
  const event = new MessageEvent('message', { data: message });
  messageHandlers.forEach((handler) => handler(event));
}

function postedMessages(): Array<Record<string, unknown>> {
  return vscodeApiMock.postMessage.mock.calls.map(([message]) => message as Record<string, unknown>);
}

const INDEX = 5;

const detailPayload = {
  number: INDEX,
  title: `PR ${INDEX}`,
  state: 'open',
  user: { login: 'demo-user' },
  repository: { full_name: 'owner/repo' },
  base: { sha: 'base-sha' },
  head: { sha: 'head-sha' },
  merge_base: 'merge-base-sha',
  labels: [],
  assignees: [],
  assets: [],
};

/**
 * The page on its own route, over a fresh module graph: `useAppState` is a
 * module-level singleton whose router is the one its first caller saw, so the
 * route has to be in place before the view (and with it the state) mounts.
 */
async function mountPullRequestDetail() {
  vi.resetModules();
  const { appRouterKey } = await import('../../composables/useAppRouter');
  const router = createTestRouter();
  await router.push({
    name: 'pullRequestDetail',
    params: { instanceId: 'inst-1', owner: 'owner', repo: 'repo', index: String(INDEX) },
  });
  const PullRequestDetail = (await import('../PullRequestDetail.vue')).default;
  const wrapper = mount(PullRequestDetail, {
    global: {
      // The dashboard's entry provides this key (`src/main.ts`); without it the
      // composable behaves like a standalone panel, which has no route.
      plugins: [router, createTestI18n('en')],
      provide: { [appRouterKey]: router },
      stubs: {
        AttachmentList: true,
        CollapsibleSection: true,
        CommentTimeline: true,
        CommitDiffList: true,
        DateTimePicker: true,
        DiffFileList: true,
        EasyMdeEditor: true,
        MarkdownBody: true,
        ModalDialog: true,
        PendingAttachmentList: true,
        PullRequestForm: true,
        ReactionBar: true,
      },
    },
  });
  await flushPromises();
  return { wrapper, router };
}

describe('the pull request detail page refreshes itself', () => {
  it('re-reads the pull request and the sections keyed by its diff range', async () => {
    const { wrapper } = await mountPullRequestDetail();
    // The host answers everything the page asked for on the way in. A settled
    // page is what makes the assertion below meaningful twice over: a load that
    // was not forced would be answered from the five-second cache, and a request
    // still in flight would make the loader dedupe instead of re-reading.
    dispatchMessage({
      command: 'pullRequestDetail',
      instanceId: 'inst-1',
      owner: 'owner',
      repo: 'repo',
      index: INDEX,
      detail: detailPayload,
    });
    dispatchMessage({
      command: 'pullRequestFiles',
      instanceId: 'inst-1',
      owner: 'owner',
      repo: 'repo',
      index: INDEX,
      baseSha: 'merge-base-sha',
      headSha: 'head-sha',
      files: [],
    });
    dispatchMessage({
      command: 'pullRequestCommentsAndTimeline',
      instanceId: 'inst-1',
      owner: 'owner',
      repo: 'repo',
      index: INDEX,
      comments: [],
    });
    dispatchMessage({
      command: 'pullRequestCommits',
      instanceId: 'inst-1',
      owner: 'owner',
      repo: 'repo',
      index: INDEX,
      commits: [],
    });
    await flushPromises();
    vscodeApiMock.postMessage.mockClear();

    dispatchMessage({ command: 'refreshData' });
    await flushPromises();

    expect(postedMessages()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          command: 'getPullRequestDetail',
          instanceId: 'inst-1',
          owner: 'owner',
          repo: 'repo',
          index: INDEX,
        }),
        // The three the payload's diff range keys.
        expect.objectContaining({
          command: 'getPullRequestFiles',
          baseSha: 'merge-base-sha',
          headSha: 'head-sha',
        }),
        expect.objectContaining({ command: 'getPullRequestCommentsAndTimeline', index: INDEX }),
        expect.objectContaining({ command: 'getPullRequestCommits', index: INDEX }),
      ]),
    );
    // And it is the page's own data, not the dashboard's: the instance-level
    // reload the old refresh ran would blank the pull request instead.
    expect(postedMessages().map((message) => message.command)).not.toContain('getRepositories');
    wrapper.unmount();
  });
});
