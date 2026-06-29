import * as vscode from 'vscode';
import { logger } from '../logger';
import { ForgejoClient } from '../api/client';
import { ConfigManager, ForgejoInstance } from '../config';
import { getWebviewContent } from './content';

export class ForgejoToolkitViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'forgejoToolkitView';

  private _view?: vscode.WebviewView;

  constructor(
    private readonly _extensionUri: vscode.Uri,
    private readonly _config: ConfigManager,
  ) {}

  public resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken,
  ) {
    this._view = webviewView;

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this._extensionUri, 'out', 'webview')],
    };

    webviewView.webview.html = getWebviewContent(webviewView.webview, this._extensionUri.fsPath);

    webviewView.webview.onDidReceiveMessage(
      async (message) => {
        logger.debug(`Received message from webview: ${message.command}`);
        switch (message.command) {
          case 'getInstances':
            this._sendInstances();
            return;
          case 'getLocale': {
            const configured = vscode.workspace
              .getConfiguration('forgejoToolkit')
              .get<'en' | 'zh' | undefined>('locale');
            const locale: 'en' | 'zh' =
              configured && (configured === 'en' || configured === 'zh')
                ? configured
                : resolveLocale(vscode.env.language);
            const debug = vscode.workspace.getConfiguration('forgejoToolkit').get<boolean>('debug', false);
            this._reply('setLocale', { locale });
            this._reply('setDebug', { debug });
            this._updateViewTitle(locale);
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
              logger.error(`testConnection failed: ${err}`);
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
              this._sendInstances();
              this._reply('saveInstanceResult', { success: true });
              vscode.window.showInformationMessage(`Connected to Forgejo as ${user.login}`);
            } catch (error) {
              const err = error instanceof Error ? error.message : String(error);
              logger.error(`saveInstance failed: ${err}`);
              this._reply('saveInstanceResult', { success: false, error: err });
            }
            return;
          }
          case 'removeInstance': {
            const { id } = message;
            if (typeof id !== 'string') {
              return;
            }
            await this._config.removeInstance(id);
            this._sendInstances();
            return;
          }
          case 'setLocale': {
            const newLocale = message.locale;
            if (typeof newLocale === 'string' && (newLocale === 'en' || newLocale === 'zh')) {
              await vscode.workspace.getConfiguration('forgejoToolkit').update('locale', newLocale, true);
              this._reply('setLocale', { locale: newLocale });
              this._updateViewTitle(newLocale);
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
          case 'openExternal':
            if (typeof message.url === 'string') {
              vscode.env.openExternal(vscode.Uri.parse(message.url));
            }
            return;
          case 'getRepositories': {
            const instance = this._findInstance(message.instanceId);
            if (!instance) {
              return;
            }
            try {
              const client = new ForgejoClient(instance.url, instance.token, logger);
              const repos = await client.getUserRepositories();
              this._reply('repositories', { instanceId: instance.id, repositories: repos });
            } catch (error) {
              const err = error instanceof Error ? error.message : String(error);
              logger.error(`getRepositories failed for ${instance.name}: ${err}`);
              this._reply('repositories', { instanceId: message.instanceId, error: err });
            }
            return;
          }
          case 'getMyIssues': {
            const instance = this._findInstance(message.instanceId);
            if (!instance) {
              return;
            }
            try {
              const client = new ForgejoClient(instance.url, instance.token, logger);
              const issues = await client.getUserIssues(message.state ?? 'open');
              this._reply('myIssues', { instanceId: instance.id, issues });
            } catch (error) {
              const err = error instanceof Error ? error.message : String(error);
              logger.error(`getMyIssues failed for ${instance.name}: ${err}`);
              this._reply('myIssues', { instanceId: message.instanceId, error: err });
            }
            return;
          }
          case 'getMyPullRequests': {
            const instance = this._findInstance(message.instanceId);
            if (!instance) {
              return;
            }
            try {
              const client = new ForgejoClient(instance.url, instance.token, logger);
              const pulls = await client.getUserPullRequests(message.state ?? 'open');
              this._reply('myPullRequests', { instanceId: instance.id, pullRequests: pulls });
            } catch (error) {
              const err = error instanceof Error ? error.message : String(error);
              logger.error(`getMyPullRequests failed for ${instance.name}: ${err}`);
              this._reply('myPullRequests', { instanceId: message.instanceId, error: err });
            }
            return;
          }
          case 'getRepoDetail': {
            const instance = this._findInstance(message.instanceId);
            if (!instance) {
              return;
            }
            const { owner, repo } = message;
            if (typeof owner !== 'string' || typeof repo !== 'string') {
              return;
            }
            try {
              const client = new ForgejoClient(instance.url, instance.token, logger);
              const detail = await client.getRepoDetail(owner, repo);
              this._reply('repoDetail', { instanceId: instance.id, owner, repo, detail });
            } catch (error) {
              const err = error instanceof Error ? error.message : String(error);
              logger.error(`getRepoDetail failed for ${instance.name}/${owner}/${repo}: ${err}`);
              this._reply('repoDetail', { instanceId: message.instanceId, owner, repo, error: err });
            }
            return;
          }
          case 'copyToClipboard': {
            const text = message.text;
            if (typeof text === 'string') {
              await vscode.env.clipboard.writeText(text);
              vscode.window.showInformationMessage('Copied to clipboard');
            }
            return;
          }
        }
      },
      undefined,
      [],
    );

    webviewView.onDidChangeVisibility(() => {
      if (webviewView.visible) {
        this._sendInstances();
      }
    });
  }

  public openSettings() {
    this._view?.webview.postMessage({ command: 'openSettings' });
  }

  public refresh() {
    this._sendInstances();
  }

  public updateTitle(locale: 'en' | 'zh') {
    this._updateViewTitle(locale);
  }

  private _findInstance(id: unknown): ForgejoInstance | undefined {
    if (typeof id !== 'string') {
      return undefined;
    }
    return this._config.getInstances().find((i) => i.id === id);
  }

  private _updateViewTitle(locale: 'en' | 'zh') {
    if (!this._view) {
      return;
    }
    const title = locale === 'zh' ? '仪表盘' : 'Dashboard';
    this._view.title = title;
  }

  private _sendInstances() {
    if (this._view?.visible) {
      this._view.webview.postMessage({
        command: 'instances',
        data: this._config.getInstances(),
      });
    }
  }

  private _reply(command: string, data: unknown) {
    this._view?.webview.postMessage({ command, data });
  }
}

function resolveLocale(vscodeLanguage: string): 'en' | 'zh' {
  const lang = vscodeLanguage.toLowerCase();
  if (lang.startsWith('zh')) {
    return 'zh';
  }
  return 'en';
}
