import * as cp from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { promisify } from 'util';
import type { ForgejoInstance, LinkedRepository } from '@cpf23333-forgejo-toolkit/shared/webview/messages';
import { isSshOrGitRemote, normalizeGitUrl } from '@cpf23333-forgejo-toolkit/shared/git/url';
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
 *
 * The host may be named in any transport form a repository stores —
 * `https://host/...`, `ssh://git@host:2222/...`, `git://host:9418/...`, or
 * scp-style `user@host:path` with *any* login, because git's scp syntax does
 * not require the user to be `git` (`forgejo@host:owner/repo.git` and
 * `alice@host:owner/repo.git` are ordinary remotes); parseRemoteUrl handles all
 * of them, including normalizeGitRemote's structural rule that the remote names
 * a repository under the instance (host plus at least owner and repo).
 */
export function remoteMatchesInstance(remoteUrl: string, instanceUrl: string): boolean {
  const remote = parseRemoteUrl(remoteUrl);
  if (!remote) {
    return false;
  }
  let instanceHostPaths: string[];
  try {
    const parsed = new URL(instanceUrl);
    instanceHostPaths = [normalizeGitUrl(`${parsed.host}${parsed.pathname}`)];
    if (remote.compareWithoutPort) {
      instanceHostPaths.push(normalizeGitUrl(`${parsed.hostname}${parsed.pathname}`));
    }
  } catch {
    return false;
  }
  return instanceHostPaths.some(
    (hostPath) => remote.normalized === hostPath || remote.normalized.startsWith(`${hostPath}/`),
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
 * Whether a remote name may be handed to `git` as an argument.
 *
 * `git` reads any argument starting with `-` as an option, and a repository can
 * define a remote whose name looks like one (`git remote add --force …`). Such a
 * name would turn a fetch into a different command while the caller still hands
 * it the instance token, so a name starting with `-` is ignored by detection and
 * refused by the fetch helpers. Everything else git accepts is accepted here:
 * the remote name becomes a path component of `refs/remotes/<name>/…`, so only
 * the shapes that can never be a ref are refused — whitespace and control
 * characters, and `..`. Characters a user may legitimately type are therefore
 * kept (`my+fork`, `fork@2024`, a leading `_` such as the `_forgejo` remote the
 * publish prompt offers, `my/fork`); rejecting them would hide a remote the user
 * can create and pick. A name git itself refuses for another reason (e.g. `a:b`)
 * simply fails in git, which is not a security boundary because the name is
 * always passed as a single argv entry.
 */
export function isSafeRemoteName(value: string): boolean {
  return value.length > 0 && !value.startsWith('-') && !/[\s\p{Cc}]/u.test(value) && !value.includes('..');
}

/** Refuses an unusable remote name instead of handing it to `git` as an option. */
function assertRemoteName(value: string): void {
  if (!isSafeRemoteName(value)) {
    throw new Error(`"${value}" is not a usable git remote name`);
  }
}

/**
 * A remote URL with its credentials removed, for display and logging.
 *
 * `git remote -v` reports whatever the repository stores, including
 * `https://user:token@host/owner/repo.git`; that value reaches the dashboard and
 * the output channel. Only credential material is replaced: a password, and the
 * username of an http(s) URL that carries no password, where a token is commonly
 * written in the username position (`https://<token>@host/owner/repo.git`). A
 * plain ssh user (`ssh://git@host/...`) names the login, not a secret, and stays
 * visible, as do the host and path a user needs to recognise the remote.
 */
export function redactRemoteUrl(url: string): string {
  if (!url.includes('@')) {
    return url;
  }
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    // Not a URL: scp-like syntax (`user@host:path`) carries no password, so
    // there is nothing to strip.
    return url;
  }
  if (!parsed.username && !parsed.password) {
    return url;
  }
  if (parsed.password) {
    parsed.password = '***';
  } else if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
    // The username is the only userinfo here, so it is the functional
    // equivalent of a password (a Forgejo access token).
    parsed.username = '***';
  }
  return parsed.toString();
}

/**
 * The repository identities a URL stands for, as `<host>[:port]/<path>` with
 * the `.git` suffix dropped, the case folded and the userinfo removed.
 *
 * The same repository must compare equal whichever transport its URL uses:
 * `https://host/owner/repo.git`, `git@host:owner/repo.git`,
 * `ssh://git@host:2222/owner/repo.git` and `git://host:9418/owner/repo.git` all
 * name it, while normalizeGitUrl keeps the scheme and the transport user and so
 * never equates the first with any of the others. `hostPath` keeps an explicit
 * port, because an http(s) port identifies the server
 * (`https://host:3000/...` is a different target from `https://host/...`);
 * `hostPathWithoutPort` drops it, for the ssh/git transports whose port is
 * transport-level and unrelated to the instance's web port (a self-hosted
 * server commonly serves SSH on 2222 while the web UI runs on 3000) — the same
 * distinction remoteMatchesInstance draws. The userinfo names a credential, not
 * the repository, so it is dropped from the remote *and* the configured
 * instance URL: a remote or an instance stored as
 * `https://user:token@host/...` is still the same repository.
 *
 * Undefined when the value names no host and path at all, e.g. a local-path
 * remote (`/home/me/repo`, `D:\repos\my repo`).
 */
function remoteComparisonKeys(
  url: string,
): { hostPath: string; hostPathWithoutPort: string; compareWithoutPort: boolean } | undefined {
  const withoutUserinfo = url.replace(/^([A-Za-z][A-Za-z0-9+.-]*:\/\/)[^/?#]*@/, '$1');
  if (!withoutUserinfo.includes('://')) {
    // A Windows drive path (`D:\repos\x`, `D:/repos/x`) is a local path, not
    // git's scp form: git only reads `<host>:<path>` as a remote when the first
    // two characters are not a DOS drive prefix (`has_dos_drive_prefix` in
    // git's url_is_local_not_ssh), so `D:` must stay a local path here too.
    if (/^[A-Za-z]:/.test(withoutUserinfo)) {
      return undefined;
    }
    // scp-style (`git@host:owner/repo.git`, and git's login-less
    // `host:owner/repo.git`): there is no scheme for the URL parser to consume,
    // and the login before `@` — when there is one — is the transport user,
    // never a web credential. git's scp syntax does not require a login, so the
    // bare form is a remote too and must be parsed rather than dropped. git also
    // accepts an absolute path there (`git@host:/owner/repo.git`), whose leading
    // slash is not a separator.
    const scp = /^(?:[^/@:]+@)?([^/:]+):(.+)$/.exec(withoutUserinfo);
    if (!scp) {
      return undefined;
    }
    const hostPath = normalizeGitUrl(`${scp[1]}/${scp[2].replace(/^\/+/, '')}`);
    return { hostPath, hostPathWithoutPort: hostPath, compareWithoutPort: true };
  }
  let parsed: URL;
  try {
    parsed = new URL(withoutUserinfo);
  } catch {
    return undefined;
  }
  return {
    hostPath: normalizeGitUrl(`${parsed.host}${parsed.pathname}`),
    hostPathWithoutPort: normalizeGitUrl(`${parsed.hostname}${parsed.pathname}`),
    compareWithoutPort: isSshOrGitRemote(withoutUserinfo),
  };
}

/**
 * True when two URLs name the same repository on the same host — with the remote
 * on one side and an expected `${instanceUrl}/${owner}/${repo}` URL on the other
 * (see findLocalRepo, resolveRemoteForRepo, isCurrentWorkspaceBaseRepo).
 *
 * The comparison form is chosen for the pair, not for one side: when *either*
 * URL uses a portless transport (scp-style `host:path`, `ssh://`, `git://`), the
 * port is dropped from both, because an SSH/git port is transport-level and has
 * no relation to the instance's web port (a self-hosted server commonly serves
 * SSH on 2222 while the web UI runs on 3000). Only when both URLs are http(s)
 * does the port have to match exactly, because there it identifies the server.
 *
 * Comparing `parseRemoteUrl(...).normalized` on both sides instead compares
 * different forms: an http(s) instance URL keeps its port while the ssh/scp
 * remote drops it, so an instance deployed on a non-default port would reject
 * every ssh/scp remote as "not the PR base repository". Both sides always name a
 * host and a path here; the structural "host plus at least owner and repo" rule
 * parseRemoteUrl applies to a single URL is not needed, because the expected URL
 * is constructed from instance URL plus owner/repo. Credentials in either
 * URL's userinfo are ignored and the `.git` suffix is not part of the key (see
 * remoteComparisonKeys).
 */
export function sameRepositoryUrl(remoteUrl: string, expectedUrl: string): boolean {
  const remote = remoteComparisonKeys(remoteUrl);
  const expected = remoteComparisonKeys(expectedUrl);
  if (!remote || !expected) {
    return false;
  }
  return remote.compareWithoutPort || expected.compareWithoutPort
    ? remote.hostPathWithoutPort === expected.hostPathWithoutPort
    : remote.hostPath === expected.hostPath;
}

/**
 * A remote URL parsed into the repository it names, transport-independently
 * (see parseRemoteUrl, which is what callers outside this module should use).
 */
export interface ParsedRemoteUrl {
  /**
   * Host-plus-path comparison key: an http(s) port is kept (it identifies the
   * server), an ssh/git/scp transport port is dropped.
   */
  normalized: string;
  /** True when `normalized` has no port because the transport's port is irrelevant. */
  compareWithoutPort: boolean;
  owner: string;
  repo: string;
}

/**
 * The repository a remote URL names, in the shape the shared normalizeGitRemote
 * returns but for every transport form.
 *
 * normalizeGitRemote is limited to the URLs its parser accepts plus the `git@`
 * spelling of the scp form: `new URL('alice@host:owner/repo.git')` throws, so a
 * repository whose remote uses any other scp login comes back undefined and is
 * dropped *before* matching — leaving the repository looking unlinked and
 * offered as a publish candidate again. Parsing through remoteComparisonKeys
 * accepts `user@host:path` for every login, and keeps normalizeGitRemote's
 * structural rule: the URL must name host plus at least owner and repo.
 */
export function parseRemoteUrl(url: string): ParsedRemoteUrl | undefined {
  const keys = remoteComparisonKeys(url);
  if (!keys) {
    return undefined;
  }
  const normalized = keys.compareWithoutPort ? keys.hostPathWithoutPort : keys.hostPath;
  const parts = normalized.split('/').filter(Boolean);
  if (parts.length < 3) {
    return undefined;
  }
  return {
    normalized,
    compareWithoutPort: keys.compareWithoutPort,
    owner: parts[parts.length - 2],
    repo: parts[parts.length - 1],
  };
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
    if (!isSafeRemoteName(name)) {
      // An option-like or otherwise unusable name is never passed to git; the
      // remote stays visible to the user in git itself.
      continue;
    }
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
      const matches = remotes.some((remote) => expectedUrls.some((url) => sameRepositoryUrl(remote.url, url)));
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
 * The remote may name the repository in any transport form (https, ssh://,
 * scp-style git@host:owner/repo.git); see sameRepositoryUrl.
 */
export async function resolveRemoteForRepo(
  dirPath: string,
  instanceUrl: string,
  owner: string,
  repo: string,
): Promise<string | undefined> {
  const normalizedInstanceUrl = instanceUrl.replace(/\/$/, '');
  const expectedUrls = [`${normalizedInstanceUrl}/${owner}/${repo}.git`, `${normalizedInstanceUrl}/${owner}/${repo}`];
  const remotes = await listRemotes(dirPath);
  return remotes.find((remote) => expectedUrls.some((url) => sameRepositoryUrl(remote.url, url)))?.name;
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
 *
 * The remote name reaches git as an argv entry here and in the push-target
 * resolution above, so it is guarded like the fetch helpers guard theirs: a name
 * starting with `-` would be read as an option (`--force`, `--upload-pack=…`).
 * Callers derive it from the upstream (`@{upstream}`) or from a user prompt, so
 * it is not necessarily one this module chose.
 */
export async function pushBranch(
  dirPath: string,
  remote: string,
  refspec: string,
  token?: string,
  setUpstream = false,
  tokenInstanceUrl?: string,
): Promise<void> {
  assertRemoteName(remote);
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
  assertGitRevision(refspec, 'refspec');
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

/**
 * Revisions reach git as argv entries, and a value starting with `-` is read as an
 * option: the repository's `default_branch` or a pull request's head ref is
 * server-controlled, so `--depth=1`, `--prune`, `--dry-run` or `--upload-pack=…`
 * would otherwise be honoured (the last one executes a command on ssh remotes).
 * Reject such values instead of trusting the caller; `--` is added where the git
 * subcommand accepts it.
 */
function assertGitRevision(value: string, label: string): void {
  // eslint-disable-next-line no-control-regex -- control characters cannot appear in a ref either
  if (value.startsWith('-') || /[\s\u0000-\u001f]/.test(value)) {
    throw new Error(`${label} "${value}" is not a valid git revision`);
  }
}

/**`git` accepts an abbreviated SHA from 4 characters up; anything else is not a commit. */
function assertCommitSha(value: string): void {
  if (!/^[0-9a-f]{4,64}$/i.test(value)) {
    throw new Error(`"${value}" is not a commit SHA`);
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
  assertGitRevision(localBranch, 'branch');
  assertRemoteName(remote);
  const { stderr } = await runGit(['fetch', remote, '--', `${ref}:${localBranch}`], repoPath, authEnv(token));
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
  assertGitRevision(localBranch, 'branch');
  const { stderr } = await runGit(['worktree', 'add', '-B', localBranch, '--', worktreePath, localBranch], repoPath);
  if (stderr && stderr.toLowerCase().includes('error')) {
    throw new Error(stderr);
  }
}

export async function createWorktree(repoPath: string, worktreePath: string, branch: string): Promise<void> {
  await fs.promises.mkdir(path.dirname(worktreePath), { recursive: true });
  assertGitRevision(branch, 'branch');
  const { stderr } = await runGit(['worktree', 'add', '--', worktreePath, branch], repoPath);
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
  assertGitRevision(branch, 'branch');
  assertRemoteName(remote);
  const { stderr } = await runGit(['fetch', remote, '--', branch], repoPath, authEnv(token));
  if (stderr && stderr.toLowerCase().includes('error')) {
    throw new Error(stderr);
  }
}

/**
 * Create a worktree on a NEW branch starting at startPoint (e.g. FETCH_HEAD
 * right after fetchBranch, which works in bare caches and regular checkouts
 * alike). `-B` also resets a leftover branch of the same name, so retrying a
 * previously failed start-work flow cannot get stuck on "branch already
 * exists" — but only when that reset loses nothing. A leftover branch that
 * still points at startPoint, or that is merely behind it (an ancestor, e.g.
 * the branch a previous attempt created from an older fetch), is reset
 * silently. A leftover issue branch that has moved on past startPoint carries
 * work of its own (removing the worktree keeps the branch on purpose), and
 * resetting it would discard those commits without a prompt, so that case
 * fails loudly instead.
 *
 * The guard fails closed when it cannot be evaluated: a start point that does
 * not resolve while the branch exists means the divergence is unknown (the
 * branch might carry commits of its own), so the reset is refused rather than
 * run unguarded. When the branch does not exist there is nothing to reset
 * (`-B` creates it) and an unresolvable start point is left to git, which needs
 * that same value to create the branch and fails the command if it is bad.
 */
export async function createWorktreeWithNewBranch(
  repoPath: string,
  worktreePath: string,
  newBranch: string,
  startPoint: string,
): Promise<void> {
  await fs.promises.mkdir(path.dirname(worktreePath), { recursive: true });
  assertGitRevision(newBranch, 'branch');
  assertGitRevision(startPoint, 'start point');
  const [existingSha, startSha] = await Promise.all([
    getRefCommitSha(repoPath, `refs/heads/${newBranch}`),
    getRefCommitSha(repoPath, startPoint),
  ]);
  if (existingSha) {
    if (!startSha) {
      throw new Error(
        `branch "${newBranch}" already exists and the start point "${startPoint}" cannot be resolved; refusing to reset it without knowing what it would lose`,
      );
    }
    // Commits the leftover branch has that startPoint does not reach. Zero
    // covers "same commit" and "behind startPoint" (both resettable); a
    // positive count — or a rev-list git cannot complete, which must not be
    // read as "nothing to lose" — means the branch carries its own work.
    const ownCommits = await countCommitsNotReachableFrom(repoPath, existingSha, startSha);
    if (ownCommits === undefined || ownCommits > 0) {
      throw new Error(
        `branch "${newBranch}" already exists at ${existingSha.slice(0, 7)} and has commits of its own; delete the branch before starting work on it again`,
      );
    }
  }
  const { stderr } = await runGit(['worktree', 'add', '-B', newBranch, '--', worktreePath, startPoint], repoPath);
  if (stderr && stderr.toLowerCase().includes('error')) {
    throw new Error(stderr);
  }
}

/**
 * Commits reachable from `tip` but not from `from` (`git rev-list --count
 * from..tip`). Undefined when git cannot answer: a caller deciding whether a
 * reset is destructive must treat that as "cannot prove it is safe", not as
 * zero.
 */
async function countCommitsNotReachableFrom(repoPath: string, tip: string, from: string): Promise<number | undefined> {
  try {
    const { stdout } = await runGit(['rev-list', '--count', `${from}..${tip}`], repoPath);
    const count = Number.parseInt(stdout.trim(), 10);
    return Number.isNaN(count) || count < 0 ? undefined : count;
  } catch {
    return undefined;
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

/** Uncommitted (tracked, untracked or ignored) changes in a leftover worktree. */
async function isWorktreeDirty(worktreePath: string): Promise<boolean> {
  try {
    // `--ignored` matters here: a worktree whose only content is a gitignored
    // `.env` or a build output directory is not empty for its owner, and
    // `git worktree remove --force` would delete exactly that. Counting ignored
    // files as dirt makes the caller's confirmation prompt appear instead.
    const { stdout } = await runGit(['status', '--porcelain', '--ignored'], worktreePath);
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
  const matches = remotes.some((remote) => expectedUrls.some((url) => sameRepositoryUrl(remote.url, url)));
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
  assertGitRevision(ref, 'ref');
  try {
    const { stdout } = await runGit(['rev-parse', '--verify', `${ref}^{commit}`], repoPath);
    const sha = stdout.trim();
    return sha || undefined;
  } catch {
    return undefined;
  }
}

export async function deleteBranch(repoPath: string, branch: string): Promise<void> {
  assertGitRevision(branch, 'branch');
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
  // The SHA comes from the API; a non-hex value would be parsed as an option
  // (`-m`/`--strategy`…) rather than a commit.
  assertCommitSha(mergeCommitSha);
  const revertResult = await runGit(['revert', '-m', '1', '--no-edit', '--', mergeCommitSha], repoPath);
  if (revertResult.stderr && revertResult.stderr.toLowerCase().includes('error')) {
    throw new Error(revertResult.stderr);
  }
  const upstream = await getUpstreamBranch(repoPath);
  const remote = upstream && upstream.includes('/') ? upstream.split('/')[0] : 'origin';
  const remoteBranch = upstream && upstream.includes('/') ? upstream.split('/').slice(1).join('/') : undefined;
  if (expectedRepo) {
    // remoteMatchesInstance (in pushBranch) only proves the remote is on the
    // same host; a fork or any other repository on the same instance would
    // pass that check and receive the revert push. Compare the URLs git will
    // actually push to — `remote.<name>.pushurl` and `url.<base>.pushInsteadOf`
    // change the target without changing the fetch URL — and require every one
    // of them to be the pull request's own repository (Forgejo owner/repo names
    // are case-insensitive).
    const isExpectedRepo = (url: string): boolean => {
      const info = parseRemoteUrl(url);
      return (
        info !== undefined &&
        info.owner.toLowerCase() === expectedRepo.owner.toLowerCase() &&
        info.repo.toLowerCase() === expectedRepo.repo.toLowerCase()
      );
    };
    const pushUrls = await getRemotePushUrls(repoPath, remote);
    if (!pushUrls || pushUrls.length === 0 || !pushUrls.every(isExpectedRepo)) {
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
  logger.debug(
    `[detectLinkedRepository] instances: ${instances.map((i) => `${i.id}=${redactRemoteUrl(i.url)}`).join(', ')}`,
  );

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
      `[detectLinkedRepository] remotes for ${dirPath}: ${remotes.map((r) => `${r.name}=${redactRemoteUrl(r.url)}`).join(', ') || 'none'}`,
    );
    const remoteInfos: { entry: GitRemoteEntry; info: ParsedRemoteUrl }[] = [];
    for (const entry of remotes) {
      // parseRemoteUrl, not the shared normalizeGitRemote: an scp-style remote
      // with a login other than `git` must not be filtered out here, or it
      // never reaches the host match below and the repository looks unlinked.
      const info = parseRemoteUrl(entry.url);
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
        logger.debug(
          `[detectLinkedRepository] compare ${info.normalized} vs ${redactRemoteUrl(instance.url)}: ${matchesInstance}`,
        );
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
          `[detectLinkedRepository] ${matched.length} accounts match ${redactRemoteUrl(entry.url)}; bound to ${chosen.id} (owner: ${info.owner})`,
        );
      }
      logger.debug(`[detectLinkedRepository] matched ${chosen.id}`);
      // The remote URL is stored for display (the dashboard shows which remote a
      // repository is linked through); credentials in it are stripped, because
      // the value also reaches the webview and the log.
      linked = {
        instanceId: chosen.id,
        owner: info.owner,
        repo: info.repo,
        localPath: dirPath,
        remoteUrl: redactRemoteUrl(entry.url),
      };
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
          // Credentials stripped: the value is displayed and logged.
          remoteUrl: redactRemoteUrl(entry.url),
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
