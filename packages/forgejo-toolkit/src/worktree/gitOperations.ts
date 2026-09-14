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
 * command line in error.message, so re-throw an error carrying only git's
 * stderr, which never echoes the command line.
 */
async function runGit(
  args: string[],
  cwd?: string,
  extraEnv?: NodeJS.ProcessEnv,
): Promise<{ stdout: string; stderr: string }> {
  try {
    return await execFile('git', args, { cwd, env: extraEnv ? { ...process.env, ...extraEnv } : process.env });
  } catch (error) {
    const stderr = (error as { stderr?: unknown }).stderr;
    const message = typeof stderr === 'string' && stderr.trim() ? stderr.trim() : 'Git operation failed';
    throw new Error(message);
  }
}

/**
 * Environment that carries the auth token via git's env-based config (not
 * persisted in repo config). Passing the header as `-c http.extraHeader=...`
 * argv would put the token in git's command line, where it is visible in
 * process listings (ps, Task Manager's command-line column) and in
 * process-creation logs (auditd execve, Sysmon/ETW) that are routinely
 * archived. The remaining exposure — same-user reading /proc/<pid>/environ —
 * is identical to the command line's visibility on Linux and requires a
 * targeted local attacker either way. Env config needs git >= 2.31.
 */
function authEnv(token?: string): NodeJS.ProcessEnv | undefined {
  if (!token) {
    return undefined;
  }
  return {
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: 'http.extraHeader',
    GIT_CONFIG_VALUE_0: `Authorization: token ${token}`,
  };
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
  const args = ['push'];
  if (setUpstream) {
    args.push('-u');
  }
  args.push(remote, refspec);
  const { stderr } = await runGit(args, dirPath, authEnv(token));
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
  // Pass the token via env-based per-command config so it is neither persisted
  // in the cloned repository's remote URL nor visible in git's command line.
  // --quiet keeps clone progress out of stderr (huge repos would overflow
  // execFile's 1MB maxBuffer); fatal errors are still printed, so the check
  // below is unaffected.
  const { stderr } = await runGit(['clone', '--bare', '--quiet', url, targetPath], undefined, authEnv(token));
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
  const { stderr } = await runGit(['fetch', remote, `${ref}:${localBranch}`], repoPath, authEnv(token));
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
 * Fetch a single branch from a remote. After this call FETCH_HEAD points at
 * the fetched tip in both regular checkouts and bare cache clones (where
 * `refs/remotes/origin/<branch>` does not exist).
 */
export async function fetchBranch(repoPath: string, remote: string, branch: string, token?: string): Promise<void> {
  const { stderr } = await runGit(['fetch', remote, branch], repoPath, authEnv(token));
  if (stderr && stderr.toLowerCase().includes('error')) {
    throw new Error(stderr);
  }
}

/**
 * Create a worktree on a NEW branch starting at startPoint (e.g. FETCH_HEAD
 * right after fetchBranch, which works in bare caches and regular checkouts
 * alike). `-B` also resets a leftover branch of the same name, so retrying a
 * previously failed start-work flow cannot get stuck on "branch already
 * exists".
 */
export async function createWorktreeWithNewBranch(
  repoPath: string,
  worktreePath: string,
  newBranch: string,
  startPoint: string,
): Promise<void> {
  await fs.promises.mkdir(path.dirname(worktreePath), { recursive: true });
  const { stderr } = await runGit(['worktree', 'add', '-B', newBranch, worktreePath, startPoint], repoPath);
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

/**
 * Revert a merged PR's merge commit and push the result.
 *
 * When `expectedBranch` is given, the current branch must match it — reverting
 * on the wrong branch would push the revert to the wrong place. The push goes
 * through `pushBranch` with the instance token, so the remote is re-validated
 * against the instance (TOCTOU) and credentials are never sent to another host.
 */
export async function revertMergeCommit(
  repoPath: string,
  mergeCommitSha: string,
  expectedBranch?: string,
  token?: string,
  tokenInstanceUrl?: string,
): Promise<void> {
  if (expectedBranch) {
    const currentBranch = await getCurrentBranch(repoPath);
    if (currentBranch !== expectedBranch) {
      throw new Error(
        vscode.l10n.t('Revert aborted: the current branch is not the pull request base branch {0}', expectedBranch),
      );
    }
  }
  const revertResult = await runGit(['revert', '-m', '1', '--no-edit', mergeCommitSha], repoPath);
  if (revertResult.stderr && revertResult.stderr.toLowerCase().includes('error')) {
    throw new Error(revertResult.stderr);
  }
  const upstream = await getUpstreamBranch(repoPath);
  if (upstream && upstream.includes('/')) {
    const [remote, ...branchParts] = upstream.split('/');
    await pushBranch(repoPath, remote, `HEAD:${branchParts.join('/')}`, token, false, tokenInstanceUrl);
  } else {
    await pushBranch(repoPath, 'origin', 'HEAD', token, false, tokenInstanceUrl);
  }
}

export async function openWorktree(worktreePath: string, openInNewWindow: boolean): Promise<boolean> {
  const uri = vscode.Uri.file(worktreePath);
  if (openInNewWindow) {
    await vscode.commands.executeCommand('vscode.openFolder', uri, true);
    return true;
  }
  const currentFolder = vscode.workspace.workspaceFolders?.[0]?.uri;
  if (currentFolder && currentFolder.fsPath === worktreePath) {
    return true;
  }
  const openLabel = vscode.l10n.t('Open');
  const choice = await vscode.window.showWarningMessage(
    vscode.l10n.t('This will replace the current workspace with the worktree. Continue?'),
    { modal: true },
    openLabel,
  );
  if (choice !== openLabel) {
    return false;
  }
  await vscode.commands.executeCommand('vscode.openFolder', uri, false);
  return true;
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

/** True when filePath lies inside folderPath (both absolute). */
function isPathInsideFolder(folderPath: string, filePath: string): boolean {
  const relative = path.relative(folderPath, filePath);
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
}

/**
 * Direct subdirectories of folderPath that are git repositories themselves.
 * One level only: covers the common layouts (a plain folder holding several
 * repos side by side, or a repo with another repo nested inside) without
 * walking deep trees like node_modules.
 */
async function findNestedRepositories(folderPath: string): Promise<string[]> {
  let entries: fs.Dirent[];
  try {
    entries = await fs.promises.readdir(folderPath, { withFileTypes: true });
  } catch {
    return [];
  }
  const repos: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }
    const subPath = path.join(folderPath, entry.name);
    if (await isGitRepository(subPath)) {
      repos.push(subPath);
    }
  }
  return repos.sort();
}

/**
 * All git repositories directly usable from the current workspace: every
 * workspace folder that is a repository plus nested repositories one level
 * below each folder. Used by publish to let the user pick the target repo.
 */
export async function listWorkspaceRepositories(): Promise<string[]> {
  const repos = new Set<string>();
  for (const folder of vscode.workspace.workspaceFolders ?? []) {
    if (await isGitRepository(folder.uri.fsPath)) {
      repos.add(folder.uri.fsPath);
    }
    for (const nested of await findNestedRepositories(folder.uri.fsPath)) {
      repos.add(nested);
    }
  }
  return [...repos];
}

/**
 * Pick the account to bind when several configured instances match the same
 * remote host. Prefer the account whose username matches the remote's owner
 * namespace (pushing to one's own namespace is the common case); otherwise
 * keep the first match. Deterministic so the status bar and commands agree.
 */
export function preferOwnNamespaceInstance(matched: ForgejoInstance[], remoteOwner: string): ForgejoInstance {
  const own = matched.find(
    (instance) => instance.username && instance.username.toLowerCase() === remoteOwner.toLowerCase(),
  );
  return own ?? matched[0];
}

export interface DetectLinkedRepositoryOptions {
  /**
   * Attribute the linked repository to the repo containing this file path
   * (defaults to the active editor's path). Interactive commands operating
   * on a specific file should pass that file's path.
   */
  preferredPath?: string;
  /**
   * When several workspace repositories match configured instances and the
   * preferred path does not attribute one, ask the user to pick. Defaults to
   * false: passive callers (status bar, completion) get the first match.
   */
  pickOnAmbiguity?: boolean;
}

export async function detectLinkedRepository(
  instances: ForgejoInstance[],
  options?: DetectLinkedRepositoryOptions,
): Promise<LinkedRepository | undefined> {
  const folders = [...(vscode.workspace.workspaceFolders ?? [])];
  // In a multi-root workspace, check the folder containing the active editor
  // first: when no single repository can be attributed, the first match
  // should reflect the repository the user is looking at, not whichever
  // folder happens to match first.
  const activePath = vscode.window.activeTextEditor?.document.uri.fsPath;
  if (activePath) {
    folders.sort(
      (a, b) =>
        Number(isPathInsideFolder(b.uri.fsPath, activePath)) - Number(isPathInsideFolder(a.uri.fsPath, activePath)),
    );
  }
  logger.debug(`[detectLinkedRepository] workspace folders: ${folders.map((f) => f.uri.fsPath).join(', ')}`);
  logger.debug(`[detectLinkedRepository] instances: ${instances.map((i) => `${i.id}=${i.url}`).join(', ')}`);

  const candidates = new Set<string>();
  for (const folder of folders) {
    candidates.add(folder.uri.fsPath);
    const gitRoot = await findGitRoot(folder.uri.fsPath);
    if (gitRoot) {
      candidates.add(gitRoot);
    }
    // Nested repositories one level below the folder root (e.g. a plain
    // folder holding several repos, or a repo inside another repo).
    for (const nested of await findNestedRepositories(folder.uri.fsPath)) {
      candidates.add(nested);
    }
  }
  logger.debug(`[detectLinkedRepository] candidates: ${Array.from(candidates).join(', ')}`);

  const matches: LinkedRepository[] = [];
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

    const matched = instances.filter((instance) => {
      let instanceHostPath: string;
      try {
        const parsed = new URL(instance.url);
        instanceHostPath = normalizeGitUrl(`${parsed.host}${parsed.pathname}`);
      } catch {
        return false;
      }
      logger.debug(`[detectLinkedRepository] compare ${remoteInfo.normalized} vs ${instanceHostPath}`);
      return remoteInfo.normalized === instanceHostPath || remoteInfo.normalized.startsWith(`${instanceHostPath}/`);
    });
    if (matched.length === 0) {
      continue;
    }
    // Several accounts on the same host all match the remote; bind explicitly
    // to one (preferring the remote owner's own namespace) so follow-up write
    // operations use a single, logged identity instead of an arbitrary one.
    const chosen = preferOwnNamespaceInstance(matched, remoteInfo.owner);
    if (matched.length > 1) {
      logger.info(
        `[detectLinkedRepository] ${matched.length} accounts match ${remoteUrl}; bound to ${chosen.id} (owner: ${remoteInfo.owner})`,
      );
    }
    logger.debug(`[detectLinkedRepository] matched ${chosen.id}`);
    matches.push({
      instanceId: chosen.id,
      owner: remoteInfo.owner,
      repo: remoteInfo.repo,
      localPath: dirPath,
      remoteUrl,
    });
  }

  if (matches.length === 0) {
    logger.debug('[detectLinkedRepository] no match');
    return undefined;
  }
  if (matches.length > 1) {
    // Attribute by the file the command is operating on (or the active
    // editor): the repository containing that path wins; longest path first
    // so a nested repository beats its enclosing one.
    const attributionPath = options?.preferredPath ?? activePath;
    if (attributionPath) {
      const containing = matches
        .filter((m) => m.localPath === attributionPath || isPathInsideFolder(m.localPath, attributionPath))
        .sort((a, b) => b.localPath.length - a.localPath.length);
      if (containing.length > 0) {
        logger.debug(`[detectLinkedRepository] attributed to ${containing[0].localPath} via ${attributionPath}`);
        return containing[0];
      }
    }
    if (options?.pickOnAmbiguity) {
      const picked = await vscode.window.showQuickPick(
        matches.map((match) => ({
          label: `${match.owner}/${match.repo}`,
          description: match.localPath,
          match,
        })),
        { placeHolder: vscode.l10n.t('Multiple Forgejo repositories found in the workspace. Select one') },
      );
      return picked?.match;
    }
  }
  logger.debug(`[detectLinkedRepository] resolved to ${matches[0].localPath}`);
  return matches[0];
}
