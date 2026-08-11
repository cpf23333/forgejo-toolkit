import * as cp from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { promisify } from 'util';
import type { ForgejoInstance, LinkedRepository } from '@cpf23333-forgejo-toolkit/shared/webview/messages';
import { normalizeGitRemote, normalizeGitUrl } from '@cpf23333-forgejo-toolkit/shared/git/url';
import { logger } from '../logger';

const exec = promisify(cp.exec);

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
    const { stdout } = await exec(`git remote get-url ${remote}`, { cwd: dirPath });
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

export async function cloneRepository(url: string, targetPath: string, token?: string): Promise<void> {
  await fs.promises.mkdir(path.dirname(targetPath), { recursive: true });
  const cloneUrl = token ? injectTokenIntoUrl(url, token) : url;
  const { stderr } = await exec(`git clone --bare "${cloneUrl}" "${targetPath}"`);
  if (stderr && stderr.toLowerCase().includes('error')) {
    throw new Error(stderr);
  }
}

export async function fetchPullRequestHead(
  repoPath: string,
  remote: string,
  prIndex: number,
  localBranch: string,
): Promise<void> {
  const ref = `refs/pull/${prIndex}/head`;
  const { stderr } = await exec(`git fetch ${remote} ${ref}:${localBranch}`, { cwd: repoPath });
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
  const { stderr } = await exec(`git worktree add -B ${localBranch} "${worktreePath}" ${localBranch}`, {
    cwd: repoPath,
  });
  if (stderr && stderr.toLowerCase().includes('error')) {
    throw new Error(stderr);
  }
}

export async function createWorktree(repoPath: string, worktreePath: string, branch: string): Promise<void> {
  await fs.promises.mkdir(path.dirname(worktreePath), { recursive: true });
  const { stderr } = await exec(`git worktree add "${worktreePath}" ${branch}`, { cwd: repoPath });
  if (stderr && stderr.toLowerCase().includes('error')) {
    throw new Error(stderr);
  }
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

export async function revertMergeCommit(repoPath: string, mergeCommitSha: string): Promise<void> {
  const revertResult = await exec(`git revert -m 1 --no-edit ${mergeCommitSha}`, { cwd: repoPath });
  if (revertResult.stderr && revertResult.stderr.toLowerCase().includes('error')) {
    throw new Error(revertResult.stderr);
  }
  const pushResult = await exec('git push', { cwd: repoPath });
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
    const choice = await vscode.window.showWarningMessage(
      'This will replace the current workspace with the worktree. Continue?',
      { modal: true },
      'Open',
    );
    if (choice !== 'Open') {
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

function injectTokenIntoUrl(url: string, token: string): string {
  try {
    const parsed = new URL(url);
    parsed.username = token;
    parsed.password = '';
    return parsed.toString();
  } catch {
    return url;
  }
}
