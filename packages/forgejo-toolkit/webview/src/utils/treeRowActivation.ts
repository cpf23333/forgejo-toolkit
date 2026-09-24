/**
 * Keyboard activation for the "show more" rows rendered inside `<vscode-tree>`.
 *
 * The tree's host listens for `keydown` and, for Enter/Space, calls
 * `stopPropagation()` + `preventDefault()` on the component node before doing
 * its own item selection. A `<button>` nested in a tree item is therefore never
 * activated by the keyboard: the key event is consumed on the item (the node the
 * tree focuses), the browser's default button activation is suppressed, and the
 * tree emits a select for an item without file metadata instead.
 *
 * The escape hatch is a capture-phase listener on the tree host: it runs before
 * the tree's own (bubble-phase) listener on the same node, so stopping immediate
 * propagation there both activates the affordance and keeps the tree from
 * treating the key as selection. Arrow-key navigation is untouched - only
 * Enter/Space over a "show more" row is handled here.
 */
const SHOW_MORE_ROW_SELECTOR = '.tree-show-more-row';

/** Whether `node` sits inside a "show more" row. */
function isInShowMoreRow(node: EventTarget | null): node is HTMLElement {
  if (!(node instanceof HTMLElement)) {
    return false;
  }
  // A guard for the test environment's simpler nodes as well as detached ones.
  if (typeof node.closest !== 'function') {
    return false;
  }
  return node.closest(SHOW_MORE_ROW_SELECTOR) !== null;
}

/**
 * Handle a keydown that reached a tree host. Returns true when the key activated
 * a "show more" row, in which case the caller must not let the event reach the
 * tree's own selection handling.
 */
export function activateShowMoreRowFromKey(event: KeyboardEvent): boolean {
  if (event.key !== 'Enter' && event.key !== ' ') {
    return false;
  }
  if (!isInShowMoreRow(event.target)) {
    return false;
  }
  // The tree consumes the key on the item, not the nested button, so the
  // browser never runs its default activation: fire it here.
  (event.target as HTMLElement).closest<HTMLElement>(SHOW_MORE_ROW_SELECTOR)?.querySelector('button')?.click();
  return true;
}
