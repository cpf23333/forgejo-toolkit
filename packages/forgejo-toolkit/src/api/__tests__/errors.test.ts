import { describe, it, expect } from 'vitest';
import { ApiError, toApiError, apiErrorUserMessage, extractApiErrorMessage, userFacingErrorMessage } from '../errors';

describe('toApiError', () => {
  it('passes ApiError instances through unchanged', () => {
    const original = new ApiError('http', 'Forgejo API error 500: {}', 500);
    expect(toApiError(original)).toBe(original);
  });

  it('classifies timeouts by error name', () => {
    const timeout = new Error('The operation was aborted due to timeout');
    timeout.name = 'TimeoutError';
    expect(toApiError(timeout).kind).toBe('timeout');

    const aborted = new Error('This operation was aborted');
    aborted.name = 'AbortError';
    expect(toApiError(aborted).kind).toBe('timeout');
  });

  it('classifies HTTP errors and extracts the status code', () => {
    const error = new Error('Forgejo API error 409: {"message":"conflict"}');
    const apiError = toApiError(error);
    expect(apiError.kind).toBe('http');
    expect(apiError.status).toBe(409);
    expect(apiError.rawMessage).toBe('Forgejo API error 409: {"message":"conflict"}');
  });

  it('classifies fetch failures and socket errors as network errors', () => {
    expect(toApiError(new TypeError('fetch failed')).kind).toBe('network');
    expect(toApiError(new Error('connect ECONNREFUSED 127.0.0.1:3000')).kind).toBe('network');
    expect(toApiError(new Error('getaddrinfo ENOTFOUND forgejo.example.com')).kind).toBe('network');
    expect(toApiError(new Error('socket hang up')).kind).toBe('network');
  });

  it('classifies a TLS certificate rejection as its own kind, not a network failure', () => {
    // `fetch` wraps the real failure: the top-level TypeError only says
    // "fetch failed", the certificate problem rides on `cause`.
    for (const code of [
      'DEPTH_ZERO_SELF_SIGNED_CERT',
      'CERT_HAS_EXPIRED',
      'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
      'ERR_TLS_CERT_ALTNAME_INVALID',
      'SELF_SIGNED_CERT_IN_CHAIN',
    ]) {
      const cause = new Error('self-signed certificate') as Error & { code: string };
      cause.code = code;
      const error = new TypeError('fetch failed', { cause });
      expect(toApiError(error).kind).toBe('tls');
    }

    // Undici sometimes reports the prose without a machine-readable code.
    expect(toApiError(new TypeError('fetch failed: unable to verify the first certificate')).kind).toBe('tls');
  });

  it('keeps a plain DNS or refused-connection failure out of the certificate kind', () => {
    const dnsCause = new Error('getaddrinfo ENOTFOUND forgejo.example.com') as Error & { code: string };
    dnsCause.code = 'ENOTFOUND';
    expect(toApiError(new TypeError('fetch failed', { cause: dnsCause })).kind).toBe('network');

    const refusedCause = new Error('connect ECONNREFUSED forgejo.example.com:443') as Error & { code: string };
    refusedCause.code = 'ECONNREFUSED';
    expect(toApiError(new TypeError('fetch failed', { cause: refusedCause })).kind).toBe('network');
  });

  it('falls back to unknown for anything else', () => {
    expect(toApiError(new Error('something odd happened')).kind).toBe('unknown');
    expect(toApiError('a string error').kind).toBe('unknown');
    expect(toApiError(undefined).kind).toBe('unknown');
    expect(toApiError('a string error').rawMessage).toBe('a string error');
  });
});

describe('extractApiErrorMessage', () => {
  // The strings below are what `describedBody` in
  // `packages/shared/src/request/index.ts` writes into the error message: a JSON
  // body follows the status text inside parentheses, anything else is described
  // by shape instead of quoted.
  it('pulls the message field out of the JSON body', () => {
    const raw = 'Forgejo API error 422: {"message":"title is required","url":"https://example.com"}';
    expect(extractApiErrorMessage(raw)).toBe('title is required');
  });

  it('pulls the message out of the parenthesized JSON body the request client produces', () => {
    expect(
      extractApiErrorMessage('Forgejo API error 422: Unprocessable Entity ({"message":"title is required"})'),
    ).toBe('title is required');
    expect(extractApiErrorMessage('Forgejo API error 409: Conflict ({"message":"name taken"})')).toBe('name taken');
  });

  it('keeps a described body when the status text is empty (HTTP/2 sends no reason phrase)', () => {
    // A server that omits the reason phrase leaves the status text empty, so the
    // body starts with the parenthesis.
    expect(extractApiErrorMessage('Forgejo API error 409: ({"message":"name taken"})')).toBe('name taken');
  });

  it('falls back to the raw text when the body has no usable message', () => {
    expect(extractApiErrorMessage('Forgejo API error 500: Internal Server Error')).toBe(
      'Forgejo API error 500: Internal Server Error',
    );
    expect(extractApiErrorMessage('Forgejo API error 500: {"other":1}')).toBe('Forgejo API error 500: {"other":1}');
    // A JSON body with fields but no `message` keeps its description rather than
    // rendering a partial object.
    expect(extractApiErrorMessage('Forgejo API error 500: Internal Server Error ({"errors":["boom"]})')).toBe(
      'Forgejo API error 500: Internal Server Error ({"errors":["boom"]})',
    );
    expect(extractApiErrorMessage('plain error')).toBe('plain error');
  });

  it('keeps the described shape of an HTML or empty body instead of hunting for JSON', () => {
    // The request layer never quotes a non-JSON body, and a description is more
    // actionable than the markup would be.
    const html = extractApiErrorMessage('Forgejo API error 502: non-JSON response body (HTTP 502, text/html)');
    expect(html).toBe('Forgejo API error 502: non-JSON response body (HTTP 502, text/html)');
    expect(extractApiErrorMessage('Forgejo API error 503: empty response body (HTTP 503, application/json)')).toBe(
      'Forgejo API error 503: empty response body (HTTP 503, application/json)',
    );
  });

  it('keeps the raw text for a truncated JSON body instead of showing half an object', () => {
    const raw = 'Forgejo API error 422: Unprocessable Entity ({"message":"' + 'x'.repeat(20) + ' (truncated)})';
    expect(extractApiErrorMessage(raw)).toBe(raw);
  });
});

describe('apiErrorUserMessage', () => {
  function messageFor(kind: 'network' | 'timeout' | 'tls' | 'http' | 'unknown', raw: string, status?: number): string {
    return apiErrorUserMessage(new ApiError(kind, raw, status));
  }

  it('renders a timeout message without the raw text', () => {
    expect(messageFor('timeout', 'aborted')).toContain('timed out');
  });

  it('renders a network message without the raw text', () => {
    expect(messageFor('network', 'fetch failed')).toContain('Cannot connect');
  });

  it('names the certificate problem instead of telling the user to check that the instance is running', () => {
    const message = messageFor('tls', 'fetch failed');
    expect(message).toContain('certificate');
    expect(message).not.toContain('Cannot connect');
  });

  it('never renders a certificate failure as a connectivity problem, and keeps the other failure messages', () => {
    const certCause = Object.assign(new Error('self-signed certificate'), { code: 'DEPTH_ZERO_SELF_SIGNED_CERT' });
    const dnsCause = Object.assign(new Error('getaddrinfo ENOTFOUND forgejo.example.com'), { code: 'ENOTFOUND' });
    const refusedCause = Object.assign(new Error('connect ECONNREFUSED forgejo.example.com:443'), {
      code: 'ECONNREFUSED',
    });

    const certificate = toApiError(new TypeError('fetch failed', { cause: certCause })).userMessage;
    const dns = toApiError(new TypeError('fetch failed', { cause: dnsCause })).userMessage;
    const refused = toApiError(new TypeError('fetch failed', { cause: refusedCause })).userMessage;
    const timeout = toApiError(
      Object.assign(new Error('This operation was aborted'), { name: 'TimeoutError' }),
    ).userMessage;

    // Certificate, DNS, refused connection and timeout must each be recognizable
    // as what they are — a certificate failure is not a connectivity failure.
    expect(certificate).toContain('certificate');
    expect(certificate).not.toContain('Cannot connect');
    expect(dns).toContain('Cannot connect');
    expect(refused).toContain('Cannot connect');
    expect(timeout).toContain('timed out');
    expect(new Set([certificate, dns, timeout]).size).toBe(3);
    // The two genuine connectivity failures are the only pair allowed to share
    // a message: both mean "we never reached the instance".
    expect(refused).toBe(dns);
  });

  it('maps well-known HTTP statuses to specific messages', () => {
    expect(messageFor('http', 'Forgejo API error 401: {}', 401)).toContain('credentials');
    expect(messageFor('http', 'Forgejo API error 403: {}', 403)).toContain('Permission denied');
    expect(messageFor('http', 'Forgejo API error 404: {}', 404)).toContain('Not found');
  });

  it('appends the extracted body message for 409/422 and other statuses', () => {
    // The parentheses are the request layer's JSON body wrapper; the message
    // inside is what the user must see, not the raw body.
    const conflict = messageFor('http', 'Forgejo API error 409: Conflict ({"message":"name taken"})', 409);
    expect(conflict).toContain('Conflict');
    expect(conflict).toContain('name taken');
    expect(conflict).not.toContain('"message"');

    const validation = messageFor(
      'http',
      'Forgejo API error 422: Unprocessable Entity ({"message":"title is required"})',
      422,
    );
    expect(validation).toContain('Validation failed');
    expect(validation).toContain('title is required');

    const generic = messageFor('http', 'Forgejo API error 500: Internal Server Error ({"message":"boom"})', 500);
    expect(generic).toContain('Request failed');
    expect(generic).toContain('boom');
  });

  it('keeps the described shape for an HTML or empty error body', () => {
    const html = messageFor('http', 'Forgejo API error 502: non-JSON response body (HTTP 502, text/html)', 502);
    expect(html).toContain('Request failed');
    expect(html).toContain('non-JSON response body');
    expect(html).not.toContain('<html>');

    const empty = messageFor('http', 'Forgejo API error 503: empty response body (HTTP 503, application/json)', 503);
    expect(empty).toContain('Request failed');
    expect(empty).toContain('empty response body');
  });

  it('keeps the raw body when the JSON has no message field', () => {
    const raw = 'Forgejo API error 500: Internal Server Error ({"errors":["boom"]})';
    const message = messageFor('http', raw, 500);
    expect(message).toContain('Request failed');
    expect(message).toContain('{"errors":["boom"]}');
  });

  it('keeps the raw message for unknown errors', () => {
    expect(messageFor('unknown', 'weird failure')).toBe('weird failure');
  });
});

describe('ApiError', () => {
  it('keeps the raw text as message so legacy pattern matching still works', () => {
    const error = new ApiError('http', 'Forgejo API error 409: {"message":"name taken"}', 409);
    expect(error.message).toBe('Forgejo API error 409: {"message":"name taken"}');
    expect(error.name).toBe('ApiError');
    expect(error.userMessage).toContain('name taken');
  });
});

describe('userFacingErrorMessage', () => {
  it('renders ApiError via its localized userMessage', () => {
    const error = new ApiError('network', 'fetch failed');
    expect(userFacingErrorMessage(error)).toContain('Cannot connect');
  });

  it('passes plain errors and non-errors through unchanged', () => {
    expect(userFacingErrorMessage(new Error('plain'))).toBe('plain');
    expect(userFacingErrorMessage('text')).toBe('text');
    expect(userFacingErrorMessage(42)).toBe('42');
  });
});
