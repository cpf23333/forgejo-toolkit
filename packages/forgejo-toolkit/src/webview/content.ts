import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';

export interface WebviewContentOptions {
  panelMode?: 'onboarding' | 'pullReviewComment';
  locale?: 'en' | 'zh';
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
  const configScript = `<script nonce="${nonce}">window.__FORGEJO_TOOLKIT_CONFIG__ = ${JSON.stringify(config)};</script>`;

  const baseUri = webview.asWebviewUri(vscode.Uri.file(webviewDistPath)).toString().replace(/\/$/, '');

  // vscode-elements' <vscode-icon> copies the codicon stylesheet into its
  // shadow DOM by looking up this exact link id. The css + font are copied
  // next to the bundle at build time (see webview/vite.config.ts), so this
  // works in the packaged extension where node_modules does not exist.
  const codiconLink = `<link rel="stylesheet" href="${baseUri}/codicon.css" id="vscode-codicon-stylesheet">`;

  const cspMeta = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; font-src 'self' data: ${webview.cspSource}; script-src 'nonce-${nonce}'; img-src 'self' blob: data: ${webview.cspSource} http: https:; connect-src 'self' ${webview.cspSource} http: https:;">`;
  html = html.replace(/<head>/i, `<head>\n    ${cspMeta}\n    ${codiconLink}\n    ${configScript}`);

  html = html.replace(/(src|href)="([^"]*)"/g, (match, attr, value) => {
    if (value.startsWith('http') || value.startsWith('data:')) {
      return match;
    }
    const resolved = value.startsWith('/') ? value.slice(1) : value;
    return `${attr}="${baseUri}/${resolved}"`;
  });

  html = html.replace(/<script /g, `<script nonce="${nonce}" `);

  return html;
}

function getNonce(): string {
  let text = '';
  const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  for (let i = 0; i < 32; i++) {
    text += possible.charAt(Math.floor(Math.random() * possible.length));
  }
  return text;
}
