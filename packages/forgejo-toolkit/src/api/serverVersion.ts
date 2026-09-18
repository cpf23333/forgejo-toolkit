import { passthroughTranslate, type TranslateFn } from './translate';

export interface ServerVersion {
  major: number;
  minor: number;
  patch: number;
}

/**
 * Parses a `/api/v1/version` payload such as "1.21.5", "v1.19.2" or
 * "7.0.1+gitea-1.22". Returns undefined for anything unparseable — callers
 * must fail open (an unknown version never blocks a feature).
 */
export function parseServerVersion(raw: string): ServerVersion | undefined {
  const match = raw.trim().match(/^v?(\d+)\.(\d+)(?:\.(\d+))?/);
  if (!match) {
    return undefined;
  }
  return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3] ?? 0) };
}

export function isVersionAtLeast(version: ServerVersion, minimum: ServerVersion): boolean {
  if (version.major !== minimum.major) {
    return version.major > minimum.major;
  }
  if (version.minor !== minimum.minor) {
    return version.minor > minimum.minor;
  }
  return version.patch >= minimum.patch;
}

// The Actions API first shipped (experimentally) with Gitea/Forgejo 1.19;
// older instances answer 404 on every /actions endpoint.
export const MIN_ACTIONS_VERSION: ServerVersion = { major: 1, minor: 19, patch: 0 };

const MIN_ACTIONS_VERSION_TEXT = `${MIN_ACTIONS_VERSION.major}.${MIN_ACTIONS_VERSION.minor}.${MIN_ACTIONS_VERSION.patch}`;

// The oldest Forgejo release the extension supports as a whole. Instances
// below it get a soft per-session warning; nothing is blocked. Forgejo's
// 1.x line (1.21 and earlier, long predating the v7+ renumbering) compares
// below 15 naturally with plain semver ordering.
export const MIN_SUPPORTED_VERSION: ServerVersion = { major: 15, minor: 0, patch: 0 };

export const MIN_SUPPORTED_VERSION_TEXT = `${MIN_SUPPORTED_VERSION.major}.${MIN_SUPPORTED_VERSION.minor}.${MIN_SUPPORTED_VERSION.patch}`;

/**
 * Whether a probed server version meets the supported floor. Unknown or
 * unparseable versions pass — a failed probe must never trigger a warning.
 */
export function isVersionSupported(version: string | undefined): boolean {
  if (!version) {
    return true;
  }
  const parsed = parseServerVersion(version);
  if (!parsed) {
    return true;
  }
  return isVersionAtLeast(parsed, MIN_SUPPORTED_VERSION);
}

// Per-session cache keyed by normalized instance URL. Populated on extension
// activation and after a successful connection test / instance save.
const serverVersions = new Map<string, string>();

function versionKey(url: string): string {
  return url.replace(/\/+$/, '');
}

export function setServerVersion(url: string, version: string): void {
  serverVersions.set(versionKey(url), version);
}

export function getServerVersion(url: string): string | undefined {
  return serverVersions.get(versionKey(url));
}

/**
 * Drops the cached version for one instance. Call before re-probing on
 * instance save/edit: a stale entry (e.g. recorded before a server upgrade)
 * would otherwise keep gating features until the session ends.
 */
export function clearServerVersion(url: string): void {
  serverVersions.delete(versionKey(url));
}

/** Drops every cached version (tests). */
export function clearServerVersions(): void {
  serverVersions.clear();
}

/**
 * Throws a localized, actionable error when the cached server version is
 * known to predate the Actions API. Unknown or unparseable versions pass —
 * the version probe is best-effort and must never block a working instance.
 * The extension passes vscode.l10n.t as `t`; headless consumers keep the
 * English passthrough default.
 */
export function assertActionsSupported(url: string, t: TranslateFn = passthroughTranslate): void {
  const raw = getServerVersion(url);
  if (!raw) {
    return;
  }
  const version = parseServerVersion(raw);
  if (!version || isVersionAtLeast(version, MIN_ACTIONS_VERSION)) {
    return;
  }
  throw new Error(
    t(
      'This feature requires Forgejo {0} or newer, but this server reports version {1}.',
      MIN_ACTIONS_VERSION_TEXT,
      raw,
    ),
  );
}
