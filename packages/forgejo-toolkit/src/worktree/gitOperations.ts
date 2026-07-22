import * as cp from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { promisify } from 'util';

const exec = promisify(cp.exec);

export async function isGitRepository(dirPath: string): Promise<boolean> {
  try {
    const stat = await fs.promises.stat(path.join(dirPath, '.git'));
    return stat.isDirectory();
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

function normalizeGitUrl(url: string): string {
  return url
    .replace(/\.git\/$/, '')
    .replace(/\.git$/, '')
    .replace(/\/+$/, '')
    .toLowerCase();
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
