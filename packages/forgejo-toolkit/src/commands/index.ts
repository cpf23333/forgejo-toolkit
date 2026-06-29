import * as vscode from 'vscode';
import { ForgejoToolkitViewProvider } from '../webview/viewProvider';

export function registerCommands(context: vscode.ExtensionContext, viewProvider: ForgejoToolkitViewProvider) {
  context.subscriptions.push(
    vscode.commands.registerCommand('forgejoToolkit.refreshInstances', () => {
      viewProvider.refresh();
    }),

    vscode.commands.registerCommand('forgejoToolkit.openSettings', () => {
      viewProvider.openSettings();
    }),
  );
}
