import { describe, expect, it } from 'vitest';
import { spawnSync } from 'child_process';
import { LEASE_EXPIRY_MS, LEASE_RECORD_VERSION } from '../lease/leaseConstants';
import {
  POLLING_DIAGNOSTICS_SCHEMA_VERSION,
  buildPollingDiagnostics,
  containsCredentialField,
  type PollingDiagnosticsInput,
} from '../lease/pollingDiagnostics';
import type { ClaimRequestObservation, LeaseRecord } from '../lease/leaseTypes';

/**
 * The diagnostics payload (§11.1 stage 2), which is the extension's only data
 * exit: with no telemetry, this JSON is what a bug report carries. Two things
 * are therefore tested as hard requirements rather than conveniences — the
 * field list is the contract, and no credential may appear anywhere in it.
 */

const NOW = 1_000_000;

/** A pid the OS has already reaped, so the liveness column is deterministic. */
const DEAD_PID = spawnSync(process.execPath, ['-e', 'process.exit(0)']).pid as number;

function record(overrides: Partial<LeaseRecord> = {}): LeaseRecord {
  return {
    version: LEASE_RECORD_VERSION,
    ownerNonce: 'foreign-nonce-12345678',
    pid: 4242,
    claimedAt: NOW - 60_000,
    heartbeatAt: NOW - 5_000,
    releaseReason: null,
    appVersion: '0.0.1',
    instancesFingerprint: 'abc123abc123abcd',
    ...overrides,
  };
}

function request(overrides: Partial<ClaimRequestObservation['request']> = {}): ClaimRequestObservation {
  return {
    request: { version: LEASE_RECORD_VERSION, pid: DEAD_PID, focused: true, at: NOW - 1_000, ...overrides },
    mtimeMs: NOW - 1_000,
    token: 'feedc0de',
    fileName: `mcp-leader-lease.json.claim.${DEAD_PID}.feedc0de`,
  };
}

function input(overrides: Partial<PollingDiagnosticsInput> = {}): PollingDiagnosticsInput {
  return {
    now: NOW,
    window: {
      role: 'follower',
      focused: false,
      pid: 111,
      ownerNonce: 'self-nonce-abcdef01',
      sessionId: 'session-1',
      workspaceName: 'forgejo-toolkit',
      workspaceFolders: ['forgejo-toolkit'],
      extensionHostStartedAt: NOW - 30_000,
      lastHeartbeatWrittenAt: NOW - 20_000,
      consecutiveHeartbeatFailures: 0,
    },
    lease: {
      path: '/home/user/.config/Code/User/globalStorage/cpf23333.forgejo-toolkit/mcp-leader-lease.json',
      exists: true,
      writable: true,
      read: { kind: 'ok', record: record() },
      claimRequests: [request()],
      claimRequestFiles: [
        { name: `mcp-leader-lease.json.claim.${DEAD_PID}.feedc0de`, mtimeMs: NOW - 1_000 },
        { name: 'mcp-leader-lease.json.claim.4242.broken', mtimeMs: NOW - 2_000 },
      ],
      holderAlive: true,
    },
    handover: null,
    polling: {
      enabled: true,
      intervalSeconds: 300,
      leaseEnabled: true,
      degraded: true,
      degradedReason: 'lease-unavailable',
      degradedSince: NOW - 10_000,
      noticeShown: true,
      lastSuccessfulPollAt: NOW - 1_000,
      nextScheduledPollAt: NOW + 299_000,
    },
    versions: {
      instances: [
        {
          id: 'instance-1',
          url: 'https://forgejo.example.com',
          version: '16.0.1',
          probedAt: NOW - 30_000,
          stale: false,
        },
      ],
      followsInstanceConfig: true,
    },
    env: {
      extensionVersion: '0.0.1',
      vscodeVersion: '1.139.0',
      os: 'win32',
      arch: 'x64',
      osRelease: '10.0.26200',
      locale: 'en',
      remoteName: undefined,
    },
    ...overrides,
  };
}

describe('the polling diagnostics payload (§11.1 stage 2)', () => {
  it('carries the authoritative field list and survives a JSON round trip', () => {
    const payload = buildPollingDiagnostics(input());

    expect(payload.schemaVersion).toBe(POLLING_DIAGNOSTICS_SCHEMA_VERSION);
    expect(Object.keys(payload).sort()).toEqual([
      'env',
      'generatedAt',
      'handover',
      'lease',
      'polling',
      'schemaVersion',
      'versions',
      'visibleWindows',
      'window',
    ]);
    expect(Object.keys(payload.window).sort()).toEqual([
      'consecutiveHeartbeatFailures',
      'extensionHostStartedAt',
      'focused',
      'lastHeartbeatWrittenAt',
      'ownerNoncePrefix',
      'pid',
      'role',
      'sessionId',
      'workspaceFolders',
      'workspaceName',
    ]);
    expect(Object.keys(payload.lease).sort()).toEqual([
      'claimRequestFiles',
      'exists',
      'parsed',
      'path',
      'pathIsAbsolute',
      'probeError',
      'rawParseError',
      'rawTextIncluded',
      'writable',
    ]);
    expect(Object.keys(payload.lease.parsed ?? {}).sort()).toEqual([
      'appVersion',
      'claimedAt',
      'containsTokenField',
      'expiresInMs',
      'heartbeatAgeMs',
      'heartbeatAt',
      'instancesFingerprint',
      'ownerNoncePrefix',
      'pid',
      'releaseReason',
      'version',
      'windowId',
    ]);
    expect(Object.keys(payload.polling).sort()).toEqual([
      'degraded',
      'degradedReason',
      'degradedSince',
      'enabled',
      'intervalSeconds',
      'lastSuccessfulPollAt',
      'leaseEnabled',
      'nextScheduledPollAt',
      'noticeShown',
    ]);
    expect(Object.keys(payload.versions).sort()).toEqual(['followsInstanceConfig', 'probeCache']);
    expect(Object.keys(payload.env).sort()).toEqual([
      'arch',
      'extensionVersion',
      'locale',
      'os',
      'osRelease',
      'remoteName',
      'vscodeVersion',
    ]);

    const json = JSON.stringify(payload, null, 2);
    expect(JSON.parse(json)).toEqual(payload);
    // The self-check that proves the record schema itself carries no secret.
    expect(payload.lease.parsed?.containsTokenField).toBe(false);
    expect(payload.lease.rawTextIncluded).toBe(false);
  });

  it('lists the windows this one can see, itself first, and claims no more than that', () => {
    const payload = buildPollingDiagnostics(input());

    // The row set is exactly: this window, the lease holder, and every pid with
    // a request file. A window that is neither the holder nor competing for the
    // lease appears nowhere — which is why the field is `visibleWindows` and
    // not `allWindows` (there is no registry to list it from at this stage).
    expect(payload.visibleWindows).toEqual([
      {
        pid: 111,
        role: 'follower',
        ownerNoncePrefix: 'self-non',
        focused: false,
        isSelf: true,
        lastSeenAt: NOW - 20_000,
        alive: true,
      },
      {
        pid: 4242,
        role: 'leader',
        ownerNoncePrefix: 'foreign-',
        focused: null,
        isSelf: false,
        lastSeenAt: NOW - 5_000,
        alive: true,
      },
      {
        pid: DEAD_PID,
        role: 'follower',
        ownerNoncePrefix: null,
        focused: true,
        isSelf: false,
        lastSeenAt: NOW - 1_000,
        alive: false,
      },
    ]);
    // The file listing keeps the entries that do not parse: that is the point
    // of reporting names and mtimes instead of the parsed requests.
    expect(payload.lease.claimRequestFiles.map((file) => file.name)).toEqual([
      `mcp-leader-lease.json.claim.${DEAD_PID}.feedc0de`,
      'mcp-leader-lease.json.claim.4242.broken',
    ]);
  });

  it('reports the record age and the time left, including a negative age', () => {
    const payload = buildPollingDiagnostics(
      input({
        lease: {
          path: 'C:\\storage\\mcp-leader-lease.json',
          exists: true,
          writable: false,
          probeError: 'EACCES',
          // A record from the future: the clock rolled back, and the payload
          // must show it rather than clamp it to zero.
          read: { kind: 'ok', record: record({ heartbeatAt: NOW + 4_000 }) },
          claimRequests: [],
          claimRequestFiles: [],
          holderAlive: false,
        },
      }),
    );

    expect(payload.lease.parsed?.heartbeatAgeMs).toBe(-4_000);
    expect(payload.lease.parsed?.expiresInMs).toBe(LEASE_EXPIRY_MS + 4_000);
    expect(payload.lease.pathIsAbsolute).toBe(true);
    expect(payload.lease.probeError).toBe('EACCES');
    expect(payload.lease.writable).toBe(false);
  });

  it('reports a broken record as a parse error and no record, with no raw text', () => {
    const payload = buildPollingDiagnostics(
      input({
        lease: {
          path: '/storage/mcp-leader-lease.json',
          exists: true,
          writable: true,
          read: { kind: 'invalid', reason: 'malformed' },
          claimRequests: [],
          claimRequestFiles: [],
        },
      }),
    );

    expect(payload.lease.parsed).toBeNull();
    expect(payload.lease.rawParseError).toBe('malformed');
    expect(payload.lease.rawTextIncluded).toBe(false);
  });

  it('never carries a token, an authorization header or a raw credential URL', () => {
    const payload = buildPollingDiagnostics(
      input({
        versions: {
          instances: [
            // A token written in the username position, and one in the
            // password position: both are how a credential reaches a
            // configured URL.
            { id: 'a', url: 'https://s3cr3t-token@forgejo.example.com', version: '16.0.1' },
            { id: 'b', url: 'https://alice:s3cr3t-token@forgejo.example.com' },
          ],
          followsInstanceConfig: true,
        },
      }),
    );

    const json = JSON.stringify(payload);
    expect(json).not.toContain('s3cr3t-token');
    // The redaction is the existing `redactInstanceUrl` rule, which also
    // normalizes the URL (hence the trailing slash on a bare host).
    expect(payload.versions.probeCache[0]?.url).toBe('https://***@forgejo.example.com/');
    expect(payload.versions.probeCache[1]?.url).toBe('https://alice:***@forgejo.example.com/');
    // No "does a token exist" boolean either: the design forbids it outright.
    expect(json).not.toMatch(/tokenPresent|tokenExists|hasToken/i);
    // The only occurrence of the word is the documented self-check field name.
    expect(json.match(/token/gi)?.length).toBe(1);
  });

  it('reads a credential-shaped field name out of a record, so the self-check is real', () => {
    expect(containsCredentialField(record())).toBe(false);
    expect(containsCredentialField({ ...record(), token: '' })).toBe(true);
    expect(containsCredentialField({ ...record(), Authorization: 'x' })).toBe(true);
    expect(containsCredentialField({ ...record(), password: 'x' })).toBe(true);
  });

  it('reports the shared probe cache’s write time and staleness (§9 route 2)', () => {
    // The rows come from the cache that lives beside the instance
    // configuration, so a follower window reports what another window probed —
    // including the case where that record has expired and may no longer gate.
    const payload = buildPollingDiagnostics(
      input({
        versions: {
          instances: [
            { id: 'fresh', url: 'https://fresh.example.com', version: '16.0.1', probedAt: NOW - 1_000, stale: false },
            {
              id: 'expired',
              url: 'https://expired.example.com',
              version: '15.0.0',
              probedAt: NOW - 90_000,
              stale: true,
            },
            // No shared entry: the value this window holds in memory alone has
            // no write time and no TTL, so both stay null rather than invented.
            { id: 'local', url: 'https://local.example.com', version: '17.0.0' },
            { id: 'unknown', url: 'https://unknown.example.com' },
          ],
          followsInstanceConfig: true,
        },
      }),
    );

    expect(payload.versions.followsInstanceConfig).toBe(true);
    expect(payload.versions.probeCache).toEqual([
      {
        instanceId: 'fresh',
        url: 'https://fresh.example.com',
        version: '16.0.1',
        // No source in the input: a row that carries a version but does not say
        // where it came from is the older shape, and its value is a probe result.
        source: 'probed',
        declaredVersion: null,
        probedAt: NOW - 1_000,
        stale: false,
      },
      {
        instanceId: 'expired',
        url: 'https://expired.example.com',
        version: '15.0.0',
        source: 'probed',
        declaredVersion: null,
        probedAt: NOW - 90_000,
        stale: true,
      },
      {
        instanceId: 'local',
        url: 'https://local.example.com',
        version: '17.0.0',
        source: 'probed',
        declaredVersion: null,
        probedAt: null,
        stale: null,
      },
      {
        instanceId: 'unknown',
        url: 'https://unknown.example.com',
        version: null,
        source: 'unknown',
        declaredVersion: null,
        probedAt: null,
        stale: null,
      },
    ]);
  });

  it('says whether the value came from the user’s declaration or from a probe', () => {
    // The question a bug report actually asks: "why is this feature offered (or
    // refused) for this instance?" — answered by the source and the declared
    // string, next to the value the gates used.
    const payload = buildPollingDiagnostics(
      input({
        versions: {
          instances: [
            {
              id: 'declared',
              url: 'https://declared.example.com',
              version: '1.18.0',
              source: 'declared',
              declaredVersion: '1.18.0',
            },
            // A hand-edited record: the declaration is reported verbatim so it
            // is visible, while `source`/`version` show it is not being used.
            {
              id: 'ignored',
              url: 'https://ignored.example.com',
              source: 'unknown',
              declaredVersion: 'not-a-version',
            },
          ],
          followsInstanceConfig: true,
        },
      }),
    );

    expect(payload.versions.probeCache).toEqual([
      {
        instanceId: 'declared',
        url: 'https://declared.example.com',
        version: '1.18.0',
        source: 'declared',
        declaredVersion: '1.18.0',
        probedAt: null,
        stale: null,
      },
      {
        instanceId: 'ignored',
        url: 'https://ignored.example.com',
        version: null,
        source: 'unknown',
        declaredVersion: 'not-a-version',
        probedAt: null,
        stale: null,
      },
    ]);
  });

  it('passes the handover, the polling state and the environment through unchanged', () => {
    const handover = {
      direction: 'takeover' as const,
      reason: 'focus' as const,
      at: NOW,
      latencyMs: 1_200,
      latencyUnknown: null,
      counterpartPid: 4242,
      requestCount: 2,
    };
    const payload = buildPollingDiagnostics(
      input({
        handover,
        env: {
          extensionVersion: '1.2.3',
          vscodeVersion: '1.139.0',
          os: 'linux',
          arch: 'arm64',
          osRelease: '6.8.0',
          locale: 'zh-cn',
          remoteName: 'wsl',
        },
      }),
    );

    expect(payload.handover).toEqual(handover);
    expect(payload.polling).toEqual({
      enabled: true,
      intervalSeconds: 300,
      leaseEnabled: true,
      degraded: true,
      degradedReason: 'lease-unavailable',
      degradedSince: NOW - 10_000,
      noticeShown: true,
      lastSuccessfulPollAt: NOW - 1_000,
      nextScheduledPollAt: NOW + 299_000,
    });
    expect(payload.env).toEqual({
      extensionVersion: '1.2.3',
      vscodeVersion: '1.139.0',
      os: 'linux',
      arch: 'arm64',
      osRelease: '6.8.0',
      locale: 'zh-cn',
      remoteName: 'wsl',
    });
  });
});
