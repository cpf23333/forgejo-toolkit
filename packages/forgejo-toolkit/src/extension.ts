import * as vscode from 'vscode';
import { registerCommands } from './commands';
import { ForgejoToolkitViewProvider } from './webview/viewProvider';
import { ConfigManager } from './config';
import { registerReadmeProvider } from './readmeProvider';
import { registerRepoFileProvider } from './repoFileProvider';
import { FORGEJO_PR_SCHEME, ForgejoPRFileSystemProvider } from './prFileSystemProvider';
import { ForgejoPRDecorationProvider } from './prDecorationProvider';
import { ForgejoIssueMentionProvider } from './editor/issueMentionProvider';
import { logger } from './logger';

export function activate(context: vscode.ExtensionContext) {
  logger.watch();
  context.subscriptions.push({ dispose: () => logger.dispose() });

  const config = new ConfigManager(context);
  const readmeProvider = registerReadmeProvider(context);
  registerRepoFileProvider(context, config);
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

  const mentionProvider = new ForgejoIssueMentionProvider(config);
  context.subscriptions.push(
    vscode.languages.registerDocumentLinkProvider({ scheme: 'file' }, mentionProvider),
    vscode.languages.registerDocumentLinkProvider({ scheme: FORGEJO_PR_SCHEME }, mentionProvider),
    vscode.languages.registerCompletionItemProvider({ scheme: 'file' }, mentionProvider, '#', '@'),
    vscode.languages.registerCompletionItemProvider({ scheme: FORGEJO_PR_SCHEME }, mentionProvider, '#', '@'),
  );

  console.log('Forgejo Toolkit extension activated');
}

export function deactivate() {
  // cleanup if needed
}
