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
// What a rewritten href is left holding: everything real moves to `data-href`,
// so the surviving `href` is inert. A link neutralized this way (a dangerous
// scheme) has no `data-href` at all and is unwrapped like one the host cannot
// open (see unwrapUnopenableAnchors).
const NEUTRALIZED_HREF = 'javascript:void(0)';

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
          element.setAttribute(attr.name, NEUTRALIZED_HREF);
        } else if (value.startsWith('#')) {
          element.setAttribute(attr.name, value);
        } else {
          element.setAttribute('data-href', resolveUrl(value, baseUrl));
          element.setAttribute(attr.name, NEUTRALIZED_HREF);
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

/**
 * Whether the webview's host would actually open this URL. `openExternal`
 * accepts `http:`/`https:` only (see the host's dispatch), so a `mailto:`,
 * `file:` or `vscode:` target — and a protocol-relative `//host/path`, which has
 * no scheme of its own — is refused host-side with a log line.
 */
export function isOpenableUrl(value: string): boolean {
  try {
    const scheme = new URL(value).protocol;
    return scheme === 'http:' || scheme === 'https:';
  } catch {
    return false;
  }
}

/**
 * Replaces an anchor the host cannot open — or one the sanitizer neutralized —
 * with its own content, so the text stays and the link stops looking live.
 *
 * An anchor whose `data-href` the host would refuse used to keep rendering with
 * link styling while the click handler emitted `openExternal` for a
 * `mailto:`/`file:`/`vscode:` target the host then refused: the user clicked and
 * nothing happened, with no explanation anywhere in the UI.
 *
 * A dangerous-scheme href (`javascript:`, `data:text/html`, …) has no
 * `data-href` at all — the rewrite above already replaced it with
 * `javascript:void(0)` — so nothing unwrapped it: it rendered in link colour,
 * stayed a tab stop, and did nothing at all when activated. Such an anchor is
 * unwrapped on the same evidence (its surviving href is the neutralized
 * placeholder). A fragment (`#…`) href is the one inert href that is a real
 * destination, and it is kept.
 */
function unwrapUnopenableAnchors(root: ParentNode): void {
  for (const anchor of Array.from(root.querySelectorAll('a'))) {
    const target = anchor.getAttribute('data-href');
    if (target !== null && isOpenableUrl(target)) {
      continue;
    }
    const hrefs = anchorHrefValues(anchor);
    // No href at all is inert already (and may be an `id`/`name` target), so
    // only an anchor that really carries the neutralized placeholder is a link
    // this webview produced and can undo.
    const deadLink = target !== null || (hrefs.length > 0 && hrefs.every((value) => value === NEUTRALIZED_HREF));
    if (!deadLink) {
      continue;
    }
    const parent = anchor.parentNode;
    if (!parent) {
      continue;
    }
    for (const child of Array.from(anchor.childNodes)) {
      parent.insertBefore(child, anchor);
    }
    parent.removeChild(anchor);
  }
}

/** Every `href`-ish value an anchor carries (`href` and SVG's `xlink:href`). */
function anchorHrefValues(anchor: Element): string[] {
  return Array.from(anchor.attributes)
    .filter((attr) => {
      const name = attr.name.toLowerCase();
      return name === 'href' || name.endsWith(':href');
    })
    .map((attr) => attr.value.trim());
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
 * - Unwraps `<a>` tags that only contain an `<img>` so images are not clickable,
 *   and `<a>` tags whose target the host cannot open (see isOpenableUrl) so a
 *   `mailto:`/`file:`/`vscode:` link renders as plain text instead of a live
 *   looking link that does nothing — and, the same way, an anchor the rewrite
 *   above neutralized (a dangerous-scheme href), which used to keep link colour
 *   and a tab stop while activating it did nothing.
 */
export function sanitizeMarkdownHtml(html: string, baseUrl?: string): string {
  const parser = new DOMParser();
  const doc = parser.parseFromString(html, 'text/html');
  rewriteUrlAttributes(doc, baseUrl);
  unwrapImageAnchors(doc);
  unwrapUnopenableAnchors(doc);
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
