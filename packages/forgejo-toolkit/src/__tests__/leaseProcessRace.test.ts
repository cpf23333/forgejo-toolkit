import { describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Worker } from 'worker_threads';
import { LEASE_FILE_NAME } from '../lease/leaseConstants';
import { removeTempDir } from './tempDir';

/**
 * The cross-process mutual-exclusion test §10.1.3 asks for: "the only test that
 * can prove `wx` is atomic on a real filesystem".
 *
 * **What it does.** It puts N independent claimants — the main thread plus
 * `worker_threads` workers, each in its own thread with its own call into the
 * kernel — on ONE real lease path in ONE real temp directory, releases all of
 * them on a *shared deadline* through a `SharedArrayBuffer`, and asserts that
 * exactly one wins `fs.openSync(path, 'wx', 0o600)` while the others see
 * `EEXIST`. The shared deadline matters: without it the main thread's
 * synchronous create wins every round simply because a freshly spawned worker
 * needs milliseconds to boot, which would "prove" nothing about the kernel.
 *
 * `worker_threads` rather than `child_process` on purpose: a piped child needs
 * stdio, which the test sandbox refuses (EPERM), while a worker reports back
 * through `parentPort`/`workerData`. The threaded workers still contend for the
 * *same file* from *different threads*, which is the arbitration under test.
 *
 * **What it does NOT prove.** The worker body exercises the primitive itself,
 * not `LeaseStore`: an eval'd worker cannot `import` the TypeScript module, and
 * doing so would prove nothing new about the kernel. It also does not cover the
 * rest of the protocol — the stale-release re-read, the heartbeat's atomic
 * write, the yield path or the claim requests. The same-process `LeaseStore`
 * races (2 and 3 racers x 50 rounds, in `leaseStore.test.ts`) cover the module
 * layer, and §10.2 leaves real extension hosts, activation order and
 * `deactivate()` reliability to the soak harness.
 */

/**
 * The leanest possible claimant: wait for the shared deadline, exclusive
 * create, write, report the outcome.
 *
 * `require` (not `import`) because an eval'd worker body is CommonJS unless the
 * closest `package.json` declares `"type": "module"`, which
 * `packages/forgejo-toolkit` does not.
 *
 * Control block layout: `[0]` ready count, `[1]` deadline (`Date.now()` ms),
 * `[2]` release flag.
 */
const WORKER_SOURCE = `
const fs = require('fs');
const { parentPort, workerData } = require('worker_threads');

async function claim() {
  const control = new Int32Array(workerData.control);
  // Phase 1: announce that this claimant is standing at the line.
  Atomics.add(control, 0, 1);
  // Phase 2: wait for the release flag, then for the shared deadline. Both are
  // busy-waits: a thread that yields here would lose the race to the scheduler
  // instead of to the kernel.
  while (Atomics.load(control, 2) === 0) {
    /* spin */
  }
  const startAt = Atomics.load(control, 1);
  while (Date.now() < startAt) {
    /* spin */
  }
  try {
    const handle = fs.openSync(workerData.leasePath, 'wx', 0o600);
    fs.writeSync(handle, workerData.payload);
    fs.closeSync(handle);
    parentPort.postMessage({ status: 'won', pid: process.pid });
  } catch (error) {
    parentPort.postMessage({
      status: error && error.code === 'EEXIST' ? 'lost' : 'error',
      code: error && error.code ? String(error.code) : undefined,
      message: error && error.message ? String(error.message) : String(error),
      pid: process.pid,
    });
  }
}

claim().catch((error) => {
  parentPort.postMessage({ status: 'error', message: String(error) });
});
`;

interface ClaimantOutcome {
  status: 'won' | 'lost' | 'error';
  code?: string;
  /** The claiming thread's pid; every worker in a round reports the same one. */
  pid?: number;
  message?: string;
}

/** How long after the release all claimants aim their create at. */
const RACE_DELAY_MS = 60;
/** How long to wait for every claimant to reach the line before releasing. */
const READY_TIMEOUT_MS = 20_000;

const control = new SharedArrayBuffer(3 * Int32Array.BYTES_PER_ELEMENT);
const controlView = new Int32Array(control);

/** One worker, started with `eval: true`, resolved on its single report. */
function startWorker(leasePath: string, payload: string): { worker: Worker; outcome: Promise<ClaimantOutcome> } {
  const worker = new Worker(WORKER_SOURCE, {
    eval: true,
    workerData: { leasePath, payload, control },
  });
  const outcome = new Promise<ClaimantOutcome>((resolve, reject) => {
    worker.on('message', (message: ClaimantOutcome) => resolve(message));
    worker.on('error', reject);
    worker.on('exit', (code) => {
      // Settling an already-settled promise is a no-op, so this only rejects
      // when a worker died before reporting — a harness failure that must not
      // be counted as a lost race.
      reject(new Error(`worker exited with code ${code} before reporting`));
    });
  });
  return { worker, outcome };
}

interface RoundResult {
  /** How many claimants reported "ready" before the release flag was set. */
  ready: number;
  /** The main thread's payload, for comparison. */
  mainPayload: string;
  /** The worker payloads, in order, for comparison. */
  workerPayloads: string[];
  /** The content actually in the lease file once the round settled. */
  content: string;
  statuses: ClaimantOutcome['status'][];
  codes: string[];
  messages: string[];
}

/**
 * One round: every claimant races for one path from a shared deadline.
 *
 * `mainThreadClaims: false` leaves the workers alone on the path, which is what
 * makes the round deterministic evidence about the workers: a round with no
 * other claimant cannot end without a worker winning.
 */
async function raceRound(
  leasePath: string,
  workerCount: number,
  stalePart: boolean,
  mainThreadClaims: boolean,
): Promise<RoundResult> {
  if (stalePart) {
    // A crashed atomic write's leftover — under the same race, so "a stale
    // `.part` does not block the `wx` create" is measured, not assumed.
    const partPath = `${leasePath}.part`;
    await fs.promises.writeFile(partPath, '{"half":"a write that crashed"}');
    const old = new Date(Date.now() - 60_000);
    await fs.promises.utimes(partPath, old, old);
  }

  Atomics.store(controlView, 0, 0);
  Atomics.store(controlView, 1, 0);
  Atomics.store(controlView, 2, 0);

  const mainPayload = 'main-thread';
  const workerPayloads = Array.from({ length: workerCount }, (_, index) => `worker-${index}`);
  const started = workerPayloads.map((payload) => startWorker(leasePath, payload));

  // Wait until every claimant says it is at the line, so the release is a
  // genuine simultaneous start rather than "whoever booted first".
  const readyDeadline = Date.now() + READY_TIMEOUT_MS;
  while (Atomics.load(controlView, 0) < workerCount && Date.now() < readyDeadline) {
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  const ready = Atomics.load(controlView, 0);

  Atomics.store(controlView, 1, Date.now() + RACE_DELAY_MS);
  Atomics.store(controlView, 2, 1);

  // The main thread races under the same deadline, spinning so the scheduler
  // cannot hand it the win by parking it for the worker's boot time.
  let mainOutcome: ClaimantOutcome = { status: 'lost' };
  try {
    if (mainThreadClaims) {
      while (Date.now() < Atomics.load(controlView, 1)) {
        /* spin to the shared deadline */
      }
      const handle = fs.openSync(leasePath, 'wx', 0o600);
      fs.writeSync(handle, mainPayload);
      fs.closeSync(handle);
      mainOutcome = { status: 'won', pid: process.pid };
    }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    mainOutcome = { status: code === 'EEXIST' ? 'lost' : 'error', code, pid: process.pid };
  }

  let workerOutcomes: ClaimantOutcome[];
  try {
    workerOutcomes = await Promise.all(started.map((entry) => entry.outcome));
  } finally {
    await Promise.all(started.map((entry) => entry.worker.terminate()));
  }

  const outcomes = mainThreadClaims ? [mainOutcome, ...workerOutcomes] : workerOutcomes;
  return {
    ready,
    mainPayload,
    workerPayloads,
    content: await fs.promises.readFile(leasePath, 'utf8'),
    statuses: outcomes.map((outcome) => outcome.status),
    codes: outcomes.map((outcome) => outcome.code ?? ''),
    messages: outcomes.map((outcome) => outcome.message ?? ''),
  };
}

// This file used to carry its own removal helper: the worker threads it spawns
// hold handles on the round's directory until `terminate()` resolves, so a
// removal one tick early fails with EPERM on Windows. That is exactly the window
// the shared `tempDirRemovalOptions` retries through, so the local copy is gone.

describe('cross-process mutual exclusion on a real filesystem (§10.1.3)', () => {
  it('lets exactly one of five simultaneous claimants win each of 25 rounds', async () => {
    const WORKERS = 4;
    const ROUNDS = 25;
    const CLAIMANTS = WORKERS + 1;
    const expectedPayloads = ['main-thread', ...Array.from({ length: WORKERS }, (_, index) => `worker-${index}`)];
    const roundsWithStalePart = new Set([4, 9, 14, 19, 24]);

    for (let round = 0; round < ROUNDS; round += 1) {
      const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'lease-xproc-'));
      const leasePath = path.join(dir, LEASE_FILE_NAME);
      const withStalePart = roundsWithStalePart.has(round);
      try {
        const result = await raceRound(leasePath, WORKERS, withStalePart, true);
        const where = `round ${round} (${withStalePart ? 'with' : 'without'} a stale .part)`;

        expect(result.ready, `${where}: every claimant must have been at the line`).toBe(WORKERS);
        const winners = result.statuses.filter((status) => status === 'won').length;
        const losers = result.statuses.filter((status) => status === 'lost').length;
        const errors = result.statuses.filter((status) => status === 'error').length;
        expect(
          errors,
          `${where}: unexpected failures: ${result.codes.filter(Boolean).join(', ')} ${result.messages.filter(Boolean).join('; ')}`,
        ).toBe(0);
        expect(winners, `${where}: exactly one claimant must win`).toBe(1);
        expect(losers, `${where}: every other claimant must have observed EEXIST`).toBe(CLAIMANTS - 1);
        for (const code of result.codes) {
          expect(code === '' || code === 'EEXIST').toBe(true);
        }
        // The winner's payload is the file's content: the write happened
        // through the same exclusive create that won, so no loser wrote at all.
        expect(expectedPayloads, `${where}: the file must hold the winner's payload`).toContain(result.content);
        // Printed so a CI failure report says who won which round: an
        // all-main-thread distribution would mean the barrier stopped working.
        console.log(`[lease-xproc] ${where}: winner=${result.content} ready=${result.ready}`);
      } finally {
        await removeTempDir(dir);
      }
    }
  }, 120_000);

  it('lets the workers alone settle a round, which proves they really raced', async () => {
    // The main thread stays out, so a round *cannot* end without a worker
    // winning, and a worker that never got past the barrier would hang into the
    // timeout instead of passing quietly. This is what makes the assertions
    // above evidence about the workers rather than about the main thread.
    const WORKERS = 4;
    const ROUNDS = 3;
    for (let round = 0; round < ROUNDS; round += 1) {
      const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'lease-xproc-workers-'));
      const leasePath = path.join(dir, LEASE_FILE_NAME);
      try {
        const result = await raceRound(leasePath, WORKERS, false, false);
        expect(result.ready, `workers-only round ${round}: every worker must have been at the line`).toBe(WORKERS);
        const winners = result.statuses.filter((status) => status === 'won').length;
        const losers = result.statuses.filter((status) => status === 'lost').length;
        expect(winners, `workers-only round ${round}: exactly one worker must win`).toBe(1);
        expect(losers, `workers-only round ${round}: the rest must see EEXIST`).toBe(WORKERS - 1);
        expect(result.workerPayloads, `workers-only round ${round}: a worker wrote the file`).toContain(result.content);
      } finally {
        await removeTempDir(dir);
      }
    }
  }, 60_000);
});
