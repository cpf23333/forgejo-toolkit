import type { WebviewApi } from 'vscode-webview';

export const vscode: WebviewApi<unknown> = acquireVsCodeApi();
