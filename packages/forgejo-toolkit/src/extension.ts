import * as vscode from 'vscode';
import { registerCommands } from './commands';
import { ForgejoToolkitViewProvider } from './webview/viewProvider';
import { OnboardingWebviewPanel } from './webview/onboardingPanel';
import { ConfigManager } from './config';
import { registerReadmeProvider } from './readmeProvider';
import { registerRepoFileProvider } from './repoFileProvider';
import { FORGEJO_PR_SCHEME, ForgejoPRFileSystemProvider } from './prFileSystemProvider';
import { ForgejoPRDecorationProvider } from './prDecorationProvider';
import { ForgejoIssueMentionProvider } from './editor/issueMentionProvider';
import { TodoCommentCodeActionProvider } from './editor/todoCommentCodeAction';
import { PullReviewCommentController } from './comments/pullReviewCommentController';
import { NotificationPoller } from './notifications/notificationPoller';
import { CreatePrStatusBarController } from './statusBar/createPrStatusBar';
import { userFacingErrorMessage } from './api/errors';
import { setForgejoClientHost } from './api/clientHost';
import { createVscodeClientHost } from './api/vscodeClientHost';
import { probeServerVersion } from './api/versionProbe';
import { registerForgejoRemoteSourceProviders } from './clone/remoteSourceProvider';
import { registerMcpServerProvider } from './mcpServerProvider';
import { maybeShowWelcomeOnboarding } from './welcome';
import { logger } from './logger';

export async function activate(context: vscode.ExtensionContext) {
  logger.watch();
  context.subscriptions.push({ dispose: () => logger.dispose() });

  // Auth-failure toasts and localized client messages go through these hooks;
  // the headless MCP server process keeps the no-op defaults.
  setForgejoClientHost(createVscodeClientHost(logger));

  const config = new ConfigManager(context);
  try {
    await config.init();
  } catch (error) {
    // Token migration touches SecretStorage, which may be unavailable on
    // systems without a keyring. Degrade gracefully: instances remain
    // readable from globalState and token-dependent operations surface
    // their own errors later.
    const err = userFacingErrorMessage(error);
    logger.error(`Failed to initialize stored instance tokens: ${err}`);
  }

  // Best-effort version probes feed the feature gates (e.g. the Actions API
  // requires ≥ 1.19); failures fail open and are logged at debug level.
  for (const instance of config.getInstances()) {
    void probeServerVersion(instance.url, instance.token, logger, instance.syncApiUrlsToInstanceUrl);
  }

  // The mock module (msw + all fixtures) is stripped from production builds:
  // esbuild defines this flag and dead-code-eliminates the guarded branch.
  if (process.env.FORGEJO_TOOLKIT_INCLUDE_MOCKS === 'true' && config.isMockApiEnabled()) {
    import('./test/mocks/server')
      .then(({ startMockServer }) => {
        startMockServer();
        logger.info('Mock API server started for offline development');
      })
      .catch((error: unknown) => {
        const err = userFacingErrorMessage(error);
        logger.error(`Failed to start mock API server: ${err}`);
      });
  }

  const readmeProvider = registerReadmeProvider(context);

  // First-run onboarding: show the setup guide once when no instance is
  // configured yet; never auto-opens again after the first activation.
  void maybeShowWelcomeOnboarding(context, config.getInstances().length > 0, () => {
    OnboardingWebviewPanel.createOrShow(context, context.extensionUri, config, readmeProvider);
  }).catch((error: unknown) => {
    logger.error(`Welcome onboarding failed: ${error instanceof Error ? error.message : String(error)}`);
  });
  registerRepoFileProvider(context, config);
  const prFileSystemProvider = new ForgejoPRFileSystemProvider(config);

  context.subscriptions.push(
    vscode.workspace.registerFileSystemProvider(FORGEJO_PR_SCHEME, prFileSystemProvider, { isReadonly: true }),
  );
  context.subscriptions.push(vscode.window.registerFileDecorationProvider(new ForgejoPRDecorationProvider()));

  const viewProvider = new ForgejoToolkitViewProvider(context, context.extensionUri, config, readmeProvider);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(ForgejoToolkitViewProvider.viewType, viewProvider, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
  );

  const notificationPoller = new NotificationPoller(config, viewProvider, context, logger);
  context.subscriptions.push(notificationPoller);
  notificationPoller.start();

  const pullReviewCommentController = new PullReviewCommentController(config, context.extensionUri, logger);
  context.subscriptions.push(pullReviewCommentController);
  // Review submissions happen in a separate panel; let the dashboard reload
  // the affected PR so merge blockers and the timeline stay current.
  pullReviewCommentController.onReviewSubmitted = (params) => viewProvider.notifyPullRequestReviewSubmitted(params);

  const createPrStatusBar = new CreatePrStatusBarController(config);
  context.subscriptions.push(createPrStatusBar);
  viewProvider.onPullRequestsChanged = () => createPrStatusBar.notifyPullRequestsChanged();

  registerCommands(context, config, readmeProvider, viewProvider, pullReviewCommentController);

  const mentionProvider = new ForgejoIssueMentionProvider(config);
  context.subscriptions.push(
    vscode.languages.registerDocumentLinkProvider({ scheme: 'file' }, mentionProvider),
    vscode.languages.registerCompletionItemProvider({ scheme: 'file' }, mentionProvider, '#', '@'),
  );

  context.subscriptions.push(
    vscode.languages.registerCodeActionsProvider({ scheme: 'file' }, new TodoCommentCodeActionProvider(), {
      providedCodeActionKinds: TodoCommentCodeActionProvider.providedCodeActionKinds,
    }),
  );

  // Forgejo instances as clone sources in the "Git: Clone" quick pick.
  // Degrades to a log line when the built-in git extension is unavailable.
  void registerForgejoRemoteSourceProviders(context, config);

  // Expose the configured instances to agent mode as MCP tools.
  registerMcpServerProvider(context, config, logger);

  logger.info('Forgejo Toolkit extension activated');
}

export function deactivate() {
  // cleanup if needed
}
