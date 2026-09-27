import * as vscode from 'vscode';
import { createProxyDispatcher, getProxyFetch, redactProxyForLog, resolveProxyUrl } from './api/proxy';
import { setDefaultRequestDispatcher } from './api/client';
import { registerCommands } from './commands';
import { ForgejoToolkitViewProvider } from './webview/viewProvider';
import { OnboardingWebviewPanel } from './webview/onboardingPanel';
import { ConfigManager } from './config';
import { registerReadmeProvider } from './readmeProvider';
import { registerRepoFileProvider } from './repoFileProvider';
import { FORGEJO_PR_SCHEME, ForgejoPrDiffFileSystemProvider } from './prFileSystemProvider';
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
import { cleanupMcpBroker } from './mcpBroker';
import { cleanupMcpWorkspaceState } from './mcpWorkspaceState';
import { disposePollingLease, startPollingLease, type LeaseSupervisor } from './lease/leaseSupervisor';
import { createLeaseDegradedNotifier } from './lease/leaseDegradedNotice';
import { registerCopyPollingDiagnosticsCommand } from './commands/copyPollingDiagnostics';
import { registerWriteCopilotInstructionsCommand } from './commands/copilotInstructions';
import { watchForExtensionUpdate } from './updateNotifier';
import { maybeShowWelcomeOnboarding } from './welcome';
import { logger } from './logger';

export async function activate(context: vscode.ExtensionContext) {
  // Requests honour a proxy: the editor's http.proxy wins over the environment,
  // and the agent plus its matching fetch are created once per resolved URL. A
  // value the proxy agent refuses must never abort activation, so it degrades to
  // a direct connection with a log line instead.
  const installProxyDispatcher = (): void => {
    const proxyUrl = resolveProxyUrl(process.env, vscode.workspace.getConfiguration('http').get<string>('proxy'));
    const proxyDispatcher = createProxyDispatcher(proxyUrl);
    if (proxyUrl && !proxyDispatcher) {
      // Redacted: a proxy URL may carry credentials and this channel is logged.
      logger.info(`Ignoring the configured proxy "${redactProxyForLog(proxyUrl)}": it is not a usable HTTP proxy URL`);
    }
    setDefaultRequestDispatcher(proxyDispatcher, proxyDispatcher ? getProxyFetch() : undefined);
  };
  installProxyDispatcher();
  // The dispatcher is installed once, so a proxy the user adds, fixes or removes
  // must be picked up without reloading the window.
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration('http.proxy')) {
        installProxyDispatcher();
      }
    }),
  );
  logger.watch();
  context.subscriptions.push({ dispose: () => logger.dispose() });
  // Prompt for the reload a .vsix update needs once it lands under a running
  // window (see updateNotifier).
  watchForExtensionUpdate(context, logger);

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

  // The mock module (msw + all fixtures) is stripped from production builds:
  // esbuild defines this flag and dead-code-eliminates the guarded branch.
  //
  // Started before anything else in activation that issues a request, and
  // awaited: `startMockServer` resolves once the interceptor is installed, so
  // the version probes below and the notification poller's first round are
  // served by the mocks instead of going to the real network.
  if (process.env.FORGEJO_TOOLKIT_INCLUDE_MOCKS === 'true' && config.isMockApiEnabled()) {
    try {
      const { startMockServer } = await import('./test/mocks/server');
      await startMockServer();
      logger.info('Mock API server started for offline development');
    } catch (error) {
      const err = userFacingErrorMessage(error);
      logger.error(`Failed to start mock API server: ${err}`);
    }
  }

  // Best-effort version probes feed the feature gates (e.g. the Actions API
  // requires ≥ 1.19); failures fail open and are logged at debug level.
  for (const instance of config.getInstances()) {
    void probeServerVersion(instance.url, instance.token, logger, instance.syncApiUrlsToInstanceUrl);
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
  const prFileSystemProvider = new ForgejoPrDiffFileSystemProvider(config);

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

  // Multi-window polling lease, stage 2: with `forgejoToolkit.multiWindowLease`
  // on (the default) this window takes part in the election in its
  // globalStorage directory, and the notification poller below consults its
  // gate — only the owner polls and alerts, a follower that becomes the owner
  // starts immediately, and every uncertainty degrades toward polling (§8). The
  // record carries the running version and a fingerprint of the configured
  // instance set, both read here because this is where the context and the
  // config live. Started before the poller on purpose: the gate has to exist
  // before there is anything to ask it.
  const globalStoragePath = context.globalStorageUri?.fsPath;
  const leaseNotifier = createLeaseDegradedNotifier({ logger });
  let leaseSupervisor: LeaseSupervisor | undefined;
  if (globalStoragePath) {
    leaseSupervisor = startPollingLease(
      {
        directory: globalStoragePath,
        appVersion: context.extension.packageJSON.version as string,
        instanceIds: () => config.getInstances().map((instance) => instance.id),
        // The one-time §7.1 notice: it says the feature is not missing, only
        // that this window now polls on its own.
        onDegraded: (cause) => leaseNotifier.notify(cause),
      },
      logger,
    );
    context.subscriptions.push(leaseSupervisor);
  }

  const notificationPoller = new NotificationPoller(config, viewProvider, context, logger, leaseSupervisor);
  context.subscriptions.push(notificationPoller);
  notificationPoller.start();

  // Registered here rather than in registerCommands: the handler needs the live
  // lease, the poller's timing and the settings the config manager exposes, all
  // of which exist only at this point in activation. This is also §7.1's
  // diagnostics entry point — "which window is polling, and when did it last
  // change hands" — together with the existing View Log command.
  registerCopyPollingDiagnosticsCommand(context, {
    lease: () => leaseSupervisor,
    config,
    pollingTiming: () => notificationPoller.pollingTiming(),
    extensionVersion: context.extension.packageJSON.version as string,
    ...(globalStoragePath === undefined ? {} : { globalStoragePath }),
    extensionHostStartedAt: Date.now(),
  });

  const pullReviewCommentController = new PullReviewCommentController(config, context.extensionUri, logger);
  context.subscriptions.push(pullReviewCommentController);
  // Review submissions happen in a separate panel; let the dashboard reload
  // the affected PR so merge blockers and the timeline stay current.
  pullReviewCommentController.onReviewSubmitted = (params) => viewProvider.notifyPullRequestReviewSubmitted(params);

  const createPrStatusBar = new CreatePrStatusBarController(config);
  context.subscriptions.push(createPrStatusBar);
  viewProvider.onPullRequestsChanged = () => createPrStatusBar.notifyPullRequestsChanged();

  registerCommands(context, config, readmeProvider, viewProvider, pullReviewCommentController);
  // Registered here rather than in registerCommands: the handler needs only the
  // instance configuration and the shared linked-repository detection, and it
  // documents the MCP surface the block at the end of activate() starts.
  registerWriteCopilotInstructionsCommand(context, config);

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

  // Expose the configured instances to agent mode as MCP tools. The provider,
  // the workspace-state publishing behind the tools and the local broker all
  // follow `forgejoToolkit.mcpEnabled` and are started and stopped together,
  // so turning the setting off in a running window leaves no stale
  // registration behind (see mcpServerProvider).
  registerMcpServerProvider(context, config, logger);

  logger.info('Forgejo Toolkit extension activated');
}

export async function deactivate(): Promise<void> {
  // Gives up this window's polling lease — only while the record is still
  // ours, so a window that has taken over is never fought — and stops the
  // election's timers, focus subscription and setting watcher.
  await disposePollingLease();
  // Deletes this window's MCP workspace-state file (best-effort; see the
  // function for why a crash-orphaned file is harmless).
  await cleanupMcpWorkspaceState(logger);
  // Stops this window's MCP broker and deletes its registration file, so a
  // forwarder launched afterwards fails its connect fast and falls back to
  // the zero-configuration launch instead of hanging on a dead endpoint.
  await cleanupMcpBroker(logger);
}
