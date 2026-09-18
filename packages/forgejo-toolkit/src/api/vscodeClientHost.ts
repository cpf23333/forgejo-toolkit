import * as vscode from 'vscode';
import type { ForgejoClientHost, InsufficientScopeDetails } from './clientHost';
import { getServerVersion } from './serverVersion';
import type { Logger } from '../logger';

// 401/403 scope toasts are deduped per instance+reason for the whole session:
// pollers and manual refreshes would otherwise re-toast the same failure on
// every request.
const shownPermissionErrorKeys = new Set<string>();

// Unsupported-version warnings fire at most once per instance per session:
// the probe re-runs on every activation, save, and connection test.
const shownUnsupportedVersionUrls = new Set<string>();

/**
 * Extension-host implementation of the ForgejoClient host hooks: auth
 * failures surface as error toasts with actions that open the instance's
 * token settings page or the extension settings view.
 */
export function createVscodeClientHost(logger?: Logger): ForgejoClientHost {
  const notify = (key: string, instanceUrl: string, message: string) => {
    if (shownPermissionErrorKeys.has(key)) {
      return;
    }
    shownPermissionErrorKeys.add(key);
    const openTokenSettings = vscode.l10n.t('Open Token Settings');
    const openSettings = vscode.l10n.t('Open Settings');
    void vscode.window.showErrorMessage(message, openTokenSettings, openSettings).then(
      (choice) => {
        if (choice === openTokenSettings) {
          const tokenSettingsUrl = `${instanceUrl.replace(/\/$/, '')}/user/settings/applications`;
          void vscode.env.openExternal(vscode.Uri.parse(tokenSettingsUrl));
        } else if (choice === openSettings) {
          void vscode.commands.executeCommand('forgejoToolkit.openSettings');
        }
      },
      (error: unknown) => {
        logger?.error(
          `Failed to show permission error notification: ${error instanceof Error ? error.message : String(error)}`,
        );
      },
    );
  };

  return {
    t: vscode.l10n.t,
    notifyInvalidCredentials(instanceUrl: string): void {
      notify(
        `${instanceUrl}|401`,
        instanceUrl,
        vscode.l10n.t('Invalid or expired credentials for {0}. Update the access token.', instanceUrl),
      );
    },
    notifyInsufficientScope(instanceUrl: string, details: InsufficientScopeDetails): void {
      // Forgejo names the missing scope in the error body ("token does not
      // have at least one of required scope(s): [write:issue]"); surface it
      // so the user knows exactly which scope to grant.
      const message = details.scope
        ? vscode.l10n.t(
            'Permission denied by {0}: the access token lacks the required scope {1}.',
            instanceUrl,
            details.scope,
          )
        : vscode.l10n.t(
            'Permission denied by {0}: {1}. The access token may lack the required scope.',
            instanceUrl,
            details.body,
          );
      notify(`${instanceUrl}|${details.body}`, instanceUrl, message);
    },
    notifyUnsupportedInstance(url: string, requiredVersion: string): void {
      if (shownUnsupportedVersionUrls.has(url)) {
        return;
      }
      shownUnsupportedVersionUrls.add(url);
      const serverVersion = getServerVersion(url);
      const message = serverVersion
        ? vscode.l10n.t(
            'This instance runs Forgejo {0}, which is older than the minimum supported version {1}. Some features may not work.',
            serverVersion,
            requiredVersion,
          )
        : vscode.l10n.t(
            'This instance runs a Forgejo version older than the minimum supported version {0}. Some features may not work.',
            requiredVersion,
          );
      void vscode.window.showWarningMessage(message).then(undefined, (error: unknown) => {
        logger?.error(
          `Failed to show unsupported version notification: ${error instanceof Error ? error.message : String(error)}`,
        );
      });
    },
  };
}
