import * as cp from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { promisify } from 'util';
import type { ForgejoInstance, LinkedRepository } from '@cpf23333-forgejo-toolkit/shared/webview/messages';
import { normalizeGitRemote, normalizeGitUrl } from '@cpf23333-forgejo-toolkit/shared/git/url';
import { logger } from '../logger';

const execFile = promisify(cp.execFile);

/**
 * Run git with an argument array (no shell, so ref/path arguments cannot be
 * used for shell injection). On failure, cp.execFile errors embed the full
 * command line in error.message — which would leak the token passed via
 * `-c http.extraHeader` — so re-throw an error carrying only git's stderr,
 * which never echoes the command line.
 */
async function runGit(args: string[], cwd?: string): Promise<{ stdout: string; stderr: string }> {
  try {
    return await execFile('git', args, { cwd });
  } catch (error) {
    const stderr = (error as { stderr?: unknown }).stderr;
    const message = typeof stderr === 'string' && stderr.trim() ? stderr.trim() : 'Git operation failed';
    throw new Error(message);
  }
}

/** Arguments that carry the auth token via a per-command header (not persisted in repo config). */
function authArgs(token?: string): string[] {
  return token ? ['-c', `http.extraHeader=Authorization: token ${token}`] : [];
}

/**
 * True when remoteUrl points at the Forgejo instance identified by
 * instanceUrl (host plus any sub-path the instance is deployed under).
 */
export function remoteMatchesInstance(remoteUrl: string, instanceUrl: string): boolean {
  const remoteInfo = normalizeGitRemote(remoteUrl);
  if (!remoteInfo) {
    return false;
  }
  let instanceHostPath: string;
  try {
    const parsed = new URL(instanceUrl);
    instanceHostPath = normalizeGitUrl(`${parsed.host}${parsed.pathname}`);
  } catch {
    return false;
  }
  return remoteInfo.normalized === instanceHostPath || remoteInfo.normalized.startsWith(`${instanceHostPath}/`);
}

export async function isGitRepository(dirPath: string): Promise<boolean> {
  try {
    await fs.promises.access(path.join(dirPath, '.git'));
    return true;
  } catch {
    return false;
  }
}

export async function getRemoteUrl(dirPath: string, remote = 'origin'): Promise<string | undefined> {
  try {
    const { stdout } = await runGit(['remote', 'get-url', remote], dirPath);
    return stdout.trim();
  } catch {
    return undefined;
  }
}

export async function findLocalRepo(instanceUrl: string, owner: string, repo: string): Promise<string | undefined> {
  const normalizedInstanceUrl = instanceUrl.replace(/\/$/, '');
  const expectedUrls = [`${normalizedInstanceUrl}/${owner}/${repo}.git`, `${normalizedInstanceUrl}/${owner}/${repo}`];

  const candidates = new Set<string>();
  for (const folder of vscode.workspace.workspaceFolders ?? []) {
    candidates.add(folder.uri.fsPath);
    candidates.add(path.dirname(folder.uri.fsPath));
  }

  for (const candidate of candidates) {
    if (await isGitRepository(candidate)) {
      const remote = await getRemoteUrl(candidate);
      if (remote && expectedUrls.some((url) => normalizeGitUrl(remote) === normalizeGitUrl(url))) {
        return candidate;
      }
    }
  }

  return undefined;
}

export async function addRemote(dirPath: string, remote: string, url: string): Promise<void> {
  const { stderr } = await runGit(['remote', 'add', remote, url], dirPath);
  if (stderr && stderr.toLowerCase().includes('error')) {
    throw new Error(stderr);
  }
}

export async function getCurrentBranch(dirPath: string): Promise<string | undefined> {
  try {
    const { stdout } = await runGit(['rev-parse', '--abbrev-ref', 'HEAD'], dirPath);
    const branch = stdout.trim();
    // A detached HEAD makes git print "HEAD" instead of a branch name.
    return branch && branch !== 'HEAD' ? branch : undefined;
  } catch {
    return undefined;
  }
}

export async function getUpstreamBranch(dirPath: string): Promise<string | undefined> {
  try {
    const { stdout } = await runGit(['rev-parse', '--abbrev-ref', '@{upstream}'], dirPath);
    return stdout.trim() || undefined;
  } catch {
    return undefined;
  }
}

/**
 * Push a branch to a remote. `refspec` is usually just the branch name, but a
 * `local:remote` refspec pushes the local branch to a differently-named remote
 * branch (used when the upstream branch was renamed on the remote).
 *
 * When both `token` and `tokenInstanceUrl` are given, the remote URL is
 * re-resolved immediately before the push (it may have changed since the
 * caller checked — TOCTOU) and must belong to that instance; a mismatch
 * aborts the push so the token is never sent to another host, and an
 * unresolvable URL degrades to a tokenless push.
 */
export async function pushBranch(
  dirPath: string,
  remote: string,
  refspec: string,
  token?: string,
  setUpstream = false,
  tokenInstanceUrl?: string,
): Promise<void> {
  if (token && tokenInstanceUrl) {
    const remoteUrl = await getRemoteUrl(dirPath, remote);
    if (remoteUrl === undefined) {
      token = undefined;
    } else if (!remoteMatchesInstance(remoteUrl, tokenInstanceUrl)) {
      // Do not include the URL in the message: it may embed credentials.
      throw new Error(`Push aborted: remote "${remote}" does not belong to the expected Forgejo instance`);
    }
  }
  const args = [...authArgs(token), 'push'];
  if (setUpstream) {
    args.push('-u');
  }
  args.push(remote, refspec);
  const { stderr } = await runGit(args, dirPath);
  if (stderr && stderr.toLowerCase().includes('error')) {
    throw new Error(stderr);
  }
}

/**
 * Number of commits on HEAD that are not yet pushed to its upstream. Undefined
 * when the upstream ref cannot be resolved (e.g. the remote-tracking branch is
 * missing because the remote branch was deleted).
 */
export async function getAheadCount(dirPath: string): Promise<number | undefined> {
  try {
    const { stdout } = await runGit(['rev-list', '--count', '@{upstream}..HEAD'], dirPath);
    const count = Number.parseInt(stdout.trim(), 10);
    return Number.isNaN(count) ? undefined : count;
  } catch {
    return undefined;
  }
}

/**
 * Absolute path of the HEAD file for the repository at dirPath. Linked
 * worktrees have a .git file whose "gitdir:" pointer locates the real gitdir
 * (where HEAD lives); regular checkouts use <dirPath>/.git/HEAD.
 */
export async function getGitHeadPath(dirPath: string): Promise<string | undefined> {
  try {
    const gitPath = path.join(dirPath, '.git');
    const stat = await fs.promises.stat(gitPath);
    if (stat.isDirectory()) {
      return path.join(gitPath, 'HEAD');
    }
    const content = await fs.promises.readFile(gitPath, 'utf8');
    const match = /^gitdir:\s*(.+)$/m.exec(content);
    if (!match) {
      return undefined;
    }
    const gitdir = match[1].trim();
    return path.join(path.isAbsolute(gitdir) ? gitdir : path.resolve(dirPath, gitdir), 'HEAD');
  } catch {
    return undefined;
  }
}

export async function cloneRepository(url: string, targetPath: string, token?: string): Promise<void> {
  await fs.promises.mkdir(path.dirname(targetPath), { recursive: true });
  // Pass the token via a per-command header so it is not persisted in the
  // cloned repository's remote URL.
  const { stderr } = await runGit([...authArgs(token), 'clone', '--bare', url, targetPath]);
  if (stderr && stderr.toLowerCase().includes('error')) {
    throw new Error(stderr);
  }
}

export async function fetchPullRequestHead(
  repoPath: string,
  remote: string,
  prIndex: number,
  localBranch: string,
  token?: string,
): Promise<void> {
  const ref = `refs/pull/${prIndex}/head`;
  const { stderr } = await runGit([...authArgs(token), 'fetch', remote, `${ref}:${localBranch}`], repoPath);
  if (stderr && stderr.toLowerCase().includes('error')) {
    throw new Error(stderr);
  }
}

export async function createWorktreeFromBranch(
  repoPath: string,
  worktreePath: string,
  localBranch: string,
): Promise<void> {
  await fs.promises.mkdir(path.dirname(worktreePath), { recursive: true });
  const { stderr } = await runGit(['worktree', 'add', '-B', localBranch, worktreePath, localBranch], repoPath);
  if (stderr && stderr.toLowerCase().includes('error')) {
    throw new Error(stderr);
  }
}

export async function createWorktree(repoPath: string, worktreePath: string, branch: string): Promise<void> {
  await fs.promises.mkdir(path.dirname(worktreePath), { recursive: true });
  const { stderr } = await runGit(['worktree', 'add', worktreePath, branch], repoPath);
  if (stderr && stderr.toLowerCase().includes('error')) {
    throw new Error(stderr);
  }
}

/**
 * Remove a linked worktree. Runs `git worktree remove --force` in the source
 * repository so the .git/worktrees metadata and the branch's checked-out state
 * are cleaned up. If that fails (e.g. the directory was already deleted or git
 * refuses to remove it), falls back to `git worktree prune` plus a manual
 * directory delete. The original removal error is rethrown when the fallback
 * also fails.
 */
export async function removeWorktreeAndPrune(repoPath: string, worktreePath: string): Promise<void> {
  try {
    await runGit(['worktree', 'remove', '--force', worktreePath], repoPath);
    return;
  } catch (removeError) {
    try {
      await runGit(['worktree', 'prune'], repoPath);
      await fs.promises.rm(worktreePath, { recursive: true, force: true });
      return;
    } catch {
      throw removeError;
    }
  }
}

export type PrWorktreeState = 'current' | 'stale' | 'missing';

/**
 * Validate a leftover worktree directory against the expected PR head sha.
 * 'current' means the directory is checked out at expectedSha and can be
 * reused; 'stale' means it did not match and has been removed so the caller
 * can recreate it from scratch; 'missing' means there is nothing on disk.
 */
export async function validatePrWorktree(
  repoPath: string,
  worktreePath: string,
  expectedSha: string,
): Promise<PrWorktreeState> {
  const exists = await fs.promises.access(worktreePath).then(
    () => true,
    () => false,
  );
  if (!exists) {
    return 'missing';
  }
  const sha = await getCurrentCommitSha(worktreePath);
  if (sha && sha === expectedSha) {
    return 'current';
  }
  await removeWorktreeAndPrune(repoPath, worktreePath);
  return 'stale';
}

export async function isCurrentWorkspaceBaseRepo(
  instanceUrl: string,
  owner: string,
  repo: string,
): Promise<string | undefined> {
  const firstFolder = vscode.workspace.workspaceFolders?.[0];
  if (!firstFolder) {
    return undefined;
  }
  const candidate = firstFolder.uri.fsPath;
  if (!(await isGitRepository(candidate))) {
    return undefined;
  }
  const remote = await getRemoteUrl(candidate);
  if (!remote) {
    return undefined;
  }
  const normalizedInstanceUrl = instanceUrl.replace(/\/$/, '');
  const expectedUrls = [`${normalizedInstanceUrl}/${owner}/${repo}.git`, `${normalizedInstanceUrl}/${owner}/${repo}`];
  if (expectedUrls.some((url) => normalizeGitUrl(remote) === normalizeGitUrl(url))) {
    return candidate;
  }
  return undefined;
}

export function sanitizeForPath(title: string): string {
  return title
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fa5]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 50);
}

export async function getCurrentCommitSha(repoPath: string): Promise<string | undefined> {
  try {
    const { stdout } = await runGit(['rev-parse', 'HEAD'], repoPath);
    const sha = stdout.trim();
    return sha || undefined;
  } catch {
    return undefined;
  }
}

export async function revertMergeCommit(repoPath: string, mergeCommitSha: string): Promise<void> {
  const revertResult = await runGit(['revert', '-m', '1', '--no-edit', mergeCommitSha], repoPath);
  if (revertResult.stderr && revertResult.stderr.toLowerCase().includes('error')) {
    throw new Error(revertResult.stderr);
  }
  const pushResult = await runGit(['push'], repoPath);
  if (pushResult.stderr && pushResult.stderr.toLowerCase().includes('error')) {
    throw new Error(pushResult.stderr);
  }
}

export async function openWorktree(worktreePath: string, openInNewWindow: boolean): Promise<void> {
  const uri = vscode.Uri.file(worktreePath);
  if (openInNewWindow) {
    await vscode.commands.executeCommand('vscode.openFolder', uri, true);
  } else {
    const currentFolder = vscode.workspace.workspaceFolders?.[0]?.uri;
    if (currentFolder && currentFolder.fsPath === worktreePath) {
      return;
    }
    const openLabel = vscode.l10n.t('Open');
    const choice = await vscode.window.showWarningMessage(
      vscode.l10n.t('This will replace the current workspace with the worktree. Continue?'),
      { modal: true },
      openLabel,
    );
    if (choice !== openLabel) {
      return;
    }
    await vscode.commands.executeCommand('vscode.openFolder', uri, false);
  }
}

async function findGitRoot(startPath: string): Promise<string | undefined> {
  let current = startPath;
  const root = path.parse(current).root;
  while (current !== root) {
    if (await isGitRepository(current)) {
      return current;
    }
    const parent = path.dirname(current);
    if (parent === current) {
      break;
    }
    current = parent;
  }
  return undefined;
}

export async function detectLinkedRepository(instances: ForgejoInstance[]): Promise<LinkedRepository | undefined> {
  const folders = vscode.workspace.workspaceFolders ?? [];
  logger.debug(`[detectLinkedRepository] workspace folders: ${folders.map((f) => f.uri.fsPath).join(', ')}`);
  logger.debug(`[detectLinkedRepository] instances: ${instances.map((i) => `${i.id}=${i.url}`).join(', ')}`);

  const candidates = new Set<string>();
  for (const folder of folders) {
    candidates.add(folder.uri.fsPath);
    const gitRoot = await findGitRoot(folder.uri.fsPath);
    if (gitRoot) {
      candidates.add(gitRoot);
    }
  }
  logger.debug(`[detectLinkedRepository] candidates: ${Array.from(candidates).join(', ')}`);

  for (const dirPath of candidates) {
    const remoteUrl = await getRemoteUrl(dirPath);
    logger.debug(`[detectLinkedRepository] remote for ${dirPath}: ${remoteUrl ?? 'none'}`);
    if (!remoteUrl) {
      continue;
    }
    const remoteInfo = normalizeGitRemote(remoteUrl);
    logger.debug(`[detectLinkedRepository] normalized remote: ${remoteInfo?.normalized ?? 'invalid'}`);
    if (!remoteInfo) {
      continue;
    }

    for (const instance of instances) {
      let instanceHostPath: string;
      try {
        const parsed = new URL(instance.url);
        instanceHostPath = normalizeGitUrl(`${parsed.host}${parsed.pathname}`);
      } catch {
        continue;
      }
      logger.debug(`[detectLinkedRepository] compare ${remoteInfo.normalized} vs ${instanceHostPath}`);
      if (remoteInfo.normalized === instanceHostPath || remoteInfo.normalized.startsWith(`${instanceHostPath}/`)) {
        logger.debug(`[detectLinkedRepository] matched ${instance.id}`);
        return {
          instanceId: instance.id,
          owner: remoteInfo.owner,
          repo: remoteInfo.repo,
          localPath: dirPath,
          remoteUrl,
        };
      }
    }
  }
  logger.debug('[detectLinkedRepository] no match');
  return undefined;
}
