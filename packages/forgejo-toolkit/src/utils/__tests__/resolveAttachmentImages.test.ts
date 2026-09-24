import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { resolveAttachmentImages, clearResolvedImageCache } from '../resolveAttachmentImages';
import { logger } from '../../logger';
import type { ForgejoInstance } from '@cpf23333-forgejo-toolkit/shared/webview/messages';

function createInstance(): ForgejoInstance {
  return {
    id: 'demo',
    name: 'Demo',
    url: 'https://forgejo.example.com',
    token: 'mock-token',
    username: 'demo-user',
    syncApiUrlsToInstanceUrl: false,
  };
}

describe('resolveAttachmentImages', () => {
  beforeEach(() => {
    clearResolvedImageCache();
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url.includes('/attachments/') || url.includes('/attachment/')) {
          return {
            ok: true,
            headers: new Map([['content-type', 'image/png']]),
            arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer,
          } as unknown as Response;
        }
        return { ok: false, status: 404 } as unknown as Response;
      }),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('resolves global attachment URLs (/attachments/<uuid>)', async () => {
    const html = '<p><img src="/attachments/abc-123" alt="screenshot"></p>';
    const result = await resolveAttachmentImages(html, createInstance());
    expect(result).toContain('data:image/png;base64,');
    expect(result).not.toContain('/attachments/abc-123');
  });

  it('resolves repository attachment URLs (/<owner>/<repo>/attachment/<uuid>)', async () => {
    const html =
      '<p><img src="https://forgejo.example.com/demo-user/demo-repo/attachment/xyz-789" alt="screenshot"></p>';
    const result = await resolveAttachmentImages(html, createInstance());
    expect(result).toContain('data:image/png;base64,');
    expect(result).not.toContain('/attachment/xyz-789');
  });

  it('resolves repository attachment URLs (/<owner>/<repo>/attachments/<uuid>)', async () => {
    const html =
      '<p><img src="https://forgejo.example.com/demo-user/demo-repo/attachments/baf821ef-3e07-4a4b-9db7-4de3442b0d4c" alt="screenshot"></p>';
    const result = await resolveAttachmentImages(html, createInstance());
    expect(result).toContain('data:image/png;base64,');
    expect(result).not.toContain('/attachments/baf821ef-3e07-4a4b-9db7-4de3442b0d4c');
  });

  it('leaves external image URLs unchanged', async () => {
    const html = '<p><img src="https://other.example.com/image.png" alt="external"></p>';
    const result = await resolveAttachmentImages(html, createInstance());
    expect(result).toBe(html);
  });

  it('leaves non-attachment local URLs unchanged', async () => {
    const html =
      '<p><img src="https://forgejo.example.com/demo-user/demo-repo/raw/branch/main/image.png" alt="repo"></p>';
    const result = await resolveAttachmentImages(html, createInstance());
    expect(result).toBe(html);
  });

  it('replaces markdown attachment URLs', async () => {
    const markdown = '![screenshot](/attachments/md-uuid)';
    const result = await resolveAttachmentImages(markdown, createInstance());
    expect(result).toContain('data:image/png;base64,');
    expect(result).not.toContain('/attachments/md-uuid');
  });

  it('normalizes attachment URL origin to the configured instance URL', async () => {
    const html =
      '<p><img src="https://mirror.example.com/demo-user/demo-repo/attachments/baf821ef-3e07-4a4b-9db7-4de3442b0d4c" alt="screenshot"></p>';
    const result = await resolveAttachmentImages(html, createInstance());
    expect(result).toContain('data:image/png;base64,');
    expect(result).not.toContain('mirror.example.com');
    // fetch should have been called against the configured instance origin.
    const fetchCalls = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls as string[][];
    expect(fetchCalls.some(([url]) => url.startsWith('https://forgejo.example.com'))).toBe(true);
  });

  it('serves repeated resolves of the same URL from cache without refetching', async () => {
    const html = '<p><img src="/attachments/cache-uuid" alt="screenshot"></p>';
    const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>;

    const first = await resolveAttachmentImages(html, createInstance());
    expect(first).toContain('data:image/png;base64,');
    const callsAfterFirst = fetchMock.mock.calls.length;
    expect(callsAfterFirst).toBe(1);

    const second = await resolveAttachmentImages(html, createInstance());
    expect(second).toBe(first);
    expect(fetchMock.mock.calls.length).toBe(callsAfterFirst);
  });

  it('does not serve a cached image to a different instance on the same origin', async () => {
    const html = '<p><img src="/attachments/shared-uuid" alt="screenshot"></p>';
    const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>;

    await resolveAttachmentImages(html, createInstance());
    expect(fetchMock.mock.calls.length).toBe(1);

    // Same server, different account: attachment visibility is token-scoped, so
    // the first instance's resolved data must not be reused.
    const otherInstance = { ...createInstance(), id: 'other', token: 'other-token' };
    await resolveAttachmentImages(html, otherInstance);

    expect(fetchMock.mock.calls.length).toBe(2);
    expect((fetchMock.mock.calls[1][1] as { headers: { Authorization: string } }).headers.Authorization).toBe(
      'token other-token',
    );
  });

  it('evicts the oldest resolved image when the cache exceeds 100 entries', async () => {
    const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>;
    const instance = createInstance();

    const urls = Array.from({ length: 101 }, (_, i) => `/attachments/evict-${i}`);
    for (const url of urls) {
      await resolveAttachmentImages(`![a](${url})`, instance);
    }
    expect(fetchMock.mock.calls.length).toBe(101);

    // The oldest entry was evicted, so resolving it again refetches.
    await resolveAttachmentImages(`![a](${urls[0]})`, instance);
    expect(fetchMock.mock.calls.length).toBe(102);

    // The most recent entry is still cached.
    await resolveAttachmentImages(`![a](${urls[100]})`, instance);
    expect(fetchMock.mock.calls.length).toBe(102);
  });

  it('fetches at most 4 attachments at a time', async () => {
    const instance = createInstance();
    let inFlight = 0;
    let maxInFlight = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        // Hold the request open so overlapping fetches are observable.
        await new Promise((resolve) => setTimeout(resolve, 5));
        inFlight -= 1;
        return {
          ok: true,
          headers: new Map([['content-type', 'image/png']]),
          arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer,
        } as unknown as Response;
      }),
    );

    const html = Array.from({ length: 12 }, (_, i) => `<img src="/attachments/fan-out-${i}">`).join('');
    const result = await resolveAttachmentImages(html, instance);

    // Every URL was resolved, but one token-bearing GET per attachment with no
    // cap would flood a self-hosted instance (12 links would be 12 in flight).
    expect(result.match(/data:image\/png;base64,/g)).toHaveLength(12);
    expect(maxInFlight).toBeGreaterThan(1);
    expect(maxInFlight).toBeLessThanOrEqual(4);
  });

  it('evicts by the byte budget, not only by the 100-entry cap', async () => {
    const instance = createInstance();
    const fetchMock = vi.fn(async () => ({
      ok: true,
      headers: new Map([['content-type', 'image/png']]),
      // ~11 MiB per image: three of them exceed the 32 MiB budget while the
      // entry cap (100) is nowhere near being reached.
      arrayBuffer: async () => new Uint8Array(11 * 1024 * 1024).buffer,
    })) as unknown as typeof fetch;
    vi.stubGlobal('fetch', fetchMock);

    for (const name of ['byte-a', 'byte-b', 'byte-c']) {
      await resolveAttachmentImages(`![a](/attachments/${name})`, instance);
    }
    expect(fetchMock).toHaveBeenCalledTimes(3);

    // The least recently used entry was dropped to stay inside the budget.
    await resolveAttachmentImages('![a](/attachments/byte-a)', instance);
    expect(fetchMock).toHaveBeenCalledTimes(4);

    // A recent entry survived and is still served from the cache.
    await resolveAttachmentImages('![a](/attachments/byte-c)', instance);
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it('reports a failed attachment fetch instead of silently dropping the URL', async () => {
    const debug = vi.spyOn(logger, 'debug').mockImplementation(() => undefined);
    const instance = createInstance();

    try {
      // A refusal (403): the webview cannot load the authenticated URL itself, so
      // a silent drop would look like a missing image with nothing to diagnose.
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => ({ ok: false, status: 403, headers: new Map() }) as unknown as Response),
      );
      const forbidden = '<img src="/attachments/forbidden-uuid">';
      expect(await resolveAttachmentImages(forbidden, instance)).toBe(forbidden);

      // A thrown network failure used to be swallowed by an empty catch.
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => {
          throw new Error('socket hang up');
        }),
      );
      const offline = '<img src="/attachments/offline-uuid">';
      expect(await resolveAttachmentImages(offline, instance)).toBe(offline);

      const lines = debug.mock.calls.map((call) => String(call[0]));
      expect(lines.some((line) => line.includes('forbidden-uuid') && line.includes('403'))).toBe(true);
      expect(lines.some((line) => line.includes('offline-uuid') && line.includes('socket hang up'))).toBe(true);
    } finally {
      debug.mockRestore();
    }
  });
});
