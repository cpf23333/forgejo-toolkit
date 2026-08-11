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
    return {
      instanceId,
      owner,
      repo,
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
    const instance = config.getInstances().find((i) => i.id === params.instanceId);
    if (!instance) {
      vscode.window.showWarningMessage(vscode.l10n.t('Forgejo instance not found'));
      return;
    }
    const normalizedUrl = instance.url.replace(/\/$/, '');
    permalink = `${normalizedUrl}/${params.owner}/${params.repo}/blob/${params.ref}/${params.path}${lineRangeFragment(selection)}`;
  } else if (uri.scheme === 'file') {
    const linked = await detectLinkedRepository(config.getInstances());
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
    permalink = `${normalizedUrl}/${linked.owner}/${linked.repo}/blob/${sha}/${relativePath}${lineRangeFragment(selection)}`;
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
