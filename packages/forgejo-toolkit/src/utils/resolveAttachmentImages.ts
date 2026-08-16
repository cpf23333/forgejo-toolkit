import type { ForgejoInstance } from '@cpf23333-forgejo-toolkit/shared/webview/messages';

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
      try {
        const response = await fetch(url, {
          headers: { Authorization: `token ${instance.token}` },
        });
        if (!response.ok) {
          return;
        }
        const buffer = await response.arrayBuffer();
        const base64 = Buffer.from(buffer).toString('base64');
        const contentType = response.headers.get('content-type') ?? guessMimeType(url);
        dataUrlMap.set(url, `data:${contentType};base64,${base64}`);
      } catch {
        // Keep the original URL on failure.
      }
    }),
  );

  let result = text.replace(/!\[([^[\]]*)\]\(([^)]+)\)/g, (match, alt, url) => {
    const resolved = resolveUrl(url, baseUrl);
    const dataUrl = dataUrlMap.get(resolved);
    return dataUrl ? `![${alt}](${dataUrl})` : match;
  });

  result = result.replace(/<img\b[^>]*\bsrc=["']([^"']+)["'][^>]*>/gi, (match, url) => {
    const resolved = resolveUrl(url, baseUrl);
    const dataUrl = dataUrlMap.get(resolved);
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
    const resolved = resolveUrl(match[2], baseUrl);
    if (isLocalAttachmentUrl(resolved, baseUrl)) {
      urls.add(resolved);
    }
  }

  while ((match = htmlRegex.exec(text)) !== null) {
    const resolved = resolveUrl(match[1], baseUrl);
    if (isLocalAttachmentUrl(resolved, baseUrl)) {
      urls.add(resolved);
    }
  }

  return urls;
}

function resolveUrl(url: string, baseUrl: string): string {
  try {
    return new URL(url, baseUrl).href;
  } catch {
    return url;
  }
}

function isLocalAttachmentUrl(url: string, baseUrl: string): boolean {
  try {
    const parsed = new URL(url, baseUrl);
    if (parsed.origin !== new URL(baseUrl).origin) {
      return false;
    }
    return parsed.pathname.startsWith('/attachments/');
  } catch {
    return false;
  }
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
