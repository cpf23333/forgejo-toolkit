/**
 * The webview's context-menu policy: which targets keep the browser's own menu.
 *
 * A right click inside a webview opens the platform's default editing menu —
 * 剪切 / 复制 / 粘贴 — wherever it lands. On the dashboard's rows (a repository, a
 * pull request, an issue, a notification, a saved instance) none of the three
 * items applies to the block under the cursor, so the menu covers the row and
 * offers nothing to do with it. The default is therefore to suppress the menu,
 * and exactly two kinds of target keep it:
 *
 * 1. a text control or an editing host — an `input`, a `textarea` (including the
 *    ones inside a `vscode-textfield` / `vscode-textarea` shadow root) or a
 *    `contenteditable` element. The menu's Cut / Copy / Paste belongs to a
 *    control rather than to a row; a checkbox or a range input rides along,
 *    because the menu there is harmless and second-guessing the platform over a
 *    field the user can operate buys nothing; and
 * 2. a non-empty text selection, where copying is what the right click is for.
 *
 * Everything else is suppressed. Suppression is the interim behaviour, not the
 * end state: these rows are meant to carry VS Code-native items later, which are
 * contributed through `contributes.menus` under `webview/context` and pointed at
 * the item under the cursor with `data-vscode-context`. Those items have to be
 * **added**, because the menu being suppressed here is the wrong menu rather
 * than a menu that is missing something. The two exceptions above are what such
 * items must not break — and an element that carries `data-vscode-context` is
 * where the predicate will have to start allowing the menu again. The shipped
 * policy is recorded in `docs/architecture/README.md`, the deferred inventory in
 * `TODO.md`'s 「P3 Webview 右键菜单的 VS Code 原生项（本次只做了抑制）」 entry.
 */

/** Text controls whose own editing commands the browser's menu serves. */
const TEXT_CONTROL_SELECTOR = 'input, textarea';

/**
 * The editing surface of the markdown editor (`EasyMdeEditor.vue`).
 *
 * CodeMirror 5's textarea input style keeps the native menu alive for the
 * editor: from inside the `contextmenu` dispatch it moves its hidden textarea to
 * a 30x30 box under the pointer and focuses it (`TextareaInput.onContextMenu`),
 * so the browser edits *that field*. The event's target is still the rendered
 * line — the box only moves after the target is fixed — which makes the editor
 * the one editing surface whose field is not an ancestor of the click. Without
 * this clause a right click in a comment editor would lose paste, which is the
 * exact command the exceptions exist to preserve.
 */
const CODE_EDITOR_SELECTOR = '.CodeMirror';

/** The targets whose own browser menu is worth keeping. */
const EDITABLE_TARGET_SELECTOR = `${TEXT_CONTROL_SELECTOR}, ${CODE_EDITOR_SELECTOR}`;

/** The attribute that turns an element into an editing host (HTML standard). */
const CONTENT_EDITABLE_ATTRIBUTE = 'contenteditable';

/**
 * Whether the browser's own context menu may stay for a right click that landed
 * on `target`, given the `selectionText` selected at that moment.
 *
 * See the module comment for what each half is for. `target` has to be the
 * deepest node of the event's composed path, not the retargeted `event.target`:
 * a `contextmenu` inside a custom element's shadow root reports the host, and
 * the editable field is the element inside it.
 */
export function allowsNativeContextMenu(target: EventTarget | null, selectionText: string): boolean {
  if (selectionText !== '') {
    return true;
  }

  const element = elementOf(target);
  if (element === null) {
    return false;
  }

  return element.closest(EDITABLE_TARGET_SELECTOR) !== null || hasEditableAncestor(element);
}

/**
 * Installs the policy on one surface's window, and returns the function that
 * removes it again (for tests; a webview document lives as long as its surface).
 *
 * The listener runs in the capture phase. `preventDefault()` is what removes the
 * browser's menu, and capturing means an inner handler that stops propagation
 * cannot leave the wrong menu standing; it never stops propagation itself, so a
 * component that opens its own menu on the same event still sees it.
 */
export function installNativeContextMenuPolicy(win: Window): () => void {
  const onContextMenu = (event: MouseEvent): void => {
    const [deepest] = event.composedPath();
    const selectedText = win.getSelection()?.toString() ?? '';
    if (!allowsNativeContextMenu(deepest ?? event.target, selectedText)) {
      event.preventDefault();
    }
  };

  win.addEventListener('contextmenu', onContextMenu, { capture: true });
  return () => win.removeEventListener('contextmenu', onContextMenu, { capture: true });
}

/**
 * The element a context-menu event landed in, or `null` for a target that cannot
 * be walked (`closest` is on `Element`; a text node, the document or the window
 * is not one).
 */
function elementOf(target: EventTarget | null): Element | null {
  const candidate = target as Element | null;
  return candidate !== null && typeof candidate.closest === 'function' ? candidate : null;
}

/**
 * Whether `element` sits inside an editing host.
 *
 * The nearest ancestor — or the element itself — that carries `contenteditable`
 * decides, and `contenteditable="false"` terminates the walk: a read-only island
 * inside an editable region is not editable, which is what the HTML standard's
 * `isContentEditable` reports as well. `contenteditable="inherit"` (and any
 * unknown value) inherits, so the walk continues upwards.
 */
function hasEditableAncestor(element: Element): boolean {
  for (let node: Element | null = element; node !== null; node = node.parentElement) {
    const value = node.getAttribute(CONTENT_EDITABLE_ATTRIBUTE);
    if (value === null || value === 'inherit') {
      continue;
    }
    return value !== 'false';
  }
  return false;
}
