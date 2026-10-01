import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { LEASE_RECORD_VERSION } from '../lease/leaseConstants';
import type { LeaseDecisionInput, OwnWindowState } from '../lease/leaseDecision';
import { LeaseStore, type LeaseStoreOptions } from '../lease/leaseStore';
import type { ClaimRequest, ClaimRequestObservation, LeaseRecord } from '../lease/leaseTypes';
import { tempDirRemovalOptions } from './tempDir';

/**
 * Helpers shared by the lease tests. Not a `.test.ts` file, so the extension
 * vitest config does not pick it up as a suite.
 */

/** A fresh real directory per test, so two "windows" can share one profile. */
export async function makeTempDir(prefix = 'lease-test-'): Promise<string> {
  return fs.promises.mkdtemp(path.join(os.tmpdir(), prefix));
}

export async function removeTempDir(dir: string): Promise<void> {
  // Best-effort stays: a lease test that deliberately holds a handle open is
  // asserting about the lease, not about cleanup. The shared options retry the
  // EPERM/EBUSY a handle under the tree produces on Windows before giving up.
  await fs.promises.rm(dir, tempDirRemovalOptions).catch(() => undefined);
}

/** A complete lease record with sensible defaults, so a test states only what it means. */
export function makeLease(overrides: Partial<LeaseRecord> = {}): LeaseRecord {
  return {
    version: LEASE_RECORD_VERSION,
    ownerNonce: 'aaaa1111bbbb2222',
    pid: process.pid,
    claimedAt: 1_000,
    heartbeatAt: 1_000,
    releaseReason: null,
    appVersion: '0.0.1',
    instancesFingerprint: 'fp',
    ...overrides,
  };
}

export function makeClaimRequestObservation(
  request: Partial<ClaimRequest> = {},
  overrides: Partial<Omit<ClaimRequestObservation, 'request'>> = {},
): ClaimRequestObservation {
  return {
    request: {
      version: LEASE_RECORD_VERSION,
      pid: 4242,
      focused: true,
      at: 10_000,
      ...request,
    },
    mtimeMs: 10_000,
    token: 'feedc0de',
    fileName: 'mcp-leader-lease.json.claim.4242.feedc0de',
    ...overrides,
  };
}

export function makeWindow(overrides: Partial<OwnWindowState> = {}): OwnWindowState {
  return { ownerNonce: 'self-nonce', pid: 111, focused: true, ...overrides };
}

/** A decision input with every field defaulted; each test overrides one thing. */
export function makeInput(overrides: Partial<LeaseDecisionInput> = {}): LeaseDecisionInput {
  const base: LeaseDecisionInput = {
    now: 10_000,
    own: makeWindow(),
    lease: { leasePathReadable: true, lease: { kind: 'missing' }, claimRequests: [], ownRecordUnpublished: false },
    holderPidAlive: undefined,
    ownerHealth: { consecutiveFailures: 0 },
    ownClaimRequest: { consecutiveUnansweredRequests: 0 },
  };
  return { ...base, ...overrides };
}

/** A store for a temp directory, with an immediately-resolving retry delay. */
export function makeStore(directory: string, overrides: Partial<LeaseStoreOptions> = {}): LeaseStore {
  return new LeaseStore({
    ownerNonce: 'store-nonce-a',
    pid: process.pid,
    appVersion: '0.0.1',
    instancesFingerprint: 'fp',
    delay: async () => undefined,
    ...overrides,
    directory,
  });
}

/** Write raw bytes to a path, for the malformed-file cases. */
export async function writeRaw(filePath: string, content: string): Promise<void> {
  await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
  await fs.promises.writeFile(filePath, content, 'utf8');
}

/** An error with a `code`, the shape Node's fs errors have. */
export function fsError(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`${code}: simulated failure`), { code });
}
