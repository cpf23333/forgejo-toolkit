import { describe, expect, it } from 'vitest';
import { connectionFailureMessage, isHttpUrl } from '../connectionTest';
import { ApiError } from '../../api/errors';

describe('isHttpUrl', () => {
  it('accepts http and https targets only', () => {
    expect(isHttpUrl('https://forgejo.example.com')).toBe(true);
    expect(isHttpUrl('http://forgejo.example.com:3000')).toBe(true);
    expect(isHttpUrl('file:///etc/passwd')).toBe(false);
    expect(isHttpUrl('not a url')).toBe(false);
  });
});

describe('connectionFailureMessage', () => {
  it('names a certificate failure instead of blaming the URL or the instance state', () => {
    const cause = new Error('self-signed certificate') as Error & { code: string };
    cause.code = 'DEPTH_ZERO_SELF_SIGNED_CERT';

    const message = connectionFailureMessage(new TypeError('fetch failed', { cause }));

    expect(message).toContain('certificate');
    expect(message).not.toContain('Cannot connect');
  });

  it('keeps the connectivity advice for a genuine network failure', () => {
    expect(connectionFailureMessage(new TypeError('fetch failed'))).toContain('Cannot connect');
  });

  it('names the proxy for a proxied connection failure instead of blaming the instance', () => {
    // ForgejoClient classifies a fetch failure with a proxy dispatcher
    // installed as kind 'proxy' (its `viaProxy` context); the reply must point
    // at the proxy, not at the instance behind it.
    const message = connectionFailureMessage(new ApiError('proxy', 'fetch failed'));

    expect(message).toContain('proxy');
    expect(message).not.toContain('Cannot connect to the instance');
  });

  it('keeps the timeout message for an aborted request', () => {
    expect(connectionFailureMessage(Object.assign(new Error('aborted'), { name: 'TimeoutError' }))).toContain(
      'timed out',
    );
  });

  it('reports a caller-driven abort as a cancellation, not a timeout', () => {
    // An AbortError means the caller cancelled the request; answering "the
    // instance is not responding" would name the wrong cause.
    expect(connectionFailureMessage(Object.assign(new Error('aborted'), { name: 'AbortError' }))).toBe(
      'The request was cancelled.',
    );
  });

  it('reports the status code for an HTTP rejection', () => {
    const message = connectionFailureMessage(new Error('Forgejo API error 401: {"message":"unauthorized"}'));

    expect(message).toContain('rejected the request');
    expect(message).toContain('401');
  });

  it('never renders a certificate failure as a connectivity problem', () => {
    const certCause = Object.assign(new Error('self-signed certificate'), { code: 'DEPTH_ZERO_SELF_SIGNED_CERT' });
    const dnsCause = Object.assign(new Error('getaddrinfo ENOTFOUND forgejo.example.com'), { code: 'ENOTFOUND' });

    const certificate = connectionFailureMessage(new TypeError('fetch failed', { cause: certCause }));
    const dns = connectionFailureMessage(new TypeError('fetch failed', { cause: dnsCause }));
    const timeout = connectionFailureMessage(Object.assign(new Error('aborted'), { name: 'TimeoutError' }));

    expect(certificate).toContain('certificate');
    expect(certificate).not.toContain('Cannot connect');
    expect(dns).toContain('Cannot connect');
    expect(timeout).toContain('timed out');
    expect(new Set([certificate, dns, timeout]).size).toBe(3);
  });

  it('falls back to a generic failure for anything unrecognized', () => {
    expect(connectionFailureMessage(new Error('something odd'))).toBe('The connection test failed.');
  });
});
