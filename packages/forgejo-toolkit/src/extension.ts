import * as vscode from 'vscode';
import { registerCommands } from './commands';
import { ForgejoToolkitViewProvider } from './webview/viewProvider';
import { ConfigManager } from './config';
import { registerReadmeProvider } from './readmeProvider';
import { ForgejoDiffContentProvider } from './diffContentProvider';

export function activate(context: vscode.ExtensionContext) {
  const config = new ConfigManager(context);
  const readmeProvider = registerReadmeProvider(context);
  const diffContentProvider = new ForgejoDiffContentProvider(config);

  context.subscriptions.push(
    vscode.workspace.registerTextDocumentContentProvider(ForgejoDiffContentProvider.scheme, diffContentProvider),
  );

  const viewProvider = new ForgejoToolkitViewProvider(context, context.extensionUri, config, readmeProvider);
  vscode.window.registerWebviewViewProvider(ForgejoToolkitViewProvider.viewType, viewProvider, {
    webviewOptions: { retainContextWhenHidden: true },
  });

  registerCommands(context, config, readmeProvider, viewProvider);

  console.log('Forgejo Toolkit extension activated');
}

export function deactivate() {
  // cleanup if needed
}
