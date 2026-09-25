import * as vscode from 'vscode';
import { apiErrorUserMessage, toApiError } from '../api/errors';

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
 * Non-HTTP failures (timeout, cancellation, TLS, proxy, plain network) use the
 * shared API-layer rendering, so a certificate problem is named as such rather
 * than being flattened into the generic "check that it is running" advice, and
 * a proxied failure names the proxy instead of the instance. The `proxy` kind
 * only arrives on an error ForgejoClient already classified (its `viaProxy`
 * context lives with the request, not on a raw fetch failure).
 *
 * Shared by the sidebar and the setup wizard: both test a webview-supplied URL.
 */
export function connectionFailureMessage(error: unknown): string {
  const apiError = toApiError(error);
  switch (apiError.kind) {
    case 'timeout':
    case 'cancelled':
    case 'tls':
    case 'network':
    case 'proxy':
      return apiErrorUserMessage(apiError);
    case 'http':
      return apiError.status === undefined
        ? vscode.l10n.t('The instance rejected the request.')
        : vscode.l10n.t('The instance rejected the request (HTTP {0}).', apiError.status);
    default:
      return vscode.l10n.t('The connection test failed.');
  }
}
