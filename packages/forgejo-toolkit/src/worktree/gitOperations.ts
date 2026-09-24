import * as cp from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { promisify } from 'util';
import type { ForgejoInstance, LinkedRepository } from '@cpf23333-forgejo-toolkit/shared/webview/messages';
import { isSshOrGitRemote, normalizeGitUrl } from '@cpf23333-forgejo-toolkit/shared/git/url';
import { ForgejoClient } from '../api/client';
import { createTimedCache } from '../utils/timedCache';
import { redactUrlUserinfo } from '../utils/redactUrlUserinfo';
import { logger } from '../logger';

const execFile = promisify(cp.execFile);

/**
 * Runtime cap for the commands that only touch the local repository (status,
 * rev-parse, remote, config, rev-list, branch -D, revert, worktree list/prune/
 * remove). Every one of them answers in milliseconds on a healthy repository,
 * so two minutes is far beyond any legitimate run while still bounding a wedged
 * one — an `index.lock` held by a dead process, a filesystem that stopped
 * responding.
 */
const GIT_TIMEOUT_MS = 120_000;

/**
 * Runtime cap for the commands that legitimately run for minutes: the network
 * transfers (`clone --bare`, `fetch`, `push`) and the checkout `worktree add`
 * performs. Fifteen minutes bounds a hung transfer (an unreachable host
 * mid-transfer, a credential helper waiting on input) without killing real work
 * on a slow link or a very large repository.
 */
const GIT_LONG_TIMEOUT_MS = 900_000;

/**
 * Git subcommands whose work can cross the network. A timeout on one of them may
 * well be a stalled transfer or a credential helper waiting on input, which is
 * what the timeout message for this class says.
 *
 * The long-cap callers run only these (`clone --bare`, `fetch`, `push`) plus the
 * checkout `worktree add`, which `timedOutOnNetwork` matches separately.
 */
const NETWORK_SUBCOMMANDS = new Set(['clone', 'fetch', 'ls-remote', 'pull', 'push']);

/**
 * Whether a timed-out command may have been waiting on the network or on a
 * credential helper rather than on the local repository.
 *
 * Every other command `runGit` runs is local plumbing (`rev-parse`, `config`,
 * `status`, `worktree list`/`prune`/`remove`, `reset`, `rev-list`, `branch -D`,
 * `revert`), where those two are the *least* likely causes: they answer in
 * milliseconds unless something local is stuck (an `index.lock` held by a dead
 * process, a filesystem that stopped responding). Telling the user to check the
 * network there misdirects them away from the actual cause.
 *
 * Classified from argv, never from the cap the caller passed: the message has to
 * describe the command that actually timed out, so a caller that pairs a local
 * command with the long cap still gets the local wording, and vice versa.
 */
function timedOutOnNetwork(args: string[]): boolean {
  const [subcommand, sub] = args;
  if (subcommand === 'worktree') {
    // `worktree add` performs the checkout the long cap exists for; `list`,
    // `prune` and `remove` only touch local metadata.
    return sub === 'add';
  }
  return NETWORK_SUBCOMMANDS.has(subcommand);
}

/**
 * The operation named in the timeout message. `worktree add` needs both words:
 * naming only "worktree" would not say whether the checkout or the local
 * `list`/`prune`/`remove` was the one that hung.
 */
function gitOperation(args: string[]): string {
  return args[0] === 'worktree' && args[1] === 'add' ? 'worktree add' : (args[0] ?? 'command');
}

/**
 * The message a command that outlived its cap reports, picked by the class of
 * command that timed out (see `timedOutOnNetwork`). Both classes are built here
 * and nowhere else, so the message cannot disagree with the rejection path that
 * won the race.
 */
function gitTimeoutMessage(args: string[], timeoutMs: number): string {
  const operation = gitOperation(args);
  const seconds = Math.max(1, Math.ceil(timeoutMs / 1000));
  return timedOutOnNetwork(args)
    ? vscode.l10n.t(
        'Git {0} did not finish within {1} seconds and was stopped. Check the network connection or credential helper, then try again.',
        operation,
        seconds,
      )
    : vscode.l10n.t(
        'Git {0} did not finish within {1} seconds and was stopped. The repository may be locked or a git process may be stuck; check the repository state and try again.',
        operation,
        seconds,
      );
}

/**
 * Raised when a git child had to be killed because it outlived its timeout.
 *
 * Callers single this out: a killed `git worktree add` leaves a registration and
 * a half-populated checkout that git's own failure cleanup never got to undo,
 * whereas an ordinary git failure is cleaned up by git itself. Only the kill
 * path may therefore reclaim the directory it was writing.
 */
export class GitTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GitTimeoutError';
  }
}

/**
 * Maps an `execFile` failure to the error the callers see.
 *
 * On failure, cp.execFile errors embed the full command line in error.message,
 * so only git's stderr is re-thrown: it never echoes the command line (and any
 * credential it carries). When there is no stderr — the process could not be
 * spawned at all — the reason is reported instead of a constant: a user with no
 * git on the extension host's PATH (or a wrong `git.path`) otherwise gets no
 * hint about what to fix.
 */
function describeGitFailure(error: unknown, gitPath: string): Error {
  const stderr = (error as { stderr?: unknown }).stderr;
  if (typeof stderr === 'string' && stderr.trim()) {
    return new Error(stderr.trim());
  }
  const code = (error as { code?: unknown }).code;
  if (code === 'ENOENT') {
    return new Error(vscode.l10n.t('Git was not found at "{0}". Install Git or set the "git.path" setting.', gitPath));
  }
  return new Error(
    vscode.l10n.t('Failed to run Git at "{0}"{1}.', gitPath, typeof code === 'string' ? ` (${code})` : ''),
  );
}

/**
 * Run git with an argument array (no shell, so ref/path arguments cannot be
 * used for shell injection), killing the child when it outlives `timeoutMs`.
 *
 * Without the cap a single hung git wedged the whole feature for the rest of
 * the session: `InFlightTasks` deletes its key only when the task settles, so
 * the never-settling promise kept "Cloning …" up, kept the webview spinner on,
 * left the git process behind, and made every later attempt on that key reuse
 * the same dead promise. The timeout rejects with `GitTimeoutError` so the task
 * settles (and the key is released) and the user gets an actionable message.
 * That rejection is guaranteed even though the abort's own rejection can win
 * the race (see `timerFired` below): the class is what callers branch on.
 *
 * `timeoutMs` defaults to the local-command cap; the callers whose work is
 * genuinely long pass `GIT_LONG_TIMEOUT_MS`.
 *
 * The timeout message names the likely cause for the class of command that
 * actually timed out — the network/credential helper for a transfer or checkout,
 * the local repository state for the plumbing that answers in milliseconds on a
 * healthy one — rather than blaming the network for every command (see
 * `gitTimeoutMessage`).
 *
 * The binary is resolved from the editor's `git.path` setting on every call
 * (git runs may be minutes apart, and the setting is live), falling back to
 * `git` on PATH.
 */
export async function runGit(
  args: string[],
  cwd?: string,
  extraEnv?: NodeJS.ProcessEnv,
  timeoutMs = GIT_TIMEOUT_MS,
): Promise<{ stdout: string; stderr: string }> {
  const configuredGitPath = vscode.workspace.getConfiguration('git').get<string>('path');
  const gitPath = typeof configuredGitPath === 'string' && configuredGitPath.trim() ? configuredGitPath : 'git';
  // The child is killed through this controller, and the same timer rejects the
  // call: with only the abort, a spawn that ignores the signal (or a stub that
  // never answers) would keep the promise pending, which is the wedge this cap
  // exists to remove.
  const controller = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  // Records that the cap fired, not just that the race rejected with it. The
  // abort makes `execFile` reject with its own AbortError, and with both
  // promises racing, which rejection `Promise.race` observes first is not
  // guaranteed: on Node 22+ the abort's rejection wins and
  // `error instanceof GitTimeoutError` is false, so a timed-out command was
  // reported as an ordinary failure. The flag makes the outcome independent of
  // that ordering — once the cap fired, the caller always sees the timeout.
  let timerFired = false;
  const timeoutError = () => new GitTimeoutError(gitTimeoutMessage(args, timeoutMs));
  const timedOut = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      timerFired = true;
      // `killSignal: 'SIGKILL'` below, not SIGTERM: a wedged git (an
      // unreachable host mid-transfer, a credential helper blocked on input)
      // cannot be trusted to exit on a catchable signal, and the process has to
      // be gone before the caller's cleanup deletes what it was writing (see
      // rethrowAfterKilledWorktreeAdd).
      controller.abort();
      reject(timeoutError());
    }, timeoutMs);
  });
  try {
    return await Promise.race([
      execFile(gitPath, args, {
        cwd,
        env: extraEnv ? { ...process.env, ...extraEnv } : process.env,
        signal: controller.signal,
        killSignal: 'SIGKILL',
      }),
      timedOut,
    ]);
  } catch (error) {
    // The cap fired: whatever rejection won the race is the killed child's, so
    // report the timeout the callers single out (the message is built here, so
    // the AbortError seen earlier in the race is never surfaced).
    if (timerFired) {
      throw error instanceof GitTimeoutError ? error : timeoutError();
    }
    // Everything else is a git failure.
    throw describeGitFailure(error, gitPath);
  } finally {
    // Also covers the timeout path: an already-fired timer is harmless to clear,
    // and a pending one must not outlive the call.
    clearTimeout(timer);
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

/**
 * The fetch URL git reports for `remote`, or `undefined` when it cannot be
 * resolved (unknown remote, missing git).
 *
 * An unusable remote name is refused outright (it throws instead of returning
 * `undefined`) for the same reason as in getRemotePushUrls: `git remote get-url`
 * reads `--push`/`--all` as its own options, so a `branch.<name>.remote` of
 * `--all` would answer with *every* remote's URLs while the caller attributes
 * them to one remote — a "does this remote belong to my instance" check would
 * then pass on another remote's URL. The guard is the same one the siblings use
 * (assertRemoteName); callers cannot express "unknown" for a name git never
 * accepted.
 */
export async function getRemoteUrl(dirPath: string, remote = 'origin'): Promise<string | undefined> {
  assertRemoteName(remote);
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
 *
 * An unusable remote name is refused outright (it throws instead of returning
 * `undefined`) rather than resolved: `git remote get-url` reads `--push`/`--all`
 * as its own options, so a `branch.<name>.remote` of `--all` would answer with
 * *every* remote's URLs while the caller attributes them to one remote — the
 * "does this remote belong to my instance" check would then pass on another
 * remote's URL. The guard is the same one the fetch/push builders use
 * (assertRemoteName); callers cannot express "unknown" for a name git never
 * accepted.
 */
export async function getRemotePushUrls(dirPath: string, remote: string): Promise<string[] | undefined> {
  assertRemoteName(remote);
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
 * the output channel. The rule — and its single implementation — lives in
 * `utils/redactUrlUserinfo.ts`, which the vscode-free API client and MCP bundle
 * can import too; this name is kept for the callers that already use it.
 */
export const redactRemoteUrl = redactUrlUserinfo;

/**
 * True when the URL's port is transport-level rather than the server's web port
 * (see remoteComparisonKeys).
 *
 * `isSshOrGitRemote` from the shared package covers `ssh://`, `git://` and the
 * scp form, but not git's explicit-SSH alias `git+ssh://`, which git treats the
 * same way (its default transport port is SSH's 22, so a remote may name 2222
 * while the instance's web UI runs on 3000). That alias is handled here rather
 * than in the shared helper, which is owned elsewhere and re-exported to the
 * webview.
 */
function isPortlessRemoteTransport(url: string): boolean {
  return isSshOrGitRemote(url) || /^git\+ssh:\/\//i.test(url.trim());
}

/**
 * The repository identities a URL stands for, as `<host>[:port]/<path>` with
 * the `.git` suffix dropped, the case folded and the userinfo removed.
 *
 * The same repository must compare equal whichever transport its URL uses:
 * `https://host/owner/repo.git`, `git@host:owner/repo.git`,
 * `ssh://git@host:2222/owner/repo.git`, `git+ssh://git@host:2222/owner/repo.git`
 * and `git://host:9418/owner/repo.git` all name it, while normalizeGitUrl keeps
 * the scheme and the transport user and so never equates the first with any of
 * the others. `hostPath` keeps an explicit port, because an http(s) port
 * identifies the server
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
    compareWithoutPort: isPortlessRemoteTransport(withoutUserinfo),
  };
}

/**
 * True when two URLs name the same repository on the same host — with the remote
 * on one side and an expected `${instanceUrl}/${owner}/${repo}` URL on the other
 * (see findLocalRepo, resolveRemoteForRepo, isCurrentWorkspaceBaseRepo).
 *
 * The comparison form is chosen for the pair, not for one side: when *either*
 * URL uses a portless transport (scp-style `host:path`, `ssh://`, `git://`,
 * `git+ssh://`), the port is dropped from both, because an SSH/git port is
 * transport-level and has no relation to the instance's web port (a self-hosted
 * server commonly serves SSH on 2222 while the web UI runs on 3000). Only when
 * both URLs are http(s) does the port have to match exactly, because there it
 * identifies the server.
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

/** A `@{upstream}` value resolved into the remote and the remote branch name. */
export interface UpstreamRef {
  /** Name of the remote the upstream belongs to. */
  remote: string;
  /** Remote branch name, without the remote prefix. */
  branch: string;
}

/**
 * Resolve the branch's configured upstream into its remote name and remote
 * branch name.
 *
 * Neither part can be found by splitting the `@{upstream}` value at the first
 * `/`: `isSafeRemoteName` deliberately accepts a slash inside a remote name
 * (`my/fork`, which git accepts and the publish prompt can offer), so
 * `my/fork/feature` is remote `my/fork` with branch `feature` — the first-slash
 * split produced remote `my` and then fetched or pushed to a remote that does
 * not exist, failing with a message about the wrong thing.
 *
 * Git stores the exact answer: `branch.<name>.merge` is the remote's full ref
 * (`refs/heads/feature`) and `branch.<name>.remote` names the remote. When that
 * configuration is absent or unreadable the `@{upstream}` value is matched
 * against the remote names git reports, longest first, so a slash-named remote
 * still wins over a similarly-prefixed shorter one.
 *
 * Returns `undefined` for a detached HEAD or a branch with no upstream at all.
 * The first-slash split is the last resort for a name that matches none of the
 * reported remotes, so an ordinary `origin/…` upstream keeps resolving exactly
 * as it did before even on a repository whose remote list cannot be read.
 */
export async function resolveUpstreamRemote(dirPath: string): Promise<UpstreamRef | undefined> {
  const branch = await getCurrentBranch(dirPath);
  if (!branch) {
    return undefined;
  }
  try {
    const [remoteResult, mergeResult] = await Promise.all([
      runGit(['config', '--get', `branch.${branch}.remote`], dirPath),
      runGit(['config', '--get', `branch.${branch}.merge`], dirPath),
    ]);
    const remote = remoteResult.stdout.trim();
    const merge = mergeResult.stdout.trim();
    if (remote && merge.startsWith('refs/heads/')) {
      const remoteBranch = merge.slice('refs/heads/'.length);
      if (remoteBranch) {
        return { remote, branch: remoteBranch };
      }
    }
  } catch {
    // No upstream configured, or no branch section at all.
  }

  // The configuration did not name the upstream: `git rev-parse --abbrev-ref
  // @{upstream}` still prints `<remote>/<branch>`, and the remote name may
  // contain a slash, so it is matched against the names git reports — longest
  // first, because the shortest would silently rewrite `my/fork/main` into
  // remote `my` and branch `fork/main`.
  const upstream = await getUpstreamBranch(dirPath);
  if (!upstream) {
    return undefined;
  }
  const remoteNames = new Set((await listRemotes(dirPath)).map((entry) => entry.name));
  const matched = [...remoteNames]
    .filter((name) => upstream.startsWith(`${name}/`))
    .sort((a, b) => b.length - a.length)[0];
  if (matched) {
    return { remote: matched, branch: upstream.slice(matched.length + 1) };
  }
  // Last resort: the shape that misreads a slash-named remote, reached only
  // once both exact answers are unavailable.
  const slash = upstream.indexOf('/');
  if (slash <= 0 || slash >= upstream.length - 1) {
    return undefined;
  }
  return { remote: upstream.slice(0, slash), branch: upstream.slice(slash + 1) };
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
 *
 * `refspec` is a local *branch name*, which is sent as the full
 * `refs/heads/<branch>` source (see `pushRefspec`): passed bare, a legal branch
 * named `+x` would be read as the force marker plus the branch `x`.
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
  args.push(remote, pushRefspec(refspec));
  // A push transfers as much as a fetch does, so it gets the same long cap.
  const { stderr } = await runGit(args, dirPath, authEnv(token), GIT_LONG_TIMEOUT_MS);
  if (stderr && stderr.toLowerCase().includes('error')) {
    throw new Error(stderr);
  }
}

/**
 * The refspec this module pushes with, made unambiguous.
 *
 * A bare local branch name is not a safe refspec: git reads a leading `+` as
 * the force-update marker, so the legal branch `+x` would reach the remote as
 * "force-update the branch `x`" — pushing unrelated history over it — and a
 * name that matches nothing would fail as `src refspec x does not match any`
 * instead of naming the branch the user asked for. `assertGitRevision` only
 * rejects a leading `-`, which is not enough here (and `+`, unlike `-`, is a
 * perfectly legal refname character, so it must not simply be refused).
 *
 * Spelling the source as the full `refs/heads/<branch>` removes the ambiguity:
 * `refs/heads/+x` names the branch that actually exists, and no part of the
 * value is left for git to read as a flag.
 *
 * Only a value git could misread is rewritten. A plain branch name needs no
 * help (`git push origin fix` already means `refs/heads/fix`), and the other
 * spellings must stay exactly as the caller wrote them: the pseudo-refs
 * (`HEAD`, `FETCH_HEAD`) are not branches, so `refs/heads/HEAD` names nothing
 * and the push would fail outright, while a `refs/...` value or a
 * `<src>:<dst>` pair would be pointed at a different ref by prefixing it.
 */
function pushRefspec(refspec: string): string {
  if (refspec.includes(':') || refspec.startsWith('refs/')) {
    return refspec;
  }
  // An all-caps name is git's pseudo-ref spelling (`HEAD`, `FETCH_HEAD`,
  // `MERGE_HEAD`, …). A branch *could* be named `WIP`, and leaving that one as
  // written is harmless: a plain name already resolves to the same branch.
  if (/^[A-Z][A-Z_]*$/.test(refspec)) {
    return refspec;
  }
  return `refs/heads/${refspec}`;
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

/**
 * Create the shared bare cache clone at `targetPath`.
 *
 * On failure the partial clone is removed, but only the one this call made and
 * only while it is still provably incomplete. A `git clone` killed at its
 * timeout (or one that failed before git wrote `remote.origin.url`) leaves a
 * directory that looks like a valid cache clone, and the caller treats a
 * directory that exists as usable — the retry skips the clone and every later
 * attempt fails with "No git remote in the local repository points at
 * owner/repo". The leftovers must therefore be reclaimed.
 *
 * The cache directory is shared by every VS Code window (`_bareCloneInFlight`
 * dedupes inside one extension host only), so "the path did not exist before
 * this call" does not prove the directory is this call's output: a second
 * window that read the path as absent just before the first window's clone
 * created it fails with "destination path already exists" and would `rm -rf`
 * the clone the first window is still writing into (breaking its in-flight
 * fetch/worktree add and the checkouts whose gitdir lives inside it).
 *
 * Chosen mechanism: an ownership marker plus a completeness gate.
 *
 * - Before cloning, this call creates `<targetPath>.clone-owner` holding a
 *   unique token (this extension host's pid plus a per-call nonce).
 * - Cleanup happens only when that marker is still the one this call wrote AND
 *   `<targetPath>/config` does not carry a usable `remote.origin.url`. A marker
 *   another call wrote means the directory is somebody else's; a complete clone
 *   is left alone no matter whose marker is there, which is what protects a
 *   clone another window already finished or is still using.
 * - The marker lives beside the directory, not inside it, so it never appears
 *   as content of the clone and cannot itself be mistaken for clone state.
 *
 * A directory the user created by hand is never deleted either: it has no
 * marker of ours, so the first condition already excludes it.
 */
export async function cloneRepository(url: string, targetPath: string, token?: string): Promise<void> {
  const existedBeforeCall = await fs.promises.access(targetPath).then(
    () => true,
    () => false,
  );
  await fs.promises.mkdir(path.dirname(targetPath), { recursive: true });
  const markerPath = cloneMarkerPath(targetPath);
  const markerToken = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  let markerWritten = false;
  try {
    // Written before the clone so a concurrent window's failure cleanup can
    // already see that this directory belongs to somebody else.
    await fs.promises.writeFile(markerPath, markerToken, 'utf8');
    markerWritten = true;
  } catch {
    // Best-effort: without the marker the cleanup below simply declines to
    // remove anything, which is the safe direction.
  }
  try {
    // Pass the token via env-based per-command config so it is neither persisted
    // in the cloned repository's remote URL nor visible in git's command line.
    // --quiet keeps clone progress out of stderr (huge repos would overflow
    // execFile's 1MB maxBuffer); fatal errors are still printed, so the check
    // below is unaffected.
    const { stderr } = await runGit(
      ['clone', '--bare', '--quiet', url, targetPath],
      undefined,
      authEnv(token),
      GIT_LONG_TIMEOUT_MS,
    );
    if (stderr && stderr.toLowerCase().includes('error')) {
      throw new Error(stderr);
    }
  } catch (error) {
    if (
      markerWritten &&
      !existedBeforeCall &&
      (await isThisCallsIncompleteClone(targetPath, markerPath, markerToken))
    ) {
      // Best-effort: the directory is this call's partial output, and a delete
      // that fails (a file still held open by the killed child on Windows) must
      // not replace the clone's own failure.
      try {
        await fs.promises.rm(targetPath, { recursive: true, force: true });
      } catch {
        // Leftovers are retried by the next attempt's own clone (which fails on
        // an existing directory) rather than reported here.
      }
    }
    if (markerWritten) {
      await fs.promises.rm(markerPath, { force: true }).catch(() => undefined);
    }
    throw error;
  }
  // Success: the clone is complete, so nothing may delete it. The marker would
  // only ever be stale after this point.
  if (markerWritten) {
    await fs.promises.rm(markerPath, { force: true }).catch(() => undefined);
  }
}

/** Where `cloneRepository` records which call owns an in-progress clone. */
function cloneMarkerPath(targetPath: string): string {
  return `${targetPath}.clone-owner`;
}

/**
 * Whether the directory at `targetPath` is still this call's own, unfinished
 * clone output — the only thing the failure path may delete. Both conditions
 * are required, and each rules out a different way of deleting someone else's
 * clone (see cloneRepository).
 */
async function isThisCallsIncompleteClone(
  targetPath: string,
  markerPath: string,
  markerToken: string,
): Promise<boolean> {
  try {
    const owner = await fs.promises.readFile(markerPath, 'utf8');
    if (owner.trim() !== markerToken) {
      return false;
    }
  } catch {
    return false;
  }
  return !(await hasUsableOriginRemote(targetPath));
}

/**
 * Whether a bare repository directory carries the `remote.origin.url` a
 * finished `git clone` writes. Its own or a caller's separate helper would
 * disagree on which file to read, so the probe is kept here, next to the only
 * caller.
 */
async function hasUsableOriginRemote(repoPath: string): Promise<boolean> {
  try {
    const config = await fs.promises.readFile(path.join(repoPath, 'config'), 'utf8');
    // The `url = …` line of the remote git wrote; the section header
    // (`[remote "origin"]`) carries no url key of its own, so a header alone
    // never counts as usable.
    return /(?:^|\n)\s*url\s*=\s*\S/.test(config);
  } catch {
    return false;
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
  try {
    await runFetchPullRequestHead(repoPath, remote, ref, localBranch, token);
  } catch (error) {
    if (!(await recoverFromWorktreeCheckedOutBranch(repoPath, localBranch, error))) {
      throw error;
    }
    // The leftover registration and the branch that was stuck in it are gone,
    // so the refspec writes the branch now.
    await runFetchPullRequestHead(repoPath, remote, ref, localBranch, token);
  }
}

async function runFetchPullRequestHead(
  repoPath: string,
  remote: string,
  ref: string,
  localBranch: string,
  token?: string,
): Promise<void> {
  const { stderr } = await runGit(
    ['fetch', remote, '--', `${ref}:${localBranch}`],
    repoPath,
    authEnv(token),
    GIT_LONG_TIMEOUT_MS,
  );
  if (stderr && stderr.toLowerCase().includes('error')) {
    throw new Error(stderr);
  }
}

/**
 * Clear a stale git worktree registration that a refused fetch is stuck on.
 *
 * `git fetch <remote> <ref>:<branch>` refuses when `<branch>` is checked out in
 * any registered worktree (its own included), and the PR flow creates the
 * throwaway `pr-<n>-<sha7>` branch in exactly that way. If the worktree
 * directory is then deleted outside git (a cache-directory change, disk
 * cleanup, or a manual delete), its registration survives: `git worktree remove`
 * never ran, so `.git/worktrees/<name>` is still there and states the branch is
 * checked out at a path that no longer exists. Every retry then fails forever
 * with the same refusal, and the user only sees "the pull request may have been
 * updated, please retry" — which never becomes true.
 *
 * Recovery is deliberately narrow. It acts only on a git failure whose message
 * names the branch as checked out, and only when no checkout of that branch is
 * left on disk: the leftovers are the *missing* worktree directories, whose
 * registration `git worktree prune` drops (prune only removes registrations
 * whose directory is gone). An existing directory is left untouched, so a
 * worktree holding the user's local work is never destroyed to unblock a fetch;
 * its registration points at a path that exists and is pruned by nothing.
 *
 * Returns whether the caller may retry.
 */
async function recoverFromWorktreeCheckedOutBranch(
  repoPath: string,
  localBranch: string,
  error: unknown,
): Promise<boolean> {
  const message = error instanceof Error ? error.message : String(error);
  if (!/refusing to fetch into branch/i.test(message) || !message.includes(localBranch)) {
    return false;
  }
  const registeredDir = await findMissingWorktreeDirFor(repoPath, localBranch);
  if (!registeredDir) {
    return false;
  }
  await runGit(['worktree', 'prune'], repoPath);
  // The throwaway branch the missing checkout pinned: dropping it frees the
  // branch for the refspec. A real user branch is never named this way, and the
  // delete is best-effort — a leftover branch that survives still cannot block
  // the fetch once its registration is gone.
  await deleteBranch(repoPath, localBranch).catch(() => undefined);
  return true;
}

/**
 * The branch a `worktree add` refusal names as already checked out, or
 * undefined when the refusal is about anything else.
 *
 * git prints `fatal: '<branch>' is already used by worktree at '<path>'` (and
 * has used the wording "is already checked out at" in other versions), so both
 * the punctuation around the branch name and the path's quoting are read
 * loosely rather than anchored to one git version.
 */
function alreadyUsedBranch(error: unknown): string | undefined {
  const message = error instanceof Error ? error.message : String(error);
  const match = /'?([^'\s]+)'? is already (?:used by worktree at|checked out at) ['"]?(.+?)['"]?\s*$/m.exec(message);
  return match?.[1];
}

/**
 * The path of the registered worktree that still holds `localBranch` while its
 * directory is gone, or undefined when there is no such registration.
 *
 * This is what makes pruning safe: `git worktree prune` drops *only*
 * registrations whose directory has disappeared, so it can never reclaim a
 * checkout the user is working in. A registration at a path that exists is
 * reported as nothing to recover from and is left to the flow's own
 * stale-worktree handling (which asks before destroying anything).
 */
async function findMissingWorktreeDirFor(repoPath: string, localBranch: string): Promise<string | undefined> {
  let registeredDir: string | undefined;
  try {
    const { stdout } = await runGit(['worktree', 'list', '--porcelain'], repoPath);
    // The block `git worktree list --porcelain` prints for the worktree holding
    // the branch: a `worktree <path>` line followed by `branch refs/heads/<name>`
    // (detached entries say `detached` instead) and, once its directory is gone,
    // a `prunable <reason>` line. The path never contains a newline, so the
    // first line of the block is the whole path.
    for (const block of stdout.split(/\n\s*\n/)) {
      const lines = block.split('\n');
      const pathLine = lines.find((line) => line.startsWith('worktree '));
      const holdsBranch = lines.some((line) => line.trim() === `branch refs/heads/${localBranch}`);
      if (holdsBranch && pathLine) {
        registeredDir = pathLine.slice('worktree '.length).trim();
        break;
      }
    }
  } catch {
    return undefined;
  }
  if (!registeredDir) {
    return undefined;
  }
  // The directory probe is the authority, not git's `prunable` line: a version
  // that does not report the marker yet still must not have a live checkout
  // pruned, and an existing directory is never a prune candidate either way.
  if (
    await fs.promises.access(registeredDir).then(
      () => true,
      () => false,
    )
  ) {
    // The checkout is still on disk, so somebody may be working in it; the
    // caller's failure stands and the flow's own stale-worktree handling takes
    // it from here.
    return undefined;
  }
  return registeredDir;
}

/**
 * Rethrow a failed `git worktree add`, first reclaiming what a killed one left
 * behind.
 *
 * `git worktree add` registers the checkout under
 * `<repo>/.git/worktrees/<name>` and populates the directory afterwards. An
 * ordinary failure is undone by git itself, but a process killed at its timeout
 * never runs that cleanup: the registration and a half-populated directory stay
 * on disk, and the *next* attempt then fails for good — the fetch refuses to
 * write a branch that is registered at an existing path, and
 * `recoverFromWorktreeCheckedOutBranch` deliberately leaves a directory that
 * exists alone. Only the timeout path therefore reclaims the path: git refuses
 * to add into an existing non-empty directory, so a killed add means the
 * directory is this call's own partial output, while deleting after an ordinary
 * failure could destroy a leftover the user meant to reuse.
 *
 * The branch is kept (only the checkout goes), exactly like every other
 * worktree removal in this module.
 */
async function rethrowAfterKilledWorktreeAdd(repoPath: string, worktreePath: string, error: unknown): Promise<never> {
  if (error instanceof GitTimeoutError) {
    await removeWorktreeAndPrune(repoPath, worktreePath).catch(() => undefined);
  }
  throw error;
}

export async function createWorktreeFromBranch(
  repoPath: string,
  worktreePath: string,
  localBranch: string,
): Promise<void> {
  await fs.promises.mkdir(path.dirname(worktreePath), { recursive: true });
  assertGitRevision(localBranch, 'branch');
  try {
    const { stderr } = await runGit(
      ['worktree', 'add', '-B', localBranch, '--', worktreePath, localBranch],
      repoPath,
      undefined,
      GIT_LONG_TIMEOUT_MS,
    );
    if (stderr && stderr.toLowerCase().includes('error')) {
      throw new Error(stderr);
    }
  } catch (error) {
    await rethrowAfterKilledWorktreeAdd(repoPath, worktreePath, error);
  }
}

export async function createWorktree(repoPath: string, worktreePath: string, branch: string): Promise<void> {
  await fs.promises.mkdir(path.dirname(worktreePath), { recursive: true });
  assertGitRevision(branch, 'branch');
  try {
    const { stderr } = await runGit(
      ['worktree', 'add', '--', worktreePath, branch],
      repoPath,
      undefined,
      GIT_LONG_TIMEOUT_MS,
    );
    if (stderr && stderr.toLowerCase().includes('error')) {
      throw new Error(stderr);
    }
  } catch (error) {
    await rethrowAfterKilledWorktreeAdd(repoPath, worktreePath, error);
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
  const { stderr } = await runGit(['fetch', remote, '--', branch], repoPath, authEnv(token), GIT_LONG_TIMEOUT_MS);
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
 *
 * A registration left behind by a checkout whose directory was deleted outside
 * git is recovered from rather than reported: see the catch below. A refusal
 * git reports for any other reason, and one whose checkout is still on disk, is
 * rethrown unchanged.
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
  await assertResetIsSafe(repoPath, newBranch, startPoint);
  try {
    await runCreateWorktreeWithNewBranch(repoPath, worktreePath, newBranch, startPoint);
  } catch (error) {
    // A registration whose directory was deleted outside git (a cache-directory
    // change, disk cleanup, a manual delete) refuses every `worktree add` for
    // its branch with "already used by worktree at <missing path>" until someone
    // prunes it by hand — the state the code's own comments call realistic and
    // the PR path already recovers from (`recoverFromWorktreeCheckedOutBranch`).
    // The issue path had no such recovery, so "Start work" could never succeed
    // again. Same rule here: prune only a registration whose checkout is really
    // gone, then retry once.
    const heldBranch = alreadyUsedBranch(error);
    if (!heldBranch || !(await findMissingWorktreeDirFor(repoPath, heldBranch))) {
      throw error;
    }
    await runGit(['worktree', 'prune'], repoPath);
    // The prune removed only the registration, so the branch (and any commits
    // it carries) is still there. The reset guard has to run again before the
    // retry: while the branch was pinned to the missing checkout it may have
    // been the only ref resolving its tip, and `-B` must not silently drop
    // commits of its own. It refuses (fails loudly) rather than resetting.
    await assertResetIsSafe(repoPath, newBranch, startPoint);
    await runCreateWorktreeWithNewBranch(repoPath, worktreePath, newBranch, startPoint);
  }
}

async function runCreateWorktreeWithNewBranch(
  repoPath: string,
  worktreePath: string,
  newBranch: string,
  startPoint: string,
): Promise<void> {
  try {
    const { stderr } = await runGit(
      ['worktree', 'add', '-B', newBranch, '--', worktreePath, startPoint],
      repoPath,
      undefined,
      GIT_LONG_TIMEOUT_MS,
    );
    if (stderr && stderr.toLowerCase().includes('error')) {
      throw new Error(stderr);
    }
  } catch (error) {
    await rethrowAfterKilledWorktreeAdd(repoPath, worktreePath, error);
  }
}

/**
 * The divergence guard described on createWorktreeWithNewBranch: `-B` may only
 * reset a leftover branch when that loses nothing, and an unevaluable guard
 * fails closed.
 */
async function assertResetIsSafe(repoPath: string, newBranch: string, startPoint: string): Promise<void> {
  const [existingSha, startSha] = await Promise.all([
    getRefCommitSha(repoPath, `refs/heads/${newBranch}`),
    getRefCommitSha(repoPath, startPoint),
  ]);
  if (!existingSha) {
    return;
  }
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
  /**
   * Commits reachable from its HEAD but not from the expected PR head sha, or
   * `undefined` when that range cannot be resolved at all. An unknown count is
   * not zero: the expected sha may simply not exist in this clone yet (the PR
   * head is fetched later in the open flow), so a caller that treats zero as
   * "nothing to lose" must treat `undefined` as "may hold local commits" and
   * confirm before discarding.
   */
  commitsAhead: number | undefined;
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
 * Commits reachable from the worktree's HEAD but not from the expected sha, or
 * `undefined` when that cannot be determined.
 *
 * An unresolvable range must not be reported as zero. Zero means "nothing to
 * lose" and the caller skips its confirmation on it, so an unknown count would
 * silently force-delete a leftover that may hold the user's local commits. A
 * sha the clone has never fetched is the ordinary case here — the PR head is
 * fetched only later in the open flow — and is exactly when local commits are
 * most likely to be sitting in the old checkout.
 */
async function countCommitsAhead(worktreePath: string, expectedSha: string): Promise<number | undefined> {
  if (!/^[0-9a-f]{7,40}$/i.test(expectedSha)) {
    return undefined;
  }
  try {
    const { stdout } = await runGit(['rev-list', '--count', `${expectedSha}..HEAD`], worktreePath);
    const count = Number.parseInt(stdout.trim(), 10);
    return Number.isNaN(count) || count < 0 ? undefined : count;
  } catch {
    return undefined;
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
 * The git directory holding a working tree's state (`.git` for an ordinary
 * checkout, the `worktrees/<name>` directory for a linked one), resolved by git
 * itself so worktrees are handled correctly. Undefined when git cannot report
 * it (not a repository, git missing), in which case state files cannot be
 * inspected and callers must not claim the state is clean.
 */
export async function resolveGitDir(repoPath: string): Promise<string | undefined> {
  try {
    const { stdout } = await runGit(['rev-parse', '--absolute-git-dir'], repoPath);
    return stdout.trim() || undefined;
  } catch {
    return undefined;
  }
}

/**
 * True when the repository is in the middle of a `git revert`: the sequencer
 * writes REVERT_HEAD for a conflicted revert and removes it once the revert is
 * committed or aborted. Used both by `revertMergeCommit`'s fail-safe cleanup and
 * by callers that must tell the user what state they are looking at.
 */
export async function isRevertInProgress(repoPath: string): Promise<boolean> {
  const gitDir = await resolveGitDir(repoPath);
  if (!gitDir) {
    return false;
  }
  return await fs.promises.access(path.join(gitDir, 'REVERT_HEAD')).then(
    () => true,
    () => false,
  );
}

export interface RevertMergeCommitResult {
  /**
   * `pushed`: the revert commit was created and pushed — the only state in
   * which the caller may report success. `conflict`: `git revert` failed, so
   * the revert was undone and nothing was pushed. `reverted-not-pushed`: the
   * revert commit was created but the push failed; the commit was removed
   * locally again (unless the cleanup itself failed, which the thrown error
   * says), so the remote is unchanged.
   */
  status: 'pushed' | 'conflict' | 'reverted-not-pushed';
}

/**
 * Revert a merged PR's merge commit and push the result.
 *
 * When `expectedBranch` is given, the current branch must match it — reverting
 * on the wrong branch would push the revert to the wrong place. The push goes
 * through `pushBranch` with the instance token, so the remote is re-validated
 * against the instance (TOCTOU) and credentials are never sent to another host.
 *
 * Fail-safe: the local revert is not left behind, and nothing the revert did not
 * write is discarded. The commit HEAD pointed at before the revert is recorded
 * first, as is the tracked state of the working tree; a failed revert is then
 * undone with `git revert --abort` while the sequencer is mid-revert (which
 * reconstructs the pre-revert state and keeps local modifications it does not
 * need to overwrite), and a created-but-unpushed revert commit is dropped with a
 * reset that only runs when the tree held no tracked changes before the revert,
 * still holds none, and HEAD is still that commit. Otherwise the commit is left
 * in place and the message names it so the user can drop it themselves. The
 * returned status (and the thrown message) describe the state precisely, because
 * a caller that reports "success" for an unpushed revert would be lying. Undoing
 * a revert only restores tracked content, so the messages name any untracked
 * files `git revert` may have written.
 */
export async function revertMergeCommit(
  repoPath: string,
  mergeCommitSha: string,
  expectedBranch?: string,
  token?: string,
  tokenInstanceUrl?: string,
  expectedRepo?: { owner: string; repo: string },
): Promise<RevertMergeCommitResult> {
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
  const originalSha = await getCurrentCommitSha(repoPath);
  if (!originalSha) {
    // Without the pre-revert commit there is no way back, and a failed revert
    // would strand the repository in a state this flow cannot report.
    throw new Error(vscode.l10n.t('Revert aborted: could not determine the current commit of the repository'));
  }

  const upstream = await getUpstreamBranch(repoPath);
  // The remote name may itself contain a slash (`my/fork`), so neither part of
  // the upstream can be found by splitting at the first separator; see
  // resolveUpstreamRemote. `origin` stays the fallback for a branch with no
  // upstream configured at all.
  const upstreamRef = upstream ? await resolveUpstreamRemote(repoPath) : undefined;
  const remote = upstreamRef?.remote ?? 'origin';
  const remoteBranch = upstreamRef?.branch;
  if (upstream && !upstreamRef) {
    // The remote could not be resolved at all: pushing the revert to a remote
    // the first-slash split invented would either fail misleadingly or target
    // the wrong repository, and `expectedRepo` below could not validate it.
    throw new Error(
      vscode.l10n.t(
        'Revert aborted: the upstream branch "{0}" does not name a configured git remote in this repository',
        upstream,
      ),
    );
  }
  if (expectedRepo) {
    // remoteMatchesInstance (in pushBranch) only proves the remote is on the
    // same host; a fork or any other repository on the same instance would
    // pass that check and receive the revert push. Compare the URLs git will
    // actually push to — `remote.<name>.pushurl` and `url.<base>.pushInsteadOf`
    // change the target without changing the fetch URL — and require every one
    // of them to be the pull request's own repository (Forgejo owner/repo names
    // are case-insensitive). This runs before the revert so a rejected target
    // costs nothing locally.
    const isExpectedRepo = (url: string): boolean => {
      const info = parseRemoteUrl(url);
      return (
        info !== undefined &&
        info.owner.toLowerCase() === expectedRepo.owner.toLowerCase() &&
        info.repo.toLowerCase() === expectedRepo.repo.toLowerCase()
      );
    };
    // The remote name comes from `branch.<name>.remote`, which a repository can
    // set to anything — including `--all`, which `git remote get-url` reads as
    // its own option. getRemotePushUrls refuses such a name by throwing, and
    // that refusal is an internal message: it names neither the instance nor the
    // repository, and it is not localized. Check first, so the user gets a
    // localized abort naming the real problem instead.
    if (!isSafeRemoteName(remote)) {
      throw new Error(
        vscode.l10n.t(
          'Revert aborted: "{0}" is not a usable git remote name, so the push target for {1}/{2} could not be verified. Point the branch at a real remote (for example "origin") and try again.',
          remote,
          expectedRepo.owner,
          expectedRepo.repo,
        ),
      );
    }
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

  /**
   * Tracked-file entries of `git status --porcelain`: staged, unstaged and
   * unmerged paths. Untracked (`??`) and ignored (`!!`) files are dropped,
   * because no undo below touches them and they are therefore not evidence of
   * work at risk. Undefined when git cannot report the status at all, in which
   * case nothing may be assumed clean.
   */
  const readTrackedChanges = async (): Promise<string[] | undefined> => {
    try {
      const { stdout } = await runGit(['status', '--porcelain'], repoPath);
      return stdout
        .split('\n')
        .map((line) => line.trimEnd())
        .filter((line) => line.length > 0 && !line.startsWith('??') && !line.startsWith('!!'));
    } catch {
      return undefined;
    }
  };

  // The tracked changes already in the working tree before the revert ran. `git
  // revert` never touches them (it refuses to start when it would overwrite
  // them), so no undo may discard them either.
  const preRevertTrackedChanges = await readTrackedChanges();

  /**
   * Undo a `git revert` that failed, without discarding anything the revert did
   * not write.
   *
   * While the sequencer is mid-revert, `git revert --abort` is the undo: it
   * reconstructs the pre-revert state and, unlike `git reset --hard`, refuses to
   * overwrite a locally modified file instead of silently dropping it — so it is
   * safe even when the tree already held the user's own edits. With no sequencer
   * state the revert applied nothing (git writes REVERT_HEAD before it touches
   * the index), so no command is run at all.
   */
  const undoFailedRevert = async (): Promise<'undone' | 'failed' | 'left-alone'> => {
    if (await isRevertInProgress(repoPath)) {
      try {
        await runGit(['revert', '--abort'], repoPath);
        return 'undone';
      } catch {
        return 'failed';
      }
    }
    return 'left-alone';
  };

  /** The conflict message, naming the repository state and how to get back. */
  const revertFailedError = async (reason: string): Promise<Error> => {
    const outcome = await undoFailedRevert();
    if (outcome === 'undone') {
      return new Error(
        vscode.l10n.t(
          'Revert failed and was undone: {0}. The revert was aborted and the repository is back at {1}; changes that were already in the working tree were left untouched and untracked files the revert wrote are not removed.',
          reason,
          originalSha.slice(0, 7),
        ),
      );
    }
    if (outcome === 'failed') {
      return new Error(
        vscode.l10n.t(
          'Revert failed: {0}. The revert is still in progress and could not be aborted automatically; run "git revert --abort" in the local repository to undo it (it keeps your other local changes).',
          reason,
        ),
      );
    }
    return new Error(
      vscode.l10n.t(
        'Revert failed: {0}. Nothing was discarded — the repository is still at {1} and the working tree was left as the failed revert left it; inspect it with "git status" before retrying.',
        reason,
        originalSha.slice(0, 7),
      ),
    );
  };

  let revertResult: { stdout: string; stderr: string };
  try {
    revertResult = await runGit(['revert', '-m', '1', '--no-edit', '--', mergeCommitSha], repoPath);
  } catch (error) {
    throw await revertFailedError(error instanceof Error ? error.message : String(error));
  }
  if (revertResult.stderr && revertResult.stderr.toLowerCase().includes('error')) {
    throw await revertFailedError(revertResult.stderr);
  }

  // The commit the revert just created. The failed-push undo may drop this one
  // commit and nothing else, so it is recorded here and re-checked below instead
  // of assuming HEAD still points at it.
  const revertCommitSha = await getCurrentCommitSha(repoPath);

  /**
   * Drop the local revert commit, and nothing else.
   *
   * `git reset --hard` restores every tracked file to the recorded commit, so it
   * may only run when no other tracked change is in the way: the status is read
   * again and compared with the pre-revert snapshot (both must be free of
   * tracked changes), and HEAD must still be the revert commit — a commit the
   * user made meanwhile, or an edit the revert never touched, would otherwise be
   * dropped with it. Untracked files survive a hard reset either way. When the
   * reset is not safe the commit is left in place and the caller names it.
   */
  const undoRevertCommit = async (): Promise<'undone' | 'left-alone'> => {
    if (!preRevertTrackedChanges || preRevertTrackedChanges.length > 0) {
      return 'left-alone';
    }
    const trackedChangesNow = await readTrackedChanges();
    if (!trackedChangesNow || trackedChangesNow.length > 0) {
      return 'left-alone';
    }
    if (revertCommitSha === undefined || (await getCurrentCommitSha(repoPath)) !== revertCommitSha) {
      return 'left-alone';
    }
    try {
      await runGit(['reset', '--hard', originalSha], repoPath);
      return 'undone';
    } catch {
      return 'left-alone';
    }
  };

  try {
    if (remoteBranch) {
      await pushBranch(repoPath, remote, `HEAD:${remoteBranch}`, token, false, tokenInstanceUrl);
    } else {
      await pushBranch(repoPath, 'origin', 'HEAD', token, false, tokenInstanceUrl);
    }
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    const outcome = await undoRevertCommit();
    throw new Error(
      outcome === 'undone'
        ? vscode.l10n.t(
            'Revert could not be pushed and was undone: {0}. No local commit and no remote change was left behind; the repository is back at {1}.',
            reason,
            originalSha.slice(0, 7),
          )
        : vscode.l10n.t(
            'Revert could not be pushed: {0}. The local revert commit {1} was NOT pushed and is still there; your other local changes were left untouched. Commit or stash them, then drop the revert commit with "git reset --hard {2}".',
            reason,
            revertCommitSha ? revertCommitSha.slice(0, 7) : 'HEAD',
            originalSha,
          ),
    );
  }
  return { status: 'pushed' };
}

/**
 * Whether `worktreePath` is the folder the window already has open. Only then is
 * opening it a no-op; "no folder open at all" is not this case (there is still a
 * workspace to replace, and `openWorktree` prompts for it).
 */
function isOpenWorkspaceFolder(worktreePath: string): boolean {
  const currentFolder = vscode.workspace.workspaceFolders?.[0];
  return currentFolder !== undefined && pathsEqual(currentFolder.uri.fsPath, worktreePath);
}

/**
 * Whether opening `worktreePath` in the current window would replace the folder
 * that is open right now. False for a new window (nothing is replaced).
 *
 * The callers that create the checkout ask this *before* creating it: the
 * "replace the current workspace" confirmation is the last point at which the
 * user can still decline, and a checkout created before that prompt is left
 * behind with no record when the window is not replaced (see onward in
 * `openWorktree`, which asks the same question through this function).
 */
export function requiresWorkspaceReplacement(worktreePath: string, openInNewWindow: boolean): boolean {
  return !openInNewWindow && !isOpenWorkspaceFolder(worktreePath);
}

export async function openWorktree(
  worktreePath: string,
  openInNewWindow: boolean,
  beforeOpenInCurrentWindow?: () => Promise<void>,
  options?: { confirmed?: boolean },
): Promise<boolean> {
  const currentFolder = vscode.workspace.workspaceFolders?.[0];
  const uri = worktreeFolderUri(worktreePath, currentFolder?.uri);
  if (openInNewWindow) {
    return openFolderInWindow(uri, true);
  }
  if (isOpenWorkspaceFolder(worktreePath)) {
    // Already the open folder: nothing is replaced, so there is nothing to ask.
    return true;
  }
  // A caller that already asked (because it had to decide whether to create the
  // checkout at all) sets `confirmed`, so the user is prompted once.
  if (!options?.confirmed) {
    const openLabel = vscode.l10n.t('Open');
    const choice = await vscode.window.showWarningMessage(
      vscode.l10n.t('This will replace the current workspace with the worktree. Continue?'),
      { modal: true },
      openLabel,
    );
    if (choice !== openLabel) {
      return false;
    }
  }
  // vscode.openFolder with forceNewWindow=false reloads the window and tears
  // down this extension host, so anything that must still happen (persisting
  // the worktree record) has to run before the command, not after it.
  await beforeOpenInCurrentWindow?.();
  return openFolderInWindow(uri, false);
}

/**
 * Runs `vscode.openFolder`, reporting whether a window was actually asked for:
 * the command rejects when the target cannot be opened, and a caller that
 * records the worktree as opened (or answers the webview `worktreeOpened`)
 * would otherwise claim success for a folder that never opened.
 */
async function openFolderInWindow(uri: vscode.Uri, openInNewWindow: boolean): Promise<boolean> {
  try {
    await vscode.commands.executeCommand('vscode.openFolder', uri, openInNewWindow);
    return true;
  } catch (error) {
    logger.error(
      `Opening the worktree folder ${uri.toString()} failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    return false;
  }
}

/**
 * URI for a path that exists on the extension host. Under Remote-SSH, WSL and
 * dev containers that path is meaningful only to the remote server, while VS
 * Code resolves a `file:` openable in the client process, where it does not
 * exist: no window opens even though `vscode.openFolder` succeeds. Reusing the
 * open workspace folder's scheme and authority keeps the path on the host that
 * has it; a local (or absent) folder keeps `file:`.
 */
function worktreeFolderUri(worktreePath: string, folderUri: vscode.Uri | undefined): vscode.Uri {
  if (!folderUri?.scheme || folderUri.scheme === 'file') {
    return vscode.Uri.file(worktreePath);
  }
  return vscode.Uri.from({
    scheme: folderUri.scheme,
    authority: folderUri.authority,
    path: toUriPath(worktreePath),
  });
}

/**
 * Host path in URI form: forward slashes, and a Windows drive letter behind a
 * leading slash (`C:\a\b` → `/c:/a/b`), which is what `Uri.file` itself does.
 */
function toUriPath(fsPath: string): string {
  const slashed = fsPath.replace(/\\/g, '/');
  return /^[a-zA-Z]:/.test(slashed) ? `/${slashed[0].toLowerCase()}${slashed.slice(1)}` : slashed;
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
  // Only `..` and `../…` escape: a real child of a directory whose name starts
  // with two dots (`..cache/x`) has a relative form that also starts with `..`.
  return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

/**
 * Path equality on the platforms whose default filesystem is case-insensitive:
 * Windows (NTFS) and macOS (APFS/HFS+). A strict string compare would treat the
 * same directory as different, which for `openWorktree` means the destructive
 * "replace the current workspace" modal for the folder that is already open.
 * Other platforms keep the exact compare (the extension host's filesystem is
 * case-sensitive there, so two spellings are two directories).
 */
function pathsEqual(a: string, b: string): boolean {
  return process.platform === 'win32' || process.platform === 'darwin' ? a.toLowerCase() === b.toLowerCase() : a === b;
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
