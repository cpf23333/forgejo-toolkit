/**
 * The payload behind `forgejoToolkit.copyPollingDiagnostics` (§11.1 stage 2).
 *
 * This command is not a convenience: the extension has no telemetry and no
 * error reporting (§2.1), so the JSON it puts on the clipboard is the *only*
 * way a maintainer learns why the polling lease misbehaved on a user's
 * machine. The field list below is therefore a contract, not a summary, and
 * two rules in it are hard constraints:
 *
 * - **No credential ever appears**: no access token, no `Authorization` header,
 *   no value from the editor's secret storage — and no "has a token" boolean
 *   either, because "token exists: false" is still an assertion about secrets
 *   and buys no diagnosis. Instance URLs *are* included (they are the user's
 *   own configuration and the only coordinate that identifies which instance a
 *   row is about), but only after the existing `redactInstanceUrl` rule has
 *   removed any userinfo the URL carries.
 * - **The raw lease text is never included** (`rawTextIncluded` is a constant
 *   `false`): a hand-edited file could hold anything, and the whole diagnostics
 *   dump would then be a channel for it. What is included is the *validated*
 *   record, whose schema is pinned by `leaseGuards.test.ts`.
 *
 * Everything here is a pure function of its inputs, so the shape can be tested
 * without an editor, a lease file or a clipboard.
 */

import { redactInstanceUrl } from '../api/versionProbe';
import type { ServerVersionSource } from '../api/serverVersion';
import { LEASE_EXPIRY_MS } from './leaseConstants';
import { isPidAlive } from './leaseStore';
import type { ClaimRequestObservation, LeaseHandoverRecord, LeaseRead } from './leaseTypes';

/** The schema version this build emits. A reader pins on it (§11.1 stage 2). */
export const POLLING_DIAGNOSTICS_SCHEMA_VERSION = 1;

/** The role names every diagnostics surface uses (logs and this JSON). */
export type PollingDiagnosticsRole = 'leader' | 'follower' | 'degraded';

/**
 * One window of the `visibleWindows` list: "who is polling", as far as *this*
 * window can see it.
 *
 * The name is deliberate (§11.1 stage 2 follow-up). The list is assembled from
 * the lease record, this window's own state and the claim-request files on
 * disk, so a quiet follower — a window that is not the holder and has not
 * asked for the lease — leaves no trace on disk and is invisible here. The
 * field used to be called `allWindows`, which read as a registry of every
 * window in the profile; there is no such registry at this stage, and a
 * payload that implies one sends a reader looking for rows that were never
 * there. What it does answer reliably is "which window is polling, and who
 * else is competing for it".
 */
export interface PollingDiagnosticsWindowRow {
  pid: number;
  role: PollingDiagnosticsRole;
  /** The first 8 characters of that window's nonce; `null` when not knowable. */
  ownerNoncePrefix: string | null;
  /** `null` for a window whose focus state this window cannot see. */
  focused: boolean | null;
  isSelf: boolean;
  /** When that pid was last seen: the lease heartbeat, the request time, or now. */
  lastSeenAt: number;
  /** `process.kill(pid, 0)`, `EPERM` counted as alive (§3.5). */
  alive: boolean;
}

/** The lease file as this window sees it, with the record's own fields expanded. */
export interface PollingDiagnosticsLease {
  path: string;
  pathIsAbsolute: boolean;
  writable: boolean;
  probeError: string | null;
  exists: boolean;
  parsed: {
    version: number;
    pid: number;
    ownerNoncePrefix: string;
    windowId: string | null;
    claimedAt: number;
    heartbeatAt: number;
    heartbeatAgeMs: number;
    expiresInMs: number;
    containsTokenField: boolean;
    appVersion: string;
    instancesFingerprint: string;
    releaseReason: string | null;
  } | null;
  /** `malformed` / `unreadable` when the file could not be used, else `null`. */
  rawParseError: string | null;
  /** Always `false`: the raw file text is never part of a diagnostics dump. */
  rawTextIncluded: false;
  claimRequestFiles: { name: string; mtimeMs: number }[];
}

/**
 * One instance's server version, as far as this window can see it.
 *
 * `source` is what answers "why is this feature offered, or refused, for this
 * instance" from a bug report: `declared` when the user stated the version on
 * the instance record (the escape hatch for a probe that sees the wrong answer
 * or none), `probed` when the automatic probe answered, `unknown` when neither
 * did. `version` is the value those gates use, except in one case, documented
 * with `stale` below.
 *
 * `declaredVersion` carries the instance record's declared string verbatim,
 * whether or not it parses, so a declaration that is being ignored is visible as
 * such. It is `null` when the instance declares nothing.
 *
 * `probedAt` is when the shared cache entry the row's value was read from was
 * written, and `stale` is whether that entry is past its TTL. Both are `null`
 * when the row's value did not come from the shared cache: a value that exists
 * only in this process's memory has no write time and no TTL, and a declared
 * value does not come from the cache at all. When the gates have no value but
 * the cache still holds one (`stale: true`, nothing renewed it), the row reports
 * that entry's own value so a reader can see what the probe found — the value is
 * then *not* what the gates use, and `source` is `unknown`.
 */
export interface PollingDiagnosticsVersionRow {
  instanceId: string;
  url: string;
  version: string | null;
  source: ServerVersionSource;
  declaredVersion: string | null;
  probedAt: number | null;
  stale: boolean | null;
}

export interface PollingDiagnostics {
  schemaVersion: number;
  generatedAt: number;
  window: {
    role: PollingDiagnosticsRole;
    focused: boolean;
    pid: number;
    ownerNoncePrefix: string;
    sessionId: string | null;
    workspaceName: string | null;
    workspaceFolders: string[];
    extensionHostStartedAt: number;
    lastHeartbeatWrittenAt: number | null;
    consecutiveHeartbeatFailures: number;
  };
  /**
   * Every window this one can see, itself first: the current holder from the
   * lease record and every pid with a claim request on disk. **Not** a
   * registry — a quiet follower is invisible here (see
   * `PollingDiagnosticsWindowRow`).
   */
  visibleWindows: PollingDiagnosticsWindowRow[];
  lease: PollingDiagnosticsLease;
  handover: LeaseHandoverRecord | null;
  polling: {
    enabled: boolean;
    intervalSeconds: number;
    leaseEnabled: boolean;
    /** True while this window polls because the mechanism is unavailable (§8). */
    degraded: boolean;
    degradedReason: string | null;
    degradedSince: number | null;
    noticeShown: boolean;
    lastSuccessfulPollAt: number | null;
    nextScheduledPollAt: number | null;
  };
  versions: {
    /** The shared probe cache of §9 route 2, one row per configured instance. */
    probeCache: PollingDiagnosticsVersionRow[];
    /**
     * Whether that cache lives beside the instance configuration, which is the
     * §9 route 2 decision: `globalState`, in a key next to the instance list, so
     * every window reads the same records and a follower's gate no longer stops
     * at "unknown". Reported as observed rather than as intended — the command
     * that assembles the payload reads the same cache the gates do.
     */
    followsInstanceConfig: boolean;
  };
  env: {
    extensionVersion: string;
    vscodeVersion: string;
    os: string;
    arch: string;
    osRelease: string;
    locale: string;
    remoteName: string | null;
  };
}

/** Everything the builder needs; every field is already-read plain data. */
export interface PollingDiagnosticsInput {
  now: number;
  window: {
    role: PollingDiagnosticsRole;
    focused: boolean;
    pid: number;
    ownerNonce: string;
    sessionId?: string | undefined;
    workspaceName?: string | undefined;
    workspaceFolders?: readonly string[] | undefined;
    extensionHostStartedAt: number;
    lastHeartbeatWrittenAt?: number | undefined;
    consecutiveHeartbeatFailures: number;
  };
  lease: {
    path: string;
    exists: boolean;
    writable: boolean;
    probeError?: string | undefined;
    read: LeaseRead;
    claimRequests: readonly ClaimRequestObservation[];
    /** Every `<lease>.claim.*` entry, parsed or not (§3.2's identity rule). */
    claimRequestFiles: readonly { name: string; mtimeMs: number }[];
    holderAlive?: boolean | undefined;
  };
  handover: LeaseHandoverRecord | null;
  polling: {
    enabled: boolean;
    intervalSeconds: number;
    leaseEnabled: boolean;
    degraded: boolean;
    degradedReason?: string | undefined;
    degradedSince?: number | undefined;
    noticeShown: boolean;
    lastSuccessfulPollAt?: number | undefined;
    nextScheduledPollAt?: number | undefined;
  };
  versions: {
    instances: readonly {
      id: string;
      url: string;
      version?: string | undefined;
      /**
       * Where the version the gates use came from, as the caller's resolution
       * reported it. Absent in the older shape, where a row only said what the
       * shared cache held.
       */
      source?: ServerVersionSource | undefined;
      /** The instance record's declared string, verbatim, when it has one. */
      declaredVersion?: string | undefined;
      /**
       * When the shared cache entry was written (§9 route 2). `null` or absent
       * for a value this window only holds in memory, and for a declared value.
       */
      probedAt?: number | null | undefined;
      /** Whether that entry is past its TTL; `null` when there is no shared entry. */
      stale?: boolean | null | undefined;
    }[];
    followsInstanceConfig: boolean;
  };
  env: {
    extensionVersion: string;
    vscodeVersion: string;
    os: string;
    arch: string;
    osRelease: string;
    locale: string;
    remoteName?: string | undefined;
  };
}

/** The prefixes used by the lease file's nonce in logs and diagnostics (§7.1). */
function prefixOf(nonce: string): string {
  return nonce.slice(0, 8);
}

/**
 * True when a record carries a field name that looks like a credential.
 *
 * This is the payload's self-check (`containsTokenField`): the lease schema has
 * no such field by construction (§3.2), and the value is computed rather than
 * hard-coded so a future field added here cannot quietly become one. Only
 * *keys* are inspected; no value is ever echoed.
 */
export function containsCredentialField(record: object): boolean {
  return Object.keys(record).some((key) => /token|authorization|secret|password|credential/i.test(key));
}

/**
 * Builds the clipboard payload. Pure: no clock, no editor, no file reads — the
 * caller has already read everything (`LeaseStore.inspect`, `window.state`,
 * the config), so a test can assert the whole shape from literals.
 */
export function buildPollingDiagnostics(input: PollingDiagnosticsInput): PollingDiagnostics {
  const { now, window: own, lease, polling } = input;
  const record = lease.read.kind === 'ok' ? lease.read.record : undefined;

  const visibleWindows: PollingDiagnosticsWindowRow[] = [];
  const seen = new Set<string>();
  const rowKey = (pid: number, noncePrefix: string | null): string => `${pid}:${noncePrefix ?? ''}`;

  const pushRow = (row: PollingDiagnosticsWindowRow): void => {
    const key = rowKey(row.pid, row.ownerNoncePrefix);
    if (seen.has(key)) {
      return;
    }
    seen.add(key);
    visibleWindows.push(row);
  };

  // This window first: it is the only row whose focus state is a direct read.
  pushRow({
    pid: own.pid,
    role: own.role,
    ownerNoncePrefix: prefixOf(own.ownerNonce),
    focused: own.focused,
    isSelf: true,
    lastSeenAt: own.lastHeartbeatWrittenAt ?? now,
    alive: true,
  });

  // The current holder, when it is somebody else. `focused` comes from a
  // pending request by the same pid if there is one — there is no cross-window
  // focus API — and stays `null` when nothing on disk says.
  if (record !== undefined && record.ownerNonce !== own.ownerNonce) {
    const request = lease.claimRequests.find((observation) => observation.request.pid === record.pid);
    pushRow({
      pid: record.pid,
      role: 'leader',
      ownerNoncePrefix: prefixOf(record.ownerNonce),
      focused: request?.request.focused ?? null,
      isSelf: false,
      lastSeenAt: record.heartbeatAt,
      alive: lease.holderAlive ?? isPidAlive(record.pid),
    });
  }

  // Every requester on disk is a window that wants the lease: a follower.
  for (const observation of lease.claimRequests) {
    pushRow({
      pid: observation.request.pid,
      role: 'follower',
      ownerNoncePrefix: null,
      focused: observation.request.focused,
      isSelf: observation.request.pid === own.pid,
      lastSeenAt: observation.request.at,
      alive: isPidAlive(observation.request.pid),
    });
  }

  return {
    schemaVersion: POLLING_DIAGNOSTICS_SCHEMA_VERSION,
    generatedAt: now,
    window: {
      role: own.role,
      focused: own.focused,
      pid: own.pid,
      ownerNoncePrefix: prefixOf(own.ownerNonce),
      sessionId: own.sessionId ?? null,
      workspaceName: own.workspaceName ?? null,
      workspaceFolders: [...(own.workspaceFolders ?? [])],
      extensionHostStartedAt: own.extensionHostStartedAt,
      lastHeartbeatWrittenAt: own.lastHeartbeatWrittenAt ?? null,
      consecutiveHeartbeatFailures: own.consecutiveHeartbeatFailures,
    },
    visibleWindows,
    lease: {
      path: lease.path,
      pathIsAbsolute: /^([a-zA-Z]:[\\/]|[\\/]{1,2})/.test(lease.path),
      writable: lease.writable,
      probeError: lease.probeError ?? null,
      exists: lease.exists,
      parsed:
        record === undefined
          ? null
          : {
              version: record.version,
              pid: record.pid,
              ownerNoncePrefix: prefixOf(record.ownerNonce),
              windowId: record.windowId ?? null,
              claimedAt: record.claimedAt,
              heartbeatAt: record.heartbeatAt,
              // Negative ages are reported as they are: they are the clock
              // rollback evidence §6 asks a reader to be able to see.
              heartbeatAgeMs: now - record.heartbeatAt,
              expiresInMs: LEASE_EXPIRY_MS - (now - record.heartbeatAt),
              containsTokenField: containsCredentialField(record),
              appVersion: record.appVersion,
              instancesFingerprint: record.instancesFingerprint,
              releaseReason: record.releaseReason,
            },
      rawParseError: lease.read.kind === 'invalid' ? lease.read.reason : null,
      rawTextIncluded: false,
      claimRequestFiles: lease.claimRequestFiles.map((file) => ({ name: file.name, mtimeMs: file.mtimeMs })),
    },
    handover: input.handover,
    polling: {
      enabled: polling.enabled,
      intervalSeconds: polling.intervalSeconds,
      leaseEnabled: polling.leaseEnabled,
      degraded: polling.degraded,
      degradedReason: polling.degradedReason ?? null,
      degradedSince: polling.degradedSince ?? null,
      noticeShown: polling.noticeShown,
      lastSuccessfulPollAt: polling.lastSuccessfulPollAt ?? null,
      nextScheduledPollAt: polling.nextScheduledPollAt ?? null,
    },
    versions: {
      probeCache: input.versions.instances.map((instance) => ({
        instanceId: instance.id,
        // The URL a human needs to recognise the instance, with any userinfo
        // removed by the same rule the log lines use.
        url: redactInstanceUrl(instance.url),
        version: instance.version ?? null,
        // Where that value came from — declared versus probed — which is what
        // tells a reader whether the gates are honouring the user's own
        // statement or the probe's answer (see PollingDiagnosticsVersionRow).
        // A row from the older shape, which only said what the cache held, has
        // no source: a version it does carry is a probe result by construction.
        source: instance.source ?? (instance.version === undefined ? 'unknown' : 'probed'),
        declaredVersion: instance.declaredVersion ?? null,
        // The shared cache's write time and TTL verdict (§9 route 2). Both are
        // `null` for the process-local fallback, which has neither, and for a
        // declared value, which is not read from the cache.
        probedAt: instance.probedAt ?? null,
        stale: instance.stale ?? null,
      })),
      followsInstanceConfig: input.versions.followsInstanceConfig,
    },
    env: {
      extensionVersion: input.env.extensionVersion,
      vscodeVersion: input.env.vscodeVersion,
      os: input.env.os,
      arch: input.env.arch,
      osRelease: input.env.osRelease,
      locale: input.env.locale,
      remoteName: input.env.remoteName ?? null,
    },
  };
}
