import { afterEach, describe, expect, it } from 'vitest';
import { allowsNativeContextMenu, installNativeContextMenuPolicy } from '../nativeContextMenu';
import {
  contextMenuAttribute,
  contextMenuFieldAttribute,
  contextMenuSectionOf,
  logSelectionAttribute,
} from '../contextMenu';

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

  it('keeps the platform editing menu on a field inside a marked element, while the element keeps ours', () => {
    // The rule, pinned with a synthetic field: a marker hides VS Code's Cut / Copy /
    // Paste and the key travels with it, so a field inside a marked element would lose its
    // editing menu. The field's own deeper marker sets the key back — and because VS Code
    // resolves each key from the clicked element outwards with the nearest value winning,
    // the section still applies to the field, so our items stay too. The one shipped
    // surface with that shape is the AI pre-review card (the test below); no settings row
    // embeds a field, which is why this one is synthetic.
    const container = mount(
      `<div class="instance-row" data-vscode-context='${contextMenuAttribute({
        webviewSection: 'notificationRow',
        forgejoInstanceId: 'inst-1',
        forgejoNotificationId: 11,
      })}'>` +
        '<span class="row-label">demo-user@forgejo.example.com</span>' +
        `<input class="row-field" value="demo-user" data-vscode-context='${contextMenuFieldAttribute()}' />` +
        '</div>',
    );
    const row = container.querySelector('.instance-row')!;
    const label = container.querySelector('.row-label')!;
    const field = container.querySelector('.row-field')!;

    /**
     * VS Code's own accumulation: the walk goes from the clicked element outwards, and
     * each key keeps the value from the marker **nearest** the target (its listener does
     * `context = { ...parsed, ...context }`, so the value already in hand wins).
     */
    const accumulated = (target: Element): Record<string, unknown> => {
      const context: Record<string, unknown> = {};
      for (let node: Element | null = target; node !== null; node = node.parentElement) {
        const raw = node.getAttribute('data-vscode-context');
        if (raw === null) {
          continue;
        }
        for (const [key, value] of Object.entries(JSON.parse(raw) as Record<string, unknown>)) {
          if (!(key in context)) {
            context[key] = value;
          }
        }
      }
      return context;
    };

    // The row itself: ours only, no platform entries.
    expect(accumulated(label)).toMatchObject({ preventDefaultContextMenuItems: true });
    // The field: the platform entries come back, and the row's section is still in scope,
    // so the row's items remain offered beside them.
    expect(accumulated(field)).toMatchObject({
      preventDefaultContextMenuItems: false,
      webviewSection: 'notificationRow',
    });

    // And the policy agrees the event must reach VS Code for all three.
    expect(allowsNativeContextMenu(row, '')).toBe(true);
    expect(allowsNativeContextMenu(label, '')).toBe(true);
    expect(allowsNativeContextMenu(field, '')).toBe(true);
    expect(contextMenuSectionOf(field)).toBe('notificationRow');

    const uninstall = installNativeContextMenuPolicy(window);
    try {
      expect(contextMenuOn(field).defaultPrevented).toBe(false);
    } finally {
      uninstall();
    }
  });

  it('keeps the editing menu on a suggestion card’s own editor, while the card keeps its items', () => {
    // The second surface with a field inside a marked row: the AI pre-review card's body
    // editor. Same shape as the settings case above — the card's marker hides VS Code's
    // three entries, the textarea's own marker brings them back, and the card's section
    // (with its panel id) stays in scope so "Copy Suggested Comment" and "Open in Diff"
    // still apply to the field's tree.
    const container = mount(
      `<article class="card" data-vscode-context='${contextMenuAttribute({
        webviewSection: 'preReviewSuggestion',
        forgejoPanelId: 'ai-pre-review-1',
        forgejoSuggestionIndex: 0,
      })}'>` +
        '<span class="anchor">src/index.ts:2</span>' +
        `<textarea class="body-input" data-vscode-context='${contextMenuFieldAttribute()}'>body</textarea>` +
        '</article>',
    );
    const card = container.querySelector('.card')!;
    const anchor = container.querySelector('.anchor')!;
    const editor = container.querySelector('.body-input')!;

    /** VS Code's own accumulation: nearest value of each key wins (`pre/index.html`). */
    const accumulated = (target: Element): Record<string, unknown> => {
      const context: Record<string, unknown> = {};
      for (let node: Element | null = target; node !== null; node = node.parentElement) {
        const raw = node.getAttribute('data-vscode-context');
        if (raw === null) {
          continue;
        }
        for (const [key, value] of Object.entries(JSON.parse(raw) as Record<string, unknown>)) {
          if (!(key in context)) {
            context[key] = value;
          }
        }
      }
      return context;
    };

    expect(accumulated(anchor)).toMatchObject({
      preventDefaultContextMenuItems: true,
      webviewSection: 'preReviewSuggestion',
      forgejoPanelId: 'ai-pre-review-1',
      forgejoSuggestionIndex: 0,
    });
    expect(accumulated(editor)).toMatchObject({
      preventDefaultContextMenuItems: false,
      webviewSection: 'preReviewSuggestion',
      forgejoPanelId: 'ai-pre-review-1',
      forgejoSuggestionIndex: 0,
    });

    expect(allowsNativeContextMenu(card, '')).toBe(true);
    expect(allowsNativeContextMenu(editor, '')).toBe(true);
    expect(contextMenuSectionOf(editor)).toBe('preReviewSuggestion');

    const uninstall = installNativeContextMenuPolicy(window);
    try {
      expect(contextMenuOn(editor).defaultPrevented).toBe(false);
    } finally {
      uninstall();
    }
  });
});

describe('the job log’s marker at click time', () => {
  /**
   * The race the policy closes: the marker is written on `selectionchange`, so a
   * selection that grew afterwards is still described by the attribute in the DOM — and
   * VS Code builds the menu's context keys from that attribute. The capture-phase
   * listener runs before VS Code reads them, so it can take the stale fact away.
   */
  function logCarrier(carriedText: string): HTMLElement {
    const container = mount(
      `<pre class="job-log" data-vscode-context='${logSelectionAttribute(carriedText)}'>aaaa bbbb cccc dddd</pre>`,
    );
    return container.querySelector('.job-log') as HTMLElement;
  }

  it('withdraws a marker whose text is not the live selection, so the item cannot be offered', () => {
    const log = logCarrier('aaaa bbbb');
    expect(contextMenuSectionOf(log)).toBe('runLog');

    // The reader grew the selection between the marker and the click.
    const selection = window.getSelection()!;
    const range = document.createRange();
    range.selectNodeContents(log);
    selection.removeAllRanges();
    selection.addRange(range);
    const live = selection.toString();
    expect(live).not.toBe('aaaa bbbb');

    const uninstall = installNativeContextMenuPolicy(window);
    try {
      const event = contextMenuOn(log);
      // The marker is gone, so VS Code reads no run-log fact …
      expect(log.hasAttribute('data-vscode-context')).toBe(false);
      expect(contextMenuSectionOf(log)).toBeUndefined();
      // … and the live selection keeps the event allowed, so the platform's own Copy is
      // what the reader gets — for the whole selection.
      expect(event.defaultPrevented).toBe(false);
    } finally {
      uninstall();
    }
  });

  it('keeps a marker that matches the live selection, so the item is offered and copies exactly', () => {
    const log = logCarrier('aaaa bbbb cccc dddd');
    const selection = window.getSelection()!;
    const range = document.createRange();
    range.selectNodeContents(log);
    selection.removeAllRanges();
    selection.addRange(range);
    const live = selection.toString();

    const uninstall = installNativeContextMenuPolicy(window);
    try {
      const event = contextMenuOn(log);
      expect(event.defaultPrevented).toBe(false);
      // Unchanged, so the carried text is still the selection and the item is offered.
      expect(contextMenuSectionOf(log)).toBe('runLog');
      const marker = JSON.parse(log.getAttribute('data-vscode-context')!) as Record<string, unknown>;
      expect(marker.forgejoLogText).toBe(live);
      expect(marker.forgejoLogSelection).toBe(true);
    } finally {
      uninstall();
    }
  });

  it('withdraws the marker and still suppresses the menu when there is no selection left', () => {
    // A collapsed selection with a stale marker: the fact goes, and with no selection the
    // policy suppresses as it always did — no empty menu either way.
    const log = logCarrier('aaaa bbbb');
    window.getSelection()?.removeAllRanges();

    const uninstall = installNativeContextMenuPolicy(window);
    try {
      expect(contextMenuOn(log).defaultPrevented).toBe(true);
      expect(log.hasAttribute('data-vscode-context')).toBe(false);
    } finally {
      uninstall();
    }
  });
});
