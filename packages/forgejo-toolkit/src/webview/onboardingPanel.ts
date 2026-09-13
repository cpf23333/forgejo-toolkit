import * as vscode from 'vscode';
import { logger } from '../logger';
import { ForgejoClient } from '../api/client';
import { ConfigManager } from '../config';
import type { ForgejoInstance } from '@cpf23333-forgejo-toolkit/shared/webview/messages';
import { getWebviewContent } from './content';
import type { ReadmeContentProvider } from '../readmeProvider';
import { openReadmePreview } from '../readmeProvider';
import type { ExportSettings, HostToWebviewMessage } from '@cpf23333-forgejo-toolkit/shared/webview/messages';
import { toPublicInstance } from '@cpf23333-forgejo-toolkit/shared/webview/messages';
import { computeTokenConflicts, readExportDataFromUri } from './instanceImport';
import { resolveLocale } from '../utils/resolveLocale';
import { userFacingErrorMessage } from '../api/errors';
import { probeServerVersion } from '../api/versionProbe';
import { validateCacheDirectory } from '../worktree/worktreeManager';

export class OnboardingWebviewPanel {
  public static readonly viewType = 'forgejoToolkitOnboarding';
  public static currentPanel?: OnboardingWebviewPanel;

  private readonly _panel: vscode.WebviewPanel;
  private _disposables: vscode.Disposable[] = [];
  /** Request ids currently being handled; a reply removes the id (see `_reply`). */
  private readonly _unansweredRequests = new Set<string>();

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
                const instanceHost = new URL(normalizedUrl).host;
                const instance: ForgejoInstance = {
                  id: `${instanceHost}-${user.login}`,
                  url: normalizedUrl,
                  token,
                  name: `${user.login}@${instanceHost}`,
                  username: user.login,
                  syncApiUrlsToInstanceUrl,
                };

                await this._config.addInstance(instance);
                void probeServerVersion(normalizedUrl, token, logger, syncApiUrlsToInstanceUrl);
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
                const htmlWithResolvedImages = await this._resolveImageUrls(html, instance);
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
              const instancesToImport = Array.isArray((message as { instances?: unknown[] }).instances)
                ? ((message as { instances?: ForgejoInstance[] }).instances as ForgejoInstance[])
                : undefined;
              const settings = (message as { settings?: ExportSettings }).settings;
              await this._importInstances(instancesToImport, settings);
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
      const existingInstances = this._config.getInstances();
      const existingIds = existingInstances.map((instance) => instance.id);
      // Conflict flags are computed host-side (parallel to `instances`) so
      // stored tokens are never sent to the webview.
      const tokenConflicts = computeTokenConflicts(instances, existingInstances);
      this._reply('importInstancesPreview', { instances, existingIds, tokenConflicts, settings });
    } catch (error) {
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
        this._reply('instancesImported', { success: false });
        return;
      }
      try {
        const data = await readExportDataFromUri(uris[0]);
        instances = data.instances;
        if (data.settings) {
          settings = data.settings;
        }
      } catch (error) {
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
    this._panel.webview.html = getWebviewContent(this._panel.webview, this._extensionUri.fsPath, {
      panelMode: 'onboarding',
      locale,
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

  private async _resolveImageUrls(html: string, instance: ForgejoInstance): Promise<string> {
    const instanceBaseUrl = instance.url.replace(/\/$/, '');
    const imgSrcRegex = /<img[^\u003e]*\s+src=["']([^"']+)["'][^\u003e]*>/gi;
    const replacements: Array<{ start: number; end: number; value: string }> = [];
    let match;
    while ((match = imgSrcRegex.exec(html)) !== null) {
      const src = match[1];
      if (!src || src.startsWith('data:')) {
        continue;
      }
      let absoluteUrl: string;
      try {
        absoluteUrl = new URL(src, instanceBaseUrl).href;
      } catch {
        continue;
      }
      try {
        const response = await fetch(absoluteUrl, {
          headers: { Authorization: `token ${instance.token}` },
        });
        if (!response.ok) {
          continue;
        }
        const buffer = await response.arrayBuffer();
        const base64 = Buffer.from(buffer).toString('base64');
        const contentType = response.headers.get('content-type') ?? 'image/png';
        replacements.push({
          start: match.index,
          end: imgSrcRegex.lastIndex,
          value: `data:${contentType};base64,${base64}`,
        });
      } catch {
        // ignore image fetch errors, keep original url
      }
    }
    let result = html;
    for (let i = replacements.length - 1; i >= 0; i--) {
      const { start, end, value } = replacements[i];
      const original = result.slice(start, end);
      const srcMatch = /src=["'][^"']+["']/i.exec(original);
      if (!srcMatch) {
        continue;
      }
      const srcStart = start + srcMatch.index;
      result = result.slice(0, srcStart + 5) + value + result.slice(srcStart + srcMatch[0].length - 1);
    }
    return result;
  }
}
