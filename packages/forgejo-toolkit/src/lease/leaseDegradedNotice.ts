/**
 * The one-time "the lease gave up, this window polls on its own" notice (§7.1).
 *
 * The mechanism is silent when it works, and that is deliberate. What must not
 * be silent is the *opposite*: if the lease is unusable on this machine — an
 * unwritable globalStorage, a read-only profile, a filesystem whose
 * create-exclusive is not exclusive — the window falls back to polling exactly
 * as it does with the setting off (§8), and without a word the user would never
 * know that the setting they enabled is doing nothing.
 *
 * Two rules shape the message:
 *
 * - **It says the feature is not missing, only that requests are more
 *   numerous.** Degrading is the safe direction (§8's total principle), and a
 *   message that reads like an error would teach users to distrust a mechanism
 *   that is working as designed.
 * - **It is once per session** (per notifier instance, which the activation
 *   site creates once). The state it describes is persistent, so repeating it
 *   would be noise; a later activation that still degrades may say it again.
 *
 * Both actions are real, not decorative: the first runs the diagnostics command
 * (§11.1 stage 2 — with no telemetry, that JSON is the only evidence a bug
 * report can carry), and the second turns `forgejoToolkit.multiWindowLease` off
 * at user scope, which is §11.1 stage 3's rollback path in one click.
 *
 * The command id lives here rather than with the command because this module is
 * the lower layer: the lease may not import `commands/**`, and the notice is
 * the only thing that has to *invoke* the command by name.
 */

import * as vscode from 'vscode';

/** The diagnostics command the notice's first button runs (§11.1 stage 2). */
export const COPY_POLLING_DIAGNOSTICS_COMMAND = 'forgejoToolkit.copyPollingDiagnostics';

/** The slice of `Logger` this module uses. */
export interface LeaseNoticeLogger {
  info(message: string): void;
  error(message: string): void;
}

export interface LeaseDegradedNotifier {
  /** Shows the notice, unless this session already has. Never throws. */
  notify(cause: string): void;
  /** Whether the notice has been shown in this session (§7.1's "once"). */
  readonly shown: boolean;
}

export interface LeaseDegradedNoticeOptions {
  logger: LeaseNoticeLogger;
}

/**
 * Creates this session's notifier. The once-per-session latch lives here, so
 * the supervisor can call `notify` on every degradation event without knowing
 * anything about pacing.
 */
export function createLeaseDegradedNotifier(options: LeaseDegradedNoticeOptions): LeaseDegradedNotifier {
  let shown = false;
  const notifier: LeaseDegradedNotifier = {
    get shown(): boolean {
      return shown;
    },
    notify(cause: string): void {
      if (shown) {
        return;
      }
      shown = true;
      options.logger.info(
        `Polling lease unavailable (cause=${cause}); this window polls on its own and the one-time notice is shown.`,
      );
      const copyLabel = vscode.l10n.t('Copy Diagnostics');
      const disableLabel = vscode.l10n.t('Disable This Setting');
      // Promise.resolve flattens the Thenable so the catch below also covers a
      // synchronous throw inside the callback, which must not surface as an
      // unhandled rejection (the same shape the poller's toast uses).
      void Promise.resolve(
        vscode.window.showInformationMessage(
          vscode.l10n.t(
            'The multi-window polling lease is unavailable on this machine, so this window polls and alerts on its own. Nothing is missing — requests may just be more numerous.',
          ),
          copyLabel,
          disableLabel,
        ),
      )
        .then(async (choice) => {
          if (choice === copyLabel) {
            await vscode.commands.executeCommand(COPY_POLLING_DIAGNOSTICS_COMMAND);
            return;
          }
          if (choice === disableLabel) {
            // User scope on purpose: the lease is a property of the machine, and
            // a window that cannot use it is the reason to stop asking every
            // window for it.
            await vscode.workspace
              .getConfiguration('forgejoToolkit')
              .update('multiWindowLease', false, vscode.ConfigurationTarget.Global);
          }
        })
        .catch((error: unknown) => {
          options.logger.error(`Failed to handle the polling lease notice action: ${errorText(error)}`);
        });
    },
  };
  return notifier;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
