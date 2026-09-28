import { passthroughTranslate, type TranslateFn } from './translate';

export interface InsufficientScopeDetails {
  /** The scope Forgejo named in the error body, when it did. */
  scope?: string;
  /** Trimmed response body, for message rendering and toast dedupe. */
  body: string;
}

/**
 * Host-environment hooks for ForgejoClient: everything the client needs that
 * differs between the extension host (toasts, vscode.l10n) and a headless
 * process (the MCP server, where these are no-ops). The extension registers
 * its implementation at activation via setForgejoClientHost; tests do the
 * same in the shared vitest setup.
 */
export interface ForgejoClientHost {
  /** Localize a user-facing message with {0} placeholders. */
  t: TranslateFn;
  /**
   * The token was rejected outright (401): deleted, expired, or reinstalled instance.
   *
   * `credentialFingerprint` identifies the credential that actually failed
   * without being one: a non-reversible digest of it (never the credential, and
   * never logged or shown). It is optional because only the client holds the
   * credential — a host that dedupes the toast folds the fingerprint into its
   * dedupe key so that a rotated token re-arms the toast while a poller
   * repeating the same bad token stays quiet. `undefined` means the caller does
   * not know which credential failed, and the host falls back to what it can
   * derive on its own.
   */
  notifyInvalidCredentials(instanceUrl: string, credentialFingerprint?: string): void;
  /**
   * 403 where Forgejo says the token lacks a required scope. The
   * `credentialFingerprint` has the same meaning and the same optionality as on
   * `notifyInvalidCredentials`.
   */
  notifyInsufficientScope(instanceUrl: string, details: InsufficientScopeDetails, credentialFingerprint?: string): void;
  /**
   * The probed server version is below the supported floor (soft warning, never
   * blocks). `probedVersion` is the value the caller just probed, when it has
   * one: the host keys its per-window dedupe on it so a server that moves to a
   * different unsupported version can warn again, and falls back to the cached
   * version when the caller does not pass it.
   */
  notifyUnsupportedInstance(url: string, requiredVersion: string, probedVersion?: string): void;
}

const headlessHost: ForgejoClientHost = {
  t: passthroughTranslate,
  notifyInvalidCredentials: () => undefined,
  notifyInsufficientScope: () => undefined,
  notifyUnsupportedInstance: () => undefined,
};

let currentHost: ForgejoClientHost = headlessHost;

export function setForgejoClientHost(host: ForgejoClientHost): void {
  currentHost = host;
}

export function getForgejoClientHost(): ForgejoClientHost {
  return currentHost;
}
