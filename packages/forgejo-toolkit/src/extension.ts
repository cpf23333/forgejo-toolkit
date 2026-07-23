import * as vscode from 'vscode';
import { registerCommands } from './commands';
import { ForgejoToolkitViewProvider } from './webview/viewProvider';
import { ConfigManager } from './config';
import { registerReadmeProvider } from './readmeProvider';
import { FORGEJO_PR_SCHEME, ForgejoPRFileSystemProvider } from './prFileSystemProvider';
import { ForgejoPRDecorationProvider } from './prDecorationProvider';

export function activate(context: vscode.ExtensionContext) {
  const config = new ConfigManager(context);
  const readmeProvider = registerReadmeProvider(context);
  const prFileSystemProvider = new ForgejoPRFileSystemProvider(config);

  context.subscriptions.push(
    vscode.workspace.registerFileSystemProvider(FORGEJO_PR_SCHEME, prFileSystemProvider, { isReadonly: true }),
  );
  context.subscriptions.push(vscode.window.registerFileDecorationProvider(new ForgejoPRDecorationProvider()));

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
