import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { http, HttpResponse } from 'msw';
import { ForgejoClient } from '../client';
import { mockServer, resetMockServer, startMockServer, stopMockServer } from '../../test/mocks/server';

/**
 * The wire format Kubb 5's serializer produces, compared against what the v4
 * pipeline produced for the same options.
 *
 * v4 built the query with the shared request layer's `buildUrl`; v5 builds it in
 * `packages/forgejo-api/src/generated/.kubb/serializers.ts`. The two agree on
 * every case the client actually sends — including `collectionFormat: multi`
 * arrays, which are the ones Forgejo depends on (see the notification filters in
 * `test/mocks/handlers.ts`) — and these tests pin that agreement at the wire
 * level, so a serializer change cannot silently alter a request the server
 * interprets.
 */
describe('query serialization parity', () => {
  beforeAll(() => {
    startMockServer();
  });

  afterAll(() => {
    stopMockServer();
  });

  afterEach(() => {
    resetMockServer();
  });

  /** Runs one request through the client and returns the search string it sent. */
  async function captureSearch(run: (client: ForgejoClient) => Promise<unknown>): Promise<string> {
    let search = '';
    mockServer.use(
      http.get('https://*/api/v1/notifications', ({ request }) => {
        search = new URL(request.url).search;
        return HttpResponse.json([]);
      }),
    );
    await run(new ForgejoClient('https://forgejo.example.com', 'mock-token'));
    return search;
  }

  it('repeats the key for a multi-valued parameter, like the Forgejo collectionFormat it declares', async () => {
    // The pinned snapshot declares `status-types` and `subject-type` as
    // `type: array, collectionFormat: multi`, and `buildUrl` repeated the key per
    // element for exactly that reason. A comma-joined value would be read by the
    // server as one unknown status type, i.e. an empty notification list.
    const search = await captureSearch((client) =>
      client.getNotifications(['unread', 'pinned'], ['issue', 'pull'], 50),
    );
    const params = new URLSearchParams(search);
    expect(params.getAll('status-types')).toEqual(['unread', 'pinned']);
    expect(params.getAll('subject-type')).toEqual(['issue', 'pull']);
    expect(params.get('limit')).toBe('50');
    expect(params.get('before')).toBeNull();
  });

  it('omits a key whose value is undefined rather than sending it empty', async () => {
    // `before` is the paging cursor and is absent on the first page. An empty
    // `before=` would be sent to the server as a cursor of ''.
    const search = await captureSearch((client) => client.getNotifications(['unread'], undefined, 50, undefined));
    expect(search).toContain('status-types=unread');
    expect(search).not.toContain('before');
    expect(search).not.toContain('subject-type');
  });

  it('keeps reserved characters encoded the same way the shared client did', async () => {
    let search = '';
    mockServer.use(
      http.get('https://*/api/v1/repos/search', ({ request }) => {
        search = new URL(request.url).search;
        return HttpResponse.json({ ok: true, data: [], total_count: 0 });
      }),
    );
    await new ForgejoClient('https://forgejo.example.com', 'mock-token').searchRepositories('release/1.0 x');
    // `URLSearchParams` encodes a space as `+` and `/` as `%2F`; both were the
    // v4 output for the same value, and both are what `buildUrl` produced.
    expect(search).toBe('?q=release%2F1.0+x&limit=20');
  });
});
