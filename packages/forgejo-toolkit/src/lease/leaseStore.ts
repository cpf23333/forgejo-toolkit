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

  /** The instance fingerprint is refreshed by the owner, never a reason to elect (§3.3). */
  updateInstancesFingerprint(fingerprint: string): void {
    this.instancesFingerprint = fingerprint;
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
   */
  async read(): Promise<LeaseObservation> {
    let raw: string;
    try {
      raw = await this.fs.readFile(this.leasePath);
    } catch (error) {
      if (errorCode(error) === 'ENOENT') {
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
      return { read: { kind: 'ok', record }, record, ...(mtimeMs === undefined ? {} : { mtimeMs }) };
    } catch {
      return { read: { kind: 'invalid', reason: 'malformed' }, ...(mtimeMs === undefined ? {} : { mtimeMs }) };
    }
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
   */
  async yieldOwn(): Promise<ReleaseOutcome> {
    const observation = await this.read();
    if (observation.read.kind === 'missing') {
      return 'missing';
    }
    if (observation.read.kind !== 'ok' || observation.read.record.ownerNonce !== this.ownerNonce) {
      // Not our file: touch nothing. This is the case a window that lost the
      // lease during its own tick lands in.
      return 'not-owner';
    }
    return this.unlinkAndClassify();
  }

  /**
   * Refresh `heartbeatAt` if — and only if — the lease is still ours (§4.1).
   *
   * The re-read is the entire convergence mechanism: a window that took over
   * while this one was busy is detected here, within one heartbeat, and the
   * caller degrades instead of polling alongside the new owner (§4.1.2, §4.3).
   */
  async heartbeat(now: number, options: { attempts?: number } = {}): Promise<HeartbeatOutcome> {
    const observation = await this.read();
    if (observation.read.kind === 'missing') {
      return 'missing';
    }
    if (observation.read.kind !== 'ok' || observation.read.record.ownerNonce !== this.ownerNonce) {
      return 'not-owner';
    }
    const record: LeaseWriteInput = {
      ownerNonce: this.ownerNonce,
      pid: this.pid,
      ...(this.windowId === undefined ? {} : { windowId: this.windowId }),
      claimedAt: observation.read.record.claimedAt,
      heartbeatAt: now,
      releaseReason: null,
      appVersion: this.appVersion,
      instancesFingerprint: this.instancesFingerprint,
    };
    const attempts = Math.max(1, options.attempts ?? LEASE_HEARTBEAT_WRITE_ATTEMPTS);
    return this.writeLeaseWithRetry(record, attempts);
  }

  /** One immediate `wx` attempt; no stale handling, no retries (§4.2.2). */
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
    // We own the file now. Filling it in is best-effort: an empty lease is
    // stale by construction, so the worst case is that another window takes it
    // over 35 s later — never that a live holder goes unnoticed (§8).
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
    try {
      await this.writeLeaseWithRetry(record, LEASE_HEARTBEAT_WRITE_ATTEMPTS);
      // §4.2.5: a `.part` left by a crashed write can be cleared on takeover,
      // now that this window is the one writing that name.
      await this.clearStalePart(now);
    } catch {
      // Keep the claim: the empty file still excludes others via `wx`.
    }
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
   * `now` is passed in, and the caller enforces the H debounce and the
   * anti-storm backoff before calling; this method only writes.
   */
  async writeClaimRequest(
    now: number,
    options: { focused: boolean; ownPid?: number } = { focused: true },
  ): Promise<ClaimRequest> {
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
    return request;
  }

  /** The token of the request file this store last wrote, for ownership checks. */
  get lastClaimRequestToken(): string | undefined {
    return this.claimRequestToken;
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
