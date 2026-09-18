import { ForgejoClient } from './client';
import { getForgejoClientHost } from './clientHost';
import { isVersionSupported, MIN_SUPPORTED_VERSION_TEXT, setServerVersion } from './serverVersion';
import type { Logger } from '../logger';

/**
 * Best-effort server version probe: the result feeds the feature gates in
 * `serverVersion.ts`. Failures are logged at debug level and swallowed —
 * an instance that cannot be probed simply keeps every feature enabled
 * (the gates fail open for unknown versions). A probed version below the
 * supported floor triggers a soft host notification; nothing is blocked.
 */
export async function probeServerVersion(
  url: string,
  token: string,
  logger?: Logger,
  syncApiUrlsToInstanceUrl?: boolean,
): Promise<void> {
  try {
    const client = new ForgejoClient(url, token, logger, syncApiUrlsToInstanceUrl);
    const version = await client.getServerVersion();
    if (version) {
      setServerVersion(url, version);
      logger?.debug(`Server version for ${url}: ${version}`);
      if (!isVersionSupported(version)) {
        getForgejoClientHost().notifyUnsupportedInstance(url, MIN_SUPPORTED_VERSION_TEXT);
      }
    }
  } catch (error) {
    logger?.debug(`Server version probe failed for ${url}: ${error instanceof Error ? error.message : String(error)}`);
  }
}
