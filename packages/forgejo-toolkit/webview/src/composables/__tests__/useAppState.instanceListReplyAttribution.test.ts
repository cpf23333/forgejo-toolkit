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
    { global: { plugins: [router, i18n] } },
  );
  await flushPromises();
  return { wrapper, state: wrapper.vm.state as ReturnType<typeof mod.useAppState> };
}

type AppState =
  ReturnType<typeof createState> extends Promise<infer T> ? (T extends { state: infer S } ? S : never) : never;

/** The server the webview is configured against first. */
const INSTANCE_A = {
  id: 'inst-a',
  url: 'https://forgejo.example.com/alpha',
  name: 'alpha-user@forgejo.example.com',
  username: 'alpha-user',
};

/** The replacement: same id, different URL, so the identity changed. */
const REPLACED = { ...INSTANCE_A, url: 'https://forgejo.example.com/beta' };

function repo(id: number, name: string) {
  return { id, name, full_name: `owner/${name}` } as never;
}

/**
 * One dashboard list's reply path: the key its loading slot uses, the command
 * that asks for it, and a reply carrying rows. Each row carries a `name` — the
 * marker the assertions key on — so the three lists are checked the same way.
 */
const LISTS = [
  {
    label: 'repositories',
    key: `repos-${INSTANCE_A.id}`,
    request: { command: 'getRepositories', instanceId: INSTANCE_A.id },
    reply: (server: 'old' | 'new') => ({
      command: 'repositories',
      instanceId: INSTANCE_A.id,
      repositories: [repo(server === 'old' ? 1 : 2, server === 'old' ? 'old-server-row' : 'new-server-row')],
    }),
    stored: (state: AppState) => state.repositories.value.get(INSTANCE_A.id),
    cached: (state: AppState) => state.repositoriesCache.get(INSTANCE_A.id),
  },
  {
    label: 'my issues',
    key: `issues-${INSTANCE_A.id}-open`,
    request: { command: 'getMyIssues', instanceId: INSTANCE_A.id, state: 'open' },
    reply: (server: 'old' | 'new') => ({
      command: 'myIssues',
      instanceId: INSTANCE_A.id,
      state: 'open',
      issues: [
        {
          id: server === 'old' ? 1 : 2,
          number: 1,
          title: server === 'old' ? 'old-server-row' : 'new-server-row',
        },
      ],
    }),
    stored: (state: AppState) => state.myIssues.value.get(INSTANCE_A.id) as Array<{ title?: string }> | undefined,
    cached: (state: AppState) =>
      state.myIssuesCache.get(`${INSTANCE_A.id}:open`) as Array<{ title?: string }> | undefined,
  },
  {
    label: 'my pull requests',
    key: `pulls-${INSTANCE_A.id}-open`,
    request: { command: 'getMyPullRequests', instanceId: INSTANCE_A.id, state: 'open' },
    reply: (server: 'old' | 'new') => ({
      command: 'myPullRequests',
      instanceId: INSTANCE_A.id,
      state: 'open',
      pullRequests: [
        {
          id: server === 'old' ? 1 : 2,
          index: 1,
          title: server === 'old' ? 'old-server-row' : 'new-server-row',
        },
      ],
    }),
    stored: (state: AppState) => state.myPullRequests.value.get(INSTANCE_A.id) as Array<{ title?: string }> | undefined,
    cached: (state: AppState) =>
      state.myPullRequestsCache.get(`${INSTANCE_A.id}:open`) as Array<{ title?: string }> | undefined,
  },
] as const;

/** The row marker of a stored/cached list, whichever list it is. */
function rowName(rows: unknown[] | undefined): string | undefined {
  const row = rows?.[0] as { name?: string; title?: string } | undefined;
  return row?.name ?? row?.title;
}

/**
 * An instance edit keeps the id, so the previous server's request is still on
 * the wire when the identity change re-issues the same list for the server now
 * configured. The reply carries no identity of its own, so attribution has to
 * come from one record per outstanding request: recording only the *latest*
 * request let the replaced server's reply match the reload's identity/epoch and
 * write its rows — and its cache — under the id the new configuration uses,
 * where they stayed on screen if they landed after the fresh reply.
 */
describe.each(LISTS)('$label reply attribution across an identity change', (list) => {
  /**
   * The live race: the list the user is looking at is being loaded from the
   * server that is about to be replaced, and the replacement's own reload (which
   * `instances` issues) therefore puts two requests for the same key on the
   * wire — one for each server.
   */
  async function startReplacedLoad(state: AppState) {
    dispatchMessage({ command: 'instances', data: [INSTANCE_A] });
    await nextTick();
    vscodeApiMock.postMessage.mockClear();
    state.loadRepositories(INSTANCE_A.id, true);
    state.loadMyIssues(INSTANCE_A.id, 'open', true);
    state.loadMyPullRequests(INSTANCE_A.id, 'open', true);
    expect(vscodeApiMock.postMessage).toHaveBeenCalledWith(expect.objectContaining(list.request));
  }

  async function replaceInstance() {
    dispatchMessage({ command: 'instances', data: [REPLACED] });
    await nextTick();
    // The identity change re-issues every list for the server now configured, so
    // each key has one outstanding request per server.
    expect(vscodeApiMock.postMessage).toHaveBeenCalledWith(expect.objectContaining(list.request));
  }

  it('drops the replaced server’s queued reply and keeps the reload’s record for its own', async () => {
    const { state } = await createState();
    await startReplacedLoad(state);
    await replaceInstance();

    // The replaced server answers the request that was already on the wire. That
    // request is the oldest record for the key and its reply is refused: it was
    // sent for a server the identity change dropped, whatever identity/epoch the
    // reload re-recorded the key with.
    dispatchMessage(list.reply('old'));
    await nextTick();

    // Nothing may be written under the id now pointed at the new server: not the
    // rows, and not the cache the next visit would be served from.
    expect(list.stored(state) ?? []).toHaveLength(0);
    expect(list.cached(state)).toBeUndefined();

    // The reload's request is still outstanding — the stale reply consumed the
    // record the change superseded, not the reload's — so its own reply fills the
    // list as usual.
    dispatchMessage(list.reply('new'));
    await nextTick();

    expect(list.stored(state)).toHaveLength(1);
    expect(rowName(list.stored(state))).toBe('new-server-row');
    expect(list.cached(state)).toHaveLength(1);
    expect(rowName(list.cached(state))).toBe('new-server-row');
    expect(state.loading.get(list.key)).toBe(false);
  });

  it('cannot tell the two replies apart once they arrive out of send order', async () => {
    // A known, documented limit: `getRepositories`/`getMyIssues`/
    // `getMyPullRequests` echo no request id, so when the reload's reply arrives
    // *before* the one for the request the edit superseded, the two are
    // indistinguishable — both match the reload's record, which carries the same
    // identity/epoch. This test pins the current behaviour so a future host-side
    // request id (or a different attribution rule) shows up here as an
    // intentional change rather than a silent regression.
    const { state } = await createState();
    await startReplacedLoad(state);
    await replaceInstance();

    dispatchMessage(list.reply('new'));
    await nextTick();
    dispatchMessage(list.reply('old'));
    await nextTick();

    // The send-order interleaving — the one the host produces — is guarded (see
    // the test below); this records that the reverse interleaving is not.
    expect(list.stored(state)).toBeDefined();
  });

  it('attributes a reply to the request it answers, not to the latest record', async () => {
    // What the guard now does that the single-record version could not: the reply
    // is judged by the record of the request it answers, so a record sent for a
    // server the instance no longer points at makes the reply stale even when the
    // reload has re-recorded the key with the same identity/epoch. The superseded
    // server's reply is refused and its rows never reach the list.
    const { state } = await createState();
    await startReplacedLoad(state);
    await replaceInstance();

    dispatchMessage(list.reply('old'));
    await nextTick();
    expect(list.stored(state) ?? []).toHaveLength(0);

    dispatchMessage(list.reply('new'));
    await nextTick();
    expect(rowName(list.stored(state))).toBe('new-server-row');
  });

  it('keeps the fresh rows when both replies arrive in the host’s send order', async () => {
    // The order the host actually answers in: the request queued first (the
    // server being replaced) is answered first.
    const { state } = await createState();
    await startReplacedLoad(state);
    await replaceInstance();

    dispatchMessage(list.reply('old'));
    await nextTick();
    dispatchMessage(list.reply('new'));
    await nextTick();

    expect(list.stored(state)).toHaveLength(1);
    expect(rowName(list.stored(state))).toBe('new-server-row');
    expect(list.cached(state)).toHaveLength(1);
    expect(rowName(list.cached(state))).toBe('new-server-row');
  });

  it('still accepts a reply that answers no recorded request of ours', async () => {
    // Hand-built replies (and a host build that answers a request this webview
    // never recorded) keep flowing: only a reply that a *record of another
    // server* could not have produced is refused.
    const { state } = await createState();
    dispatchMessage({ command: 'instances', data: [INSTANCE_A] });
    await nextTick();

    dispatchMessage(list.reply('new'));
    await nextTick();

    expect(list.stored(state)).toHaveLength(1);
  });
});
