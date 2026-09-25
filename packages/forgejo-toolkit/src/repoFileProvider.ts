import * as vscode from 'vscode';
import { ForgejoClient } from './api/client';
import { apiErrorUserMessage, toApiError } from './api/errors';
import { ConfigManager } from './config';
import { logger } from './logger';
import { missingPayloadNotice } from './utils/payloadNotice';

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

/**
 * The errors this provider throws for a path it has itself judged absent. They
 * must pass through the catch below untouched, and a `FileSystemError` cannot
 * carry a marker of ours, so the instances are tracked by identity.
 */
const absentPaths = new WeakSet<object>();

function absentPathError(uri: vscode.Uri): vscode.FileSystemError {
  const error = vscode.FileSystemError.FileNotFound(uri);
  absentPaths.add(error);
  return error;
}

/**
 * Converts a failed contents request into the error the editor should show.
 *
 * A "file not found" answer is only truthful for a real 404 (or a path this
 * provider itself judged absent); a revoked token, a rate limit or an outage
 * must say so instead of looking like a missing file. `Unavailable` is used
 * because VS Code surfaces a file-system provider error's message to the user,
 * so the localized API reason actually reaches them.
 */
function repoFileReadFailure(uri: vscode.Uri, error: unknown): vscode.FileSystemError {
  if (typeof error === 'object' && error !== null && absentPaths.has(error)) {
    return error as vscode.FileSystemError;
  }
  const apiError = toApiError(error);
  if (apiError.kind === 'http' && apiError.status === 404) {
    return absentPathError(uri);
  }
  logger.error(`repo file request failed for ${uri.toString()}: ${apiError.rawMessage}`);
  return vscode.FileSystemError.Unavailable(apiErrorUserMessage(apiError));
}

/**
 * The error for a listed entry that carries no readable content of its own.
 *
 * `stat` and `readDirectory` report a symlink or a submodule as a plain file so
 * a listing entry stays openable rather than becoming a row that swallows the
 * click, but neither has a blob the contents endpoint can serve: a submodule
 * entry carries only the recorded commit and a symlink's `content` is its
 * target, not a file body. This error says which of the two it is and what the
 * user can do instead, rather than reporting the path as missing — a listed
 * entry is not a missing one, and `FileNotFound` for a path the same provider
 * just reported as existing is what made the three methods disagree.
 *
 * Exported for the PR diff provider (`prFileSystemProvider.ts`), whose
 * `readFile` must answer the same entry kinds the same way.
 */
export function unreadableEntryError(type: string): vscode.FileSystemError {
  const what =
    type === 'submodule'
      ? vscode.l10n.t('This path is a git submodule, which has no file content to open')
      : vscode.l10n.t('This path is a symbolic link, whose stored content is only its link target');
  return vscode.FileSystemError.Unavailable(vscode.l10n.t('{0}. Open the repository on the server to view it.', what));
}

/**
 * How one contents entry is reported to the editor.
 *
 * `dir` is the only type that is not a file: every other type the API can
 * answer with (`file`, `symlink`, `submodule`, and anything a future server
 * adds) is reported as `FileType.File` so it stays a navigable row, and
 * `readFile` decides whether it has readable content. Reporting a listed entry
 * as a type the editor then refuses to open is the mismatch this prevents.
 */
function entryFileType(entry: { type?: string }): vscode.FileType {
  return entry.type === 'dir' ? vscode.FileType.Directory : vscode.FileType.File;
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
        throw absentPathError(uri);
      }

      // The contents endpoint answers with the requested entry alone when the
      // path names a file, and with its children when it names a directory — so a
      // directory holding exactly one child would otherwise be reported as that
      // child. Comparing the reported path with the requested one tells them
      // apart (`entries[0].path` echoes the request for a file).
      const isDirectory = entries.length > 1 || entries[0].type === 'dir' || entries[0].path !== params.path;

      if (isDirectory) {
        return {
          type: vscode.FileType.Directory,
          ctime: 0,
          mtime: 0,
          size: 0,
        };
      }

      const entry = entries[0];
      return {
        // A symlink or submodule echoed back by the contents endpoint is
        // reported as a file, exactly as `readDirectory` lists it, so `stat`
        // never contradicts the listing; `readFile` explains why it cannot be
        // opened. See entryFileType.
        type: entryFileType(entry),
        ctime: 0,
        mtime: 0,
        size: entry.size ?? 0,
      };
    } catch (error) {
      throw repoFileReadFailure(uri, error);
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

      return entries.map((entry): [string, vscode.FileType] => [entry.name ?? '', entryFileType(entry)]);
    } catch (error) {
      throw repoFileReadFailure(uri, error);
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

      // A single entry is only this file when the API echoed the requested path;
      // otherwise the path named a directory with one child (see `stat`).
      if (!entry || entry.path !== params.path) {
        throw absentPathError(uri);
      }
      if (entry.type === 'dir') {
        // The request named a directory that echoed its own path: a directory is
        // not a file to read, and `stat` reports it as one.
        throw absentPathError(uri);
      }

      if (entry.type !== 'file') {
        // A `symlink` or a `submodule` is listed as a file by `stat` and
        // `readDirectory` so its row stays openable, but neither has a blob the
        // contents endpoint serves: a submodule entry carries only the recorded
        // commit, and a symlink's `content` is its target rather than a file
        // body. Reporting FileNotFound here answered "the entry you were just
        // shown does not exist" for a path that does exist.
        if (entry.content) {
          // A server that does provide the payload owns the answer: serve it
          // rather than second-guessing the entry type.
          return base64ToUint8Array(entry.content);
        }
        throw unreadableEntryError(entry.type ?? 'file');
      }

      if (!entry.content) {
        // An empty `content` means one of two things, and they must not look
        // alike: Forgejo withholds the payload of files above
        // `[api] DEFAULT_MAX_BLOB_SIZE` (reporting the real `size` instead), in
        // which case the reader gets the same explanation the diff view serves,
        // or the file really is empty and opens as an empty document. Reporting
        // "file not found" for either was wrong.
        const notice = missingPayloadNotice(entry.size);
        return notice ? new TextEncoder().encode(`${notice}\n`) : new Uint8Array(0);
      }

      return base64ToUint8Array(entry.content);
    } catch (error) {
      throw repoFileReadFailure(uri, error);
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
