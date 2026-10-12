import { describe, expect, it } from 'vitest';
import {
  CONTEXT_MENU_SECTION_KEY,
  CONTEXT_MENU_SECTIONS,
  contextMenuAttribute,
  contextMenuSectionOf,
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

  it('publishes exactly the four row families of this batch', () => {
    expect([...CONTEXT_MENU_SECTIONS]).toEqual(['repositoryRow', 'pullRequestRow', 'issueRow', 'notificationRow']);
  });
});
