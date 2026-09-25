import * as vscode from 'vscode';
import { ForgejoClient } from './api/client';
import type { ForgejoContentEntry } from './api/types';
import { userFacingErrorMessage } from './api/errors';
import { ConfigManager } from './config';
import { logger } from './logger';
import { base64ToUint8Array, unreadableEntryError } from './repoFileProvider';
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
 * Parse a `forgejo-pr` URI into the parameters the diff views carry, or
 * `undefined` when the URI is not one this extension builds. This is the single
 * strict parser for the scheme: the file system provider, the review-comment
 * controller and the permalink command all consume these URIs, and the three
 * used to parse them with different fallbacks (an unparseable index degrading
 * to 0, a missing ref degrading to the default branch). The fallbacks were
 * dropped because both mislabel what the URI addresses — "PR 0" names no pull
 * request, and the contents endpoint answers an empty ref with the *default
 * branch* while the URI claims a specific sha — so a URI missing either is
 * invalid outright (the same refusal repoFileProvider.ts applies).
 *
 * One deliberate exception: `prDecorationProvider.ts` keeps its own lenient
 * `parseUri`, because it only reads the `status` field to pick a decoration
 * badge — a malformed URI degrading to "no decoration" is harmless, while the
 * consumers above address content and comments, where a misread parameter
 * would show the wrong data.
 */
export function parseForgejoPrUri(uri: vscode.Uri): ForgejoPrUriParams | undefined {
  if (uri.scheme !== FORGEJO_PR_SCHEME || !uri.query) {
    return undefined;
  }
  try {
    const query = JSON.parse(uri.query) as Partial<ForgejoPrUriParams>;
    const pathMatch = uri.path.match(/^\/([^/]+)\/([^/]+)\/([^/]+)\/(.+)$/);
    if (!pathMatch) {
      return undefined;
    }
    const [, instanceId, owner, repo, filepath] = pathMatch;
    // Only a number or a numeric string: `Number(query.index)` alone would
    // also accept `true` (→ 1) and `null` (→ 0).
    const index =
      typeof query.index === 'number'
        ? query.index
        : typeof query.index === 'string'
          ? Number(query.index)
          : Number.NaN;
    if (!Number.isInteger(index) || index < 1) {
      return undefined;
    }
    if (!query.ref) {
      return undefined;
    }
    return {
      instanceId,
      owner,
      repo,
      index,
      ref: query.ref,
      path: filepath,
      isBase: query.isBase ?? false,
      status: query.status,
    };
  } catch {
    return undefined;
  }
}

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
      // A FileSystemError, like every other failure this provider reports (and
      // like the sibling repo provider at repoFileProvider.ts): a plain Error
      // bypasses VS Code's file-system error handling.
      throw vscode.FileSystemError.FileNotFound(vscode.l10n.t('Forgejo instance not found: {0}', instanceId));
    }

    // Only the fetch itself is wrapped: the entry interpretation below throws
    // this provider's own FileSystemErrors, and routing those through the
    // catch would re-wrap a deliberate FileNotFound/Unavailable as a generic
    // load failure.
    let entries: ForgejoContentEntry[];
    try {
      const client = new ForgejoClient(instance.url, instance.token, logger, instance.syncApiUrlsToInstanceUrl);
      entries = await client.getRepoContents(owner, repo, params.path, ref);
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

    const entry = entries[0];
    // A single entry is only this file when the API echoed the requested path;
    // otherwise the URI named a directory and the answer is its listing, whose
    // first child must not be served as this file's content (the same echo
    // check `RepoFileSystemProvider.readFile` applies).
    if (!entry || entry.path !== params.path || entry.type === 'dir') {
      throw vscode.FileSystemError.FileNotFound(uri);
    }
    if (entry.type !== 'file') {
      // A symlink or submodule echoed back for the requested path carries no
      // blob of its own; explain that (with the same localized error the repo
      // provider serves) instead of failing with an untranslated generic Error.
      // A server that does provide the payload owns the answer: serve it.
      if (entry.content) {
        return base64ToUint8Array(entry.content);
      }
      throw unreadableEntryError(entry.type ?? 'file');
    }
    if (!entry.content) {
      const notice = missingPayloadNotice(entry.size);
      return notice ? new TextEncoder().encode(`${notice}\n`) : new Uint8Array(0);
    }
    // Decode base64 straight to bytes: routing binary content through a
    // UTF-8 string would corrupt it.
    return base64ToUint8Array(entry.content);
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

  /**
   * The parsed parameters, or `FileNotFound` when the URI is not one this
   * provider builds. `readFile` and `stat` both go through this so they can
   * never disagree about a URI neither of them can serve.
   */
  private _requireUri(uri: vscode.Uri): ForgejoPrUriParams {
    const params = parseForgejoPrUri(uri);
    if (!params) {
      throw vscode.FileSystemError.FileNotFound(uri);
    }
    return params;
  }
}
