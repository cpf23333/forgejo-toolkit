import * as cp from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { promisify } from 'util';
import type { ForgejoInstance, LinkedRepository } from '@cpf23333-forgejo-toolkit/shared/webview/messages';
import { normalizeGitRemote, normalizeGitUrl } from '@cpf23333-forgejo-toolkit/shared/git/url';
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
    const match = /^(\S+)\t(\S+) \((?:fetch|push)\)$/.exec(line.trim());
    if (!match) {
      continue;
    }
    const key = `${match[1]}\0${match[2]}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    entries.push({ name: match[1], url: match[2] });
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
  const cacheKey = `${remoteInfo.normalized}|${instances.map((i) => i.id).join(',')}`;
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
}

export async function detectLinkedRepositories(
  instances: ForgejoInstance[],
  options?: DetectLinkedRepositoryOptions,
): Promise<DetectLinkedRepositoriesResult> {
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
    // Pass 1: host match across all remotes; cheap (no API calls).
    for (const { entry, info } of remoteInfos) {
      const matched = instances.filter((instance) => {
        let instanceHostPath: string;
        try {
          const parsed = new URL(instance.url);
          instanceHostPath = normalizeGitUrl(`${parsed.host}${parsed.pathname}`);
        } catch {
          return false;
        }
        logger.debug(`[detectLinkedRepository] compare ${info.normalized} vs ${instanceHostPath}`);
        return info.normalized === instanceHostPath || info.normalized.startsWith(`${instanceHostPath}/`);
      });
      if (matched.length === 0) {
        continue;
      }
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
  }

  if (matches.length === 0) {
    logger.debug('[detectLinkedRepository] no match');
    return { linked: undefined, all: matches };
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
        return { linked: containing[0], all: matches };
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
      return { linked: picked?.match, all: matches };
    }
  }
  logger.debug(`[detectLinkedRepository] resolved to ${matches[0].localPath}`);
  return { linked: matches[0], all: matches };
}

export async function detectLinkedRepository(
  instances: ForgejoInstance[],
  options?: DetectLinkedRepositoryOptions,
): Promise<LinkedRepository | undefined> {
  return (await detectLinkedRepositories(instances, options)).linked;
}
