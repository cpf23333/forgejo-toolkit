import * as vscode from 'vscode';

const OUTPUT_CHANNEL_NAME = 'Forgejo Toolkit';

export class Logger {
  private channel?: vscode.OutputChannel;

  private get outputChannel(): vscode.OutputChannel {
    if (!this.channel) {
      this.channel = vscode.window.createOutputChannel(OUTPUT_CHANNEL_NAME);
    }
    return this.channel;
  }

  private isDebugEnabled(): boolean {
    return vscode.workspace.getConfiguration('forgejoToolkit').get<boolean>('debug', false);
  }

  info(message: string): void {
    this.outputChannel.appendLine(`[INFO] ${new Date().toISOString()} ${message}`);
  }

  debug(message: string): void {
    if (!this.isDebugEnabled()) {
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

  dispose(): void {
    this.channel?.dispose();
    this.channel = undefined;
  }
}

export const logger = new Logger();
