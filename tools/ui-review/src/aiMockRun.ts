// The mock endpoint's lifecycle: the state file that records a running endpoint,
// the detached child that serves it, and the one way to stop it.
//
// Why a detached child and a state file rather than a server inside `launch.ts`:
// the launcher returns as soon as CDP answers (the dev host is a detached process
// of its own), so a server living in the launcher's process would die in the same
// second it was started. The child outlives the launcher, the state file is what
// the launcher, `kill.ts` and the `ai-mock` command use to find it again, and
// every use of it is guarded by an HTTP identity check — a recorded pid is only
// killed when the endpoint at its recorded URL still answers as this mock
// (`AI_MOCK_IDENTITY`), so a recycled pid can never be mistaken for it.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import {
  AI_MOCK_DEFAULT_CHUNK_DELAY_MS,
  AI_MOCK_IDENTITY,
  AI_MOCK_REQUESTS_PATH,
  type AiMockRequestRecord,
} from './aiMockServer';
import { isPidAlive, killProcess } from './winProc';

export const AI_MOCK_STATE_FILE = 'ai-mock.json';
export const AI_MOCK_LOG_FILE = 'ai-mock.log';
export const AI_MOCK_STATE_VERSION = 1;

/** Where the state file lives for one harness directory. */
export function aiMockStatePath(harnessDir: string): string {
  return path.join(harnessDir, AI_MOCK_STATE_FILE);
}

/** The request log the detached child writes (its stdout and stderr both land here). */
export function aiMockLogPath(harnessDir: string): string {
  return path.join(harnessDir, AI_MOCK_LOG_FILE);
}

/** What a running endpoint recorded about itself. */
export interface AiMockState {
  version: number;
  /** The identity marker `/__mock/requests` answers with. */
  id: string;
  url: string;
  host: string;
  port: number;
  pid: number;
  startedAt: string;
  chunkDelayMs: number;
  logFile: string;
}

/**
 * One state file's contents, or `null` when it is missing, unreadable, a shape
 * this version does not know, or not this mock's own record.
 */
export function parseAiMockState(raw: unknown): AiMockState | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const entry = raw as Record<string, unknown>;
  if (entry.version !== AI_MOCK_STATE_VERSION || entry.id !== AI_MOCK_IDENTITY) return null;
  const url = typeof entry.url === 'string' ? entry.url : '';
  const host = typeof entry.host === 'string' ? entry.host : '';
  const port = typeof entry.port === 'number' ? entry.port : NaN;
  const pid = typeof entry.pid === 'number' ? entry.pid : NaN;
  if (url === '' || host === '' || !Number.isInteger(port) || port <= 0 || !Number.isInteger(pid) || pid <= 0) {
    return null;
  }
  return {
    version: AI_MOCK_STATE_VERSION,
    id: AI_MOCK_IDENTITY,
    url,
    host,
    port,
    pid,
    startedAt: typeof entry.startedAt === 'string' ? entry.startedAt : '',
    chunkDelayMs: typeof entry.chunkDelayMs === 'number' ? entry.chunkDelayMs : AI_MOCK_DEFAULT_CHUNK_DELAY_MS,
    logFile: typeof entry.logFile === 'string' ? entry.logFile : '',
  };
}

export function readAiMockStateFile(file: string): AiMockState | null {
  try {
    return parseAiMockState(JSON.parse(fs.readFileSync(file, 'utf8')));
  } catch {
    return null;
  }
}

export function readAiMockState(harnessDir: string): AiMockState | null {
  return readAiMockStateFile(aiMockStatePath(harnessDir));
}

/** Writes the state file, creating its directory if needed. */
export function writeAiMockStateFile(file: string, state: AiMockState): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(state, null, 2)}\n`);
}

/** Forgets a recorded endpoint; returns whether there was anything to forget. */
export function clearAiMockState(harnessDir: string): boolean {
  const file = aiMockStatePath(harnessDir);
  if (!fs.existsSync(file)) return false;
  fs.rmSync(file);
  return true;
}

/**
 * Forgets a state file only when it describes `pid`, so a foreground `serve`
 * ending cannot delete the record of an endpoint it does not own.
 */
export function clearAiMockStateFileIfOwnedBy(file: string, pid: number): boolean {
  const state = readAiMockStateFile(file);
  if (!state || state.pid !== pid) return false;
  fs.rmSync(file);
  return true;
}

/** The last `count` lines of a file, or a sentence saying why there are none. */
export function logTail(file: string, count = 12): string {
  try {
    const lines = fs
      .readFileSync(file, 'utf8')
      .split(/\r?\n/)
      .filter((line) => line.trim() !== '');
    if (lines.length === 0) return '(the log is empty)';
    return lines.slice(-count).join('\n');
  } catch {
    return '(no log was written)';
  }
}

/**
 * Whether the endpoint at `url` answers as this mock.
 *
 * This is the guard every destructive step goes through: it proves that the thing
 * at the recorded address is the endpoint the state file describes, rather than
 * "some process is listening on that port now".
 */
export async function aiMockEndpointAlive(url: string, timeoutMs = 1500): Promise<boolean> {
  try {
    const response = await fetch(`${url.replace(/\/+$/, '')}${AI_MOCK_REQUESTS_PATH}`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) return false;
    const payload: unknown = await response.json();
    return (payload as { id?: unknown }).id === AI_MOCK_IDENTITY;
  } catch {
    return false;
  }
}

export interface AiMockRequestListing {
  count: number;
  requests: AiMockRequestRecord[];
}

/** What the endpoint has seen, as the endpoint itself reports it. */
export async function fetchAiMockRequests(url: string, timeoutMs = 3000): Promise<AiMockRequestListing> {
  const response = await fetch(`${url.replace(/\/+$/, '')}${AI_MOCK_REQUESTS_PATH}`, {
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) {
    throw new Error(`${url}${AI_MOCK_REQUESTS_PATH} answered HTTP ${response.status}`);
  }
  const payload = (await response.json()) as { id?: unknown; count?: unknown; requests?: unknown };
  if (payload.id !== AI_MOCK_IDENTITY || !Array.isArray(payload.requests)) {
    throw new Error(`${url}${AI_MOCK_REQUESTS_PATH} did not answer as the mock endpoint`);
  }
  return { count: payload.requests.length, requests: payload.requests as AiMockRequestRecord[] };
}

export interface StartAiMockOptions {
  harnessDir: string;
  /**
   * The port to bind; `0` (the default) asks the OS for a free one. A fixed port
   * is supported because a caller may want a stable URL, but it is never the
   * harness's own choice.
   */
  port?: number;
  chunkDelayMs?: number;
  /** How long to wait for the child to report the port it bound. */
  timeoutMs?: number;
  /**
   * The `aiMock.ts` entry script to spawn. Overridable so a test can keep its
   * state file and log in a temporary directory while still running the real
   * script; the child's working directory is derived from it, because that is
   * what makes `--import tsx` resolvable.
   */
  scriptPath?: string;
}

export interface AiMockLaunch {
  state: AiMockState;
  /** True when an endpoint started by an earlier run was reused instead of spawned. */
  reused: boolean;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Starts the endpoint for a launch, or reuses the one an earlier launch left
 * running.
 *
 * Reuse is deliberate: two dev hosts on one machine both pointed at the same
 * endpoint is a normal thing to want, and starting a second child on a new
 * ephemeral port would leave the first one orphaned with no state file pointing
 * at it. Reuse is refused when the caller asked for a *different* explicit port,
 * because then the two runs disagree about something the operator stated.
 *
 * A child that exits before it reports a port (the interesting case: the port is
 * taken, or the user may not bind it) is reported with the tail of its log rather
 * than a timeout, so a bind failure is never swallowed.
 */
export async function startAiMockServerForLaunch(options: StartAiMockOptions): Promise<AiMockLaunch> {
  const harnessDir = options.harnessDir;
  const port = options.port ?? 0;
  const chunkDelayMs = options.chunkDelayMs ?? AI_MOCK_DEFAULT_CHUNK_DELAY_MS;
  const timeoutMs = options.timeoutMs ?? 20_000;
  const statePath = aiMockStatePath(harnessDir);
  const logFile = aiMockLogPath(harnessDir);
  const scriptPath = options.scriptPath ?? path.join(harnessDir, 'src', 'aiMock.ts');
  const spawnCwd = path.resolve(path.dirname(scriptPath), '..');

  const existing = readAiMockStateFile(statePath);
  if (existing && (await aiMockEndpointAlive(existing.url))) {
    if (port !== 0 && existing.port !== port) {
      throw new Error(
        `a mock endpoint is already running on port ${existing.port} (not ${port}); stop it first ` +
          `('pnpm --filter @cpf23333-forgejo-toolkit/ui-review ai-mock stop', or 'pnpm kill'), ` +
          `or drop --ai-mock-port`,
      );
    }
    return { state: existing, reused: true };
  }
  if (!fs.existsSync(scriptPath)) {
    throw new Error(`the mock endpoint's entry script is missing: ${scriptPath}`);
  }
  // A stale record is removed before the spawn, so that any state file seen from
  // here on belongs to the child this call started: the poll below also checks the
  // pid, and this is what makes the file's mere existence mean something.
  fs.rmSync(statePath, { force: true });

  // Opened 'w': the log describes one endpoint's life, and the previous run's
  // lines would only make the current failure harder to read.
  const logFd = fs.openSync(logFile, 'w');
  const child = spawn(
    process.execPath,
    [
      '--import',
      'tsx',
      scriptPath,
      'serve',
      `--port=${port}`,
      `--chunk-delay=${chunkDelayMs}`,
      `--state-file=${statePath}`,
      `--log-file=${logFile}`,
    ],
    {
      cwd: spawnCwd,
      detached: true,
      // File descriptors rather than pipes: nothing has to drain them, and the
      // log survives the launcher's own exit.
      stdio: ['ignore', logFd, logFd],
      windowsHide: true,
    },
  );
  fs.closeSync(logFd);
  let exitCode: number | null = null;
  child.once('exit', (code) => {
    exitCode = code ?? 0;
  });
  child.unref();
  if (child.pid === undefined) {
    throw new Error('the mock endpoint child process could not be started');
  }
  const childPid = child.pid;

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (exitCode !== null) {
      throw new Error(
        `the mock endpoint exited before it was listening (exit code ${exitCode}). Its log (${logFile}) ends with:\n` +
          logTail(logFile),
      );
    }
    const state = readAiMockStateFile(statePath);
    if (state && state.pid === childPid && (await aiMockEndpointAlive(state.url))) {
      return { state, reused: false };
    }
    await sleep(100);
  }
  throw new Error(
    `timed out after ${timeoutMs} ms waiting for the mock endpoint (pid ${childPid}) to report its port; see ${logFile}`,
  );
}

export type AiMockStopOutcome = 'none' | 'stopped' | 'already-stopped' | 'foreign-pid';

export interface AiMockStopReport {
  outcome: AiMockStopOutcome;
  message: string;
}

/** Waits for the endpoint to stop answering, so a kill is not reported before it took effect. */
async function waitForSilence(url: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!(await aiMockEndpointAlive(url))) return true;
    await sleep(100);
  }
  return !(await aiMockEndpointAlive(url));
}

/**
 * Stops the recorded endpoint.
 *
 * The identity check comes first and the pid is only killed when it passes: a
 * state file whose endpoint no longer answers says nothing about the process that
 * holds the pid now, and killing a recycled pid would be worse than leaving a
 * stale file behind. Both non-kill paths say which file to delete.
 */
export async function stopAiMockServer(harnessDir: string): Promise<AiMockStopReport> {
  const file = aiMockStatePath(harnessDir);
  const state = readAiMockStateFile(file);
  if (!state) {
    return {
      outcome: 'none',
      message: `no ${AI_MOCK_STATE_FILE} in ${harnessDir}: no mock endpoint was recorded`,
    };
  }
  if (await aiMockEndpointAlive(state.url)) {
    try {
      killProcess(state.pid);
    } catch (error) {
      // The endpoint answered a moment ago, so a failure here means the pid went
      // away by itself; anything else is a real error and is reported as one.
      if (isPidAlive(state.pid)) throw error;
    }
    const silent = await waitForSilence(state.url, 3000);
    clearAiMockState(harnessDir);
    return {
      outcome: 'stopped',
      message:
        `stopped the mock endpoint at ${state.url} (pid ${state.pid})` +
        `${silent ? '' : ' — it still answered after the kill, so check for another listener on that port'}`,
    };
  }
  if (isPidAlive(state.pid)) {
    return {
      outcome: 'foreign-pid',
      message:
        `nothing answers at ${state.url} any more, but pid ${state.pid} is still running; not killing a process this ` +
        `state file does not prove is the endpoint. Delete ${file} if you are sure nothing of this harness is left`,
    };
  }
  clearAiMockState(harnessDir);
  return {
    outcome: 'already-stopped',
    message: `the mock endpoint at ${state.url} was not running; cleared the stale ${AI_MOCK_STATE_FILE}`,
  };
}
