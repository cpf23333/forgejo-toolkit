import { redactUrlUserinfo } from '../utils/redactUrlUserinfo';
import { ForgejoClient, type ClientLogger } from './client';
import { getForgejoClientHost } from './clientHost';
import { isVersionSupported, MIN_SUPPORTED_VERSION_TEXT, setServerVersion } from './serverVersion';

/**
 * An instance URL with its credentials removed, for logs.
 *
 * A configured instance URL may embed credentials (`https://user:token@host`),
 * and the log lines below reach the output channel and the MCP server's stderr.
 * The rule lives in `utils/redactUrlUserinfo.ts`, which imports nothing and so
 * is safe for this MCP-bundle module; this name is kept for the callers that
 * already use it.
 */
export const redactInstanceUrl = redactUrlUserinfo;

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
