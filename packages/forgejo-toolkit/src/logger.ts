import * as vscode from 'vscode';

const OUTPUT_CHANNEL_NAME = 'Forgejo Toolkit';

export class Logger {
  private channel?: vscode.OutputChannel;
  private _debugEnabled = false;
  private _configSubscription?: vscode.Disposable;

  constructor() {
    this._refreshDebugEnabled();
  }

  watch(): void {
    this._configSubscription?.dispose();
    this._configSubscription = vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration('forgejoToolkit.debug')) {
        this._refreshDebugEnabled();
      }
    });
  }

  dispose(): void {
    this._configSubscription?.dispose();
    this._configSubscription = undefined;
    this.channel?.dispose();
    this.channel = undefined;
  }

  private get outputChannel(): vscode.OutputChannel {
    if (!this.channel) {
      this.channel = vscode.window.createOutputChannel(OUTPUT_CHANNEL_NAME);
    }
    return this.channel;
  }

  private _refreshDebugEnabled(): void {
    this._debugEnabled = vscode.workspace.getConfiguration('forgejoToolkit').get<boolean>('debug', false);
  }

  isDebugEnabled(): boolean {
    return this._debugEnabled;
  }

  info(message: string): void {
    this.outputChannel.appendLine(`[INFO] ${new Date().toISOString()} ${message}`);
  }

  debug(message: string): void {
    if (!this._debugEnabled) {
      return;
    }
    this.outputChannel.appendLine(`[DEBUG] ${new Date().toISOString()} ${message}`);
  }

  error(message: string): void {
    this.outputChannel.appendLine(`[ERROR] ${new Date().toISOString()} ${message}`);
  }

  show(): void {
    this.outputChannel.show();
  }
}

export const logger = new Logger();

/**
 * Show an error toast with a "View Log" action that reveals the extension's
 * output channel. Use on failure paths where the output channel carries the
 * underlying detail (push failures, publish failures, ...).
 */
export async function showErrorWithLog(message: string): Promise<void> {
  const viewLogLabel = vscode.l10n.t('View Log');
  const choice = await vscode.window.showErrorMessage(message, viewLogLabel);
  if (choice === viewLogLabel) {
    logger.show();
  }
}
