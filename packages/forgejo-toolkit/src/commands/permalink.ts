import * as vscode from 'vscode';
import * as path from 'path';
import type { ConfigManager } from '../config';
import { detectLinkedRepository, getCurrentCommitSha, runGit } from '../worktree/gitOperations';
import { FORGEJO_PR_SCHEME, parseForgejoPrUri } from '../prFileSystemProvider';
import { stripUrlUserinfo } from '../utils/redactUrlUserinfo';

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

/**
 * Whether any remote-tracking branch of the repository contains `sha`, or
 * undefined when git cannot answer (git missing, repository unreadable). A
 * blob URL built from a HEAD commit no remote branch contains resolves to a
 * 404 on the instance, so the caller warns about the link instead of failing
 * the copy: the commit may be pushed any moment, and an unanswerable check
 * must not block copying. The sha comes from the local `rev-parse`, so it is
 * trusted and needs no validation of its own.
 */
async function isCommitOnRemoteBranch(repoPath: string, sha: string): Promise<boolean | undefined> {
  try {
    const { stdout } = await runGit(['branch', '--remotes', '--contains', sha], repoPath);
    return stdout.trim().length > 0;
  } catch {
    return undefined;
  }
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
  // True only when git positively reported the commit as absent from every
  // remote-tracking branch; an unanswerable check stays false (see
  // isCommitOnRemoteBranch).
  let commitMayBeUnpushed = false;

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
    // The configured instance URL may embed a credential as userinfo, and this
    // string goes to the clipboard as a link someone else follows: the userinfo
    // is stripped, not masked. A mask would leave `***@host` in the URL the user
    // pastes, which is not a usable credential and breaks the link for them.
    // The helper re-serializes an absolute URL (appending a trailing slash for a
    // bare origin), so the trailing slash is trimmed afterwards to keep the join
    // below from producing a double slash.
    const normalizedUrl = stripUrlUserinfo(instance.url).replace(/\/$/, '');
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
    const normalizedUrl = stripUrlUserinfo(instance.url).replace(/\/$/, '');
    permalink = `${normalizedUrl}/${linked.owner}/${linked.repo}/blob/${sha}/${encodePermalinkPath(relativePath)}${lineRangeFragment(selection)}`;
    // The blob URL names the local HEAD commit. Until that commit is pushed,
    // the link resolves to a 404 for anyone following it — the copy still
    // happens (the user may be about to push), but the confirmation says the
    // link is not live yet.
    commitMayBeUnpushed = (await isCommitOnRemoteBranch(linked.localPath, sha)) === false;
  } else {
    vscode.window.showWarningMessage(vscode.l10n.t('Permalink is not supported for this file type'));
    return;
  }

  if (!permalink) {
    return;
  }

  await vscode.env.clipboard.writeText(permalink);
  if (commitMayBeUnpushed) {
    vscode.window.showInformationMessage(
      vscode.l10n.t('Permalink copied to clipboard (the commit may not be pushed yet)'),
    );
  } else {
    vscode.window.showInformationMessage(vscode.l10n.t('Permalink copied to clipboard'));
  }
}
