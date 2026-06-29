import * as vscode from 'vscode';
import { registerCommands } from './commands';
import { ForgejoToolkitViewProvider } from './webview/viewProvider';
import { ConfigManager } from './config';

export function activate(context: vscode.ExtensionContext) {
  const config = new ConfigManager(context);

  const viewProvider = new ForgejoToolkitViewProvider(context.extensionUri, config);
  vscode.window.registerWebviewViewProvider(ForgejoToolkitViewProvider.viewType, viewProvider, {
    webviewOptions: { retainContextWhenHidden: true },
  });

  registerCommands(context, viewProvider);

  console.log('Forgejo Toolkit extension activated');
}

export function deactivate() {
  // cleanup if needed
}
