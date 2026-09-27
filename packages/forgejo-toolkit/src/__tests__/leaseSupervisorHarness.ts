import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { vi } from 'vitest';
import { LEASE_CLAIM_TICK_MS, LEASE_FILE_NAME, LEASE_RECORD_VERSION } from '../lease/leaseConstants';
import { LeaseStore, toFileSystem, type FileSystem } from '../lease/leaseStore';
import { LeaseSupervisor } from '../lease/leaseSupervisor';
import type { ClaimRequest, LeaseRecord } from '../lease/leaseTypes';

/**
 * The lease tests' harness: a real temp directory, a real `LeaseStore`, an
 * injectable clock, a fake window and a fake settings source.
 *
 * Two things are deliberately real, because they are what the stage wires up:
 * the store (so a test proves the election's files, not a stub's calls) and the
 * fs, which is only ever wrapped to *inject a fault* — the `EPERM`/`EACCES`
 * paths §4.1 and §8 describe. Fake timers drive the tick; the harness never
 * sleeps, because `whenSettled()` is the tick's own completion signal.
 */

/** The logger spies, typed from the factory so no `Mock` generic is spelled out. */
export function makeLeaseLogger() {
  return {
    info: vi.fn((_message: string) => undefined),
    debug: vi.fn((_message: string) => undefined),
  };
}

export type LeaseLoggerSpy = ReturnType<typeof makeLeaseLogger>;

/** The fake window: `isFocused` plus the event `onDidChangeWindowState` stands for. */
export interface FocusHarness {
  focused: boolean;
  listeners: Set<(focused: boolean) => void>;
  /** State and event together: what a real window state change looks like. */
  fire(focused: boolean): void;
  /** State only, no event: the missed-event case §2.3 prerequisite 1 covers. */
  setSilently(focused: boolean): void;
  listenerCount(): number;
}

/** The fake setting: a value plus the change event `onDidChangeConfiguration` stands for. */
export interface SettingsHarness {
  enabled: boolean;
  /** Flips the value and fires the change, as the editor would. */
  set(enabled: boolean): void;
  listenerCount(): number;
}

export interface LeaseHarness {
  dir: string;
  leasePath: string;
  clock: { ms: number };
  focus: FocusHarness;
  settings: SettingsHarness;
  logger: LeaseLoggerSpy;
  store: LeaseStore;
  supervisor: LeaseSupervisor;
  /** Every `mayPoll` transition the gate published, in order (§8, stage 2). */
  gateChanges: boolean[];
  /** Every cause the supervisor reported to the §7.1 notice callback. */
  degradedNotices: string[];
  infoLines(): string[];
  debugLines(): string[];
  allLines(): string[];
  start(): Promise<void>;
  /** Moves the clock and the fake interval by `count` ticks, awaiting each. */
  tick(count?: number): Promise<void>;
  readRecord(): Promise<LeaseRecord | undefined>;
  dispose(): Promise<void>;
}

export interface MakeLeaseOptions {
  /** The initial focus state; `false` keeps the H debounce out of the way. */
  focused?: boolean;
  clockStart?: number;
  ownerNonce?: string;
  pid?: number;
  /** A wrapped `toFileSystem()` that fails on demand. */
  fs?: FileSystem;
  /** The version stamped into the record; defaults to `0.0.1`. */
  appVersion?: string;
  /** The configured instance identifiers the fingerprint is built from (§3.3). */
  instanceIds?: () => readonly string[];
  /** `forgejoToolkit.multiWindowLease`; defaults to on. */
  leaseEnabled?: boolean;
}

/** The real fs with named operations replaced, for the failure paths. */
export function withFaults(overrides: Partial<FileSystem>): FileSystem {
  return { ...toFileSystem(), ...overrides };
}

// Re-exported so a test can wrap it without importing the store module twice.
export { toFileSystem };

export async function makeLeaseHarness(options: MakeLeaseOptions = {}): Promise<LeaseHarness> {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'lease-supervisor-'));
  const leasePath = path.join(dir, LEASE_FILE_NAME);
  const clock = { ms: options.clockStart ?? 1_000_000 };
  const logger = makeLeaseLogger();
  const focus = makeFocusHarness(options.focused ?? false);
  const settingsListeners = new Set<() => void>();
  const settings: SettingsHarness = {
    enabled: options.leaseEnabled ?? true,
    set(enabled: boolean) {
      settings.enabled = enabled;
      for (const listener of [...settingsListeners]) {
        listener();
      }
    },
    listenerCount: () => settingsListeners.size,
  };
  const gateChanges: boolean[] = [];
  const degradedNotices: string[] = [];
  const store = new LeaseStore({
    directory: dir,
    // A hex nonce, like the real `LEASE_WINDOW_NONCE`, so the §7.1
    // `nonce=<first 8>` field is asserted against something meaningful.
    ownerNonce: options.ownerNonce ?? 'a1b2c3d4e5f60718',
    pid: options.pid ?? 111,
    appVersion: options.appVersion ?? '0.0.1',
    instancesFingerprint: 'fp',
    windowId: 'lease-window',
    delay: async () => undefined,
    fs: options.fs ?? toFileSystem(),
  });
  const supervisor = new LeaseSupervisor({
    directory: dir,
    logger,
    ...(options.appVersion === undefined ? {} : { appVersion: options.appVersion }),
    ...(options.instanceIds === undefined ? {} : { instanceIds: options.instanceIds }),
    isLeaseEnabled: () => settings.enabled,
    onDidChangeSettings: (listener) => {
      settingsListeners.add(listener);
      return {
        dispose: () => {
          settingsListeners.delete(listener);
        },
      };
    },
    onDegraded: (cause) => {
      degradedNotices.push(cause);
    },
    host: {
      isFocused: () => focus.focused,
      onDidChangeFocus: (listener) => {
        focus.listeners.add(listener);
        return {
          dispose: () => {
            focus.listeners.delete(listener);
          },
        };
      },
    },
    store,
    now: () => clock.ms,
  });
  supervisor.onDidChange((mayPoll) => {
    gateChanges.push(mayPoll);
  });

  const harness: LeaseHarness = {
    dir,
    leasePath,
    clock,
    focus,
    settings,
    logger,
    store,
    supervisor,
    gateChanges,
    degradedNotices,
    infoLines: () => logger.info.mock.calls.map(([message]) => message),
    debugLines: () => logger.debug.mock.calls.map(([message]) => message),
    allLines: () => [...harness.infoLines(), ...harness.debugLines()],
    start: async () => {
      supervisor.start();
      await supervisor.whenSettled();
    },
    tick: async (count = 1) => {
      for (let index = 0; index < count; index += 1) {
        clock.ms += LEASE_CLAIM_TICK_MS;
        await vi.advanceTimersByTimeAsync(LEASE_CLAIM_TICK_MS);
        await supervisor.whenSettled();
      }
    },
    readRecord: async () => {
      try {
        return JSON.parse(await fs.promises.readFile(leasePath, 'utf8')) as LeaseRecord;
      } catch {
        return undefined;
      }
    },
    dispose: async () => {
      await supervisor.dispose();
    },
  };
  return harness;
}

function makeFocusHarness(initial: boolean): FocusHarness {
  const harness: FocusHarness = {
    focused: initial,
    listeners: new Set(),
    fire: (focused) => {
      harness.focused = focused;
      for (const listener of [...harness.listeners]) {
        listener(focused);
      }
    },
    setSilently: (focused) => {
      harness.focused = focused;
    },
    listenerCount: () => harness.listeners.size,
  };
  return harness;
}

export async function removeLeaseHarness(harness: LeaseHarness): Promise<void> {
  await harness.supervisor.dispose();
  await fs.promises.rm(harness.dir, { recursive: true, force: true });
}

/** A lease record another window would have written, in this window's directory. */
export async function writeForeignLease(
  harness: LeaseHarness,
  overrides: Partial<LeaseRecord> = {},
): Promise<LeaseRecord> {
  const record: LeaseRecord = {
    version: LEASE_RECORD_VERSION,
    ownerNonce: 'foreign-nonce',
    pid: 4242,
    claimedAt: harness.clock.ms,
    heartbeatAt: harness.clock.ms,
    releaseReason: null,
    appVersion: '0.0.1',
    instancesFingerprint: 'fp',
    ...overrides,
  };
  await fs.promises.writeFile(harness.leasePath, `${JSON.stringify(record, null, 2)}\n`, 'utf8');
  return record;
}

/** Another window's claim request on disk, without going through this window's store. */
export async function writeForeignClaimRequest(
  harness: LeaseHarness,
  request: Partial<ClaimRequest> = {},
  options: { pid?: number; token?: string; at?: number } = {},
): Promise<void> {
  const payload: ClaimRequest = {
    version: LEASE_RECORD_VERSION,
    pid: options.pid ?? 4242,
    focused: true,
    at: options.at ?? harness.clock.ms,
    ...request,
  };
  const file = `${harness.leasePath}.claim.${payload.pid}.${options.token ?? 'feedc0de'}`;
  await fs.promises.writeFile(file, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
}

/** Every claim-request file for the lease, by name. */
export async function claimRequestFiles(harness: LeaseHarness): Promise<string[]> {
  const names = await fs.promises.readdir(harness.dir);
  return names.filter((name) => name.startsWith(`${LEASE_FILE_NAME}.claim.`)).sort();
}

export function leaseFileExists(harness: LeaseHarness): boolean {
  return fs.existsSync(harness.leasePath);
}

/** Lines whose `action=` is `action` (a `lease` field, not a substring). */
export function linesWithAction(lines: readonly string[], action: string): string[] {
  return lines.filter((line) => line.includes(`action=${action} `));
}
