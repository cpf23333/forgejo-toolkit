import type { ForgejoInstance } from '@cpf23333-forgejo-toolkit/shared/webview/messages';
import { API_REQUEST_TIMEOUT_MS } from '../api/client';

/**
 * Session-level cache of resolved attachment images. Attachment content at a
 * UUID URL is immutable, so a resolved data URL never expires. Failed lookups
 * are not cached. Bounded with simple LRU eviction: data URLs are large
 * (base64), so an unbounded Map would grow with every attachment ever viewed.
 */
const MAX_RESOLVED_IMAGES = 100;
const resolvedImageCache = new Map<string, string>();

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
  if (!resolvedImageCache.has(key) && resolvedImageCache.size >= MAX_RESOLVED_IMAGES) {
    // Map iteration order is insertion order: the first key is the oldest.
    const oldest = resolvedImageCache.keys().next().value;
    if (oldest !== undefined) {
      resolvedImageCache.delete(oldest);
    }
  }
  resolvedImageCache.set(key, dataUrl);
}

function getCachedImage(instanceId: string, url: string): string | undefined {
  const key = resolvedImageKey(instanceId, url);
  const dataUrl = resolvedImageCache.get(key);
  if (dataUrl !== undefined) {
    // Refresh recency: re-insert so frequently used images are evicted last.
    resolvedImageCache.delete(key);
    resolvedImageCache.set(key, dataUrl);
  }
  return dataUrl;
}

/** Clear the session-level image cache. Exported for tests. */
export function clearResolvedImageCache(): void {
  resolvedImageCache.clear();
}

/**
 * Find attachment image URLs inside markdown or HTML and replace them with
 * base64 data URLs so they can be rendered without exposing the API token.
 *
 * Handles both `![alt](url)` markdown syntax and `<img src="url">` HTML tags.
 */
export async function resolveAttachmentImages(text: string, instance: ForgejoInstance): Promise<string> {
  const baseUrl = instance.url.replace(/\/$/, '');
  const imageUrls = collectLocalImageUrls(text, baseUrl);
  if (imageUrls.size === 0) {
    return text;
  }

  const dataUrlMap = new Map<string, string>();
  await Promise.all(
    Array.from(imageUrls).map(async (url) => {
      const cached = getCachedImage(instance.id, url);
      if (cached) {
        dataUrlMap.set(url, cached);
        return;
      }
      try {
        // A hung image host must not stall the surrounding Promise.all; on
        // timeout the fetch rejects and the original URL is kept.
        const response = await fetch(url, {
          headers: { Authorization: `token ${instance.token}` },
          signal: AbortSignal.timeout(API_REQUEST_TIMEOUT_MS),
        });
        if (!response.ok) {
          return;
        }
        const buffer = await response.arrayBuffer();
        const base64 = Buffer.from(buffer).toString('base64');
        const contentType = response.headers.get('content-type') ?? guessMimeType(url);
        const dataUrl = `data:${contentType};base64,${base64}`;
        cacheResolvedImage(instance.id, url, dataUrl);
        dataUrlMap.set(url, dataUrl);
      } catch {
        // Keep the original URL on failure.
      }
    }),
  );

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
