import { describe, it, expect, vi } from 'vitest';
import { activateShowMoreRowFromKey } from '../treeRowActivation';

/**
 * The "show more" rows of the repository file browser live inside a
 * `<vscode-tree>`. The tree's host consumes Enter/Space on the tree item it
 * focuses, so a nested `<button>` never gets the browser's own keyboard
 * activation; this helper is the capture-phase escape hatch (see the module
 * comment). The markup mirrors the stub the component tests render.
 */
function showMoreRow(): { row: HTMLElement; button: HTMLButtonElement } {
  const tree = document.createElement('div');
  tree.innerHTML =
    '<div data-stub="vscode-tree">' +
    '<div data-stub="vscode-tree-item" class="tree-show-more-row">' +
    '<button type="button" class="tree-show-more">Show more</button>' +
    '</div>' +
    '</div>';
  document.body.append(tree);
  const row = tree.querySelector<HTMLElement>('.tree-show-more-row')!;
  return { row, button: row.querySelector('button')! };
}

function keydown(target: EventTarget, key: string): KeyboardEvent {
  const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
  // `event.target` is only set while the event is being dispatched, which is
  // exactly how the handler reads it.
  target.dispatchEvent(event);
  return event;
}

describe('activateShowMoreRowFromKey', () => {
  it('activates the nested button on Enter and Space from inside the row', () => {
    const { row, button } = showMoreRow();
    const onClick = vi.fn();
    button.addEventListener('click', onClick);

    expect(activateShowMoreRowFromKey(keydown(button, 'Enter'))).toBe(true);
    expect(activateShowMoreRowFromKey(keydown(button, ' '))).toBe(true);
    // The tree focuses the item, so the event may target the row itself.
    expect(activateShowMoreRowFromKey(keydown(row, 'Enter'))).toBe(true);
    expect(onClick).toHaveBeenCalledTimes(3);
    row.remove();
  });

  it('leaves other keys and other rows to the tree', () => {
    const { row } = showMoreRow();
    const plainRow = document.createElement('div');
    plainRow.innerHTML = '<button type="button">README.md</button>';
    document.body.append(plainRow);
    const plainButton = plainRow.querySelector('button')!;
    const onClick = vi.fn();
    plainButton.addEventListener('click', onClick);

    // Arrow keys and Tab drive the tree's own navigation.
    expect(activateShowMoreRowFromKey(keydown(row, 'ArrowDown'))).toBe(false);
    // Enter over a normal row is the tree's item selection, not this helper's.
    expect(activateShowMoreRowFromKey(keydown(plainButton, 'Enter'))).toBe(false);
    expect(onClick).not.toHaveBeenCalled();
    row.remove();
    plainRow.remove();
  });

  it('reports nothing to activate when the row has no control', () => {
    const { row } = showMoreRow();
    row.querySelector('button')!.remove();

    expect(activateShowMoreRowFromKey(keydown(row, 'Enter'))).toBe(true);
    expect(activateShowMoreRowFromKey(keydown(document.body, 'Enter'))).toBe(false);
    row.remove();
  });
});
