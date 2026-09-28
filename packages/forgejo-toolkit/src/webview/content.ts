import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as crypto from 'crypto';

export interface WebviewContentOptions {
  panelMode?: 'onboarding' | 'pullReviewComment';
  locale?: 'en' | 'zh';
  /** URLs of the configured Forgejo instances; their origins are added to CSP img-src. */
  instanceUrls?: string[];
  /**
   * Allow `http:` image sources. The setup wizard previews markdown from an instance
   * the user has typed but not saved yet, and its HTML (and therefore its CSP) is
   * built before that URL is known; regenerating the panel to apply the origin would
   * reset the form, which the webview does not persist. Only that panel opts in — the
   * dashboard keeps https-only and proxies instance images through the extension host.
   */
  allowInsecureImages?: boolean;
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

/**
 * The document CSP. Exported so its rules — in particular which image origins are
 * allowed for which panel — can be asserted without building the webview bundle.
 */
export function buildContentSecurityPolicy(
  webview: { cspSource: string },
  nonce: string,
  options?: WebviewContentOptions,
): string {
  const instanceOrigins = toInstanceOrigins(options?.instanceUrls ?? []);
  const imgSrc = [
    `'self'`,
    'blob:',
    'data:',
    'https:',
    ...(options?.allowInsecureImages ? ['http:'] : []),
    webview.cspSource,
    ...instanceOrigins,
  ].join(' ');
  return (
    [
      "default-src 'none'",
      `style-src ${webview.cspSource} 'unsafe-inline'`,
      `font-src 'self' data: ${webview.cspSource}`,
      `script-src 'nonce-${nonce}' 'strict-dynamic' ${webview.cspSource}`,
      `img-src ${imgSrc}`,
      `connect-src 'self' ${webview.cspSource}`,
    ].join('; ') + ';'
  );
}

/**
 * The document each webview surface loads.
 *
 * The three surfaces are separate Vite entries (see `webview/vite.config.mts`),
 * so the sidebar dashboard's shell (`App.vue`, the router, the elements only it
 * renders) is not in a panel's entry graph and a panel is not in the sidebar's.
 * Before the split every surface loaded `index.html`, which is how opening the
 * setup wizard or the review comment editor downloaded the whole dashboard.
 */
export const WEBVIEW_HTML_FILES = {
  dashboard: 'index.html',
  onboarding: 'onboarding.html',
  pullReviewComment: 'pullReviewComment.html',
} as const;

/** The HTML document `getWebviewContent` renders for a surface. */
export function webviewHtmlFile(panelMode: WebviewContentOptions['panelMode']): string {
  return WEBVIEW_HTML_FILES[panelMode ?? 'dashboard'];
}

export function getWebviewContent(
  webview: vscode.Webview,
  extensionPath: string,
  options?: WebviewContentOptions,
): string {
  const webviewDistPath = path.join(extensionPath, 'out', 'webview');
  const htmlPath = path.join(webviewDistPath, webviewHtmlFile(options?.panelMode));

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
  // next to the bundle at build time (see webview/vite.config.mts), so this
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
  const cspMeta = `<meta http-equiv="Content-Security-Policy" content="${buildContentSecurityPolicy(webview, nonce, options)}">`;

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

/**
 * The CSP nonce. It gates every script tag in the generated HTML, so it must
 * be unguessable: `Math.random` is not a cryptographic source, and a
 * predictable nonce lets injected markup ride the script-src exception. 24
 * random bytes render as 32 base64url characters — the length the previous
 * alphabet-based implementation produced. This module only runs on the
 * extension host (it is imported by the view provider and the review-comment
 * panel, never bundled into the webview), so node:crypto is available.
 */
function getNonce(): string {
  return crypto.randomBytes(24).toString('base64url');
}
