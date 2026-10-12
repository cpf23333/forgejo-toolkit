import { describe, expect, it } from 'vitest';
import {
  CONTEXT_MENU_LOG_SELECTION_MAX_CHARS,
  CONTEXT_MENU_PLATFORM_ITEMS_KEY,
  CONTEXT_MENU_SECTION_KEY,
  CONTEXT_MENU_SECTIONS,
  contextMenuAttribute,
  contextMenuFieldAttribute,
  contextMenuSectionOf,
  logSelectionAttribute,
} from '../contextMenu';

/**
 * The marker every row publishes, and the reader the policy uses.
 *
 * The two halves have to agree with the manifest's `when` clauses and with the host's
 * own validation, so what is pinned here is the shape: the section key and its value,
 * the identity keys, and `preventDefaultContextMenuItems` — the key that keeps VS
 * Code's own Cut / Copy / Paste off a row we have just un-suppressed.
 */

describe('contextMenuAttribute', () => {
  it('publishes the row identity plus the key that hides the platform entries', () => {
    const attribute = contextMenuAttribute({
      webviewSection: 'pullRequestRow',
      forgejoInstanceId: 'inst-1',
      forgejoOwner: 'demo-user',
      forgejoRepo: 'demo-repo',
      forgejoIndex: 7,
    });

    expect(JSON.parse(attribute)).toEqual({
      [CONTEXT_MENU_SECTION_KEY]: 'pullRequestRow',
      // Without this the reader would get the platform's Cut / Copy / Paste beside
      // our items; VS Code gates its three on `when: !preventDefaultContextMenuItems`.
      preventDefaultContextMenuItems: true,
      forgejoInstanceId: 'inst-1',
      forgejoOwner: 'demo-user',
      forgejoRepo: 'demo-repo',
      forgejoIndex: 7,
    });
  });

  it('carries a notification row’s own id, and the coordinates only when they exist', () => {
    const withCoordinates = contextMenuAttribute({
      webviewSection: 'notificationRow',
      forgejoInstanceId: 'inst-1',
      forgejoNotificationId: 42,
      forgejoSubjectType: 'issue',
      forgejoOwner: 'demo-user',
      forgejoRepo: 'demo-repo',
      forgejoIndex: 5,
    });
    expect(JSON.parse(withCoordinates)).toMatchObject({
      forgejoNotificationId: 42,
      forgejoSubjectType: 'issue',
      forgejoIndex: 5,
    });

    const withoutCoordinates = contextMenuAttribute({
      webviewSection: 'notificationRow',
      forgejoInstanceId: 'inst-1',
      forgejoNotificationId: 43,
    });
    expect(JSON.parse(withoutCoordinates)).not.toHaveProperty('forgejoSubjectType');
    expect(JSON.parse(withoutCoordinates)).not.toHaveProperty('forgejoIndex');
  });
});

describe('contextMenuSectionOf', () => {
  it('names the section of the nearest marker, and nothing for the rest', () => {
    const page = document.createElement('div');
    page.setAttribute(
      'data-vscode-context',
      contextMenuAttribute({ webviewSection: 'repositoryRow', forgejoInstanceId: 'page' }),
    );
    const row = document.createElement('div');
    row.setAttribute(
      'data-vscode-context',
      contextMenuAttribute({ webviewSection: 'issueRow', forgejoInstanceId: 'inst-1', forgejoIndex: 7 }),
    );
    const title = document.createElement('span');
    row.append(title);
    const bare = document.createElement('div');
    page.append(row, bare);
    document.body.append(page);

    // Nearest wins, which is also how VS Code accumulates the context.
    expect(contextMenuSectionOf(title)).toBe('issueRow');
    expect(contextMenuSectionOf(row)).toBe('issueRow');
    expect(contextMenuSectionOf(bare)).toBe('repositoryRow');
    page.remove();
  });

  it('refuses a foreign, empty or unparsable marker', () => {
    const cases = ['{"webviewSection":"notOurs"}', '{"other":"x"}', '{}', 'not json', ''];
    for (const value of cases) {
      const element = document.createElement('div');
      element.setAttribute('data-vscode-context', value);
      expect(contextMenuSectionOf(element), value).toBeUndefined();
    }
    expect(contextMenuSectionOf(document.createElement('div'))).toBeUndefined();
  });

  it('finds the marker across a shadow boundary, host first', () => {
    // The shape the repository rows actually have: the marker sits on a `vscode-*` host
    // (a `vscode-tree-item`), and the pointer lands on that host's shadow-owned content
    // — where a plain `closest()` cannot reach the host's attribute, so the row would
    // lose its menu entirely.
    const host = document.createElement('div');
    host.setAttribute(
      'data-vscode-context',
      contextMenuAttribute({ webviewSection: 'repositoryRow', forgejoInstanceId: 'inst-1' }),
    );
    const shadow = host.attachShadow({ mode: 'open' });
    const inner = document.createElement('span');
    const deeper = document.createElement('button');
    inner.append(deeper);
    shadow.append(inner);
    document.body.append(host);

    expect(contextMenuSectionOf(inner)).toBe('repositoryRow');
    expect(contextMenuSectionOf(deeper)).toBe('repositoryRow');
    // The host itself keeps answering as before.
    expect(contextMenuSectionOf(host)).toBe('repositoryRow');
    host.remove();
  });

  it('takes the nearest marker on either side of a shadow boundary', () => {
    const page = document.createElement('div');
    page.setAttribute(
      'data-vscode-context',
      contextMenuAttribute({ webviewSection: 'repositoryRow', forgejoInstanceId: 'page' }),
    );
    const host = document.createElement('div');
    host.setAttribute(
      'data-vscode-context',
      contextMenuAttribute({ webviewSection: 'issueRow', forgejoInstanceId: 'inst-1', forgejoIndex: 7 }),
    );
    const shadow = host.attachShadow({ mode: 'open' });
    const inner = document.createElement('span');
    shadow.append(inner);
    page.append(host);
    document.body.append(page);

    // The host's own section wins over the page's, which is how VS Code's accumulation
    // resolves `webviewSection`.
    expect(contextMenuSectionOf(inner)).toBe('issueRow');
    page.remove();
  });

  it('does not fall through a foreign marker inside a shadow root to an outer one of ours', () => {
    const page = document.createElement('div');
    page.setAttribute(
      'data-vscode-context',
      contextMenuAttribute({ webviewSection: 'repositoryRow', forgejoInstanceId: 'page' }),
    );
    const host = document.createElement('div');
    host.setAttribute('data-vscode-context', '{"webviewSection":"notOurs"}');
    const shadow = host.attachShadow({ mode: 'open' });
    const inner = document.createElement('span');
    shadow.append(inner);
    page.append(host);
    document.body.append(page);

    // The deeper marker is the one VS Code would use for `webviewSection`, so the policy
    // must not un-suppress on the strength of the outer one.
    expect(contextMenuSectionOf(inner)).toBeUndefined();
    page.remove();
  });

  it('publishes the shipped sections, and no more', () => {
    expect([...CONTEXT_MENU_SECTIONS]).toEqual([
      'repositoryRow',
      'pullRequestRow',
      'issueRow',
      'notificationRow',
      'settingsInstanceRow',
      'settingsEndpointRow',
      'preReviewSuggestion',
      'runLog',
    ]);
  });
});

describe('contextMenuFieldAttribute', () => {
  it('sets the platform key back to false and declares nothing else', () => {
    // Exactly one key: a `webviewSection` here would take the row's section away from
    // the field's own tree, and the row's items are meant to keep applying to it.
    expect(JSON.parse(contextMenuFieldAttribute())).toEqual({ [CONTEXT_MENU_PLATFORM_ITEMS_KEY]: false });
  });

  it('still leaves the field inside the row’s section', () => {
    const row = document.createElement('div');
    row.setAttribute(
      'data-vscode-context',
      contextMenuAttribute({
        webviewSection: 'notificationRow',
        forgejoInstanceId: 'inst-1',
        forgejoNotificationId: 11,
      }),
    );
    const field = document.createElement('input');
    field.setAttribute('data-vscode-context', contextMenuFieldAttribute());
    row.append(field);
    document.body.append(row);

    // A marker that declares no section does not decide: the walk continues outward, so
    // the policy still recognises the row and the menu opens at all.
    expect(contextMenuSectionOf(field)).toBe('notificationRow');
    row.remove();
  });
});

describe('logSelectionAttribute', () => {
  it('publishes nothing when there is nothing selected', () => {
    // No marker means the policy keeps suppressing and the log shows no menu at all,
    // which is the behaviour it had before the Copy item existed: VS Code contributes
    // nothing of its own to a `<pre>`, so a marker here would open an empty menu.
    expect(logSelectionAttribute('')).toBeUndefined();
    expect(logSelectionAttribute('   \n  ')).toBeUndefined();
  });

  it('publishes the section, the selection fact and the selected text', () => {
    const marker = JSON.parse(logSelectionAttribute('line one\nline two')!) as Record<string, unknown>;
    expect(marker).toMatchObject({
      webviewSection: 'runLog',
      forgejoLogSelection: true,
      forgejoLogText: 'line one\nline two',
    });
    // Kept for consistency with the shared writer: it only hides entries VS Code adds
    // itself, and on a `<pre>` it adds none.
    expect(marker.preventDefaultContextMenuItems).toBe(true);
  });

  it('carries a selection at the boundary whole, and publishes nothing over it', () => {
    // At the bound the whole selection travels …
    const atBoundary = 'y'.repeat(CONTEXT_MENU_LOG_SELECTION_MAX_CHARS);
    const marker = JSON.parse(logSelectionAttribute(atBoundary)!) as Record<string, unknown>;
    expect(marker.forgejoLogText).toBe(atBoundary);
    expect(String(marker.forgejoLogText).length).toBe(CONTEXT_MENU_LOG_SELECTION_MAX_CHARS);

    // … and one character over it publishes no marker at all, so the Copy item is not
    // offered: nothing is ever put on the clipboard partially and without a word, and the
    // reader keeps the status quo (no menu; the keyboard copy still takes the selection).
    expect(logSelectionAttribute('y'.repeat(CONTEXT_MENU_LOG_SELECTION_MAX_CHARS + 1))).toBeUndefined();
    expect(logSelectionAttribute('y'.repeat(CONTEXT_MENU_LOG_SELECTION_MAX_CHARS + 50_000))).toBeUndefined();
  });
});
