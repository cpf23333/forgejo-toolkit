import * as vscode from 'vscode';
import { instanceIdFor, instanceNameFor } from '../instanceIdentity';
import { logger } from '../logger';
import { ForgejoClient } from '../api/client';
import { ConfigManager } from '../config';
import type { ForgejoInstance } from '@cpf23333-forgejo-toolkit/shared/webview/messages';
import { getWebviewContent } from './content';
import type { ReadmeContentProvider } from '../readmeProvider';
import { openReadmePreview } from '../readmeProvider';
import type { ExportSettings, HostToWebviewMessage } from '@cpf23333-forgejo-toolkit/shared/webview/messages';
import { toPublicInstance } from '@cpf23333-forgejo-toolkit/shared/webview/messages';
import {
  computeImportTokenConflicts,
  ImportCancelledError,
  readExportDataFromUri,
  stripInstanceTokens,
} from './instanceImport';
import { resolveLocale } from '../utils/resolveLocale';
import { isSafeRepoIdentity } from './repoIdentity';
import { connectionFailureMessage, isHttpUrl } from './connectionTest';
import { hasUrlUserinfo, redactUrlUserinfo } from '../utils/redactUrlUserinfo';
import { resolveAttachmentImages } from '../utils/resolveAttachmentImages';
import { userFacingErrorMessage } from '../api/errors';
import { probeServerVersion } from '../api/versionProbe';
import { clearServerVersion } from '../api/serverVersion';
import { clearLinkedRepositoryCache } from '../worktree/gitOperations';
import { validateCacheDirectory } from '../worktree/worktreeManager';
import { markWelcomeOnboardingShown } from '../welcome';

export class OnboardingWebviewPanel {
  public static readonly viewType = 'forgejoToolkitOnboarding';
  public static currentPanel?: OnboardingWebviewPanel;

  private readonly _panel: vscode.WebviewPanel;
  private _disposables: vscode.Disposable[] = [];
  /** Request ids currently being handled; a reply removes the id (see `_reply`). */
  private readonly _unansweredRequests = new Set<string>();
  /**
   * Full instance entries (tokens included) from the latest import preview,
   * kept host-side so token values never cross into the webview. Same
   * single-slot lifecycle as the main panel: overwritten by the next preview,
   * cleared on confirm, cancel, or the panel's disposal; `importInstances`
   * rehydrates the selected entries by id.
   */
  private _pendingImportInstances: ForgejoInstance[] | undefined;
  /**
   * Set by `_dispose`, which runs from the panel's `onDidDispose`. The webview
   * is gone from then on, so `_reply` must stop posting: a request that settles
   * after the user closed the panel (the async handlers here all await the
   * network) would otherwise call `postMessage` on a disposed webview, and the
   * rejection that produces is unhandled — the dispatch wrapper's own catch has
   * already returned by then. Same guard the sidebar gets by checking its
   * `_view` reference, which its dispose handler clears.
   */
  private _disposed = false;

  public static createOrShow(
    context: vscode.ExtensionContext,
    extensionUri: vscode.Uri,
    config: ConfigManager,
    readmeProvider: ReadmeContentProvider,
  ): OnboardingWebviewPanel {
    const column = vscode.window.activeTextEditor ? vscode.window.activeTextEditor.viewColumn : undefined;

    if (OnboardingWebviewPanel.currentPanel) {
      OnboardingWebviewPanel.currentPanel._panel.reveal(column);
      return OnboardingWebviewPanel.currentPanel;
    }

    const panel = vscode.window.createWebviewPanel(
      OnboardingWebviewPanel.viewType,
      'Forgejo Toolkit Setup',
      column ?? vscode.ViewColumn.One,
      {
        enableScripts: true,
        localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'out', 'webview')],
        retainContextWhenHidden: true,
      },
    );

    OnboardingWebviewPanel.currentPanel = new OnboardingWebviewPanel(
      panel,
      context,
      extensionUri,
      config,
      readmeProvider,
    );
    return OnboardingWebviewPanel.currentPanel;
  }

  /**
   * Push a `forgejoToolkit.locale` change made outside this panel (the Settings
   * editor, another panel) into the open webview: it renders in the language it
   * was created with until it receives `setLocale`, which the shared webview
   * composable already handles.
   */
  public static notifyLocaleChanged(locale: 'en' | 'zh'): void {
    OnboardingWebviewPanel.currentPanel?._reply('setLocale', { locale });
  }

  private constructor(
    panel: vscode.WebviewPanel,
    private readonly _context: vscode.ExtensionContext,
    private readonly _extensionUri: vscode.Uri,
    private readonly _config: ConfigManager,
    private readonly _readmeProvider: ReadmeContentProvider,
  ) {
    this._panel = panel;

    this._update();

    this._panel.onDidDispose(() => this._dispose(), null, this._disposables);

    this._disposables.push(this._config.onInstancesChanged(() => this._sendInstances()));

    this._panel.webview.onDidReceiveMessage(
      async (message) => {
        logger.debug(`Received message from onboarding webview: ${String(message?.command)}`);
        // Same fallback as the main view provider: a handler that throws — or
        // bails out without replying — must not leave a `_requestId` request
        // pending in the webview forever.
        const requestId =
          message && typeof message === 'object' && typeof message._requestId === 'string'
            ? (message._requestId as string)
            : undefined;
        if (requestId) {
          this._unansweredRequests.add(requestId);
        }
        try {
          // The README preview command carries a repository identity that ends
          // up in a virtual document URI; the same guard the sidebar applies is
          // repeated here because this panel has its own dispatcher. It sits
          // inside the try so a non-object message is handled by the catch
          // below instead of becoming an unhandled rejection.
          if (message && typeof message === 'object' && !isSafeRepoIdentity(message.owner, message.repo)) {
            logger.error(
              `Ignoring onboarding message with an unsafe owner/repo identity: ${String(message.owner)}/${String(message.repo)}`,
            );
            if (requestId) {
              this._unansweredRequests.delete(requestId);
              this._reply('requestError', {
                _requestId: requestId,
                error: vscode.l10n.t('The request could not be completed'),
              });
            }
            return;
          }
          switch (message.command) {
            case 'getInitialState': {
              const configured = vscode.workspace
                .getConfiguration('forgejoToolkit')
                .get<'en' | 'zh' | undefined>('locale');
              const locale: 'en' | 'zh' = resolveLocale(configured);
              const debug = vscode.workspace.getConfiguration('forgejoToolkit').get<boolean>('debug', false);
              const directory = this._config.getWorktreeCacheDirectory() ?? '';
              const defaultDirectory = this._config.getDefaultWorktreeCacheDirectory();
              this._reply('initialState', {
                instances: this._config.getInstances().map(toPublicInstance),
                locale,
                debug,
                worktrees: [],
                worktreeOpenMode: this._config.getWorktreeOpenMode(),
                worktreeCacheDirectory: directory,
                worktreeCacheDirectoryDefault: defaultDirectory,
              });
              return;
            }

            case 'testConnection': {
              const { url, token } = message;
              if (typeof url !== 'string' || typeof token !== 'string') {
                this._reply('testConnectionResult', { success: false, error: vscode.l10n.t('Invalid input') });
                return;
              }
              // Unlike the sidebar's testConnection (viewProvider), this handler
              // reads no `instanceId` and never falls back to a stored token
              // when the field is empty. That difference is intentional today:
              // the wizard only tests instances that are not saved yet
              // (Onboarding.vue calls this for new instances), so there is no
              // stored token to fall back to. If the wizard ever learns to edit
              // an existing instance, align this with the sidebar's same-origin
              // stored-token fallback first — otherwise testing a private
              // instance with an empty token field fails here while the same
              // edit succeeds in the sidebar.
              // Same guard as the sidebar: only http(s) targets may be reached,
              // so a compromised webview cannot aim the host at a `file:` URL or
              // an intranet host. A URL that embeds a credential is refused for
              // the sidebar's reason: `fetch` cannot request one, and the wizard
              // stores through ConfigManager, which refuses such a URL — so
              // testing it would only produce a "cannot connect" message that
              // names the instance instead of the URL.
              if (!isHttpUrl(url) || hasUrlUserinfo(url)) {
                this._reply('testConnectionResult', {
                  success: false,
                  error: vscode.l10n.t('Enter a valid http(s) URL for the Forgejo instance.'),
                });
                return;
              }
              try {
                const client = new ForgejoClient(url, token, logger);
                const user = await client.getCurrentUser();
                // Refresh the cached server version used by the feature gates.
                void probeServerVersion(url, token, logger);
                this._reply('testConnectionResult', { success: true, username: user.login });
              } catch (error) {
                const err = connectionFailureMessage(error);
                logger.error(`onboarding testConnection failed: ${err}`);
                this._reply('testConnectionResult', { success: false, error: err });
              }
              return;
            }
            case 'saveInstance': {
              const { url, token, syncApiUrlsToInstanceUrl } = message;
              if (typeof url !== 'string' || typeof token !== 'string') {
                this._reply('saveInstanceResult', { success: false, error: vscode.l10n.t('Invalid input') });
                return;
              }
              // Same refusal as testConnection above, and for the sidebar's
              // reason (viewProvider's saveInstance): `ConfigManager.addInstance`
              // will not store a URL that embeds a credential, and `fetch` cannot
              // request one either. Without this the wizard connection-tested the
              // URL first and answered "Cannot connect to the instance…", naming
              // the instance when the URL was the problem. Checked before the
              // test, so no request leaves the extension host for such a URL.
              if (!isHttpUrl(url) || hasUrlUserinfo(url)) {
                this._reply('saveInstanceResult', {
                  success: false,
                  error: vscode.l10n.t('Enter a valid http(s) URL for the Forgejo instance.'),
                });
                return;
              }
              try {
                const client = new ForgejoClient(url, token, logger);
                const user = await client.getCurrentUser();

                const normalizedUrl = url.replace(/\/$/, '');
                // Match viewProvider's saveInstance: the id is keyed by host
                // (including the port), so both entry points produce the same
                // instance identity.
                const instance: ForgejoInstance = {
                  id: instanceIdFor(normalizedUrl, user.login),
                  url: normalizedUrl,
                  token,
                  name: instanceNameFor(normalizedUrl, user.login),
                  username: user.login,
                  syncApiUrlsToInstanceUrl,
                };

                await this._config.addInstance(instance);
                // Match viewProvider's saveInstance: drop stale per-URL caches
                // (server version gate, linked-repository scan) before
                // re-probing the freshly saved instance.
                clearServerVersion(normalizedUrl);
                clearLinkedRepositoryCache();
                void probeServerVersion(normalizedUrl, token, logger, syncApiUrlsToInstanceUrl);
                this._reply('instances', { data: this._config.getInstances().map(toPublicInstance) });
                this._reply('saveInstanceResult', { success: true });
                vscode.window.showInformationMessage(vscode.l10n.t('Connected to Forgejo as {0}', user.login));
              } catch (error) {
                const err = userFacingErrorMessage(error);
                logger.error(`onboarding saveInstance failed: ${err}`);
                // Same status-only reply as the sidebar's saveInstance (see
                // connectionFailureMessage): userFacingErrorMessage embeds the
                // upstream response body for 409/422, and that remote-authored
                // content must not be reflected into the webview. The log keeps
                // the full message.
                this._reply('saveInstanceResult', { success: false, error: connectionFailureMessage(error) });
              }
              return;
            }
            case 'getRepositories': {
              // The setup guide probes this right after a successful save: a
              // token can pass the `/user` check the save performs and still
              // miss `read:repository`, which the dashboard then shows as
              // "Permission denied" with no repositories. The guide reads the
              // answer out of its `repos-<id>` slot, which only a
              // `repositories` reply fills (and only that reply clears the
              // busy flag the load sets), and `loadRepositories` sends no
              // `_requestId` — so the dispatcher fallback below cannot cover
              // this command and *every* branch must answer. Served here
              // rather than refused: the panel has the saved instance and the
              // client, and the reply shape is viewProvider's handler for the
              // same command, which is what the shared webview code already
              // understands (success carries the list, failure carries `error`
              // that the guide turns into its missing-scope message).
              const requestedId = typeof message.instanceId === 'string' ? message.instanceId : '';
              const instance = this._findInstance(message.instanceId);
              if (!instance) {
                this._reply('repositories', {
                  instanceId: requestedId,
                  error: vscode.l10n.t('Instance not found'),
                });
                return;
              }
              try {
                const client = new ForgejoClient(
                  instance.url,
                  instance.token,
                  logger,
                  instance.syncApiUrlsToInstanceUrl,
                );
                const repos = await client.getUserRepositories();
                this._reply('repositories', { instanceId: instance.id, repositories: repos.items });
              } catch (error) {
                const err = userFacingErrorMessage(error);
                logger.error(`onboarding getRepositories failed for ${instance.name}: ${err}`);
                this._reply('repositories', { instanceId: requestedId, error: err });
              }
              return;
            }
            case 'removeInstance': {
              const { id } = message;
              if (typeof id === 'string') {
                const instance = this._findInstance(id);
                if (!instance) {
                  return;
                }
                // Same host-enforced confirmation as the main panel; a decline
                // needs no reply (the webview tracks no pending state here).
                if (!(await this._confirmDestructive(vscode.l10n.t('Remove instance "{0}"?', instance.name)))) {
                  return;
                }
                const { removed: removedWorktrees, strandedCheckouts } = await this._config.removeInstance(id);
                this._reply('instances', { data: this._config.getInstances().map(toPublicInstance) });
                if (removedWorktrees > 0) {
                  // Same notice as the sidebar: the worktree records are gone but
                  // their checkouts stay on disk, and naming them is the only way
                  // the user can still find them.
                  void vscode.window.showInformationMessage(
                    vscode.l10n.t(
                      'Removed instance {0} along with its {1} worktree record(s). Their checkouts stay on disk at {2}; nothing tracks them any more, so delete them yourself once they hold no work you still need.',
                      instance.name,
                      removedWorktrees,
                      strandedCheckouts.join(', '),
                    ),
                  );
                }
              }
              return;
            }
            case 'setLocale': {
              const newLocale = message.locale;
              if (typeof newLocale === 'string' && (newLocale === 'en' || newLocale === 'zh')) {
                await vscode.workspace.getConfiguration('forgejoToolkit').update('locale', newLocale, true);
                this._reply('setLocale', { locale: newLocale });
              }
              return;
            }
            case 'setDebug': {
              const debug = message.debug;
              if (typeof debug === 'boolean') {
                await vscode.workspace.getConfiguration('forgejoToolkit').update('debug', debug, true);
              }
              return;
            }
            case 'setWorktreeOpenMode': {
              const mode = message.mode;
              if (mode === 'ask' || mode === 'currentWindow' || mode === 'newWindow') {
                await this._config.setWorktreeOpenMode(mode);
                this._reply('worktreeOpenMode', { mode });
              }
              return;
            }
            case 'setWorktreeCacheDirectory': {
              const directory = message.directory;
              if (typeof directory === 'string') {
                if (!(await this._setWorktreeCacheDirectory(directory))) {
                  return;
                }
                this._reply('worktreeCacheDirectory', {
                  directory: this._config.getWorktreeCacheDirectory() ?? '',
                  defaultDirectory: this._config.getDefaultWorktreeCacheDirectory(),
                });
              }
              return;
            }
            case 'browseWorktreeCacheDirectory': {
              const result = await vscode.window.showOpenDialog({
                canSelectFiles: false,
                canSelectFolders: true,
                canSelectMany: false,
                openLabel: vscode.l10n.t('Select Cache Directory'),
              });
              if (result && result.length > 0) {
                const directory = result[0].fsPath;
                if (!(await this._setWorktreeCacheDirectory(directory))) {
                  return;
                }
                this._reply('worktreeCacheDirectory', {
                  directory: this._config.getWorktreeCacheDirectory() ?? '',
                  defaultDirectory: this._config.getDefaultWorktreeCacheDirectory(),
                });
              }
              return;
            }
            case 'openExternal': {
              const url = message.url;
              if (typeof url !== 'string') {
                return;
              }
              const uri = vscode.Uri.parse(url);
              // Only web URLs may be opened from the (untrusted) webview.
              if (uri.scheme !== 'http' && uri.scheme !== 'https') {
                // The URL is webview-supplied and may carry a credential as
                // userinfo; the sidebar redacts it for the same two log lines
                // (viewProvider's openExternal), so this panel must not write
                // the raw value it refused.
                logger.error(
                  `Blocked onboarding openExternal with disallowed scheme "${uri.scheme}": ${redactUrlUserinfo(url)}`,
                );
                return;
              }
              try {
                await vscode.env.openExternal(uri);
              } catch (error) {
                const err = userFacingErrorMessage(error);
                logger.error(`onboarding openExternal failed for ${redactUrlUserinfo(url)}: ${err}`);
              }
              return;
            }
            case 'copyToClipboard': {
              const text = message.text;
              if (typeof text === 'string') {
                await vscode.env.clipboard.writeText(text);
                vscode.window.showInformationMessage(vscode.l10n.t('Copied to clipboard'));
              }
              return;
            }
            case 'previewReadme': {
              const { owner, repo, content, instanceId } = message;
              if (typeof owner === 'string' && typeof repo === 'string' && typeof content === 'string') {
                // The instance id keys the virtual document, exactly as in the
                // sidebar handler: without it two instances hosting the same
                // owner/repo would share one README document.
                openReadmePreview(
                  this._readmeProvider,
                  owner,
                  repo,
                  content,
                  typeof instanceId === 'string' ? instanceId : undefined,
                );
              }
              return;
            }
            case 'renderMarkdown': {
              const instance = this._findInstance(message.instanceId);
              if (!instance) {
                return;
              }
              const { text, _requestId } = message;
              if (typeof text !== 'string' || typeof _requestId !== 'string') {
                return;
              }
              try {
                const client = new ForgejoClient(
                  instance.url,
                  instance.token,
                  logger,
                  instance.syncApiUrlsToInstanceUrl,
                );
                const html = await client.renderMarkdown(text, message.context);
                // Same safe resolver as the main panel: only attachment URLs
                // on the instance origin are fetched with the token.
                const htmlWithResolvedImages = await resolveAttachmentImages(html, instance);
                this._reply('renderedMarkdown', { _requestId, html: htmlWithResolvedImages });
              } catch (error) {
                const err = userFacingErrorMessage(error);
                logger.error(`onboarding renderMarkdown failed for ${instance.name}: ${err}`);
                this._reply('renderedMarkdown', { _requestId, error: err });
              }
              return;
            }
            case 'previewImportInstances': {
              await this._previewImportInstances();
              return;
            }
            case 'importInstances': {
              const rawIds = (message as { ids?: unknown }).ids;
              const settings = (message as { settings?: ExportSettings }).settings;
              if (Array.isArray(rawIds)) {
                // Preview confirmation: rehydrate the selected entries from
                // the host-side stash (same as the main panel). Instance
                // data sent by the webview is untrusted and ignored.
                const pending = this._pendingImportInstances;
                this._pendingImportInstances = undefined;
                if (!pending) {
                  this._reply('instancesImported', {
                    success: false,
                    error: vscode.l10n.t('The import preview is no longer available; please pick the file again'),
                  });
                  return;
                }
                const wanted = new Set(rawIds.filter((id): id is string => typeof id === 'string'));
                const selected = pending.filter((instance) => wanted.has(instance.id));
                if (selected.length === 0) {
                  this._reply('instancesImported', {
                    success: false,
                    error: vscode.l10n.t('No valid instances found in the import data'),
                  });
                  return;
                }
                await this._importInstances(selected, settings);
                return;
              }
              await this._importInstances(undefined, settings);
              return;
            }
            case 'cancelImportInstances': {
              this._pendingImportInstances = undefined;
              return;
            }
            case 'closeOnboarding': {
              // The guide only sends this once the user got through it, which is
              // what suppresses the automatic reopen on later activations (see
              // maybeShowWelcomeOnboarding).
              await markWelcomeOnboardingShown(this._context);
              this._panel.dispose();
              // The button is labelled "Open Dashboard", so it has to land
              // there: focusing the view container alone only brings the
              // sidebar's *last* route on screen, which after a first run is
              // whatever the guide left behind. `openDashboard` is the same
              // two-step the sidebar's own openDashboard() performs (reveal the
              // view, then post the navigation message), and the registered
              // command is the way to reach it from here — this panel has no
              // reference to the view provider, and it queues the message until
              // the view has been resolved if it was never shown.
              vscode.commands.executeCommand('forgejoToolkitView.focus');
              vscode.commands.executeCommand('forgejoToolkit.openDashboard');
              return;
            }
          }
        } catch (error) {
          const err = userFacingErrorMessage(error);
          logger.error(`Error handling onboarding webview message "${String(message?.command)}": ${err}`);
        } finally {
          if (requestId && this._unansweredRequests.has(requestId)) {
            this._unansweredRequests.delete(requestId);
            logger.error(
              `Onboarding handler for "${String(message.command)}" ended without replying to request ${requestId}`,
            );
            this._reply('requestError', {
              _requestId: requestId,
              error: vscode.l10n.t('The request could not be completed'),
            });
          }
        }
      },
      undefined,
      this._disposables,
    );
  }

  /**
   * Same host-enforced confirmation as the main view provider: destructive
   * commands must not rely on the (untrusted) webview to confirm.
   */
  private async _confirmDestructive(message: string): Promise<boolean> {
    const confirmLabel = vscode.l10n.t('Confirm');
    const choice = await vscode.window.showWarningMessage(message, { modal: true }, confirmLabel);
    return choice === confirmLabel;
  }

  private async _previewImportInstances() {
    const uris = await vscode.window.showOpenDialog({
      canSelectFiles: true,
      canSelectFolders: false,
      canSelectMany: false,
      filters: { JSON: ['json'] },
    });
    if (!uris || uris.length === 0) {
      // The webview keeps a single in-flight slot for this request; a silent
      // cancel would wedge it forever, so answer explicitly.
      this._reply('importInstancesPreview', {
        instances: [],
        existingIds: [],
        tokenConflicts: [],
        settings: undefined,
        cancelled: true,
      });
      return;
    }
    try {
      const { instances, settings, dropped } = await readExportDataFromUri(uris[0]);
      // Stash the full entries host-side; the webview only receives a
      // token-less copy and later confirms by id (same as the main panel).
      this._pendingImportInstances = instances;
      const existingInstances = this._config.getInstances();
      const existingIds = existingInstances.map((instance) => instance.id);
      // Conflict flags (stored-token collisions and in-file duplicates) are
      // computed host-side (parallel to `instances`) — see the message type.
      const tokenConflicts = computeImportTokenConflicts(instances, existingInstances);
      const payload: Omit<Extract<HostToWebviewMessage, { command: 'importInstancesPreview' }>, 'command'> & {
        /** Entries the host could not use; the webview warns about them. */
        dropped?: number;
      } = {
        instances: stripInstanceTokens(instances),
        existingIds,
        tokenConflicts,
        settings,
        // Entries the host could not use are absent from `instances`, so the
        // count is the only signal that the file held more. Omitted when zero:
        // the webview reads an absent field as "nothing to warn about".
        ...(dropped > 0 ? { dropped } : {}),
      };
      this._reply('importInstancesPreview', payload);
    } catch (error) {
      this._pendingImportInstances = undefined;
      if (error instanceof ImportCancelledError) {
        // The user dismissed the password prompt: answer like the file-picker
        // cancel above so the preview slot frees without an error banner.
        this._reply('importInstancesPreview', {
          instances: [],
          existingIds: [],
          tokenConflicts: [],
          settings: undefined,
          cancelled: true,
        });
        return;
      }
      const err = userFacingErrorMessage(error);
      logger.error(`onboarding previewImportInstances failed: ${err}`);
      this._reply('importInstancesPreview', {
        instances: [],
        existingIds: [],
        tokenConflicts: [],
        settings: undefined,
        error: err,
      });
    }
  }

  private async _importInstances(instancesToImport?: ForgejoInstance[], settings?: ExportSettings) {
    let instances: ForgejoInstance[];
    if (instancesToImport) {
      instances = instancesToImport;
    } else {
      const uris = await vscode.window.showOpenDialog({
        canSelectFiles: true,
        canSelectFolders: false,
        canSelectMany: false,
        filters: { JSON: ['json'] },
      });
      if (!uris || uris.length === 0) {
        this._reply('instancesImported', { success: false, cancelled: true });
        return;
      }
      try {
        const data = await readExportDataFromUri(uris[0]);
        instances = data.instances;
        if (data.settings) {
          settings = data.settings;
        }
      } catch (error) {
        if (error instanceof ImportCancelledError) {
          // Dismissing the password prompt is a cancel, not a failure (same
          // reply as the file-picker cancel above).
          this._reply('instancesImported', { success: false, cancelled: true });
          return;
        }
        const err = userFacingErrorMessage(error);
        logger.error(`onboarding importInstances failed: ${err}`);
        this._reply('instancesImported', { success: false, error: err });
        return;
      }
    }
    try {
      for (const instance of instances) {
        try {
          await this._config.addInstance(instance);
        } catch (error) {
          // The setup guide only renders the failure reply when it names the
          // reason; without the instance identity a rejected entry (an invalid
          // URL, a storage failure) reads as "nothing happened".
          throw new Error(
            vscode.l10n.t(
              'Importing instance {0} failed: {1}',
              instance.name || instance.url,
              userFacingErrorMessage(error),
            ),
          );
        }
      }
      await this._applyImportSettings(settings);
      this._reply('instances', { data: this._config.getInstances().map(toPublicInstance) });
      this._reply('instancesImported', { success: true, count: instances.length });
    } catch (error) {
      const err = userFacingErrorMessage(error);
      logger.error(`onboarding importInstances failed: ${err}`);
      // The wizard shows this string next to the import step, so it names what
      // failed (the instance, or the corrupt file / wrong password from the
      // parse above) instead of failing silently.
      this._reply('instancesImported', { success: false, error: err });
    }
  }

  private async _applyImportSettings(settings: ExportSettings | undefined) {
    if (!settings) {
      return;
    }
    const configuration = vscode.workspace.getConfiguration('forgejoToolkit');
    if (settings.locale === 'en' || settings.locale === 'zh') {
      await configuration.update('locale', settings.locale, true);
      this._reply('setLocale', { locale: settings.locale });
    }
    if (typeof settings.debug === 'boolean') {
      await configuration.update('debug', settings.debug, true);
      this._reply('setDebug', { debug: settings.debug });
    }
    if (
      settings.worktreeOpenMode === 'ask' ||
      settings.worktreeOpenMode === 'currentWindow' ||
      settings.worktreeOpenMode === 'newWindow'
    ) {
      await this._config.setWorktreeOpenMode(settings.worktreeOpenMode);
      this._reply('worktreeOpenMode', { mode: settings.worktreeOpenMode });
    }
    if (typeof settings.worktreeCacheDirectory === 'string') {
      if (await this._setWorktreeCacheDirectory(settings.worktreeCacheDirectory)) {
        const directory = this._config.getWorktreeCacheDirectory() ?? '';
        const defaultDirectory = this._config.getDefaultWorktreeCacheDirectory();
        this._reply('worktreeCacheDirectory', { directory, defaultDirectory });
      }
    }
  }

  /**
   * Same validation as the settings view: create the directory when missing
   * and probe writability before persisting it. An empty value resets to the
   * default directory and is always accepted.
   */
  private async _setWorktreeCacheDirectory(directory: string): Promise<boolean> {
    const trimmed = directory.trim();
    if (trimmed) {
      try {
        await validateCacheDirectory(trimmed);
      } catch (error) {
        const err = userFacingErrorMessage(error);
        void vscode.window.showErrorMessage(
          vscode.l10n.t('Cannot use "{0}" as the worktree cache directory: {1}', trimmed, err),
        );
        return false;
      }
    }
    await this._config.setWorktreeCacheDirectory(trimmed);
    return true;
  }

  private _sendInstances() {
    this._reply('instances', { data: this._config.getInstances().map(toPublicInstance) });
  }

  private _findInstance(id: unknown): ForgejoInstance | undefined {
    if (typeof id !== 'string') {
      return undefined;
    }
    return this._config.getInstances().find((i) => i.id === id);
  }

  private _reply<T extends HostToWebviewMessage['command']>(
    command: T,
    data: Omit<Extract<HostToWebviewMessage, { command: T }>, 'command'>,
  ) {
    // Mark the request answered so the dispatch fallback does not emit a
    // duplicate requestError reply.
    const requestId = (data as { _requestId?: unknown })._requestId;
    if (typeof requestId === 'string') {
      this._unansweredRequests.delete(requestId);
    }
    if (this._disposed) {
      // The webview is gone; posting would reject on a disposed panel. The
      // request is still marked answered above so nothing lingers waiting on it.
      return;
    }
    this._panel.webview.postMessage({ command, ...data } as HostToWebviewMessage);
  }

  private _update() {
    const configured = vscode.workspace.getConfiguration('forgejoToolkit').get<'en' | 'zh' | undefined>('locale');
    const locale = resolveLocale(configured);
    const instanceUrls = this._config.getInstances().map((i) => i.url);
    this._panel.webview.html = getWebviewContent(this._panel.webview, this._extensionUri.fsPath, {
      panelMode: 'onboarding',
      locale,
      instanceUrls,
      // Markdown previews in the wizard point at the instance being configured,
      // which may be plain http and is not saved yet (see allowInsecureImages).
      allowInsecureImages: true,
    });
  }

  private _dispose() {
    this._disposed = true;
    OnboardingWebviewPanel.currentPanel = undefined;
    this._panel.dispose();
    // The import preview's stash holds the picked file's tokens in plaintext.
    // The webview that could still confirm it is gone, so keeping it would leave
    // those tokens in memory until the next preview overwrote them.
    this._pendingImportInstances = undefined;
    while (this._disposables.length) {
      const disposable = this._disposables.pop();
      if (disposable) {
        disposable.dispose();
      }
    }
  }
}
