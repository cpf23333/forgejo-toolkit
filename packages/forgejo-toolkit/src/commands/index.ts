import * as vscode from 'vscode';
import { ForgejoToolkitViewProvider } from '../webview/viewProvider';
import { OnboardingWebviewPanel } from '../webview/onboardingPanel';
import type { ConfigManager } from '../config';
import type { ReadmeContentProvider } from '../readmeProvider';

export function registerCommands(
  context: vscode.ExtensionContext,
  config: ConfigManager,
  readmeProvider: ReadmeContentProvider,
  viewProvider: ForgejoToolkitViewProvider,
) {
  context.subscriptions.push(
    vscode.commands.registerCommand('forgejoToolkit.refreshInstances', () => {
      viewProvider.refresh();
    }),

    vscode.commands.registerCommand('forgejoToolkit.openSettings', () => {
      viewProvider.openSettings();
    }),

    vscode.commands.registerCommand('forgejoToolkit.openOnboarding', () => {
      OnboardingWebviewPanel.createOrShow(context, context.extensionUri, config, readmeProvider);
    }),

    vscode.commands.registerCommand('forgejoToolkit.openDashboard', () => {
      viewProvider.openDashboard();
    }),
  );
}
