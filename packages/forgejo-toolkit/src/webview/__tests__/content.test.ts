import { describe, it, expect, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import type * as vscode from 'vscode';

vi.mock('fs', () => ({
  existsSync: vi.fn(() => true),
  readFileSync: vi.fn(
    () =>
      '<!DOCTYPE html><html><head><title>Forgejo Toolkit</title></head><body><div id="app"></div><script src="main.js"></script></body></html>',
  ),
}));

import { getWebviewContent, toInstanceOrigins, type WebviewContentOptions } from '../content';

const CSP_SOURCE = 'https://webview-cdn.example.com';

function createFakeWebview(): vscode.Webview {
  return {
    cspSource: CSP_SOURCE,
    asWebviewUri: (_uri: { fsPath: string }) => ({
      toString: () => `${CSP_SOURCE}/bundle`,
    }),
  } as unknown as vscode.Webview;
}

function render(options?: WebviewContentOptions): string {
  return getWebviewContent(createFakeWebview(), '/ext', options);
}

function extractCsp(html: string): string {
  const match = /Content-Security-Policy" content="([^"]+)"/.exec(html);
  expect(match).not.toBeNull();
  return match![1];
}

function extractConfigJson(html: string): string {
  const match = /window\.__FORGEJO_TOOLKIT_CONFIG__ = (.*?);<\/script>/.exec(html);
  expect(match).not.toBeNull();
  return match![1];
}

describe('getWebviewContent', () => {
  it('restricts img-src to the webview source and configured instance origins', () => {
    const html = render({
      instanceUrls: ['https://forgejo.example.com/sub/path/', 'https://git.example.com'],
    });
    const csp = extractCsp(html);
    expect(csp).toContain(
      `img-src 'self' blob: data: https: ${CSP_SOURCE} https://forgejo.example.com https://git.example.com;`,
    );
  });

  it('allows https: images (gravatar, hot-linked) but keeps http: and connect-src tight', () => {
    const csp = extractCsp(render({ instanceUrls: ['https://forgejo.example.com'] }));
    const imgSrc = /img-src ([^;]+);/.exec(csp)![1];
    const connectSrc = /connect-src ([^;]+);/.exec(csp)![1];
    expect(imgSrc.split(' ')).toContain('https:');
    expect(imgSrc.split(' ')).not.toContain('http:');
    expect(connectSrc).toBe(`'self' ${CSP_SOURCE}`);
  });

  it('works without instances', () => {
    const csp = extractCsp(render());
    expect(csp).toContain(`img-src 'self' blob: data: https: ${CSP_SOURCE};`);
  });

  it('escapes </script> inside the injected config JSON', () => {
    const html = render({
      pullReviewComment: {
        instanceId: 'id',
        owner: 'o</script><script>alert(1)</script>',
        repo: 'r',
        index: 1,
        path: 'src/file.ts',
        position: 1,
        isBase: false,
        lineNumber: 1,
        mode: 'single',
      },
    });
    // The only literal closing script tags are the two legitimate ones
    // (the injected config block and the bundle script).
    expect(html.match(/<\/script>/g)).toHaveLength(2);
    expect(html).toContain('\\u003c/script>');
    // The escaped JSON still round-trips to the original values.
    const config = JSON.parse(extractConfigJson(html));
    expect(config.pullReviewComment.owner).toBe('o</script><script>alert(1)</script>');
  });

  it('does not let the src/href rewrite touch the injected config block', () => {
    const html = render({
      pullReviewComment: {
        instanceId: 'id',
        owner: 'o',
        repo: 'r',
        index: 1,
        path: 'weird src="x" href="y" path.ts',
        position: 1,
        isBase: false,
        lineNumber: 1,
        mode: 'single',
      },
    });
    const config = JSON.parse(extractConfigJson(html));
    expect(config.pullReviewComment.path).toBe('weird src="x" href="y" path.ts');
  });

  it('rewrites bundle resource URLs and nonces every script tag', () => {
    const html = render();
    expect(html).toContain(`src="${CSP_SOURCE}/bundle/main.js"`);
    // The nonce is base64url (crypto.randomBytes), whose alphabet adds - and _.
    const nonce = /script-src 'nonce-([A-Za-z0-9_-]+)'/.exec(extractCsp(html))![1];
    for (const match of html.matchAll(/<script /g)) {
      const tag = html.slice(match.index, html.indexOf('>', match.index));
      expect(tag).toContain(`nonce="${nonce}"`);
    }
  });

  it('loads each surface its own entry document', () => {
    // The five surfaces are separate Vite entries (see webview/vite.config.mts),
    // so a panel document must never be the dashboard's: loading index.html from
    // a panel is exactly the regression that made a panel download the whole
    // dashboard shell. The settings page's own document is the newest of them —
    // it moved out of the sidebar's router into an editor-area tab
    // (`docs/design/settings-page.md` §9.3).
    const expected: [WebviewContentOptions | undefined, string][] = [
      [undefined, 'index.html'],
      [{ instanceUrls: ['https://forgejo.example.com'] }, 'index.html'],
      [{ panelMode: 'onboarding' }, 'onboarding.html'],
      [{ panelMode: 'pullReviewComment' }, 'pullReviewComment.html'],
      [{ panelMode: 'aiPreReview' }, 'aiPreReview.html'],
      [{ panelMode: 'settings' }, 'settings.html'],
    ];
    for (const [options, file] of expected) {
      vi.mocked(fs.readFileSync).mockClear();
      render(options);
      const read = vi.mocked(fs.readFileSync).mock.calls.at(-1)?.[0];
      expect(read).toBe(path.join('/ext', 'out', 'webview', file));
    }
  });

  it('carries the AI pre-review panel payload into the document config', () => {
    // The payload travels like the review-comment editor's context: the panel's
    // first paint shows the candidates without a round trip. Escaping `<` is what
    // keeps a comment body from terminating the config script block.
    const html = render({
      panelMode: 'aiPreReview',
      locale: 'zh',
      aiPreReview: {
        instanceId: 'inst-1',
        owner: 'demo-user',
        repo: 'demo-repo',
        index: 2,
        model: { name: 'Fake Model', vendor: 'fake', family: 'fake', id: 'fake-model' },
        transport: { id: 'vscode.lm', kind: 'vscode.lm', provider: 'fake' },
        scope: 'changed-files',
        // The coverage the panel's header states: one file covered out of the
        // three the run fetched, which is the "N of M" branch the header renders.
        changedFileCount: 1,
        changedFilesTotal: 3,
        candidateCount: 1,
        drops: [{ label: 'line not in the diff', count: 1 }],
        canOpenPullRequest: true,
        candidates: [
          {
            index: 0,
            path: 'src/index.ts',
            line: 2,
            side: 'head',
            extraLines: 0,
            body: 'Careful: </script> in a body must not break the document',
          },
        ],
      },
    });

    const config = /window\.__FORGEJO_TOOLKIT_CONFIG__ = (.*?);<\/script>/s.exec(html)?.[1] ?? '';
    expect(config).toContain('\\u003c/script>');
    const parsed = JSON.parse(config.replace(/\\u003c/g, '<')) as {
      panelMode?: string;
      locale?: string;
      aiPreReview?: { scope?: string; candidates?: { body?: string }[] };
    };
    expect(parsed.panelMode).toBe('aiPreReview');
    expect(parsed.locale).toBe('zh');
    expect(parsed.aiPreReview?.scope).toBe('changed-files');
    expect(parsed.aiPreReview?.candidates?.[0]?.body).toContain('</script>');
  });

  it('reports the flat document it needs when the webview was not built', () => {
    vi.mocked(fs.existsSync).mockReturnValueOnce(false);
    const html = render({ panelMode: 'pullReviewComment' });
    expect(html).toContain('build:webview');
  });
});

describe('toInstanceOrigins', () => {
  it('keeps only the origin and dedupes', () => {
    expect(
      toInstanceOrigins([
        'https://forgejo.example.com/sub/path/',
        'https://forgejo.example.com/other',
        'http://git.example.com:3000',
      ]),
    ).toEqual(['https://forgejo.example.com', 'http://git.example.com:3000']);
  });

  it('skips non-http(s) and malformed URLs', () => {
    expect(toInstanceOrigins(['ftp://forgejo.example.com', 'not a url', ''])).toEqual([]);
  });
});
