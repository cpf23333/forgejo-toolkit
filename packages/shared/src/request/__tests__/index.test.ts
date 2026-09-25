import { describe, it, expect, vi } from 'vitest';
import { http, HttpResponse } from 'msw';
import { mockServer } from './setup';
import { buildUrl, encodePathSegment, mergeHeaders, client } from '../index';
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

  it('skips null params', () => {
    const config: RequestConfig = {
      baseURL: 'http://example.com',
      url: '/api/repos',
      params: { state: null, page: 1 },
    };
    expect(buildUrl(config)).toBe('http://example.com/api/repos?page=1');
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

  it('skips undefined and null entries inside arrays', () => {
    const config: RequestConfig = {
      baseURL: 'http://example.com',
      url: '/api/repos',
      params: { label: ['bug', undefined, null] },
    };
    expect(buildUrl(config)).toBe('http://example.com/api/repos?label=bug');
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

describe('encodePathSegment', () => {
  it('leaves simple segments untouched', () => {
    expect(encodePathSegment('main')).toBe('main');
  });

  it('encodes slashes in branch or tag names', () => {
    expect(encodePathSegment('release/1.0')).toBe('release%2F1.0');
  });

  it('encodes reserved characters', () => {
    expect(encodePathSegment('a#b?c')).toBe('a%23b%3Fc');
  });

  it('accepts numbers', () => {
    expect(encodePathSegment(42)).toBe('42');
  });

  it('refuses dot segments instead of encoding them', () => {
    // `encodeURIComponent` leaves `.` alone and the URL parser resolves `.`/`..`
    // (and their percent-encoded spellings) as path navigation, so an
    // interpolated value could walk out of the endpoint it was meant for.
    expect(() => encodePathSegment('..')).toThrow(/Unsafe path segment/);
    expect(() => encodePathSegment('.')).toThrow(/Unsafe path segment/);
    // A name that merely contains dots is fine.
    expect(encodePathSegment('v1.0.0')).toBe('v1.0.0');
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

  it('overrides case-insensitively, keeping the later spelling of the name', () => {
    // Header names are case-insensitive, so `Content-Type` and `content-type`
    // must not coexist in the merged record (they would serialize as one
    // illegal combined header).
    expect(mergeHeaders({ 'Content-Type': 'text/plain' }, { 'content-type': 'application/json' })).toEqual({
      'content-type': 'application/json',
    });
    expect(mergeHeaders([['X-Custom', '1']], { 'x-custom': '2' }, [['X-CUSTOM', '3']])).toEqual({ 'X-CUSTOM': '3' });
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
    ).rejects.toThrow(/Forgejo API error 404: non-JSON response body \(HTTP 404, text\/plain\)/);
  });

  it('uses the fetch that understands a configured dispatcher', async () => {
    // A dispatcher and the fetch sharing its undici copy must travel together:
    // Node's built-in fetch rejects a dispatcher built by another undici major.
    const dispatcher = { fake: true };
    const calls: Array<{ url: string; dispatcher?: unknown }> = [];
    const fetchImpl = (url: string, init?: { dispatcher?: unknown }) => {
      calls.push({ url, dispatcher: init?.dispatcher });
      return Promise.resolve(new Response(JSON.stringify({ ok: true }), { status: 200 }));
    };

    const result = (await client({
      baseURL: 'http://example.com',
      url: '/api/repos',
      dispatcher,
      fetchImpl,
    })) as ResponseConfig<{ ok: boolean }>;

    expect(calls).toEqual([{ url: 'http://example.com/api/repos', dispatcher }]);
    expect(result.data).toEqual({ ok: true });
  });

  it('falls back to global fetch when only a dispatcher is set', async () => {
    // Without a matching fetch the dispatcher is dropped rather than handed to a
    // fetch that would fail the request.
    mockServer.use(http.get('http://example.com/api/repos', () => HttpResponse.json({ ok: true }, { status: 200 })));

    const result = (await client({
      baseURL: 'http://example.com',
      url: '/api/repos',
      dispatcher: { fake: true },
    })) as ResponseConfig<{ ok: boolean }>;

    expect(result.data).toEqual({ ok: true });
  });

  it('describes an oversized non-JSON error body instead of embedding it', async () => {
    const htmlBody = `<html><body>${'x'.repeat(2000)}</body></html>`;
    mockServer.use(
      http.get('http://example.com/api/repos', () =>
        HttpResponse.html(htmlBody, { status: 502, statusText: 'Bad Gateway' }),
      ),
    );

    let error: Error | undefined;
    try {
      await client({
        baseURL: 'http://example.com',
        url: '/api/repos',
      });
    } catch (e) {
      error = e as Error;
    }

    expect(error).toBeInstanceOf(Error);
    expect(error!.message).toContain('Forgejo API error 502:');
    // The reverse proxy's HTML page must not be quoted into the message...
    expect(error!.message).not.toContain('<html>');
    expect(error!.message).not.toContain('(truncated)');
    // ...but the shape of the response is named, with its status and type.
    expect(error!.message).toContain('non-JSON');
    expect(error!.message).toContain('text/html');
    // Well below the old 500-character body dump.
    expect(error!.message.length).toBeLessThan(200);
  });

  it('reports an HTML error page as a non-JSON body without leaking the request token', async () => {
    mockServer.use(
      http.get('http://example.com/api/repos', () =>
        HttpResponse.html('<html><body>502 Bad Gateway</body></html>', { status: 502 }),
      ),
    );

    let error: Error | undefined;
    try {
      await client({
        baseURL: 'http://example.com',
        url: '/api/repos',
        headers: { Authorization: 'Bearer secret-token-9f8e' },
      });
    } catch (e) {
      error = e as Error;
    }

    expect(error!.message).toContain('Forgejo API error 502');
    expect(error!.message).toContain('non-JSON');
    expect(error!.message).not.toContain('secret-token-9f8e');
    expect(error!.message).not.toContain('<html>');
  });

  it('throws instead of returning undefined when a 200 body is not JSON', async () => {
    mockServer.use(
      http.get('http://example.com/api/repos', () => HttpResponse.html('<html><body>maintenance</body></html>')),
    );

    await expect(
      client({
        baseURL: 'http://example.com',
        url: '/api/repos',
      }),
    ).rejects.toThrow(/Forgejo API error 200: non-JSON response body \(HTTP 200, text\/html\)/);
  });

  it('describes an empty error body instead of quoting the status text as content', async () => {
    mockServer.use(
      http.get(
        'http://example.com/api/repos',
        () => new HttpResponse(null, { status: 503, statusText: 'Unavailable' }),
      ),
    );

    await expect(
      client({
        baseURL: 'http://example.com',
        url: '/api/repos',
      }),
    ).rejects.toThrow(/Forgejo API error 503: empty response body \(HTTP 503/);
  });

  it('still returns an empty object for an empty 200 body', async () => {
    mockServer.use(http.get('http://example.com/api/repos', () => new HttpResponse(null, { status: 200 })));

    const result = await client({
      baseURL: 'http://example.com',
      url: '/api/repos',
    });

    expect(result.status).toBe(200);
    expect(result.data).toEqual({});
  });

  it('returns valid JSON that does not match the expected shape as-is', async () => {
    // The request layer only decodes; shape validation belongs to the caller,
    // so a syntactically valid body must not become an "unknown" error.
    mockServer.use(http.get('http://example.com/api/repos', () => HttpResponse.json(['unexpected', 'shape'])));

    const result = await client({
      baseURL: 'http://example.com',
      url: '/api/repos',
    });

    expect(result.data).toEqual(['unexpected', 'shape']);
  });

  it('returns an empty object for 204 responses', async () => {
    mockServer.use(http.get('http://example.com/api/repos', () => new HttpResponse(null, { status: 204 })));

    const result = await client({
      baseURL: 'http://example.com',
      url: '/api/repos',
    });

    expect(result.status).toBe(204);
    expect(result.data).toEqual({});
  });

  it('returns the raw body stream for responseType stream', async () => {
    mockServer.use(http.get('http://example.com/api/blob', () => new HttpResponse(new Uint8Array([1, 2, 3]).buffer)));

    const result = (await client({
      baseURL: 'http://example.com',
      url: '/api/blob',
      responseType: 'stream',
    })) as ResponseConfig<ReadableStream<Uint8Array> | null>;

    const body = result.data;
    expect(body).toBeTruthy();
    const reader = body!.getReader();
    const chunks: number[] = [];
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      chunks.push(...value);
    }
    expect(chunks).toEqual([1, 2, 3]);
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

  it('sends a string body verbatim instead of JSON-encoding it', async () => {
    // renderMarkdownRaw's data is a raw markdown string; JSON.stringify would
    // wrap it in quotes and contradict the operation's text/plain declaration.
    let receivedBody = '';
    let receivedContentType: string | null = null;
    mockServer.use(
      http.post('http://example.com/api/markdown/raw', async ({ request }) => {
        receivedBody = await request.text();
        receivedContentType = request.headers.get('content-type');
        return HttpResponse.text('ok');
      }),
    );

    await client({
      baseURL: 'http://example.com',
      url: '/api/markdown/raw',
      method: 'POST',
      data: '# hi',
      responseType: 'text',
      headers: { 'Content-Type': 'text/plain' },
    });

    expect(receivedBody).toBe('# hi');
    expect(receivedContentType).toBe('text/plain');
  });

  it('keeps a caller-supplied Content-Type instead of forcing application/json', async () => {
    // An operation that posts a non-JSON body (e.g. renderMarkdownRaw's
    // text/plain) must not have its content type overwritten by the default.
    let receivedContentType: string | null = null;
    mockServer.use(
      http.post('http://example.com/api/markdown', ({ request }) => {
        receivedContentType = request.headers.get('content-type');
        return HttpResponse.text('ok');
      }),
    );

    await client({
      baseURL: 'http://example.com',
      url: '/api/markdown',
      method: 'POST',
      data: '# hi',
      responseType: 'text',
      headers: { 'Content-Type': 'text/plain' },
    });

    expect(receivedContentType).toBe('text/plain');
  });

  it('matches a caller-supplied content-type case-insensitively', async () => {
    // A lowercase spelling must suppress the JSON default too: setting
    // `Content-Type` alongside it would serialize as one illegal combined
    // header (see mergeHeaders).
    let receivedContentType: string | null = null;
    mockServer.use(
      http.post('http://example.com/api/markdown', ({ request }) => {
        receivedContentType = request.headers.get('content-type');
        return HttpResponse.text('ok');
      }),
    );

    await client({
      baseURL: 'http://example.com',
      url: '/api/markdown',
      method: 'POST',
      data: '# hi',
      responseType: 'text',
      headers: { 'content-type': 'text/plain' },
    });

    expect(receivedContentType).toBe('text/plain');
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
