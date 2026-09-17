import * as vscode from 'vscode';
import type { ForgejoClientHost, InsufficientScopeDetails } from './clientHost';
import type { Logger } from '../logger';

// 401/403 scope toasts are deduped per instance+reason for the whole session:
// pollers and manual refreshes would otherwise re-toast the same failure on
// every request.
const shownPermissionErrorKeys = new Set<string>();

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
  };
}
