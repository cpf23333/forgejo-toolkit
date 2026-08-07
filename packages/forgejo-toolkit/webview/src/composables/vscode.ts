import type { WebviewApi } from 'vscode-webview';

export const vscode: WebviewApi<unknown> = acquireVsCodeApi();

export function postMessage<T>(message: T): void {
  vscode.postMessage(JSON.parse(JSON.stringify(message)));
}
