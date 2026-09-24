import * as vscode from 'vscode';
import { ForgejoClient } from './api/client';
import { ApiError } from './api/errors';
import { ConfigManager } from './config';
import { logger } from './logger';
import { base64ToUint8Array } from './repoFileProvider';
import { missingPayloadNotice } from './utils/payloadNotice';

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

/**
 * The notice served in place of a file whose payload Forgejo withheld. Kept
 * re-exported here because this provider (and the diff view) were its first
 * users; the implementation lives in `utils/payloadNotice` so the repository
 * file provider can use it without a circular import.
 */
export { missingPayloadNotice } from './utils/payloadNotice';

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
      // Constant mtime: URIs are content-addressed by sha, so changed content
      // means a changed URI; a varying mtime would only make VS Code re-read.
      mtime: 0,
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
      return new Uint8Array(0);
    }

    const { instanceId, owner, repo, ref, isBase, status } = params;

    // For added files, the base side is empty; for removed files, the head side is empty.
    if ((isBase && status === 'added') || (!isBase && status === 'removed')) {
      return new Uint8Array(0);
    }

    const instance = this._config.getInstances().find((i) => i.id === instanceId);
    if (!instance) {
      throw new Error(`Forgejo instance not found: ${instanceId}`);
    }

    try {
      const client = new ForgejoClient(instance.url, instance.token, logger, instance.syncApiUrlsToInstanceUrl);
      const entries = await client.getRepoContents(owner, repo, params.path, ref);
      const entry = entries[0];
      if (!entry || entry.type !== 'file') {
        throw new Error(`Unexpected contents response for ${params.path}@${ref}`);
      }
      if (!entry.content) {
        const notice = missingPayloadNotice(entry.size);
        return notice ? new TextEncoder().encode(`${notice}\n`) : new Uint8Array(0);
      }
      // Decode base64 straight to bytes: routing binary content through a
      // UTF-8 string would corrupt it.
      return base64ToUint8Array(entry.content);
    } catch (error) {
      if (error instanceof ApiError && error.status === 404) {
        return new Uint8Array(0);
      }
      const err = error instanceof Error ? error.message : String(error);
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
