import { describe, it, expect, vi } from 'vitest';
import { buildUrl, mergeHeaders, client } from '../index';
import type { RequestConfig, ResponseConfig } from '../index';

describe('buildUrl', () => {
  it('joins baseURL and path', () => {
    const config: RequestConfig = { baseURL: 'http://example.com', url: '/api/repos' };
    expect(buildUrl(config)).toBe('http://example.com/api/repos');
  });

  it('removes trailing slash from baseURL', () => {
    const config: RequestConfig = { baseURL: 'http://example.com/', url: '/api/repos' };
    expect(buildUrl(config)).toBe('http://example.com/api/repos');
  });

  it('appends query params', () => {
    const config: RequestConfig = {
      baseURL: 'http://example.com',
      url: '/api/repos',
      params: { page: 1, limit: 10 },
    };
    expect(buildUrl(config)).toBe('http://example.com/api/repos?page=1&limit=10');
  });

  it('serializes null as "null"', () => {
    const config: RequestConfig = {
      baseURL: 'http://example.com',
      url: '/api/repos',
      params: { state: null },
    };
    expect(buildUrl(config)).toBe('http://example.com/api/repos?state=null');
  });

  it('ignores undefined params', () => {
    const config: RequestConfig = {
      baseURL: 'http://example.com',
      url: '/api/repos',
      params: { state: undefined, page: 2 },
    };
    expect(buildUrl(config)).toBe('http://example.com/api/repos?page=2');
  });
});

describe('mergeHeaders', () => {
  it('merges objects', () => {
    expect(mergeHeaders({ Accept: 'application/json' }, { Authorization: 'Bearer token' })).toEqual({
      Accept: 'application/json',
      Authorization: 'Bearer token',
    });
  });

  it('merges arrays', () => {
    expect(
      mergeHeaders(
        [
          ['Accept', 'application/json'],
          ['X-Custom', '1'],
        ],
        [['Authorization', 'Bearer token']],
      ),
    ).toEqual({
      Accept: 'application/json',
      'X-Custom': '1',
      Authorization: 'Bearer token',
    });
  });

  it('later values override earlier ones', () => {
    expect(mergeHeaders({ Accept: 'text/plain' }, { Accept: 'application/json' })).toEqual({
      Accept: 'application/json',
    });
  });

  it('skips undefined entries', () => {
    expect(
      mergeHeaders(
        { Accept: 'application/json', 'X-Missing': undefined as unknown as string },
        { Authorization: 'Bearer token' },
      ),
    ).toEqual({
      Accept: 'application/json',
      Authorization: 'Bearer token',
    });
  });
});

describe('client', () => {
  it('returns parsed JSON on success', async () => {
    const responseData = { id: 1, name: 'test' };
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      statusText: 'OK',
      headers: new Headers({ 'content-type': 'application/json' }),
      body: true,
      json: vi.fn().mockResolvedValue(responseData),
    } as unknown as Response);

    const result = (await client({
      baseURL: 'http://example.com',
      url: '/api/repos',
    })) as ResponseConfig<typeof responseData>;

    expect(result.data).toEqual(responseData);
    expect(result.status).toBe(200);
    expect(globalThis.fetch).toHaveBeenCalledWith(
      'http://example.com/api/repos',
      expect.objectContaining({
        method: undefined,
        headers: { Accept: 'application/json' },
      }),
    );
  });

  it('throws on non-ok response', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 404,
      statusText: 'Not Found',
      text: vi.fn().mockResolvedValue('Not found'),
    } as unknown as Response);

    await expect(
      client({
        baseURL: 'http://example.com',
        url: '/api/repos',
      }),
    ).rejects.toThrow('Forgejo API error 404: Not found');
  });

  it('serializes JSON body and sets content-type', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 201,
      statusText: 'Created',
      headers: new Headers(),
      body: true,
      json: vi.fn().mockResolvedValue({}),
    } as unknown as Response);

    await client({
      baseURL: 'http://example.com',
      url: '/api/repos',
      method: 'POST',
      data: { name: 'new-repo' },
    });

    expect(globalThis.fetch).toHaveBeenCalledWith(
      'http://example.com/api/repos',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ name: 'new-repo' }),
        headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      }),
    );
  });

  it('sends FormData without JSON serialization', async () => {
    const formData = new FormData();
    formData.append('file', new Blob(['content']));

    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      statusText: 'OK',
      headers: new Headers(),
      body: true,
      json: vi.fn().mockResolvedValue({}),
    } as unknown as Response);

    await client({
      baseURL: 'http://example.com',
      url: '/api/upload',
      method: 'POST',
      data: formData,
    });

    const callArgs = vi.mocked(globalThis.fetch).mock.calls[0];
    expect(callArgs?.[1]).toMatchObject({
      method: 'POST',
      body: formData,
      headers: { Accept: 'application/json' },
    });
  });
});
