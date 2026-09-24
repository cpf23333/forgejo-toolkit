import * as vscode from 'vscode';
import { toApiError } from '../api/errors';

/**
 * The only schemes a connection test may reach. The URL comes from a webview,
 * which is untrusted: without this check a compromised view has the host issue
 * a request to any URL it names (a `file:`/`data:`/`javascript:` target, or an
 * intranet host reachable only from the extension host), turning the command
 * into an SSRF and port-scanning primitive. Deliberately permissive about the
 * host itself, because the setup wizard has to test arbitrary user-entered
 * Forgejo instances.
 */
export function isHttpUrl(value: string): boolean {
  try {
    const scheme = new URL(value).protocol;
    return scheme === 'http:' || scheme === 'https:';
  } catch {
    return false;
  }
}

/**
 * Status-only rendering of a connection-test failure. `userFacingErrorMessage`
 * embeds the upstream response body for 409/422/other HTTP statuses, and that
 * reflected content would be shown inside the webview whose own CSP forbids
 * loading it — so the reply carries the failure kind (or bare status code)
 * instead of anything the remote server authored.
 *
 * Shared by the sidebar and the setup wizard: both test a webview-supplied URL.
 */
export function connectionFailureMessage(error: unknown): string {
  const apiError = toApiError(error);
  switch (apiError.kind) {
    case 'timeout':
      return vscode.l10n.t('The request timed out. The instance is not responding.');
    case 'network':
      return vscode.l10n.t('Cannot connect to the instance. Check that it is running and that the URL is correct.');
    case 'http':
      return apiError.status === undefined
        ? vscode.l10n.t('The instance rejected the request.')
        : vscode.l10n.t('The instance rejected the request (HTTP {0}).', apiError.status);
    default:
      return vscode.l10n.t('The connection test failed.');
  }
}
