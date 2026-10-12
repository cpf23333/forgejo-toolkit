import { afterEach, describe, expect, it } from 'vitest';
import { allowsNativeContextMenu, installNativeContextMenuPolicy } from '../nativeContextMenu';
import { contextMenuAttribute, contextMenuSectionOf } from '../contextMenu';

/**
 * The policy's third exception: one of **our own rows**, recognised by its
 * `data-vscode-context` marker.
 *
 * This is the half of the contributed-context-menu mechanism that lives in the
 * webview, and it is the half a reader cannot check from VS Code's source: VS Code's
 * injected listener returns early when the event was already `preventDefault`ed, so a
 * marked row only gets a menu — ours, with `preventDefaultContextMenuItems: true`
 * keeping the platform's Cut / Copy / Paste off it — while the policy lets the event
 * through. The other two exceptions are re-pinned here beside it, because the change
 * that added this one is exactly the change that could have broken them.
 */

const mounted: HTMLElement[] = [];

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

const REPOSITORY_MARKER = contextMenuAttribute({
  webviewSection: 'repositoryRow',
  forgejoInstanceId: 'inst-1',
  forgejoOwner: 'demo-user',
  forgejoRepo: 'demo-repo',
});

describe('the policy on a marked row', () => {
  it('lets the event through on a marked row and its descendants', () => {
    const container = mount(
      `<div class="repo-row" data-vscode-context='${REPOSITORY_MARKER}'><span class="name">demo-repo</span></div>`,
    );

    // The row itself, and anything inside it: VS Code resolves the context through
    // `closest`, so a click on the title belongs to the same item.
    expect(allowsNativeContextMenu(container.querySelector('.repo-row'), '')).toBe(true);
    expect(allowsNativeContextMenu(container.querySelector('.name'), '')).toBe(true);
  });

  it('actually leaves the event unprevented, which is what opens the menu at all', () => {
    const container = mount(
      `<div class="repo-row" data-vscode-context='${REPOSITORY_MARKER}'><span class="name">demo-repo</span></div>`,
    );
    const uninstall = installNativeContextMenuPolicy(window);
    try {
      // VS Code's own listener sits on the same window and returns early on
      // `defaultPrevented`; an unprevented event is the whole precondition for the
      // contributed items to appear.
      expect(contextMenuOn(container.querySelector('.name')!).defaultPrevented).toBe(false);
      // A plain row in the same document is still suppressed.
      const plain = mount('<div class="card">nothing to do with a repository</div>');
      expect(contextMenuOn(plain.querySelector('.card')!).defaultPrevented).toBe(true);
    } finally {
      uninstall();
    }
  });

  it('keeps suppressing a plain row, and a marker that is not ours', () => {
    const container = mount(
      '<div class="plain-row"><span class="name">demo-repo</span></div>' +
        '<div class="foreign" data-vscode-context=\'{"webviewSection":"somethingElse"}\'><span>x</span></div>' +
        '<div class="broken" data-vscode-context="{not json"><span>x</span></div>',
    );

    expect(allowsNativeContextMenu(container.querySelector('.plain-row'), '')).toBe(false);
    expect(allowsNativeContextMenu(container.querySelector('.name'), '')).toBe(false);
    // Only a section this build publishes may un-suppress the platform menu.
    expect(allowsNativeContextMenu(container.querySelector('.foreign'), '')).toBe(false);
    expect(allowsNativeContextMenu(container.querySelector('.broken'), '')).toBe(false);
  });

  it('lets the event through when the pointer lands on a marked row’s shadow-owned content', () => {
    // The regression the live walk found: a row's marker is on its `vscode-*` host, and
    // a right click on the host's own internals reports a shadow-owned target. The
    // policy must not prevent the event there, or the row loses its menu entirely —
    // contributed items included — because VS Code's listener returns early on
    // `defaultPrevented`.
    const host = document.createElement('div');
    host.className = 'shadow-row';
    host.setAttribute('data-vscode-context', REPOSITORY_MARKER);
    const shadow = host.attachShadow({ mode: 'open' });
    const inner = document.createElement('span');
    inner.className = 'shadow-inner';
    const deepest = document.createElement('button');
    inner.append(deepest);
    shadow.append(inner);
    document.body.append(host);
    try {
      expect(allowsNativeContextMenu(inner, '')).toBe(true);
      expect(allowsNativeContextMenu(deepest, '')).toBe(true);

      const uninstall = installNativeContextMenuPolicy(window);
      try {
        // The same shape the walk reproduced: the event's response depends only on what
        // the policy decided for the shadow-owned target.
        expect(contextMenuOn(deepest).defaultPrevented).toBe(false);
      } finally {
        uninstall();
      }

      // A shadow host with no marker keeps the suppression, first tree and all.
      const plain = document.createElement('div');
      plain.className = 'plain-shadow-row';
      const plainShadow = plain.attachShadow({ mode: 'open' });
      const plainInner = document.createElement('span');
      plainShadow.append(plainInner);
      document.body.append(plain);
      const uninstall2 = installNativeContextMenuPolicy(window);
      try {
        expect(allowsNativeContextMenu(plainInner, '')).toBe(false);
        expect(contextMenuOn(plainInner).defaultPrevented).toBe(true);
      } finally {
        uninstall2();
      }
      plain.remove();
    } finally {
      host.remove();
    }
  });

  it('takes the nearest marker, so a row inside a marked page is the row that counts', () => {
    const pageMarker = contextMenuAttribute({
      webviewSection: 'repositoryRow',
      forgejoInstanceId: 'inst-page',
      forgejoOwner: 'page-owner',
      forgejoRepo: 'page-repo',
    });
    const innerMarker = contextMenuAttribute({
      webviewSection: 'issueRow',
      forgejoInstanceId: 'inst-1',
      forgejoOwner: 'demo-user',
      forgejoRepo: 'demo-repo',
      forgejoIndex: 7,
    });
    const container = mount(
      `<div class="page" data-vscode-context='${pageMarker}'>` +
        `<div class="row" data-vscode-context='${innerMarker}'><span class="title">#7</span></div>` +
        `<div class="bare"><span class="title">no marker of its own</span></div>` +
        '</div>',
    );

    // VS Code accumulates nearest-first, so the row's own section is the one the
    // `when` clauses see. The policy only has to agree that the nearest marker is
    // ours; "bare" inherits the page's marker, exactly as VS Code's walk would.
    expect(allowsNativeContextMenu(container.querySelector('.row'), '')).toBe(true);
    expect(allowsNativeContextMenu(container.querySelector('.bare'), '')).toBe(true);
    expect(contextMenuSectionOf(container.querySelector('.row')!)).toBe('issueRow');
    expect(contextMenuSectionOf(container.querySelector('.bare')!)).toBe('repositoryRow');
  });

  it('still keeps the menu on the two kinds of editable target', () => {
    const container = mount(
      '<input value="query" />' +
        '<textarea>body</textarea>' +
        '<div contenteditable="true"><span>editing</span></div>' +
        '<div class="CodeMirror"><div class="CodeMirror-line">a line</div></div>' +
        '<p class="selectable">select me</p>',
    );

    expect(allowsNativeContextMenu(container.querySelector('input'), '')).toBe(true);
    expect(allowsNativeContextMenu(container.querySelector('textarea'), '')).toBe(true);
    expect(allowsNativeContextMenu(container.querySelector('[contenteditable] span'), '')).toBe(true);
    expect(allowsNativeContextMenu(container.querySelector('.CodeMirror-line'), '')).toBe(true);
    const selectable = container.querySelector('.selectable')!;
    select(selectable);
    expect(allowsNativeContextMenu(selectable, 'select me')).toBe(true);
  });
});
