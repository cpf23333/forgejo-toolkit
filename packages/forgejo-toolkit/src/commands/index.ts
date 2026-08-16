import * as vscode from 'vscode';
import { ForgejoToolkitViewProvider } from '../webview/viewProvider';
import { OnboardingWebviewPanel } from '../webview/onboardingPanel';
import type { ConfigManager } from '../config';
import type { ReadmeContentProvider } from '../readmeProvider';
import { COMMAND_ADD_COMMENT, PullReviewCommentController } from '../comments/pullReviewCommentController';
import { copyPermalink } from './permalink';

export function registerCommands(
  context: vscode.ExtensionContext,
  config: ConfigManager,
  readmeProvider: ReadmeContentProvider,
  viewProvider: ForgejoToolkitViewProvider,
  pullReviewCommentController: PullReviewCommentController,
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

    vscode.commands.registerCommand('forgejoToolkit.copyPermalink', () => {
      copyPermalink(config).catch((error: unknown) => {
        const err = error instanceof Error ? error.message : String(error);
        vscode.window.showErrorMessage(vscode.l10n.t('Failed to copy permalink: {0}', err));
      });
    }),

    vscode.commands.registerCommand(COMMAND_ADD_COMMENT, (args?: { lineNumber?: number }) => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) {
        vscode.window.showWarningMessage(vscode.l10n.t('No active editor'));
        return;
      }
      const lineNumber = typeof args?.lineNumber === 'number' ? args.lineNumber : undefined;
      pullReviewCommentController.addComment(editor, lineNumber).catch((error: unknown) => {
        const err = error instanceof Error ? error.message : String(error);
        vscode.window.showErrorMessage(vscode.l10n.t('Failed to add review comment: {0}', err));
      });
    }),

    vscode.commands.registerCommand('forgejoToolkit.deletePullReviewComment', (comment: vscode.Comment | undefined) => {
      if (!comment?.contextValue) {
        return;
      }
      const context = pullReviewCommentController.getCommentContext(comment.contextValue);
      if (!context) {
        return;
      }
      pullReviewCommentController.deleteComment(context).catch((error: unknown) => {
        const err = error instanceof Error ? error.message : String(error);
        vscode.window.showErrorMessage(vscode.l10n.t('Failed to delete review comment: {0}', err));
      });
    }),
  );
}
