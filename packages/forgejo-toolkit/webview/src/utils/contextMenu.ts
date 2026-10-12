/**
 * The webview-side half of VS Code's contributed context menus.
 *
 * A `webview/context` menu item runs in the extension host, so the host has to be
 * told *which* row the reader right-clicked. VS Code is the carrier: an element that
 * carries `data-vscode-context` (JSON) publishes that object as context keys for the
 * menu, and hands the same object to the command as its first argument (the injected
 * listener walks from the target up through `closest('[data-vscode-context]')`,
 * accumulating nearest-first — see the Webview API's "Context menus" section and
 * `docs/architecture/README.md`). This module is the one place that spells what a row
 * publishes, so a row cannot invent a key the manifest's `when` clauses cannot see,
 * and the policy in `nativeContextMenu.ts` can recognise "one of our rows" without
 * repeating the section names.
 *
 * Two rules hold here:
 *
 * 1. **`preventDefaultContextMenuItems: true` is part of every marker.** VS Code
 *    contributes its own Cut / Copy / Paste to the same `webview/context` menu, gated
 *    on `when: !preventDefaultContextMenuItems`; without this key, un-suppressing the
 *    menu for a row would hand the reader the three platform entries the suppression
 *    existed to remove, beside our items. The policy stops calling `preventDefault()`
 *    for a marked element — and that is the other half of the same condition, because
 *    VS Code's injected listener returns early on `defaultPrevented` and shows no menu
 *    at all then, ours included.
 * 2. **The marker carries identity, and the host treats all of it as untrusted.** A
 *    webview is not trusted input anywhere else in this repository and is not trusted
 *    here either: the values travel so the host can *find* the entity, and the host
 *    re-validates every one of them before it navigates, copies or opens anything.
 */

/** The attribute VS Code reads to build a webview context menu's context keys. */
export const VSCODE_CONTEXT_ATTRIBUTE = 'data-vscode-context';

/** The context key VS Code's own documentation uses to name one section of a webview. */
export const CONTEXT_MENU_SECTION_KEY = 'webviewSection';

/**
 * The row families this extension publishes, one `webviewSection` value each.
 *
 * The list is the single source of truth for both halves: a row is allowed through
 * the suppression policy exactly while its section is here, and the manifest's
 * `when` clauses name these same strings. Batch 1 covers the four below; the settings
 * page's instance and endpoint rows, the pre-review suggestion list and the log and
 * diff text are deliberately not here yet (`TODO.md`'s inventory entry).
 */
export const CONTEXT_MENU_SECTIONS = ['repositoryRow', 'pullRequestRow', 'issueRow', 'notificationRow'] as const;

/** One value of {@link CONTEXT_MENU_SECTIONS}. */
export type ContextMenuSection = (typeof CONTEXT_MENU_SECTIONS)[number];

/**
 * What one row publishes, and therefore what the host's commands receive.
 *
 * The keys are prefixed on purpose: VS Code puts every key of this object into a
 * **global** context-key namespace for the duration of the menu, and a bare `index`
 * or `type` would collide with whatever else is asking about those names.
 */
export interface ContextMenuContext {
  webviewSection: ContextMenuSection;
  /** The configured instance the row belongs to. */
  forgejoInstanceId: string;
  forgejoOwner?: string;
  forgejoRepo?: string;
  /** The issue or pull request number. */
  forgejoIndex?: number;
  /** The notification's own id, for the "Mark as Read" item. */
  forgejoNotificationId?: number;
  /**
   * The notification's subject type, when the row declares one: `issue` or `pull`.
   *
   * It is a context key rather than something the command works out, because the
   * `when` clause is what decides whether "Open Issue" or "Open Pull Request" is the
   * item on a notification row at all.
   */
  forgejoSubjectType?: 'issue' | 'pull';
}

/**
 * The `data-vscode-context` value for one row.
 *
 * `preventDefaultContextMenuItems` is added here rather than by each caller: it is the
 * half of the mechanism that keeps the platform's three entries off a row, and a row
 * that forgot it would silently bring them back.
 *
 * **A row that contains an editable field must not take this default.** The key travels
 * with the row's marker, so a field inside it would lose Cut / Copy / Paste as well —
 * and no policy change can help, because the platform entries are gated on the context
 * VS Code accumulates, not on this extension's predicate. The mechanism's own answer is
 * a deeper marker on the field (`contextMenuAttribute` without the key, i.e. the field's
 * own object wins nearest-first); batch 1's four rows carry no editable field, and the
 * settings rows, which do, are still deferred (`TODO.md`'s inventory entry).
 */
export function contextMenuAttribute(context: ContextMenuContext): string {
  return JSON.stringify({ ...context, preventDefaultContextMenuItems: true });
}

/**
 * The section the nearest `data-vscode-context` marker in scope declares, when it is
 * one of ours.
 *
 * "Nearest" is by VS Code's own walk order — the element first, then outwards — which
 * is also why this cannot be a single `closest()`: `closest` stops at a **shadow
 * boundary**, and a `vscode-*` row's marker sits on the host while the pointer lands on
 * shadow-owned content inside it (`vscode-tree-item`'s own internals). A plain
 * `closest()` finds nothing there, the policy then keeps preventing the event, and the
 * row loses its menu entirely. The loop therefore searches the element's own tree, then
 * hops to `getRootNode().host` and searches the next tree out — the closest equivalent
 * of VS Code's `closest` + `parentElement` walk that a shadow boundary allows.
 *
 * The **first** marker found decides, and only a section this extension publishes may
 * un-suppress the platform menu: a foreign or unparsable marker returns `undefined`
 * rather than falling through to an outer one, because VS Code's own accumulation would
 * let the deeper marker's `webviewSection` win the `when` clauses anyway.
 */
export function contextMenuSectionOf(element: Element): ContextMenuSection | undefined {
  for (let current: Element | null = element; current !== null; current = shadowHostOf(current)) {
    const carrier = current.closest(`[${VSCODE_CONTEXT_ATTRIBUTE}]`);
    if (carrier !== null) {
      return sectionOfCarrier(carrier);
    }
  }
  return undefined;
}

/** The host of `element`'s shadow root, or `null` when it is not inside one. */
function shadowHostOf(element: Element): Element | null {
  if (typeof ShadowRoot === 'undefined') {
    return null;
  }
  const root = element.getRootNode();
  return root instanceof ShadowRoot ? root.host : null;
}

/** The section one marker carrier declares, or `undefined` when it declares none of ours. */
function sectionOfCarrier(carrier: Element): ContextMenuSection | undefined {
  const raw = carrier.getAttribute(VSCODE_CONTEXT_ATTRIBUTE);
  if (raw === null) {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (typeof parsed !== 'object' || parsed === null) {
    return undefined;
  }
  const section = (parsed as { [CONTEXT_MENU_SECTION_KEY]?: unknown })[CONTEXT_MENU_SECTION_KEY];
  return CONTEXT_MENU_SECTIONS.find((candidate) => candidate === section);
}
