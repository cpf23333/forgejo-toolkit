import type { ServerVersionCacheStorage } from '../serverVersionCache';

/**
 * An in-memory stand-in for the editor state store behind the shared server
 * version cache (§9 route 2).
 *
 * The cache only ever sees a `ServerVersionCacheStorage`, so every test of it —
 * the unit tests here, the probe tests and the diagnostics command — can share
 * this one double instead of standing up a `vscode.ExtensionContext`. It also
 * exposes the two things those tests need to see: the raw slot (so a test can
 * assert the merge left another window's entries alone) and the failure modes
 * (so "an unreadable store degrades to the in-process behaviour" can be
 * exercised rather than assumed).
 */
export interface MemoryVersionCacheStore {
  storage: ServerVersionCacheStorage;
  /** The slot's current contents, exactly as stored. */
  raw: () => unknown;
  /** Overwrites the slot without going through `write` (a "narrow the window" race). */
  seed: (next: unknown) => void;
  /** How many times `write` was called. */
  writes: () => number;
  /** How many times `read` was called, for the wait loop's polling assertions. */
  reads: () => number;
  /** Forgets the write count, so a phase of a test can be counted on its own. */
  resetWrites: () => void;
  /** Makes every read throw, as an unusable store would. */
  failReads: (error?: unknown) => void;
  /** Makes every write reject, as a locked or read-only store would. */
  failWrites: (error?: unknown) => void;
  /**
   * Undoes {@link failReads}/{@link failWrites}. A store is normally rebuilt per
   * test, but a suite that shares one across tests (the probe and gate suites,
   * whose subject is the real client) has to be able to heal it.
   */
  resetFailures: () => void;
}

export function makeMemoryVersionCacheStore(initial?: unknown): MemoryVersionCacheStore {
  let value = initial;
  let readError: unknown;
  let writeError: unknown;
  let writeCount = 0;
  let readCount = 0;
  return {
    storage: {
      read: () => {
        readCount += 1;
        if (readError !== undefined) {
          throw readError;
        }
        return value;
      },
      write: async (next: unknown) => {
        writeCount += 1;
        if (writeError !== undefined) {
          throw writeError;
        }
        value = next;
      },
    },
    raw: () => value,
    seed: (next) => {
      value = next;
    },
    writes: () => writeCount,
    reads: () => readCount,
    resetWrites: () => {
      writeCount = 0;
    },
    failReads: (error = new Error('EACCES')) => {
      readError = error;
    },
    failWrites: (error = new Error('EPERM')) => {
      writeError = error;
    },
    resetFailures: () => {
      readError = undefined;
      writeError = undefined;
    },
  };
}
