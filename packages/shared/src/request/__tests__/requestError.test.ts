import { describe, it, expect } from 'vitest';
import { http, HttpResponse } from 'msw';
import { mockServer } from './setup';
import { client, RequestError } from '../index';
import type { RequestConfig } from '../index';

/**
 * The failure contract of the shared client: every HTTP failure throws a
 * `RequestError` carrying `status`, `statusText`, `headers` and `body`, while
 * `message` keeps the `Forgejo API error <status>: <detail>` format byte for
 * byte. These assertions are the ones that fail if the structured fields are
 * dropped in favour of a plain `Error`.
 */
async function failingRequest(config: RequestConfig): Promise<RequestError> {
  try {
    await client(config);
  } catch (error) {
    return error as RequestError;
  }
  throw new Error('the request was expected to fail');
}

const repoRequest: RequestConfig = { baseURL: 'http://example.com', url: '/api/repos' };

describe('RequestError from client', () => {
  it('carries the status, status text, headers and parsed JSON body', async () => {
    const body = { message: 'name taken', url: 'https://forgejo.example.com/api/v1/user/repos' };
    mockServer.use(
      http.get('http://example.com/api/repos', () => HttpResponse.json(body, { status: 409, statusText: 'Conflict' })),
    );

    const error = await failingRequest(repoRequest);

    expect(error).toBeInstanceOf(RequestError);
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe('RequestError');
    expect(error.status).toBe(409);
    expect(error.statusText).toBe('Conflict');
    expect(error.headers.get('content-type')).toContain('application/json');
    // The server-authored payload is a field, not something the caller has to
    // re-parse out of the message.
    expect(error.body).toEqual(body);
    expect((error.body as typeof body).message).toBe('name taken');
    // ...and the message is still the exact pre-refactor text.
    expect(error.message).toBe(
      'Forgejo API error 409: Conflict ({"message":"name taken","url":"https://forgejo.example.com/api/v1/user/repos"})',
    );
  });

  it('keeps the raw text as the body for a non-JSON response', async () => {
    mockServer.use(
      http.get('http://example.com/api/repos', () =>
        HttpResponse.html('<html><body>502 Bad Gateway</body></html>', { status: 502, statusText: 'Bad Gateway' }),
      ),
    );

    const error = await failingRequest(repoRequest);

    expect(error).toBeInstanceOf(RequestError);
    expect(error.status).toBe(502);
    expect(error.body).toBe('<html><body>502 Bad Gateway</body></html>');
    // The message still describes the shape instead of quoting the markup.
    expect(error.message).toBe('Forgejo API error 502: non-JSON response body (HTTP 502, text/html)');
    expect(error.message).not.toContain('<html>');
  });

  it('carries an empty body as the empty string', async () => {
    mockServer.use(
      http.get(
        'http://example.com/api/repos',
        () =>
          new HttpResponse(null, {
            status: 503,
            statusText: 'Unavailable',
            headers: { 'content-type': 'application/json' },
          }),
      ),
    );

    const error = await failingRequest(repoRequest);

    expect(error.status).toBe(503);
    expect(error.statusText).toBe('Unavailable');
    expect(error.body).toBe('');
    expect(error.message).toBe('Forgejo API error 503: empty response body (HTTP 503, application/json)');
  });

  it('keeps the raw text when a declared-JSON body does not parse', async () => {
    // The media-type rule and the message agree: a body the client could not
    // parse stays text, and the message quotes that same text.
    mockServer.use(
      http.get(
        'http://example.com/api/repos',
        () =>
          new HttpResponse('{"message":"cut off', {
            status: 500,
            statusText: 'Internal Server Error',
            headers: { 'content-type': 'application/json' },
          }),
      ),
    );

    const error = await failingRequest(repoRequest);

    expect(error.status).toBe(500);
    expect(error.body).toBe('{"message":"cut off');
    expect(error.message).toBe('Forgejo API error 500: Internal Server Error ({"message":"cut off)');
  });

  it('parses a JSON error body that is not an object', async () => {
    mockServer.use(
      http.get('http://example.com/api/repos', () =>
        HttpResponse.json(['first', 'second'], { status: 400, statusText: 'Bad Request' }),
      ),
    );

    const error = await failingRequest(repoRequest);

    expect(error.status).toBe(400);
    expect(error.body).toEqual(['first', 'second']);
  });

  it('throws the same error type for a 200 whose body is not JSON', async () => {
    // The sibling failure path (nonJsonSuccessBodyError) reports an HTTP
    // failure too, so it throws the same structured type.
    mockServer.use(
      http.get('http://example.com/api/repos', () => HttpResponse.html('<html><body>maintenance</body></html>')),
    );

    const error = await failingRequest(repoRequest);

    expect(error).toBeInstanceOf(RequestError);
    expect(error.status).toBe(200);
    expect(error.body).toBe('<html><body>maintenance</body></html>');
    expect(error.message).toBe('Forgejo API error 200: non-JSON response body (HTTP 200, text/html)');
  });

  it('keeps the message shape when the status carries no reason phrase', async () => {
    // HTTP/2 sends no reason phrase (and a server may omit it elsewhere). A
    // custom fetch pins that exact Response: over the wire the transport fills
    // the standard phrase in, so the empty one is not reachable through msw.
    const fetchImpl = () =>
      Promise.resolve(
        new Response('{"message":"nope"}', {
          status: 409,
          statusText: '',
          headers: { 'content-type': 'application/json' },
        }),
      );

    const error = await failingRequest({ ...repoRequest, dispatcher: { fake: true }, fetchImpl });

    expect(error.status).toBe(409);
    expect(error.statusText).toBe('');
    expect(error.body).toEqual({ message: 'nope' });
    // `describedBody` starts the detail with the (empty) status text, so the
    // message carries two spaces here; pinning the oddity keeps the
    // byte-for-byte promise honest rather than papering over it.
    expect(error.message).toBe('Forgejo API error 409:  ({"message":"nope"})');
  });
});
