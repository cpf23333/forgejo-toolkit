import { describe, expect, it } from 'vitest';
import { buildContentSecurityPolicy } from '../content';

const webview = { cspSource: 'vscode-resource://test' };

describe('buildContentSecurityPolicy', () => {
  it('keeps the dashboard images https-only', () => {
    const csp = buildContentSecurityPolicy(webview, 'nonce', { instanceUrls: [] });
    // `https:` contains the string `http`, so the assertion looks for the token.
    expect(csp).toContain(' https: ');
    expect(csp).not.toContain(' http: ');
  });

  it('lets the setup wizard preview images from a plain-http instance', () => {
    // The wizard renders markdown from the instance being configured, which may be
    // http and is not saved yet; its HTML is built before the URL is known, and
    // regenerating the panel to apply the origin would reset the unpersisted form.
    const csp = buildContentSecurityPolicy(webview, 'nonce', { instanceUrls: [], allowInsecureImages: true });
    expect(csp).toContain(' http: ');
  });

  it('adds configured instance origins to img-src', () => {
    const csp = buildContentSecurityPolicy(webview, 'nonce', {
      instanceUrls: ['http://forgejo.example.com:3000/'],
    });
    expect(csp).toContain('http://forgejo.example.com:3000');
  });
});
