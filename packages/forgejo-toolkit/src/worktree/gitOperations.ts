import * as cp from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { promisify } from 'util';
import type { ForgejoInstance, LinkedRepository } from '@cpf23333-forgejo-toolkit/shared/webview/messages';
import { isSshOrGitRemote, normalizeGitRemote, normalizeGitUrl } from '@cpf23333-forgejo-toolkit/shared/git/url';
import { ForgejoClient } from '../api/client';
import { createTimedCache } from '../utils/timedCache';
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
 * SSH/git remotes carry a transport-level port that has no relation to the
 * instance's web port (self-hosted servers often serve SSH on 2222 while the
 * web UI runs on 3000), so for them the instance URL's port is ignored;
 * http(s) remotes keep the strict host-plus-port comparison.
 */
export function remoteMatchesInstance(remoteUrl: string, instanceUrl: string): boolean {
  const remoteInfo = normalizeGitRemote(remoteUrl);
  if (!remoteInfo) {
    return false;
  }
  let instanceHostPaths: string[];
  try {
    const parsed = new URL(instanceUrl);
    instanceHostPaths = [normalizeGitUrl(`${parsed.host}${parsed.pathname}`)];
    if (isSshOrGitRemote(remoteUrl)) {
      instanceHostPaths.push(normalizeGitUrl(`${parsed.hostname}${parsed.pathname}`));
    }
  } catch {
    return false;
  }
  return instanceHostPaths.some(
    (hostPath) => remoteInfo.normalized === hostPath || remoteInfo.normalized.startsWith(`${hostPath}/`),
  );
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

/**
 * Every URL git would actually push to for `remote`, in git's own order.
 *
 * A remote configured with `remote.<name>.pushurl` (or rewritten by
 * `url.<base>.pushInsteadOf`) pushes to those URLs while `git remote get-url`
 * keeps reporting the *fetch* URL. Resolving the push targets explicitly is
 * what makes the token-host guard in pushBranch meaningful: validating the
 * fetch URL alone would let a mirror push receive the access token.
 *
 * `undefined` means the push target could not be resolved at all (unknown
 * remote, missing git); callers must treat that as "do not send the token".
 */
export async function getRemotePushUrls(dirPath: string, remote: string): Promise<string[] | undefined> {
  try {
    const { stdout } = await runGit(['remote', 'get-url', '--push', '--all', remote], dirPath);
    const urls = stdout
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
    return urls.length > 0 ? urls : undefined;
  } catch {
    return undefined;
  }
}

export interface GitRemoteEntry {
  name: string;
  url: string;
}

/**
 * All remote URLs of the repository at dirPath, one entry per remote/URL pair
 * reported by `git remote -v` (fetch and push lines included). Repositories
 * often carry several remotes (e.g. an upstream mirror plus a Forgejo
 * remote), so detection must look beyond origin. Entries are deduplicated and
 * origin's come first, so callers iterating in order keep origin's priority.
 */
export async function listRemotes(dirPath: string): Promise<GitRemoteEntry[]> {
  let stdout: string;
  try {
    ({ stdout } = await runGit(['remote', '-v'], dirPath));
  } catch {
    return [];
  }
  const seen = new Set<string>();
  const entries: GitRemoteEntry[] = [];
  for (const line of stdout.split('\n')) {
    // `git remote -v` prints "<name>\t<url> (fetch)" / " (push)" and quotes
    // nothing, so a URL may contain spaces (local-path remotes such as
    // "/home/me/My Repos/x.git" or "D:\repos\my repo"): split off the name at
    // the first tab and strip the trailing operation suffix instead of
    // requiring a whitespace-free URL.
    const trimmed = line.trim();
    const tabIndex = trimmed.indexOf('\t');
    if (tabIndex <= 0) {
      continue;
    }
    const name = trimmed.slice(0, tabIndex);
    const urlMatch = /^(.*) \((?:fetch|push)\)$/.exec(trimmed.slice(tabIndex + 1));
    if (!urlMatch || urlMatch[1].length === 0) {
      continue;
    }
    const url = urlMatch[1];
    const key = `${name}\0${url}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    entries.push({ name, url });
  }
  entries.sort((a, b) => Number(b.name === 'origin') - Number(a.name === 'origin'));
  return entries;
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
      const remotes = await listRemotes(candidate);
      const matches = remotes.some((remote) =>
        expectedUrls.some((url) => normalizeGitUrl(remote.url) === normalizeGitUrl(url)),
      );
      if (matches) {
        return candidate;
      }
    }
  }

  return undefined;
}

/**
 * Resolve the name of the remote in dirPath whose URL points at
 * {instanceUrl}/{owner}/{repo} (with or without the .git suffix). Fetching
 * must go through the matching remote rather than a hardcoded 'origin':
 * with several remotes, 'origin' may point at a fork or a different host.
 * listRemotes orders 'origin' first, so it wins when several remotes match.
 */
export async function resolveRemoteForRepo(
  dirPath: string,
  instanceUrl: string,
  owner: string,
  repo: string,
): Promise<string | undefined> {
  const normalizedInstanceUrl = instanceUrl.replace(/\/$/, '');
  const expectedUrls = new Set(
    [`${normalizedInstanceUrl}/${owner}/${repo}.git`, `${normalizedInstanceUrl}/${owner}/${repo}`].map((url) =>
      normalizeGitUrl(url),
    ),
  );
  const remotes = await listRemotes(dirPath);
  return remotes.find((remote) => expectedUrls.has(normalizeGitUrl(remote.url)))?.name;
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
 * When both `token` and `tokenInstanceUrl` are given, the *push* targets are
 * re-resolved immediately before the push (they may have changed since the
 * caller checked — TOCTOU) and every one of them must belong to that instance;
 * a mismatch aborts the push so the token is never sent to another host, and
 * an unresolvable target degrades to a tokenless push. `git remote get-url`
 * alone is not enough here: `remote.<name>.pushurl` and
 * `url.<base>.pushInsteadOf` make git push somewhere the fetch URL does not
 * mention.
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
    const pushUrls = await getRemotePushUrls(dirPath, remote);
    if (pushUrls === undefined) {
      token = undefined;
    } else if (!pushUrls.every((url) => remoteMatchesInstance(url, tokenInstanceUrl))) {
      // Do not include the URL in the message: it may embed credentials.
      throw new Error(
        `Push aborted: the push target of remote "${remote}" does not belong to the expected Forgejo instance (check remote.<name>.pushurl)`,
      );
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

/**
 * Throwaway branch naming used for PR worktrees (`pr-<n>-<sha7>`, the same
 * name WorktreeManager.removeWorktree deletes). The pattern guard keeps a
 * real user branch safe when a stale directory somehow has one checked out.
 */
const PR_THROWAWAY_BRANCH_PATTERN = /^pr-\d+-[0-9a-f]{7}$/;

/** Local work a forced stale-worktree removal would destroy. */
export interface StalePrWorktreeInfo {
  /** Branch checked out in the leftover worktree (undefined when detached). */
  branch?: string;
  /** Uncommitted changes (tracked or untracked) in the leftover worktree. */
  dirty: boolean;
  /** Commits reachable from its HEAD but not from the expected PR head sha. */
  commitsAhead: number;
}

export type PrWorktreeInspection =
  | { state: 'missing' }
  | { state: 'current' }
  | { state: 'stale'; info: StalePrWorktreeInfo };

/**
 * Inspect a leftover worktree directory against the expected PR head sha.
 * 'current' means the directory is checked out at expectedSha and can be
 * reused; 'missing' means there is nothing on disk; 'stale' means it does not
 * match and carries what a discard would destroy.
 *
 * Inspection deliberately does not touch the filesystem: `git worktree remove
 * --force` deletes dirty worktrees and the throwaway branch delete drops local
 * commits, so the decision to discard belongs to the caller, which can confirm
 * with the user first (see discardStalePrWorktree).
 */
export async function inspectPrWorktree(worktreePath: string, expectedSha: string): Promise<PrWorktreeInspection> {
  const exists = await fs.promises.access(worktreePath).then(
    () => true,
    () => false,
  );
  if (!exists) {
    return { state: 'missing' };
  }
  const sha = await getCurrentCommitSha(worktreePath);
  if (sha && sha === expectedSha) {
    return { state: 'current' };
  }

  const [branch, dirty, commitsAhead] = await Promise.all([
    getCurrentBranch(worktreePath),
    isWorktreeDirty(worktreePath),
    countCommitsAhead(worktreePath, expectedSha),
  ]);
  return { state: 'stale', info: { branch, dirty, commitsAhead } };
}

/** Uncommitted (tracked or untracked) changes in a leftover worktree. */
async function isWorktreeDirty(worktreePath: string): Promise<boolean> {
  try {
    const { stdout } = await runGit(['status', '--porcelain'], worktreePath);
    return stdout.trim().length > 0;
  } catch {
    // `git status` failed, so dirt cannot be ruled out by inspection. A
    // directory without a `.git` entry is a broken leftover with nothing
    // tracked in it, which stays deletable without a prompt; one that does
    // claim to be a worktree but cannot be read (repository on an unavailable
    // drive, corrupt gitdir) must fail closed and let the caller confirm.
    return await fs.promises.access(path.join(worktreePath, '.git')).then(
      () => true,
      () => false,
    );
  }
}

/**
 * Commits reachable from the worktree's HEAD but not from the expected sha.
 * An unresolvable expected sha (unknown ref, non-sha value) counts as zero:
 * blocking every discard on an unrelated git failure would strand the flow.
 */
async function countCommitsAhead(worktreePath: string, expectedSha: string): Promise<number> {
  if (!/^[0-9a-f]{7,40}$/i.test(expectedSha)) {
    return 0;
  }
  try {
    const { stdout } = await runGit(['rev-list', '--count', `${expectedSha}..HEAD`], worktreePath);
    const count = Number.parseInt(stdout.trim(), 10);
    return Number.isNaN(count) || count < 0 ? 0 : count;
  } catch {
    return 0;
  }
}

/**
 * Destructive: remove a leftover PR worktree and, when it is the throwaway
 * `pr-<n>-<sha7>` branch, delete that branch too. `git worktree remove` never
 * removes branches, and once the caller overwrites the worktree record with
 * the new head sha the old branch name is no longer derivable and would leak
 * forever. Callers must confirm with the user first whenever
 * inspectPrWorktree reported `dirty` work or local commits
 * (see StalePrWorktreeInfo): the forced removal discards both.
 */
export async function discardStalePrWorktree(repoPath: string, worktreePath: string, branch?: string): Promise<void> {
  await removeWorktreeAndPrune(repoPath, worktreePath);
  if (branch && PR_THROWAWAY_BRANCH_PATTERN.test(branch)) {
    await deleteBranch(repoPath, branch).catch(() => undefined);
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
  const remotes = await listRemotes(candidate);
  if (remotes.length === 0) {
    return undefined;
  }
  const normalizedInstanceUrl = instanceUrl.replace(/\/$/, '');
  const expectedUrls = [`${normalizedInstanceUrl}/${owner}/${repo}.git`, `${normalizedInstanceUrl}/${owner}/${repo}`];
  const matches = remotes.some((remote) =>
    expectedUrls.some((url) => normalizeGitUrl(remote.url) === normalizeGitUrl(url)),
  );
  if (matches) {
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

/** Resolve an arbitrary ref (branch, tag, sha) to the commit sha it points at. */
export async function getRefCommitSha(repoPath: string, ref: string): Promise<string | undefined> {
  try {
    const { stdout } = await runGit(['rev-parse', '--verify', `${ref}^{commit}`], repoPath);
    const sha = stdout.trim();
    return sha || undefined;
  } catch {
    return undefined;
  }
}

export async function deleteBranch(repoPath: string, branch: string): Promise<void> {
  const { stderr } = await runGit(['branch', '-D', branch], repoPath);
  if (stderr && stderr.toLowerCase().includes('error')) {
    throw new Error(stderr);
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
  expectedRepo?: { owner: string; repo: string },
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
  const remote = upstream && upstream.includes('/') ? upstream.split('/')[0] : 'origin';
  const remoteBranch = upstream && upstream.includes('/') ? upstream.split('/').slice(1).join('/') : undefined;
  if (expectedRepo) {
    // remoteMatchesInstance (in pushBranch) only proves the remote is on the
    // same host; a fork or any other repository on the same instance would
    // pass that check and receive the revert push. Require the push remote to
    // point at the pull request's own repository (Forgejo owner/repo names
    // are case-insensitive).
    const remoteUrl = await getRemoteUrl(repoPath, remote);
    const remoteInfo = remoteUrl ? normalizeGitRemote(remoteUrl) : undefined;
    if (
      !remoteInfo ||
      remoteInfo.owner.toLowerCase() !== expectedRepo.owner.toLowerCase() ||
      remoteInfo.repo.toLowerCase() !== expectedRepo.repo.toLowerCase()
    ) {
      throw new Error(
        vscode.l10n.t(
          'Revert aborted: the {0} remote does not point at {1}/{2}',
          remote,
          expectedRepo.owner,
          expectedRepo.repo,
        ),
      );
    }
  }
  if (remoteBranch) {
    await pushBranch(repoPath, remote, `HEAD:${remoteBranch}`, token, false, tokenInstanceUrl);
  } else {
    await pushBranch(repoPath, 'origin', 'HEAD', token, false, tokenInstanceUrl);
  }
}

export async function openWorktree(
  worktreePath: string,
  openInNewWindow: boolean,
  beforeOpenInCurrentWindow?: () => Promise<void>,
): Promise<boolean> {
  const uri = vscode.Uri.file(worktreePath);
  if (openInNewWindow) {
    await vscode.commands.executeCommand('vscode.openFolder', uri, true);
    return true;
  }
  const currentFolder = vscode.workspace.workspaceFolders?.[0]?.uri;
  if (currentFolder && pathsEqual(currentFolder.fsPath, worktreePath)) {
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
  // vscode.openFolder with forceNewWindow=false reloads the window and tears
  // down this extension host, so anything that must still happen (persisting
  // the worktree record) has to run before the command, not after it.
  await beforeOpenInCurrentWindow?.();
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
export function isPathInsideFolder(folderPath: string, filePath: string): boolean {
  const relative = path.relative(folderPath, filePath);
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
}

/**
 * Path equality that tolerates Windows drive-letter casing (`C:` vs `c:`):
 * the filesystem is case-insensitive there, so a strict string compare would
 * treat the same directory as different.
 */
function pathsEqual(a: string, b: string): boolean {
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
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

// Repo-path fallback binding results, keyed by normalized remote plus an
// instance-list fingerprint. Both positive and negative outcomes are cached:
// detectLinkedRepository runs on passive paths (status bar, mention
// completion, dashboard), and an unmatched remote would otherwise cost one
// API probe per configured instance on every call.
const repoPathBindingCache = createTimedCache<string | null>(60_000);

/**
 * Fallback binding for self-hosted instances reachable under several network
 * addresses (LAN IP, VPN alias, public domain): when no configured instance
 * host matches the remote, ask each instance whether it actually serves
 * owner/repo. Returns the instance id to bind to, or null when no instance
 * verifies. Never throws; probes are cached briefly either way.
 */
async function resolveInstanceByRepoPath(
  instances: ForgejoInstance[],
  remoteInfo: { normalized: string; owner: string; repo: string },
): Promise<string | null> {
  const cacheKey = `${remoteInfo.normalized}|${instances.map((i) => `${i.id}=${i.url}`).join(',')}`;
  const cached = repoPathBindingCache.get(cacheKey);
  if (cached !== undefined) {
    return cached;
  }
  const results = await Promise.all(
    instances.map(async (instance) => {
      const client = new ForgejoClient(instance.url, instance.token, logger, instance.syncApiUrlsToInstanceUrl);
      return (await client.probeRepository(remoteInfo.owner, remoteInfo.repo)) ? instance.id : undefined;
    }),
  );
  const verified = results.filter((id): id is string => id !== undefined);
  let bound: string | null = null;
  if (verified.length === 1) {
    bound = verified[0];
    logger.info(`[detectLinkedRepository] bound ${remoteInfo.normalized} to ${bound} via repo-path fallback`);
  } else if (verified.length > 1) {
    bound = verified[0];
    logger.info(
      `[detectLinkedRepository] ${verified.length} instances serve ${remoteInfo.normalized}; bound to first (${bound}) via repo-path fallback`,
    );
  }
  repoPathBindingCache.set(cacheKey, bound);
  return bound;
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

export interface DetectLinkedRepositoriesResult {
  /** The repository the calling context is attributed to (may be undefined). */
  linked: LinkedRepository | undefined;
  /** Every workspace repository linked to a configured instance. */
  all: LinkedRepository[];
  /**
   * Workspace git repositories with no remote host-matching a configured
   * instance (no Forgejo remote yet — either remote-less or pointing
   * elsewhere). Drives the Publish to Forgejo button's visibility: it only
   * makes sense while at least one repository is not on Forgejo yet.
   */
  unpublished: string[];
}

/**
 * The options-independent half of detection: which workspace repositories
 * match a configured instance, and which have no Forgejo remote yet. Which
 * match becomes `linked` depends on the call's options and is recomputed per
 * call from the cached scan.
 */
interface LinkedRepositoryScan {
  matches: LinkedRepository[];
  unpublished: string[];
}

// Short-TTL cache for the expensive half of detectLinkedRepositories:
// candidate enumeration (fs probes), one `git remote -v` per candidate, and
// pass-2 API probing (resolveInstanceByRepoPath, itself cached a bit longer).
// The status bar, the webview provider, and mention completion all trigger
// detection on the same events; without a shared cache each consumer spawns
// its own git subprocess burst per tab switch. The key covers the post-sort
// folder order (the active editor only reorders the scan; attribution is
// recomputed per call) and the instance id/url list, so instance add/remove
// and workspace-folder changes miss on their own. A token-only change keeps
// the same key, which is why onInstancesChanged handlers must call
// clearLinkedRepositoryCache.
const LINKED_REPOSITORY_SCAN_TTL_MS = 10_000;
const linkedRepositoryScanCache = createTimedCache<LinkedRepositoryScan>(LINKED_REPOSITORY_SCAN_TTL_MS);
let linkedRepositoryScanInFlight: { key: string; promise: Promise<LinkedRepositoryScan> } | undefined;

/**
 * Drop every cached detection result (the workspace scan and the repo-path
 * fallback bindings). Called when the instance configuration changes; also
 * used by tests to isolate cases from each other.
 */
export function clearLinkedRepositoryCache(): void {
  linkedRepositoryScanCache.clear();
  repoPathBindingCache.clear();
}

async function scanLinkedRepositories(
  instances: ForgejoInstance[],
  folders: vscode.WorkspaceFolder[],
): Promise<LinkedRepositoryScan> {
  const key = JSON.stringify([folders.map((folder) => folder.uri.fsPath), instances.map((i) => [i.id, i.url])]);
  const cached = linkedRepositoryScanCache.get(key);
  if (cached) {
    return cached;
  }
  // Coalesce concurrent callers with the same key (the status bar and the
  // webview fire on the same debounced events): one scan, shared result.
  if (linkedRepositoryScanInFlight?.key === key) {
    return linkedRepositoryScanInFlight.promise;
  }
  const promise = doScanLinkedRepositories(instances, folders);
  linkedRepositoryScanInFlight = { key, promise };
  try {
    const scan = await promise;
    linkedRepositoryScanCache.set(key, scan);
    return scan;
  } finally {
    if (linkedRepositoryScanInFlight?.promise === promise) {
      linkedRepositoryScanInFlight = undefined;
    }
  }
}

async function doScanLinkedRepositories(
  instances: ForgejoInstance[],
  folders: vscode.WorkspaceFolder[],
): Promise<LinkedRepositoryScan> {
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
  const unpublished: string[] = [];
  for (const dirPath of candidates) {
    // A repository may carry several remotes (fork upstreams, mirrors, a
    // Forgejo remote next to a non-Forgejo origin): link against any of them,
    // with origin taking priority (listRemotes orders it first).
    const remotes = await listRemotes(dirPath);
    logger.debug(
      `[detectLinkedRepository] remotes for ${dirPath}: ${remotes.map((r) => `${r.name}=${r.url}`).join(', ') || 'none'}`,
    );
    const remoteInfos: { entry: GitRemoteEntry; info: NonNullable<ReturnType<typeof normalizeGitRemote>> }[] = [];
    for (const entry of remotes) {
      const info = normalizeGitRemote(entry.url);
      logger.debug(`[detectLinkedRepository] normalized remote ${entry.name}: ${info?.normalized ?? 'invalid'}`);
      if (info) {
        remoteInfos.push({ entry, info });
      }
    }

    let linked: LinkedRepository | undefined;
    // A repository "has a Forgejo remote" when any remote's host matches a
    // configured instance (pass-1 semantics, no API calls). Repositories
    // without one are publish candidates for the Publish to Forgejo button.
    let hasForgejoRemote = false;
    // Pass 1: host match across all remotes; cheap (no API calls). Uses the
    // same matching rules as remoteMatchesInstance (SSH/git remotes ignore
    // the instance URL's web port).
    for (const { entry, info } of remoteInfos) {
      const matched = instances.filter((instance) => {
        const matchesInstance = remoteMatchesInstance(entry.url, instance.url);
        logger.debug(`[detectLinkedRepository] compare ${info.normalized} vs ${instance.url}: ${matchesInstance}`);
        return matchesInstance;
      });
      if (matched.length === 0) {
        continue;
      }
      hasForgejoRemote = true;
      // Several accounts on the same host all match the remote; bind explicitly
      // to one (preferring the remote owner's own namespace) so follow-up write
      // operations use a single, logged identity instead of an arbitrary one.
      const chosen = preferOwnNamespaceInstance(matched, info.owner);
      if (matched.length > 1) {
        logger.info(
          `[detectLinkedRepository] ${matched.length} accounts match ${entry.url}; bound to ${chosen.id} (owner: ${info.owner})`,
        );
      }
      logger.debug(`[detectLinkedRepository] matched ${chosen.id}`);
      linked = { instanceId: chosen.id, owner: info.owner, repo: info.repo, localPath: dirPath, remoteUrl: entry.url };
      break;
    }
    // Pass 2: self-hosted servers are often reachable under several network
    // addresses; when no host matches any remote, verify owner/repo against
    // each configured instance instead of giving up on this candidate.
    if (!linked) {
      for (const { entry, info } of remoteInfos) {
        const fallbackId = await resolveInstanceByRepoPath(instances, info);
        if (!fallbackId) {
          continue;
        }
        logger.debug(`[detectLinkedRepository] matched ${fallbackId}`);
        linked = {
          instanceId: fallbackId,
          owner: info.owner,
          repo: info.repo,
          localPath: dirPath,
          remoteUrl: entry.url,
        };
        break;
      }
    }
    if (linked) {
      matches.push(linked);
    }
    // A repository linked via the pass-2 repo-path fallback is on Forgejo
    // even though no remote host-matched, so it must not count as unpublished.
    if (!hasForgejoRemote && !linked && (await isGitRepository(dirPath))) {
      unpublished.push(dirPath);
    }
  }

  return { matches, unpublished };
}

export async function detectLinkedRepositories(
  instances: ForgejoInstance[],
  options?: DetectLinkedRepositoryOptions,
): Promise<DetectLinkedRepositoriesResult> {
  const folders = [...(vscode.workspace.workspaceFolders ?? [])];
  // In a multi-root workspace, check the folder containing the active editor
  // first: when no single repository can be attributed, the first match
  // should reflect the repository the user is looking at, not whichever
  // folder happens to match first. The sort only reorders the (cached) scan;
  // attribution below is recomputed on every call.
  const activePath = vscode.window.activeTextEditor?.document.uri.fsPath;
  if (activePath) {
    folders.sort(
      (a, b) =>
        Number(isPathInsideFolder(b.uri.fsPath, activePath)) - Number(isPathInsideFolder(a.uri.fsPath, activePath)),
    );
  }
  const { matches, unpublished } = await scanLinkedRepositories(instances, folders);

  if (matches.length === 0) {
    logger.debug('[detectLinkedRepository] no match');
    return { linked: undefined, all: matches, unpublished };
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
        return { linked: containing[0], all: matches, unpublished };
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
      return { linked: picked?.match, all: matches, unpublished };
    }
  }
  logger.debug(`[detectLinkedRepository] resolved to ${matches[0].localPath}`);
  return { linked: matches[0], all: matches, unpublished };
}

export async function detectLinkedRepository(
  instances: ForgejoInstance[],
  options?: DetectLinkedRepositoryOptions,
): Promise<LinkedRepository | undefined> {
  return (await detectLinkedRepositories(instances, options)).linked;
}
