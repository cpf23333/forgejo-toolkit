import { describe, expect, it } from 'vitest';
import { createProxyDispatcher, resolveProxyUrl } from '../proxy';

describe('resolveProxyUrl', () => {
  it('prefers the configured setting over the environment', () => {
    expect(resolveProxyUrl({ HTTPS_PROXY: 'http://env.example.com:8080' }, 'http://setting.example.com:3128')).toBe(
      'http://setting.example.com:3128',
    );
  });

  it('falls back to the environment in a stable order and ignores blanks', () => {
    expect(
      resolveProxyUrl({
        HTTPS_PROXY: '   ',
        HTTP_PROXY: 'http://http.example.com:1',
        ALL_PROXY: 'http://all.example.com:2',
      }),
    ).toBe('http://http.example.com:1');
    expect(resolveProxyUrl({ ALL_PROXY: 'socks5://all.example.com:2' })).toBe('socks5://all.example.com:2');
    expect(resolveProxyUrl({})).toBeUndefined();
    expect(resolveProxyUrl({}, '   ')).toBeUndefined();
  });
});

describe('createProxyDispatcher', () => {
  it('creates one agent per proxy URL and none without one', () => {
    expect(createProxyDispatcher(undefined)).toBeUndefined();
    const first = createProxyDispatcher('http://proxy.example.com:3128');
    expect(first).toBeDefined();
    expect(createProxyDispatcher('http://proxy.example.com:3128')).toBe(first);
  });
});
