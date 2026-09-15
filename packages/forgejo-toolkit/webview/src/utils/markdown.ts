const dangerousTags = new Set([
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
]);
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

function sanitizeNode(node: Node, baseUrl?: string): Node | null {
  if (node.nodeType === Node.ELEMENT_NODE) {
    const element = node as Element;
    const tagName = element.tagName.toLowerCase();

    if (dangerousTags.has(tagName)) {
      return null;
    }

    const attributes = Array.from(element.attributes);
    for (const attr of attributes) {
      const name = attr.name.toLowerCase();
      if (name.startsWith('on')) {
        element.removeAttribute(attr.name);
        continue;
      }
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
      if (name === 'target') {
        element.removeAttribute(attr.name);
        continue;
      }
      if (name === 'style') {
        element.removeAttribute(attr.name);
        continue;
      }
    }

    const children = Array.from(element.childNodes);
    for (const child of children) {
      const sanitized = sanitizeNode(child, baseUrl);
      if (sanitized !== child) {
        if (sanitized) {
          element.replaceChild(sanitized, child);
        } else {
          element.removeChild(child);
        }
      }
    }
  }
  return node;
}

function unwrapImageAnchors(doc: Document): void {
  const anchors = Array.from(doc.querySelectorAll('a'));
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
  const children = Array.from(doc.body.childNodes);
  for (const child of children) {
    if (sanitizeNode(child, baseUrl) === null) {
      doc.body.removeChild(child);
    }
  }
  unwrapImageAnchors(doc);
  return doc.body.innerHTML;
}
