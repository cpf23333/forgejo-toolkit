import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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
  openSettingsEditorFor: vi.fn(),
  removeInstanceById: vi.fn(async () => undefined),
  testProviderCommand: vi.fn(async () => undefined),
  writeText: vi.fn(async () => undefined),
  openExternal: vi.fn(async (_uri: unknown) => true),
  showWarningMessage: vi.fn(),
}));

vi.mock('../ai/testProvider', () => ({
  aiTestProviderCommand: state.testProviderCommand,
  aiProviderTestAddress: (provider: { id: string }) => `https://${provider.id}.example.com/v1`,
}));

vi.mock('../ai/modelSettings', () => ({
  aiProviderSettingsReading: () => ({ providers: [{ id: 'gateway-1' }, { id: 'gateway-2' }], rejected: [] }),
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
  window: { showWarningMessage: state.showWarningMessage },
  l10n: { t: (message: string) => message },
}));

vi.mock('../logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import {
  readRowTarget,
  registerWebviewContextMenuCommands,
  WEBVIEW_CONTEXT_MENU_COMMANDS,
  WEBVIEW_CONTEXT_MENU_SECTION_VIEWS,
  WEBVIEW_CONTEXT_MENU_SECTIONS,
  WEBVIEW_CONTEXT_MENU_SETTINGS_VIEW_ID,
  WEBVIEW_CONTEXT_MENU_VIEW_ID,
} from '../commands/webviewContextMenu';
import { registerAiPreReviewPanel, unregisterAiPreReviewPanel } from '../aiPreReviewPanelRegistry';
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

afterEach(() => {
  // The registry is process-wide (that is its point), so a test leaves nothing behind.
  for (const id of ['panel-1', 'panel-2', 'panel-3']) {
    unregisterAiPreReviewPanel(id);
  }
});

beforeEach(() => {
  registered.clear();
  vi.clearAllMocks();
  state.instanceBaseUrl.mockReturnValue('https://forgejo.example.com');
  state.openSettingsEditorFor.mockClear();
  state.removeInstanceById.mockClear();
  state.testProviderCommand.mockClear();
  registerWebviewContextMenuCommands(
    {
      revealRepositoryDetail: state.revealRepositoryDetail,
      revealIssueDetail: state.revealIssueDetail,
      revealPullRequestDetail: state.revealPullRequestDetail,
      instanceBaseUrl: state.instanceBaseUrl,
      markNotificationRead: state.markNotificationRead,
      openSettingsEditorFor: state.openSettingsEditorFor,
      removeInstanceById: state.removeInstanceById,
    } as never,
    {} as never,
  );
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

  it('pins every item to the view its section belongs to, and to one of our sections', () => {
    expect(entries.length).toBeGreaterThan(0);
    for (const entry of entries) {
      const section = WEBVIEW_CONTEXT_MENU_SECTIONS.find((candidate) => entry.when.includes(`'${candidate}'`));
      expect(section, `${entry.command}: ${entry.when}`).toBeDefined();
      expect(entry.when, entry.command).toContain(`webviewSection == '${section}'`);
      // Without `webviewId` the item would appear in every webview in the window, and
      // with the wrong id it would appear on a surface whose sections it cannot serve.
      expect(entry.when, entry.command).toContain(`webviewId == '${WEBVIEW_CONTEXT_MENU_SECTION_VIEWS[section!]}'`);
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

    // The settings page's two rows: edit / copy / remove, and test / edit / copy.
    expect(forSection('settingsInstanceRow')).toEqual(
      [
        WEBVIEW_CONTEXT_MENU_COMMANDS.editInstanceRow,
        WEBVIEW_CONTEXT_MENU_COMMANDS.copyInstanceAddress,
        WEBVIEW_CONTEXT_MENU_COMMANDS.removeInstanceRow,
      ].sort(),
    );
    expect(forSection('settingsEndpointRow')).toEqual(
      [
        WEBVIEW_CONTEXT_MENU_COMMANDS.testProviderRow,
        WEBVIEW_CONTEXT_MENU_COMMANDS.editProviderRow,
        WEBVIEW_CONTEXT_MENU_COMMANDS.copyProviderAddress,
      ].sort(),
    );
    // Every clause on the settings page names that panel, not the sidebar.
    for (const entry of entries.filter((candidate) => candidate.when.includes('settings'))) {
      expect(entry.when, entry.command).toContain(`webviewId == '${WEBVIEW_CONTEXT_MENU_SETTINGS_VIEW_ID}'`);
    }
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

describe('the settings page’s items', () => {
  /** An argument as the settings page's rows publish it. */
  function settingsArgument(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      webview: WEBVIEW_CONTEXT_MENU_SETTINGS_VIEW_ID,
      preventDefaultContextMenuItems: true,
      ...overrides,
    };
  }

  function run(command: string, value: unknown): void {
    registered.get(command)!(value);
  }

  it('accepts a saved-instance row and an endpoint row, and refuses a cross-surface argument', () => {
    expect(
      readRowTarget(settingsArgument({ webviewSection: 'settingsInstanceRow', forgejoInstanceId: 'inst-1' })),
    ).toEqual({ section: 'settingsInstanceRow', instanceId: 'inst-1' });

    expect(
      readRowTarget(settingsArgument({ webviewSection: 'settingsEndpointRow', forgejoProviderId: 'gateway-1' })),
    ).toEqual({ section: 'settingsEndpointRow', providerId: 'gateway-1' });

    // A settings section claimed by the sidebar (or the reverse) is not a row this
    // build published: the view each section belongs to is part of the validation.
    expect(
      readRowTarget({
        webview: WEBVIEW_CONTEXT_MENU_VIEW_ID,
        webviewSection: 'settingsInstanceRow',
        forgejoInstanceId: 'inst-1',
      }),
    ).toBeUndefined();
    expect(
      readRowTarget({
        webview: WEBVIEW_CONTEXT_MENU_SETTINGS_VIEW_ID,
        webviewSection: 'repositoryRow',
        forgejoInstanceId: 'inst-1',
        forgejoOwner: 'demo-user',
        forgejoRepo: 'demo-repo',
      }),
    ).toBeUndefined();
    // And each row still needs its own identity.
    expect(readRowTarget(settingsArgument({ webviewSection: 'settingsInstanceRow' }))).toBeUndefined();
    expect(readRowTarget(settingsArgument({ webviewSection: 'settingsEndpointRow' }))).toBeUndefined();
  });

  it('opens the page’s own editors through the host, by id', () => {
    run(
      WEBVIEW_CONTEXT_MENU_COMMANDS.editInstanceRow,
      settingsArgument({ webviewSection: 'settingsInstanceRow', forgejoInstanceId: 'inst-1' }),
    );
    expect(state.openSettingsEditorFor).toHaveBeenCalledWith({ command: 'settingsEditInstance', id: 'inst-1' });

    run(
      WEBVIEW_CONTEXT_MENU_COMMANDS.editProviderRow,
      settingsArgument({ webviewSection: 'settingsEndpointRow', forgejoProviderId: 'gateway-1' }),
    );
    expect(state.openSettingsEditorFor).toHaveBeenCalledWith({ command: 'settingsEditProvider', id: 'gateway-1' });
  });

  it('removes an instance through the provider’s own confirmed path', async () => {
    run(
      WEBVIEW_CONTEXT_MENU_COMMANDS.removeInstanceRow,
      settingsArgument({ webviewSection: 'settingsInstanceRow', forgejoInstanceId: 'inst-1' }),
    );
    await vi.waitFor(() => expect(state.removeInstanceById).toHaveBeenCalledWith('inst-1'));

    // A refused argument must not remove anything: the confirmation is the provider's,
    // but the *target* is only as trustworthy as this validation.
    state.removeInstanceById.mockClear();
    run(
      WEBVIEW_CONTEXT_MENU_COMMANDS.removeInstanceRow,
      settingsArgument({ webviewSection: 'settingsInstanceRow', forgejoInstanceId: '' }),
    );
    expect(state.removeInstanceById).not.toHaveBeenCalled();
  });

  it('copies the instance’s functional address and the endpoint’s display address', async () => {
    run(
      WEBVIEW_CONTEXT_MENU_COMMANDS.copyInstanceAddress,
      settingsArgument({ webviewSection: 'settingsInstanceRow', forgejoInstanceId: 'inst-1' }),
    );
    await vi.waitFor(() => expect(state.writeText).toHaveBeenCalledWith('https://forgejo.example.com'));

    state.writeText.mockClear();
    run(
      WEBVIEW_CONTEXT_MENU_COMMANDS.copyProviderAddress,
      settingsArgument({ webviewSection: 'settingsEndpointRow', forgejoProviderId: 'gateway-1' }),
    );
    await vi.waitFor(() => expect(state.writeText).toHaveBeenCalledWith('https://gateway-1.example.com/v1'));
  });

  it('runs the endpoint test through the existing runner, with the id the row published', async () => {
    run(
      WEBVIEW_CONTEXT_MENU_COMMANDS.testProviderRow,
      settingsArgument({ webviewSection: 'settingsEndpointRow', forgejoProviderId: 'gateway-2' }),
    );
    await vi.waitFor(() => expect(state.testProviderCommand).toHaveBeenCalledWith(expect.anything(), 'gateway-2'));
  });
});

describe('the pre-review suggestion items', () => {
  /** A marker as a suggestion card publishes it. */
  function cardArgument(panelId: string, index: number): Record<string, unknown> {
    return {
      webview: 'forgejoToolkitAiPreReview',
      webviewSection: 'preReviewSuggestion',
      preventDefaultContextMenuItems: true,
      forgejoPanelId: panelId,
      forgejoSuggestionIndex: index,
    };
  }

  /**
   * A stand-in for one open panel.
   *
   * The real class registers itself on creation and leaves on dispose, with two real
   * panels pinned in `aiPreReviewPanel.test.ts`; these stand-ins exist so this file can
   * assert **routing** — which panel an item reaches — without a webview.
   */
  function fakePanel(id: string) {
    return {
      panelId: id,
      copySuggestionBody: vi.fn(async (_index: unknown) => true),
      openSuggestionDiff: vi.fn(async (_index: unknown) => undefined),
    };
  }

  it('routes to the panel the context came from, not to the newest one', async () => {
    const first = fakePanel('panel-1');
    const second = fakePanel('panel-2');
    // Registration order is the "newest" order: a "whichever panel is current"
    // implementation would answer every item with `second`.
    registerAiPreReviewPanel(first.panelId, first as never);
    registerAiPreReviewPanel(second.panelId, second as never);

    registered.get(WEBVIEW_CONTEXT_MENU_COMMANDS.copyPreReviewSuggestion)!(cardArgument('panel-1', 1));
    await vi.waitFor(() => expect(first.copySuggestionBody).toHaveBeenCalledWith(1));
    expect(second.copySuggestionBody).not.toHaveBeenCalled();

    registered.get(WEBVIEW_CONTEXT_MENU_COMMANDS.openPreReviewSuggestionDiff)!(cardArgument('panel-2', 0));
    await vi.waitFor(() => expect(second.openSuggestionDiff).toHaveBeenCalledWith(0));
    expect(first.openSuggestionDiff).not.toHaveBeenCalled();
  });

  it('takes the index from the marker and the content from the panel, never the marker', async () => {
    const panel = fakePanel('panel-3');
    registerAiPreReviewPanel(panel.panelId, panel as never);

    // The marker carries no body and no anchor — only which card it is.
    registered.get(WEBVIEW_CONTEXT_MENU_COMMANDS.copyPreReviewSuggestion)!(cardArgument('panel-3', 0));
    await vi.waitFor(() => expect(panel.copySuggestionBody).toHaveBeenCalledWith(0));
    expect(typeof panel.copySuggestionBody.mock.calls[0][0]).toBe('number');
  });

  it('refuses with a sentence when the panel is gone, instead of doing nothing silently', async () => {
    registered.get(WEBVIEW_CONTEXT_MENU_COMMANDS.copyPreReviewSuggestion)!(cardArgument('panel-closed', 0));

    await vi.waitFor(() => expect(state.showWarningMessage).toHaveBeenCalledTimes(1));
    expect(String(state.showWarningMessage.mock.calls[0][0])).toContain('no longer open');
  });

  it('accepts a card’s argument and refuses one that names nothing', () => {
    expect(readRowTarget(cardArgument('panel-1', 0))).toEqual({
      section: 'preReviewSuggestion',
      panelId: 'panel-1',
      suggestionIndex: 0,
    });
    // Index 0 is a real card (the payload's own identity starts there) …
    expect(readRowTarget(cardArgument('panel-1', 0))).toBeDefined();
    // … while a negative or fractional one, a missing panel and the wrong view are not.
    expect(readRowTarget(cardArgument('panel-1', -1))).toBeUndefined();
    expect(readRowTarget(cardArgument('panel-1', 0.5))).toBeUndefined();
    expect(readRowTarget({ ...cardArgument('panel-1', 0), forgejoPanelId: undefined })).toBeUndefined();
    expect(readRowTarget({ ...cardArgument('panel-1', 0), webview: WEBVIEW_CONTEXT_MENU_VIEW_ID })).toBeUndefined();
  });

  it('offers exactly the two card items, on the panel’s own view id', () => {
    const entries = manifest.contributes.menus['webview/context'].filter((entry) =>
      entry.when.includes("'preReviewSuggestion'"),
    );
    expect(entries.map((entry) => entry.command).sort()).toEqual(
      [
        WEBVIEW_CONTEXT_MENU_COMMANDS.copyPreReviewSuggestion,
        WEBVIEW_CONTEXT_MENU_COMMANDS.openPreReviewSuggestionDiff,
      ].sort(),
    );
    for (const entry of entries) {
      expect(entry.when).toContain("webviewId == 'forgejoToolkitAiPreReview'");
    }
  });
});

describe('the job log’s Copy item', () => {
  /** A marker as the log publishes it while a selection exists. */
  function logArgument(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      webview: WEBVIEW_CONTEXT_MENU_VIEW_ID,
      webviewSection: 'runLog',
      preventDefaultContextMenuItems: true,
      forgejoLogSelection: true,
      forgejoLogText: 'npm ERR! missing script: build',
      ...overrides,
    };
  }

  it('is offered only when the marker says a selection exists', () => {
    const entry = manifest.contributes.menus['webview/context'].find(
      (candidate) => candidate.command === WEBVIEW_CONTEXT_MENU_COMMANDS.copyRunLogSelection,
    )!;
    // The clause is the gate the marker's presence alone cannot be: an item that could
    // only no-op must not appear.
    expect(entry.when).toContain("webviewSection == 'runLog'");
    expect(entry.when).toContain('forgejoLogSelection == true');
    expect(entry.when).toContain(`webviewId == '${WEBVIEW_CONTEXT_MENU_VIEW_ID}'`);
  });

  it('accepts the selection the marker carries and refuses everything else', () => {
    expect(readRowTarget(logArgument())).toEqual({ section: 'runLog', logText: 'npm ERR! missing script: build' });
    // No selection fact, no text, blank text, a forged oversized text, or another
    // surface's view: none of them may reach the clipboard.
    expect(readRowTarget(logArgument({ forgejoLogSelection: undefined }))).toBeUndefined();
    expect(readRowTarget(logArgument({ forgejoLogSelection: false }))).toBeUndefined();
    expect(readRowTarget(logArgument({ forgejoLogText: undefined }))).toBeUndefined();
    expect(readRowTarget(logArgument({ forgejoLogText: '   ' }))).toBeUndefined();
    expect(readRowTarget(logArgument({ forgejoLogText: 42 }))).toBeUndefined();
    expect(readRowTarget(logArgument({ forgejoLogText: 'x'.repeat(1_000_001) }))).toBeUndefined();
    expect(readRowTarget(logArgument({ webview: 'someOtherWebview' }))).toBeUndefined();
  });

  it('copies exactly the text the marker carried', async () => {
    registered.get(WEBVIEW_CONTEXT_MENU_COMMANDS.copyRunLogSelection)!(logArgument());
    await vi.waitFor(() => expect(state.writeText).toHaveBeenCalledWith('npm ERR! missing script: build'));
  });

  it('says so when it refuses a log marker, instead of looking like a Copy that worked', async () => {
    // Both shapes are unreachable from this extension's own webview (a blank or over-bound
    // selection publishes no marker), so these are hand-planted ones — and a click that
    // does nothing must still say what happened.
    for (const forged of [
      logArgument({ forgejoLogText: '   ' }),
      logArgument({ forgejoLogText: 'x'.repeat(1_000_001) }),
    ]) {
      state.showWarningMessage.mockClear();
      state.writeText.mockClear();
      registered.get(WEBVIEW_CONTEXT_MENU_COMMANDS.copyRunLogSelection)!(forged);

      expect(state.writeText).not.toHaveBeenCalled();
      await vi.waitFor(() => expect(state.showWarningMessage).toHaveBeenCalledTimes(1));
      expect(String(state.showWarningMessage.mock.calls[0][0])).toContain('could not be copied');
    }

    // A marker for another surface's section keeps the quiet refusal it had: only the log
    // arm would otherwise look like a Copy that worked.
    state.showWarningMessage.mockClear();
    registered.get(WEBVIEW_CONTEXT_MENU_COMMANDS.openRepositoryRow)!({
      webview: WEBVIEW_CONTEXT_MENU_VIEW_ID,
      webviewSection: 'repositoryRow',
    });
    expect(state.showWarningMessage).not.toHaveBeenCalled();
  });
});
