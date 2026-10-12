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
 * 3. **A field inside a marked row gets its own deeper marker.**
 *    `preventDefaultContextMenuItems` travels with the row, and VS Code resolves each
 *    key from the clicked element outwards with the nearest value winning — so a field
 *    in that row would lose Cut / Copy / Paste unless it declares the key back to
 *    `false` itself ({@link contextMenuFieldAttribute}).
 */

/** The attribute VS Code reads to build a webview context menu's context keys. */
export const VSCODE_CONTEXT_ATTRIBUTE = 'data-vscode-context';

/** The section key VS Code's own documentation uses to name one section of a webview. */
export const CONTEXT_MENU_SECTION_KEY = 'webviewSection';

/**
 * The log marker's key holding the selected text.
 *
 * Exported so the policy can compare it with the live selection at click time without
 * spelling the key a second time (`nativeContextMenu.ts`).
 */
export const CONTEXT_MENU_LOG_TEXT_KEY = 'forgejoLogText';

/**
 * VS Code's key for its own Cut / Copy / Paste entries in a webview's context menu.
 *
 * Its own contributions are gated on `when: !preventDefaultContextMenuItems`, so this is
 * both the switch that hides them for a row and the switch that brings them back for a
 * field inside one.
 */
export const CONTEXT_MENU_PLATFORM_ITEMS_KEY = 'preventDefaultContextMenuItems';

/**
 * The sections this extension publishes, one `webviewSection` value each.
 *
 * The list is the single source of truth for both halves: an element is allowed through
 * the suppression policy exactly while its section is here, and the manifest's `when`
 * clauses name these same strings. It covers the four sidebar row families
 * (`repositoryRow`, `pullRequestRow`, `issueRow`, `notificationRow`), the settings page's
 * saved-instance and endpoint rows and the pre-review panel's suggestion cards
 * (`settingsInstanceRow`, `settingsEndpointRow`, `preReviewSuggestion`), and the job log
 * (`runLog`).
 *
 * The log is the one section that is **not a row**: it is prose, and the marker only
 * exists while a non-empty selection is inside it ({@link logSelectionAttribute}),
 * because the measurement is that VS Code contributes nothing at all to a `<pre>`'s menu
 * — a marker present without a selection would open an empty menu. The pull request diff
 * **body** is deliberately not a section: it opens in VS Code's native diff editor, not
 * in a webview, so there is no webview text to act on.
 */
export const CONTEXT_MENU_SECTIONS = [
  'repositoryRow',
  'pullRequestRow',
  'issueRow',
  'notificationRow',
  'settingsInstanceRow',
  'settingsEndpointRow',
  'preReviewSuggestion',
  'runLog',
] as const;

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
  forgejoInstanceId?: string;
  /** The configured AI endpoint a settings row belongs to. */
  forgejoProviderId?: string;
  /**
   * The AI pre-review panel a suggestion card belongs to.
   *
   * The panel is not a singleton — each run opens its own — so this id is what routes an
   * item to the panel that was right-clicked instead of to the newest one
   * (src/aiPreReviewPanelRegistry.ts).
   */
  forgejoPanelId?: string;
  /** The suggestion card's index, inside that panel's payload. */
  forgejoSuggestionIndex?: number;
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
  /**
   * Set by the job log's marker: there is a non-empty selection to copy.
   *
   * The key only ever appears as `true` — the marker itself exists only while a selection
   * does — and it exists so the manifest can gate the item on the fact rather than on the
   * marker's presence.
   */
  forgejoLogSelection?: boolean;
  /** The selected log text, capped; the host copies exactly this. */
  forgejoLogText?: string;
}

/**
 * The `data-vscode-context` value for one row.
 *
 * `preventDefaultContextMenuItems` is added here rather than by each caller: it is the
 * half of the mechanism that keeps the platform's three entries off a row, and a row
 * that forgot it would silently bring them back.
 *
 * **A marked element that contains an editable field also gives that field
 * {@link contextMenuFieldAttribute}**, which is what keeps the field's own Cut / Copy /
 * Paste. No shipped marker has that shape today except the AI pre-review card: the
 * settings page's instance and endpoint rows contain no `input`, `textarea` or
 * `vscode-textfield` at all — the page's fields live in the **forms outside** those rows,
 * which carry no marker — and the only embedded field anywhere is that card's body
 * editor. The rule is kept for the next surface that puts a field inside a marked row,
 * and `nativeContextMenu.markedRows.test.ts` pins both halves of it.
 */
export function contextMenuAttribute(context: ContextMenuContext): string {
  return JSON.stringify({ ...context, [CONTEXT_MENU_PLATFORM_ITEMS_KEY]: true });
}

/**
 * The `data-vscode-context` value for an **editable field inside a marked row**.
 *
 * The row's marker hides the platform's three entries, and VS Code resolves each key
 * from the clicked element outwards with the nearest value winning — so without this a
 * field inside a marked row would lose Cut / Copy / Paste. This marker sets the key back
 * to `false` and deliberately declares **no `webviewSection`**: the row's section (and
 * so the row's own items) still applies to the field's tree, while the platform's three
 * come back. No predicate change could have achieved it — those entries are gated on the
 * context VS Code accumulates, not on this extension's policy.
 *
 * The one shipped use is the **AI pre-review card's body editor**, which is the only
 * embedded field this extension puts inside a marked element (the settings rows contain
 * none). It is general on purpose: the next surface that embeds a field in a marked row
 * needs it too, and the test that models VS Code's accumulation guards the rule.
 */
export function contextMenuFieldAttribute(): string {
  return JSON.stringify({ [CONTEXT_MENU_PLATFORM_ITEMS_KEY]: false });
}

/**
 * What the job log publishes in `data-vscode-context`, or `undefined` when it should
 * publish nothing.
 *
 * The measurement that shapes this: VS Code contributes **no** entries of its own to a
 * `<pre>`'s context menu (with or without a selection the menu is empty), and this
 * extension's policy suppresses the menu unless the element is editable, selected or
 * marked. So a selection inside the log would otherwise produce nothing to click, and an
 * item that could only no-op must not appear. The marker is therefore published **only
 * while a non-empty selection exists**: with one, the section lets the policy through and
 * the `Copy` item (gated on `forgejoLogSelection`) appears; without one, there is no
 * marker at all, the policy keeps suppressing, and the log behaves exactly as it did
 * before this item existed.
 *
 * `forgejoLogSelection` is always `true` in a marker that exists — it is a context key the
 * manifest's `when` clause tests. The clause is deliberately about **the fact the marker
 * carries**, not about a live selection: the webview re-reads the selection on
 * `selectionchange` and removes the marker when it is gone, so a stale marker is one
 * somebody planted by hand, and the most it can do is copy exactly the text it carries —
 * never another element's selection. The host re-validates both fields for that reason.
 *
 * The selected **text** travels too, because the menu item runs in the extension host and
 * cannot read the webview's selection. It is carried **whole or not at all**: a selection
 * over {@link CONTEXT_MENU_LOG_SELECTION_MAX_CHARS} publishes no marker, so the item is
 * not offered and the reader keeps the status quo (no menu; Ctrl+C copies the selection).
 * Silently putting a truncated log on the clipboard would be the one outcome nobody can
 * see or undo.
 *
 * `preventDefaultContextMenuItems: true` (added by {@link contextMenuAttribute}) costs
 * nothing here and is kept for consistency: it only hides entries VS Code would add
 * itself, and on a `<pre>` it adds none — the measured empty menu is the proof, not a
 * reason to leave the key off.
 */
export function logSelectionAttribute(selectionText: string): string | undefined {
  if (selectionText.trim() === '' || selectionText.length > CONTEXT_MENU_LOG_SELECTION_MAX_CHARS) {
    return undefined;
  }
  return contextMenuAttribute({
    webviewSection: 'runLog',
    forgejoLogSelection: true,
    forgejoLogText: selectionText,
  });
}

/**
 * The most a log selection may be for its marker to exist.
 *
 * A menu attribute is not a place for an unbounded document, and a selection of a job log
 * can be the whole log; a million characters is what a clipboard carries comfortably, and
 * the bound is a **refusal** rather than a cut: over it, no marker is published at all
 * (see {@link logSelectionAttribute}), so nothing is ever copied partially and without a
 * word. The host keeps the same bound as its own refusal of a forged marker.
 */
export const CONTEXT_MENU_LOG_SELECTION_MAX_CHARS = 1_000_000;

/**
 * The section of the **nearest marker that declares one**, when it is one of ours.
 *
 * "Nearest" is by VS Code's own walk order — the element first, then outwards — which is
 * also why this cannot be a single `closest()`: `closest` stops at a **shadow boundary**,
 * and a `vscode-*` row's marker sits on the host while the pointer lands on shadow-owned
 * content inside it (`vscode-tree-item`'s own internals). A plain `closest()` finds
 * nothing there, the policy then keeps preventing the event, and the row loses its menu
 * entirely. The loop therefore walks the element's own tree, then hops to
 * `getRootNode().host` and continues in the next tree out.
 *
 * A marker that declares **no** `webviewSection` does not decide: it is how a field
 * inside a row restores the platform entries while still belonging to the row's section
 * (VS Code accumulates every marker in the chain, nearest value per key). A marker that
 * declares a **foreign** section does decide — `undefined` — because VS Code would use
 * that value for the `when` clauses, so un-suppressing on the strength of an outer marker
 * would show a menu with none of our items in it. An unparsable marker is skipped, which
 * is what VS Code's own parse failure does.
 */
export function contextMenuSectionOf(element: Element): ContextMenuSection | undefined {
  const carrier = contextMenuSectionCarrierOf(element);
  if (carrier === null) {
    return undefined;
  }
  const marker = markerOf(carrier);
  return marker === undefined
    ? undefined
    : CONTEXT_MENU_SECTIONS.find((candidate) => candidate === marker[CONTEXT_MENU_SECTION_KEY]);
}

/**
 * The nearest element whose marker **declares a section**, by the same outward walk.
 *
 * It exists for the one caller that has to look at a marker's *other* keys before the
 * event continues: the policy checks the job log's carried text against the live
 * selection and withdraws the marker when they disagree
 * (`nativeContextMenu.ts`). Returning the element rather than a section is what lets that
 * caller read and, when it must, remove the attribute.
 */
export function contextMenuSectionCarrierOf(element: Element): Element | null {
  for (let node: Element | null = element; node !== null; node = nextElementOutward(node)) {
    if (!node.hasAttribute(VSCODE_CONTEXT_ATTRIBUTE)) {
      continue;
    }
    const marker = markerOf(node);
    if (marker === undefined) {
      continue;
    }
    if (CONTEXT_MENU_SECTION_KEY in marker) {
      return node;
    }
  }
  return null;
}

/** The next element outward from `node`, crossing a shadow boundary when there is one. */
function nextElementOutward(node: Element): Element | null {
  if (node.parentElement !== null) {
    return node.parentElement;
  }
  return shadowHostOf(node);
}

/** The host of `element`'s shadow root, or `null` when it is not inside one. */
function shadowHostOf(element: Element): Element | null {
  if (typeof ShadowRoot === 'undefined') {
    return null;
  }
  const root = element.getRootNode();
  return root instanceof ShadowRoot ? root.host : null;
}

/** One marker's parsed object, or `undefined` when it cannot be parsed as one. */
function markerOf(carrier: Element): Record<string, unknown> | undefined {
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
  return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : undefined;
}
