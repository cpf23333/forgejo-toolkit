import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';

export interface WebviewContentOptions {
  panelMode?: 'onboarding' | 'pullReviewComment';
  locale?: 'en' | 'zh';
  /** URLs of the configured Forgejo instances; their origins are added to CSP img-src. */
  instanceUrls?: string[];
  pullReviewComment?: {
    instanceId: string;
    owner: string;
    repo: string;
    index: number;
    path: string;
    position: number;
    isBase: boolean;
    lineNumber: number;
    extraLinesCount?: number;
    mode: 'single' | 'review';
    pendingReviewId?: number;
  };
}

export function getWebviewContent(
  webview: vscode.Webview,
  extensionPath: string,
  options?: WebviewContentOptions,
): string {
  const webviewDistPath = path.join(extensionPath, 'out', 'webview');
  const htmlPath = path.join(webviewDistPath, 'index.html');

  if (!fs.existsSync(htmlPath)) {
    return `
            <html>
                <body style="font-family: sans-serif; padding: 20px;">
                    <h1>Forgejo Toolkit</h1>
                    <p>Webview not built. Run <code>pnpm run build:webview</code> first.</p>
                </body>
            </html>
        `;
  }

  const nonce = getNonce();
  let html = fs.readFileSync(htmlPath, 'utf8');

  const config: {
    panelMode?: 'onboarding' | 'pullReviewComment';
    locale?: 'en' | 'zh';
    vscodeVersion: string;
    pullReviewComment?: WebviewContentOptions['pullReviewComment'];
  } = {
    panelMode: options?.panelMode,
    locale: options?.locale,
    vscodeVersion: vscode.version,
    pullReviewComment: options?.pullReviewComment,
  };
  // Escape `<` so a `</script>` inside a value (e.g. a weird file path) cannot
  // terminate the script block early.
  const configJson = JSON.stringify(config).replace(/</g, '\\u003c');
  const configScript = `<script nonce="${nonce}">window.__FORGEJO_TOOLKIT_CONFIG__ = ${configJson};</script>`;

  const baseUri = webview.asWebviewUri(vscode.Uri.file(webviewDistPath)).toString().replace(/\/$/, '');

  // vscode-elements' <vscode-icon> copies the codicon stylesheet into its
  // shadow DOM by looking up this exact link id. The css + font are copied
  // next to the bundle at build time (see webview/vite.config.ts), so this
  // works in the packaged extension where node_modules does not exist.
  const codiconLink = `<link rel="stylesheet" href="${baseUri}/codicon.css" id="vscode-codicon-stylesheet">`;

  // Images (avatars, attachments, markdown images) are served by the
  // configured instances; private attachments are additionally inlined as
  // data URLs by the host (see resolveAttachmentImages). Third-party https
  // images must also load: Forgejo returns gravatar URLs for users without
  // an uploaded avatar, and issue/PR bodies hot-link images. Plain http from
  // *other* hosts stays blocked (cleartext); the configured instances' own
  // origins are allowlisted below, so an http:// instance still renders its
  // own images. The webview never fetches directly — everything goes through
  // postMessage — so connect-src stays limited to webview resources.
  // script-src pairs the nonce with 'strict-dynamic' so the trust of the
  // nonce'd entry script propagates to its module graph — the code-split
  // chunks (rolldown runtime, lazy views) are plain URL fetches that carry no
  // nonce and would otherwise be blocked. webview.cspSource is the CSP2
  // fallback for engines without strict-dynamic support (ignored where
  // strict-dynamic is honored).
  const instanceOrigins = toInstanceOrigins(options?.instanceUrls ?? []);
  const imgSrc = [`'self'`, 'blob:', 'data:', 'https:', webview.cspSource, ...instanceOrigins].join(' ');
  const cspMeta = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; font-src 'self' data: ${webview.cspSource}; script-src 'nonce-${nonce}' 'strict-dynamic' ${webview.cspSource}; img-src ${imgSrc}; connect-src 'self' ${webview.cspSource};">`;

  html = html.replace(/(src|href)="([^"]*)"/g, (match, attr, value) => {
    if (value.startsWith('http') || value.startsWith('data:')) {
      return match;
    }
    const resolved = value.startsWith('/') ? value.slice(1) : value;
    return `${attr}="${baseUri}/${resolved}"`;
  });

  html = html.replace(/<script /g, `<script nonce="${nonce}" `);

  // Injected after the rewrites above so the injected markup (CSP meta,
  // codicon link, config script) is never touched by them.
  html = html.replace(/<head>/i, `<head>\n    ${cspMeta}\n    ${codiconLink}\n    ${configScript}`);

  return html;
}

/**
 * Derive the unique http(s) origins of the configured instances. Instance
 * URLs may carry a path (Forgejo installed under a sub-path), which CSP
 * source expressions do not support — only the origin is kept.
 */
export function toInstanceOrigins(instanceUrls: string[]): string[] {
  const origins = new Set<string>();
  for (const url of instanceUrls) {
    try {
      const parsed = new URL(url);
      if (parsed.protocol === 'https:' || parsed.protocol === 'http:') {
        origins.add(parsed.origin);
      }
    } catch {
      // Malformed instance URLs simply get no CSP entry.
    }
  }
  return [...origins];
}

function getNonce(): string {
  let text = '';
  const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  for (let i = 0; i < 32; i++) {
    text += possible.charAt(Math.floor(Math.random() * possible.length));
  }
  return text;
}
