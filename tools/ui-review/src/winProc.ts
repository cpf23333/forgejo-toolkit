// Dev-host process inventory: which Code.exe processes belong to this harness,
// which of them is a window, and which extension host belongs to which window.
//
// Everything in this file except `listDevHostProcesses` / `killProcess` is pure,
// so the selection rules can be unit-tested without a running dev host. The two
// impure functions shell out to PowerShell, the same way kill.ts does.
//
// Known limitation (must be verified by a real run, see README): Windows does not
// let a user-mode tool read another process's environment block, and the
// extension host's *parent* is the window's root process, not necessarily the
// window we want. Pairing window -> exthost therefore uses the extension host's
// creation time as the last resort, and the pairing is only trusted after it is
// cross-checked against `exthost/exthost.log` (see logs.ts `exthostLogPids`).
import { execFileSync } from 'node:child_process';

export type ProcessRole = 'window' | 'extensionHost' | 'other';

/** The Electron sub-type a VS Code extension host runs as on current builds. */
export const NODE_SERVICE_SUBTYPE = 'node.mojom.nodeservice';

export interface DevHostProcess {
  pid: number;
  parentPid: number;
  /** `--type=` value, lower-cased (`extensionHost`, `utility`, `window`, `renderer`, …) or null for the root. */
  type: string | null;
  /** `--utility-sub-type=` value, lower-cased (`node.mojom.NodeService`, …) or null. */
  utilitySubType: string | null;
  /** `--user-data-dir=` argument, exactly as passed (no quoting stripped twice). */
  userDataDir: string | null;
  /** `--logsPath=` argument, when VS Code passed one to this process. */
  logsPath: string | null;
  /** ISO-8601 creation time from `Get-Date -Format o`. */
  createdAt: string | null;
  commandLine: string;
}

/**
 * Which process is a window, and which is *plausibly* an extension host.
 *
 * Two shapes have to be recognised, because they differ per VS Code/Electron
 * build (measured live on 2026-09-27, see the README):
 *   - `--type=extensionHost` (the older/desktop shape);
 *   - `--type=utility --utility-sub-type=node.mojom.NodeService` (current builds).
 *
 * The NodeService shape is **not** a positive identification: several such
 * processes run per window (the extension host is only one of them, and the log
 * session showed six), and none of them carries `--logsPath` or
 * `--user-data-dir`. A window's extension host is therefore identified by the pid
 * its own `exthost/exthost.log` names (see `pairExtensionHosts` with `logPids`),
 * never by this classification alone.
 */
export function classifyProcess(process: Pick<DevHostProcess, 'type' | 'utilitySubType'>): ProcessRole {
  const type = process.type?.toLowerCase() ?? null;
  if (type === null) return 'window';
  if (type === 'extensionhost') return 'extensionHost';
  if (type === 'utility' && process.utilitySubType?.toLowerCase() === NODE_SERVICE_SUBTYPE) {
    return 'extensionHost';
  }
  return 'other';
}

export function isNodeService(process: Pick<DevHostProcess, 'type' | 'utilitySubType'>): boolean {
  return process.type?.toLowerCase() === 'utility' && process.utilitySubType?.toLowerCase() === NODE_SERVICE_SUBTYPE;
}

export interface ParsedCommandLine {
  type: string | null;
  utilitySubType: string | null;
  userDataDir: string | null;
  logsPath: string | null;
  extensionDevelopmentPath: string | null;
}

function readFlag(commandLine: string, flag: string): string | null {
  // Both `--type=extensionHost` (Electron) and `--type extensionHost` are seen
  // across Chromium versions; VS Code's own flags are always the `=` spelling.
  const equals = new RegExp(`(?:^|\\s)${flag}=("([^"]*)"|(\\S+))`, 'i');
  const spaced = new RegExp(`(?:^|\\s)${flag}\\s+("([^"]*)"|(\\S+))`, 'i');
  for (const pattern of [equals, spaced]) {
    const match = pattern.exec(commandLine);
    if (match) return (match[2] ?? match[3] ?? '').replace(/\\+$/, '');
  }
  return null;
}

export function parseCommandLine(commandLine: string): ParsedCommandLine {
  const type = readFlag(commandLine, '--type');
  const utilitySubType = readFlag(commandLine, '--utility-sub-type');
  return {
    type: type ? type.toLowerCase() : null,
    utilitySubType: utilitySubType ? utilitySubType.toLowerCase() : null,
    userDataDir: readFlag(commandLine, '--user-data-dir'),
    logsPath: readFlag(commandLine, '--logsPath'),
    extensionDevelopmentPath: readFlag(commandLine, '--extensionDevelopmentPath'),
  };
}

export function toDevHostProcess(raw: {
  ProcessId: number;
  ParentProcessId: number;
  CommandLine?: string | null;
  CreationDate?: string | null;
}): DevHostProcess {
  const commandLine = raw.CommandLine ?? '';
  const parsed = parseCommandLine(commandLine);
  return {
    pid: raw.ProcessId,
    parentPid: raw.ParentProcessId,
    type: parsed.type,
    utilitySubType: parsed.utilitySubType,
    userDataDir: parsed.userDataDir,
    logsPath: parsed.logsPath,
    createdAt: raw.CreationDate ?? null,
    commandLine,
  };
}

export function windowProcesses(processes: readonly DevHostProcess[]): DevHostProcess[] {
  return processes.filter((p) => classifyProcess(p) === 'window').sort((a, b) => a.pid - b.pid);
}

/**
 * Processes that *could* be an extension host: the unambiguous
 * `--type=extensionHost` shape, plus every NodeService utility process (which is
 * ambiguous on current builds). Used for counting and diagnostics; the real
 * pairing goes through the log pids.
 */
export function extensionHostCandidates(processes: readonly DevHostProcess[]): DevHostProcess[] {
  return processes
    .filter((p) => classifyProcess(p) === 'extensionHost')
    .sort((a, b) => compareCreatedAt(a, b) || a.pid - b.pid);
}

export function extensionHostProcesses(processes: readonly DevHostProcess[]): DevHostProcess[] {
  return extensionHostCandidates(processes);
}

function compareCreatedAt(a: DevHostProcess, b: DevHostProcess): number {
  const left = a.createdAt ? Date.parse(a.createdAt) : NaN;
  const right = b.createdAt ? Date.parse(b.createdAt) : NaN;
  if (Number.isNaN(left) || Number.isNaN(right)) return 0;
  return left - right;
}

export interface ProfileOwners {
  /** `--user-data-dir` values seen on the harness processes, de-duplicated (case-insensitive). */
  profiles: string[];
  /** True when every process that reported a profile reported the same one. */
  consistent: boolean;
}

/**
 * The "one profile, two windows" invariant, as far as process command lines can
 * prove it. `--user-data-dir` is not guaranteed to be present on every process,
 * so this reports what it found rather than guessing; callers must fail loudly
 * when `consistent` is false.
 */
export function profileOwners(processes: readonly DevHostProcess[]): ProfileOwners {
  const seen = new Map<string, string>();
  for (const process of processes) {
    if (!process.userDataDir) continue;
    const key = normalizeWinPath(process.userDataDir);
    if (!seen.has(key)) seen.set(key, process.userDataDir);
  }
  const profiles = [...seen.values()].sort();
  return { profiles, consistent: profiles.length <= 1 };
}

export function normalizeWinPath(value: string): string {
  return value.replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase();
}

export interface ExthostPairing {
  window1: ExthostRef;
  window2: ExthostRef;
}

export interface ExthostRef {
  /** The pid the window's own log names, or null when the log is missing. */
  pid: number | null;
  /** Where the pid came from: the window's log (authoritative), or the process table. */
  source: 'log' | 'process-table';
  /** The process, when it is currently in the table. */
  process: DevHostProcess | null;
  /**
   * Our best evidence that this pid is alive: the process table, or `process.kill(pid, 0)`
   * for a pid the table no longer carries (it may have exited between the two reads).
   */
  alive: boolean;
}

/**
 * Pair the two windows' extension hosts to the pids their own logs name.
 *
 * `logPids` is the authoritative input (window label -> the pid(s) recorded as
 * `Extension host with pid <n> started` in that window's `exthost/exthost.log`).
 * The log is the *only* reliable link on current VS Code builds: neither
 * `--logsPath` nor `--user-data-dir` is passed to the extension host, and the
 * extension host does not carry `--type=extensionHost` at all — it is one of
 * several `--type=utility --utility-sub-type=node.mojom.NodeService` processes per
 * window (six in the measured session), with no per-window marker in its command
 * line. Creation order is therefore only a fallback for the older shape.
 */
export function pairExtensionHosts(
  processes: readonly DevHostProcess[],
  logPids: ReadonlyMap<'window1' | 'window2', readonly number[]> = new Map(),
): ExthostPairing {
  const hasLogPids = logPids.size > 0;
  const window1 = hasLogPids ? resolveFromLog('window1', logPids.get('window1') ?? [], processes) : null;
  const window2 = hasLogPids ? resolveFromLog('window2', logPids.get('window2') ?? [], processes) : null;
  if (window1 && window2) {
    if (window1.pid !== null && window1.pid === window2.pid) {
      throw new Error(
        `both windows' logs name the same extension host pid ${window1.pid}; the log directories were ` +
          'attributed to the wrong windows',
      );
    }
    return { window1, window2 };
  }

  // No log pids to work with: fall back to the unambiguous process shape.
  const hosts = processes
    .filter((p) => classifyProcess(p) === 'extensionHost')
    .sort((a, b) => compareCreatedAt(a, b) || a.pid - b.pid);
  if (hosts.length === 0) {
    throw new Error(
      'no extension host process found: is the dev host running, and did both windows load the extension?',
    );
  }
  if (hosts.length > 2) {
    throw new Error(
      `found ${hosts.length} extension-host-shaped processes and no exthost.log pids to disambiguate them; ` +
        `this mode only understands the two windows it launched: ${hosts.map((h) => h.pid).join(', ')}`,
    );
  }
  if (hosts.length === 1) {
    throw new Error(
      'only one candidate extension host is running and no exthost.log pid to confirm it: the second window ' +
        'did not load the extension (check that it was opened with Ctrl+Shift+N inside the running instance)',
    );
  }
  const toRef = (process: DevHostProcess): ExthostRef => ({
    pid: process.pid,
    source: 'process-table',
    process,
    alive: true,
  });
  return { window1: toRef(hosts[0]), window2: toRef(hosts[1]) };
}

function resolveFromLog(
  label: 'window1' | 'window2',
  pids: readonly number[],
  processes: readonly DevHostProcess[],
): ExthostRef | null {
  if (pids.length === 0) return null;
  const table = new Map(processes.map((process) => [process.pid, process]));
  for (let index = pids.length - 1; index >= 0; index -= 1) {
    const pid = pids[index];
    const process = table.get(pid) ?? null;
    if (process) return { pid, source: 'log', process, alive: true };
    if (!isPidAlive(pid)) {
      // The window's extension host is gone (killed, or reloaded and not yet
      // restarted). That is a legitimate state to *report*; `kill` refuses it.
      return { pid, source: 'log', process: null, alive: false };
    }
    // Alive but not in the (filtered) table: keep looking at older entries.
  }
  return { pid: pids[pids.length - 1], source: 'log', process: null, alive: true };
}

/**
 * `process.kill(pid, 0)` — the existence probe the extension itself uses for the
 * lease and the broker. `EPERM` counts as alive (the process exists, we just may
 * not signal it).
 */
export function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** `Stop-Process -Force` on one pid: a crash shape, no `deactivate()` runs. */
export function stopProcessCommand(pid: number): string {
  if (!Number.isInteger(pid) || pid <= 0) throw new Error(`refusing to build a kill command for pid ${pid}`);
  return `Stop-Process -Id ${pid} -Force`;
}

export interface KillTarget {
  label: string;
  pid: number;
  type: string | null;
  command: string;
}

/**
 * Resolve a window's extension-host reference into the exact `Stop-Process` call.
 *
 * Refused cases, all of which have been seen or are one read away from being seen:
 * a null pid (the window's log has no `Extension host with pid` line), a pid whose
 * process is not in the table (already killed or exited — killing nothing would
 * misreport success), and a pid that is a window root rather than an extension
 * host. On the current build the extension host is a NodeService utility process,
 * so that ambiguity is accepted here *only* because the pid came from the window's
 * own log.
 */
export function killTargetFor(label: string, ref: ExthostRef, processes: readonly DevHostProcess[]): KillTarget {
  if (ref.pid === null) {
    throw new Error(
      `no extension host pid recorded for ${label}: its exthost.log has no "Extension host with pid" line`,
    );
  }
  if (!ref.alive) {
    throw new Error(
      `${label}'s extension host (pid ${ref.pid}) is not running any more — nothing to kill; ` +
        'reload that window to get a new one',
    );
  }
  const process = processes.find((candidate) => candidate.pid === ref.pid);
  if (!process) {
    throw new Error(`pid ${ref.pid} (${label}) is not a process of this dev host any more`);
  }
  if (classifyProcess(process) !== 'extensionHost') {
    throw new Error(
      `refusing to kill pid ${ref.pid}: it is a '${process.type ?? 'root'}' process` +
        `${process.utilitySubType ? ` (${process.utilitySubType})` : ''}, not an extension host`,
    );
  }
  return { label, pid: ref.pid, type: process.type, command: stopProcessCommand(ref.pid) };
}

// --- PowerShell -------------------------------------------------------------

const LIST_SCRIPT = [
  "$ErrorActionPreference='Stop';",
  'Get-CimInstance Win32_Process -Filter "Name=\'Code.exe\'" |',
  '  Where-Object { $_.CommandLine -and $_.CommandLine -match $env:DSH_UI_REVIEW_MARKER } |',
  '  Select-Object ProcessId, ParentProcessId, CommandLine, @{n="CreationDate";e={$_.CreationDate.ToString("o")}} |',
  '  ConvertTo-Json -Depth 3 -Compress',
].join(' ');

/**
 * Every Code.exe process of this harness (the marker is this tools directory, the
 * same filter kill.ts uses). Returns [] when the dev host is not running.
 */
export function listDevHostProcesses(harnessDir: string): DevHostProcess[] {
  let out: string;
  try {
    out = execFileSync('powershell', ['-NoProfile', '-Command', LIST_SCRIPT], {
      encoding: 'utf8',
      env: { ...process.env, DSH_UI_REVIEW_MARKER: escapeRegex(harnessDir) },
    });
  } catch (error) {
    throw new Error(`failed to list dev-host processes: ${(error as Error).message}`);
  }
  const trimmed = out.trim();
  if (!trimmed) return [];
  const parsed: unknown = JSON.parse(trimmed);
  const rows = Array.isArray(parsed) ? parsed : [parsed];
  return rows.map((row) => toDevHostProcess(row as Parameters<typeof toDevHostProcess>[0]));
}

const BACKSLASH = String.fromCharCode(92);
/** The characters a .NET regex treats specially. */
const METACHARACTERS = '.*+?^${}()|[]';

/** Escape a literal string for .NET/PowerShell `-match` (regex, `\`-escaped). */
export function escapeRegex(value: string): string {
  let out = '';
  for (const character of value) {
    if (character === BACKSLASH || METACHARACTERS.includes(character)) out += `${BACKSLASH}${character}`;
    else out += character;
  }
  return out;
}

/** Run the very command that `killTargetFor` built — no shell interpolation. */
export function killProcess(pid: number): void {
  const script = `${stopProcessCommand(pid)}; Write-Output "killed ${pid}"`;
  const out = execFileSync('powershell', ['-NoProfile', '-Command', script], { encoding: 'utf8' });
  const text = out.trim();
  if (!text) throw new Error(`killing pid ${pid} produced no output`);
}
