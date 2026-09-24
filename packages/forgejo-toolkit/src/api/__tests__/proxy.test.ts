import { describe, expect, it } from 'vitest';
import { createProxyDispatcher, getProxyFetch, normalizeProxyUrl, resolveProxyUrl } from '../proxy';

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

  it('accepts the scheme-less value people write in http.proxy', () => {
    // `new ProxyAgent('proxy.example.com:3128')` throws, which used to abort
    // activation; the value is normalized instead of rejected.
    expect(normalizeProxyUrl('proxy.example.com:3128')).toBe('http://proxy.example.com:3128/');
    expect(createProxyDispatcher('proxy.example.com:3128')).toBeDefined();
  });

  it.each(['socks5://proxy.example.com:1080', 'not a url', 'http://'])(
    'never throws for the unusable value %j and falls back to a direct connection',
    (value) => {
      expect(normalizeProxyUrl(value)).toBeUndefined();
      expect(createProxyDispatcher(value)).toBeUndefined();
    },
  );

  it('exposes the bundled-undici fetch only while a proxy is active', () => {
    // The dispatcher is only understood by the undici copy that created it, so
    // the two are installed together (see `getProxyFetch`).
    expect(createProxyDispatcher('http://proxy.example.com:9999')).toBeDefined();
    expect(typeof getProxyFetch()).toBe('function');

    // An unusable value means "no proxy", so the previously installed pair must
    // not stay behind and keep routing host-side fetches through the old agent.
    expect(createProxyDispatcher('socks5://proxy.example.com:1080')).toBeUndefined();
    expect(getProxyFetch()).toBeUndefined();
  });
});
