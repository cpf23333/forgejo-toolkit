import * as vscode from 'vscode';
import { ForgejoClient } from './api/client';
import { ConfigManager } from './config';
import { logger } from './logger';

export const REPO_FILE_SCHEME = 'cpf23333-forgejo-toolkit-repofile';

export interface RepoFileUriParams {
  instanceId: string;
  owner: string;
  repo: string;
  ref: string;
  path: string;
}

export function buildRepoFileUri(params: RepoFileUriParams): vscode.Uri {
  return vscode.Uri.from({
    scheme: REPO_FILE_SCHEME,
    path: `/${params.instanceId}/${params.owner}/${params.repo}/${params.path}`,
    query: JSON.stringify({
      ref: params.ref,
    }),
  });
}

function parseRepoFileUri(uri: vscode.Uri): RepoFileUriParams | undefined {
  try {
    const match = uri.path.match(/^\/([^/]+)\/([^/]+)\/([^/]+)\/(.+)$/);
    if (!match) {
      return undefined;
    }
    const [, instanceId, owner, repo, path] = match;
    const query = JSON.parse(uri.query) as { ref?: string };
    if (!query.ref) {
      return undefined;
    }
    return {
      instanceId,
      owner,
      repo,
      ref: query.ref,
      path,
    };
  } catch {
    return undefined;
  }
}

export function base64ToUint8Array(content: string): Uint8Array {
  const binary = Buffer.from(content, 'base64');
  return new Uint8Array(binary.buffer, binary.byteOffset, binary.byteLength);
}

export class RepoFileSystemProvider implements vscode.FileSystemProvider {
  private readonly _onDidChangeFile = new vscode.EventEmitter<vscode.FileChangeEvent[]>();
  public readonly onDidChangeFile = this._onDidChangeFile.event;

  constructor(private readonly _config: ConfigManager) {}

  watch(): vscode.Disposable {
    return new vscode.Disposable(() => {});
  }

  async stat(uri: vscode.Uri): Promise<vscode.FileStat> {
    const params = parseRepoFileUri(uri);
    if (!params) {
      throw vscode.FileSystemError.FileNotFound(uri);
    }

    const instance = this._getInstance(params.instanceId);
    if (!instance) {
      throw vscode.FileSystemError.FileNotFound(uri);
    }

    try {
      const client = new ForgejoClient(instance.url, instance.token, logger, instance.syncApiUrlsToInstanceUrl);
      const entries = await client.getRepoContents(params.owner, params.repo, params.path, params.ref);

      if (entries.length === 0) {
        throw vscode.FileSystemError.FileNotFound(uri);
      }

      if (entries.length > 1 || entries[0].type === 'dir') {
        return {
          type: vscode.FileType.Directory,
          ctime: 0,
          mtime: 0,
          size: 0,
        };
      }

      const entry = entries[0];
      return {
        type: vscode.FileType.File,
        ctime: 0,
        mtime: 0,
        size: entry.size ?? 0,
      };
    } catch (error) {
      const err = error instanceof Error ? error.message : String(error);
      logger.error(`stat failed for ${uri.toString()}: ${err}`);
      throw vscode.FileSystemError.FileNotFound(uri);
    }
  }

  async readDirectory(uri: vscode.Uri): Promise<[string, vscode.FileType][]> {
    const params = parseRepoFileUri(uri);
    if (!params) {
      throw vscode.FileSystemError.FileNotFound(uri);
    }

    const instance = this._getInstance(params.instanceId);
    if (!instance) {
      throw vscode.FileSystemError.FileNotFound(uri);
    }

    try {
      const client = new ForgejoClient(instance.url, instance.token, logger, instance.syncApiUrlsToInstanceUrl);
      const entries = await client.getRepoContents(params.owner, params.repo, params.path, params.ref);

      return entries.map((entry): [string, vscode.FileType] => [
        entry.name ?? '',
        entry.type === 'dir' ? vscode.FileType.Directory : vscode.FileType.File,
      ]);
    } catch (error) {
      const err = error instanceof Error ? error.message : String(error);
      logger.error(`readDirectory failed for ${uri.toString()}: ${err}`);
      throw vscode.FileSystemError.FileNotFound(uri);
    }
  }

  async readFile(uri: vscode.Uri): Promise<Uint8Array> {
    const params = parseRepoFileUri(uri);
    if (!params) {
      throw vscode.FileSystemError.FileNotFound(uri);
    }

    const instance = this._getInstance(params.instanceId);
    if (!instance) {
      throw vscode.FileSystemError.FileNotFound(uri);
    }

    try {
      const client = new ForgejoClient(instance.url, instance.token, logger, instance.syncApiUrlsToInstanceUrl);
      const entries = await client.getRepoContents(params.owner, params.repo, params.path, params.ref);
      const entry = entries[0];

      if (!entry || entry.type !== 'file' || !entry.content) {
        throw vscode.FileSystemError.FileNotFound(uri);
      }

      return base64ToUint8Array(entry.content);
    } catch (error) {
      const err = error instanceof Error ? error.message : String(error);
      logger.error(`readFile failed for ${uri.toString()}: ${err}`);
      throw vscode.FileSystemError.FileNotFound(uri);
    }
  }

  createDirectory(): void {
    throw vscode.FileSystemError.NoPermissions();
  }

  writeFile(): void {
    throw vscode.FileSystemError.NoPermissions();
  }

  delete(): void {
    throw vscode.FileSystemError.NoPermissions();
  }

  rename(): void {
    throw vscode.FileSystemError.NoPermissions();
  }

  private _getInstance(instanceId: string) {
    return this._config.getInstances().find((i) => i.id === instanceId);
  }
}

export function registerRepoFileProvider(
  context: vscode.ExtensionContext,
  config: ConfigManager,
): RepoFileSystemProvider {
  const provider = new RepoFileSystemProvider(config);
  context.subscriptions.push(
    vscode.workspace.registerFileSystemProvider(REPO_FILE_SCHEME, provider, { isReadonly: true }),
  );
  return provider;
}
