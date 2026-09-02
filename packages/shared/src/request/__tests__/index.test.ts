import { describe, it, expect, vi } from 'vitest';
import { http, HttpResponse } from 'msw';
import { mockServer } from './setup';
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

  it('serializes arrays as repeated keys (collectionFormat: multi)', () => {
    const config: RequestConfig = {
      baseURL: 'http://example.com',
      url: '/api/notifications',
      params: { 'status-types': ['unread', 'pinned'] },
    };
    expect(buildUrl(config)).toBe('http://example.com/api/notifications?status-types=unread&status-types=pinned');
  });

  it('skips undefined entries inside arrays and serializes null as "null"', () => {
    const config: RequestConfig = {
      baseURL: 'http://example.com',
      url: '/api/repos',
      params: { label: ['bug', undefined, null] },
    };
    expect(buildUrl(config)).toBe('http://example.com/api/repos?label=bug&label=null');
  });

  it('omits empty arrays entirely', () => {
    const config: RequestConfig = {
      baseURL: 'http://example.com',
      url: '/api/repos',
      params: { label: [], page: 1 },
    };
    expect(buildUrl(config)).toBe('http://example.com/api/repos?page=1');
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
    mockServer.use(
      http.get('http://example.com/api/repos', () =>
        HttpResponse.json(responseData, { headers: { 'content-type': 'application/json' } }),
      ),
    );

    const result = (await client({
      baseURL: 'http://example.com',
      url: '/api/repos',
    })) as ResponseConfig<typeof responseData>;

    expect(result.data).toEqual(responseData);
    expect(result.status).toBe(200);
  });

  it('throws on non-ok response', async () => {
    mockServer.use(
      http.get('http://example.com/api/repos', () =>
        HttpResponse.text('Not found', { status: 404, statusText: 'Not Found' }),
      ),
    );

    await expect(
      client({
        baseURL: 'http://example.com',
        url: '/api/repos',
      }),
    ).rejects.toThrow('Forgejo API error 404: Not found');
  });

  it('serializes JSON body and sets content-type', async () => {
    const requestSpy = vi.fn();
    mockServer.use(
      http.post('http://example.com/api/repos', async ({ request }) => {
        requestSpy(await request.json());
        return HttpResponse.json({});
      }),
    );

    await client({
      baseURL: 'http://example.com',
      url: '/api/repos',
      method: 'POST',
      data: { name: 'new-repo' },
    });

    expect(requestSpy).toHaveBeenCalledWith({ name: 'new-repo' });
  });

  it('sends FormData without JSON serialization', async () => {
    const formData = new FormData();
    formData.append('file', new Blob(['content']));

    let receivedBody: FormData | undefined;
    mockServer.use(
      http.post('http://example.com/api/upload', async ({ request }) => {
        receivedBody = (await request.formData()) as FormData;
        return HttpResponse.json({});
      }),
    );

    await client({
      baseURL: 'http://example.com',
      url: '/api/upload',
      method: 'POST',
      data: formData,
    });

    expect(receivedBody?.get('file')).toBeInstanceOf(Blob);
  });
});
