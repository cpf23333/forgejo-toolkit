import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { ConfigManager } from '../config';

export function openDashboard(context: vscode.ExtensionContext, config: ConfigManager) {
    const panel = vscode.window.createWebviewPanel(
        'forgejoToolkitDashboard',
        'Forgejo Toolkit Dashboard',
        vscode.ViewColumn.One,
        {
            enableScripts: true,
            retainContextWhenHidden: true,
            localResourceRoots: [vscode.Uri.file(path.join(context.extensionPath, 'out', 'webview'))],
        }
    );

    panel.webview.html = getWebviewContent(panel.webview, context.extensionPath);

    panel.webview.onDidReceiveMessage(
        async (message) => {
            switch (message.command) {
                case 'getInstances':
                    panel.webview.postMessage({ command: 'instances', data: config.getInstances() });
                    return;
                case 'openExternal':
                    if (typeof message.url === 'string') {
                        vscode.env.openExternal(vscode.Uri.parse(message.url));
                    }
                    return;
            }
        },
        undefined,
        context.subscriptions
    );
}

function getWebviewContent(webview: vscode.Webview, extensionPath: string): string {
    const webviewDistPath = path.join(extensionPath, 'out', 'webview');
    const htmlPath = path.join(webviewDistPath, 'index.html');

    if (!fs.existsSync(htmlPath)) {
        return `
            <html>
                <body style="font-family: sans-serif; padding: 20px;">
                    <h1>Forgejo Toolkit</h1>
                    <p>Webview not built. Run <code>npm run build:webview</code> first.</p>
                </body>
            </html>
        `;
    }

    const nonce = getNonce();
    let html = fs.readFileSync(htmlPath, 'utf8');

    // Inject CSP meta tag
    const cspMeta = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">`;
    html = html.replace(/<head>/i, `<head>\n    ${cspMeta}`);

    // Rewrite asset URLs to webview URIs and add nonce to scripts
    const baseUri = webview.asWebviewUri(vscode.Uri.file(webviewDistPath)).toString().replace(/\/$/, '');
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
