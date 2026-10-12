import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The contributed `webview/context` items: the manifest section, the argument they
 * receive, and what each command does with it.
 *
 * Three spellings of the same fact have to agree — the webview's marker keys, the
 * manifest's `when` clauses and the handler here — and none of them is checked by the
 * other's tests, so this file holds them together. The argument is webview input (VS
 * Code forwards the element's `data-vscode-context` object), so the validation cases
 * are as load-bearing as the happy paths.
 */

const state = vi.hoisted(() => ({
  revealRepositoryDetail: vi.fn(),
  revealIssueDetail: vi.fn(),
  revealPullRequestDetail: vi.fn(),
  instanceBaseUrl: vi.fn(),
  markNotificationRead: vi.fn(async () => true),
  writeText: vi.fn(async () => undefined),
  openExternal: vi.fn(async (_uri: unknown) => true),
}));

vi.mock('vscode', () => ({
  commands: {
    registerCommand: (id: string, handler: (argument?: unknown) => unknown) => {
      registered.set(id, handler);
      return { dispose: () => undefined };
    },
  },
  env: {
    clipboard: { writeText: state.writeText },
    openExternal: state.openExternal,
  },
  Uri: { parse: (value: string) => ({ toString: () => value, _url: value }) },
}));

vi.mock('../logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import {
  readRowTarget,
  registerWebviewContextMenuCommands,
  WEBVIEW_CONTEXT_MENU_COMMANDS,
  WEBVIEW_CONTEXT_MENU_SECTIONS,
  WEBVIEW_CONTEXT_MENU_VIEW_ID,
} from '../commands/webviewContextMenu';
import { logger } from '../logger';

const registered = new Map<string, (argument?: unknown) => unknown>();

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

interface CommandContribution {
  command: string;
  title: string;
}

interface MenuContribution {
  command: string;
  when: string;
  group?: string;
}

function readJson(relative: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path.join(packageRoot, relative), 'utf8')) as Record<string, unknown>;
}

const manifest = readJson('package.json') as {
  contributes: {
    commands: CommandContribution[];
    menus: Record<string, MenuContribution[]>;
  };
};
const nlsEn = readJson('package.nls.json') as Record<string, string>;
const nlsZh = readJson('package.nls.zh-cn.json') as Record<string, string>;

/** A valid argument, as VS Code would hand it over for a marked row. */
function argument(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    webview: WEBVIEW_CONTEXT_MENU_VIEW_ID,
    webviewSection: 'pullRequestRow',
    preventDefaultContextMenuItems: true,
    forgejoInstanceId: 'inst-1',
    forgejoOwner: 'demo-user',
    forgejoRepo: 'demo-repo',
    forgejoIndex: 7,
    ...overrides,
  };
}

beforeEach(() => {
  registered.clear();
  vi.clearAllMocks();
  state.instanceBaseUrl.mockReturnValue('https://forgejo.example.com');
  registerWebviewContextMenuCommands({
    revealRepositoryDetail: state.revealRepositoryDetail,
    revealIssueDetail: state.revealIssueDetail,
    revealPullRequestDetail: state.revealPullRequestDetail,
    instanceBaseUrl: state.instanceBaseUrl,
    markNotificationRead: state.markNotificationRead,
  } as never);
});

describe('the manifest section', () => {
  const entries = manifest.contributes.menus['webview/context'] ?? [];

  it('contributes the row commands and offers them nowhere else', () => {
    const ids = manifest.contributes.commands.map((entry) => entry.command);
    for (const command of Object.values(WEBVIEW_CONTEXT_MENU_COMMANDS)) {
      expect(ids).toContain(command);
    }
    // A row action needs a row under the cursor, so the palette must not offer them.
    const palette = manifest.contributes.menus.commandPalette ?? [];
    for (const command of Object.values(WEBVIEW_CONTEXT_MENU_COMMANDS)) {
      expect(palette.filter((entry) => entry.command === command).map((entry) => entry.when)).toEqual(['false']);
    }
  });

  it('pins every item to this extension’s webview and to one of our sections', () => {
    expect(entries.length).toBeGreaterThan(0);
    for (const entry of entries) {
      // Without `webviewId` the item would appear in every webview in the window.
      expect(entry.when, entry.command).toContain(`webviewId == '${WEBVIEW_CONTEXT_MENU_VIEW_ID}'`);
      const section = WEBVIEW_CONTEXT_MENU_SECTIONS.find((candidate) => entry.when.includes(`'${candidate}'`));
      expect(section, `${entry.command}: ${entry.when}`).toBeDefined();
      expect(entry.when, entry.command).toContain(`webviewSection == '${section}'`);
    }
  });

  it('gives every contributed command a title in both language pairs', () => {
    for (const id of Object.values(WEBVIEW_CONTEXT_MENU_COMMANDS)) {
      const contribution = manifest.contributes.commands.find((entry) => entry.command === id)!;
      const match = /^%(.+)%$/.exec(contribution.title);
      expect(match, `${id} must take its title from package.nls`).toBeTruthy();
      const key = match![1];
      expect(nlsEn[key], `en: ${key}`).toBeTruthy();
      expect(nlsZh[key], `zh: ${key}`).toBeTruthy();
      expect(nlsZh[key]).not.toBe(nlsEn[key]);
    }
  });

  it('offers exactly the inventory’s items per row family', () => {
    const forSection = (section: string) =>
      entries
        .filter((entry) => entry.when.includes(`'${section}'`))
        .map((entry) => entry.command)
        .sort();

    expect(forSection('repositoryRow')).toEqual(
      [
        WEBVIEW_CONTEXT_MENU_COMMANDS.openRepositoryRow,
        WEBVIEW_CONTEXT_MENU_COMMANDS.copyRepositoryAddress,
        // The refresh is the existing view-title command, reused rather than redone.
        'forgejoToolkit.refreshInstances',
      ].sort(),
    );
    expect(forSection('issueRow')).toEqual(
      [
        WEBVIEW_CONTEXT_MENU_COMMANDS.openIssueRow,
        WEBVIEW_CONTEXT_MENU_COMMANDS.copyRowReference,
        WEBVIEW_CONTEXT_MENU_COMMANDS.openRowInBrowser,
      ].sort(),
    );
    expect(forSection('pullRequestRow')).toEqual(
      [
        WEBVIEW_CONTEXT_MENU_COMMANDS.openPullRequestRow,
        WEBVIEW_CONTEXT_MENU_COMMANDS.copyRowReference,
        WEBVIEW_CONTEXT_MENU_COMMANDS.openRowInBrowser,
      ].sort(),
    );
    // A notification row's open item is one of the two row commands, chosen by the
    // subject type the row published.
    const notification = entries.filter((entry) => entry.when.includes("'notificationRow'"));
    expect(notification.map((entry) => entry.command).sort()).toEqual(
      [
        WEBVIEW_CONTEXT_MENU_COMMANDS.openIssueRow,
        WEBVIEW_CONTEXT_MENU_COMMANDS.openPullRequestRow,
        WEBVIEW_CONTEXT_MENU_COMMANDS.markNotificationRowRead,
      ].sort(),
    );
    expect(
      notification.filter((entry) => entry.command === WEBVIEW_CONTEXT_MENU_COMMANDS.openIssueRow)[0].when,
    ).toContain("forgejoSubjectType == 'issue'");
    expect(
      notification.filter((entry) => entry.command === WEBVIEW_CONTEXT_MENU_COMMANDS.openPullRequestRow)[0].when,
    ).toContain("forgejoSubjectType == 'pull'");
  });

  it('offers no item that could only no-op', () => {
    // `markNotificationRowRead` needs the row's own id; without the clause a
    // notification row that published none would show an item whose handler refuses it
    // — the same dead affordance the marker rule refuses to create for the open items.
    const markRead = entries.find((entry) => entry.command === WEBVIEW_CONTEXT_MENU_COMMANDS.markNotificationRowRead)!;
    expect(markRead.when).toContain('forgejoNotificationId > 0');

    // And the handler really does require it: the pair has to agree.
    const withoutId = argument({
      webviewSection: 'notificationRow',
      forgejoNotificationId: undefined,
      forgejoOwner: undefined,
      forgejoRepo: undefined,
      forgejoIndex: undefined,
    });
    expect(readRowTarget(withoutId)).toBeUndefined();
  });
});

describe('readRowTarget', () => {
  it('accepts the argument VS Code forwards for a marked row', () => {
    expect(readRowTarget(argument())).toEqual({
      section: 'pullRequestRow',
      instanceId: 'inst-1',
      owner: 'demo-user',
      repo: 'demo-repo',
      index: 7,
    });
  });

  it('accepts a notification row with only its own id', () => {
    expect(
      readRowTarget(
        argument({
          webviewSection: 'notificationRow',
          forgejoNotificationId: 42,
          forgejoOwner: undefined,
          forgejoRepo: undefined,
          forgejoIndex: undefined,
        }),
      ),
    ).toEqual({ section: 'notificationRow', instanceId: 'inst-1', notificationId: 42 });
  });

  it('refuses anything the marker was not supposed to say', () => {
    const refused: Array<[string, unknown]> = [
      ['not an object', 'nope'],
      ['an array', []],
      ['another webview', argument({ webview: 'someOtherWebview' })],
      ['no webview at all', argument({ webview: undefined })],
      ['a section we do not publish', argument({ webviewSection: 'settingsInstanceRow' })],
      ['no instance', argument({ forgejoInstanceId: '' })],
      ['a missing repository', argument({ forgejoRepo: undefined })],
      ['a path instead of a name', argument({ forgejoOwner: 'demo/../user' })],
      ['a traversal step', argument({ forgejoRepo: '..' })],
      ['an empty name', argument({ forgejoOwner: '' })],
      ['a query in a name', argument({ forgejoRepo: 'demo-repo?x=1' })],
      ['a fractional number', argument({ forgejoIndex: 1.5 })],
      ['a negative number', argument({ forgejoIndex: -3 })],
      ['a string number', argument({ forgejoIndex: '7' })],
      [
        'a notification row without its id',
        argument({ webviewSection: 'notificationRow', forgejoNotificationId: undefined }),
      ],
      ['a repository row with a number only', argument({ webviewSection: 'repositoryRow', forgejoRepo: undefined })],
    ];
    for (const [label, value] of refused) {
      expect(readRowTarget(value), label).toBeUndefined();
    }
  });
});

describe('the commands', () => {
  function run(command: string, value: unknown = argument()): void {
    const handler = registered.get(command);
    expect(handler, `${command} is not registered`).toBeDefined();
    handler!(value);
  }

  it('opens each entity through the navigation the sidebar already uses', () => {
    run(WEBVIEW_CONTEXT_MENU_COMMANDS.openPullRequestRow);
    expect(state.revealPullRequestDetail).toHaveBeenCalledWith({
      instanceId: 'inst-1',
      owner: 'demo-user',
      repo: 'demo-repo',
      index: 7,
    });

    run(WEBVIEW_CONTEXT_MENU_COMMANDS.openIssueRow, argument({ webviewSection: 'issueRow' }));
    expect(state.revealIssueDetail).toHaveBeenCalledWith({
      instanceId: 'inst-1',
      owner: 'demo-user',
      repo: 'demo-repo',
      index: 7,
    });

    run(
      WEBVIEW_CONTEXT_MENU_COMMANDS.openRepositoryRow,
      argument({ webviewSection: 'repositoryRow', forgejoIndex: undefined }),
    );
    expect(state.revealRepositoryDetail).toHaveBeenCalledWith({
      instanceId: 'inst-1',
      owner: 'demo-user',
      repo: 'demo-repo',
    });
  });

  it('copies the clone address and the row reference from the instance’s own base URL', async () => {
    run(WEBVIEW_CONTEXT_MENU_COMMANDS.copyRepositoryAddress, argument({ webviewSection: 'repositoryRow' }));
    await vi.waitFor(() =>
      expect(state.writeText).toHaveBeenCalledWith('https://forgejo.example.com/demo-user/demo-repo.git'),
    );

    run(WEBVIEW_CONTEXT_MENU_COMMANDS.copyRowReference);
    await vi.waitFor(() => expect(state.writeText).toHaveBeenCalledWith('demo-user/demo-repo#7'));
  });

  it('opens the browser at a URL built here, never one the marker names', async () => {
    run(WEBVIEW_CONTEXT_MENU_COMMANDS.openRowInBrowser);
    await vi.waitFor(() =>
      expect(state.openExternal).toHaveBeenCalledWith(
        expect.objectContaining({ _url: 'https://forgejo.example.com/demo-user/demo-repo/pulls/7' }),
      ),
    );

    state.openExternal.mockClear();
    run(WEBVIEW_CONTEXT_MENU_COMMANDS.openRowInBrowser, argument({ webviewSection: 'issueRow' }));
    await vi.waitFor(() =>
      expect(state.openExternal).toHaveBeenCalledWith(
        expect.objectContaining({ _url: 'https://forgejo.example.com/demo-user/demo-repo/issues/7' }),
      ),
    );
  });

  it('percent-encodes the path segments it builds, so a marker cannot spell a path', async () => {
    // `safeSegment` accepts a `%` — a name may contain one — so the encoding is what has
    // to make the address safe. Without it an adversarial marker's `..%2f..%2fadmin`
    // reaches the editor's `openExternal` verbatim, one decode away from a traversal.
    const hostile = argument({ forgejoRepo: '..%2f..%2fadmin', webviewSection: 'issueRow' });
    expect(readRowTarget(hostile)).toBeDefined();

    run(WEBVIEW_CONTEXT_MENU_COMMANDS.openRowInBrowser, hostile);
    await vi.waitFor(() => expect(state.openExternal).toHaveBeenCalled());
    const opened = state.openExternal.mock.calls.at(-1)?.[0] as { _url?: unknown } | undefined;
    const url = typeof opened?._url === 'string' ? opened._url : '';
    expect(url).not.toContain('..%2f');
    expect(url).not.toContain('..%2F');
    expect(url).toContain('..%252f..%252fadmin');

    // The same rule for the copied clone address.
    state.writeText.mockClear();
    run(WEBVIEW_CONTEXT_MENU_COMMANDS.copyRepositoryAddress, argument({ forgejoRepo: '..%2f..%2fadmin' }));
    await vi.waitFor(() =>
      expect(state.writeText).toHaveBeenCalledWith('https://forgejo.example.com/demo-user/..%252f..%252fadmin.git'),
    );
  });

  it('marks the notification read through the provider, and does nothing without an id', async () => {
    run(
      WEBVIEW_CONTEXT_MENU_COMMANDS.markNotificationRowRead,
      argument({ webviewSection: 'notificationRow', forgejoNotificationId: 42, forgejoIndex: undefined }),
    );
    await vi.waitFor(() => expect(state.markNotificationRead).toHaveBeenCalledWith('inst-1', 42));

    state.markNotificationRead.mockClear();
    run(WEBVIEW_CONTEXT_MENU_COMMANDS.markNotificationRowRead, argument({ webviewSection: 'notificationRow' }));
    expect(state.markNotificationRead).not.toHaveBeenCalled();
  });

  it('does nothing with a refused argument, and says so at debug level', () => {
    const refused = argument({ webview: 'someOtherWebview' });
    for (const command of Object.values(WEBVIEW_CONTEXT_MENU_COMMANDS)) {
      run(command, refused);
    }

    expect(state.revealRepositoryDetail).not.toHaveBeenCalled();
    expect(state.revealIssueDetail).not.toHaveBeenCalled();
    expect(state.revealPullRequestDetail).not.toHaveBeenCalled();
    expect(state.writeText).not.toHaveBeenCalled();
    expect(state.openExternal).not.toHaveBeenCalled();
    expect(state.markNotificationRead).not.toHaveBeenCalled();
    expect(logger.debug).toHaveBeenCalledTimes(Object.values(WEBVIEW_CONTEXT_MENU_COMMANDS).length);
  });
});
