/**
 * The lease's IO layer: the file the election is made of.
 *
 * The whole point of this module is that `fs.open(path, 'wx')` is the only
 * arbiter (§3.1, §4.3): the kernel decides "does not exist → create" in one
 * step, so exactly one window's claim succeeds and the others get `EEXIST`.
 * Nothing here reads or writes the editor's state store — the election is
 * file-only by decision (§2 decision 1, §12.2), because that store's
 * read-modify-write is not atomic and would turn "who leads" into a
 * probability. The reverse guard in `src/__tests__/leaseGuards.test.ts` fails
 * on a mere mention of it, which is why this note names no API.
 *
 * Division of labour with `src/utils/atomicWrite.ts`, which is easy to get
 * wrong and is therefore stated once here:
 *
 * - **Mutual exclusion** (`claim`) uses only `open(..., 'wx')`. Never a
 *   read-modify-write, never an unlink-then-create.
 * - **Refreshing a lease we already hold** (`heartbeat`) uses the atomic-write
 *   shape (write a sibling, fsync, rename) because the target already exists
 *   and a rename never creates a second holder. Doing it by hand rather than
 *   calling `writeFileAtomically` has one reason: the sibling is created with
 *   `wx` and closed *before* the rename, which is what keeps the measured
 *   Windows `EPERM` (rename over a target some process holds open, §13.1) from
 *   being manufactured by this code itself. The target is re-created with
 *   `wx`, so a crash can never leave the lease half-written.
 *
 * Anything this module cannot do degrades toward *more* polling (§8): an
 * unusable directory is reported as `unavailable` and the caller falls back to
 * full-speed polling, never to silence.
 */

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import {
  LEASE_CLAIM_REQUEST_MAX_AGE_MS,
  LEASE_FILE_NAME,
  LEASE_HEARTBEAT_RETRY_DELAY_MS,
  LEASE_HEARTBEAT_WRITE_ATTEMPTS,
  LEASE_RECORD_VERSION,
  LEASE_STALE_PART_MAX_AGE_MS,
} from './leaseConstants';
import { isLeaseStale } from './leaseDecision';
import type {
  ClaimRequest,
  ClaimOutcome,
  ClaimRequestObservation,
  HeartbeatOutcome,
  LeaseRead,
  LeaseRecord,
  ReleaseOutcome,
} from './leaseTypes';

/** The per-window nonce: generated once per extension host process (§3.2). */
export const LEASE_WINDOW_NONCE = crypto.randomBytes(8).toString('hex');

/** The slice used in log lines and the diagnostics JSON (§7.1, §11.1 stage 2). */
export function noncePrefix(nonce: string): string {
  return nonce.slice(0, 8);
}

/**
 * A stable digest of the configured instance *set*, for the record's
 * `instancesFingerprint` (§3.2, §3.3).
 *
 * The input is the config's own instance identity — `ForgejoInstance.id`, the
 * value the saved configuration and the stored secret are keyed by, and the same
 * notion `notificationPoller`'s instance key is built from. Nothing else is
 * hashed: no URL, no login, no name, so the digest carries no address (§3.2).
 * Sorting makes it depend on the *set*, not the order, because reordering the
 * configured instances is not a change in what this window polls.
 *
 * Diagnostics only, by decision: the fingerprint is deliberately absent from
 * `LeaseDecisionInput`, so it structurally cannot influence an election (§3.3).
 */
export function instanceSetFingerprint(instanceIds: readonly string[]): string {
  return crypto
    .createHash('sha256')
    .update([...instanceIds].sort().join('\u0000'))
    .digest('hex')
    .slice(0, 16);
}

/**
 * The subset of `fs.promises` this module uses, so tests can inject an fs that
 * fails on demand without mocking the whole `fs` module. The real adapter is
 * `toFileSystem` below.
 */
export interface FileSystem {
  readFile(filePath: string): Promise<string>;
  writeFile(filePath: string, data: string, mode: number): Promise<void>;
  openExclusive(filePath: string, mode: number): Promise<void>;
  chmod(filePath: string, mode: number): Promise<void>;
  mkdirp(dirPath: string, mode: number): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  unlink(filePath: string): Promise<void>;
  rm(filePath: string): Promise<void>;
  stat(filePath: string): Promise<{ mtimeMs: number; size: number; mode: number } | undefined>;
  readdir(dirPath: string): Promise<{ name: string; isFile: boolean }[]>;
  syncFile(filePath: string): Promise<void>;
}

/**
 * Node's `fs.promises` behind the interface above.
 *
 * `chmod`, `rename` and `unlink` are called with `this` bound to
 * `fs.promises`: tests spy on those three by replacing them on
 * `fs.promises`, which is the only way to make a real Windows `EPERM` happen
 * on demand (§10.1.7).
 */
export function toFileSystem(): FileSystem {
  const promises = fs.promises;
  return {
    readFile: (filePath) => promises.readFile(filePath, 'utf8'),
    writeFile: (filePath, data, mode) => promises.writeFile(filePath, data, { encoding: 'utf8', mode }),
    openExclusive: async (filePath, mode) => {
      const handle = await promises.open(filePath, 'wx', mode);
      await handle.close();
    },
    chmod: (filePath, mode) => promises.chmod(filePath, mode),
    mkdirp: async (dirPath, mode) => {
      await promises.mkdir(dirPath, { recursive: true, mode });
    },
    rename: (from, to) => promises.rename(from, to),
    unlink: (filePath) => promises.unlink(filePath),
    rm: (filePath) => promises.rm(filePath, { force: true }),
    stat: async (filePath) => {
      const stats = await promises.stat(filePath);
      return { mtimeMs: stats.mtimeMs, size: stats.size, mode: stats.mode & 0o777 };
    },
    readdir: async (dirPath) => {
      // `readdir` with `withFileTypes` plus a per-entry `stat` (rather than
      // `Dirent.isFile()`): the entries this module cares about are always
      // regular files, and it keeps the interface to one method per operation.
      const names = await promises.readdir(dirPath);
      const entries: { name: string; isFile: boolean }[] = [];
      for (const name of names) {
        const stats = await promises.stat(path.join(dirPath, name)).catch(() => undefined);
        entries.push({ name, isFile: stats?.isFile() ?? false });
      }
      return entries;
    },
    syncFile: async (filePath) => {
      const handle = await promises.open(filePath, 'r+');
      try {
        await handle.sync();
      } finally {
        await handle.close();
      }
    },
  };
}

/** What `writeClaimRequest` did: the published request, and the fate of the previous one. */
export interface ClaimRequestPublish {
  request: ClaimRequest;
  /**
   * What became of this window's *previous* request file (§3.2/§12.10: one file
   * per requester, replaced in place). `cleared` is the normal case; `missing`
   * means there was nothing to retire; `not-owner` means the file at our last
   * name was not provably ours and was deliberately left alone; **`failed`**
   * means the new request was published anyway and the old file is still there —
   * the caller should report that once per streak rather than per tick.
   */
  retiredPrevious: 'cleared' | 'missing' | 'not-owner' | 'failed';
}

/** Everything a `LeaseStore` needs to know about the window it serves. */
export interface LeaseStoreOptions {
  /** Where the lease lives: `<globalStorageUri.fsPath>/mcp-leader-lease.json` (§3.1). */
  directory: string;
  /** This window's module-scope nonce. Defaults to `LEASE_WINDOW_NONCE`. */
  ownerNonce?: string;
  /** This window's extension host pid. Defaults to `process.pid`. */
  pid?: number;
  /** Optional human-readable label for the record's `windowId` (§3.2). */
  windowId?: string;
  /** `context.extension.packageJSON.version`, or whatever the host reports. */
  appVersion?: string;
  /** Fingerprint of the instance set (§3.2, §3.3). */
  instancesFingerprint?: string;
  /** Injectable for tests; defaults to the real `fs.promises`. */
  fs?: FileSystem;
  /** Injectable for tests that need to observe the retry schedule. */
  delay?: (ms: number) => Promise<void>;
}

/** One captured lease, as written by this window. */
export interface LeaseWriteInput {
  ownerNonce: string;
  pid: number;
  windowId?: string;
  claimedAt: number;
  heartbeatAt: number;
  releaseReason: string | null;
  appVersion: string;
  instancesFingerprint: string;
}

/** The shape `LeaseStore.read()` returns: the record plus how it got here. */
export interface LeaseObservation {
  read: LeaseRead;
  /** The record when the file parsed and validated, for the caller's convenience. */
  record?: LeaseRecord;
  /** The file's mtime, or `undefined` when it does not exist. */
  mtimeMs?: number;
}

/** Everything the diagnostics of the *later* stages needs from the store, in one read. */
export interface LeaseInspection {
  leasePath: string;
  exists: boolean;
  read: LeaseRead;
  /** `fs.access`-style probe result for the directory; `undefined` when it could not be probed. */
  writable?: boolean;
  writableErrorCode?: string;
  ownerIsSelf: boolean;
  /** `process.kill(pid, 0)`, `EPERM` counted as alive (§3.5). */
  holderAlive?: boolean;
  claimRequests: ClaimRequestObservation[];
}

/**
 * True while the process exists. `process.kill(pid, 0)` sends no signal: it
 * throws `ESRCH` for a dead pid and `EPERM` for a live process this user may
 * not signal — which counts as alive, because taking a live window's lease is
 * worse than waiting (§3.5, mcpBroker.ts's `isProcessAlive`, deliberately
 * duplicated rather than imported from `mcp/**`).
 */
export function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** `EPERM`/`EBUSY`/`EACCES` are the codes a Windows lock or a scan can cause (§13.1, §8). */
export function isTransientWriteError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return code === 'EPERM' || code === 'EBUSY' || code === 'EACCES' || code === 'EMFILE' || code === 'ENFILE';
}

function errorCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException | undefined)?.code;
}

/** True when the error means "another window holds it" rather than "the mechanism is broken". */
function isExistsError(error: unknown): boolean {
  return errorCode(error) === 'EEXIST';
}

/**
 * The IO layer for one window: claim, heartbeat, yield, request, clean up.
 *
 * One instance per window. It holds no timer and starts nothing — the wiring
 * stage owns the cadence — so constructing one has no side effects beyond
 * generating a nonce.
 */
export class LeaseStore {
  readonly leasePath: string;
  private readonly directory: string;
  private readonly ownerNonce: string;
  private readonly pid: number;
  private readonly windowId?: string;
  private readonly appVersion: string;
  private instancesFingerprint: string;
  private readonly fs: FileSystem;
  private readonly delay: (ms: number) => Promise<void>;
  /** The token of the request file this window last wrote, if any. */
  private claimRequestToken?: string;
  /**
   * `Date.now()` of the `wx` create this window won, kept in memory so an
   * unpublished record can be republished with its original claim time instead
   * of restarting the anti-ping-pong window N on every retry (§2.3, §3.2).
   */
  private claimedAt?: number;
  /**
   * True while the file at the lease path is this window's own `wx`-created
   * lease whose record never landed. It is the store's knowledge that the *file
   * exists* but the *lease is not published* (§3.2, §4.2): only the window that
   * won the create can tell, and only it may repair the file.
   */
  private recordUnpublished = false;

  constructor(options: LeaseStoreOptions) {
    this.directory = options.directory;
    this.leasePath = path.join(options.directory, LEASE_FILE_NAME);
    this.ownerNonce = options.ownerNonce ?? LEASE_WINDOW_NONCE;
    this.pid = options.pid ?? process.pid;
    this.windowId = options.windowId;
    this.appVersion = options.appVersion ?? '0.0.0';
    this.instancesFingerprint = options.instancesFingerprint ?? '';
    this.fs = options.fs ?? toFileSystem();
    this.delay = options.delay ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  /** This window's nonce, so callers can log its prefix (§7.1). */
  get nonce(): string {
    return this.ownerNonce;
  }

  /** This window's pid, side by side with the nonce in every log line. */
  get processId(): number {
    return this.pid;
  }

  /**
   * The instance fingerprint is refreshed by the owner, never a reason to elect
   * (§3.3). Diagnostics only: the decision layer's input has no field for it.
   */
  updateInstancesFingerprint(fingerprint: string): void {
    this.instancesFingerprint = fingerprint;
  }

  /**
   * True when this window holds a `wx`-created lease whose record was never
   * published — the file exists, but what a reader gets is garbage, not the
   * `ownerNonce` that proves ownership (§3.2, §4.2). The decision layer needs
   * this to stay in its owner branch instead of trying to take over its own
   * lease, and the caller needs it to know that a `heartbeat()` call is really
   * a republish.
   */
  get holdsUnpublishedRecord(): boolean {
    return this.recordUnpublished;
  }

  /**
   * `<lease>.claim.<pid>` — and, for the file this window actually writes,
   * `<lease>.claim.<pid>.<token>`, so the owner can tell two requests by the
   * same pid apart (§2.3, §12.10).
   */
  claimRequestPath(pid: number = this.pid, token?: string): string {
    return `${this.leasePath}.claim.${pid}${token === undefined ? '' : `.${token}`}`;
  }

  /** The `.part` sibling a crashed write can leave behind (§4.2.5). */
  get leasePartPath(): string {
    return `${this.leasePath}.part`;
  }

  /**
   * Read and validate the lease file. Never throws: an unreadable file is
   * reported as `invalid` (or as an unreadable *path*, which the decision layer
   * turns into the degraded branch, §8).
   *
   * Every read also settles this window's unpublished-ownership knowledge,
   * because that is where the truth arrives: a readable record naming this
   * window means the publish succeeded, a foreign or absent one means this
   * window no longer holds anything. A malformed record leaves the flag alone —
   * that is the state the flag exists to describe (§3.2, §4.2).
   */
  async read(): Promise<LeaseObservation> {
    let raw: string;
    try {
      raw = await this.fs.readFile(this.leasePath);
    } catch (error) {
      if (errorCode(error) === 'ENOENT') {
        this.abandonUnpublishedRecord();
        return { read: { kind: 'missing' } };
      }
      // Anything else — EACCES, EISDIR, ENOTDIR, an I/O error — means the
      // mechanism cannot be used: the decision layer degrades to full-speed
      // polling rather than keep a silent window (§8).
      return { read: { kind: 'invalid', reason: 'unreadable' } };
    }
    const mtimeMs = await this.fs
      .stat(this.leasePath)
      .then((stats) => stats?.mtimeMs)
      .catch(() => undefined);
    try {
      const parsed: unknown = JSON.parse(raw);
      const record = validateLeaseRecord(parsed);
      if (!record) {
        return { read: { kind: 'invalid', reason: 'malformed' }, ...(mtimeMs === undefined ? {} : { mtimeMs }) };
      }
      if (record.ownerNonce === this.ownerNonce) {
        // Readable and ours: whatever was unpublished is published now.
        this.recordUnpublished = false;
        this.claimedAt = record.claimedAt;
      } else {
        this.abandonUnpublishedRecord();
      }
      return { read: { kind: 'ok', record }, record, ...(mtimeMs === undefined ? {} : { mtimeMs }) };
    } catch {
      return { read: { kind: 'invalid', reason: 'malformed' }, ...(mtimeMs === undefined ? {} : { mtimeMs }) };
    }
  }

  /** This window holds nothing any more: forget the unpublished claim entirely. */
  private abandonUnpublishedRecord(): void {
    this.recordUnpublished = false;
    this.claimedAt = undefined;
  }

  /** Read the lease and, when it parses, probe the holder pid (§3.5). */
  async readHolderAlive(observation: LeaseObservation): Promise<boolean | undefined> {
    if (observation.read.kind !== 'ok') {
      return undefined;
    }
    return isPidAlive(observation.read.record.pid);
  }

  /**
   * The one atomic step: `wx`-create the lease (§4.2). Exactly one window's
   * call can succeed; everyone else gets `contended` and stays a follower.
   *
   * There is deliberately no automatic "unlink and retry" inside this call. The
   * release of a stale record happens in `releaseStale`, which re-reads and
   * re-validates first, and the decision layer is what says whether it is
   * warranted (`mustReleaseStale`). Unlinking as a *reaction to `EEXIST`* is
   * exactly the failure mode §4.2.3 forbids: two followers would delete each
   * other's — and the winner's — just-written record.
   */
  async claim(now: number): Promise<ClaimOutcome> {
    return this.tryCreate(now);
  }

  /**
   * Release a lease that is verifiably not usable (invalid, expired, or held
   * by a dead pid), re-reading it first so a lease that became live in the
   * meantime is left alone (§4.2.3).
   */
  async releaseStale(now: number): Promise<ReleaseOutcome> {
    const observation = await this.read();
    if (observation.read.kind === 'missing') {
      return 'missing';
    }
    if (observation.read.kind === 'invalid') {
      return this.unlinkAndClassify();
    }
    const record = observation.read.record;
    if (record.ownerNonce === this.ownerNonce) {
      return 'not-owner';
    }
    if (!isLeaseStale(record, now, isPidAlive(record.pid))) {
      return 'not-owner';
    }
    return this.unlinkAndClassify();
  }

  /**
   * Voluntarily give the lease up (§2.3 step 3, §5): re-read the file, compare
   * the holder token, and only unlink when it is still ours. This is the whole
   * confirmation — the maintainer's 2026-09-27 decision removed the second one,
   * so nothing here waits for anything else.
   *
   * A *malformed* record is released too when this window is the one whose
   * publish failed (see `holdsUnpublishedRecord`): that file is the empty shell
   * of our own claim, it holds nobody's data, and leaving it behind would make a
   * step-down or a `deactivate()` leave a file that only some other window's
   * stale-release can clear. An *unreadable* path is still left alone — nothing
   * can be proven about it.
   */
  async yieldOwn(): Promise<ReleaseOutcome> {
    const observation = await this.read();
    if (observation.read.kind === 'missing') {
      return 'missing';
    }
    if (observation.read.kind === 'invalid') {
      if (observation.read.reason === 'unreadable' || !this.recordUnpublished) {
        return 'not-owner';
      }
      return this.unlinkAndClassify();
    }
    if (observation.read.record.ownerNonce !== this.ownerNonce) {
      // Not our file: touch nothing. This is the case a window that lost the
      // lease during its own tick lands in.
      return 'not-owner';
    }
    return this.unlinkAndClassify();
  }

  /**
   * Refresh `heartbeatAt` if — and only if — the lease is still ours (§4.1), or
   * republish this window's own record when its last write never landed.
   *
   * The re-read is the entire convergence mechanism: a window that took over
   * while this one was busy is detected here, within one heartbeat, and the
   * caller degrades instead of polling alongside the new owner (§4.1.2, §4.3).
   *
   * The repair case is the one exception, and it is narrow: a *malformed*
   * record this window created (`holdsUnpublishedRecord`) is written again with
   * the claim time kept in memory — nobody else may repair that file, and
   * leaving it alone would make the lease permanently unreadable while its
   * holder keeps renewing (§3.2, §4.2). A malformed record this window did not
   * create, and any foreign record, is `not-owner`: it is not ours to fix.
   */
  async heartbeat(now: number, options: { attempts?: number } = {}): Promise<HeartbeatOutcome> {
    const observation = await this.read();
    if (observation.read.kind === 'missing') {
      return 'missing';
    }
    let claimedAt: number;
    if (observation.read.kind === 'ok') {
      if (observation.read.record.ownerNonce !== this.ownerNonce) {
        return 'not-owner';
      }
      claimedAt = observation.read.record.claimedAt;
    } else {
      // The record is unreadable. Only this window's own unpublished shell may
      // be written, and only with the claim time its `wx` create remembered.
      if (observation.read.reason === 'unreadable') {
        return 'unavailable';
      }
      if (!this.recordUnpublished || this.claimedAt === undefined) {
        return 'not-owner';
      }
      claimedAt = this.claimedAt;
    }
    const record: LeaseWriteInput = {
      ownerNonce: this.ownerNonce,
      pid: this.pid,
      ...(this.windowId === undefined ? {} : { windowId: this.windowId }),
      claimedAt,
      heartbeatAt: now,
      releaseReason: null,
      appVersion: this.appVersion,
      instancesFingerprint: this.instancesFingerprint,
    };
    const attempts = Math.max(1, options.attempts ?? LEASE_HEARTBEAT_WRITE_ATTEMPTS);
    const outcome = await this.writeLeaseWithRetry(record, attempts);
    if (outcome === 'written') {
      // Published (or republished): the file now carries the record a reader
      // needs, so the unpublished state is over.
      this.recordUnpublished = false;
      this.claimedAt = claimedAt;
    }
    return outcome;
  }

  /**
   * One immediate `wx` attempt; no stale handling, no retries (§4.2.2).
   *
   * The outcome distinguishes the two states a successful create can produce
   * (§3.2, §4.2): `claimed` means the file was created *and* the record
   * published, `claimed-unpublished` means this window holds the mutex but the
   * record a reader needs is missing. The latter is not a failure of the claim —
   * the `wx` create is what excludes other windows, and it stands — but it is
   * not a usable lease either, and the caller has to keep republishing.
   */
  private async tryCreate(now: number): Promise<ClaimOutcome> {
    try {
      await this.fs.mkdirp(this.directory, 0o700);
    } catch (error) {
      if (isExistsError(error)) {
        // Exists as a file, or a concurrent mkdir: `open(..., 'wx')` reports
        // the real verdict immediately below.
      } else if (!isTransientWriteError(error)) {
        return 'unavailable';
      }
    }
    try {
      await this.fs.openExclusive(this.leasePath, 0o600);
    } catch (error) {
      return isExistsError(error) ? 'contended' : 'unavailable';
    }
    // The mutex is ours from here on, and the claim time has to be remembered
    // for a possible repair: once the record is unreadable, the file cannot tell
    // us when this window claimed it.
    this.claimedAt = now;
    this.recordUnpublished = true;
    const record: LeaseWriteInput = {
      ownerNonce: this.ownerNonce,
      pid: this.pid,
      ...(this.windowId === undefined ? {} : { windowId: this.windowId }),
      claimedAt: now,
      heartbeatAt: now,
      releaseReason: null,
      appVersion: this.appVersion,
      instancesFingerprint: this.instancesFingerprint,
    };
    const published = await this.writeLeaseWithRetry(record, LEASE_HEARTBEAT_WRITE_ATTEMPTS).catch(
      (): HeartbeatOutcome => 'failed',
    );
    if (published === 'missing') {
      // The file disappeared under the write: someone released it while this
      // window was filling it in. There is nothing to hold, and calling it ours
      // would let two windows claim the same path.
      this.abandonUnpublishedRecord();
      return 'contended';
    }
    if (published !== 'written') {
      // An empty file is stale by construction, so the worst case is that
      // another window releases it as stale and claims it — never that a live
      // holder goes unnoticed (§8). Report the state honestly instead of
      // pretending the record landed.
      return 'claimed-unpublished';
    }
    this.recordUnpublished = false;
    // §4.2.5: a `.part` left by a crashed write can be cleared on takeover, now
    // that this window is the one writing that name.
    await this.clearStalePart(now);
    return 'claimed';
  }

  private async writeLeaseWithRetry(record: LeaseWriteInput, attempts: number): Promise<HeartbeatOutcome> {
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      if (attempt > 0) {
        await this.delay(LEASE_HEARTBEAT_RETRY_DELAY_MS);
      }
      try {
        await this.writeLeaseAtomically(record);
        return 'written';
      } catch (error) {
        if (!isTransientWriteError(error)) {
          // A read-only filesystem is the mechanism being unusable, not a
          // heartbeat hiccup (§8).
          return 'unavailable';
        }
      }
    }
    // Every attempt hit a transient write error (a Windows `EPERM` from a read
    // handle that stayed open too long, §13.1). Report it as a failure only if
    // there is still a lease here to refresh: if the file is gone, someone
    // released it and this window is simply no longer the owner (§4.1.2).
    return (await this.fs.stat(this.leasePath).catch(() => undefined)) ? 'failed' : 'missing';
  }

  /**
   * Write the lease atomically: sibling `.part` created with `wx`, fsynced,
   * handle closed, then renamed over the target (§3.2's atomic-write shape; see
   * the module comment for why it is not `writeFileAtomically`).
   */
  private async writeLeaseAtomically(record: LeaseWriteInput): Promise<void> {
    const partPath = this.leasePartPath;
    const payload = `${JSON.stringify(recordToJson(record), null, 2)}\n`;
    // A `.part` that is *ours to clear* blocks `wx`; a younger one may be
    // another window mid-write, so it only costs one attempt (§4.2.5).
    await this.clearStalePart(record.heartbeatAt);
    try {
      // The target's mode (0600 on first creation) is copied onto the sibling
      // so the rename cannot widen it, exactly as `writeFileAtomically` does.
      const existingMode = await this.fs
        .stat(this.leasePath)
        .then((stats) => stats?.mode)
        .catch(() => undefined);
      await this.fs.writeFile(partPath, payload, existingMode ?? 0o600);
      await this.fs.chmod(partPath, existingMode ?? 0o600);
      await this.fs.syncFile(partPath);
      await this.fs.rename(partPath, this.leasePath);
    } catch (error) {
      await this.fs.rm(partPath).catch(() => undefined);
      throw error;
    }
  }

  /**
   * Remove a `.part` older than the staleness window; younger ones are left
   * alone because they may be another window's write in flight (§4.2.5).
   * Public so the takeover path's caller and the tests can state that rule
   * directly.
   */
  async clearStalePart(now: number): Promise<boolean> {
    const stats = await this.fs.stat(this.leasePartPath).catch(() => undefined);
    if (!stats) {
      return false;
    }
    if (now - stats.mtimeMs < LEASE_STALE_PART_MAX_AGE_MS) {
      return false;
    }
    await this.fs.unlink(this.leasePartPath).catch(() => undefined);
    return true;
  }

  private async unlinkAndClassify(): Promise<ReleaseOutcome> {
    // Releasing means giving up the claim, whatever the unlink answered: the
    // unpublished-record bookkeeping must not survive a release, or a later
    // heartbeat would "repair" a lease this window has just walked away from
    // (and a successor may hold it by then).
    this.abandonUnpublishedRecord();
    try {
      await this.fs.unlink(this.leasePath);
      return 'released';
    } catch (error) {
      if (errorCode(error) === 'ENOENT') {
        // Someone else got there first; the goal is achieved either way.
        return 'missing';
      }
      return 'failed';
    }
  }

  /** All `<lease>.claim.*` files in the directory, parsed. */
  async readClaimRequests(): Promise<ClaimRequestObservation[]> {
    let entries: { name: string; isFile: boolean }[];
    try {
      entries = await this.fs.readdir(this.directory);
    } catch {
      return [];
    }
    const prefix = `${path.basename(this.leasePath)}.claim.`;
    const observations: ClaimRequestObservation[] = [];
    for (const entry of entries) {
      if (!entry.isFile || !entry.name.startsWith(prefix)) {
        continue;
      }
      const filePath = path.join(this.directory, entry.name);
      const read = await this.readClaimRequestFile(filePath, entry.name);
      if (read.kind === 'ok') {
        observations.push(read.observation);
      }
    }
    return observations;
  }

  private async readClaimRequestFile(
    filePath: string,
    fileName: string,
  ): Promise<{ kind: 'ok'; observation: ClaimRequestObservation } | { kind: 'invalid' }> {
    try {
      const raw = await this.fs.readFile(filePath);
      const parsed: unknown = JSON.parse(raw);
      const request = validateClaimRequest(parsed);
      if (!request) {
        return { kind: 'invalid' };
      }
      const stats = await this.fs.stat(filePath).catch(() => undefined);
      return {
        kind: 'ok',
        observation: {
          request,
          mtimeMs: stats?.mtimeMs ?? request.at,
          token: tokenFromFileName(fileName),
          fileName,
        },
      };
    } catch {
      return { kind: 'invalid' };
    }
  }

  /**
   * Publish this window's request to displace the owner (§2.3 step 1). The
   * owner's lease file is never touched: it stays the `wx`-protected mutex.
   *
   * **One request file per requester, replaced in place.** The name carries a
   * fresh random token per request, so publishing without retiring the previous
   * file leaves one small file behind per request — a window that is refused on
   * every tick would leak thousands of them into globalStorage within a day, and
   * nothing else ever removes them: `clearClaimRequest` only knows the token it
   * wrote last, and the owner deliberately prunes only *dead* requesters
   * (`pruneStaleClaimRequests`). So the previous file is retired first, with the
   * same re-read-and-verify discipline `clearClaimRequest` uses: a file that is
   * no longer ours, or that names another pid, is left alone. **A failed
   * retirement never blocks the publish** — the new request is written either
   * way, and the caller reports `retiredPrevious: 'failed'` once per streak.
   *
   * `now` is passed in, and the caller enforces the H debounce and the
   * anti-storm backoff before calling; this method only writes.
   */
  async writeClaimRequest(
    now: number,
    options: { focused: boolean; ownPid?: number } = { focused: true },
  ): Promise<ClaimRequestPublish> {
    const retiredPrevious = await this.clearClaimRequest();
    const token = crypto.randomBytes(4).toString('hex');
    const request: ClaimRequest = {
      version: LEASE_RECORD_VERSION,
      pid: options.ownPid ?? this.pid,
      focused: options.focused,
      ...(this.windowId === undefined ? {} : { windowId: this.windowId }),
      at: now,
    };
    await this.fs.mkdirp(this.directory, 0o700);
    await this.fs.writeFile(this.claimRequestPath(request.pid, token), `${JSON.stringify(request, null, 2)}\n`, 0o600);
    this.claimRequestToken = token;
    return { request, retiredPrevious };
  }

  /** The token of the request file this store last wrote, for ownership checks. */
  get lastClaimRequestToken(): string | undefined {
    return this.claimRequestToken;
  }

  /**
   * Owner-side housekeeping (§2.3, §12.10), run while the owner is already
   * reading the request directory: remove the entries that can never matter
   * again — **older than `LEASE_CLAIM_REQUEST_MAX_AGE_MS`** (the decision layer
   * ignores them anyway) **and** written by a pid that is no longer alive (so no
   * window can be mid-republish). It is the safety net for a window that died
   * between publishing its request and retiring it; without it those files stay
   * in globalStorage forever.
   *
   * The observations are the ones the caller just read, so this costs no second
   * directory scan. Two conditions are deliberately absolute: a **fresh** file
   * is never removed (whatever its pid — the age filter is the only thing that
   * may make a file irrelevant), and an **old file of a live pid** is never
   * removed either (that window may be about to republish, and the age filter
   * already stops it from counting). `keepFileName` — the pending request the
   * caller is acting on — is skipped as well. Unparseable entries never reach
   * here: `readClaimRequests` drops them, and with no pid to probe they cannot
   * be proven dead, so they are left alone rather than deleted blind.
   *
   * Returns the base names it removed, for the caller's log line.
   */
  async pruneStaleClaimRequests(
    now: number,
    observed: readonly ClaimRequestObservation[],
    keepFileName?: string,
  ): Promise<string[]> {
    const removed: string[] = [];
    for (const observation of observed) {
      if (observation.fileName === keepFileName) {
        continue;
      }
      if (now - observation.request.at <= LEASE_CLAIM_REQUEST_MAX_AGE_MS) {
        continue;
      }
      if (isPidAlive(observation.request.pid)) {
        continue;
      }
      try {
        await this.fs.unlink(path.join(this.directory, observation.fileName));
        removed.push(observation.fileName);
      } catch {
        // Another window removed it first, or the unlink is not permitted:
        // nothing to report, and the next owner tick tries again.
      }
    }
    return removed;
  }

  /**
   * Remove this window's own request file, after re-reading it: a request we
   * did not write is not ours to delete, even though the name carries our pid
   * (pids are recycled).
   */
  async clearClaimRequest(): Promise<'cleared' | 'missing' | 'not-owner' | 'failed'> {
    const token = this.claimRequestToken;
    const filePath = this.claimRequestPath(this.pid, token);
    let raw: string;
    try {
      raw = await this.fs.readFile(filePath);
    } catch (error) {
      return errorCode(error) === 'ENOENT' ? 'missing' : 'failed';
    }
    let request: ClaimRequest | undefined;
    try {
      request = validateClaimRequest(JSON.parse(raw));
    } catch {
      request = undefined;
    }
    if (request && request.pid !== this.pid) {
      return 'not-owner';
    }
    if (request === undefined && token === undefined) {
      // An unparseable file we cannot prove we wrote (a pre-token name, or a
      // stranger's) is left alone: deleting it could break another window's
      // request, and a leftover request only ages out (§2.3).
      return 'not-owner';
    }
    try {
      await this.fs.unlink(filePath);
      this.claimRequestToken = undefined;
      return 'cleared';
    } catch (error) {
      return errorCode(error) === 'ENOENT' ? 'missing' : 'failed';
    }
  }

  /**
   * One cheap probe of whether the lease directory can be written, for the
   * diagnostics of §11.1 stage 2: create a uniquely named probe file with `wx`,
   * then remove it. Reports only a boolean and an error code — never a path
   * beyond the lease directory the diagnostics already carries.
   */
  async probeWritable(now: number): Promise<{ writable: boolean; errorCode?: string }> {
    const probePath = path.join(this.directory, `.lease-probe-${this.pid}-${now.toString(36)}`);
    try {
      await this.fs.mkdirp(this.directory, 0o700);
      await this.fs.openExclusive(probePath, 0o600);
      await this.fs.rm(probePath);
      return { writable: true };
    } catch (error) {
      await this.fs.rm(probePath).catch(() => undefined);
      const code = errorCode(error);
      return code === undefined ? { writable: false } : { writable: false, errorCode: code };
    }
  }

  /** The store's whole view, in one read: what the later diagnostics stage needs. */
  async inspect(): Promise<LeaseInspection> {
    const observation = await this.read();
    const claimRequests = await this.readClaimRequests();
    const probe = await this.probeWritable(Date.now());
    const holderAlive = observation.read.kind === 'ok' ? isPidAlive(observation.read.record.pid) : undefined;
    return {
      leasePath: this.leasePath,
      exists: observation.read.kind !== 'missing',
      read: observation.read,
      writable: probe.writable,
      ...(probe.errorCode === undefined ? {} : { writableErrorCode: probe.errorCode }),
      ownerIsSelf: observation.read.kind === 'ok' && observation.read.record.ownerNonce === this.ownerNonce,
      ...(holderAlive === undefined ? {} : { holderAlive }),
      claimRequests,
    };
  }

  /**
   * What `deactivate()` calls (§5): give up our own lease and our own request,
   * both after re-checking ownership. Safe when nothing exists — a window that
   * never held the lease must not fail shutdown.
   */
  async cleanup(): Promise<{ lease: ReleaseOutcome; claimRequest: 'cleared' | 'missing' | 'not-owner' | 'failed' }> {
    const lease = await this.yieldOwn();
    const claimRequest = await this.clearClaimRequest();
    return { lease, claimRequest };
  }
}

/** `now - heartbeatAt`; the decision layer turns it into "stale" (§4.2, §6). */
export function leaseHeartbeatAgeMs(record: LeaseRecord, now: number): number {
  return now - record.heartbeatAt;
}

/** The JSON that goes into the lease file (§3.2's exact field set). */
function recordToJson(record: LeaseWriteInput): Record<string, unknown> {
  return {
    version: LEASE_RECORD_VERSION,
    ownerNonce: record.ownerNonce,
    pid: record.pid,
    ...(record.windowId === undefined ? {} : { windowId: record.windowId }),
    claimedAt: record.claimedAt,
    heartbeatAt: record.heartbeatAt,
    releaseReason: record.releaseReason,
    appVersion: record.appVersion,
    instancesFingerprint: record.instancesFingerprint,
  };
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

/**
 * Validate a parsed lease record. Anything short of a complete record is
 * `undefined`, which the caller treats as `invalid` → stale → takeoverable
 * (§8: a record the owner cannot trust is one nobody should be blocked by).
 */
export function validateLeaseRecord(parsed: unknown): LeaseRecord | undefined {
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return undefined;
  }
  const record = parsed as Record<string, unknown>;
  if (record.version !== LEASE_RECORD_VERSION) {
    return undefined;
  }
  if (!isNonEmptyString(record.ownerNonce) || !isFiniteNumber(record.pid) || record.pid <= 0) {
    return undefined;
  }
  if (!isFiniteNumber(record.claimedAt) || !isFiniteNumber(record.heartbeatAt)) {
    return undefined;
  }
  if (record.windowId !== undefined && typeof record.windowId !== 'string') {
    return undefined;
  }
  if (record.releaseReason !== null && typeof record.releaseReason !== 'string') {
    return undefined;
  }
  if (typeof record.appVersion !== 'string' || typeof record.instancesFingerprint !== 'string') {
    return undefined;
  }
  return {
    version: LEASE_RECORD_VERSION,
    ownerNonce: record.ownerNonce,
    pid: Math.trunc(record.pid),
    ...(record.windowId === undefined ? {} : { windowId: record.windowId }),
    claimedAt: record.claimedAt,
    heartbeatAt: record.heartbeatAt,
    releaseReason: (record.releaseReason as string | null) ?? null,
    appVersion: record.appVersion,
    instancesFingerprint: record.instancesFingerprint,
  };
}

/** Validate a parsed claim request (§2.3, §12.10). */
export function validateClaimRequest(parsed: unknown): ClaimRequest | undefined {
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return undefined;
  }
  const request = parsed as Record<string, unknown>;
  if (request.version !== LEASE_RECORD_VERSION) {
    return undefined;
  }
  if (!isFiniteNumber(request.pid) || request.pid <= 0 || typeof request.focused !== 'boolean') {
    return undefined;
  }
  if (!isFiniteNumber(request.at)) {
    return undefined;
  }
  if (request.windowId !== undefined && typeof request.windowId !== 'string') {
    return undefined;
  }
  return {
    version: LEASE_RECORD_VERSION,
    pid: Math.trunc(request.pid),
    focused: request.focused,
    ...(request.windowId === undefined ? {} : { windowId: request.windowId }),
    at: request.at,
  };
}

/**
 * The `<random>` half of `<lease>.claim.<pid>.<random>` when present. Kept
 * permissive: the file name is a hint, and its content is the contract.
 */
function tokenFromFileName(fileName: string): string {
  const tail = fileName.split('.').pop() ?? '';
  return tail;
}
