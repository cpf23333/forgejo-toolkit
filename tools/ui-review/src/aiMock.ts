// The mock endpoint's command line.
//
//   pnpm --filter @cpf23333-forgejo-toolkit/ui-review ai-mock serve
//   pnpm --filter @cpf23333-forgejo-toolkit/ui-review ai-mock requests
//   pnpm --filter @cpf23333-forgejo-toolkit/ui-review ai-mock url
//   pnpm --filter @cpf23333-forgejo-toolkit/ui-review ai-mock stop
//
// `serve` is what `launch.ts --ai-mock` spawns (detached, with its output going
// to `ai-mock.log`), and it is also what a maintainer can run in a terminal to
// watch every request live. The other three commands read the state file
// `serve` wrote, so they keep working after the launcher has exited.
//
// `pnpm kill` stops the endpoint too (there is one stop command for the whole
// harness, see kill.ts); `ai-mock stop` is for an endpoint started without a dev
// host, or when the launcher is not involved at all.
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { flagBool, flagNumber, flagString, parseArgs } from './cliArgs';
import { AI_MOCK_DEFAULT_CHUNK_DELAY_MS, AI_MOCK_IDENTITY, AI_MOCK_SCENARIOS, startAiMockServer } from './aiMockServer';
import {
  AI_MOCK_STATE_VERSION,
  aiMockEndpointAlive,
  aiMockLogPath,
  aiMockStatePath,
  clearAiMockStateFileIfOwnedBy,
  fetchAiMockRequests,
  readAiMockState,
  stopAiMockServer,
  writeAiMockStateFile,
} from './aiMockRun';

const HARNESS_DIR = path.resolve(import.meta.dirname, '..');

export const AI_MOCK_USAGE = `usage: ai-mock.ts <command> [options]

  serve                     run the endpoint in this process (Ctrl+C stops it)
      --port <n>              port to bind (default 0: the OS picks a free one)
      --chunk-delay <ms>      gap between streamed chunks (default ${AI_MOCK_DEFAULT_CHUNK_DELAY_MS})
      --state-file <path>     where to record the running endpoint
      --log-file <path>       the path recorded as this endpoint's log
  stop                      stop the endpoint recorded in the state file
  url                       print the running endpoint's URL
  requests [--json]         print what the endpoint has seen

Scenarios (append "?scenario=NAME" to a provider's base URL):
  ${AI_MOCK_SCENARIOS.join(', ')}`;

export interface AiMockCliOptions {
  out?: (line: string) => void;
  err?: (line: string) => void;
  /** The harness directory the state file lives in; overridable so a test can use its own. */
  harnessDir?: string;
}

/** The two sinks the commands write to by default. */
const CONSOLE_IO: Required<Pick<AiMockCliOptions, 'out' | 'err'>> = {
  out: (line: string) => console.log(line),
  err: (line: string) => console.error(line),
};

async function serveCommand(
  argv: readonly string[],
  io: { out: (line: string) => void; err: (line: string) => void },
  harnessDir: string,
): Promise<number> {
  const parsed = parseArgs(argv, {
    value: ['--port', '--chunk-delay', '--state-file', '--log-file'],
    boolean: [],
  });
  const stateFile = flagString(parsed, '--state-file') ?? aiMockStatePath(harnessDir);
  const logFile = flagString(parsed, '--log-file') ?? aiMockLogPath(harnessDir);
  const port = flagNumber(parsed, '--port', 0);
  const chunkDelayMs = flagNumber(parsed, '--chunk-delay', AI_MOCK_DEFAULT_CHUNK_DELAY_MS);

  let server;
  try {
    server = await startAiMockServer({ port, chunkDelayMs, onLog: (line) => io.out(line) });
  } catch (error) {
    // A bind failure is reported here and above (the launcher reads this log),
    // never swallowed: a mock endpoint that silently is not there would make
    // every later observation a puzzle.
    io.err(`ai-mock: ${(error as Error).message}`);
    io.err('ai-mock: pass --port <n> for another port, or leave it at 0 so the OS chooses a free one');
    return 1;
  }

  writeAiMockStateFile(stateFile, {
    version: AI_MOCK_STATE_VERSION,
    id: AI_MOCK_IDENTITY,
    url: server.url,
    host: server.host,
    port: server.port,
    pid: process.pid,
    startedAt: new Date().toISOString(),
    chunkDelayMs,
    logFile,
  });
  io.out(`ai-mock: listening at ${server.url} (pid ${process.pid}, ${chunkDelayMs} ms between chunks)`);
  io.out(`ai-mock: POST ${server.url}/v1/chat/completions   GET ${server.url}/v1/models`);
  io.out(`ai-mock: state ${stateFile}   log ${logFile}`);
  io.out(`ai-mock: Ctrl+C stops it; from another terminal use 'ai-mock stop'`);

  await new Promise<void>((resolve) => {
    for (const signal of ['SIGINT', 'SIGTERM'] as const) {
      process.once(signal, () => resolve());
    }
  });
  await server.close();
  const cleared = clearAiMockStateFileIfOwnedBy(stateFile, process.pid);
  io.out(`ai-mock: stopped${cleared ? ` and cleared ${stateFile}` : ''}`);
  return 0;
}

async function stopCommand(io: { out: (line: string) => void }, harnessDir: string): Promise<number> {
  const report = await stopAiMockServer(harnessDir);
  io.out(`ai-mock: ${report.message}`);
  // A pid that is not proven to be the endpoint is the one outcome the caller
  // has to act on, so it is the one that exits non-zero.
  return report.outcome === 'foreign-pid' ? 1 : 0;
}

async function urlCommand(
  io: { out: (line: string) => void; err: (line: string) => void },
  harnessDir: string,
): Promise<number> {
  const state = readAiMockState(harnessDir);
  if (!state) {
    io.err(
      `ai-mock: no ${aiMockStatePath(harnessDir)}: no mock endpoint is recorded. Start one with ` +
        `'pnpm --filter @cpf23333-forgejo-toolkit/ui-review launch --ai-mock' or 'ai-mock serve'`,
    );
    return 1;
  }
  io.out(state.url);
  if (!(await aiMockEndpointAlive(state.url))) {
    io.err(`ai-mock: nothing answers at ${state.url} any more; the state file is stale ('ai-mock stop' clears it)`);
  }
  return 0;
}

async function requestsCommand(
  argv: readonly string[],
  io: { out: (line: string) => void; err: (line: string) => void },
  harnessDir: string,
): Promise<number> {
  const parsed = parseArgs(argv, { value: [], boolean: ['--json'] });
  const state = readAiMockState(harnessDir);
  if (!state) {
    io.err(`ai-mock: no ${aiMockStatePath(harnessDir)}: no mock endpoint is recorded`);
    return 1;
  }
  let listing;
  try {
    listing = await fetchAiMockRequests(state.url);
  } catch (error) {
    io.err(`ai-mock: ${(error as Error).message}`);
    io.err(`ai-mock: is the endpoint still running? 'ai-mock stop' clears a stale state file`);
    return 1;
  }
  if (flagBool(parsed, '--json')) {
    io.out(JSON.stringify(listing, null, 2));
    return 0;
  }
  if (listing.count === 0) {
    io.out(`ai-mock: the endpoint at ${state.url} has seen no request yet — nothing reached it`);
    return 0;
  }
  io.out(`ai-mock: ${listing.count} request(s) seen at ${state.url}`);
  for (const record of listing.requests) {
    const model = record.model === undefined ? '' : ` model=${record.model}`;
    io.out(
      `  ${record.at}  ${record.method.padEnd(4)} ${record.path}  ->  HTTP ${record.status} ` +
        `${record.shape} scenario=${record.scenario} chunks=${record.chunks} bytes=${record.bytes}${model}`,
    );
  }
  return 0;
}

/** Runs one command line; returns the process exit code. */
export async function runAiMockCli(argv: readonly string[], options: AiMockCliOptions = {}): Promise<number> {
  const io = { out: options.out ?? CONSOLE_IO.out, err: options.err ?? CONSOLE_IO.err };
  const harnessDir = options.harnessDir ?? HARNESS_DIR;
  const [command, ...rest] = argv;
  switch (command) {
    case 'serve':
      return await serveCommand(rest, io, harnessDir);
    case 'stop':
      return await stopCommand(io, harnessDir);
    case 'url':
      return await urlCommand(io, harnessDir);
    case 'requests':
      return await requestsCommand(rest, io, harnessDir);
    default:
      io.err(AI_MOCK_USAGE);
      return command === undefined ? 0 : 1;
  }
}

// Only when this file is the entry point: `aiMockRun.ts` and the tests import
// `runAiMockCli`, and importing a module must not run its command line.
const invokedPath = process.argv[1];
if (invokedPath !== undefined && pathToFileURL(path.resolve(invokedPath)).href === import.meta.url) {
  process.exitCode = await runAiMockCli(process.argv.slice(2));
}
