import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { nextTick } from 'vue';
import RepoActions from '../RepoActions.vue';
import { useAppState, actionRunsKey } from '../../composables/useAppState';
import { vscode } from '../../composables/vscode';
import { createTestRouter, createTestI18n } from '../../__tests__/helpers/test-utils';
import type { ForgejoActionRun } from '../../types/api';

// The component is mounted with the real composable so page replies flow
// through useAppState exactly as they do in the webview. useAppState is a
// module-level singleton, so the window listener registers on the first mount
// and every test below uses a distinct repo key to keep the lists apart.
let messageHandlers: Array<(event: MessageEvent) => void> = [];
let listenerInstalled = false;

const postMessageMock = vscode.postMessage as unknown as {
  mock: { calls: Array<[Record<string, unknown>]> };
  mockClear: () => void;
};

function postedMessages(): Array<Record<string, unknown>> {
  return postMessageMock.mock.calls.map((call) => call[0]);
}

beforeEach(() => {
  postMessageMock.mockClear();
  if (!listenerInstalled) {
    vi.spyOn(window, 'addEventListener').mockImplementation((type, listener) => {
      if (type === 'message') {
        messageHandlers.push(listener as (event: MessageEvent) => void);
      }
    });
    listenerInstalled = true;
  }
});

afterEach(() => {
  vi.restoreAllMocks();
});

function dispatchMessage(message: unknown) {
  const event = new MessageEvent('message', { data: message });
  messageHandlers.forEach((handler) => handler(event));
}

function runPage(firstId: number, count: number): ForgejoActionRun[] {
  return Array.from({ length: count }, (_, index) => ({
    id: firstId + index,
    title: `Run ${firstId + index}`,
    status: 'success',
  }));
}

function mountActions(repo: string) {
  return mount(RepoActions, {
    props: { instanceId: 'inst-1', owner: 'owner', repo },
    global: { plugins: [createTestRouter(), createTestI18n('en')] },
  });
}

function pageReply(repo: string, page: number, actionRuns: ForgejoActionRun[], totalCount: number) {
  return { command: 'actionRuns', instanceId: 'inst-1', owner: 'owner', repo, page, actionRuns, totalCount };
}

function lastRequestOf(command: string) {
  return [...postedMessages()].reverse().find((message) => message.command === command);
}

function loadMoreButton(wrapper: ReturnType<typeof mountActions>) {
  return wrapper.findAll('vscode-button').find((candidate) => candidate.text().includes('Load more'));
}

describe('RepoActions pagination', () => {
  it('appends the next page and hides Load more once a short page ends the list', async () => {
    const repo = 'repo';
    const wrapper = mountActions(repo);
    await flushPromises();

    expect(lastRequestOf('getActionRuns')).toMatchObject({ page: 1, limit: 30 });

    dispatchMessage(pageReply(repo, 1, runPage(1, 30), 35));
    await nextTick();

    expect(wrapper.findAll('.action-run-item')).toHaveLength(30);
    const loadMore = loadMoreButton(wrapper);
    expect(loadMore).toBeTruthy();

    await loadMore!.trigger('click');
    expect(lastRequestOf('getActionRuns')).toMatchObject({ page: 2, limit: 30 });

    // Page 2 is shorter than the requested page size: the list ends here.
    dispatchMessage(pageReply(repo, 2, runPage(31, 5), 35));
    await nextTick();

    // Both pages are on screen, in server order, and "Load more" is gone.
    const items = wrapper.findAll('.action-run-item');
    expect(items).toHaveLength(35);
    expect(items[0].text()).toContain('Run 1');
    expect(items[34].text()).toContain('Run 35');
    expect(loadMoreButton(wrapper)).toBeUndefined();
  });

  it('keeps the loaded runs and hides Load more when a page past the end is empty', async () => {
    const repo = 'past-the-end';
    const wrapper = mountActions(repo);
    await flushPromises();

    dispatchMessage(pageReply(repo, 1, runPage(1, 30), 31));
    await nextTick();

    const loadMore = loadMoreButton(wrapper);
    expect(loadMore).toBeTruthy();
    await loadMore!.trigger('click');
    expect(lastRequestOf('getActionRuns')).toMatchObject({ page: 2 });

    // The server has no second page: the empty reply must not wipe page 1.
    dispatchMessage(pageReply(repo, 2, [], 31));
    await nextTick();

    expect(wrapper.findAll('.action-run-item')).toHaveLength(30);
    expect(wrapper.text()).not.toContain('No action runs.');
    expect(loadMoreButton(wrapper)).toBeUndefined();

    const state = useAppState();
    expect(state.actionRuns.value.get(actionRunsKey('inst-1', 'owner', repo))).toHaveLength(30);
    expect(state.actionRunsHasMore.value.get(actionRunsKey('inst-1', 'owner', repo))).toBe(false);
  });

  it('restarts the list at page 1 when the list is reloaded', async () => {
    const repo = 'refresh';
    const wrapper = mountActions(repo);
    await flushPromises();

    dispatchMessage(pageReply(repo, 1, runPage(1, 30), 60));
    await nextTick();
    await loadMoreButton(wrapper)!.trigger('click');
    dispatchMessage(pageReply(repo, 2, runPage(31, 30), 60));
    await nextTick();
    expect(wrapper.findAll('.action-run-item')).toHaveLength(60);

    // A reload asks for page 1 again and replaces the accumulated pages.
    postMessageMock.mockClear();
    useAppState().loadActionRuns('inst-1', 'owner', repo, 1, true);
    expect(lastRequestOf('getActionRuns')).toMatchObject({ page: 1 });

    dispatchMessage(pageReply(repo, 1, runPage(1, 3), 3));
    await nextTick();
    expect(wrapper.findAll('.action-run-item')).toHaveLength(3);
  });

  it('advances the page counter when the server returns fewer rows than requested', async () => {
    // A server-side `[api] MaxResponseItems` below 30 returns short pages that
    // are not the end of the list: the next page must come from the loaded-page
    // counter, not from `rows / pageSize` (which would re-request page 1).
    const repo = 'clamped';
    const wrapper = mountActions(repo);
    await flushPromises();

    dispatchMessage(pageReply(repo, 1, runPage(1, 10), 25));
    await nextTick();
    expect(wrapper.findAll('.action-run-item')).toHaveLength(10);

    postMessageMock.mockClear();
    await loadMoreButton(wrapper)!.trigger('click');
    expect(lastRequestOf('getActionRuns')).toMatchObject({ page: 2 });

    dispatchMessage(pageReply(repo, 2, runPage(11, 10), 25));
    await nextTick();
    expect(wrapper.findAll('.action-run-item')).toHaveLength(20);

    postMessageMock.mockClear();
    await loadMoreButton(wrapper)!.trigger('click');
    expect(lastRequestOf('getActionRuns')).toMatchObject({ page: 3 });

    // The last page is short but the counter keeps the list complete.
    dispatchMessage(pageReply(repo, 3, runPage(21, 5), 25));
    await nextTick();
    expect(wrapper.findAll('.action-run-item')).toHaveLength(25);
    expect(loadMoreButton(wrapper)).toBeUndefined();
  });

  it('drops a late reply for a page that no longer follows the loaded ones', async () => {
    const repo = 'out-of-order';
    const wrapper = mountActions(repo);
    await flushPromises();

    dispatchMessage(pageReply(repo, 1, runPage(1, 30), 90));
    await nextTick();
    await loadMoreButton(wrapper)!.trigger('click');
    expect(lastRequestOf('getActionRuns')).toMatchObject({ page: 2 });

    // A page-3 reply arrives before page 2 (duplicate/late response): its rows
    // must not be appended, or page 2 would be skipped.
    dispatchMessage(pageReply(repo, 3, runPage(61, 30), 90));
    await nextTick();
    expect(wrapper.findAll('.action-run-item')).toHaveLength(30);

    // The following page still loads, and the gap is filled in order.
    dispatchMessage(pageReply(repo, 2, runPage(31, 30), 90));
    await nextTick();
    const items = wrapper.findAll('.action-run-item');
    expect(items).toHaveLength(60);
    expect(items[30].text()).toContain('Run 31');
  });
});
