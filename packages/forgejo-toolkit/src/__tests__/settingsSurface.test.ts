import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';
import {
  SETTINGS_SURFACE_WRITABLE_KEYS,
  type SettingsSourceLevel,
} from '@cpf23333-forgejo-toolkit/shared/webview/messages';
import {
  NOTIFICATION_POLLING_INTERVAL_DEFAULT_SECONDS,
  NOTIFICATION_POLLING_INTERVAL_MAX_SECONDS,
  NOTIFICATION_POLLING_INTERVAL_MIN_SECONDS,
} from '@cpf23333-forgejo-toolkit/shared/limits';
import {
  MACHINE_SCOPED_SETTING_KEYS,
  readSettingsSurface,
  writeSettingsSurfaceValue,
} from '../webview/settingsSurface';

/**
 * The drift guard (`docs/design/settings-page.md` §6) and the host half of the
 * settings page's own surface.
 *
 * A new setting can fail in exactly one way that nobody notices: it is not
 * rendered by this page, so it is silently absent from every place a user could
 * find it. There used to be a second identity for that ledger — a list of
 * settings deliberately left to VS Code's own editor — and it is gone: every
 * setting the manifest contributes has a control on the page now (§1.3), so the
 * guard says that outright. It holds three things against each other:
 *
 * 1. the manifest's configuration keys (what exists),
 * 2. the webview's English string catalogue (what the page renders — every
 *    rendered setting has an entry keyed by its full id there), and
 * 3. the same catalogue read the other way (a rendered id the manifest no longer
 *    contributes is a stale control, which the old two-list guard could not see).
 *
 * What it still catches, and must: a contributed key nobody renders; a rendered
 * id whose label resolves in only one language; a key the page accepts a write
 * for but does not render; a machine-scoped list that drifted from the manifest;
 * and the interval's declared range drifting from the manifest's own
 * `minimum`/`maximum`/`default` or from the sentence the page states them in.
 */

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

interface ManifestProperty {
  title?: string;
  description?: string;
  type?: string;
  default?: unknown;
  minimum?: number;
  maximum?: number;
  scope?: string;
}

interface ManifestShape {
  contributes: { configuration: { properties: Record<string, ManifestProperty> } };
}

const manifest = JSON.parse(readFileSync(path.join(packageRoot, 'package.json'), 'utf8')) as ManifestShape;
const manifestProperties = manifest.contributes.configuration.properties;
const manifestKeys = Object.keys(manifestProperties);

const readCatalogue = (locale: 'en' | 'zh') =>
  JSON.parse(readFileSync(path.join(packageRoot, 'webview', 'src', 'i18n', `${locale}.json`), 'utf8')) as {
    settings: Record<string, unknown>;
  };

const en = readCatalogue('en');
const zh = readCatalogue('zh');

/** The rendered settings: the catalogue keys that are a setting's full id. */
const renderedKeys = Object.keys(en.settings).filter((key) => key.startsWith('forgejoToolkit.'));

/** The levels a reading may name, as the page's own type spells them. */
const SOURCE_LEVELS: readonly SettingsSourceLevel[] = ['default', 'user', 'workspace'];

describe('the settings page ownership policy', () => {
  it('renders every configuration key the manifest contributes', () => {
    // The ledger's only remaining identity: the page is where every setting
    // lives, so a contributed key that is not in the catalogue above is a
    // setting nobody can find.
    const missing = manifestKeys
      .filter((key) => !renderedKeys.includes(key))
      .map(
        (key) =>
          `${key}: not rendered by the settings page — render it (the page is every setting's home now) and ` +
          'add its id to the webview string catalogue',
      );
    expect(missing).toEqual([]);
  });

  it('names no setting the manifest does not contribute', () => {
    // The other direction, and the one the old native-only list used to hide: a
    // catalogue entry for a key the manifest dropped is a control that can never
    // be written, and the mapping test in `webview/src/views/__tests__` would
    // keep believing it exists.
    const stale = renderedKeys
      .filter((key) => !manifestKeys.includes(key))
      .map((key) => `${key}: the page renders it, but the manifest does not contribute it`);
    expect(stale).toEqual([]);
  });

  it('holds the manifest’s machine-scoped settings exactly', () => {
    // Machine-scoped keys cannot be overridden, so the page's source reading
    // treats them differently (§3.5). The list in the policy module is the only
    // copy of that fact outside the manifest, and this is what keeps it one.
    const declared = manifestKeys.filter((key) => manifestProperties[key]?.scope === 'machine').sort();
    expect([...MACHINE_SCOPED_SETTING_KEYS].sort()).toEqual(declared);
  });

  it('points every rendered setting at a string the page actually has', () => {
    // A rendered id's catalogue value is the key of the label the page shows for
    // it, so the mapping cannot rot in either direction: a value that names
    // nothing is a failure here, and a missing id is a failure above.
    const broken = renderedKeys
      .filter((id) => typeof en.settings[id] !== 'string' || (en.settings[id] as string).trim() === '')
      .map((id) => `${id}: the catalogue entry is not a label key`);
    const unresolvable = renderedKeys
      .map((id) => ({ id, labelKey: en.settings[id] as string }))
      .filter(({ labelKey }) => {
        const found = flatten(en).get(labelKey);
        return typeof found !== 'string' || found.trim() === '';
      })
      .map(({ id, labelKey }) => `${id}: "${labelKey}" is not a string in en.json`);
    const untranslated = renderedKeys
      .map((id) => ({ id, labelKey: en.settings[id] as string }))
      .filter(({ labelKey }) => {
        const found = flatten(zh).get(labelKey);
        return typeof found !== 'string' || found.trim() === '';
      })
      .map(({ id, labelKey }) => `${id}: "${labelKey}" is not a string in zh.json`);
    expect([...broken, ...unresolvable, ...untranslated]).toEqual([]);
  });

  it('lists only settings the page renders as writable from the page', () => {
    const notRendered = SETTINGS_SURFACE_WRITABLE_KEYS.filter((key) => !renderedKeys.includes(key)).map(
      (key) => `${key}: writable from the page but not in the rendered catalogue`,
    );
    expect(notRendered).toEqual([]);
  });
});

describe('the interval the manifest declares', () => {
  it('holds the manifest, the shared bounds and the page’s sentence together', () => {
    // The range is one fact with three readers: the poller clamps to it, the page
    // refuses outside it, and the page's own description states it. Neither a
    // moved bound nor an edited sentence may leave the others behind.
    const property = manifestProperties['forgejoToolkit.notificationPollingInterval'];
    expect(property?.type).toBe('number');
    expect(property?.minimum).toBe(NOTIFICATION_POLLING_INTERVAL_MIN_SECONDS);
    expect(property?.maximum).toBe(NOTIFICATION_POLLING_INTERVAL_MAX_SECONDS);
    expect(property?.default).toBe(NOTIFICATION_POLLING_INTERVAL_DEFAULT_SECONDS);

    const english = String(flatten(en).get('settings.notifications.intervalDescription') ?? '');
    const chinese = String(flatten(zh).get('settings.notifications.intervalDescription') ?? '');
    for (const description of [english, chinese]) {
      expect(description).toContain(String(NOTIFICATION_POLLING_INTERVAL_MIN_SECONDS));
      expect(description).toContain(String(NOTIFICATION_POLLING_INTERVAL_MAX_SECONDS));
      expect(description).toContain(String(NOTIFICATION_POLLING_INTERVAL_DEFAULT_SECONDS));
    }
  });
});

describe('the settings page surface: reading', () => {
  /** The three readings the surface takes from `ConfigManager`, as a test states them. */
  function readWith(overrides: Partial<Parameters<typeof readSettingsSurface>[0]> = {}) {
    return readSettingsSurface({
      isNotificationPollingEnabled: () => true,
      getNotificationPollingInterval: () => NOTIFICATION_POLLING_INTERVAL_DEFAULT_SECONDS,
      isMockApiEnabled: () => false,
      ...overrides,
    });
  }

  it('reads each switch through the reader the behaviour itself uses', () => {
    // The default `vscode` mock answers every configuration read with
    // `undefined`, which is exactly the "nothing is configured" case. The
    // expected snapshot is therefore each reader's own closed/default answer —
    // including the switches whose default is on, which is what proves the page
    // reads the features' rules rather than assuming `false`. The global AI switch
    // is one of those: its manifest default is on, so an absent value reads as on.
    // The three readings passed in come from `ConfigManager`, which owns them.
    const snapshot = readWith();
    expect(snapshot).toEqual({
      notificationPollingEnabled: true,
      notificationPollingInterval: NOTIFICATION_POLLING_INTERVAL_DEFAULT_SECONDS,
      useMockApi: false,
      mcpEnabled: true,
      mcpWriteTools: { createIssueComment: false, submitPullReview: false, cancelActionRun: false },
      mcpWriteAuditToFile: false,
      multiWindowLease: true,
      aiEnabled: true,
      aiPreReview: false,
      aiPreReviewPromptScope: 'ask',
      prDescription: false,
      prDescriptionPromptScope: 'ask',
      sources: Object.fromEntries(SETTINGS_SURFACE_WRITABLE_KEYS.map((key) => [key, 'default'])),
    });
  });

  it('reports the notification switch exactly as the poller reads it', () => {
    expect(readWith({ isNotificationPollingEnabled: () => false }).notificationPollingEnabled).toBe(false);
  });

  it('reports the polling interval exactly as the poller reads it', () => {
    // The clamped reading, not the stored one: the poller's own answer is what
    // the field shows, so the page cannot present an interval the loop ignores.
    expect(readWith({ getNotificationPollingInterval: () => 60 }).notificationPollingInterval).toBe(60);
  });

  it('reports the developer mock switch exactly as activation reads it', () => {
    expect(readWith({ isMockApiEnabled: () => true }).useMockApi).toBe(true);
  });

  it('reports the global AI switch exactly as the selection reads it', () => {
    // One reading for the whole area: the page's control and the switch that gates
    // every feature come from the same reader, so they cannot disagree.
    vi.mocked(vscode.workspace.getConfiguration).mockReturnValue({
      get: (key: string) => (key === 'aiEnabled' ? false : undefined),
      inspect: () => undefined,
    } as never);

    expect(readWith().aiEnabled).toBe(false);
  });

  /** Points the mocked configuration at one `inspect` answer per setting name. */
  function useInspected(inspected: Record<string, unknown>): void {
    vi.mocked(vscode.workspace.getConfiguration).mockReturnValue({
      get: vi.fn(),
      update: vi.fn(),
      inspect: (key: string) => inspected[key],
    } as never);
  }

  it('carries the level every setting it presents comes from, for every writable key', () => {
    // Total on purpose: "nothing above the user level holds this" and "this build
    // said nothing about it" must not look alike to the page (§3.5). The map is
    // required — `readSettingsSurface` is the only thing that produces a snapshot
    // (its return type makes one without the map not compile) — and this is the
    // reading that fails if it ever stops carrying it: `Object.keys` of a missing
    // map throws, and a map that lost a key fails the comparison below.
    useInspected({});
    const snapshot = readWith();

    expect(Object.keys(snapshot.sources).sort()).toEqual([...SETTINGS_SURFACE_WRITABLE_KEYS].sort());
    // The levels this reading can produce are pinned as a set, not as "each value
    // is one of these": three of them are left on purpose (§3.5 — no
    // `workspaceFolder`, since a configuration read without a resource URI never
    // reports one), and the assertions below are what make adding a fourth value
    // back a deliberate change. An empty `inspect` reading is entirely `default`,
    // so that is also the check that "no level holds this" is not reported as a
    // level that does.
    expect([...new Set(Object.values(snapshot.sources))]).toEqual(['default']);
    expect(SOURCE_LEVELS).toEqual(['default', 'user', 'workspace']);
    expect(snapshot.sources['forgejoToolkit.notificationPollingEnabled']).toBe('default');
  });

  it('prefers the workspace level over the user level, and reads no folder level', () => {
    // There is no `workspaceFolder` reading to prefer: the configuration is read
    // without a resource URI, so `inspect().workspaceFolderValue` is never the
    // level reported — a folder value supplied here changes nothing (§3.5).
    useInspected({
      mcpEnabled: { workspaceFolderValue: false, workspaceValue: true, globalValue: true },
      mcpWriteAuditToFile: { workspaceValue: true, globalValue: false },
      multiWindowLease: { globalValue: false },
    });
    const { sources } = readWith();

    expect(sources['forgejoToolkit.mcpEnabled']).toBe('workspace');
    expect(sources['forgejoToolkit.mcpWriteAuditToFile']).toBe('workspace');
    expect(sources['forgejoToolkit.multiWindowLease']).toBe('user');
  });

  it('never reports a workspace level for a machine-scoped setting', () => {
    // VS Code does not apply a workspace value to a machine-scoped setting, so a
    // value that appears in one is not the level the effective value comes from.
    // Claiming otherwise would make the page say a setting wins which does not.
    useInspected({
      aiEnabled: { workspaceValue: false, globalValue: true },
      aiPreReview: { workspaceValue: false },
    });
    const { sources } = readWith();

    expect(MACHINE_SCOPED_SETTING_KEYS).toContain('forgejoToolkit.aiEnabled');
    expect(sources['forgejoToolkit.aiEnabled']).toBe('user');
    // The same shape on a key the manifest does not scope to `machine` is a real
    // override, which is what makes the assertion above about the list and not
    // about `inspect` being ignored everywhere.
    expect(sources['forgejoToolkit.aiPreReview']).toBe('workspace');
  });
});

describe('the settings page surface: writing', () => {
  const update = vi.fn(async () => undefined);
  const get = vi.fn((key: string): unknown => (key === 'mcpEnabled' ? false : undefined));

  afterEach(() => {
    update.mockReset();
    update.mockImplementation(async () => undefined);
    get.mockClear();
    vi.mocked(vscode.workspace.getConfiguration).mockReset();
  });

  /** Points the mocked configuration at this file's spies. */
  function useConfiguration(): void {
    vi.mocked(vscode.workspace.getConfiguration).mockReturnValue({
      get,
      update,
      inspect: () => undefined,
    } as never);
  }

  it('writes a boolean at global scope, with the key without its section', async () => {
    useConfiguration();

    expect(await writeSettingsSurfaceValue('forgejoToolkit.notificationPollingEnabled', true)).toEqual({ ok: true });
    expect(update).toHaveBeenCalledWith('notificationPollingEnabled', true, vscode.ConfigurationTarget.Global);
  });

  it('writes the developer mock switch the same way, so the page owns its only writable source', async () => {
    useConfiguration();

    expect(await writeSettingsSurfaceValue('forgejoToolkit.useMockApi', true)).toEqual({ ok: true });
    expect(update).toHaveBeenCalledWith('useMockApi', true, vscode.ConfigurationTarget.Global);
  });

  it('writes the global AI switch the same way, because the page owns its only writable source', async () => {
    useConfiguration();

    expect(await writeSettingsSurfaceValue('forgejoToolkit.aiEnabled', false)).toEqual({ ok: true });
    expect(update).toHaveBeenCalledWith('aiEnabled', false, vscode.ConfigurationTarget.Global);
  });

  it('accepts the polling interval inside the manifest’s range and refuses everything else', async () => {
    useConfiguration();

    for (const seconds of [
      NOTIFICATION_POLLING_INTERVAL_MIN_SECONDS,
      NOTIFICATION_POLLING_INTERVAL_DEFAULT_SECONDS,
      NOTIFICATION_POLLING_INTERVAL_MAX_SECONDS,
    ]) {
      expect(
        await writeSettingsSurfaceValue('forgejoToolkit.notificationPollingInterval', seconds),
        String(seconds),
      ).toEqual({ ok: true });
    }
    expect(update).toHaveBeenLastCalledWith(
      'notificationPollingInterval',
      NOTIFICATION_POLLING_INTERVAL_MAX_SECONDS,
      vscode.ConfigurationTarget.Global,
    );

    // Outside the range, and anything that is not a number at all — including the
    // `NaN` an empty field produces — is refused with the range in the sentence,
    // never with the value the untrusted webview sent.
    const refused = [
      NOTIFICATION_POLLING_INTERVAL_MIN_SECONDS - 1,
      NOTIFICATION_POLLING_INTERVAL_MAX_SECONDS + 1,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      `${NOTIFICATION_POLLING_INTERVAL_DEFAULT_SECONDS}`,
      undefined,
    ];
    const writesBefore = update.mock.calls.length;
    for (const value of refused) {
      const result = await writeSettingsSurfaceValue('forgejoToolkit.notificationPollingInterval', value);
      expect(result.ok, String(value)).toBe(false);
      expect(result.ok === false && result.error).toContain('between 60 and 3600');
    }
    expect(update.mock.calls.length).toBe(writesBefore);
  });

  it('writes one write tool as its own dotted key, and never as the container', async () => {
    // A live walkthrough hit the editor's own refusal on all three switches: the
    // page wrote the **container** `forgejoToolkit.mcpWriteTools`, which the
    // manifest does not contribute (it contributes only the three dotted keys), so
    // the write was refused as an unregistered setting. The write has to address
    // the same key the manifest declares — and because it writes one dotted key,
    // a tool a newer build added is simply a key nothing here writes.
    expect(manifestKeys).toContain('forgejoToolkit.mcpWriteTools.createIssueComment');
    expect(manifestKeys).not.toContain('forgejoToolkit.mcpWriteTools');
    get.mockImplementation((key: string) => (key === 'mcpWriteTools' ? { futureTool: true } : undefined));
    useConfiguration();

    expect(await writeSettingsSurfaceValue('forgejoToolkit.mcpWriteTools.createIssueComment', true)).toEqual({
      ok: true,
    });
    expect(update).toHaveBeenCalledTimes(1);
    expect(update).toHaveBeenCalledWith('mcpWriteTools.createIssueComment', true, vscode.ConfigurationTarget.Global);
    // The unknown neighbour is not part of the write at all.
    expect(update).not.toHaveBeenCalledWith('mcpWriteTools', expect.anything(), expect.anything());
  });

  it('turns a write tool off through its own dotted key', async () => {
    get.mockImplementation((key: string) => (key === 'mcpWriteTools' ? { cancelActionRun: true } : undefined));
    useConfiguration();

    expect(await writeSettingsSurfaceValue('forgejoToolkit.mcpWriteTools.cancelActionRun', false)).toEqual({
      ok: true,
    });
    expect(update).toHaveBeenCalledWith('mcpWriteTools.cancelActionRun', false, vscode.ConfigurationTarget.Global);
  });

  it('leaves a write tool alone when the reader already reports that value', async () => {
    // The current value is read through the reader the behaviour itself uses
    // (`enabledMcpWriteTools`): an explicit `true` is on, everything else is off.
    get.mockImplementation((key: string) => (key === 'mcpWriteTools' ? { submitPullReview: true } : undefined));
    useConfiguration();

    expect(await writeSettingsSurfaceValue('forgejoToolkit.mcpWriteTools.submitPullReview', true)).toEqual({
      ok: true,
    });
    expect(await writeSettingsSurfaceValue('forgejoToolkit.mcpWriteTools.createIssueComment', false)).toEqual({
      ok: true,
    });
    expect(update).not.toHaveBeenCalled();
  });

  it('writes a switch whose stored value is not a boolean, rather than trusting it', async () => {
    // `"true"` is not `true`: the reader calls that tool off, so clicking the
    // switch on has to reach the setting.
    get.mockImplementation((key: string) => (key === 'mcpWriteTools' ? { createIssueComment: 'true' } : undefined));
    useConfiguration();

    expect(await writeSettingsSurfaceValue('forgejoToolkit.mcpWriteTools.createIssueComment', true)).toEqual({
      ok: true,
    });
    expect(update).toHaveBeenCalledWith('mcpWriteTools.createIssueComment', true, vscode.ConfigurationTarget.Global);
  });

  it('accepts every value of the prompt scope and nothing else', async () => {
    useConfiguration();

    for (const scope of ['ask', 'metadata-only', 'changed-lines-only', 'full-diff', 'changed-files']) {
      expect(await writeSettingsSurfaceValue('forgejoToolkit.aiPreReviewPromptScope', scope), scope).toEqual({
        ok: true,
      });
    }
    const refused = await writeSettingsSurfaceValue('forgejoToolkit.aiPreReviewPromptScope', 'changed');
    expect(refused.ok).toBe(false);
    expect(refused.ok === false && refused.error).toContain('it takes one of');
    expect(refused.ok === false && refused.error).toContain('changed-files');
  });

  it('accepts every value of the PR-description scope and nothing else', async () => {
    // The second feature's scope has its own enumeration: the pre-review's values
    // describe line-level review content and mean something else here, so a value
    // only one of the two enumerations knows must be refused rather than stored.
    useConfiguration();

    for (const scope of ['ask', 'commits-only', 'commits-and-files']) {
      expect(await writeSettingsSurfaceValue('forgejoToolkit.prDescriptionPromptScope', scope), scope).toEqual({
        ok: true,
      });
    }
    expect(update).toHaveBeenLastCalledWith(
      'prDescriptionPromptScope',
      'commits-and-files',
      vscode.ConfigurationTarget.Global,
    );
    const refused = await writeSettingsSurfaceValue('forgejoToolkit.prDescriptionPromptScope', 'changed-files');
    expect(refused.ok).toBe(false);
    expect(refused.ok === false && refused.error).toContain('it takes one of');
    expect(refused.ok === false && refused.error).toContain('commits-and-files');
    expect(refused.ok === false && refused.error).not.toContain('changed-files,');
  });

  it('refuses a key the page does not own', async () => {
    useConfiguration();

    const refused = await writeSettingsSurfaceValue('forgejoToolkit.aiProviders', []);
    expect(refused.ok).toBe(false);
    expect(update).not.toHaveBeenCalled();
  });

  it('refuses a value of the wrong type without echoing it', async () => {
    // The webview is untrusted input: a forged message can put anything in
    // `value`, so the refusal names the setting and the shape and never the value
    // — otherwise the host would print a credential into the page and the log.
    useConfiguration();

    const secret = 'sk-should-never-be-printed';
    const refused = await writeSettingsSurfaceValue('forgejoToolkit.mcpEnabled', secret);
    expect(refused.ok).toBe(false);
    expect(refused.ok === false && refused.error).toContain('forgejoToolkit.mcpEnabled');
    expect(refused.ok === false && refused.error).toContain('on or off');
    expect(refused.ok === false && refused.error).not.toContain(secret);
    expect(update).not.toHaveBeenCalled();
  });

  it("reports a failed write with the editor's own sentence", async () => {
    update.mockRejectedValue(new Error('no write access'));
    useConfiguration();

    const refused = await writeSettingsSurfaceValue('forgejoToolkit.multiWindowLease', false);
    expect(refused.ok).toBe(false);
    expect(refused.ok === false && refused.error).toContain('forgejoToolkit.multiWindowLease');
    expect(refused.ok === false && refused.error).toContain('no write access');
  });
});

/** Flattens one catalogue into dotted key paths, the way the i18n parity test reads it. */
function flatten(value: unknown, prefix = ''): Map<string, string> {
  const entries = new Map<string, string>();
  if (value === null || typeof value !== 'object') {
    entries.set(prefix, String(value));
    return entries;
  }
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    const keyPath = prefix ? `${prefix}.${key}` : key;
    for (const [childKey, childValue] of flatten(child, keyPath)) {
      entries.set(childKey, childValue);
    }
  }
  return entries;
}
