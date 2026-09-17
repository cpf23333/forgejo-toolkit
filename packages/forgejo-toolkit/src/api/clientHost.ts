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
  /** The token was rejected outright (401): deleted, expired, or reinstalled instance. */
  notifyInvalidCredentials(instanceUrl: string): void;
  /** 403 where Forgejo says the token lacks a required scope. */
  notifyInsufficientScope(instanceUrl: string, details: InsufficientScopeDetails): void;
}

const headlessHost: ForgejoClientHost = {
  t: passthroughTranslate,
  notifyInvalidCredentials: () => undefined,
  notifyInsufficientScope: () => undefined,
};

let currentHost: ForgejoClientHost = headlessHost;

export function setForgejoClientHost(host: ForgejoClientHost): void {
  currentHost = host;
}

export function getForgejoClientHost(): ForgejoClientHost {
  return currentHost;
}
