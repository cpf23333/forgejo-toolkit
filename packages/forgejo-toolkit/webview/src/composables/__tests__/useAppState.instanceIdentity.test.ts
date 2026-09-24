import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { nextTick } from 'vue';
import { createTestRouter, createTestI18n } from '../../__tests__/helpers/test-utils';

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
  return { wrapper, state: wrapper.vm.state as ReturnType<typeof mod.useAppState> };
}

type AppState =
  ReturnType<typeof createState> extends Promise<infer T> ? (T extends { state: infer S } ? S : never) : never;

const INSTANCE_A = {
  id: 'inst-a',
  url: 'https://forgejo.example.com/alpha',
  name: 'alpha-user@forgejo.example.com',
  username: 'alpha-user',
};

function seedInstanceData(state: AppState) {
  state.repositories.value.set(INSTANCE_A.id, [{ id: 1, name: 'repo' }] as never);
  state.myIssues.value.set(INSTANCE_A.id, [{ id: 1, number: 1 }] as never);
  state.myPullRequests.value.set(INSTANCE_A.id, [{ id: 1, index: 1 }] as never);
  state.repoDetails.value.set(`${INSTANCE_A.id}:owner/repo`, { repository: { name: 'repo' } } as never);
  state.issueDetails.value.set(`${INSTANCE_A.id}:owner/repo#issue-1`, { number: 1 } as never);
  state.repoContents.value.set(`${INSTANCE_A.id}:owner/repo:ref:main:`, [] as never);
  state.actionRuns.value.set(`${INSTANCE_A.id}:owner/repo:actions`, [] as never);
  state.notifications.value.set(`${INSTANCE_A.id}:notifications`, [{ id: 1, unread: true }] as never);
  state.polledNotifications.value.set(INSTANCE_A.id, [{ id: 1, unread: true }] as never);
  state.userStopwatches.value.set(`${INSTANCE_A.id}:user-stopwatches`, [] as never);
  state.globalSearchResults.value.set(`${INSTANCE_A.id}:global-search:all:all:query`, [] as never);
  state.loading.set(`${INSTANCE_A.id}:owner/repo:actions`, true);
  state.errors.set(`${INSTANCE_A.id}:owner/repo:actions`, 'boom');
  state.repositoriesCache.set(INSTANCE_A.id, [{ id: 1, name: 'repo' }] as never);
  state.myIssuesCache.set(`${INSTANCE_A.id}:open`, [] as never);
  // The repo-scoped lists carry a "fetched at" mark that guards them from
  // being refetched; it is part of the payload pair `clearInstancePayloads`
  // has to drop.
  state.repoIssues.value.set(`${INSTANCE_A.id}:owner/repo:issues:open`, [] as never);
  state.repoIssuesFetchedAt.set(`${INSTANCE_A.id}:owner/repo:issues:open`, Date.now());
}

/**
 * An instance edit keeps the id: without dropping what is cached under it, the
 * repositories, issues, files and runs of the account/server the user just
 * replaced stay on screen, because every payload is keyed by that id and the
 * host sends the same list with only the changed fields.
 */
describe('useAppState instance identity changes', () => {
  it('drops the cached payloads of an instance whose url changed', async () => {
    const { state } = await createState();
    dispatchMessage({ command: 'instances', data: [INSTANCE_A] });
    await nextTick();
    seedInstanceData(state);

    dispatchMessage({
      command: 'instances',
      data: [{ ...INSTANCE_A, url: 'https://forgejo.example.com/beta' }],
    });
    await nextTick();

    expect(state.repositories.value.has(INSTANCE_A.id)).toBe(false);
    expect(state.myIssues.value.has(INSTANCE_A.id)).toBe(false);
    expect(state.myPullRequests.value.has(INSTANCE_A.id)).toBe(false);
    expect(state.repoDetails.value.has(`${INSTANCE_A.id}:owner/repo`)).toBe(false);
    expect(state.issueDetails.value.has(`${INSTANCE_A.id}:owner/repo#issue-1`)).toBe(false);
    expect(state.repoContents.value.has(`${INSTANCE_A.id}:owner/repo:ref:main:`)).toBe(false);
    expect(state.actionRuns.value.has(`${INSTANCE_A.id}:owner/repo:actions`)).toBe(false);
    expect(state.notifications.value.has(`${INSTANCE_A.id}:notifications`)).toBe(false);
    expect(state.polledNotifications.value.has(INSTANCE_A.id)).toBe(false);
    expect(state.userStopwatches.value.has(`${INSTANCE_A.id}:user-stopwatches`)).toBe(false);
    expect(state.globalSearchResults.value.has(`${INSTANCE_A.id}:global-search:all:all:query`)).toBe(false);
    // The TTL caches behind those payloads go too, or the next visit would be a
    // cache hit whose payload was just dropped.
    expect(state.repositoriesCache.has(INSTANCE_A.id)).toBe(false);
    expect(state.myIssuesCache.has(`${INSTANCE_A.id}:open`)).toBe(false);
    // The repo list marks guard their refetch, so a mark left behind would keep
    // serving the replaced server's list as fresh.
    expect(state.repoIssuesFetchedAt.has(`${INSTANCE_A.id}:owner/repo:issues:open`)).toBe(false);
    // A stale spinner/error for the replaced server would otherwise stick.
    expect(state.loading.has(`${INSTANCE_A.id}:owner/repo:actions`)).toBe(false);
    expect(state.errors.has(`${INSTANCE_A.id}:owner/repo:actions`)).toBe(false);
    // The new list is what the view shows.
    expect(state.instances.value[0].url).toBe('https://forgejo.example.com/beta');
  });

  it('drops the cached payloads when the account behind the same url changed', async () => {
    const { state } = await createState();
    dispatchMessage({ command: 'instances', data: [INSTANCE_A] });
    await nextTick();
    seedInstanceData(state);

    // Same server, different token: the host revalidates and reports the new
    // account, which is the only identity the webview ever sees for the token.
    dispatchMessage({
      command: 'instances',
      data: [{ ...INSTANCE_A, username: 'beta-user', name: 'beta-user@forgejo.example.com' }],
    });
    await nextTick();

    expect(state.repositories.value.has(INSTANCE_A.id)).toBe(false);
    expect(state.issueDetails.value.has(`${INSTANCE_A.id}:owner/repo#issue-1`)).toBe(false);
    expect(state.notifications.value.has(`${INSTANCE_A.id}:notifications`)).toBe(false);
  });

  it('keeps the payloads when the list is re-sent unchanged', async () => {
    const { state } = await createState();
    dispatchMessage({ command: 'instances', data: [INSTANCE_A] });
    await nextTick();
    seedInstanceData(state);

    dispatchMessage({ command: 'instances', data: [{ ...INSTANCE_A }] });
    await nextTick();

    // A plain refresh of the list must not blank the dashboard.
    expect(state.repositories.value.get(INSTANCE_A.id)).toHaveLength(1);
    expect(state.issueDetails.value.has(`${INSTANCE_A.id}:owner/repo#issue-1`)).toBe(true);
    expect(state.notifications.value.get(`${INSTANCE_A.id}:notifications`)).toHaveLength(1);
  });

  it('leaves another instance untouched', async () => {
    const other = {
      id: 'inst-b',
      url: 'https://forgejo.example.com/other',
      name: 'other-user@forgejo.example.com',
      username: 'other-user',
    };
    const { state } = await createState();
    dispatchMessage({ command: 'instances', data: [INSTANCE_A, other] });
    await nextTick();
    seedInstanceData(state);
    state.repositories.value.set(other.id, [{ id: 9, name: 'kept' }] as never);
    state.issueDetails.value.set(`${other.id}:owner/repo#issue-1`, { number: 1 } as never);

    dispatchMessage({
      command: 'instances',
      data: [{ ...INSTANCE_A, url: 'https://forgejo.example.com/beta' }, other],
    });
    await nextTick();

    expect(state.repositories.value.get(other.id)).toHaveLength(1);
    expect(state.issueDetails.value.has(`${other.id}:owner/repo#issue-1`)).toBe(true);
  });

  it('does not drop payloads when an instance is added for the first time', async () => {
    const { state } = await createState();
    dispatchMessage({ command: 'instances', data: [] });
    await nextTick();
    seedInstanceData(state);
    // Seeded before the instance was known: an add has no previous identity to
    // compare against, so nothing is reported as changed here.
    dispatchMessage({ command: 'instances', data: [INSTANCE_A] });
    await nextTick();

    expect(state.repositories.value.get(INSTANCE_A.id)).toHaveLength(1);
  });
});

/**
 * The repo-scoped issue/PR lists are guarded by a "fetched at" mark: the loader
 * serves the list while the mark is fresh and only refetches once both are
 * gone. Dropping the list without its mark therefore leaves a fresh mark with
 * no list, and the loader keeps answering "fresh" for the rest of the mark's
 * TTL — the list the user just lost is never refetched.
 */
describe('useAppState instance payload clearing and repo list marks', () => {
  function listKey(instanceId: string, owner: string, repo: string): string {
    return `${instanceId}:${owner}/${repo}:issues:open`;
  }

  it('drops the repo list marks of a replaced instance, so its lists are refetched', async () => {
    const { state } = await createState();
    dispatchMessage({ command: 'instances', data: [INSTANCE_A] });
    await nextTick();
    seedInstanceData(state);
    const issuesKey = listKey(INSTANCE_A.id, 'owner', 'repo');
    vscodeApiMock.postMessage.mockClear();

    dispatchMessage({
      command: 'instances',
      data: [{ ...INSTANCE_A, url: 'https://forgejo.example.com/beta' }],
    });
    await nextTick();

    // Both halves of the pair are gone...
    expect(state.repoIssues.value.has(issuesKey)).toBe(false);
    expect(state.repoIssuesFetchedAt.has(issuesKey)).toBe(false);
    // ...so the next visit actually asks the server again.
    state.loadRepoIssues(INSTANCE_A.id, 'owner', 'repo', 'open');
    expect(vscodeApiMock.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        command: 'getRepoIssues',
        instanceId: INSTANCE_A.id,
        owner: 'owner',
        repo: 'repo',
      }),
    );
  });

  it('refetches a repo issue list whose mark was dropped with its payload', async () => {
    // The other direction: while both halves are present the loader answers from
    // the payload, and only the pair being gone makes it ask the server again.
    const { state } = await createState();
    const key = listKey(INSTANCE_A.id, 'owner', 'repo');
    state.repoIssues.value.set(key, [] as never);
    state.repoIssuesFetchedAt.set(key, Date.now());
    vscodeApiMock.postMessage.mockClear();

    state.loadRepoIssues(INSTANCE_A.id, 'owner', 'repo', 'open');
    expect(vscodeApiMock.postMessage).not.toHaveBeenCalled();

    // Dropping the mark alone already refetches; the payload alone does not.
    state.repoIssuesFetchedAt.delete(key);
    state.loadRepoIssues(INSTANCE_A.id, 'owner', 'repo', 'open');

    expect(vscodeApiMock.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ command: 'getRepoIssues', instanceId: INSTANCE_A.id, owner: 'owner', repo: 'repo' }),
    );
  });
});
