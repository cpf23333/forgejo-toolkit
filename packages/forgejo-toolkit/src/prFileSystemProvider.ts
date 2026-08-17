import * as vscode from 'vscode';
import { ForgejoClient } from './api/client';
import { ConfigManager } from './config';
import { logger } from './logger';

export interface ForgejoPrUriParams {
  instanceId: string;
  owner: string;
  repo: string;
  /** Pull request index (number) used to fetch reviews and line comments. */
  index: number;
  ref: string;
  path: string;
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
      const client = new ForgejoClient(instance.url, instance.token, logger, instance.syncApiUrlsToInstanceUrl);
      const content = await client.getFileContent(owner, repo, params.path, ref);
      return new TextEncoder().encode(content);
    } catch (error) {
      const err = error instanceof Error ? error.message : String(error);
      if (err.includes('404')) {
        return new TextEncoder().encode('');
      }
      logger.error(`Failed to fetch Forgejo PR file content for ${uri.toString()}: ${err}`);
      throw new Error(`Failed to fetch ${params.path}@${ref}: ${err}`);
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
      const query = JSON.parse(uri.query) as Partial<ForgejoPrUriParams>;
      const pathMatch = uri.path.match(/^\/([^/]+)\/([^/]+)\/([^/]+)\/(.+)$/);
      if (!pathMatch) {
        return undefined;
      }
      const [, instanceId, owner, repo, filepath] = pathMatch;
      const index = typeof query.index === 'number' ? query.index : Number(query.index);
      return {
        instanceId,
        owner,
        repo,
        index: Number.isNaN(index) ? 0 : index,
        ref: query.ref ?? '',
        path: filepath,
        isBase: query.isBase ?? false,
        status: query.status,
      };
    } catch {
      return undefined;
    }
  }
}
