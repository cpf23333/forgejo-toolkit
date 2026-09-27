import * as os from 'os';
import * as vscode from 'vscode';
import { userFacingErrorMessage } from '../api/errors';
import { getServerVersion } from '../api/serverVersion';
import type { ConfigManager } from '../config';
import { COPY_POLLING_DIAGNOSTICS_COMMAND } from '../lease/leaseDegradedNotice';
import { buildPollingDiagnostics, type PollingDiagnostics } from '../lease/pollingDiagnostics';
import { isMultiWindowLeaseEnabled, type LeaseSupervisor } from '../lease/leaseSupervisor';
import { logger, showErrorWithLog } from '../logger';

/**
 * `forgejoToolkit.copyPollingDiagnostics` (§7.1, §11.1 stage 2).
 *
 * It copies a redacted JSON report of this window's polling and lease state to
 * the clipboard and prints it (with a one-line summary) to the output channel,
 * which is also what answers §7.1's "which window is polling, and when did it
 * last change hands" through the existing **View Log** command. With no
 * telemetry in this extension, that report is the only evidence a maintainer
 * can get from a user's machine, so the field list is a contract: see
 * `src/lease/pollingDiagnostics.ts`, which is where the schema and the
 * redaction rules live. This module only supplies the live values and the two
 * effects (clipboard, message); it never assembles fields itself, so the
 * "no token, no secret, no raw lease text" rule has exactly one implementation.
 */

/** Everything the command reads. All of it is live, so no value can go stale. */
export interface PollingDiagnosticsCommandSources {
  /** The live supervisor, or `undefined` when the lease never started. */
  lease: () => LeaseSupervisor | undefined;
  /** The settings and instance list the `polling`/`versions` groups describe. */
  config: Pick<ConfigManager, 'getInstances' | 'isNotificationPollingEnabled' | 'getNotificationPollingInterval'>;
  /** The poller's own timing, for `polling.lastSuccessfulPollAt`/`nextScheduledPollAt`. */
  pollingTiming: () => { lastSuccessfulPollAt?: number; nextScheduledPollAt?: number };
  /** `context.extension.packageJSON.version`. */
  extensionVersion: string;
  /** `context.globalStorageUri.fsPath`, when the host exposes one. */
  globalStoragePath?: string;
  /** `Date.now()` at activation, so the report can show how long the host has run. */
  extensionHostStartedAt: number;
}

/**
 * The one-line summary a `showLog` reader sees before the JSON: §7.1 asks for
 * "which window is polling" and "the last handover's reason and duration", and
 * both are unreadable inside a wall of JSON.
 */
export function formatPollingLeaderSummary(diagnostics: PollingDiagnostics): string {
  const { window: own, lease, handover } = diagnostics;
  const holder =
    lease.parsed === null
      ? 'none'
      : `pid=${lease.parsed.pid} nonce=${lease.parsed.ownerNoncePrefix} heartbeatAgeMs=${lease.parsed.heartbeatAgeMs}`;
  const last =
    handover === null
      ? 'none'
      : `${handover.direction}/${handover.reason} at=${handover.at} latencyMs=${
          handover.latencyMs ?? `unknown(${handover.latencyUnknown ?? 'unspecified'})`
        } counterpart=${handover.counterpartPid ?? 'unknown'} requests=${handover.requestCount}`;
  return `polling lease: role=${own.role} thisWindowPid=${own.pid} nonce=${own.ownerNoncePrefix} holder=${holder} lastHandover=${last}`;
}

/**
 * Registers the command. Follows the other host-command handlers: the whole
 * body is wrapped, and a failure surfaces a localized message with a **View
 * Log** action instead of an unhandled rejection.
 */
export function registerCopyPollingDiagnosticsCommand(
  context: vscode.ExtensionContext,
  sources: PollingDiagnosticsCommandSources,
): void {
  context.subscriptions.push(
    vscode.commands.registerCommand(COPY_POLLING_DIAGNOSTICS_COMMAND, async () => {
      try {
        const diagnostics = await collectPollingDiagnostics(sources);
        const json = JSON.stringify(diagnostics, null, 2);
        await vscode.env.clipboard.writeText(json);
        logger.info(`[copyPollingDiagnostics] ${formatPollingLeaderSummary(diagnostics)}`);
        logger.info(`[copyPollingDiagnostics] payload:\n${json}`);
        void vscode.window.showInformationMessage(vscode.l10n.t('Polling diagnostics copied to the clipboard'));
      } catch (error) {
        const err = userFacingErrorMessage(error);
        logger.error(`[copyPollingDiagnostics] ${err}`);
        void showErrorWithLog(vscode.l10n.t('Failed to copy polling diagnostics: {0}', err));
      }
    }),
  );
}

/** Assembles the payload from the live objects. Exported for the tests. */
export async function collectPollingDiagnostics(
  sources: PollingDiagnosticsCommandSources,
): Promise<PollingDiagnostics> {
  const supervisor = sources.lease();
  const snapshot = supervisor?.snapshot();
  const inspection = supervisor === undefined ? undefined : await supervisor.inspect();
  const timing = sources.pollingTiming();
  const now = Date.now();
  const instances = sources.config.getInstances();

  return buildPollingDiagnostics({
    now,
    window: {
      role: snapshot?.role ?? 'degraded',
      focused: snapshot?.focused ?? vscode.window.state.focused,
      pid: snapshot?.pid ?? process.pid,
      ownerNonce: snapshot?.ownerNonce ?? '',
      sessionId: vscode.env.sessionId,
      workspaceName: vscode.workspace.name,
      workspaceFolders: vscode.workspace.workspaceFolders?.map((folder) => folder.name) ?? [],
      extensionHostStartedAt: snapshot?.extensionHostStartedAt ?? sources.extensionHostStartedAt,
      lastHeartbeatWrittenAt: snapshot?.lastHeartbeatWrittenAt,
      consecutiveHeartbeatFailures: snapshot?.consecutiveHeartbeatFailures ?? 0,
    },
    lease: {
      path: inspection?.leasePath ?? sources.globalStoragePath ?? '',
      exists: inspection?.exists ?? false,
      writable: inspection?.writable ?? false,
      probeError: inspection?.writableErrorCode,
      read: inspection?.read ?? { kind: 'missing' },
      claimRequests: inspection?.claimRequests ?? [],
      claimRequestFiles: inspection?.claimRequestFiles ?? [],
      holderAlive: inspection?.holderAlive,
    },
    handover: snapshot?.handover ?? null,
    polling: {
      enabled: sources.config.isNotificationPollingEnabled(),
      intervalSeconds: sources.config.getNotificationPollingInterval(),
      // The live setting, read even when there is no supervisor: a window whose
      // host exposes no globalStorage still reports whether the lease was asked
      // for at all.
      leaseEnabled: snapshot?.leaseEnabled ?? isMultiWindowLeaseEnabled(),
      degraded: snapshot?.degraded ?? supervisor === undefined,
      degradedReason: snapshot?.degradedCause ?? (supervisor === undefined ? 'lease-unavailable' : undefined),
      degradedSince: snapshot?.degradedSince,
      noticeShown: snapshot?.noticeShown ?? false,
      lastSuccessfulPollAt: timing.lastSuccessfulPollAt,
      nextScheduledPollAt: timing.nextScheduledPollAt,
    },
    versions: {
      // The in-process probe cache of §9: this window's own results, keyed by
      // the instance's configured URL. Never the token — only the version.
      instances: instances.map((instance) => {
        const version = getServerVersion(instance.url);
        return version === undefined
          ? { id: instance.id, url: instance.url }
          : { id: instance.id, url: instance.url, version };
      }),
      followsInstanceConfig: false,
    },
    env: {
      extensionVersion: sources.extensionVersion,
      vscodeVersion: vscode.version,
      os: process.platform,
      arch: process.arch,
      osRelease: os.release(),
      locale: vscode.env.language,
      remoteName: vscode.env.remoteName,
    },
  });
}
