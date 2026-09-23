import * as vscode from 'vscode';
import { instanceIdFor } from '../instanceIdentity';
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
import { resolveAttachmentImages } from '../utils/resolveAttachmentImages';
import { userFacingErrorMessage } from '../api/errors';
import { probeServerVersion } from '../api/versionProbe';
import { clearServerVersion } from '../api/serverVersion';
import { clearLinkedRepositoryCache } from '../worktree/gitOperations';
import { validateCacheDirectory } from '../worktree/worktreeManager';

export class OnboardingWebviewPanel {
  public static readonly viewType = 'forgejoToolkitOnboarding';
  public static currentPanel?: OnboardingWebviewPanel;

  private readonly _panel: vscode.WebviewPanel;
  private _disposables: vscode.Disposable[] = [];
  /** Request ids currently being handled; a reply removes the id (see `_reply`). */
  private readonly _unansweredRequests = new Set<string>();
  /** URL of the instance currently being tested (not yet saved); merged into the CSP instance origins. */
  private _editingInstanceUrl: string | undefined;
  /**
   * Full instance entries (tokens included) from the latest import preview,
   * kept host-side so token values never cross into the webview. Same
   * single-slot lifecycle as the main panel: overwritten by the next
   * preview, cleared on confirm or cancel; `importInstances` rehydrates the
   * selected entries by id.
   */
  private _pendingImportInstances: ForgejoInstance[] | undefined;

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
                this._reply('testConnectionResult', { success: false, error: 'Invalid input' });
                return;
              }
              // Remember the URL being tested so the next HTML regeneration
              // includes its origin in the CSP (it is not saved yet).
              this._editingInstanceUrl = url;
              try {
                const client = new ForgejoClient(url, token, logger);
                const user = await client.getCurrentUser();
                // Refresh the cached server version used by the feature gates.
                void probeServerVersion(url, token, logger);
                this._reply('testConnectionResult', { success: true, username: user.login });
              } catch (error) {
                const err = userFacingErrorMessage(error);
                logger.error(`onboarding testConnection failed: ${err}`);
                this._reply('testConnectionResult', { success: false, error: err });
              }
              return;
            }
            case 'saveInstance': {
              const { url, token, syncApiUrlsToInstanceUrl } = message;
              if (typeof url !== 'string' || typeof token !== 'string') {
                this._reply('saveInstanceResult', { success: false, error: 'Invalid input' });
                return;
              }
              try {
                const client = new ForgejoClient(url, token, logger);
                const user = await client.getCurrentUser();

                const normalizedUrl = url.replace(/\/$/, '');
                // Match viewProvider's saveInstance: the id is keyed by host
                // (including the port), so both entry points produce the same
                // instance identity.
                const parsedInstanceUrl = new URL(normalizedUrl);
                const instanceHost = parsedInstanceUrl.host;
                const instance: ForgejoInstance = {
                  id: instanceIdFor(normalizedUrl, user.login),
                  url: normalizedUrl,
                  token,
                  name: `${user.login}@${instanceHost}${parsedInstanceUrl.pathname.replace(/\/+$/, '')}`,
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
                // Saved now: getInstances() covers the origin again.
                this._editingInstanceUrl = undefined;
                this._reply('instances', { data: this._config.getInstances().map(toPublicInstance) });
                this._reply('saveInstanceResult', { success: true });
                vscode.window.showInformationMessage(vscode.l10n.t('Connected to Forgejo as {0}', user.login));
              } catch (error) {
                const err = userFacingErrorMessage(error);
                logger.error(`onboarding saveInstance failed: ${err}`);
                this._reply('saveInstanceResult', { success: false, error: err });
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
                await this._config.removeInstance(id);
                this._reply('instances', { data: this._config.getInstances().map(toPublicInstance) });
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
                logger.error(`Blocked onboarding openExternal with disallowed scheme "${uri.scheme}": ${url}`);
                return;
              }
              try {
                await vscode.env.openExternal(uri);
              } catch (error) {
                const err = userFacingErrorMessage(error);
                logger.error(`onboarding openExternal failed for ${url}: ${err}`);
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
              const { owner, repo, content } = message;
              if (typeof owner === 'string' && typeof repo === 'string' && typeof content === 'string') {
                openReadmePreview(this._readmeProvider, owner, repo, content);
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
              this._panel.dispose();
              vscode.commands.executeCommand('forgejoToolkitView.focus');
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
      const { instances, settings } = await readExportDataFromUri(uris[0]);
      // Stash the full entries host-side; the webview only receives a
      // token-less copy and later confirms by id (same as the main panel).
      this._pendingImportInstances = instances;
      const existingInstances = this._config.getInstances();
      const existingIds = existingInstances.map((instance) => instance.id);
      // Conflict flags (stored-token collisions and in-file duplicates) are
      // computed host-side (parallel to `instances`) — see the message type.
      const tokenConflicts = computeImportTokenConflicts(instances, existingInstances);
      this._reply('importInstancesPreview', {
        instances: stripInstanceTokens(instances),
        existingIds,
        tokenConflicts,
        settings,
      });
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
        await this._config.addInstance(instance);
      }
      await this._applyImportSettings(settings);
      this._reply('instances', { data: this._config.getInstances().map(toPublicInstance) });
      this._reply('instancesImported', { success: true, count: instances.length });
    } catch (error) {
      const err = userFacingErrorMessage(error);
      logger.error(`onboarding importInstances failed: ${err}`);
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
    this._panel.webview.postMessage({ command, ...data } as HostToWebviewMessage);
  }

  private _update() {
    const configured = vscode.workspace.getConfiguration('forgejoToolkit').get<'en' | 'zh' | undefined>('locale');
    const locale = resolveLocale(configured);
    const instanceUrls = this._config.getInstances().map((i) => i.url);
    // The instance currently being tested is not saved yet, so getInstances()
    // does not cover it; without its origin the CSP would block its images in
    // markdown previews.
    if (this._editingInstanceUrl) {
      instanceUrls.push(this._editingInstanceUrl);
    }
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
    OnboardingWebviewPanel.currentPanel = undefined;
    this._panel.dispose();
    while (this._disposables.length) {
      const disposable = this._disposables.pop();
      if (disposable) {
        disposable.dispose();
      }
    }
  }
}
