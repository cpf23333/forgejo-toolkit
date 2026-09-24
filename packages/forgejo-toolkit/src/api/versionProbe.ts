import { ForgejoClient, type ClientLogger } from './client';
import { getForgejoClientHost } from './clientHost';
import { isVersionSupported, MIN_SUPPORTED_VERSION_TEXT, setServerVersion } from './serverVersion';

/**
 * An instance URL with its credentials removed, for logs.
 *
 * A configured instance URL may embed credentials (`https://user:token@host`),
 * and the log lines below reach the output channel and the MCP server's stderr.
 * `redactRemoteUrl` in `worktree/gitOperations.ts` implements the same rule, but
 * it cannot be reused here: that module imports `vscode`, and this module is part
 * of the MCP server bundle, which is built to reject any `vscode` import. Same
 * rule, kept in sync: a password is replaced, and so is the username of an
 * http(s) URL that carries no password, where a token is commonly written in the
 * username position (`https://<token>@host`). A plain ssh login
 * (`ssh://git@host/...`) names no secret and stays readable.
 *
 * Ideally both helpers live in one vscode-free utility module that
 * `gitOperations.ts` re-exports; that file is owned elsewhere, so the copy stays
 * here for now (see the round-4 report).
 */
export function redactInstanceUrl(url: string): string {
  if (!url.includes('@')) {
    return url;
  }
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    // Not an absolute URL (e.g. the scp-like `user@host:path`): nothing to strip.
    return url;
  }
  if (!parsed.username && !parsed.password) {
    return url;
  }
  if (parsed.password) {
    parsed.password = '***';
  } else if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
    parsed.username = '***';
  }
  return parsed.toString();
}

/**
 * Best-effort server version probe: the result feeds the feature gates in
 * `serverVersion.ts`. Failures are logged at debug level and swallowed —
 * an instance that cannot be probed simply keeps every feature enabled
 * (the gates fail open for unknown versions). A probed version below the
 * supported floor triggers a soft host notification; nothing is blocked.
 *
 * The logger is the client-facing interface on purpose: the MCP server process
 * runs this too, and it only has the console-backed `ClientLogger` (the editor's
 * `Logger` implements it, so both callers work).
 */
export async function probeServerVersion(
  url: string,
  token: string,
  logger?: ClientLogger,
  syncApiUrlsToInstanceUrl?: boolean,
): Promise<void> {
  try {
    const client = new ForgejoClient(url, token, logger, syncApiUrlsToInstanceUrl);
    const version = await client.getServerVersion();
    if (version) {
      setServerVersion(url, version);
      logger?.debug(`Server version for ${redactInstanceUrl(url)}: ${version}`);
      if (!isVersionSupported(version)) {
        getForgejoClientHost().notifyUnsupportedInstance(url, MIN_SUPPORTED_VERSION_TEXT);
      }
    }
  } catch (error) {
    // The failure detail can echo the request URL (fetch refuses a URL that
    // carries credentials and quotes it back), so the raw URL is replaced
    // wherever it appears, not just in the prefix.
    const detail = error instanceof Error ? error.message : String(error);
    const redactedUrl = redactInstanceUrl(url);
    logger?.debug(`Server version probe failed for ${redactedUrl}: ${detail.split(url).join(redactedUrl)}`);
  }
}
