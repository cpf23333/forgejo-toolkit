/**
 * Keyboard activation for rows rendered inside `<vscode-tree>`.
 *
 * The tree's host listens for `keydown` and, for Enter/Space, calls
 * `stopPropagation()` + `preventDefault()` on the component node before doing
 * its own item selection. A control nested in a tree item is therefore never
 * activated by the keyboard: the key event is consumed on the item (the node the
 * tree focuses), the browser's default activation is suppressed, and the tree
 * emits a select for an item whose action is not its selection.
 *
 * The escape hatch is a capture-phase listener on the tree host: it runs before
 * the tree's own (bubble-phase) listener on the same node, so stopping immediate
 * propagation there both activates the affordance and keeps the tree from
 * treating the key as selection. Arrow-key navigation is untouched - only
 * Enter/Space over a row that opted in is handled here.
 */

/**
 * Marks a `<vscode-tree-item>` whose primary action is its own click handler
 * (the dashboard and global search rows open a repository/issue/pull request).
 * A row without it is only activated when the caller names it in the row
 * selector, and then through the control it nests.
 */
export const TREE_ROW_ACTION_ATTRIBUTE = 'data-tree-row-action';

/** Selector for the rows whose primary action is the row's own click handler. */
export const TREE_ROW_ACTION_SELECTOR = `[${TREE_ROW_ACTION_ATTRIBUTE}]`;

/**
 * Controls the tree's keydown handler swallows. When one of them has focus the
 * key belongs to it (the browser would have activated it if the tree had not
 * consumed the event), so the row's own action must stay out of the way or the
 * press would fire two things at once.
 */
const NESTED_CONTROL_SELECTOR = 'button, a[href], input, select, textarea, [role="button"], [contenteditable="true"]';

/** The control a row without an action of its own offers instead. */
const ROW_CONTROL_SELECTOR = 'button';

/** The repository file browser's "show more" row. */
const SHOW_MORE_ROW_SELECTOR = '.tree-show-more-row';

/**
 * Handles a keydown that reached a tree host. Returns true when the key
 * activated a row, in which case the caller must not let the event reach the
 * tree's own selection handling.
 *
 * `rowSelector` names the rows that own the key. A row matched by it is
 * activated through its own click handler (see {@link TREE_ROW_ACTION_SELECTOR})
 * or, for a row that has no handler of its own, through the control it nests.
 * A key pressed inside a nested control of a named row activates that control
 * only.
 */
export function activateTreeRowFromKey(event: KeyboardEvent, rowSelector: string): boolean {
  if (event.key !== 'Enter' && event.key !== ' ') {
    return false;
  }
  const target = event.target;
  if (!(target instanceof HTMLElement) || typeof target.closest !== 'function') {
    return false;
  }

  const row = target.closest<HTMLElement>(rowSelector);
  if (!row) {
    return false;
  }

  // A nested control has focus: the tree consumed the key before the browser
  // could run the control's own activation, so fire that one and nothing else.
  const control = target.closest<HTMLElement>(NESTED_CONTROL_SELECTOR);
  if (control) {
    control.click();
    return true;
  }

  if (row.hasAttribute(TREE_ROW_ACTION_ATTRIBUTE)) {
    // The tree focuses the item, not the control inside it, so the row's own
    // click handler is what Enter/Space has to run.
    row.click();
    return true;
  }

  row.querySelector<HTMLElement>(ROW_CONTROL_SELECTOR)?.click();
  return true;
}

/**
 * The repository file browser's "show more" row: it has no action of its own,
 * only the nested button that reveals the next batch of entries.
 */
export function activateShowMoreRowFromKey(event: KeyboardEvent): boolean {
  return activateTreeRowFromKey(event, SHOW_MORE_ROW_SELECTOR);
}
