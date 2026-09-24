import * as vscode from 'vscode';
import { ForgejoClient } from './api/client';
import { userFacingErrorMessage } from './api/errors';
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

export class ForgejoPrDiffFileSystemProvider implements vscode.FileSystemProvider {
  private readonly _onDidChangeFile = new vscode.EventEmitter<vscode.FileChangeEvent[]>();
  public readonly onDidChangeFile = this._onDidChangeFile.event;

  constructor(private readonly _config: ConfigManager) {}

  watch(_uri: vscode.Uri, _options: { recursive: boolean; excludes: string[] }): vscode.Disposable {
    return { dispose: () => {} };
  }

  stat(uri: vscode.Uri): vscode.FileStat {
    // A URI this provider cannot parse names no file at all (see _requireUri):
    // reporting `File` with size 0 for one made `stat` claim an entry that
    // `readFile` could not serve, and the editor then opened an empty document
    // for a URI that is not one of ours.
    this._requireUri(uri);
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
    throw this._readOnlyError();
  }

  async readFile(uri: vscode.Uri): Promise<Uint8Array> {
    const params = this._requireUri(uri);

    const { instanceId, owner, repo, ref, isBase, status } = params;

    // For added files, the base side is empty; for removed files, the head side is empty.
    if ((isBase && status === 'added') || (!isBase && status === 'removed')) {
      return new Uint8Array(0);
    }

    const instance = this._config.getInstances().find((i) => i.id === instanceId);
    if (!instance) {
      throw new Error(vscode.l10n.t('Forgejo instance not found: {0}', instanceId));
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
      // A 404 used to be reported as empty bytes, which is indistinguishable
      // from a genuinely empty side: the diff then showed every line of the file
      // as added (head side missing) or as removed (base side missing). The
      // causes are real — a force-pushed or gc'd sha, a path that no longer
      // exists at that ref, a token that lost access — and the file provider
      // must not invent content for any of them. Same policy as
      // `RepoFileSystemProvider.readFile`, which reports the failure instead.
      const err = userFacingErrorMessage(error);
      logger.error(`Failed to fetch Forgejo PR file content for ${uri.toString()}: ${err}`);
      throw vscode.FileSystemError.Unavailable(vscode.l10n.t('Could not load {0} at {1}: {2}', params.path, ref, err));
    }
  }

  writeFile(_uri: vscode.Uri, _content: Uint8Array, _options: { create: boolean; overwrite: boolean }): void {
    throw this._readOnlyError();
  }

  delete(_uri: vscode.Uri, _options: { recursive: boolean }): void {
    throw this._readOnlyError();
  }

  rename(_oldUri: vscode.Uri, _newUri: vscode.Uri, _options: { overwrite: boolean }): void {
    throw this._readOnlyError();
  }

  /**
   * A PR diff file is served from the instance and is registered read-only, so
   * every mutating operation has to fail loudly. The previous no-ops let the
   * editor believe a save succeeded while nothing was written anywhere —
   * `RepoFileSystemProvider` refuses the same three operations, and the two
   * providers must not disagree about what a write does.
   */
  private _readOnlyError(): vscode.FileSystemError {
    return vscode.FileSystemError.NoPermissions();
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

  /**
   * The parsed parameters, or `FileNotFound` when the URI is not one this
   * provider builds. `readFile` and `stat` both go through this so they can
   * never disagree about a URI neither of them can serve.
   */
  private _requireUri(uri: vscode.Uri): ForgejoPrUriParams {
    const params = this._parseUri(uri);
    if (!params) {
      throw vscode.FileSystemError.FileNotFound(uri);
    }
    return params;
  }
}
