import * as vscode from 'vscode';
import type { ForgejoClientHost, InsufficientScopeDetails } from './clientHost';
import { getServerVersion } from './serverVersion';
import { redactUrlUserinfo, stripUrlUserinfo } from '../utils/redactUrlUserinfo';
import { isHttpUrl } from '../webview/connectionTest';
import type { Logger } from '../logger';

// 401/403 scope toasts are deduped per instance+reason+credential for the whole
// session: pollers and manual refreshes would otherwise re-toast the same failure
// on every request, while a rotated credential must be able to re-toast.
const shownPermissionErrorKeys = new Set<string>();

// Unsupported-version warnings fire at most once per instance per session:
// the probe re-runs on every activation, save, and connection test.
const shownUnsupportedVersionUrls = new Set<string>();

/**
 * The dedupe key for a permission toast.
 *
 * The URL alone is not enough. The actionable half of the toast is "Update the
 * access token", and after the user replaces a dead credential with another bad
 * one every request still 401s — but the key had not changed, so the toast that
 * says what to do could never come back for the rest of the window. Two
 * credential sources are folded into the key, so a rotation re-arms it while a
 * poller re-requesting with the same bad credential stays quiet:
 *
 * - `credential` is the userinfo the instance URL carries, fingerprinted here
 *   because that is the form the host can read itself. A URL without userinfo
 *   contributes the empty credential.
 * - `credentialFingerprint` is what the client sends for the credential it
 *   actually put on the request — with a SecretStorage token that is the only
 *   place the credential exists, and the host can neither read it nor tell two
 *   tokens apart without this.
 *
 * Both are digests: the key is process-local, but a key carrying a token would
 * be one `logger.debug` away from the output channel.
 *
 * The fingerprint is the cheap DJB2-and-length form the webview instance payload
 * uses (`tokenFingerprint` in shared/webview/messages), kept local so this key
 * does not depend on that module's build; the two never have to agree, they only
 * have to notice a change.
 */
export function permissionErrorKey(
  url: string,
  reason: string,
  credential: string,
  credentialFingerprint = '',
): string {
  let hash = 5381;
  for (let index = 0; index < credential.length; index += 1) {
    hash = ((hash << 5) + hash + credential.charCodeAt(index)) | 0;
  }
  return `${url}|${reason}|${(hash >>> 0).toString(16)}-${credential.length}|${credentialFingerprint}`;
}

/**
 * The credential a URL carries as userinfo, for `permissionErrorKey`. Empty for
 * a URL without userinfo, or one that cannot be parsed.
 */
function urlCredential(url: string): string {
  if (!url.includes('@')) {
    return '';
  }
  try {
    const parsed = new URL(url);
    return `${parsed.username}:${parsed.password}`;
  } catch {
    return '';
  }
}

/** Test hook: the dedupe set is per-session state, so a suite has to reset it. */
export function resetShownPermissionErrors(): void {
  shownPermissionErrorKeys.clear();
}

/**
 * Extension-host implementation of the ForgejoClient host hooks: auth
 * failures surface as error toasts with actions that open the instance's
 * token settings page or the extension settings view.
 */
export function createVscodeClientHost(logger?: Logger): ForgejoClientHost {
  /**
   * `displayUrl` is what every toast shows: the stored instance URL may carry
   * the token as userinfo, and a toast is a user-visible surface like any other.
   * `instanceUrl` keeps the real value, which only the "Open Token Settings"
   * action needs. `reason` is the failure detail the toast is about.
   * `credentialFingerprint` is the client's digest of the credential that
   * failed, when the client knew it; it only ever reaches the dedupe key.
   */
  const notify = (
    reason: string,
    displayUrl: string,
    instanceUrl: string,
    message: string,
    credentialFingerprint?: string,
  ) => {
    const key = permissionErrorKey(displayUrl, reason, urlCredential(instanceUrl), credentialFingerprint);
    if (shownPermissionErrorKeys.has(key)) {
      return;
    }
    shownPermissionErrorKeys.add(key);
    const openTokenSettings = vscode.l10n.t('Open Token Settings');
    const openSettings = vscode.l10n.t('Open Settings');
    void vscode.window.showErrorMessage(message, openTokenSettings, openSettings).then(
      (choice) => {
        if (choice === openTokenSettings) {
          // The userinfo is stripped, not merely masked: this URL is handed to
          // the operating system's browser, and `:***@host` is not a URL the
          // server can serve. The configured credential is already visible in
          // Settings; it has no business in an external browser's history.
          const tokenSettingsUrl = `${stripUrlUserinfo(instanceUrl).replace(/\/$/, '')}/user/settings/applications`;
          // Scheme allowlist before handing the URL to the OS: the instance URL
          // is stored data here, and the other three openExternal sites in the
          // extension refuse anything that is not http(s) for the same reason.
          // The token settings page of a non-HTTP instance URL cannot exist.
          if (!isHttpUrl(tokenSettingsUrl)) {
            logger?.error(`Blocked openExternal for a non-http(s) instance URL: ${displayUrl}`);
            return;
          }
          // A `false` result and a rejection are both silent failures of the
          // button: report them like the three sibling openExternal sites do, so
          // "Open Token Settings" cannot quietly do nothing.
          void vscode.env.openExternal(vscode.Uri.parse(tokenSettingsUrl)).then(
            (opened) => {
              if (!opened) {
                logger?.error(`openExternal reported failure for the token settings page of ${displayUrl}`);
              }
            },
            (error: unknown) => {
              logger?.error(
                `openExternal failed for the token settings page of ${displayUrl}: ${error instanceof Error ? error.message : String(error)}`,
              );
            },
          );
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
    notifyInvalidCredentials(instanceUrl: string, credentialFingerprint?: string): void {
      const displayUrl = redactUrlUserinfo(instanceUrl);
      notify(
        '401',
        displayUrl,
        instanceUrl,
        vscode.l10n.t('Invalid or expired credentials for {0}. Update the access token.', displayUrl),
        credentialFingerprint,
      );
    },
    notifyInsufficientScope(
      instanceUrl: string,
      details: InsufficientScopeDetails,
      credentialFingerprint?: string,
    ): void {
      // Forgejo names the missing scope in the error body ("token does not
      // have at least one of required scope(s): [write:issue]"); surface it
      // so the user knows exactly which scope to grant.
      const displayUrl = redactUrlUserinfo(instanceUrl);
      const message = details.scope
        ? vscode.l10n.t(
            'Permission denied by {0}: the access token lacks the required scope {1}.',
            displayUrl,
            details.scope,
          )
        : vscode.l10n.t(
            'Permission denied by {0}: {1}. The access token may lack the required scope.',
            displayUrl,
            details.body,
          );
      notify(details.body, displayUrl, instanceUrl, message, credentialFingerprint);
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
