import DOMPurify from 'dompurify';
import type { UponSanitizeAttributeHookEvent } from 'dompurify';

const dangerousTags = [
  'script',
  'iframe',
  'object',
  'embed',
  'form',
  'input',
  'textarea',
  'button',
  'style',
  'link',
  'base',
  'meta',
];
const dangerousSchemes = /^javascript:|data:text\/html|^data:image\/svg/i;
const absoluteUrlPattern = /^[a-z][a-z0-9+.-]*:/i;

function resolveUrl(value: string, baseUrl?: string): string {
  if (!baseUrl || absoluteUrlPattern.test(value) || value.startsWith('#')) {
    return value;
  }
  try {
    return new URL(value, baseUrl).href;
  } catch {
    return value;
  }
}

// Neutralizes link hrefs (original URL moves to `data-href`) and resolves
// relative image sources. Runs before DOMPurify so that dangerous schemes
// are already replaced with `javascript:void(0)` when DOMPurify sees them;
// this is the URL contract the click/hover handlers in MarkdownBody rely on.
function rewriteUrlAttributes(root: ParentNode, baseUrl?: string): void {
  for (const element of Array.from(root.querySelectorAll('*'))) {
    for (const attr of Array.from(element.attributes)) {
      const name = attr.name.toLowerCase();
      if (name === 'href' || name.endsWith(':href')) {
        const value = attr.value.trim();
        if (dangerousSchemes.test(value)) {
          element.setAttribute(attr.name, 'javascript:void(0)');
        } else if (value.startsWith('#')) {
          element.setAttribute(attr.name, value);
        } else {
          element.setAttribute('data-href', resolveUrl(value, baseUrl));
          element.setAttribute(attr.name, 'javascript:void(0)');
        }
        continue;
      }
      if (name === 'src') {
        const value = attr.value.trim();
        if (dangerousSchemes.test(value)) {
          element.setAttribute(attr.name, '');
        } else {
          element.setAttribute(attr.name, resolveUrl(value, baseUrl));
        }
        continue;
      }
    }
  }
}

// After the rewrite above the only surviving href values are `javascript:void(0)`
// and `#fragment` links, and src values are resolved or emptied — all inert,
// but outside DOMPurify's URI allowlist. Force-keep them so they survive
// sanitization. The hook is added and removed around the synchronous sanitize
// call so it never leaks into other DOMPurify users.
function keepRewrittenUrlAttributes(_node: Element, hookEvent: UponSanitizeAttributeHookEvent): void {
  const name = hookEvent.attrName.toLowerCase();
  if (name === 'href' || name.endsWith(':href') || name === 'src') {
    hookEvent.forceKeepAttr = true;
  }
}

function unwrapImageAnchors(root: ParentNode): void {
  const anchors = Array.from(root.querySelectorAll('a'));
  for (const anchor of anchors) {
    const children = Array.from(anchor.childNodes);
    const onlyImage =
      children.length === 1 &&
      children[0].nodeType === Node.ELEMENT_NODE &&
      (children[0] as Element).tagName.toLowerCase() === 'img';
    if (!onlyImage) {
      continue;
    }
    const parent = anchor.parentNode;
    if (!parent) {
      continue;
    }
    parent.replaceChild(children[0], anchor);
  }
}

/**
 * Sanitize rendered markdown HTML for safe display inside a webview.
 *
 * - Removes dangerous tags (including `style`, `link`, `base`, `meta`) and event handlers.
 * - Neutralizes link hrefs (keeps the original URL in `data-href`); dangerous schemes
 *   become `javascript:void(0)`. Applies to both `href` and namespaced variants such as
 *   SVG `xlink:href`.
 * - Resolves relative image URLs against the configured base URL.
 * - Removes target attributes and inline style attributes.
 * - Unwraps `<a>` tags that only contain an `<img>` so images are not clickable.
 */
export function sanitizeMarkdownHtml(html: string, baseUrl?: string): string {
  const parser = new DOMParser();
  const doc = parser.parseFromString(html, 'text/html');
  rewriteUrlAttributes(doc, baseUrl);
  unwrapImageAnchors(doc);
  DOMPurify.addHook('uponSanitizeAttribute', keepRewrittenUrlAttributes);
  try {
    return DOMPurify.sanitize(doc.body.innerHTML, {
      FORBID_TAGS: dangerousTags,
      FORBID_ATTR: ['style', 'target'],
    });
  } finally {
    DOMPurify.removeHook('uponSanitizeAttribute');
  }
}
