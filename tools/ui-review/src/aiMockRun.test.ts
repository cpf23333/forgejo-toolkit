// Tests for the mock endpoint's lifecycle (`src/aiMockRun.ts`, `src/aiMock.ts`).
//
// The lifecycle is where a harness tool goes wrong quietly: a state file that
// points at the wrong thing, a stop that kills a pid it cannot prove is the
// endpoint, a launcher that waits for a child which already died. Each of those
// is a test below.
//
// The one test that runs a real detached child is the one that matters most: it
// is `launch --ai-mock`'s handshake (spawn → wait for the port → prove the
// endpoint answers → reuse it → stop it), and it is the only way to know that the
// child outlives the process that started it.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { AI_MOCK_HOST, AI_MOCK_MODEL_IDS, startAiMockServer } from './aiMockServer';
import {
  AI_MOCK_LOG_FILE,
  AI_MOCK_STATE_FILE,
  AI_MOCK_STATE_VERSION,
  aiMockEndpointAlive,
  aiMockStatePath,
  clearAiMockStateFileIfOwnedBy,
  fetchAiMockRequests,
  parseAiMockState,
  readAiMockStateFile,
  startAiMockServerForLaunch,
  stopAiMockServer,
  writeAiMockStateFile,
  type AiMockState,
} from './aiMockRun';
import { runAiMockCli, type AiMockCliOptions } from './aiMock';

const HARNESS_DIR = path.resolve(import.meta.dirname, '..');
/** The real entry script, so the spawn test exercises what `launch --ai-mock` runs. */
const ENTRY_SCRIPT = path.join(HARNESS_DIR, 'src', 'aiMock.ts');

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ui-review-aimock-run-'));
}

/** A well-formed state record, with every field overridable. */
function stateFor(overrides: Partial<AiMockState> = {}): AiMockState {
  return {
    version: AI_MOCK_STATE_VERSION,
    id: 'ui-review-ai-mock',
    url: `http://${AI_MOCK_HOST}:1`,
    host: AI_MOCK_HOST,
    port: 1,
    pid: 4242,
    startedAt: '2026-10-05T00:00:00.000Z',
    chunkDelayMs: 60,
    logFile: 'ai-mock.log',
    ...overrides,
  };
}

/** A pid that was real a moment ago and is not any more (no pid arithmetic guessing). */
async function exitedPid(): Promise<number> {
  const child = spawn(process.execPath, ['-e', 'process.exit(0)'], { stdio: 'ignore' });
  const pid = child.pid;
  await new Promise<void>((resolve) => child.once('exit', () => resolve()));
  assert.ok(pid !== undefined);
  return pid;
}

/** Captures what a command printed, so assertions are about its words, not the console. */
function capture(): { lines: string[]; errors: string[]; options: AiMockCliOptions } {
  const lines: string[] = [];
  const errors: string[] = [];
  return {
    lines,
    errors,
    options: { out: (line) => lines.push(line), err: (line) => errors.push(line) },
  };
}

test('a state file round-trips, and a foreign or malformed one reads as unknown', () => {
  const dir = tempDir();
  const file = path.join(dir, AI_MOCK_STATE_FILE);
  writeAiMockStateFile(file, stateFor({ port: 4711 }));
  assert.deepEqual(readAiMockStateFile(file), stateFor({ port: 4711, url: `http://${AI_MOCK_HOST}:1` }));

  assert.equal(parseAiMockState(null), null);
  assert.equal(parseAiMockState('nope'), null);
  assert.equal(parseAiMockState(stateFor({ version: 99 })), null, 'an unknown version is not this state file');
  assert.equal(parseAiMockState(stateFor({ id: 'something-else' })), null, 'only this mock identity is accepted');
  assert.equal(parseAiMockState(stateFor({ port: 0 })), null);
  assert.equal(parseAiMockState(stateFor({ pid: -1 })), null);
  assert.equal(readAiMockStateFile(path.join(dir, 'missing.json')), null);
});

test('a state file is only cleared by the process it describes', () => {
  const dir = tempDir();
  const file = path.join(dir, AI_MOCK_STATE_FILE);
  writeAiMockStateFile(file, stateFor({ pid: 1234 }));
  assert.equal(clearAiMockStateFileIfOwnedBy(file, 9999), false, 'a different pid must not clear it');
  assert.equal(fs.existsSync(file), true);
  assert.equal(clearAiMockStateFileIfOwnedBy(file, 1234), true);
  assert.equal(fs.existsSync(file), false);
});

test('stop reports "none" when nothing was recorded and clears a stale record', async () => {
  const empty = tempDir();
  assert.equal((await stopAiMockServer(empty)).outcome, 'none');

  const dir = tempDir();
  writeAiMockStateFile(aiMockStatePath(dir), stateFor({ pid: await exitedPid(), url: `http://${AI_MOCK_HOST}:1` }));
  const report = await stopAiMockServer(dir);
  assert.equal(report.outcome, 'already-stopped');
  assert.match(report.message, /was not running/);
  assert.equal(fs.existsSync(aiMockStatePath(dir)), false);
});

test('stop refuses to kill a live pid the endpoint does not prove is its own', async () => {
  const dir = tempDir();
  // A live pid (this test process) and a URL that answers nothing: the state file
  // cannot prove the pid is the endpoint, and killing it would be destructive.
  writeAiMockStateFile(aiMockStatePath(dir), stateFor({ pid: process.pid, url: `http://${AI_MOCK_HOST}:1` }));
  const report = await stopAiMockServer(dir);
  assert.equal(report.outcome, 'foreign-pid');
  assert.match(report.message, /not killing a process/);
  assert.equal(fs.existsSync(aiMockStatePath(dir)), true, 'the file stays so a human can decide');
});

test('the CLI says what it knows when no endpoint is recorded', async () => {
  const dir = tempDir();
  const url = capture();
  assert.equal(await runAiMockCli(['url'], { ...url.options, harnessDir: dir }), 1);
  assert.match(url.errors.join('\n'), /no mock endpoint is recorded/);
  assert.deepEqual(url.lines, []);

  const requests = capture();
  assert.equal(await runAiMockCli(['requests'], { ...requests.options, harnessDir: dir }), 1);
  assert.match(requests.errors.join('\n'), /no mock endpoint is recorded/);

  const stop = capture();
  assert.equal(await runAiMockCli(['stop'], { ...stop.options, harnessDir: dir }), 0);
  assert.match(stop.lines.join('\n'), /no mock endpoint was recorded/);

  const usage = capture();
  assert.equal(await runAiMockCli([], usage.options), 0);
  assert.match(usage.errors.join('\n'), /usage: ai-mock\.ts/);
  assert.equal(await runAiMockCli(['nonsense'], usage.options), 1);
});

test('a bind failure is reported by the CLI and writes no state file', async () => {
  const held = await startAiMockServer({});
  try {
    const dir = tempDir();
    const stateFile = aiMockStatePath(dir);
    const captured = capture();
    const code = await runAiMockCli(['serve', `--port=${held.port}`, `--state-file=${stateFile}`], {
      ...captured.options,
      harnessDir: dir,
    });
    assert.equal(code, 1);
    const errors = captured.errors.join('\n');
    assert.match(errors, new RegExp(`cannot bind 127\\.0\\.0\\.1:${held.port}`));
    assert.match(errors, /EADDRINUSE/);
    assert.match(errors, /pass --port <n>/, 'the reader is told how to fix it');
    assert.equal(fs.existsSync(stateFile), false);
  } finally {
    await held.close();
  }
});

test('a bind failure inside the spawned child is reported with its log, not as a timeout', async () => {
  const held = await startAiMockServer({});
  const dir = tempDir();
  try {
    // This is `--ai-mock-port <taken>`: the child cannot bind and exits, and the
    // launcher has to say so (in the child's own words) instead of waiting out its
    // timeout and leaving the operator with a window and no endpoint.
    await assert.rejects(
      () =>
        startAiMockServerForLaunch({
          harnessDir: dir,
          port: held.port,
          scriptPath: ENTRY_SCRIPT,
          timeoutMs: 60_000,
        }),
      (error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        assert.match(message, /exited before it was listening/);
        assert.match(message, /EADDRINUSE/);
        assert.match(message, /ai-mock\.log/, 'the message names the log it read');
        return true;
      },
    );
    assert.equal(fs.existsSync(aiMockStatePath(dir)), false, 'a failed start records nothing');
  } finally {
    await held.close();
  }
});

test('launch --ai-mock starts a detached endpoint, reuses it, and stops it again', async () => {
  const dir = tempDir();
  const { state, reused } = await startAiMockServerForLaunch({
    harnessDir: dir,
    scriptPath: ENTRY_SCRIPT,
    timeoutMs: 60_000,
  });
  try {
    assert.equal(reused, false);
    assert.ok(state.port > 0, 'the endpoint reports the port it actually bound');
    assert.equal(state.url, `http://${AI_MOCK_HOST}:${state.port}`);
    assert.equal(state.logFile, path.join(dir, AI_MOCK_LOG_FILE));
    assert.equal(await aiMockEndpointAlive(state.url), true);

    // It is a real socket, not a record: the port it named answers HTTP.
    const models = (await fetch(`${state.url}/v1/models`).then((response) => response.json())) as {
      data: Array<{ id: string }>;
    };
    assert.deepEqual(
      models.data.map((model) => model.id),
      [...AI_MOCK_MODEL_IDS],
    );

    // A second launch reuses it rather than orphaning the first one...
    const again = await startAiMockServerForLaunch({ harnessDir: dir, scriptPath: ENTRY_SCRIPT, timeoutMs: 10_000 });
    assert.equal(again.reused, true);
    assert.equal(again.state.url, state.url);
    // ...and refuses when the operator asked for a different fixed port.
    await assert.rejects(
      () =>
        startAiMockServerForLaunch({
          harnessDir: dir,
          port: state.port + 1,
          scriptPath: ENTRY_SCRIPT,
          timeoutMs: 10_000,
        }),
      /already running on port/,
    );

    // The CLI reads the same state file, so the maintainer can query the endpoint
    // without the launcher being alive.
    const url = capture();
    assert.equal(await runAiMockCli(['url'], { ...url.options, harnessDir: dir }), 0);
    assert.deepEqual(url.lines, [state.url]);

    const requests = capture();
    assert.equal(await runAiMockCli(['requests'], { ...requests.options, harnessDir: dir }), 0);
    const text = requests.lines.join('\n');
    assert.match(text, /1 request\(s\) seen/);
    assert.match(text, /GET\s+\/v1\/models\s+->\s+HTTP 200 json/);

    const listing = await fetchAiMockRequests(state.url);
    assert.equal(listing.count, 1);
  } finally {
    const report = await stopAiMockServer(dir);
    assert.equal(report.outcome, 'stopped');
    assert.match(report.message, /stopped the mock endpoint/);
  }
  assert.equal(fs.existsSync(aiMockStatePath(dir)), false, 'a stopped endpoint leaves no state file');
  assert.equal(await aiMockEndpointAlive(state.url), false, 'and nothing answers there any more');
});

test('asking an endpoint that is not the mock for its request log is an error, not an empty list', async () => {
  await assert.rejects(
    () => fetchAiMockRequests(`http://${AI_MOCK_HOST}:1`),
    (error: unknown) => {
      // Connection refused (or a timeout): either way the CLI must report it rather
      // than print "0 requests", which would read as "the extension never called".
      assert.ok(error instanceof Error);
      return true;
    },
  );
});
