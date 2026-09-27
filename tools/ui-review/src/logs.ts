// Per-window log capture for the shared-profile dual-window mode.
//
// The dual-window mode exists because the two windows must be *observable
// separately*: each VS Code window writes its own `logs/<session>/window<N>/`
// directory, and `<session>` is the app's log session (`20260927T164507`), shared
// by every window of the instance. So the questions the lease work needs answered
// — "which window is polling/leader", "how long did the handover take", "did the
// survivor keep working" — are answered by diffing two window directories, not by
// reading one shared log.
//
// The rules that keep that honest:
//   * the session is pinned from the state file written by `dual.ts launch`;
//     resolution never silently falls back to another session;
//   * the extension's output channel lives in the *newest*
//     `exthost/output_logging_<stamp>/N-Forgejo Toolkit.log`, because a window
//     that reloads after its extension host is killed starts a new one.
import fs from 'node:fs';
import path from 'node:path';
import { DEFAULT_WINDOW_DIRS, type WindowLabel, type WindowSelector } from './windows';

export interface LogRoots {
  /** `tools/ui-review/profile/logs` */
  logsRoot: string;
  /** `logs/<session>`; pinned from the state file when the mode launched the host. */
  sessionDir: string;
  session: string;
}

export interface WindowLogDir {
  /** e.g. `window2`; the directory actually found on disk. */
  name: string;
  dir: string;
}

export const SESSION_DIR_PATTERN = /^\d{8}T\d{6}$/;

/** A single backslash, spelled without regex-literal escaping inside a template. */
const BACKSLASH = String.fromCharCode(92);
/** The characters a regex treats specially. */
const METACHARACTERS = '.*+?^${}()|[]';

/** Escape a literal string so it can be compiled as a regex. */
export function escapeRegExp(value: string): string {
  let out = '';
  for (const character of value) {
    if (character === BACKSLASH || METACHARACTERS.includes(character)) out += `${BACKSLASH}${character}`;
    else out += character;
  }
  return out;
}

export function isSessionDirName(name: string): boolean {
  return SESSION_DIR_PATTERN.test(name);
}

/** Session directories, oldest first (their names are lexicographically sortable). */
export function listSessionDirs(logsRoot: string): string[] {
  if (!fs.existsSync(logsRoot)) return [];
  return fs
    .readdirSync(logsRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && isSessionDirName(entry.name))
    .map((entry) => entry.name)
    .sort();
}

export function resolveSessionDir(logsRoot: string, session?: string): string {
  if (session) {
    if (!isSessionDirName(session)) {
      throw new Error(`'${session}' is not a log session name (expected e.g. 20260927T164507)`);
    }
    const dir = path.join(logsRoot, session);
    if (!fs.existsSync(dir)) {
      throw new Error(
        `log session ${session} does not exist under ${logsRoot}; it may have been cleaned up ` +
          '(the harness must have launched that dev host — do not read another session)',
      );
    }
    return dir;
  }
  const sessions = listSessionDirs(logsRoot);
  if (sessions.length === 0) {
    throw new Error(`no log session directories under ${logsRoot}: has the dev host ever run?`);
  }
  return path.join(logsRoot, sessions[sessions.length - 1]);
}

export function listWindowDirs(sessionDir: string): WindowLogDir[] {
  if (!fs.existsSync(sessionDir)) return [];
  return fs
    .readdirSync(sessionDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && /^window\d+$/.test(entry.name))
    .map((entry) => ({ name: entry.name, dir: path.join(sessionDir, entry.name) }))
    .sort((a, b) => windowNumber(a.name) - windowNumber(b.name));
}

export function windowNumber(name: string): number {
  const match = /^window(\d+)$/.exec(name);
  return match ? Number(match[1]) : Number.MAX_SAFE_INTEGER;
}

/** Wait (bounded) for `logs/<session>/window<N>` to appear — windows start asynchronously. */
export async function waitForWindowDir(
  sessionDir: string,
  name: string,
  timeoutMs = 60_000,
  intervalMs = 500,
): Promise<WindowLogDir> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const found = listWindowDirs(sessionDir).find((entry) => entry.name === name);
    if (found) return found;
    if (Date.now() > deadline) {
      throw new Error(
        `timed out waiting for ${path.join(sessionDir, name)}; the window never wrote its log ` +
          '(was it started inside the same instance, i.e. Ctrl+Shift+N?)',
      );
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

/**
 * `window1`/`window2` are *labels* the harness hands out by launch order, while
 * VS Code numbers its own window directories per shell lifetime (a fresh dev host
 * can start at `window3`). On current builds the extension-host process carries no
 * per-window marker at all (no `--logsPath`, no `--user-data-dir`, and the same
 * `--type=utility --utility-sub-type=node.mojom.NodeService` as five other
 * processes), so the *log* is the only link: the pid each window's own
 * `exthost/exthost.log` records is what ties that directory to a window.
 */
export interface WindowLogDirFacts {
  dir: WindowLogDir;
  /** Every `Extension host with pid <n> started` pid in that directory, oldest first. */
  exthostPids: number[];
}

export function windowLogDirFacts(sessionDir: string): WindowLogDirFacts[] {
  return listWindowDirs(sessionDir).map((dir) => ({ dir, exthostPids: exthostLogPids(dir.dir) }));
}

/**
 * Attribute the session's window directories to the launched windows.
 *
 * Preferred: match each pid in `recordedPids` against the pid in a window's log.
 * Because that needs the pids *before* the directories are known, the fallback is
 * VS Code's own numbering — for the two lowest-numbered directories, the lower
 * number is the window that was there first, i.e. `window1`. The fallback is only
 * used when the pids cannot decide, and the chosen directory is still reported so
 * a reader can check it against `exthost.log`.
 *
 * `labels` is what the caller needs: the mode asks for both windows, while
 * `dual logs 1` only asks for one (a single-window session is a legitimate state
 * and must not be turned into an error by the other label).
 */
export function attributeWindowDirs(
  sessionDir: string,
  recordedPids: ReadonlyMap<WindowLabel, number> = new Map(),
  labels: readonly WindowLabel[] = DEFAULT_WINDOW_DIRS,
): Record<WindowLabel, WindowLogDir> {
  const facts = windowLogDirFacts(sessionDir);
  const byPid = new Map<number, WindowLogDir>();
  for (const fact of facts) {
    const pid = fact.exthostPids[fact.exthostPids.length - 1];
    if (pid !== undefined && !byPid.has(pid)) byPid.set(pid, fact.dir);
  }
  const result = {} as Record<WindowLabel, WindowLogDir>;
  const missing: string[] = [];
  for (const label of labels) {
    const recorded = recordedPids.get(label);
    if (recorded !== undefined) {
      const matched = byPid.get(recorded);
      if (matched) {
        result[label] = matched;
        continue;
      }
      missing.push(`${label} (recorded exthost pid ${recorded})`);
      continue;
    }
    // No recorded pid: use VS Code's numbering, lowest two directories.
    const index = Number(label.slice('window'.length)) - 1;
    const candidate = facts[index];
    if (candidate) result[label] = candidate.dir;
    else missing.push(label);
  }
  if (missing.length > 0) {
    throw new Error(
      `could not attribute a log directory to ${missing.join(', ')} under ${sessionDir}; ` +
        `directories present: ${facts.map((fact) => `${fact.dir.name}${fact.exthostPids.length ? ` (pids ${fact.exthostPids.join(', ')})` : ' (no exthost pid yet)'}`).join('; ') || '(none)'}`,
    );
  }
  return result;
}

/** Every `Extension host with pid <n>` mentioned in a window's `exthost/exthost.log`. */
export function exthostLogPids(windowDir: string): number[] {
  const logFile = path.join(windowDir, 'exthost', 'exthost.log');
  if (!fs.existsSync(logFile)) return [];
  const text = fs.readFileSync(logFile, 'utf8');
  const pids: number[] = [];
  for (const match of text.matchAll(/Extension host with pid (\d+) started/g)) {
    pids.push(Number(match[1]));
  }
  return pids;
}

export function exthostLogPath(windowDir: string): string {
  return path.join(windowDir, 'exthost', 'exthost.log');
}

/**
 * The extension's own output channel. A reload after the extension host is killed
 * creates a new `output_logging_<stamp>` directory, so the newest one is picked.
 */
export function extensionOutputLog(windowDir: string): string | null {
  const exthostDir = path.join(windowDir, 'exthost');
  if (!fs.existsSync(exthostDir)) return null;
  const outputDirs = fs
    .readdirSync(exthostDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name.startsWith('output_logging_'))
    .map((entry) => entry.name)
    .sort();
  for (const outputDir of outputDirs.reverse()) {
    const dir = path.join(exthostDir, outputDir);
    const named = fs
      .readdirSync(dir)
      .filter((name) => /Forgejo Toolkit\.log$/i.test(name))
      .sort();
    if (named.length > 0) return path.join(dir, named[named.length - 1]);
  }
  return null;
}

export type LogPreset = 'extension' | 'exthost' | 'mcp' | 'any';

export interface LogFileEntry {
  label: WindowLabel | string;
  file: string;
  mtimeMs: number;
}

/**
 * Which files a preset means inside one window directory. `mcp` covers the sinks
 * the README documents for broker verification (`mcpServer.*.log`, one per client
 * plus the gateway's own `mcpServer.mcp.config.usrlocal.<name>.log`).
 */
export function logFilesFor(windowDir: string, preset: LogPreset): string[] {
  const files: string[] = [];
  if (preset === 'extension') {
    const file = extensionOutputLog(windowDir);
    if (file) files.push(file);
    return files;
  }
  if (preset === 'exthost') {
    const file = exthostLogPath(windowDir);
    if (fs.existsSync(file)) files.push(file);
    return files;
  }
  if (preset === 'any') {
    return walkFiles(windowDir);
  }
  for (const file of walkFiles(windowDir)) {
    if (/mcpServer\..*\.log$/i.test(path.basename(file))) files.push(file);
  }
  return files;
}

function walkFiles(root: string): string[] {
  const out: string[] = [];
  const visit = (dir: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) visit(full);
      else if (entry.isFile()) out.push(full);
    }
  };
  visit(root);
  return out.sort();
}

export interface LogQuery {
  preset: LogPreset;
  /** Literal substring (case-insensitive) or `/regex/flags`; both optional. */
  grep?: string;
  /** Keep only the last N matching lines per file. */
  tail?: number;
}

export interface LogMatch {
  file: string;
  line: number;
  text: string;
}

export function compilePattern(pattern: string): RegExp {
  const asRegex = /^\/(.*)\/([a-z]*)$/.exec(pattern);
  if (asRegex) return new RegExp(asRegex[1], asRegex[2] || 'i');
  return new RegExp(escapeRegExp(pattern), 'i');
}

export function grepFiles(files: readonly string[], query: LogQuery): LogMatch[] {
  const pattern = query.grep ? compilePattern(query.grep) : null;
  const matches: LogMatch[] = [];
  for (const file of files) {
    let text: string;
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    const kept: LogMatch[] = [];
    const lines = text.split(/\r?\n/);
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index];
      if (pattern && !pattern.test(line)) continue;
      if (!pattern && line.trim() === '') continue;
      kept.push({ file, line: index + 1, text: line });
    }
    matches.push(...(query.tail ? kept.slice(-query.tail) : kept));
  }
  return matches;
}

export function describeWindowLogs(roots: LogRoots, windowDirs: readonly WindowLogDir[], preset: LogPreset): string {
  const lines = [`session ${roots.session} (${roots.sessionDir})`];
  for (const windowDir of windowDirs) {
    const files = logFilesFor(windowDir.dir, preset);
    lines.push(`  ${windowDir.name}: ${files.length} file(s)`);
    for (const file of files) lines.push(`    ${path.relative(roots.sessionDir, file)}`);
  }
  return lines.join('\n');
}

export function selectWindowDirs(
  sessionDir: string,
  selector: WindowSelector,
  exthostPids?: ReadonlyMap<WindowLabel, number>,
): WindowLogDir[] {
  if (selector === 'all') return listWindowDirs(sessionDir);
  const mapped = attributeWindowDirs(sessionDir, exthostPids ?? new Map(), [selector]);
  return [mapped[selector]];
}
