import { describe, expect, it } from 'vitest';
import { functionalInstanceBase, functionalInstanceUrl } from '../instanceUrl';

/**
 * `instance.url` is what the webview *displays* and the host masks credentials
 * in it, so every URL the webview hands to git or opens in a browser has to come
 * from `functionalUrl` instead. The guard here is the mask: a URL that still
 * carries `***` is not a usable link, and returning it would ship a broken clone
 * URL or a dead "open in browser" target.
 */
describe('functionalInstanceUrl', () => {
  it('prefers the credential-free field over the display value', () => {
    expect(
      functionalInstanceUrl({
        id: 'inst-1',
        url: 'https://***@forgejo.example.com/',
        functionalUrl: 'https://forgejo.example.com/',
        name: 'demo',
        username: 'demo-user',
      }),
    ).toBe('https://forgejo.example.com/');
  });

  it('falls back to the display value only when it carries no mask', () => {
    // A payload from a host build that predates `functionalUrl`: the display
    // URL is all there is, and it is usable as long as nothing was redacted.
    expect(
      functionalInstanceUrl({
        id: 'inst-1',
        url: 'https://forgejo.example.com',
        name: 'demo',
        username: 'demo-user',
      }),
    ).toBe('https://forgejo.example.com');
  });

  it('never returns a masked URL', () => {
    // No functional twin and a mask in the display value: there is no usable
    // URL, and the caller's empty check suppresses the action rather than
    // copying or opening `https://***@host/...`.
    expect(
      functionalInstanceUrl({
        id: 'inst-1',
        url: 'https://***@forgejo.example.com/',
        name: 'demo',
        username: 'demo-user',
      }),
    ).toBe('');
    expect(functionalInstanceUrl(undefined)).toBe('');
  });

  it('trims trailing slashes for callers that append a path', () => {
    // The clone URL and the commit link both append `/...`, so a base that kept
    // its trailing slash produced `https://host//owner/repo.git`.
    expect(
      functionalInstanceBase({
        id: 'inst-1',
        url: 'https://***@forgejo.example.com/',
        functionalUrl: 'https://forgejo.example.com/base/',
        name: 'demo',
        username: 'demo-user',
      }),
    ).toBe('https://forgejo.example.com/base');
  });
});
