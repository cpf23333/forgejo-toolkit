import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { nextTick } from 'vue';
import { createTestRouter, createTestI18n } from '../../__tests__/helpers/test-utils';
import type { ForgejoIssue } from '../../types/api';

/**
 * An explicit refresh (`refreshData`) against a repository issue/PR list whose
 * request is still in flight.
 *
 * The refresh drops the payload and its "fetched at" mark and re-issues the
 * load, but the loader dedupes against the request it already has in flight
 * (`loading.get(key)`), so the older request cannot be cancelled and its reply
 * lands *after* the refresh. That reply is the pre-refresh answer, yet it used
 * to be written into the payload slot with a fresh mark — which made the next
 * `loadRepoIssues` see a fresh list, return without refetching, and leave the
 * user's refresh silently unanswered for the rest of `REPO_LIST_MARKS_TTL_MS`.
 * The store therefore has to remember that a key was refreshed and drop the
 * late reply instead of treating it as the refreshed answer.
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

async function createState() {
  vi.resetModules();
  const mod = await import('../../composables/useAppState');
  const router = createTestRouter();
  const i18n = createTestI18n();
  const wrapper = mount(
    {
      template: '<div></div>',
      setup() {
        const state = mod.useAppState();
        return { state };
      },
    },
    {
      global: {
        plugins: [router, i18n],
      },
    },
  );
  await flushPromises();
  return { state: wrapper.vm.state as ReturnType<typeof mod.useAppState>, mod };
}

const INSTANCE = {
  id: 'inst-1',
  url: 'https://forgejo.example.com',
  name: 'user@forgejo.example.com',
  username: 'user',
};

function issue(number: number, title: string): ForgejoIssue {
  return {
    id: number,
    number,
    title,
    state: 'open',
    html_url: `https://forgejo.example.com/owner/repo/issues/${number}`,
    user: { id: 1, login: 'user', full_name: 'User', email: 'user@example.com', avatar_url: '' },
    body: 'body',
    created_at: '2024-01-01T00:00:00Z',
    updated_at: '2024-01-01T00:00:00Z',
  };
}

/** The `getRepoIssues` posts made so far, in order. */
function postedIssueRequests() {
  return vscodeApiMock.postMessage.mock.calls
    .map(([message]) => message as { command?: string })
    .filter((message) => message.command === 'getRepoIssues');
}

/** The `getRepoPullRequests` posts made so far, in order. */
function postedPullRequests() {
  return vscodeApiMock.postMessage.mock.calls
    .map(([message]) => message as { command?: string })
    .filter((message) => message.command === 'getRepoPullRequests');
}

describe('useAppState refresh over an in-flight repository list', () => {
  it('refetches a list whose pre-refresh reply was already in flight when the refresh was pressed', async () => {
    const { state, mod } = await createState();
    dispatchMessage({ command: 'instances', data: [INSTANCE] });
    await nextTick();
    const key = mod.repoIssuesKey(INSTANCE.id, 'owner', 'repo', 'open');
    // The list is on screen but its "fetched at" mark has lapsed, so opening it
    // again asks the host for it: a refetch is in flight when the user acts.
    state.repoIssues.value.set(key, [issue(1, 'stale')]);
    state.loadRepoIssues(INSTANCE.id, 'owner', 'repo', 'open');
    await nextTick();
    expect(postedIssueRequests()).toHaveLength(1);
    vscodeApiMock.postMessage.mockClear();

    // The user presses refresh while that refetch is in flight. The refresh
    // cannot cancel it; the loader dedupes against it and posts no request of
    // its own.
    dispatchMessage({ command: 'refreshData' });
    expect(postedIssueRequests()).toHaveLength(0);
    expect(state.repoIssues.value.has(key)).toBe(false);
    expect(state.repoIssuesFetchedAt.has(key)).toBe(false);

    // The reply to the pre-refresh request arrives. It carries the answer the
    // user just asked to replace, so it must not be applied as the refreshed
    // list: it is dropped and the refreshed load is issued right away.
    dispatchMessage({
      command: 'repoIssues',
      instanceId: INSTANCE.id,
      owner: 'owner',
      repo: 'repo',
      state: 'open',
      issues: [issue(1, 'stale')],
    });
    await nextTick();

    expect(state.repoIssues.value.has(key)).toBe(false);
    expect(state.repoIssuesFetchedAt.has(key)).toBe(false);
    expect(state.loading.get(key)).toBe(true);
    expect(postedIssueRequests()).toHaveLength(1);

    // The re-issued request answers with the refreshed list and is applied like
    // any other reply.
    dispatchMessage({
      command: 'repoIssues',
      instanceId: INSTANCE.id,
      owner: 'owner',
      repo: 'repo',
      state: 'open',
      issues: [issue(2, 'fresh')],
    });
    await nextTick();

    expect(state.repoIssues.value.get(key)?.map((row) => row.title)).toEqual(['fresh']);
    expect(state.repoIssuesFetchedAt.has(key)).toBe(true);
    expect(state.loading.get(key)).toBe(false);
    expect(postedIssueRequests()).toHaveLength(1);
  });

  it('refetches instead of serving the stale mark when the loader is asked again after the refresh', async () => {
    const { state, mod } = await createState();
    dispatchMessage({ command: 'instances', data: [INSTANCE] });
    await nextTick();
    const key = mod.repoIssuesKey(INSTANCE.id, 'owner', 'repo', 'open');
    state.repoIssues.value.set(key, [issue(1, 'stale')]);
    state.loadRepoIssues(INSTANCE.id, 'owner', 'repo', 'open');
    await nextTick();
    expect(postedIssueRequests()).toHaveLength(1);
    vscodeApiMock.postMessage.mockClear();

    dispatchMessage({ command: 'refreshData' });
    dispatchMessage({
      command: 'repoIssues',
      instanceId: INSTANCE.id,
      owner: 'owner',
      repo: 'repo',
      state: 'open',
      issues: [issue(1, 'stale')],
    });
    await nextTick();
    expect(postedIssueRequests()).toHaveLength(1);

    // The pre-refresh reply left neither a payload nor a fresh mark behind, so
    // asking for the list again does not answer "fresh" from the mark it wrote:
    // it finds the refreshed request still in flight and dedupes onto it instead
    // of leaving the list empty for the mark's TTL.
    state.loadRepoIssues(INSTANCE.id, 'owner', 'repo', 'open');
    await nextTick();

    expect(state.repoIssues.value.has(key)).toBe(false);
    expect(postedIssueRequests()).toHaveLength(1);
  });

  it('refetches the pull request lists an explicit refresh replayed', async () => {
    const { state, mod } = await createState();
    dispatchMessage({ command: 'instances', data: [INSTANCE] });
    await nextTick();
    const key = mod.repoPullRequestsKey(INSTANCE.id, 'owner', 'repo', 'open');
    state.repoPullRequests.value.set(key, [{ id: 1, index: 1, title: 'stale' }] as never);
    state.loadRepoPullRequests(INSTANCE.id, 'owner', 'repo', 'open');
    await nextTick();
    expect(postedPullRequests()).toHaveLength(1);
    vscodeApiMock.postMessage.mockClear();

    // Same interleaving as the issue list above: a request is already in flight
    // when the refresh replays the load, so the replay is deduped and the reply
    // that lands afterwards belongs to the pre-refresh request. The dashboard
    // lists the refresh force-reloads post too, so only this list's requests are
    // counted.
    dispatchMessage({ command: 'refreshData' });
    expect(postedPullRequests()).toHaveLength(0);

    dispatchMessage({
      command: 'repoPullRequests',
      instanceId: INSTANCE.id,
      owner: 'owner',
      repo: 'repo',
      state: 'open',
      pullRequests: [{ id: 1, index: 1, title: 'stale' }],
    });
    await nextTick();

    expect(state.repoPullRequests.value.has(key)).toBe(false);
    expect(state.loading.get(key)).toBe(true);
    expect(postedPullRequests()).toEqual([
      {
        command: 'getRepoPullRequests',
        instanceId: INSTANCE.id,
        owner: 'owner',
        repo: 'repo',
        state: 'open',
        query: undefined,
      },
    ]);
  });
});
