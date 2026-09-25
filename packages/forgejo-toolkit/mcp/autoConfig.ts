import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { normalizeGitUrl } from '@cpf23333-forgejo-toolkit/shared/git/url';
import type { McpInstanceRegistryEntry } from '@cpf23333-forgejo-toolkit/shared/mcp/workspaceState';
import { stripUrlUserinfo } from '../src/utils/redactUrlUserinfo';

/**
 * Zero-configuration startup for the MCP server (consumer: server.ts).
 *
 * An MCP server definition spawned by VS Code receives the instance URL,
 * token, and state-file path through its launch environment. A static
 * workspace `.mcp.json` cannot do that — it carries only `command` and `args`
 * — so a server launched that way starts with no environment at all and must
 * find the instance itself. This module implements that discovery:
 *
 *   1. locate the extension's globalStorage directory (or honor the explicit
 *      FORGEJO_MCP_DATA_DIR override),
 *   2. read the instance registry (`mcp-instances.json`) the extension host
 *      publishes there (writer: src/mcpWorkspaceState.ts),
 *   3. try the workspace state files first: the newest readable
 *      `mcp-workspace-*.json` whose entries place the process's working
 *      directory inside a known checkout answers the instance URL directly,
 *   4. otherwise match the working directory's git remotes (parsed from
 *      `.git/config`, never by spawning git) against the registry,
 *   5. as a last resort, guess from the newest state file: its `active` entry
 *      (or its first entry) names the instance the user most recently worked
 *      with. This is what keeps the server usable when the MCP host launches
 *      it with a working directory that is no checkout at all — VS Code's
 *      Agents window runs Agent Host servers from the user's home directory.
 *      The guess is always announced on stderr, because it can be wrong.
 *
 * What this deliberately does *not* read: the editor's `state.vscdb` (where
 * the instance list actually lives) and the OS keychain (where tokens live).
 * The database schema is an internal that changes between VS Code versions,
 * and a headless child touching the keychain would trip the OS credential
 * prompt — both are fragile and out of bounds for a process that is not the
 * extension host. The registry file exists precisely so none of that is
 * needed.
 *
 * This module is bundled into the headless MCP server, so it must stay free
 * of `vscode` imports, and its messages are English literals on purpose —
 * they are read by MCP hosts and LLM agents, not localized.
 */

/** The extension's directory name inside VS Code's globalStorage. */
const EXTENSION_GLOBAL_STORAGE_ID = 'cpf23333.forgejo-toolkit';

/** Fixed file name of the instance registry (writer: src/mcpWorkspaceState.ts). */
const INSTANCE_REGISTRY_BASENAME = 'mcp-instances.json';

/**
 * The state file naming scheme, mirroring the reader-side guard in
 * mcp/workspaceState.ts: only names this extension itself produces are read.
 * The `.part` temporary of an interrupted atomic write does not end in
 * `.json` and is excluded by the pattern.
 */
const STATE_FILE_BASENAME = /^mcp-workspace-.+\.json$/;

/** Upper bound for a registry or state file this process will parse (same rationale as mcp/workspaceState.ts). */
const MAX_FILE_BYTES = 1024 * 1024;

export interface AutoConfigOptions {
  /** The process working directory; the session workspace of the MCP host. */
  cwd: string;
  env: NodeJS.ProcessEnv;
  platform: NodeJS.Platform;
  homeDir: string;
}

export type AutoConfigResult =
  | {
      status: 'matched';
      /** The instance URL to connect to (userinfo-stripped, as the registry publishes it). */
      url: string;
      via: 'state-file' | 'git-remote' | 'state-file-fallback';
      /**
       * The newest readable workspace state file discovered along the way, so
       * the server can offer it to `get_workspace_repository` even when
       * FORGEJO_MCP_STATE_FILE was never set. Undefined when no state file
       * exists.
       */
      stateFile?: string;
      /** An informational caveat worth logging (e.g. an ambiguous match). */
      note?: string;
    }
  | {
      status: 'failed';
      /** English, MCP-host-facing: why no instance could be determined and what to do. */
      message: string;
    };

function defaultOptions(): AutoConfigOptions {
  return { cwd: process.cwd(), env: process.env, platform: process.platform, homeDir: os.homedir() };
}

/**
 * The VS Code "user data" directories (`<installation>/User`) where
 * globalStorage lives, per platform and installation flavor (stable and
 * Insiders). A user can run either flavor — or several profiles inside one —
 * and an MCP host cannot know which, so all of them are searched.
 */
function vscodeUserDirs(env: NodeJS.ProcessEnv, platform: NodeJS.Platform, homeDir: string): string[] {
  const flavors = ['Code', 'Code - Insiders'];
  if (platform === 'win32') {
    // %APPDATA% is the roaming profile root; without it there is no VS Code
    // data location to guess.
    return env.APPDATA ? flavors.map((flavor) => path.join(env.APPDATA as string, flavor, 'User')) : [];
  }
  if (platform === 'darwin') {
    return flavors.map((flavor) => path.join(homeDir, 'Library', 'Application Support', flavor, 'User'));
  }
  // Linux: VS Code honors XDG_CONFIG_HOME and falls back to ~/.config.
  const configHome = env.XDG_CONFIG_HOME || path.join(homeDir, '.config');
  return flavors.map((flavor) => path.join(configHome, flavor, 'User'));
}

export interface DataDirSearch {
  /** Concrete directories to read: every existing candidate. */
  dirs: string[];
  /**
   * Human-readable rendering of everywhere that was searched, for the
   * not-found error message; profile directories that do not exist appear as
   * their `profiles/*` glob pattern.
   */
  searched: string[];
}

/**
 * Resolves the directories that may hold the extension's globalStorage
 * content: FORGEJO_MCP_DATA_DIR when set (tests and unconventional
 * installs point it straight at the directory containing
 * `mcp-instances.json`), otherwise the platform defaults plus one glob level
 * of profile variants (`User/profiles/<id>/globalStorage/<ext>`).
 */
export async function discoverDataDirs(options: AutoConfigOptions): Promise<DataDirSearch> {
  const override = options.env.FORGEJO_MCP_DATA_DIR;
  if (override) {
    return { dirs: [override], searched: [`${override} (FORGEJO_MCP_DATA_DIR)`] };
  }
  const dirs: string[] = [];
  const searched: string[] = [];
  for (const userDir of vscodeUserDirs(options.env, options.platform, options.homeDir)) {
    const base = path.join(userDir, 'globalStorage', EXTENSION_GLOBAL_STORAGE_ID);
    dirs.push(base);
    searched.push(base);
    const profilesDir = path.join(userDir, 'profiles');
    const profileGlob = path.join(profilesDir, '*', 'globalStorage', EXTENSION_GLOBAL_STORAGE_ID);
    let profileIds: string[] = [];
    try {
      profileIds = (await fs.promises.readdir(profilesDir, { withFileTypes: true }))
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name);
    } catch {
      // No profiles directory (the common case): the glob simply matches
      // nothing, but the pattern still belongs in the searched list so the
      // error message tells the user where a profile install would be found.
      searched.push(profileGlob);
    }
    for (const profileId of profileIds) {
      dirs.push(path.join(profilesDir, profileId, 'globalStorage', EXTENSION_GLOBAL_STORAGE_ID));
      searched.push(path.join(profilesDir, profileId, 'globalStorage', EXTENSION_GLOBAL_STORAGE_ID));
    }
  }
  return { dirs, searched };
}

/**
 * Reads and merges every registry found under `dirs`. Instances are deduped
 * by id (first occurrence wins): a user running both Code and Insiders with
 * the same account configuration would otherwise see every instance twice.
 *
 * Returns `undefined` when no directory holds a registry file at all, and
 * `corruptPaths` collects files that exist but do not parse — a distinction
 * the error message needs ("extension never ran" vs "registry damaged").
 */
async function readRegistries(
  dirs: string[],
): Promise<{ instances: McpInstanceRegistryEntry[]; corruptPaths: string[] } | undefined> {
  const instances: McpInstanceRegistryEntry[] = [];
  const seenIds = new Set<string>();
  const corruptPaths: string[] = [];
  let found = false;
  for (const dir of dirs) {
    const registryPath = path.join(dir, INSTANCE_REGISTRY_BASENAME);
    let raw: string;
    try {
      const stats = await fs.promises.stat(registryPath);
      if (!stats.isFile() || stats.size > MAX_FILE_BYTES) {
        continue;
      }
      raw = await fs.promises.readFile(registryPath, 'utf8');
    } catch {
      continue;
    }
    found = true;
    // Read as `unknown` all the way down: the bytes come from a file another
    // extension version may have written, so the shared type is documentation,
    // not something to assert. Entries that fail the field check are skipped
    // rather than failing the whole file (same contract as the state reader).
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      corruptPaths.push(registryPath);
      continue;
    }
    const list = (parsed as { instances?: unknown } | null)?.instances;
    if (!Array.isArray(list)) {
      corruptPaths.push(registryPath);
      continue;
    }
    for (const entry of list as unknown[]) {
      if (!entry || typeof entry !== 'object') {
        continue;
      }
      const candidate = entry as Record<string, unknown>;
      if (typeof candidate.id !== 'string' || typeof candidate.url !== 'string') {
        continue;
      }
      if (seenIds.has(candidate.id)) {
        continue;
      }
      seenIds.add(candidate.id);
      instances.push({
        id: candidate.id,
        // Stripped defensively: the writer already strips userinfo, but this
        // file is a trust boundary — its URLs are logged and connected to.
        url: stripUrlUserinfo(candidate.url),
        name: typeof candidate.name === 'string' ? candidate.name : '',
      });
    }
  }
  return found ? { instances, corruptPaths } : undefined;
}

/**
 * The newest readable workspace state file across the candidate directories.
 * Only the newest is consulted — for the localPath shortcut and for the
 * last-resort fallback alike: older files belong to workspaces that were not
 * touched as recently, and a stale second opinion is worse than falling
 * through to the next matching stage.
 */
async function newestStateFile(dirs: string[]): Promise<string | undefined> {
  let newest: { filePath: string; mtimeMs: number } | undefined;
  for (const dir of dirs) {
    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isFile() || !STATE_FILE_BASENAME.test(entry.name)) {
        continue;
      }
      const filePath = path.join(dir, entry.name);
      try {
        const stats = await fs.promises.stat(filePath);
        if (stats.size > MAX_FILE_BYTES) {
          continue;
        }
        if (!newest || stats.mtimeMs > newest.mtimeMs) {
          newest = { filePath, mtimeMs: stats.mtimeMs };
        }
      } catch {
        // Vanished between readdir and stat — a window closed meanwhile.
      }
    }
  }
  return newest?.filePath;
}

/**
 * The comparison form for local checkout paths. Case is folded on Windows
 * only: its filesystems are case-insensitive, while Linux is sensitive and
 * macOS can be either — folding there would merge genuinely distinct paths.
 */
function normalizeLocalPath(localPath: string, platform: NodeJS.Platform): string {
  const resolved = path.resolve(localPath);
  return platform === 'win32' ? resolved.toLowerCase() : resolved;
}

/**
 * The repository entries of a state file, read leniently (writer and reader
 * can be on different extension versions): entries without a usable
 * localPath/instanceUrl pair are skipped, and a file that does not parse
 * yields undefined — leaving the later matching stages to try.
 */
async function readStateFileEntries(stateFilePath: string): Promise<Record<string, unknown>[] | undefined> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await fs.promises.readFile(stateFilePath, 'utf8'));
  } catch {
    return undefined;
  }
  const list = (parsed as { repositories?: unknown } | null)?.repositories;
  if (!Array.isArray(list)) {
    return undefined;
  }
  return (list as unknown[]).filter(
    (entry): entry is Record<string, unknown> =>
      !!entry &&
      typeof entry === 'object' &&
      typeof (entry as Record<string, unknown>).localPath === 'string' &&
      typeof (entry as Record<string, unknown>).instanceUrl === 'string',
  );
}

/**
 * The instance URL of the state-file entry whose checkout contains the
 * working directory, if any.
 */
function matchStateFileEntry(entries: Record<string, unknown>[], options: AutoConfigOptions): string | undefined {
  const cwd = normalizeLocalPath(options.cwd, options.platform);
  for (const candidate of entries) {
    if (normalizeLocalPath(candidate.localPath as string, options.platform) === cwd) {
      return candidate.instanceUrl as string;
    }
  }
  return undefined;
}

/**
 * The fallback guess: the instance URL of the entry flagged `active` — the
 * repository the user's editor context is attributed to — or, when no entry
 * is flagged (the writer only sets the flag on unambiguous attribution), of
 * the first entry. Either way this is the instance the user most recently
 * worked with, which is the best available answer when the working directory
 * itself matches nothing.
 */
function fallbackStateFileEntryUrl(entries: Record<string, unknown>[]): string | undefined {
  const active = entries.find((entry) => entry.active === true);
  const pick = active ?? entries[0];
  return pick?.instanceUrl as string | undefined;
}

/**
 * The remote URLs of the git repository at `cwd`, parsed from the config
 * file — never by spawning git: the MCP child should start even on a machine
 * where git is not on the PATH, and a spawn per startup is avoidable I/O.
 *
 * Both `.git` forms are handled: the directory (ordinary clone, config at
 * `.git/config`) and the gitfile of a worktree/submodule (`gitdir: <path>`,
 * with the remotes living in the common directory's config when a `commondir`
 * file says the gitdir is a per-worktree one). A working directory that is
 * not a git repository simply yields no remotes, and remote matching is
 * skipped.
 */
async function readGitRemoteUrls(cwd: string): Promise<{ name: string; url: string }[]> {
  const dotGit = path.join(cwd, '.git');
  let configPath: string | undefined;
  try {
    const stats = await fs.promises.stat(dotGit);
    if (stats.isDirectory()) {
      configPath = path.join(dotGit, 'config');
    } else {
      const gitdirLine = /^\s*gitdir\s*:\s*(.+?)\s*$/m.exec(await fs.promises.readFile(dotGit, 'utf8'));
      if (!gitdirLine) {
        return [];
      }
      let gitDir = path.resolve(cwd, gitdirLine[1]);
      try {
        const common = (await fs.promises.readFile(path.join(gitDir, 'commondir'), 'utf8')).trim();
        gitDir = path.resolve(gitDir, common);
      } catch {
        // No commondir file: the gitdir is the repository's own directory.
      }
      configPath = path.join(gitDir, 'config');
    }
  } catch {
    return [];
  }
  let raw: string;
  try {
    raw = await fs.promises.readFile(configPath, 'utf8');
  } catch {
    return [];
  }
  // A deliberately small INI reader: only `[remote "<name>"]` sections and
  // their `url =` keys matter. `insteadOf` rewrites and `pushurl` are ignored
  // — this is a heuristic for picking an instance, not a git config engine.
  const remotes: { name: string; url: string }[] = [];
  let currentRemote: string | undefined;
  for (const line of raw.split(/\r?\n/)) {
    const section = /^\s*\[\s*remote\s+"([^"]+)"\s*\]/.exec(line);
    if (section) {
      currentRemote = section[1];
      continue;
    }
    if (/^\s*\[/.test(line)) {
      currentRemote = undefined;
      continue;
    }
    if (currentRemote) {
      const url = /^\s*url\s*=\s*(\S+)\s*(?:[;#].*)?$/.exec(line);
      if (url) {
        remotes.push({ name: currentRemote, url: url[1] });
      }
    }
  }
  // origin first, the rest in config order: when several remotes point at
  // different instances, origin is the checkout's own upstream.
  return remotes.sort((a, b) => (a.name === 'origin' ? -1 : b.name === 'origin' ? 1 : 0));
}

interface RemoteHostPath {
  /** Lowercase host(+port)/path comparison form (`.git` suffix and trailing slashes removed). */
  hostPath: string;
  /** True when the remote's port is transport-level (ssh/git/scp) and must not be compared. */
  ignoresPort: boolean;
}

/**
 * A remote URL reduced to its host/path comparison form, or undefined for
 * input that is not a parseable remote.
 *
 * This is a deliberately simplified, vscode-free variant of
 * `remoteMatchesInstance`'s parsing in src/worktree/gitOperations.ts — that
 * module imports `vscode` and cannot be bundled into the MCP server, so the
 * same structural rules are reimplemented here on top of the shared
 * `normalizeGitUrl` helper: scp-style `user@host:path` with any login,
 * ssh/git transport ports dropped (a self-hosted server commonly serves SSH
 * on 2222 while the web UI runs on 3000), http(s) ports kept.
 */
function parseRemoteHostPath(remoteUrl: string): RemoteHostPath | undefined {
  const cleaned = remoteUrl.trim();
  if (!cleaned) {
    return undefined;
  }
  if (!cleaned.includes('://')) {
    // scp-style syntax; git accepts any login, not just `git@`.
    const scp = /^[^\s@]+@([^\s:]+):(.+)$/.exec(cleaned);
    if (!scp) {
      return undefined;
    }
    return { hostPath: normalizeGitUrl(`${scp[1]}/${scp[2]}`), ignoresPort: true };
  }
  let parsed: URL;
  try {
    parsed = new URL(cleaned);
  } catch {
    return undefined;
  }
  const ignoresPort = parsed.protocol === 'ssh:' || parsed.protocol === 'git:';
  const host = ignoresPort ? parsed.hostname : parsed.host;
  return { hostPath: normalizeGitUrl(`${host}${parsed.pathname}`), ignoresPort };
}

/**
 * True when the remote names a repository on the instance.
 *
 * The instance contributes its host(+port) plus deployment sub-path as a
 * prefix key (and a port-less twin for ssh/git/scp remotes); the remote must
 * extend that prefix by at least owner and repo, so the instance root itself
 * is not "a repository". Same rules as the extension host's
 * `remoteMatchesInstance`, minus the features a headless matcher does not
 * need.
 */
export function remoteMatchesInstanceUrl(remoteUrl: string, instanceUrl: string): boolean {
  const remote = parseRemoteHostPath(remoteUrl);
  if (!remote) {
    return false;
  }
  let instance: URL;
  try {
    instance = new URL(stripUrlUserinfo(instanceUrl));
  } catch {
    return false;
  }
  const keys = [normalizeGitUrl(`${instance.host}${instance.pathname}`)];
  if (remote.ignoresPort) {
    keys.push(normalizeGitUrl(`${instance.hostname}${instance.pathname}`));
  }
  return keys.some((key) => {
    const rest =
      remote.hostPath === key
        ? ''
        : remote.hostPath.startsWith(`${key}/`)
          ? remote.hostPath.slice(key.length + 1)
          : undefined;
    if (rest === undefined) {
      return false;
    }
    return rest.split('/').filter(Boolean).length >= 2;
  });
}

export interface RemoteInstanceMatch {
  instance: McpInstanceRegistryEntry;
  /** The remote URL that produced the match, for the log line. */
  remoteUrl: string;
  /**
   * True when more than one registry instance matched the same remote — two
   * accounts on one host. The registry carries no username, so the owner
   * namespace cannot be compared against the account name; the first match
   * wins and the caller should log the ambiguity. Known limitation.
   */
  ambiguous: boolean;
}

/**
 * The first registry instance any remote matches, origin's remote first.
 */
export function matchInstanceForRemotes(
  remotes: { name: string; url: string }[],
  instances: McpInstanceRegistryEntry[],
): RemoteInstanceMatch | undefined {
  for (const remote of remotes) {
    const matches = instances.filter((instance) => remoteMatchesInstanceUrl(remote.url, instance.url));
    if (matches.length > 0) {
      return { instance: matches[0], remoteUrl: remote.url, ambiguous: matches.length > 1 };
    }
  }
  return undefined;
}

/**
 * Resolves the instance URL for a server launched without
 * FORGEJO_MCP_INSTANCE_URL — see the module header for the discovery order.
 */
export async function resolveAutoConfiguration(
  options: AutoConfigOptions = defaultOptions(),
): Promise<AutoConfigResult> {
  const { dirs, searched } = await discoverDataDirs(options);
  const searchedList = searched.map((dir) => `  - ${dir}`).join('\n');
  const registry = await readRegistries(dirs);
  if (!registry) {
    return {
      status: 'failed',
      message:
        'FORGEJO_MCP_INSTANCE_URL is not set and no forgejo-toolkit instance registry ' +
        `(${INSTANCE_REGISTRY_BASENAME}) was found. Searched:\n${searchedList}\n` +
        'Run the Forgejo Toolkit extension in VS Code once so it publishes the registry, ' +
        'or set FORGEJO_MCP_INSTANCE_URL (and optionally FORGEJO_MCP_TOKEN) explicitly.',
    };
  }
  if (registry.corruptPaths.length > 0 && registry.instances.length === 0) {
    return {
      status: 'failed',
      message:
        `The forgejo-toolkit instance registry exists but could not be parsed:\n` +
        registry.corruptPaths.map((filePath) => `  - ${filePath}`).join('\n') +
        '\nOpen the Forgejo Toolkit extension in VS Code so it rewrites the registry, ' +
        'or set FORGEJO_MCP_INSTANCE_URL (and optionally FORGEJO_MCP_TOKEN) explicitly.',
    };
  }

  // Shortcut: the newest workspace state file may already know which instance
  // this working directory's checkout belongs to. The entries are read once
  // and shared with the last-resort fallback below.
  const stateFile = await newestStateFile(dirs);
  const stateEntries = stateFile ? await readStateFileEntries(stateFile) : undefined;
  if (stateEntries) {
    const instanceUrl = matchStateFileEntry(stateEntries, options);
    if (instanceUrl) {
      return { status: 'matched', url: instanceUrl, via: 'state-file', stateFile };
    }
  }

  const remotes = await readGitRemoteUrls(options.cwd);
  const match = matchInstanceForRemotes(remotes, registry.instances);
  if (match) {
    return {
      status: 'matched',
      url: match.instance.url,
      via: 'git-remote',
      stateFile,
      note: match.ambiguous
        ? `Several configured instances match ${stripUrlUserinfo(match.remoteUrl)}; using the first (${match.instance.name || match.instance.url}). Set FORGEJO_MCP_INSTANCE_URL to pick another.`
        : undefined,
    };
  }

  // Last resort: the working directory matched nothing (the Agents window's
  // Agent Host launches servers from the user's home directory, which is no
  // checkout at all), so guess the instance the user most recently worked
  // with from the newest state file. This can pick the wrong instance for
  // the task at hand — the caller logs it as a guess, not as a match.
  if (stateEntries) {
    const fallbackUrl = fallbackStateFileEntryUrl(stateEntries);
    if (fallbackUrl) {
      return { status: 'matched', url: fallbackUrl, via: 'state-file-fallback', stateFile };
    }
  }

  const configured =
    registry.instances.length > 0
      ? registry.instances.map((instance) => `  - ${instance.url}`).join('\n')
      : '  (the registry lists no instances)';
  return {
    status: 'failed',
    message:
      'Could not match this working directory to any configured Forgejo instance ' +
      `(no workspace state entry and no git remote match for ${options.cwd}). ` +
      `Configured instances:\n${configured}\n` +
      'Set FORGEJO_MCP_INSTANCE_URL (and optionally FORGEJO_MCP_TOKEN) explicitly to choose one.',
  };
}
