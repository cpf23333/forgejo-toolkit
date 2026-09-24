import type { ForgejoInstance } from '@cpf23333-forgejo-toolkit/shared/webview/messages';
import { API_REQUEST_TIMEOUT_MS } from '../api/client';
import { getProxyFetch } from '../api/proxy';
import { logger } from '../logger';
import { redactUrlUserinfo } from './redactUrlUserinfo';

/**
 * Session-level cache of resolved attachment images. Attachment content at a
 * UUID URL is immutable, so a resolved data URL never expires. Failed lookups
 * are not cached. Bounded twice over, because an entry count alone bounds
 * nothing: every value is a base64 data URL (~1.33x the image), so 100
 * multi-MiB screenshots would pin hundreds of MiB for the whole session.
 * Both bounds evict the least recently used entry.
 */
const MAX_RESOLVED_IMAGES = 100;
const MAX_RESOLVED_IMAGE_BYTES = 32 * 1024 * 1024;
const resolvedImageCache = new Map<string, string>();
let resolvedImageCacheBytes = 0;

/**
 * Cache key for a resolved attachment. The instance id is part of it because
 * attachment visibility is scoped to the token: two instances can point at the
 * same origin (two accounts on one server, or a public and an internal URL), and
 * one instance's resolved image must never be served for the other's request.
 */
function resolvedImageKey(instanceId: string, url: string): string {
  return `${instanceId}|${url}`;
}

function cacheResolvedImage(instanceId: string, url: string, dataUrl: string): void {
  const key = resolvedImageKey(instanceId, url);
  const previous = resolvedImageCache.get(key);
  if (previous !== undefined) {
    resolvedImageCacheBytes -= previous.length;
    resolvedImageCache.delete(key);
  }
  // An image that alone exceeds the whole budget is served to this caller but
  // never retained: caching it would evict every other entry and still leave the
  // cache over budget.
  if (dataUrl.length > MAX_RESOLVED_IMAGE_BYTES) {
    return;
  }
  resolvedImageCache.set(key, dataUrl);
  resolvedImageCacheBytes += dataUrl.length;
  // Map iteration order is insertion order, so the first key is the oldest.
  while (
    resolvedImageCache.size > 0 &&
    (resolvedImageCache.size > MAX_RESOLVED_IMAGES || resolvedImageCacheBytes > MAX_RESOLVED_IMAGE_BYTES)
  ) {
    const oldest = resolvedImageCache.keys().next().value;
    if (oldest === undefined) {
      break;
    }
    const evicted = resolvedImageCache.get(oldest);
    resolvedImageCache.delete(oldest);
    resolvedImageCacheBytes -= evicted?.length ?? 0;
  }
}

function getCachedImage(instanceId: string, url: string): string | undefined {
  const key = resolvedImageKey(instanceId, url);
  const dataUrl = resolvedImageCache.get(key);
  if (dataUrl !== undefined) {
    // Refresh recency: re-insert so frequently used images are evicted last.
    // The byte accounting is unaffected, so it is not touched here.
    resolvedImageCache.delete(key);
    resolvedImageCache.set(key, dataUrl);
  }
  return dataUrl;
}

/** Clear the session-level image cache. Exported for tests. */
export function clearResolvedImageCache(): void {
  resolvedImageCache.clear();
  resolvedImageCacheBytes = 0;
}

/**
 * Find attachment image URLs inside markdown or HTML and replace them with
 * base64 data URLs so they can be rendered without exposing the API token.
 *
 * Handles both `![alt](url)` markdown syntax and `<img src="url">` HTML tags.
 *
 * A URL whose fetch fails is left in place (the webview cannot load an
 * authenticated attachment URL itself, so the image will not render) and the
 * failure is reported to the output channel instead of being dropped silently.
 * Per-image failures are not returned: the return type stays a plain string
 * because four host call sites embed the result directly in HTML, so widening
 * the contract would mean changing all of them for a diagnostic.
 */
export async function resolveAttachmentImages(text: string, instance: ForgejoInstance): Promise<string> {
  const baseUrl = instance.url.replace(/\/$/, '');
  const imageUrls = collectLocalImageUrls(text, baseUrl);
  if (imageUrls.size === 0) {
    return text;
  }

  const dataUrlMap = new Map<string, string>();
  // Bounded fan-out: a rendered body can link an arbitrary number of
  // attachments, and one token-bearing GET per link with no cap would flood a
  // self-hosted instance while buffering every image at once. The same
  // 4-in-flight shape as the comment-asset fan-out in `api/client.ts`.
  await runWithConcurrency(Array.from(imageUrls), 4, async (url) => {
    const cached = getCachedImage(instance.id, url);
    if (cached) {
      dataUrlMap.set(url, cached);
      return;
    }
    try {
      // A hung image host must not stall the other images; on timeout the fetch
      // rejects and the original URL is kept. Images go through the configured
      // proxy like every other request: a dispatcher is only understood by the
      // undici fetch that created it.
      const response = await (getProxyFetch() ?? fetch)(url, {
        headers: { Authorization: `token ${instance.token}` },
        signal: AbortSignal.timeout(API_REQUEST_TIMEOUT_MS),
      });
      if (!response.ok) {
        logger.debug(`[attachments] ${redactUrlUserinfo(url)} answered ${response.status}; keeping the original URL`);
        return;
      }
      const buffer = await response.arrayBuffer();
      const base64 = Buffer.from(buffer).toString('base64');
      const contentType = response.headers.get('content-type') ?? guessMimeType(url);
      const dataUrl = `data:${contentType};base64,${base64}`;
      cacheResolvedImage(instance.id, url, dataUrl);
      dataUrlMap.set(url, dataUrl);
    } catch (error) {
      // Keep the original URL, but say so: the URL is authenticated, so a
      // silently dropped image is indistinguishable from a missing one.
      logger.debug(
        `[attachments] ${redactUrlUserinfo(url)} could not be resolved: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  });

  let result = text.replace(/!\[([^[\]]*)\]\(([^)]+)\)/g, (match, alt, url) => {
    const normalized = normalizeAttachmentUrl(url, baseUrl);
    const dataUrl = normalized ? dataUrlMap.get(normalized) : undefined;
    return dataUrl ? `![${alt}](${dataUrl})` : match;
  });

  result = result.replace(/<img\b[^>]*\bsrc=["']([^"']+)["'][^>]*>/gi, (match, url) => {
    const normalized = normalizeAttachmentUrl(url, baseUrl);
    const dataUrl = normalized ? dataUrlMap.get(normalized) : undefined;
    if (!dataUrl) {
      return match;
    }
    // Replace only the URL inside the src attribute to preserve other attributes.
    return match.replace(url, dataUrl);
  });

  return result;
}

/**
 * Run `task` for every item with at most `limit` tasks in flight, preserving no
 * particular order.
 *
 * A local mirror of `mapWithConcurrency` in `api/client.ts` (the helper the
 * comment-asset fan-out uses), kept here on purpose: this module is pulled in by
 * host modules whose tests replace `../api/client` with a partial factory that
 * only provides `API_REQUEST_TIMEOUT_MS`, so importing a second export from
 * there would resolve to `undefined` under those mocks and this resolver would
 * throw before it fetched anything. Keep the two implementations in step.
 */
async function runWithConcurrency<T>(
  items: readonly T[],
  limit: number,
  task: (item: T) => Promise<void>,
): Promise<void> {
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (let index = next++; index < items.length; index = next++) {
      await task(items[index]);
    }
  });
  await Promise.all(workers);
}

function collectLocalImageUrls(text: string, baseUrl: string): Set<string> {
  const urls = new Set<string>();
  const mdRegex = /!\[([^[\]]*)\]\(([^)]+)\)/g;
  const htmlRegex = /<img\b[^>]*\bsrc=["']([^"']+)["'][^>]*>/gi;
  let match: RegExpExecArray | null;

  while ((match = mdRegex.exec(text)) !== null) {
    const normalized = normalizeAttachmentUrl(match[2], baseUrl);
    if (normalized) {
      urls.add(normalized);
    }
  }

  while ((match = htmlRegex.exec(text)) !== null) {
    const normalized = normalizeAttachmentUrl(match[1], baseUrl);
    if (normalized) {
      urls.add(normalized);
    }
  }

  return urls;
}

/**
 * Recognize Forgejo attachment URLs and normalize them to the configured
 * instance origin. The markdown API may return URLs with a different hostname
 * or IP than the one configured by the user (e.g. public vs. internal address),
 * so we use the configured baseUrl origin for fetching while preserving the
 * attachment path.
 */
function normalizeAttachmentUrl(url: string, baseUrl: string): string | undefined {
  try {
    const parsed = new URL(url, baseUrl);
    if (!isAttachmentPathname(parsed.pathname)) {
      return undefined;
    }
    const base = new URL(baseUrl);
    parsed.protocol = base.protocol;
    parsed.host = base.host;
    return parsed.href;
  } catch {
    return undefined;
  }
}

function isAttachmentPathname(path: string): boolean {
  // Global attachments: /attachments/<uuid>
  // Repository attachments rendered by the markdown API:
  //   /<owner>/<repo>/attachment/<uuid> or /<owner>/<repo>/attachments/<uuid>
  return path.startsWith('/attachments/') || /^\/[^/]+\/[^/]+\/attachments?\//.test(path);
}

function guessMimeType(url: string): string {
  const ext = url.split('.').pop()?.toLowerCase();
  switch (ext) {
    case 'png':
      return 'image/png';
    case 'jpg':
    case 'jpeg':
      return 'image/jpeg';
    case 'gif':
      return 'image/gif';
    case 'svg':
      return 'image/svg+xml';
    case 'webp':
      return 'image/webp';
    default:
      return 'application/octet-stream';
  }
}
