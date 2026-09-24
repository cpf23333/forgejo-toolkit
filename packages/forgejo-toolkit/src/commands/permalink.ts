import * as vscode from 'vscode';
import * as path from 'path';
import type { ConfigManager } from '../config';
import { detectLinkedRepository, getCurrentCommitSha } from '../worktree/gitOperations';
import { FORGEJO_PR_SCHEME, type ForgejoPrUriParams } from '../prFileSystemProvider';

function parseForgejoPrUri(uri: vscode.Uri): ForgejoPrUriParams | undefined {
  if (uri.scheme !== FORGEJO_PR_SCHEME) {
    return undefined;
  }
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

function lineRangeFragment(selection: vscode.Selection): string {
  const start = selection.start.line + 1;
  const end = selection.end.line + 1;
  if (start === end) {
    return `#L${start}`;
  }
  return `#L${start}-L${end}`;
}

/**
 * Encode a repository file path for use in a web URL. Each `/` segment is
 * percent-encoded so names containing `#`, `?`, `%`, spaces, or non-ASCII
 * characters do not break the link, while the `/` separators stay intact.
 */
export function encodePermalinkPath(filePath: string): string {
  return filePath
    .split('/')
    .map((segment) => encodeURIComponent(segment))
    .join('/');
}

export async function copyPermalink(config: ConfigManager): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    vscode.window.showWarningMessage(vscode.l10n.t('No active editor'));
    return;
  }

  const uri = editor.document.uri;
  const selection = editor.selection;
  let permalink: string | undefined;

  if (uri.scheme === FORGEJO_PR_SCHEME) {
    const params = parseForgejoPrUri(uri);
    if (!params) {
      vscode.window.showWarningMessage(vscode.l10n.t('Unable to parse Forgejo PR file URI'));
      return;
    }
    // The permalink points at a blob on the ref this side belongs to, and one
    // side of the pair is empty for a file the PR added or removed: the base ref
    // has no blob for an added file, and the head ref has none for a removed
    // one. Copying then hands out a URL that resolves to a 404, so both cases
    // are refused with the reason.
    if (params.isBase && params.status === 'added') {
      vscode.window.showWarningMessage(
        vscode.l10n.t('This file was added in the pull request and does not exist on the base ref'),
      );
      return;
    }
    if (!params.isBase && params.status === 'removed') {
      vscode.window.showWarningMessage(
        vscode.l10n.t('This file was removed in the pull request and does not exist on the head ref'),
      );
      return;
    }
    const instance = config.getInstances().find((i) => i.id === params.instanceId);
    if (!instance) {
      vscode.window.showWarningMessage(vscode.l10n.t('Forgejo instance not found'));
      return;
    }
    const normalizedUrl = instance.url.replace(/\/$/, '');
    permalink = `${normalizedUrl}/${params.owner}/${params.repo}/blob/${params.ref}/${encodePermalinkPath(params.path)}${lineRangeFragment(selection)}`;
  } else if (uri.scheme === 'file') {
    // Attribute to the repository containing the target file so nested
    // repositories in the same workspace resolve to their own remote.
    const linked = await detectLinkedRepository(config.getInstances(), { preferredPath: uri.fsPath });
    if (!linked) {
      vscode.window.showWarningMessage(vscode.l10n.t('No linked Forgejo repository found for the current workspace'));
      return;
    }
    const instance = config.getInstances().find((i) => i.id === linked.instanceId);
    if (!instance) {
      vscode.window.showWarningMessage(vscode.l10n.t('Forgejo instance not found'));
      return;
    }
    const sha = await getCurrentCommitSha(linked.localPath);
    if (!sha) {
      vscode.window.showWarningMessage(vscode.l10n.t('Unable to determine current commit SHA'));
      return;
    }
    const relativePath = path.relative(linked.localPath, uri.fsPath).replace(/\\/g, '/');
    if (!relativePath || relativePath.startsWith('..')) {
      vscode.window.showWarningMessage(vscode.l10n.t('The current file is outside the linked repository'));
      return;
    }
    const normalizedUrl = instance.url.replace(/\/$/, '');
    permalink = `${normalizedUrl}/${linked.owner}/${linked.repo}/blob/${sha}/${encodePermalinkPath(relativePath)}${lineRangeFragment(selection)}`;
  } else {
    vscode.window.showWarningMessage(vscode.l10n.t('Permalink is not supported for this file type'));
    return;
  }

  if (!permalink) {
    return;
  }

  await vscode.env.clipboard.writeText(permalink);
  vscode.window.showInformationMessage(vscode.l10n.t('Permalink copied to clipboard'));
}
