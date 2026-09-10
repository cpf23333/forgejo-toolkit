import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { resolveAttachmentImages, clearResolvedImageCache } from '../resolveAttachmentImages';
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
      '<p><img src="https://100.101.108.106:3004/demo-user/demo-repo/attachments/baf821ef-3e07-4a4b-9db7-4de3442b0d4c" alt="screenshot"></p>';
    const result = await resolveAttachmentImages(html, createInstance());
    expect(result).toContain('data:image/png;base64,');
    expect(result).not.toContain('100.101.108.106:3004');
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
});
