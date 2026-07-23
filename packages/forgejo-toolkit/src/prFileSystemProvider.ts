import * as vscode from 'vscode';
import { ForgejoClient } from './api/client';
import { ConfigManager } from './config';
import { logger } from './logger';

export interface ForgejoPrUriParams {
  instanceId: string;
  owner: string;
  repo: string;
  ref: string;
  isBase: boolean;
  status?: string;
}

export const FORGEJO_PR_SCHEME = 'forgejo-pr';

export class ForgejoPRFileSystemProvider implements vscode.FileSystemProvider {
  private readonly _onDidChangeFile = new vscode.EventEmitter<vscode.FileChangeEvent[]>();
  public readonly onDidChangeFile = this._onDidChangeFile.event;

  constructor(private readonly _config: ConfigManager) {}

  watch(_uri: vscode.Uri, _options: { recursive: boolean; excludes: string[] }): vscode.Disposable {
    return { dispose: () => {} };
  }

  stat(_uri: vscode.Uri): vscode.FileStat {
    return {
      type: vscode.FileType.File,
      ctime: 0,
      mtime: Date.now(),
      size: 0,
    };
  }

  readDirectory(_uri: vscode.Uri): [string, vscode.FileType][] {
    return [];
  }

  createDirectory(_uri: vscode.Uri): void {
    // no-op
  }

  async readFile(uri: vscode.Uri): Promise<Uint8Array> {
    const params = this._parseUri(uri);
    if (!params) {
      return new TextEncoder().encode('');
    }

    const { instanceId, owner, repo, ref, isBase, status } = params;

    // For added files, the base side is empty; for removed files, the head side is empty.
    if ((isBase && status === 'added') || (!isBase && status === 'removed')) {
      return new TextEncoder().encode('');
    }

    const instance = this._config.getInstances().find((i) => i.id === instanceId);
    if (!instance) {
      throw new Error(`Forgejo instance not found: ${instanceId}`);
    }

    try {
      const client = new ForgejoClient(instance.url, instance.token, logger);
      const content = await client.getFileContent(owner, repo, uri.path.replace(/^\//, ''), ref);
      return new TextEncoder().encode(content);
    } catch (error) {
      const err = error instanceof Error ? error.message : String(error);
      if (err.includes('404')) {
        return new TextEncoder().encode('');
      }
      logger.error(`Failed to fetch Forgejo PR file content for ${uri.toString()}: ${err}`);
      throw new Error(`Failed to fetch ${uri.path}@${ref}: ${err}`);
    }
  }

  writeFile(_uri: vscode.Uri, _content: Uint8Array, _options: { create: boolean; overwrite: boolean }): void {
    // no-op
  }

  delete(_uri: vscode.Uri, _options: { recursive: boolean }): void {
    // no-op
  }

  rename(_oldUri: vscode.Uri, _newUri: vscode.Uri, _options: { overwrite: boolean }): void {
    // no-op
  }

  private _parseUri(uri: vscode.Uri): ForgejoPrUriParams | undefined {
    if (!uri.query) {
      return undefined;
    }
    try {
      return JSON.parse(uri.query) as ForgejoPrUriParams;
    } catch {
      return undefined;
    }
  }
}
