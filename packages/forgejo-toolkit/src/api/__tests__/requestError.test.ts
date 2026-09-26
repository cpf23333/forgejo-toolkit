import { describe, it, expect } from 'vitest';
import { RequestError } from '@cpf23333-forgejo-toolkit/shared/request';
import { toApiError } from '../errors';

/**
 * The host half of the structured-error refactor: `toApiError` reads `status` and
 * `body` off a `RequestError` instead of re-parsing the message, and only a
 * foreign error (no fields of its own) still goes through the message-based
 * path. A few of these cases make the message text disagree with — or truncate —
 * what the fields say, which is exactly what a message-parsing classifier got
 * wrong.
 */
function httpError(options: {
  message: string;
  status: number;
  statusText?: string;
  body?: unknown;
  contentType?: string;
}): RequestError {
  return new RequestError(
    options.message,
    options.status,
    options.statusText ?? '',
    new Headers(options.contentType ? { 'content-type': options.contentType } : {}),
    options.body,
  );
}

describe('toApiError with a structured RequestError', () => {
  it('takes the status from the field, not from the message text', () => {
    // The message says 500; the response status field says 422. A classifier
    // that still parses the message reports 500 and the generic wording. In
    // production both come from the same response, so this disagreement only
    // exists to pin which source wins.
    const error = httpError({
      message: 'Forgejo API error 500: Internal Server Error',
      status: 422,
      statusText: 'Unprocessable Entity',
      body: { message: 'title is required', errors: ['title is required'] },
      contentType: 'application/json',
    });

    const apiError = toApiError(error);

    expect(apiError.kind).toBe('http');
    expect(apiError.status).toBe(422);
    // The raw text is still kept verbatim for logs.
    expect(apiError.rawMessage).toBe('Forgejo API error 500: Internal Server Error');
    // ...and the parsed body is preserved on the ApiError.
    expect(apiError.body).toEqual({ message: 'title is required', errors: ['title is required'] });
    expect(apiError.userMessage).toBe('Validation failed: title is required');
  });

  it('renders the server-authored 409 message from the parsed body', () => {
    const error = httpError({
      message: 'Forgejo API error 409: Conflict ({"message":"name taken"})',
      status: 409,
      statusText: 'Conflict',
      body: { message: 'name taken' },
      contentType: 'application/json',
    });

    expect(toApiError(error).userMessage).toBe('Conflict: name taken');
  });

  it('renders the body even when the message only carries a truncated copy of it', () => {
    // The body embedded in the message is capped at 500 characters, so a long
    // server message used to be unrecoverable. The field is not capped.
    const longMessage = `title ${'x'.repeat(600)} is required`;
    const error = httpError({
      message: `Forgejo API error 422: Unprocessable Entity ({"message":"title ${'x'.repeat(400)} (truncated)})`,
      status: 422,
      statusText: 'Unprocessable Entity',
      body: { message: longMessage },
      contentType: 'application/json',
    });

    expect(toApiError(error).userMessage).toBe(`Validation failed: ${longMessage}`);
  });

  it('keeps the raw-text body on the message-based path', () => {
    // A non-JSON body is stored as the raw text, and the message describes its
    // shape instead of quoting it: the description is still what renders.
    const error = httpError({
      message: 'Forgejo API error 502: non-JSON response body (HTTP 502, text/html)',
      status: 502,
      statusText: 'Bad Gateway',
      body: '<html><body>502 Bad Gateway</body></html>',
      contentType: 'text/html',
    });

    const apiError = toApiError(error);

    expect(apiError.status).toBe(502);
    expect(apiError.body).toBe('<html><body>502 Bad Gateway</body></html>');
    expect(apiError.userMessage).toBe(
      'Request failed: Forgejo API error 502: non-JSON response body (HTTP 502, text/html)',
    );
    expect(apiError.userMessage).not.toContain('<html>');
  });

  it('ignores a JSON body that carries no usable message and keeps the raw text', () => {
    const error = httpError({
      message: 'Forgejo API error 500: Internal Server Error ({"errors":["boom"]})',
      status: 500,
      statusText: 'Internal Server Error',
      body: { errors: ['boom'] },
      contentType: 'application/json',
    });

    expect(toApiError(error).userMessage).toBe(
      'Request failed: Forgejo API error 500: Internal Server Error ({"errors":["boom"]})',
    );
  });

  it('classifies a structured failure for a status the message-based path would misread', () => {
    // A 403 carrying a scope hint: the status and the body are read as fields,
    // so the kind is http and the status is exact even if the message text was
    // rewritten before it reached the host.
    const error = httpError({
      message: 'Forbidden',
      status: 403,
      statusText: 'Forbidden',
      body: { message: 'token does not have at least one of required scope(s): [write:issue]' },
      contentType: 'application/json',
    });

    const apiError = toApiError(error);

    expect(apiError.kind).toBe('http');
    expect(apiError.status).toBe(403);
    expect(apiError.userMessage).toContain('Permission denied');
  });
});

describe('toApiError with a foreign error', () => {
  it('classifies and extracts the body through the message path', () => {
    // An error the host did not create itself (another module, a test fixture, a
    // serialization boundary that dropped the class) has no fields, so the
    // message stays the only signal — and it still classifies and renders the
    // server message exactly as before.
    const error = new Error('Forgejo API error 422: Unprocessable Entity ({"message":"title is required"})');

    const apiError = toApiError(error);

    expect(apiError.kind).toBe('http');
    expect(apiError.status).toBe(422);
    expect(apiError.body).toBeUndefined();
    expect(apiError.userMessage).toBe('Validation failed: title is required');
  });

  it('keeps the message path for a plain 409', () => {
    const apiError = toApiError(new Error('Forgejo API error 409: Conflict ({"message":"name taken"})'));
    expect(apiError.status).toBe(409);
    expect(apiError.userMessage).toBe('Conflict: name taken');
  });
});
