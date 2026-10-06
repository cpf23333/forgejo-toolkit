import { afterEach, describe, expect, it } from 'vitest';
import { allowsNativeContextMenu, installNativeContextMenuPolicy } from '../nativeContextMenu';

/**
 * The webview's context-menu policy (see the module comment): the browser's own
 * menu is suppressed everywhere except an editable field and a non-empty
 * selection. These are the cases the policy is defined by; the pinning of the
 * CodeMirror clause carries the reason it exists.
 */

/** Every container a case mounted, removed again after it. */
const mounted: HTMLElement[] = [];

/** Appends `html` to the document and returns the container. */
function mount(html: string): HTMLElement {
  const container = document.createElement('div');
  container.innerHTML = html;
  document.body.append(container);
  mounted.push(container);
  return container;
}

afterEach(() => {
  for (const container of mounted.splice(0)) {
    container.remove();
  }
  window.getSelection()?.removeAllRanges();
});

/** Selects the text content of `node`, so `getSelection()` is non-empty. */
function select(node: Node): void {
  const range = document.createRange();
  range.selectNodeContents(node);
  const selection = window.getSelection();
  if (!selection) {
    throw new Error('this environment has no Selection API');
  }
  selection.removeAllRanges();
  selection.addRange(range);
}

/** A right click on `target`, the way the browser delivers one. */
function contextMenuOn(target: EventTarget): MouseEvent {
  const event = new MouseEvent('contextmenu', { bubbles: true, cancelable: true, composed: true });
  target.dispatchEvent(event);
  return event;
}

describe('allowsNativeContextMenu', () => {
  it('suppresses the menu for a content block with nothing selected', () => {
    const container = mount('<div class="repo-row"><span class="name">forgejo-toolkit</span></div>');

    expect(allowsNativeContextMenu(container.querySelector('.repo-row'), '')).toBe(false);
    expect(allowsNativeContextMenu(container.querySelector('.name'), '')).toBe(false);
    expect(allowsNativeContextMenu(container, '')).toBe(false);
  });

  it('keeps the menu for an editable field', () => {
    const container = mount(
      '<input value="query" />' +
        '<textarea>body</textarea>' +
        '<div contenteditable=""><span class="inside">text</span></div>' +
        '<div contenteditable="true"><span class="inside">text</span></div>' +
        '<div contenteditable="plaintext-only"><span class="inside">text</span></div>',
    );
    const fields = [
      ...container.querySelectorAll('input, textarea'),
      ...container.querySelectorAll('[contenteditable]'),
      ...container.querySelectorAll('.inside'),
    ];

    expect(fields).toHaveLength(8);
    for (const field of fields) {
      expect(allowsNativeContextMenu(field, ''), field.outerHTML).toBe(true);
    }
  });

  it('suppresses the menu inside a read-only island of an editable region', () => {
    const container = mount(
      '<div contenteditable="true">' +
        '<span class="read-only" contenteditable="false"><span class="inside">pinned</span></span>' +
        '</div>',
    );

    expect(allowsNativeContextMenu(container.querySelector('.read-only'), '')).toBe(false);
    expect(allowsNativeContextMenu(container.querySelector('.inside'), '')).toBe(false);
  });

  it('keeps the menu when text is selected, wherever the click landed', () => {
    const container = mount('<div class="repo-row">forgejo-toolkit</div>');

    expect(allowsNativeContextMenu(container.querySelector('.repo-row'), 'forgejo-toolkit')).toBe(true);
    // A selection of whitespace is still a selection the user made.
    expect(allowsNativeContextMenu(container.querySelector('.repo-row'), ' ')).toBe(true);
    // And it wins over a target that carries no field: the predicate is the two
    // exceptions, not one of them.
    expect(allowsNativeContextMenu(null, 'forgejo-toolkit')).toBe(true);
  });

  it('suppresses the menu for a target that is not an element', () => {
    const container = mount('<div class="repo-row">forgejo-toolkit</div>');

    expect(allowsNativeContextMenu(null, '')).toBe(false);
    expect(allowsNativeContextMenu(container.querySelector('.repo-row')!.firstChild, '')).toBe(false);
    expect(allowsNativeContextMenu(document, '')).toBe(false);
  });

  it('keeps the menu inside the markdown editor, whose field is not the click target', () => {
    // CodeMirror 5 moves its hidden textarea under the pointer from inside the
    // `contextmenu` dispatch, so the editor keeps the browser's editing menu
    // while the event's target is the rendered line. Suppressing it here would
    // take paste away from every comment editor.
    const container = mount(
      '<div class="easy-mde-editor">' +
        '<div class="editor-toolbar"><button type="button">Bold</button></div>' +
        '<div class="CodeMirror"><div class="CodeMirror-lines">' +
        '<pre class="CodeMirror-line">a comment</pre>' +
        '</div></div>' +
        '</div>',
    );

    expect(allowsNativeContextMenu(container.querySelector('.CodeMirror'), '')).toBe(true);
    expect(allowsNativeContextMenu(container.querySelector('.CodeMirror-line'), '')).toBe(true);
    // The toolbar is a button row, not the editing surface.
    expect(allowsNativeContextMenu(container.querySelector('.editor-toolbar button'), '')).toBe(false);
  });
});

describe('installNativeContextMenuPolicy', () => {
  it("prevents a content block's contextmenu and leaves an input's alone", () => {
    const dispose = installNativeContextMenuPolicy(window);
    try {
      const container = mount('<div class="repo-row">forgejo-toolkit</div><input value="query" />');

      expect(contextMenuOn(container.querySelector('.repo-row')!).defaultPrevented).toBe(true);
      expect(contextMenuOn(container.querySelector('input')!).defaultPrevented).toBe(false);
    } finally {
      dispose();
    }
  });

  it("sees the field inside a custom element's shadow root", () => {
    // A `contextmenu` inside a shadow root is retargeted to the host, which is
    // not a field; the composed path is what keeps the policy from suppressing
    // the menu over every `vscode-textfield` in the webview.
    const dispose = installNativeContextMenuPolicy(window);
    try {
      const host = document.createElement('vscode-textfield');
      const field = document.createElement('input');
      host.attachShadow({ mode: 'open' }).append(field);
      document.body.append(host);
      mounted.push(host);

      expect(contextMenuOn(field).defaultPrevented).toBe(false);
      // The host on its own is a content block, so the policy still applies.
      expect(contextMenuOn(host).defaultPrevented).toBe(true);
    } finally {
      dispose();
    }
  });

  it('keeps the menu while the document has a selection, and suppresses it again after', () => {
    const dispose = installNativeContextMenuPolicy(window);
    try {
      const container = mount('<div class="repo-row">forgejo-toolkit</div>');
      const row = container.querySelector('.repo-row')!;

      select(row);
      expect(contextMenuOn(row).defaultPrevented).toBe(false);

      window.getSelection()!.removeAllRanges();
      expect(contextMenuOn(row).defaultPrevented).toBe(true);
    } finally {
      dispose();
    }
  });

  it('answers right clicks again only while it is installed', () => {
    const dispose = installNativeContextMenuPolicy(window);
    const container = mount('<div class="repo-row">forgejo-toolkit</div>');
    const row = container.querySelector('.repo-row')!;

    dispose();
    expect(contextMenuOn(row).defaultPrevented).toBe(false);
  });
});
