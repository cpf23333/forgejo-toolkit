import * as vscode from 'vscode';
import { logger } from '../logger';
import { ForgejoClient } from '../api/client';
import { ConfigManager } from '../config';
import type { ForgejoInstance } from '@cpf23333-forgejo-toolkit/shared/webview/messages';
import { getWebviewContent } from './content';
import type { ReadmeContentProvider } from '../readmeProvider';
import { openReadmePreview } from '../readmeProvider';
import type { ExportSettings, HostToWebviewMessage } from '@cpf23333-forgejo-toolkit/shared/webview/messages';
import { readExportDataFromUri } from './instanceImport';

export class OnboardingWebviewPanel {
  public static readonly viewType = 'forgejoToolkitOnboarding';
  public static currentPanel?: OnboardingWebviewPanel;

  private readonly _panel: vscode.WebviewPanel;
  private _disposables: vscode.Disposable[] = [];

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
        logger.debug(`Received message from onboarding webview: ${message.command}`);
        switch (message.command) {
          case 'getInitialState': {
            const configured = vscode.workspace
              .getConfiguration('forgejoToolkit')
              .get<'en' | 'zh' | undefined>('locale');
            const locale: 'en' | 'zh' =
              configured && (configured === 'en' || configured === 'zh')
                ? configured
                : resolveLocale(vscode.env.language);
            const debug = vscode.workspace.getConfiguration('forgejoToolkit').get<boolean>('debug', false);
            const directory = this._config.getWorktreeCacheDirectory() ?? '';
            const defaultDirectory = this._config.getDefaultWorktreeCacheDirectory();
            this._reply('initialState', {
              instances: this._config.getInstances(),
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
              this._reply('testConnectionResult', { success: true, username: user.login });
            } catch (error) {
              const err = error instanceof Error ? error.message : String(error);
              logger.error(`onboarding testConnection failed: ${err}`);
              this._reply('testConnectionResult', { success: false, error: err });
            }
            return;
          }
          case 'saveInstance': {
            const { url, token } = message;
            if (typeof url !== 'string' || typeof token !== 'string') {
              this._reply('saveInstanceResult', { success: false, error: 'Invalid input' });
              return;
            }
            try {
              const client = new ForgejoClient(url, token, logger);
              const user = await client.getCurrentUser();

              const normalizedUrl = url.replace(/\/$/, '');
              const instance: ForgejoInstance = {
                id: `${new URL(normalizedUrl).hostname}-${user.login}`,
                url: normalizedUrl,
                token,
                name: `${user.login}@${new URL(normalizedUrl).hostname}`,
                username: user.login,
              };

              await this._config.addInstance(instance);
              this._reply('instances', { data: this._config.getInstances() });
              this._reply('saveInstanceResult', { success: true });
              vscode.window.showInformationMessage(`Connected to Forgejo as ${user.login}`);
            } catch (error) {
              const err = error instanceof Error ? error.message : String(error);
              logger.error(`onboarding saveInstance failed: ${err}`);
              this._reply('saveInstanceResult', { success: false, error: err });
            }
            return;
          }
          case 'removeInstance': {
            const { id } = message;
            if (typeof id === 'string') {
              await this._config.removeInstance(id);
              this._reply('instances', { data: this._config.getInstances() });
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
              await this._config.setWorktreeCacheDirectory(directory);
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
              openLabel: 'Select Cache Directory',
            });
            if (result && result.length > 0) {
              const directory = result[0].fsPath;
              await this._config.setWorktreeCacheDirectory(directory);
              this._reply('worktreeCacheDirectory', {
                directory: this._config.getWorktreeCacheDirectory() ?? '',
                defaultDirectory: this._config.getDefaultWorktreeCacheDirectory(),
              });
            }
            return;
          }
          case 'openExternal':
            if (typeof message.url === 'string') {
              vscode.env.openExternal(vscode.Uri.parse(message.url));
            }
            return;
          case 'copyToClipboard': {
            const text = message.text;
            if (typeof text === 'string') {
              await vscode.env.clipboard.writeText(text);
              vscode.window.showInformationMessage('Copied to clipboard');
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
            const { text, key } = message;
            if (typeof text !== 'string' || typeof key !== 'string') {
              return;
            }
            try {
              const client = new ForgejoClient(instance.url, instance.token, logger);
              const html = await client.renderMarkdown(text, message.context);
              const htmlWithResolvedImages = await this._resolveImageUrls(html, instance);
              this._reply('renderedMarkdown', { key, html: htmlWithResolvedImages });
            } catch (error) {
              const err = error instanceof Error ? error.message : String(error);
              logger.error(`onboarding renderMarkdown failed for ${instance.name}: ${err}`);
              this._reply('renderedMarkdown', { key, error: err });
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
      return;
    }
    try {
      const { instances, settings } = await readExportDataFromUri(uris[0]);
      const existingInstances = this._config.getInstances();
      const existingIds = existingInstances.map((instance) => instance.id);
      const existingTokens = existingInstances.map((instance) => instance.token);
      this._reply('importInstancesPreview', { instances, existingIds, existingTokens, settings });
    } catch (error) {
      const err = error instanceof Error ? error.message : String(error);
      logger.error(`onboarding previewImportInstances failed: ${err}`);
      this._reply('importInstancesPreview', {
        instances: [],
        existingIds: [],
        existingTokens: [],
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
        const err = error instanceof Error ? error.message : String(error);
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
      this._reply('instances', { data: this._config.getInstances() });
      this._reply('instancesImported', { success: true, count: instances.length });
    } catch (error) {
      const err = error instanceof Error ? error.message : String(error);
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
      await this._config.setWorktreeCacheDirectory(settings.worktreeCacheDirectory);
      const directory = this._config.getWorktreeCacheDirectory() ?? '';
      const defaultDirectory = this._config.getDefaultWorktreeCacheDirectory();
      this._reply('worktreeCacheDirectory', { directory, defaultDirectory });
    }
  }

  private _sendInstances() {
    this._reply('instances', { data: this._config.getInstances() });
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
    this._panel.webview.postMessage({ command, ...data } as HostToWebviewMessage);
  }

  private _update() {
    this._panel.webview.html = getWebviewContent(this._panel.webview, this._extensionUri.fsPath, { panelMode: true });
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

function resolveLocale(vscodeLanguage: string): 'en' | 'zh' {
  const lang = vscodeLanguage.toLowerCase();
  if (lang.startsWith('zh')) {
    return 'zh';
  }
  return 'en';
}
